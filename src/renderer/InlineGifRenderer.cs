using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace InlineGifRenderer
{
    public sealed class PixelRect
    {
        public int x { get; set; }
        public int y { get; set; }
        public int width { get; set; }
        public int height { get; set; }
        public Rectangle ToRectangle()
        {
            if (width <= 0 || height <= 0 || width > 16384 || height > 16384)
                throw new InvalidDataException("Rectangle dimensions are outside 1..16384.");
            if ((long)x + width > Int32.MaxValue || (long)y + height > Int32.MaxValue)
                throw new InvalidDataException("Rectangle coordinate overflow.");
            return new Rectangle(x, y, width, height);
        }
    }

    public sealed class ItemSpec
    {
        public string id { get; set; }
        public string ownerHwnd { get; set; }
        public int ownerProcessId { get; set; }
        public string source { get; set; }
        public string backgroundArgb { get; set; }
        public PixelRect imageRect { get; set; }
        public PixelRect clipRect { get; set; }
    }

    public sealed class RenderManifest
    {
        public int schemaVersion { get; set; }
        public string ownerHwnd { get; set; }
        public int ownerProcessId { get; set; }
        public bool? enabled { get; set; }
        public bool shutdown { get; set; }
        public List<ItemSpec> items { get; set; }
    }

    public sealed class PlaybackClock
    {
        private readonly int[] delays;
        private readonly long cycleMs;
        public int FrameIndex { get; private set; }
        public long RemainingMs { get; private set; }
        public long FramesAdvanced { get; private set; }
        public PlaybackClock(int[] frameDelays)
        {
            if (frameDelays == null || frameDelays.Length == 0) throw new ArgumentException("No frames.");
            delays = (int[])frameDelays.Clone();
            long total = 0;
            foreach (int delay in delays)
            {
                if (delay < 1) throw new ArgumentException("Nonpositive frame delay.");
                total += delay;
            }
            cycleMs = total;
            RemainingMs = delays[0];
        }
        public bool Advance(long elapsedMs)
        {
            if (elapsedMs <= 0 || delays.Length < 2) return false;
            int before = FrameIndex;
            if (elapsedMs >= cycleMs)
            {
                long cycles = elapsedMs / cycleMs;
                FramesAdvanced += cycles * delays.Length;
                elapsedMs %= cycleMs;
            }
            while (elapsedMs >= RemainingMs)
            {
                elapsedMs -= RemainingMs;
                FrameIndex = (FrameIndex + 1) % delays.Length;
                FramesAdvanced++;
                RemainingMs = delays[FrameIndex];
            }
            RemainingMs -= elapsedMs;
            return before != FrameIndex;
        }
    }

    public sealed class FocusedClock
    {
        private bool initialized;
        private bool wasPlaying;
        private long lastMs;
        public readonly PlaybackClock Clock;
        public bool Playing { get { return wasPlaying; } }
        public FocusedClock(int[] delays) { Clock = new PlaybackClock(delays); }
        public bool Tick(long nowMs, bool playing)
        {
            if (!initialized) { initialized = true; lastMs = nowMs; wasPlaying = playing; return false; }
            long elapsed = Math.Max(0, nowMs - lastMs);
            lastMs = nowMs;
            bool changed = playing && wasPlaying && Clock.Advance(elapsed);
            wasPlaying = playing;
            return changed;
        }
    }

    public sealed class GifSource : IDisposable
    {
        public const long MaximumBytes = 32L * 1024 * 1024;
        public const long MaximumCanvasFramePixels = 64000000;
        private MemoryStream stream;
        private Image image;
        private int selected = -1;
        public int[] Delays { get; private set; }
        public int Width { get { return image.Width; } }
        public int Height { get { return image.Height; } }
        public int FrameCount { get { return Delays.Length; } }
        public long EstimatedCanvasFramePixels { get { return (long)Width * Height * FrameCount; } }
        public GifSource(byte[] bytes)
        {
            if (bytes == null || bytes.LongLength > MaximumBytes || bytes.Length < 13)
                throw new InvalidDataException("GIF data size is invalid or exceeds 32 MiB.");
            string signature = Encoding.ASCII.GetString(bytes, 0, 6);
            if (signature != "GIF87a" && signature != "GIF89a") throw new InvalidDataException("Source is not a GIF.");
            int width = bytes[6] | (bytes[7] << 8), height = bytes[8] | (bytes[9] << 8);
            if (width < 1 || height < 1 || width > 8192 || height > 8192 || (long)width * height > 16000000)
                throw new InvalidDataException("GIF canvas exceeds renderer limits.");
            try
            {
                stream = new MemoryStream(bytes, false);
                image = Image.FromStream(stream, false, true);
                int count = image.GetFrameCount(FrameDimension.Time);
                if (count < 1 || count > 1024 || (long)image.Width * image.Height * count > MaximumCanvasFramePixels)
                    throw new InvalidDataException("GIF frame count or total canvas-frame pixels exceeds renderer limits.");
                Delays = new int[count];
                byte[] delayBytes = null;
                try { delayBytes = image.GetPropertyItem(0x5100).Value; } catch (ArgumentException) { }
                for (int i = 0; i < count; i++)
                {
                    uint centiseconds = delayBytes != null && delayBytes.Length >= (i + 1) * 4
                        ? BitConverter.ToUInt32(delayBytes, i * 4) : 10U;
                    // Very short GIF delays follow a 20 ms lower bound; missing delays use 100 ms.
                    Delays[i] = (int)Math.Max(20L, Math.Min(60000L, (long)centiseconds * 10));
                }
            }
            catch { Dispose(); throw; }
        }
        public static GifSource FromFile(string path)
        {
            if (!IsAbsoluteLocalPath(path))
                throw new InvalidDataException("GIF source must be an absolute local file path, not a URL or UNC path.");
            string full = Path.GetFullPath(path);
            using (FileStream file = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                if (file.Length > MaximumBytes) throw new InvalidDataException("GIF exceeds 32 MiB.");
                byte[] bytes = new byte[(int)file.Length];
                int offset = 0;
                while (offset < bytes.Length)
                {
                    int read = file.Read(bytes, offset, bytes.Length - offset);
                    if (read == 0) throw new EndOfStreamException("GIF changed or was truncated during read.");
                    offset += read;
                }
                return new GifSource(bytes);
            }
        }
        internal static bool IsAbsoluteLocalPath(string path)
        {
            return !String.IsNullOrEmpty(path) && path.Length >= 3 && Char.IsLetter(path[0]) && path[1] == ':'
                && (path[2] == '\\' || path[2] == '/');
        }
        public Bitmap Render(int frameIndex, Rectangle imageRect, Rectangle visibleRect, Color? background = null)
        {
            if (frameIndex < 0 || frameIndex >= FrameCount) throw new ArgumentOutOfRangeException("frameIndex");
            if (visibleRect.Width < 1 || visibleRect.Height < 1 || (long)visibleRect.Width * visibleRect.Height > 16000000)
                throw new InvalidDataException("Visible overlay surface is invalid or too large.");
            if (selected != frameIndex)
            {
                image.SelectActiveFrame(FrameDimension.Time, frameIndex);
                selected = frameIndex;
            }
            Bitmap bitmap = new Bitmap(visibleRect.Width, visibleRect.Height, PixelFormat.Format32bppPArgb);
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                graphics.Clear(background.HasValue ? background.Value : Color.Transparent);
                graphics.CompositingMode = CompositingMode.SourceOver;
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                Rectangle target = new Rectangle(imageRect.X - visibleRect.X, imageRect.Y - visibleRect.Y, imageRect.Width, imageRect.Height);
                graphics.DrawImage(image, target, 0, 0, image.Width, image.Height, GraphicsUnit.Pixel);
            }
            return bitmap;
        }
        public void Dispose()
        {
            if (image != null) { image.Dispose(); image = null; }
            if (stream != null) { stream.Dispose(); stream = null; }
        }
    }

    internal static class Native
    {
        internal const int GWL_EXSTYLE = -20, GWLP_HWNDPARENT = -8, GW_OWNER = 4, GA_ROOT = 2, GW_HWNDNEXT = 2, GW_HWNDPREV = 3;
        internal const int WS_EX_TOPMOST = 0x8;
        internal const int WS_EX_LAYERED = 0x80000, WS_EX_TRANSPARENT = 0x20, WS_EX_NOACTIVATE = 0x08000000, WS_EX_TOOLWINDOW = 0x80;
        internal const int SW_HIDE = 0, SW_SHOWNOACTIVATE = 4;
        [StructLayout(LayoutKind.Sequential)] internal struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }
        [StructLayout(LayoutKind.Sequential)] internal struct SIZE { public int Width, Height; public SIZE(int w, int h) { Width = w; Height = h; } }
        [StructLayout(LayoutKind.Sequential)] internal struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential, Pack = 1)] internal struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
        [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] internal static extern IntPtr GetAncestor(IntPtr hWnd, int flags);
        [DllImport("user32.dll")] internal static extern IntPtr GetWindow(IntPtr hWnd, int command);
        [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int processId);
        [DllImport("user32.dll")] internal static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] internal static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
        [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr hWnd, int command);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] internal static extern int GetWindowLong32(IntPtr hWnd, int index);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLong64(IntPtr hWnd, int index);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongW", SetLastError = true)] private static extern IntPtr SetWindowLong32(IntPtr hWnd, int index, IntPtr value);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)] private static extern IntPtr SetWindowLong64(IntPtr hWnd, int index, IntPtr value);
        [DllImport("user32.dll")] internal static extern IntPtr GetDC(IntPtr hWnd);
        [DllImport("user32.dll")] internal static extern int ReleaseDC(IntPtr hWnd, IntPtr dc);
        [DllImport("gdi32.dll")] internal static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")] internal static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")] internal static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
        [DllImport("gdi32.dll")] internal static extern bool DeleteObject(IntPtr obj);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool UpdateLayeredWindow(IntPtr hWnd, IntPtr destDc, ref POINT dest, ref SIZE size, IntPtr sourceDc, ref POINT source, int colorKey, ref BLENDFUNCTION blend, int flags);
        [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
        internal static void EnablePhysicalPixels()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) { }
            try { SetProcessDPIAware(); } catch (EntryPointNotFoundException) { }
        }
        internal static IntPtr SetOwner(IntPtr window, IntPtr owner)
        {
            return IntPtr.Size == 8 ? SetWindowLong64(window, GWLP_HWNDPARENT, owner) : SetWindowLong32(window, GWLP_HWNDPARENT, owner);
        }
        internal static long ExtendedStyle(IntPtr window)
        {
            return IntPtr.Size == 8 ? GetWindowLong64(window, GWL_EXSTYLE).ToInt64() : (uint)GetWindowLong32(window, GWL_EXSTYLE);
        }
        internal static IntPtr Root(IntPtr window) { return window == IntPtr.Zero ? IntPtr.Zero : GetAncestor(window, GA_ROOT); }
        internal enum OwnerOrder { Unknown, Above, Below }
        internal static OwnerOrder OrderRelativeToOwner(IntPtr window, IntPtr owner)
        {
            if (window == IntPtr.Zero || owner == IntPtr.Zero || window == owner || !IsWindow(window) || !IsWindow(owner))
                return OwnerOrder.Unknown;
            // The usual case is an immediately adjacent owned popup. Bound both
            // traversals because other processes may change the chain meanwhile.
            for (int pass = 0; pass < 2; pass++)
            {
                int direction = pass == 0 ? GW_HWNDNEXT : GW_HWNDPREV;
                IntPtr current = window;
                for (int count = 0; count < 1024; count++)
                {
                    current = GetWindow(current, direction);
                    if (current == owner) return direction == GW_HWNDNEXT ? OwnerOrder.Above : OwnerOrder.Below;
                    if (current == IntPtr.Zero || current == window) break;
                }
            }
            return OwnerOrder.Unknown;
        }
        internal static bool RepairOwnedZOrder(IntPtr window, IntPtr owner, bool ownerFocused)
        {
            return RepairOwnedZOrder(window, owner, ownerFocused, delegate { return Root(GetForegroundWindow()); });
        }
        // The foreground reader is injected only by the isolated hidden-window
        // regression test; the production overload always reads the real focus.
        internal static bool RepairOwnedZOrder(IntPtr window, IntPtr owner, bool ownerFocused, Func<IntPtr> foregroundRoot)
        {
            if (!ownerFocused || foregroundRoot == null || foregroundRoot() != owner
                || !IsWindow(window) || !IsWindow(owner) || GetWindow(window, GW_OWNER) != owner
                || ((ExtendedStyle(window) | ExtendedStyle(owner)) & WS_EX_TOPMOST) != 0
                || OrderRelativeToOwner(window, owner) != OwnerOrder.Below) return false;
            IntPtr previous = GetWindow(owner, GW_HWNDPREV);
            if (previous == window || (previous != IntPtr.Zero && !IsWindow(previous))) return false;
            // Insert after the preceding normal window, immediately ABOVE the
            // owner. Inserting after the owner itself would put us behind it.
            // A topmost predecessor must not promote this popup to TOPMOST.
            if (previous != IntPtr.Zero && (ExtendedStyle(previous) & WS_EX_TOPMOST) != 0) previous = IntPtr.Zero; // HWND_TOP
            // Recheck focus and ownership immediately before the mutating call.
            if (foregroundRoot() != owner || GetWindow(window, GW_OWNER) != owner
                || ((ExtendedStyle(window) | ExtendedStyle(owner)) & WS_EX_TOPMOST) != 0) return false;
            // A preceding popup may have moved, closed or become topmost while
            // focus was checked. Reacquire it rather than using the stale handle.
            previous = GetWindow(owner, GW_HWNDPREV);
            if (previous == window || previous == owner || (previous != IntPtr.Zero && !IsWindow(previous))) return false;
            if (previous != IntPtr.Zero && (ExtendedStyle(previous) & WS_EX_TOPMOST) != 0) previous = IntPtr.Zero;
            // NOOWNERZORDER, NOACTIVATE, SHOWWINDOW, NOMOVE, NOSIZE; no NOZORDER.
            if (!SetWindowPos(window, previous, 0, 0, 0, 0, 0x0253))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            RequireNonTopmostOverlay(window);
            return true;
        }
        private static void RequireNonTopmostOverlay(IntPtr window)
        {
            if ((ExtendedStyle(window) & WS_EX_TOPMOST) == 0) return;
            // Fail closed if an external z-order race promoted this popup. Hide
            // before demoting only this window, without showing/activating it or
            // moving its owner. Every show path checks again, including retries.
            ShowWindow(window, SW_HIDE);
            bool demoted = SetWindowPos(window, new IntPtr(-2), 0, 0, 0, 0, 0x0213); // HWND_NOTOPMOST, no SHOWWINDOW
            if (!demoted || (ExtendedStyle(window) & WS_EX_TOPMOST) != 0)
                throw new InvalidOperationException("Unexpected topmost overlay remains hidden.");
            throw new InvalidOperationException("Unexpected topmost overlay was hidden and reset.");
        }
        internal static void ShowPreservingZOrder(IntPtr window)
        {
            RequireNonTopmostOverlay(window);
            // NOZORDER, NOOWNERZORDER, NOACTIVATE, SHOWWINDOW, NOMOVE, NOSIZE.
            // Never use HWND_TOP/TOPMOST or move the owner group on blur/restore.
            if (!SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, 0x0257))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            RequireNonTopmostOverlay(window);
        }
        internal static IntPtr ParseHandle(string value)
        {
            if (String.IsNullOrWhiteSpace(value)) throw new InvalidDataException("ownerHwnd is required.");
            ulong parsed = value.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                ? UInt64.Parse(value.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture)
                : UInt64.Parse(value, CultureInfo.InvariantCulture);
            if (parsed == 0 || parsed > Int64.MaxValue || (IntPtr.Size == 4 && parsed > UInt32.MaxValue))
                throw new InvalidDataException("Invalid owner window handle.");
            return new IntPtr(unchecked((long)parsed));
        }
        internal static bool ClientBounds(IntPtr owner, out Rectangle bounds)
        {
            bounds = Rectangle.Empty;
            RECT rect;
            if (!GetClientRect(owner, out rect)) return false;
            POINT start = new POINT(rect.Left, rect.Top), end = new POINT(rect.Right, rect.Bottom);
            if (!ClientToScreen(owner, ref start) || !ClientToScreen(owner, ref end)) return false;
            if (end.X <= start.X || end.Y <= start.Y) return false;
            bounds = Rectangle.FromLTRB(start.X, start.Y, end.X, end.Y);
            return true;
        }
    }

    internal sealed class LayeredOverlay : Form
    {
        private readonly IntPtr window;
        private readonly IntPtr owner;
        internal IntPtr NativeHandle { get { return window; } }
        internal bool OverlayShown { get; private set; }
        internal LayeredOverlay(IntPtr owner)
        {
            this.owner = owner;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            Text = "Local inline GIF overlay";
            window = Handle; // Create a hidden window; no Show/activation call here.
            Native.SetOwner(window, owner);
            if (Native.GetWindow(window, Native.GW_OWNER) != owner)
            {
                Dispose();
                throw new InvalidOperationException("Could not bind overlay ownership.");
            }
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams value = base.CreateParams;
                value.ExStyle |= Native.WS_EX_LAYERED | Native.WS_EX_TRANSPARENT | Native.WS_EX_NOACTIVATE | Native.WS_EX_TOOLWINDOW;
                return value;
            }
        }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x21) { message.Result = new IntPtr(3); return; } // MA_NOACTIVATE
            if (message.Msg == 0x84) { message.Result = new IntPtr(-1); return; } // HTTRANSPARENT
            base.WndProc(ref message);
        }
        internal void HideOverlay()
        {
            if (Native.IsWindow(window)) Native.ShowWindow(window, Native.SW_HIDE);
            OverlayShown = false;
        }
        internal bool RepairOrder(bool ownerFocused)
        {
            bool repaired = Native.RepairOwnedZOrder(window, owner, ownerFocused);
            if (repaired) OverlayShown = true;
            return repaired;
        }
        internal void PaintBitmap(Bitmap bitmap, Rectangle visible, bool show, bool ownerFocused = false)
        {
            if (!Native.IsWindow(window)) throw new InvalidOperationException("Overlay window was destroyed.");
            IntPtr screen = Native.GetDC(IntPtr.Zero), memory = IntPtr.Zero, hBitmap = IntPtr.Zero, previous = IntPtr.Zero;
            try
            {
                memory = Native.CreateCompatibleDC(screen);
                if (memory == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
                hBitmap = bitmap.GetHbitmap(Color.FromArgb(0));
                previous = Native.SelectObject(memory, hBitmap);
                Native.POINT destination = new Native.POINT(visible.X, visible.Y), source = new Native.POINT(0, 0);
                Native.SIZE size = new Native.SIZE(visible.Width, visible.Height);
                Native.BLENDFUNCTION blend = new Native.BLENDFUNCTION { BlendOp = 0, BlendFlags = 0, SourceConstantAlpha = 255, AlphaFormat = 1 };
                if (!Native.UpdateLayeredWindow(window, screen, ref destination, ref size, memory, ref source, 0, ref blend, 2))
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                if (show)
                {
                    if (!RepairOrder(ownerFocused)) Native.ShowPreservingZOrder(window);
                    OverlayShown = true;
                }
            }
            finally
            {
                if (previous != IntPtr.Zero && memory != IntPtr.Zero) Native.SelectObject(memory, previous);
                if (hBitmap != IntPtr.Zero) Native.DeleteObject(hBitmap);
                if (memory != IntPtr.Zero) Native.DeleteDC(memory);
                if (screen != IntPtr.Zero) Native.ReleaseDC(IntPtr.Zero, screen);
            }
        }
    }

    internal sealed class RenderItem : IDisposable
    {
        internal readonly string Id, SourcePath;
        internal readonly IntPtr Owner;
        internal readonly int OwnerProcessId;
        internal readonly long FileLength, FileWriteTicks;
        internal readonly GifSource Gif;
        internal readonly FocusedClock FocusClock;
        internal LayeredOverlay Overlay;
        internal Rectangle ImageRect, ClipRect, LastVisible;
        internal Color Background;
        internal bool GeometryDirty = true;
        internal long FramesRendered;
        internal int LastRenderedFrame = -1;
        internal string LastError;
        internal RenderItem(ItemSpec spec, string defaultOwner, int defaultPid)
        {
            Id = spec.id;
            if (!GifSource.IsAbsoluteLocalPath(spec.source)) throw new InvalidDataException("GIF source must be an absolute local drive path.");
            SourcePath = Path.GetFullPath(spec.source);
            IntPtr supplied = Native.ParseHandle(String.IsNullOrWhiteSpace(spec.ownerHwnd) ? defaultOwner : spec.ownerHwnd);
            if (!Native.IsWindow(supplied)) throw new InvalidDataException("Owner window does not exist.");
            Owner = Native.Root(supplied);
            int processId;
            Native.GetWindowThreadProcessId(Owner, out processId);
            int expected = spec.ownerProcessId != 0 ? spec.ownerProcessId : defaultPid;
            if (expected != 0 && processId != expected) throw new InvalidDataException("Owner process ID does not match manifest.");
            OwnerProcessId = processId;
            UpdateGeometry(spec);
            FileInfo info = new FileInfo(SourcePath);
            FileLength = info.Length;
            FileWriteTicks = info.LastWriteTimeUtc.Ticks;
            Gif = GifSource.FromFile(SourcePath);
            FocusClock = new FocusedClock(Gif.Delays);
        }
        internal bool Matches(ItemSpec spec, string defaultOwner, int defaultPid)
        {
            try
            {
                IntPtr supplied = Native.ParseHandle(String.IsNullOrWhiteSpace(spec.ownerHwnd) ? defaultOwner : spec.ownerHwnd);
                int expected = spec.ownerProcessId != 0 ? spec.ownerProcessId : defaultPid;
                FileInfo info = new FileInfo(spec.source);
                return Native.Root(supplied) == Owner && (expected == 0 || expected == OwnerProcessId)
                    && String.Equals(Path.GetFullPath(spec.source), SourcePath, StringComparison.OrdinalIgnoreCase)
                    && info.Exists && info.Length == FileLength && info.LastWriteTimeUtc.Ticks == FileWriteTicks;
            }
            catch { return false; }
        }
        internal void UpdateGeometry(ItemSpec spec)
        {
            if (spec.imageRect == null || spec.clipRect == null) throw new InvalidDataException("imageRect and clipRect are required.");
            Rectangle image = spec.imageRect.ToRectangle(), clip = spec.clipRect.ToRectangle();
            Color background = Color.Transparent;
            if (!String.IsNullOrWhiteSpace(spec.backgroundArgb))
            {
                string hex = spec.backgroundArgb.Trim().TrimStart('#');
                if (hex.Length == 6) hex = "FF" + hex;
                if (hex.Length != 8) throw new InvalidDataException("backgroundArgb must be #AARRGGBB or #RRGGBB.");
                background = Color.FromArgb(unchecked((int)UInt32.Parse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture)));
            }
            GeometryDirty |= image != ImageRect || clip != ClipRect || background != Background;
            ImageRect = image;
            ClipRect = clip;
            Background = background;
        }
        internal bool Tick(long nowMs, bool enabled, IntPtr foregroundRoot, bool freezeOnBlur)
        {
            int actualPid;
            if (!Native.IsWindow(Owner)) { Hide(); FocusClock.Tick(nowMs, false); return false; }
            Native.GetWindowThreadProcessId(Owner, out actualPid);
            if (actualPid != OwnerProcessId) { Hide(); FocusClock.Tick(nowMs, false); return false; }
            Rectangle client;
            bool available = enabled && Native.IsWindowVisible(Owner) && !Native.IsIconic(Owner) && Native.ClientBounds(Owner, out client);
            Rectangle visible = Rectangle.Empty;
            if (available)
            {
                Native.ClientBounds(Owner, out client);
                visible = Rectangle.Intersect(Rectangle.Intersect(ImageRect, ClipRect), client);
            }
            bool drawable = available && visible.Width > 0 && visible.Height > 0;
            bool play = drawable && foregroundRoot == Owner;
            bool changed = FocusClock.Tick(nowMs, play);
            if (!drawable || (!play && !freezeOnBlur)) { Hide(); return true; }
            // An unfocused newly loaded item retains the original thumbnail until
            // it has rendered while focused. Existing frames can remain frozen.
            if (Overlay == null)
            {
                if (!play) return true;
                Overlay = new LayeredOverlay(Owner);
            }
            bool redraw = changed || GeometryDirty || visible != LastVisible || !Overlay.OverlayShown;
            if (redraw)
            {
                using (Bitmap frame = Gif.Render(FocusClock.Clock.FrameIndex, ImageRect, visible, Background)) Overlay.PaintBitmap(frame, visible, true, play);
                FramesRendered++;
                LastRenderedFrame = FocusClock.Clock.FrameIndex;
                LastVisible = visible;
                GeometryDirty = false;
            }
            else if (play) Overlay.RepairOrder(true); // Resume order even during a long retained frame delay.
            return true;
        }
        internal void Hide() { if (Overlay != null) Overlay.HideOverlay(); }
        public void Dispose()
        {
            if (Overlay != null) { Overlay.HideOverlay(); Overlay.Dispose(); Overlay = null; }
            if (Gif != null) Gif.Dispose();
        }
    }

    internal sealed class RenderContext : ApplicationContext
    {
        private readonly string manifestPath, statusPath;
        private readonly bool freezeOnBlur;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private readonly Dictionary<string, RenderItem> items = new Dictionary<string, RenderItem>(StringComparer.Ordinal);
        private readonly Stopwatch watch = Stopwatch.StartNew();
        private readonly Timer timer;
        private readonly List<string> errors = new List<string>();
        private const long ManifestLeaseMs = 2500;
        private long manifestTicks = -1, manifestLength = -1, lastStatusMs = -1000, lastManifestPollMs = -1000;
        private long lastManifestAcceptedMs = -1;
        private bool enabled, disposed;
        internal RenderContext(string manifest, string status, bool freeze)
        {
            manifestPath = Path.GetFullPath(manifest);
            statusPath = String.IsNullOrWhiteSpace(status) ? manifestPath + ".status.json" : Path.GetFullPath(status);
            freezeOnBlur = freeze;
            json.MaxJsonLength = 1024 * 1024;
            timer = new Timer { Interval = 15 };
            timer.Tick += OnTick;
            timer.Start();
        }
        private void ReadManifest(long now)
        {
            FileInfo info = new FileInfo(manifestPath);
            if (!info.Exists) { enabled = false; errors.Clear(); errors.Add("Waiting for local manifest."); return; }
            if (info.Length > 1024 * 1024) throw new InvalidDataException("Manifest exceeds 1 MiB.");
            if (info.LastWriteTimeUtc.Ticks == manifestTicks && info.Length == manifestLength) return;
            string text;
            using (FileStream stream = new FileStream(manifestPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, true)) text = reader.ReadToEnd();
            RenderManifest manifest = json.Deserialize<RenderManifest>(text);
            if (manifest == null || manifest.schemaVersion != 1) throw new InvalidDataException("Expected schemaVersion 1.");
            if (manifest.shutdown) { ExitThread(); return; }
            if (manifest.items == null) manifest.items = new List<ItemSpec>();
            if (manifest.items.Count > 16) throw new InvalidDataException("At most 16 GIF items are supported.");
            HashSet<string> desired = new HashSet<string>(StringComparer.Ordinal);
            errors.Clear();
            foreach (ItemSpec spec in manifest.items)
            {
                if (spec == null || String.IsNullOrWhiteSpace(spec.id) || spec.id.Length > 200 || !desired.Add(spec.id))
                    throw new InvalidDataException("Every item requires a unique nonempty id of at most 200 characters.");
                RenderItem existing;
                items.TryGetValue(spec.id, out existing);
                try
                {
                    if (existing != null && existing.Matches(spec, manifest.ownerHwnd, manifest.ownerProcessId)) existing.UpdateGeometry(spec);
                    else
                    {
                        if (existing != null) { existing.Dispose(); items.Remove(spec.id); }
                        RenderItem created = new RenderItem(spec, manifest.ownerHwnd, manifest.ownerProcessId);
                        long totalPixels = created.Gif.EstimatedCanvasFramePixels;
                        foreach (RenderItem other in items.Values) totalPixels += other.Gif.EstimatedCanvasFramePixels;
                        if (totalPixels > 128000000) { created.Dispose(); throw new InvalidDataException("Combined GIF decode budget exceeds 128 million canvas-frame pixels."); }
                        items.Add(spec.id, created);
                    }
                }
                catch (Exception exception)
                {
                    if (existing != null) { existing.Dispose(); items.Remove(spec.id); }
                    errors.Add(spec.id + ": " + exception.Message);
                }
            }
            foreach (string id in new List<string>(items.Keys))
                if (!desired.Contains(id)) { items[id].Dispose(); items.Remove(id); }
            enabled = !manifest.enabled.HasValue || manifest.enabled.Value;
            manifestTicks = info.LastWriteTimeUtc.Ticks;
            manifestLength = info.Length;
            lastManifestAcceptedMs = now;
        }
        private bool ManifestStale(long now)
        {
            // Only a successfully parsed changed manifest renews the lease.
            // A dead or stalled host cannot leave an overlay at an old position.
            return lastManifestAcceptedMs < 0 || now - lastManifestAcceptedMs >= ManifestLeaseMs;
        }
        private void OnTick(object sender, EventArgs eventArgs)
        {
            if (disposed) return;
            long now = watch.ElapsedMilliseconds;
            if (now - lastManifestPollMs >= 50)
            {
                try { ReadManifest(now); }
                catch (Exception exception) { enabled = false; errors.Clear(); errors.Add("Manifest: " + exception.Message); }
                lastManifestPollMs = now;
            }
            if (disposed) return;
            bool renderingEnabled = enabled && !ManifestStale(now);
            IntPtr foreground = Native.Root(Native.GetForegroundWindow());
            foreach (string id in new List<string>(items.Keys))
            {
                RenderItem item = items[id];
                try
                {
                    if (!item.Tick(now, renderingEnabled, foreground, freezeOnBlur)) { item.Dispose(); items.Remove(id); }
                    else item.LastError = null;
                }
                catch (Exception exception)
                {
                    item.Hide();
                    item.FocusClock.Tick(now, false);
                    item.LastError = exception.Message;
                }
            }
            if (now - lastStatusMs >= 250) { WriteStatus(false); lastStatusMs = now; }
        }
        private void WriteStatus(bool stopped)
        {
            try
            {
                List<object> statusItems = new List<object>();
                long totalFramesAdvanced = 0;
                long totalFramesRendered = 0;
                bool anyOwnerFocused = false;
                IntPtr foreground = Native.Root(Native.GetForegroundWindow());
                foreach (RenderItem item in items.Values)
                {
                    totalFramesAdvanced += item.FocusClock.Clock.FramesAdvanced;
                    totalFramesRendered += item.FramesRendered;
                    anyOwnerFocused |= foreground == item.Owner;
                    statusItems.Add(new { id = item.Id, ownerHwnd = "0x" + item.Owner.ToInt64().ToString("x"), ownerProcessId = item.OwnerProcessId,
                        frameIndex = item.FocusClock.Clock.FrameIndex, frameCount = item.Gif.FrameCount,
                        remainingMs = item.FocusClock.Clock.RemainingMs, framesAdvanced = item.FocusClock.Clock.FramesAdvanced,
                        ownerFocused = foreground == item.Owner, currentFrame = item.FocusClock.Clock.FrameIndex,
                        frameAdvanceTotal = item.FocusClock.Clock.FramesAdvanced,
                        framesRendered = item.FramesRendered, renderedFrameIndex = item.LastRenderedFrame,
                        playing = item.FocusClock.Playing, visible = item.Overlay != null && item.Overlay.OverlayShown,
                        frozen = item.Overlay != null && item.Overlay.OverlayShown && !item.FocusClock.Playing,
                        overlayNativeVisible = item.Overlay != null && Native.IsWindowVisible(item.Overlay.NativeHandle),
                        overlayOwnerMatches = item.Overlay != null && Native.GetWindow(item.Overlay.NativeHandle, Native.GW_OWNER) == item.Owner,
                        overlayTopmost = item.Overlay != null && (Native.ExtendedStyle(item.Overlay.NativeHandle) & Native.WS_EX_TOPMOST) != 0,
                        overlayZOrder = item.Overlay == null ? "absent" : Native.OrderRelativeToOwner(item.Overlay.NativeHandle, item.Owner).ToString().ToLowerInvariant(),
                        backgroundArgb = "#" + unchecked((uint)item.Background.ToArgb()).ToString("X8"), error = item.LastError });
                }
                string text = json.Serialize(new { schemaVersion = 1, processId = Process.GetCurrentProcess().Id, utc = DateTime.UtcNow.ToString("o"),
                    enabled = enabled, stopped = stopped, loadedItems = items.Count, ownerFocused = anyOwnerFocused,
                    renderingEnabled = enabled && !ManifestStale(watch.ElapsedMilliseconds), manifestStale = ManifestStale(watch.ElapsedMilliseconds),
                    manifestLeaseMs = ManifestLeaseMs, manifestAgeMs = lastManifestAcceptedMs < 0 ? -1 : Math.Max(0, watch.ElapsedMilliseconds - lastManifestAcceptedMs),
                    frameAdvanceTotal = totalFramesAdvanced, framesRenderedTotal = totalFramesRendered, freezeOnBlur = freezeOnBlur,
                    visibilityPolicy = freezeOnBlur ? "freeze-on-blur-owned-non-topmost" : "hide-overlay-on-blur-and-retain-frame", items = statusItems, errors = errors });
                AtomicWrite(statusPath, text);
            }
            catch { /* Status delivery cannot alter rendering or launch a UI. */ }
        }
        internal static void AtomicWrite(string path, string text)
        {
            string temporary = path + ".tmp-" + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
            File.WriteAllText(temporary, text, new UTF8Encoding(false));
            if (File.Exists(path)) File.Replace(temporary, path, null);
            else File.Move(temporary, path);
        }
        protected override void ExitThreadCore()
        {
            if (!disposed)
            {
                disposed = true;
                timer.Stop();
                timer.Dispose();
                foreach (RenderItem item in items.Values) item.Dispose();
                items.Clear();
                enabled = false;
                WriteStatus(true);
            }
            base.ExitThreadCore();
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Native.EnablePhysicalPixels();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string manifest = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "manifest.json");
            string report = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "self-test-results.json");
            string status = null;
            bool selfTest = false;
            bool freezeOnBlur = true;
            try
            {
                for (int i = 0; i < args.Length; i++)
                {
                    if (args[i] == "--manifest" && i + 1 < args.Length) manifest = args[++i];
                    else if (args[i] == "--status-file" && i + 1 < args.Length) status = args[++i];
                    else if (args[i] == "--report" && i + 1 < args.Length) report = args[++i];
                    else if (args[i] == "--self-test") selfTest = true;
                    else if (args[i] == "--freeze-on-blur")
                    {
                        freezeOnBlur = true;
                        bool value;
                        if (i + 1 < args.Length && Boolean.TryParse(args[i + 1], out value)) { freezeOnBlur = value; i++; }
                    }
                    else throw new ArgumentException("Supported arguments: --manifest PATH --status-file PATH --freeze-on-blur [true|false]; --self-test --report PATH.");
                }
                if (selfTest) return SelfTests.Run(report);
                using (RenderContext context = new RenderContext(manifest, status, freezeOnBlur)) Application.Run(context);
                return 0;
            }
            catch (Exception exception)
            {
                try { RenderContext.AtomicWrite(Path.GetFullPath(report), new JavaScriptSerializer().Serialize(new { success = false, error = exception.ToString() })); } catch { }
                return 1;
            }
        }
    }
}
