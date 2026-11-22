/**
 * Locate the ZCode Computer Use runtime pieces on this machine.
 *
 * Three things are needed and all three can be overridden:
 *   - upstream: the `node-repl-host` MCP server that owns the `js` tool
 *   - client:   the `computer-use` plugin that ships `setupComputerUseRuntime`
 *   - helper:   the native Windows helper (`ax_native.node` + its entry)
 *
 * Nothing here is required at module load: a missing piece produces a
 * diagnostic, not a crash, because the MCP server must still start and answer
 * `tools/list` so DSH can surface a usable error to the user instead of a dead
 * tool.
 *
 * @module dsh-zcode-cua/paths
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Candidate roots for ZCode's plugin cache, most specific first. */
function pluginCacheRoots() {
  const home = homedir();
  return [join(home, ".zcode", "cli", "plugins", "cache", "zcode-plugins-official")];
}

/** Version-sorted descendants of `root/name`, newest last. */
function versionsOf(root, name) {
  const base = join(root, name);
  if (!existsSync(base)) return [];
  try {
    // Versions sort lexicographically only by accident; the caller picks the
    // last entry and ZCode ships plain dotted versions, so a natural compare
    // keeps `0.10.0` after `0.9.0` instead of before it.
    const entries = readdirSync(base, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersions);
  } catch {
    return [];
  }
}

/** Compare dotted numeric versions, ignoring any prerelease suffix. */
function compareVersions(a, b) {
  const num = (v) => v.split("-")[0].split(".").map((part) => Number(part) || 0);
  const left = num(a);
  const right = num(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Every installed version directory of `name`, newest first.
 *
 * Newest first, not newest only: a ZCode update that leaves a half-written
 * version directory behind is a real failure mode (an interrupted download, an
 * antivirus quarantine, a disk that filled up). Taking only the newest turns
 * that into "Computer Use unavailable" with a path that looks correct, while
 * the previous version sitting right beside it would have worked. Callers probe
 * each candidate and take the first one that is actually complete.
 */
function versionsNewestFirst(root, name) {
  return versionsOf(root, name)
    .reverse()
    .map((version) => join(root, name, version));
}

/**
 * The upstream MCP server that owns the `js` tool.
 *
 * Override: `ZCODE_BRIDGE_SERVER`.
 */
export function resolveUpstreamServer() {
  const explicit = process.env.ZCODE_BRIDGE_SERVER?.trim();
  if (explicit) return explicit;
  for (const root of pluginCacheRoots()) {
    for (const dir of versionsNewestFirst(root, "node-repl-host")) {
      const entry = join(dir, "dist", "mcp", "server.js");
      if (existsSync(entry)) return entry;
    }
  }
  return undefined;
}

/**
 * The `computer-use` plugin root, which holds `scripts/computer-use-client.mjs`
 * and `docs/computer-use.md`. The model's bootstrap imports from here.
 *
 * Override: `ZCODE_CUA_PLUGIN_ROOT`.
 */
export function resolveCuaPluginRoot() {
  const explicit = process.env.ZCODE_CUA_PLUGIN_ROOT?.trim();
  if (explicit) return explicit;
  for (const root of pluginCacheRoots()) {
    for (const dir of versionsNewestFirst(root, "computer-use")) {
      if (existsSync(join(dir, "scripts", "computer-use-client.mjs"))) return dir;
    }
  }
  return undefined;
}

/**
 * Installation directories ZCode may occupy, best guess first.
 *
 * ZCode has no npm package and no PATH entry, so the install location is not
 * derivable from the executable name alone. Three sources are tried, in order
 * of reliability:
 *
 *   1. the uninstall registry, which is the only record that survives a
 *      non-default install drive (the measured case: ZCode on `D:`);
 *   2. the environment variable the user set explicitly;
 *   3. the conventional per-user and per-machine layouts.
 *
 * A wrong guess costs one `existsSync`; a missing source costs a broken
 * install, so all three are consulted before giving up.
 */
function zcodeInstallCandidates() {
  const candidates = [];

  for (const root of [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ]) {
    const found = readInstallLocationFromRegistry(root);
    if (found) candidates.push(found);
  }

  const explicit = process.env.ZCODE_HOME?.trim();
  if (explicit) candidates.push(explicit);

  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const roamingAppData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  for (const base of [localAppData, roamingAppData, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (!base) continue;
    candidates.push(join(base, "ZCode"));
    candidates.push(join(base, "Programs", "ZCode"));
  }

  return candidates;
}

/** InstallLocation of the ZCode uninstall entry under one registry root. */
function readInstallLocationFromRegistry(key) {
  try {
    // `reg query` rather than a registry module: this package has no
    // dependencies, and spawning `reg` is cheaper than requiring `winreg`
    // to be present on every machine.
    const out = execFileSync("reg", ["query", key, "/s", "/f", "ZCode", "/d"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    });
    const match = /InstallLocation\s+REG_\w+\s+(.+)/i.exec(out);
    const value = match?.[1]?.trim();
    return value && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The native Windows helper directory.
 *
 * ZCode ships it beside its own executable under `resources/tools/cua-helper`.
 * The helper entry must exist AND the addon must be loadable — a half-unpacked
 * install produces the same "CUA unavailable" symptom as no install at all, so
 * both are checked here and reported separately by {@link describeRuntime}.
 *
 * Override: `ZCODE_BRIDGE_HELPER_ROOT`.
 */
export function resolveHelperRoot() {
  const explicit = process.env.ZCODE_BRIDGE_HELPER_ROOT?.trim();
  if (explicit) return explicit;
  const candidates = zcodeInstallCandidates().map((dir) =>
    join(dir, "resources", "tools", "cua-helper"),
  );
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "build", "Release", "ax_native.node"))) return candidate;
  }
  // Fall through to the first candidate that at least exists, so the diagnostic
  // can name the directory the user was expected to have.
  return candidates.find((candidate) => existsSync(candidate));
}

/** Everything the server needs, resolved once at startup. */
export function resolveRuntime() {
  const upstream = resolveUpstreamServer();
  const cuaPluginRoot = resolveCuaPluginRoot();
  const helperRoot = resolveHelperRoot();
  const helperEntry = helperRoot ? join(helperRoot, "dist", "windows-helper.js") : undefined;
  const helperAddon = helperRoot ? join(helperRoot, "build", "Release", "ax_native.node") : undefined;
  return {
    upstream,
    cuaPluginRoot,
    helperRoot,
    helperEntry: helperEntry && existsSync(helperEntry) ? helperEntry : undefined,
    helperAddon: helperAddon && existsSync(helperAddon) ? helperAddon : undefined,
  };
}

/**
 * Human-readable account of what resolved and what did not.
 *
 * Reported through MCP `instructions` and a startup stderr line: the two
 * failure modes that actually happen (ZCode updated to a layout this plugin
 * does not know, and the helper present but its addon missing) both look
 * identical from the model's side — "Computer Use is unavailable" — and neither
 * is fixable without naming the path that was probed.
 */
export function describeRuntime(runtime) {
  const lines = [];
  lines.push(`upstream: ${runtime.upstream ?? "NOT FOUND"}`);
  lines.push(`cua plugin: ${runtime.cuaPluginRoot ?? "NOT FOUND"}`);
  lines.push(`helper root: ${runtime.helperRoot ?? "NOT FOUND"}`);
  lines.push(`helper entry: ${runtime.helperEntry ?? "NOT FOUND"}`);
  lines.push(`helper addon: ${runtime.helperAddon ?? "NOT FOUND"}`);
  return lines.join("\n");
}

/** Whether every piece needed for a real desktop action is present. */
export function runtimeIsComplete(runtime) {
  return Boolean(runtime.upstream && runtime.cuaPluginRoot && runtime.helperEntry && runtime.helperAddon);
}
