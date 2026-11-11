using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class TransportSelfTest
{
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static void AtomicWrite(string path, string text)
    {
        string temporary = path + ".next";
        File.WriteAllText(temporary, text, new UTF8Encoding(false));
        if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
    }
    private static Dictionary<string, object> ReadStatus(string path)
    {
        try
        {
            using (FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (StreamReader reader = new StreamReader(file)) return Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
        }
        catch { return null; }
    }
    private static void WaitFor(Func<bool> predicate, string failure)
    {
        Stopwatch timeout = Stopwatch.StartNew();
        while (timeout.ElapsedMilliseconds < 6000)
        {
            Application.DoEvents();
            if (predicate()) return;
            Thread.Sleep(20);
        }
        throw new InvalidOperationException(failure);
    }
    [STAThread]
    private static int Main(string[] args)
    {
        string rendererRoot = AppDomain.CurrentDomain.BaseDirectory;
        string renderer = Path.Combine(rendererRoot, "InlineGifRenderer.exe");
        string scratch = Path.Combine(rendererRoot, "transport-selftest");
        Directory.CreateDirectory(scratch);
        string manifest = Path.Combine(scratch, "manifest.json"), status = Path.Combine(scratch, "status.json"), gif = Path.Combine(scratch, "synthetic.gif");
        string report = Path.Combine(rendererRoot, "transport-self-test-results.json");
        List<string> passed = new List<string>();
        Process child = null;
        IntPtr foregroundBefore = GetForegroundWindow();
        try
        {
            Assembly implementation = Assembly.LoadFrom(renderer);
            Type fixtures = implementation.GetType("InlineGifRenderer.SelfTests", true);
            byte[] fixture = (byte[])fixtures.GetMethod("Fixture", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, null);
            File.WriteAllBytes(gif, fixture);
            using (Form owner = new Form())
            {
                string hwnd = "0x" + owner.Handle.ToInt64().ToString("x");
                int ownerPid = Process.GetCurrentProcess().Id;
                Func<int, object> item = delegate(int left)
                {
                    return new { id = "synthetic-gif-1", source = gif, backgroundArgb = "#FFFFFFFF",
                        imageRect = new { x = left, y = 100, width = 2, height = 1 }, clipRect = new { x = 0, y = 0, width = 500, height = 500 } };
                };
                Action<int, bool> publish = delegate(int pid, bool hasItem)
                {
                    AtomicWrite(manifest, Json.Serialize(new { schemaVersion = 1, ownerHwnd = hwnd, ownerProcessId = pid, enabled = true,
                        items = hasItem ? new object[] { item(100) } : new object[0] }));
                };
                publish(ownerPid, true);
                ProcessStartInfo start = new ProcessStartInfo(renderer, "--manifest \"" + manifest + "\" --status-file \"" + status + "\"");
                start.UseShellExecute = false; start.CreateNoWindow = true; start.WindowStyle = ProcessWindowStyle.Hidden;
                child = Process.Start(start);
                WaitFor(delegate { Dictionary<string, object> s = ReadStatus(status); return s != null && Convert.ToInt32(s["processId"]) == child.Id && Convert.ToInt32(s["loadedItems"]) == 1; }, "Manifest did not load through the external renderer CLI.");
                passed.Add("external-cli-manifest-and-explicit-status-file-load");
                Dictionary<string, object> loaded = ReadStatus(status);
                if (Convert.ToBoolean(loaded["ownerFocused"]) || Convert.ToInt64(loaded["frameAdvanceTotal"]) != 0) throw new InvalidOperationException("Hidden synthetic owner should remain paused.");
                passed.Add("hidden-owner-keeps-gif-paused");
                Dictionary<string, object> beforeLease = ReadStatus(status);
                System.Collections.IList initialItems = (System.Collections.IList)beforeLease["items"];
                Dictionary<string, object> initialItem = (Dictionary<string, object>)initialItems[0];
                long initialFrame = Convert.ToInt64(initialItem["currentFrame"]), initialRemaining = Convert.ToInt64(initialItem["remainingMs"]);
                WaitFor(delegate
                {
                    Dictionary<string, object> s = ReadStatus(status);
                    return s != null && Convert.ToBoolean(s["manifestStale"]) && !Convert.ToBoolean(s["renderingEnabled"]);
                }, "An unchanged manifest did not expire its renderer lease.");
                Dictionary<string, object> expired = ReadStatus(status);
                System.Collections.IList expiredItems = (System.Collections.IList)expired["items"];
                Dictionary<string, object> expiredItem = (Dictionary<string, object>)expiredItems[0];
                if (child.HasExited || !Convert.ToBoolean(expired["enabled"]) || Convert.ToInt32(expired["loadedItems"]) != 1
                    || Convert.ToBoolean(expiredItem["visible"]) || Convert.ToBoolean(expiredItem["playing"]))
                    throw new InvalidOperationException("Expired lease must hide/pause retained items without disabling the preference or exiting.");
                passed.Add("stalled-manifest-lease-hides-and-pauses-retained-items");
                publish(ownerPid, true);
                WaitFor(delegate
                {
                    Dictionary<string, object> s = ReadStatus(status);
                    return s != null && !Convert.ToBoolean(s["manifestStale"]) && Convert.ToBoolean(s["renderingEnabled"])
                        && Convert.ToInt32(s["loadedItems"]) == 1;
                }, "A fresh valid manifest did not resume the renderer lease.");
                Dictionary<string, object> renewed = ReadStatus(status);
                System.Collections.IList renewedItems = (System.Collections.IList)renewed["items"];
                Dictionary<string, object> renewedItem = (Dictionary<string, object>)renewedItems[0];
                if (Convert.ToInt64(renewedItem["currentFrame"]) != initialFrame || Convert.ToInt64(renewedItem["remainingMs"]) != initialRemaining)
                    throw new InvalidOperationException("Lease renewal changed the hidden owner's retained playback clock.");
                passed.Add("fresh-manifest-renews-lease-with-retained-playback-state");
                AtomicWrite(manifest, "{");
                WaitFor(delegate { Dictionary<string, object> s = ReadStatus(status); return s != null && !Convert.ToBoolean(s["enabled"]) && ((System.Collections.ICollection)s["errors"]).Count > 0; }, "Invalid manifest did not fail closed.");
                passed.Add("invalid-json-pauses-and-reports-error");
                publish(ownerPid, true);
                WaitFor(delegate { Dictionary<string, object> s = ReadStatus(status); return s != null && Convert.ToBoolean(s["enabled"]) && Convert.ToInt32(s["loadedItems"]) == 1 && ((System.Collections.ICollection)s["errors"]).Count == 0; }, "Valid manifest did not recover after invalid JSON.");
                passed.Add("atomic-manifest-recovery");
                publish(ownerPid + 1, true);
                WaitFor(delegate { Dictionary<string, object> s = ReadStatus(status); return s != null && Convert.ToInt32(s["loadedItems"]) == 0 && ((System.Collections.ICollection)s["errors"]).Count > 0; }, "Owner process-ID mismatch was not rejected.");
                passed.Add("owner-process-id-mismatch-rejected");
                publish(ownerPid, true);
                WaitFor(delegate { Dictionary<string, object> s = ReadStatus(status); return s != null && Convert.ToInt32(s["loadedItems"]) == 1; }, "Item did not reload after owner correction.");
                publish(ownerPid, false);
                WaitFor(delegate { Dictionary<string, object> s = ReadStatus(status); return s != null && Convert.ToInt32(s["loadedItems"]) == 0; }, "Removing an item did not dispose it.");
                passed.Add("manifest-item-removal-disposes-item");
                AtomicWrite(manifest, Json.Serialize(new { schemaVersion = 1, shutdown = true, items = new object[0] }));
                WaitFor(delegate { return child.HasExited; }, "Manifest shutdown did not exit the renderer.");
                Dictionary<string, object> stopped = ReadStatus(status);
                if (child.ExitCode != 0 || stopped == null || !Convert.ToBoolean(stopped["stopped"])) throw new InvalidOperationException("Clean shutdown status missing.");
                passed.Add("manifest-shutdown-cleans-up-and-exits");
                if (GetForegroundWindow() != foregroundBefore) throw new InvalidOperationException("Synthetic transport test changed foreground focus.");
                passed.Add("external-renderer-did-not-steal-focus");
            }
            AtomicWrite(report, Json.Serialize(new { success = true, total = passed.Count, scope = "Isolated hidden synthetic owner and local test GIF; no live KakaoTalk wiring", passed = passed }));
            return 0;
        }
        catch (Exception exception)
        {
            AtomicWrite(report, Json.Serialize(new { success = false, passed = passed, error = exception.ToString() }));
            return 1;
        }
        finally
        {
            if (child != null)
            {
                if (!child.HasExited)
                {
                    try { AtomicWrite(manifest, "{\"schemaVersion\":1,\"shutdown\":true,\"items\":[]}"); if (!child.WaitForExit(1000)) child.Kill(); } catch { }
                }
                child.Dispose();
            }
        }
    }
}
