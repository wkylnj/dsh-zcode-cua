# Resident overlay host: one PowerShell process, one JSON command per line.
#
# The Node bridge cannot create a layered window itself, and spawning a fresh
# PowerShell per show/hide would cost ~200 ms each time — far too slow for
# something that must appear the instant a tool call starts and vanish before a
# screenshot. So this process is spawned once and kept alive, reading stdin.
#
# Protocol (one JSON object per line on stdin, one line per reply on stdout):
#   {"cmd":"show","phase":"working"|"waiting","text":"..."}  -> {"ok":true,"detail":"ok:6"}
#   {"cmd":"hide"}                              -> {"ok":true}
#   {"cmd":"diagnose"}                          -> {"ok":true,"detail":"visible:..."}
#   {"cmd":"quit"}                              -> exits
#
# `text` is the action line under the title — whatever the current tool call
# said it was doing. It is optional; without it the banner shows a generic line.
#
# Compilation is done in-process with Add-Type. Nothing is written to disk, so
# the plugin ships no binaries and needs no build step. If compilation fails the
# host reports it on stderr and exits non-zero; the Node side treats the overlay
# as unavailable and keeps working, because the indicator is decoration.

param(
    [Parameter(Mandatory = $true)][string]$SourcePath
)

$ErrorActionPreference = 'Stop'

# No console window, ever: this runs as a child of the MCP bridge, and a stray
# console would steal focus and appear in screenshots.
try {
    Add-Type -Namespace DshZcodeCua -Name ConsoleHide -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
public static void Hide() { FreeConsole(); }
'@
    [DshZcodeCua.ConsoleHide]::Hide()
} catch {
    # Not fatal: worst case a console flashes.
}

$source = [System.IO.File]::ReadAllText($SourcePath, [System.Text.Encoding]::UTF8)

# Windows PowerShell 5.1 runs on .NET Framework, where GDI+ and WinForms are
# separate assemblies that are NOT loaded by default — referencing a type before
# loading its assembly fails with "Unable to find type". Load them first, then
# hand their locations to the compiler.
foreach ($name in @('System.Drawing', 'System.Windows.Forms')) {
    try { Add-Type -AssemblyName $name -ErrorAction Stop } catch {
        [Console]::Error.WriteLine("overlay: cannot load $name — $($_.Exception.Message)")
        exit 2
    }
}

$refs = @(
    [System.Drawing.Bitmap].Assembly.Location,
    [System.Drawing.Graphics].Assembly.Location,
    [System.Windows.Forms.Cursor].Assembly.Location
) | Where-Object { $_ } | Select-Object -Unique

try {
    Add-Type -TypeDefinition $source -ReferencedAssemblies $refs -Language CSharp
} catch {
    [Console]::Error.WriteLine("overlay compile failed: $($_.Exception.Message)")
    if ($_.Exception.InnerException) {
        [Console]::Error.WriteLine($_.Exception.InnerException.Message)
    }
    exit 2
}

[DshZcodeCua.Overlay]::Init()

# The Node bridge writes UTF-8. `[Console]::In` would decode it with the console
# output code page instead (936/GBK on a Chinese Windows), turning every Chinese
# action line into mojibake, so the channel is opened as explicit UTF-8 streams.
# `$false` = no BOM: the parent parses each line as JSON and a BOM would break it.
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true

function Reply([bool]$ok, [string]$detail) {
    $payload = @{ ok = $ok }
    if ($detail) { $payload.detail = $detail }
    $json = $payload | ConvertTo-Json -Compress
    $stdout.WriteLine($json)
}

Reply $true 'ready'

# Blocking read loop. `ReadLine` returning null means stdin closed: the parent
# died or shut down, so this process must not outlive it.
while ($true) {
    $line = $stdin.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }

    try {
        $cmd = $line | ConvertFrom-Json
    } catch {
        Reply $false "bad-json"
        continue
    }

    switch ($cmd.cmd) {
        'show' {
            $phase = if ($cmd.phase) { [string]$cmd.phase } else { 'working' }
            $text = if ($null -ne $cmd.text) { [string]$cmd.text } else { $null }
            $detail = [DshZcodeCua.Overlay]::Show($phase, $true, $text)
            Reply ($detail -notlike 'error:*') $detail
        }
        'hide' {
            [DshZcodeCua.Overlay]::Hide()
            Reply $true 'hidden'
        }
        'diagnose' {
            Reply $true ([DshZcodeCua.Overlay]::Diagnose())
        }
        'quit' {
            [DshZcodeCua.Overlay]::Hide()
            Reply $true 'bye'
            break
        }
        default {
            Reply $false "unknown-cmd"
        }
    }
}

[DshZcodeCua.Overlay]::Hide()
