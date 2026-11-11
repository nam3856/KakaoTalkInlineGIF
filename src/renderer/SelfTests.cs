using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace InlineGifRenderer
{
    internal static class SelfTests
    {
        private static void Check(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }
        internal static byte[] Fixture()
        {
            // A 2x1 GIF: red/red; green/red with restore-background disposal;
            // then transparent/blue. LZW clear codes avoid dictionary-size ambiguity.
            using (MemoryStream bytes = new MemoryStream())
            using (BinaryWriter writer = new BinaryWriter(bytes))
            {
                writer.Write(Encoding.ASCII.GetBytes("GIF89a"));
                writer.Write((ushort)2); writer.Write((ushort)1);
                writer.Write((byte)0xF1); writer.Write((byte)0); writer.Write((byte)0);
                writer.Write(new byte[] { 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255 });
                writer.Write(new byte[] { 0x21, 0xFF, 11 });
                writer.Write(Encoding.ASCII.GetBytes("NETSCAPE2.0"));
                writer.Write(new byte[] { 3, 1, 0, 0, 0 });
                WriteFrame(writer, 0, 2, new byte[] { 1, 1 }, 10, 1);
                WriteFrame(writer, 0, 1, new byte[] { 2 }, 20, 2);
                WriteFrame(writer, 1, 1, new byte[] { 3 }, 30, 1);
                writer.Write((byte)0x3B);
                writer.Flush();
                return bytes.ToArray();
            }
        }
        private static void WriteFrame(BinaryWriter writer, int left, int width, byte[] pixels, int delay, int disposal)
        {
            writer.Write(new byte[] { 0x21, 0xF9, 4, (byte)((disposal << 2) | 1) });
            writer.Write((ushort)delay); writer.Write((byte)0); writer.Write((byte)0);
            writer.Write((byte)0x2C); writer.Write((ushort)left); writer.Write((ushort)0);
            writer.Write((ushort)width); writer.Write((ushort)1); writer.Write((byte)0);
            List<int> codes = new List<int>();
            foreach (byte pixel in pixels) { codes.Add(4); codes.Add(pixel); }
            codes.Add(5);
            List<byte> compressed = new List<byte>();
            int bits = 0, bitCount = 0;
            foreach (int code in codes)
            {
                bits |= code << bitCount; bitCount += 3;
                while (bitCount >= 8) { compressed.Add((byte)(bits & 255)); bits >>= 8; bitCount -= 8; }
            }
            if (bitCount > 0) compressed.Add((byte)(bits & 255));
            writer.Write((byte)2); writer.Write((byte)compressed.Count); writer.Write(compressed.ToArray()); writer.Write((byte)0);
        }
        private static void ColorIs(Color actual, Color expected, string label)
        {
            Check(Math.Abs(actual.A - expected.A) <= 1 && Math.Abs(actual.R - expected.R) <= 1 && Math.Abs(actual.G - expected.G) <= 1 && Math.Abs(actual.B - expected.B) <= 1,
                label + ": expected " + expected.ToString() + ", got " + actual.ToString());
        }
        internal static int Run(string reportPath)
        {
            List<object> results = new List<object>();
            Action<string, Action> test = delegate(string name, Action action)
            {
                try { action(); results.Add(new { name = name, passed = true }); }
                catch (Exception exception) { results.Add(new { name = name, passed = false, error = exception.ToString() }); }
            };
            byte[] fixture = Fixture();
            test("frame-delay-and-pause-resume-retain-exact-frame", delegate
            {
                FocusedClock clock = new FocusedClock(new int[] { 100, 200, 300 });
                clock.Tick(0, true); clock.Tick(50, true);
                Check(clock.Clock.FrameIndex == 0 && clock.Clock.RemainingMs == 50, "Initial frame did not retain 50 ms.");
                clock.Tick(110, false); clock.Tick(10000, false);
                Check(clock.Clock.FrameIndex == 0 && clock.Clock.RemainingMs == 50 && clock.Clock.FramesAdvanced == 0, "Blur advanced animation.");
                clock.Tick(10050, true); clock.Tick(10099, true);
                Check(clock.Clock.FrameIndex == 0 && clock.Clock.RemainingMs == 1, "Resume did not continue remaining delay.");
                clock.Tick(10100, true);
                Check(clock.Clock.FrameIndex == 1 && clock.Clock.RemainingMs == 200 && clock.Clock.FramesAdvanced == 1, "Resume frame boundary was wrong.");
            });
            test("large-elapsed-interval-remains-bounded-and-correct", delegate
            {
                PlaybackClock clock = new PlaybackClock(new int[] { 100, 200, 300 });
                clock.Advance(50); clock.Advance(60000050);
                Check(clock.FrameIndex == 1 && clock.RemainingMs == 200 && clock.FramesAdvanced == 300001, "Large clock interval produced the wrong frame.");
            });
            test("two-gifs-have-independent-clocks", delegate
            {
                FocusedClock first = new FocusedClock(new int[] { 100, 100 });
                FocusedClock second = new FocusedClock(new int[] { 300, 300 });
                first.Tick(0, true); second.Tick(0, true); first.Tick(150, true); second.Tick(150, true);
                Check(first.Clock.FrameIndex == 1 && second.Clock.FrameIndex == 0, "GIF clocks were not independent.");
            });
            test("gif-retained-stream-delays-and-disposal-compositing", delegate
            {
                using (GifSource gif = new GifSource(fixture))
                {
                    Check(gif.FrameCount == 3 && gif.Delays[0] == 100 && gif.Delays[1] == 200 && gif.Delays[2] == 300, "GIF frame delays did not decode.");
                    Rectangle rect = new Rectangle(0, 0, 2, 1);
                    using (Bitmap image = gif.Render(0, rect, rect)) { ColorIs(image.GetPixel(0, 0), Color.Red, "First frame pixel 0"); ColorIs(image.GetPixel(1, 0), Color.Red, "First frame pixel 1"); }
                    using (Bitmap image = gif.Render(1, rect, rect)) { ColorIs(image.GetPixel(0, 0), Color.Lime, "Second frame pixel 0"); ColorIs(image.GetPixel(1, 0), Color.Red, "Second frame preserved prior pixel"); }
                    using (Bitmap image = gif.Render(2, rect, rect)) { Check(image.GetPixel(0, 0).A == 0, "Restore-background disposal did not clear pixel 0."); ColorIs(image.GetPixel(1, 0), Color.Blue, "Third frame pixel 1"); }
                }
            });
            test("gif-frame-jump-and-clipping-use-correct-source-coordinate", delegate
            {
                using (GifSource gif = new GifSource(fixture))
                {
                    Rectangle full = new Rectangle(100, 200, 2, 1), clip = new Rectangle(101, 200, 1, 1);
                    using (Bitmap image = gif.Render(2, full, clip)) { Check(image.Size == new Size(1, 1), "Clip dimensions wrong."); ColorIs(image.GetPixel(0, 0), Color.Blue, "Clipped GIF source pixel"); }
                }
            });
            test("gif-opaque-canvas-erases-static-thumbnail-under-transparent-pixels", delegate
            {
                using (GifSource gif = new GifSource(fixture))
                using (Bitmap image = gif.Render(2, new Rectangle(0, 0, 2, 1), new Rectangle(0, 0, 2, 1), Color.White))
                {
                    ColorIs(image.GetPixel(0, 0), Color.White, "Transparent GIF pixel should use supplied opaque backing");
                    ColorIs(image.GetPixel(1, 0), Color.Blue, "Backing should preserve GIF foreground");
                }
            });
            test("reject-non-gif-and-oversized-canvas", delegate
            {
                bool rejected = false;
                try { using (GifSource unused = new GifSource(new byte[13])) { } } catch (InvalidDataException) { rejected = true; }
                Check(rejected, "Non-GIF bytes accepted.");
                byte[] oversized = (byte[])fixture.Clone(); oversized[6] = 255; oversized[7] = 255; oversized[8] = 255; oversized[9] = 255;
                rejected = false;
                try { using (GifSource unused = new GifSource(oversized)) { } } catch (InvalidDataException) { rejected = true; }
                Check(rejected, "Oversized canvas accepted.");
                Check(!GifSource.IsAbsoluteLocalPath(@"C:relative.gif") && !GifSource.IsAbsoluteLocalPath(@"\\server\share\a.gif")
                    && !GifSource.IsAbsoluteLocalPath("https://example.com/a.gif") && GifSource.IsAbsoluteLocalPath(@"C:\cache\a.gif"), "Source path policy mismatch.");
            });
            test("physical-pixel-rect-clipping", delegate
            {
                Rectangle image = new Rectangle(-20, 100, 100, 80), viewport = new Rectangle(0, 110, 60, 50), owner = new Rectangle(10, 90, 300, 400);
                Check(Rectangle.Intersect(Rectangle.Intersect(image, viewport), owner) == new Rectangle(10, 110, 50, 50), "Viewport/owner clipping mismatch.");
            });
            test("synthetic-hidden-owned-window-style-and-no-focus-steal", delegate
            {
                IntPtr before = Native.GetForegroundWindow();
                using (Form owner = new Form())
                {
                    IntPtr ownerHandle = owner.Handle;
                    using (LayeredOverlay overlay = new LayeredOverlay(ownerHandle))
                    {
                        long style = Native.ExtendedStyle(overlay.NativeHandle);
                        long required = Native.WS_EX_LAYERED | Native.WS_EX_TRANSPARENT | Native.WS_EX_NOACTIVATE | Native.WS_EX_TOOLWINDOW;
                        Check((style & required) == required, "Overlay input/activation/layered styles missing.");
                        Check((style & 0x8) == 0, "Overlay must never be topmost.");
                        Check(Native.GetWindow(overlay.NativeHandle, Native.GW_OWNER) == ownerHandle, "Overlay has incorrect owner.");
                        Check(!Native.IsWindowVisible(overlay.NativeHandle), "Overlay did not start hidden.");
                        Check(Native.GetForegroundWindow() == before, "Creating hidden owner/overlay stole focus.");
                        IntPtr previousWindow = Native.GetWindow(overlay.NativeHandle, 3), nextWindow = Native.GetWindow(overlay.NativeHandle, 2);
                        using (GifSource gif = new GifSource(fixture))
                        using (Bitmap frame = gif.Render(0, new Rectangle(0, 0, 2, 1), new Rectangle(0, 0, 2, 1)))
                            overlay.PaintBitmap(frame, new Rectangle(0, 0, 2, 1), false);
                        Check(!Native.IsWindowVisible(overlay.NativeHandle), "Painting hidden overlay showed it.");
                        Check(Native.GetWindow(overlay.NativeHandle, 3) == previousWindow && Native.GetWindow(overlay.NativeHandle, 2) == nextWindow,
                            "Updating a frozen/hidden bitmap changed the window z-order.");
                        Check(Native.GetForegroundWindow() == before, "Painting hidden overlay stole focus.");
                    }
                }
            });
            JavaScriptSerializer json = new JavaScriptSerializer();
            int failed = 0;
            foreach (object result in results)
                if (!(bool)result.GetType().GetProperty("passed").GetValue(result, null)) failed++;
            RenderContext.AtomicWrite(Path.GetFullPath(reportPath), json.Serialize(new { success = failed == 0, total = results.Count, failed = failed,
                scope = "Isolated synthetic GIF and hidden owner windows only; no live KakaoTalk integration", results = results }));
            return failed == 0 ? 0 : 1;
        }
    }
}
