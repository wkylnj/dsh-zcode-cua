// Win32 layered-window overlay that tells the user an AI is driving the desktop.
//
// Ported visually from windows-mcp's control_overlay (Python/PIL). The reason this
// exists at all is the third requirement in the design: the indicator must be
// VISIBLE TO THE USER BUT ABSENT FROM EVERY SCREENSHOT the model takes. Two
// mechanisms are combined, because neither is sufficient alone:
//
//   * SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) makes Windows itself skip
//     this window in any capture (PrintScreen, Graphics.CopyFromScreen, DWM-based
//     grabbers). Unavailable on some compositors, so it is best-effort.
//   * Hide-before-capture, driven by the host: the JS side calls Hide() before a
//     capture_app request and Show() after. This is the one that actually holds
//     for the CUA pipeline, which captures through GDI/DWM directly.
//
// Every window here is click-through (WS_EX_TRANSPARENT), non-focusable
// (WS_EX_NOACTIVATE) and a tool window (WS_EX_TOOLWINDOW, so it never shows in
// the taskbar or Alt-Tab). Nothing in this file ever takes input.
//
// Rendering is CPU-side GDI+ into a premultiplied 32-bit DIB, pushed with
// UpdateLayeredWindow. No WPF, no WinForms, no external packages: this compiles
// with the C# compiler that ships inside Windows.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;

namespace DshZcodeCua
{
    /// <summary>One device-pixel rectangle of a layered overlay window.</summary>
    internal sealed class OverlayForm
    {
        public IntPtr Handle;
        public string ClassName;
        public int X, Y, W, H;
        public Bitmap Content;
        public byte[] Pixels;
    }

    internal static class Native
    {
        public const int WS_POPUP = unchecked((int)0x80000000);
        public const int WS_EX_LAYERED = 0x00080000;
        public const int WS_EX_TRANSPARENT = 0x00000020;
        public const int WS_EX_TOPMOST = 0x00000008;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const int WS_EX_NOACTIVATE = 0x08000000;

        public const int ULW_ALPHA = 0x00000002;
        public const byte AC_SRC_OVER = 0x00;
        public const byte AC_SRC_ALPHA = 0x01;

        public const int SW_SHOWNA = 8;

        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public const int SWP_NOSIZE = 0x0001;
        public const int SWP_NOMOVE = 0x0002;
        public const int SWP_NOACTIVATE = 0x0010;
        public const int SWP_SHOWWINDOW = 0x0040;

        public const int WM_NCHITTEST = 0x0084;
        public const int HTTRANSPARENT = -1;

        public const uint WDA_NONE = 0x00000000;
        public const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;

        public const int SM_XVIRTUALSCREEN = 76;
        public const int SM_YVIRTUALSCREEN = 77;
        public const int SM_CXVIRTUALSCREEN = 78;
        public const int SM_CYVIRTUALSCREEN = 79;

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int x;
            public int y;
            public POINT(int x, int y) { this.x = x; this.y = y; }
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct SIZE
        {
            public int cx;
            public int cy;
            public SIZE(int cx, int cy) { this.cx = cx; this.cy = cy; }
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int left;
            public int top;
            public int right;
            public int bottom;
        }

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        public struct BLENDFUNCTION
        {
            public byte BlendOp;
            public byte BlendFlags;
            public byte SourceConstantAlpha;
            public byte AlphaFormat;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct BITMAPINFOHEADER
        {
            public int biSize;
            public int biWidth;
            public int biHeight;
            public short biPlanes;
            public short biBitCount;
            public int biCompression;
            public int biSizeImage;
            public int biXPelsPerMeter;
            public int biYPelsPerMeter;
            public int biClrUsed;
            public int biClrImportant;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct BITMAPINFO
        {
            public BITMAPINFOHEADER bmiHeader;
            public int bmiColors;
        }

        public delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct WNDCLASSEX
        {
            public int cbSize;
            public uint style;
            public WndProcDelegate lpfnWndProc;
            public int cbClsExtra;
            public int cbWndExtra;
            public IntPtr hInstance;
            public IntPtr hIcon;
            public IntPtr hCursor;
            public IntPtr hbrBackground;
            [MarshalAs(UnmanagedType.LPWStr)] public string lpszMenuName;
            [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
            public IntPtr hIconSm;
        }

        // CharSet.Unicode on BOTH sides is not cosmetic. Without it the default
        // Ansi marshaling registers the class under a mangled ANSI name while
        // CreateWindowExW looks the name up as UTF-16, and every create fails
        // with 1411 ERROR_CLASS_DOES_NOT_EXIST even though RegisterClassEx
        // returned a valid atom.
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern ushort RegisterClassEx(ref WNDCLASSEX lpwcx);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool UnregisterClass(string lpClassName, IntPtr hInstance);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateWindowEx(
            int dwExStyle, string lpClassName, string lpWindowName, int dwStyle,
            int x, int y, int nWidth, int nHeight,
            IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr DefWindowProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool DestroyWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, int uFlags);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint dwAffinity);

        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int nIndex);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        public static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UpdateLayeredWindow(
            IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize,
            IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);

        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateCompatibleDC(IntPtr hDC);

        [DllImport("gdi32.dll")]
        public static extern bool DeleteDC(IntPtr hDC);

        [DllImport("gdi32.dll", SetLastError = true)]
        public static extern IntPtr CreateDIBSection(
            IntPtr hdc, ref BITMAPINFO pbmi, uint iUsage, out IntPtr ppvBits, IntPtr hSection, uint dwOffset);

        [DllImport("gdi32.dll")]
        public static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);

        [DllImport("gdi32.dll")]
        public static extern bool DeleteObject(IntPtr hObject);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);

        [DllImport("user32.dll")]
        public static extern uint GetDpiForSystem();

        [DllImport("user32.dll")]
        public static extern int GetDpiForWindow(IntPtr hwnd);

        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 as a raw handle value.
        public static readonly IntPtr DPI_AWARENESS_PER_MONITOR_V2 = new IntPtr(-4);
        public static readonly IntPtr DPI_AWARENESS_PER_MONITOR = new IntPtr(-3);
    }

    /// <summary>
    /// Owns every overlay HWND and draws the four edge glows, the top banner and
    /// the cursor ring. All public members are safe to call from any thread.
    ///
    /// Must be `public`: PowerShell's Add-Type emits into a dynamic assembly and
    /// can only reach exported types, so an internal class compiles fine and is
    /// then invisible to the host ("cannot find type").
    /// </summary>
    public static class Overlay
    {
        static readonly object Gate = new object();
        static readonly List<OverlayForm> Forms = new List<OverlayForm>();
        static readonly List<string> ClassNames = new List<string>();
        static Native.WndProcDelegate procKeepAlive;
        static bool visible;
        static string phase = "working";

        // Visual constants, matching windows-mcp's control_overlay_art.
        const int BORDER = 56;
        const int CURSOR_SIZE = 88;
        const int CURSOR_LABEL_SIZE = 20;
        const string CURSOR_LABEL = "AI";

        static Color PhaseColor()
        {
            // Blue while working, amber while waiting on the user.
            return phase == "waiting"
                ? Color.FromArgb(255, 170, 55)
                : Color.FromArgb(45, 145, 255);
        }

        static string PhaseTitle()
        {
            return phase == "waiting"
                ? "AI needs you to decide something"
                : "AI is controlling this computer";
        }

        static IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
        {
            if (msg == Native.WM_NCHITTEST) return new IntPtr(Native.HTTRANSPARENT);
            return Native.DefWindowProc(hWnd, msg, wParam, lParam);
        }

        static OverlayForm CreateForm(string name, int x, int y, int w, int h, Bitmap content, bool excludeFromCapture)
        {
            string cls = "DshCuaOverlay_" + name + "_" + Guid.NewGuid().ToString("N").Substring(0, 8);
            var wc = new Native.WNDCLASSEX();
            wc.cbSize = Marshal.SizeOf(typeof(Native.WNDCLASSEX));
            wc.style = 0;
            wc.lpfnWndProc = procKeepAlive;
            wc.hInstance = Native.GetModuleHandle(null);
            wc.lpszClassName = cls;
            if (Native.RegisterClassEx(ref wc) == 0)
                throw new InvalidOperationException("RegisterClassEx failed: " + Marshal.GetLastWin32Error());

            int ex = Native.WS_EX_LAYERED | Native.WS_EX_TRANSPARENT | Native.WS_EX_TOPMOST
                     | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE;
            IntPtr hwnd = Native.CreateWindowEx(
                ex, cls, "dsh-zcode-cua indicator", Native.WS_POPUP, x, y, w, h,
                IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
            if (hwnd == IntPtr.Zero)
            {
                Native.UnregisterClass(cls, wc.hInstance);
                throw new InvalidOperationException("CreateWindowEx failed: " + Marshal.GetLastWin32Error());
            }

            var form = new OverlayForm
            {
                Handle = hwnd,
                ClassName = cls,
                X = x, Y = y, W = w, H = h,
                Content = content,
                Pixels = Premultiplied(content),
            };
            ClassNames.Add(cls);

            // Best-effort: on compositors that reject the affinity we still get
            // exclusion from the host's hide-before-capture.
            Native.SetWindowDisplayAffinity(
                hwnd, excludeFromCapture ? Native.WDA_EXCLUDEFROMCAPTURE : Native.WDA_NONE);
            Push(form, 255);
            return form;
        }

        static byte[] Premultiplied(Bitmap bmp)
        {
            var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
            BitmapData data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                byte[] raw = new byte[data.Stride * bmp.Height];
                Marshal.Copy(data.Scan0, raw, 0, raw.Length);
                // GDI+ gives BGRA with straight alpha; UpdateLayeredWindow wants
                // premultiplied. Doing it here keeps the upload path allocation-free.
                for (int i = 0; i < raw.Length; i += 4)
                {
                    int a = raw[i + 3];
                    if (a == 255) continue;
                    if (a == 0)
                    {
                        raw[i] = 0; raw[i + 1] = 0; raw[i + 2] = 0;
                        continue;
                    }
                    raw[i] = (byte)(raw[i] * a / 255);
                    raw[i + 1] = (byte)(raw[i + 1] * a / 255);
                    raw[i + 2] = (byte)(raw[i + 2] * a / 255);
                }
                return raw;
            }
            finally
            {
                bmp.UnlockBits(data);
            }
        }

        static void Push(OverlayForm form, byte opacity)
        {
            IntPtr screenDc = Native.GetDC(IntPtr.Zero);
            if (screenDc == IntPtr.Zero) return;
            try
            {
                IntPtr memDc = Native.CreateCompatibleDC(screenDc);
                if (memDc == IntPtr.Zero) return;
                try
                {
                    var bmi = new Native.BITMAPINFO();
                    bmi.bmiHeader.biSize = Marshal.SizeOf(typeof(Native.BITMAPINFOHEADER));
                    bmi.bmiHeader.biWidth = form.W;
                    bmi.bmiHeader.biHeight = -form.H;   // top-down
                    bmi.bmiHeader.biPlanes = 1;
                    bmi.bmiHeader.biBitCount = 32;
                    bmi.bmiHeader.biCompression = 0;    // BI_RGB

                    IntPtr bits;
                    IntPtr hbm = Native.CreateDIBSection(screenDc, ref bmi, 0, out bits, IntPtr.Zero, 0);
                    if (hbm == IntPtr.Zero) return;
                    try
                    {
                        if (opacity >= 255)
                        {
                            Marshal.Copy(form.Pixels, 0, bits, form.Pixels.Length);
                        }
                        else
                        {
                            // Fade by scaling the premultiplied channels, which is
                            // what a constant-alpha blend does anyway.
                            byte[] faded = (byte[])form.Pixels.Clone();
                            for (int i = 0; i < faded.Length; i += 4)
                            {
                                faded[i] = (byte)(faded[i] * opacity / 255);
                                faded[i + 1] = (byte)(faded[i + 1] * opacity / 255);
                                faded[i + 2] = (byte)(faded[i + 2] * opacity / 255);
                                faded[i + 3] = (byte)(faded[i + 3] * opacity / 255);
                            }
                            Marshal.Copy(faded, 0, bits, faded.Length);
                        }

                        IntPtr old = Native.SelectObject(memDc, hbm);
                        try
                        {
                            var pos = new Native.POINT(form.X, form.Y);
                            var size = new Native.SIZE(form.W, form.H);
                            var src = new Native.POINT(0, 0);
                            var blend = new Native.BLENDFUNCTION
                            {
                                BlendOp = Native.AC_SRC_OVER,
                                BlendFlags = 0,
                                SourceConstantAlpha = 255,
                                AlphaFormat = Native.AC_SRC_ALPHA,
                            };
                            Native.UpdateLayeredWindow(
                                form.Handle, screenDc, ref pos, ref size, memDc, ref src, 0, ref blend, Native.ULW_ALPHA);
                        }
                        finally
                        {
                            Native.SelectObject(memDc, old);
                        }
                    }
                    finally
                    {
                        Native.DeleteObject(hbm);
                    }
                }
                finally
                {
                    Native.DeleteDC(memDc);
                }
            }
            finally
            {
                Native.ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        static GraphicsPath RoundedRect(Rectangle rect, int radius)
        {
            var path = new GraphicsPath();
            int d = Math.Max(1, radius * 2);
            path.AddArc(rect.X, rect.Y, d, d, 180, 90);
            path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
            path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        /// <summary>One screen edge: a feather that peaks at the very edge.</summary>
        static Bitmap EdgeStrip(int w, int h, string side, Color color)
        {
            var bmp = new Bitmap(Math.Max(1, w), Math.Max(1, h), PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.None;
                bool horizontal = side == "top" || side == "bottom";
                int extent = Math.Min(BORDER, horizontal ? h : w);
                for (int depth = 0; depth < extent; depth++)
                {
                    // Peak 240 at the edge, easing to 0 inward.
                    double t = 1.0 - (double)depth / Math.Max(1, extent - 1);
                    int alpha = (int)Math.Round(240 * Math.Pow(t, 1.4));
                    if (alpha <= 0) continue;
                    using (var pen = new Pen(Color.FromArgb(alpha, color), 1f))
                    {
                        switch (side)
                        {
                            case "top": g.DrawLine(pen, 0, depth, w, depth); break;
                            case "bottom": g.DrawLine(pen, 0, h - 1 - depth, w, h - 1 - depth); break;
                            case "left": g.DrawLine(pen, depth, 0, depth, h); break;
                            default: g.DrawLine(pen, w - 1 - depth, 0, w - 1 - depth, h); break;
                        }
                    }
                }
            }
            return bmp;
        }

        /// <summary>Soft radial aura behind the pointer, plus a small "AI" chip.</summary>
        static Bitmap CursorRing(Color color)
        {
            var bmp = new Bitmap(CURSOR_SIZE, CURSOR_SIZE, PixelFormat.Format32bppArgb);
            double half = (CURSOR_SIZE - 1) / 2.0;
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                for (int y = 0; y < CURSOR_SIZE; y++)
                {
                    for (int x = 0; x < CURSOR_SIZE; x++)
                    {
                        double r = Math.Sqrt((x - half) * (x - half) + (y - half) * (y - half));
                        // Hollow centre so the real pointer stays readable.
                        double clearCenter = 1.0 - Math.Exp(-0.5 * Math.Pow(Math.Max(0.0, r - 1) / 5.0, 2));
                        double outerGlow = Math.Exp(-0.5 * Math.Pow(r / 20.0, 2));
                        double edgeFade = Math.Min(1.0, Math.Max(0.0, (half - r) / 8.0));
                        int alpha = (int)Math.Round(230 * clearCenter * outerGlow * edgeFade);
                        if (alpha <= 0) continue;
                        bmp.SetPixel(x, y, Color.FromArgb(alpha, color));
                    }
                }

                // "AI" chip above-right of the hotspot, clear of the arrow body.
                using (var font = new Font("Segoe UI", CURSOR_LABEL_SIZE / 2f + 1f, FontStyle.Bold, GraphicsUnit.Pixel))
                {
                    SizeF text = g.MeasureString(CURSOR_LABEL, font);
                    int chipW = (int)text.Width + 12;
                    int chipH = (int)text.Height + 4;
                    int left = CURSOR_SIZE / 2 + 8;
                    int bottom = CURSOR_SIZE / 2 - 8;
                    var chip = new Rectangle(left, bottom - chipH, chipW, chipH);
                    using (var path = RoundedRect(chip, chipH / 2))
                    using (var brush = new SolidBrush(color))
                    {
                        g.FillPath(brush, path);
                    }
                    using (var white = new SolidBrush(Color.White))
                    {
                        g.DrawString(CURSOR_LABEL, font, white, left + 6, bottom - chipH + 2);
                    }
                }
            }
            return bmp;
        }

        /// <summary>The top-centre banner: what is happening and how to stop it.</summary>
        static Bitmap Notice(int screenWidth, Color color)
        {
            const int pad = 32;
            int available = screenWidth - 32;
            if (available < 240) return null;

            string title = PhaseTitle();
            string hint = "Move the mouse a long distance to take over";

            Font titleFont = null, hintFont = null;
            SizeF titleSize = SizeF.Empty, hintSize = SizeF.Empty;
            using (var probe = Graphics.FromImage(new Bitmap(1, 1)))
            {
                for (int px = 21; px >= 11; px--)
                {
                    var tf = new Font("Segoe UI", px + 6f, FontStyle.Bold, GraphicsUnit.Pixel);
                    var hf = new Font("Segoe UI", px, FontStyle.Regular, GraphicsUnit.Pixel);
                    SizeF ts = probe.MeasureString(title, tf);
                    SizeF hs = probe.MeasureString(hint, hf);
                    if (ts.Width + pad * 2 <= available && hs.Width + pad * 2 <= available)
                    {
                        titleFont = tf;
                        hintFont = hf;
                        titleSize = ts;
                        hintSize = hs;
                        break;
                    }
                    tf.Dispose();
                    hf.Dispose();
                }
            }
            if (titleFont == null) return null;

            const int glowPad = 32;
            int width = (int)Math.Ceiling(Math.Max(titleSize.Width, hintSize.Width)) + pad * 2;
            int height = (int)Math.Ceiling(titleSize.Height + hintSize.Height) + 30;

            var bmp = new Bitmap(width + glowPad * 2, height + glowPad * 2, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                var panel = new Rectangle(glowPad, glowPad, width, height);

                // Aura: concentric rounded outlines, densest near the panel.
                for (int i = glowPad; i >= 2; i -= 2)
                {
                    double t = 1.0 - (double)i / glowPad;
                    int alpha = (int)Math.Round(120 * t * t);
                    if (alpha <= 0) continue;
                    var outer = new Rectangle(panel.X - i, panel.Y - i, panel.Width + i * 2, panel.Height + i * 2);
                    using (var path = RoundedRect(outer, 22 + i))
                    using (var brush = new SolidBrush(Color.FromArgb(alpha, color)))
                    {
                        g.FillPath(brush, path);
                    }
                }

                // Panel body: deep navy, 80% opaque, rounded.
                using (var path = RoundedRect(panel, 22))
                using (var brush = new SolidBrush(Color.FromArgb(204, 8, 42, 88)))
                {
                    g.FillPath(brush, path);
                }
                using (var path = RoundedRect(panel, 22))
                using (var pen = new Pen(Color.FromArgb(90, color), 1f))
                {
                    g.DrawPath(pen, path);
                }

                using (var titleBrush = new SolidBrush(Color.FromArgb(255, 248, 251, 255)))
                using (var hintBrush = new SolidBrush(Color.FromArgb(255, 225, 240, 255)))
                {
                    float titleY = glowPad + 12;
                    g.DrawString(title, titleFont, titleBrush,
                        glowPad + (width - titleSize.Width) / 2f, titleY);
                    g.DrawString(hint, hintFont, hintBrush,
                        glowPad + (width - hintSize.Width) / 2f, titleY + titleSize.Height + 2);
                }
            }
            titleFont.Dispose();
            hintFont.Dispose();
            return bmp;
        }

        /// <summary>Destroy every window and forget the cached bitmaps.</summary>
        public static void Hide()
        {
            lock (Gate)
            {
                HideInternal();
            }
        }

        /// <summary>
        /// Raise the overlay for the current phase. Idempotent: calling it while
        /// already visible just repaints (so a phase change takes effect).
        ///
        /// <paramref name="excludeFromCapture"/> exists for diagnostics only: with
        /// it false the windows are capturable, which is how a test proves the
        /// overlay really paints instead of being an invisible-but-present window.
        /// </summary>
        public static string Show(string newPhase, bool excludeFromCapture = true)
        {
            lock (Gate)
            {
                if (!string.IsNullOrEmpty(newPhase)) phase = newPhase;
                HideInternal();
                try
                {
                    Color color = PhaseColor();
                    int sx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
                    int sy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
                    int sw = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
                    int sh = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
                    if (sw <= 0 || sh <= 0) return "no-display";

                    int border = Math.Min(BORDER, Math.Min(sw, sh) / 4);
                    if (border <= 0) return "display-too-small";

                    // Four edge strips. Vertical strips start below the horizontal
                    // ones so corners are not blended twice.
                    Forms.Add(CreateForm("top", sx, sy, sw, border,
                        EdgeStrip(sw, border, "top", color), excludeFromCapture));
                    Forms.Add(CreateForm("bottom", sx, sy + sh - border, sw, border,
                        EdgeStrip(sw, border, "bottom", color), excludeFromCapture));
                    int sideH = Math.Max(1, sh - border * 2);
                    Forms.Add(CreateForm("left", sx, sy + border, border, sideH,
                        EdgeStrip(border, sideH, "left", color), excludeFromCapture));
                    Forms.Add(CreateForm("right", sx + sw - border, sy + border, border, sideH,
                        EdgeStrip(border, sideH, "right", color), excludeFromCapture));

                    // Banner.
                    Bitmap notice = Notice(sw, color);
                    if (notice != null)
                    {
                        const int glowPad = 32;
                        int nx = sx + (sw - notice.Width) / 2;
                        int ny = sy + border + glowPad / 2;
                        Forms.Add(CreateForm("notice", nx, ny, notice.Width, notice.Height, notice, excludeFromCapture));
                    }

                    // Cursor aura, only while the pointer is on the virtual screen.
                    // GetCursorPos rather than WinForms' Cursor.Position: the C#
                    // here must compile without a WinForms reference, because the
                    // host only guarantees System.Drawing.
                    Native.POINT cursor;
                    if (Native.GetCursorPos(out cursor)
                        && cursor.x >= sx && cursor.x < sx + sw
                        && cursor.y >= sy && cursor.y < sy + sh)
                    {
                        Forms.Add(CreateForm("cursor",
                            cursor.x - CURSOR_SIZE / 2, cursor.y - CURSOR_SIZE / 2,
                            CURSOR_SIZE, CURSOR_SIZE, CursorRing(color), excludeFromCapture));
                    }

                    foreach (OverlayForm form in Forms)
                    {
                        Native.ShowWindow(form.Handle, Native.SW_SHOWNA);
                        Native.SetWindowPos(form.Handle, Native.HWND_TOPMOST, 0, 0, 0, 0,
                            Native.SWP_NOSIZE | Native.SWP_NOMOVE | Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW);
                    }
                    visible = true;
                    return "ok:" + Forms.Count;
                }
                catch (Exception error)
                {
                    HideInternal();
                    return "error:" + error.Message;
                }
            }
        }

        static void HideInternal()
        {
            foreach (OverlayForm form in Forms)
            {
                if (form.Handle != IntPtr.Zero) Native.DestroyWindow(form.Handle);
                if (form.Content != null) form.Content.Dispose();
            }
            Forms.Clear();
            foreach (string cls in ClassNames)
                Native.UnregisterClass(cls, Native.GetModuleHandle(null));
            ClassNames.Clear();
            visible = false;
        }

        /// <summary>Probe used by the host to prove capture exclusion is on.</summary>
        public static string Diagnose()
        {
            lock (Gate)
            {
                int sx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
                int sy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
                int sw = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
                int sh = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
                string metrics = string.Format("virtual={0},{1} {2}x{3}", sx, sy, sw, sh);
                if (Forms.Count == 0) return "hidden " + metrics;

                uint affinity;
                bool ok = Native.GetWindowDisplayAffinity(Forms[0].Handle, out affinity);
                var parts = new List<string>();
                parts.Add(string.Format("visible:{0} windows:{1} affinity_ok:{2} affinity:0x{3:x}",
                    visible, Forms.Count, ok, affinity));
                parts.Add(metrics);
                foreach (OverlayForm form in Forms)
                {
                    Native.RECT rect;
                    string where = Native.GetWindowRect(form.Handle, out rect)
                        ? string.Format("{0}@{1},{2} {3}x{4}", form.ClassName.Substring(15),
                            rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)
                        : form.ClassName.Substring(15) + "@?";
                    parts.Add(where);
                }
                return string.Join(" ", parts.ToArray());
            }
        }

        public static void Init()
        {
            // Per-monitor-v2 FIRST, before any window or metric call. Without it
            // the process is DPI-unaware: GetSystemMetrics reports virtualized
            // (smaller) sizes while the compositor scales our windows up again,
            // and every overlay lands at the wrong place — a banner centred in a
            // 1600-wide virtual screen renders in the right half of a 3200-wide
            // physical one, half of it off-screen.
            if (!Native.SetProcessDpiAwarenessContext(Native.DPI_AWARENESS_PER_MONITOR_V2))
            {
                // Older builds: fall back to the v1 context, then to the thread.
                Native.SetProcessDpiAwarenessContext(Native.DPI_AWARENESS_PER_MONITOR);
                Native.SetThreadDpiAwarenessContext(Native.DPI_AWARENESS_PER_MONITOR_V2);
            }
            procKeepAlive = new Native.WndProcDelegate(WndProc);
            // Keep the delegate reachable: a collected WndProc crashes the window
            // procedure the moment Windows calls into it.
            GC.KeepAlive(procKeepAlive);
        }
    }
}
