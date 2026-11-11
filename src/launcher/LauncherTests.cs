using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace KakaoTalkInlineGifLauncher
{
    internal static class LauncherTests
    {
        private static void Check(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
        private static void WaitFor(Func<bool> predicate, string message)
        {
            Stopwatch timeout = Stopwatch.StartNew();
            while (timeout.ElapsedMilliseconds < 5000) { if (predicate()) return; Thread.Sleep(20); }
            throw new InvalidOperationException(message);
        }
        private static Dictionary<string, object> ReadMarker(string path)
        {
            try { return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path)); } catch { return null; }
        }
        private static int Main()
        {
            string root = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "selftest-package");
            Directory.CreateDirectory(Path.Combine(root, "runtime"));
            string report = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher-self-test-results.json");
            List<object> tests = new List<object>();
            Action<string, Action> run = delegate(string name, Action action)
            {
                try { action(); tests.Add(new { name = name, passed = true }); }
                catch (Exception exception) { tests.Add(new { name = name, passed = false, error = exception.ToString() }); }
            };
            ControlStore store = new ControlStore(root);
            string ignore = Path.Combine(root, "ignore-shutdown"), marker = Path.Combine(root, "runtime", "mock-ready.json");
            if (File.Exists(ignore)) File.Delete(ignore);
            run("fresh-start-preserves-enabled-and-unknown-values-clears-only-stale-shutdown", delegate
            {
                ControlStore.AtomicWrite(store.PathName, "{\"enabled\":false,\"shutdown\":true,\"other\":\"preserved\"}");
                ControlState state = store.PrepareFirstStart();
                Check(!state.Enabled && !state.Shutdown && (string)state.Values["other"] == "preserved", "Fresh-start control preservation failed.");
            });
            run("toggle-does-not-clear-concurrent-shutdown", delegate
            {
                store.RequestShutdown();
                ControlState state = store.SetEnabled(true);
                Check(state.Enabled && state.Shutdown, "Toggle incorrectly cleared shutdown.");
            });
            run("strict-control-parser-rejects-invalid-booleans", delegate
            {
                ControlStore.AtomicWrite(store.PathName, "{\"enabled\":\"true\",\"shutdown\":false}");
                bool rejected = false;
                try { store.Read(); } catch (InvalidDataException) { rejected = true; }
                Check(rejected, "String enabled value was accepted as a boolean.");
                ControlStore.AtomicWrite(store.PathName, "{\"enabled\":true,\"shutdown\":false}");
            });
            run("bounded-utf8-logs-stay-within-byte-budget", delegate
            {
                string path = Path.Combine(root, "runtime", "bounded-test.log");
                BoundedLog log = new BoundedLog(path, 32768);
                for (int i = 0; i < 100; i++) log.Write("한글🙂 " + new string('X', 2000) + i);
                Check(new FileInfo(path).Length <= 32768 && File.ReadAllText(path).Contains("99"), "Bounded log exceeded its budget or lost the newest entry.");
            });
            run("packaged-daemon-launch-is-hidden-local-and-captures-both-streams", delegate
            {
                store.PrepareFirstStart();
                using (OwnedDaemon child = OwnedDaemon.Start(root, new BoundedLog(Path.Combine(root, "runtime", "test.stdout.log"), 32768), new BoundedLog(Path.Combine(root, "runtime", "test.stderr.log"), 32768)))
                {
                    try
                    {
                        WaitFor(delegate { Dictionary<string, object> data = ReadMarker(marker); return data != null && Convert.ToInt32(data["pid"]) == child.ProcessId; }, "Mock daemon did not report readiness.");
                        Dictionary<string, object> readyData = ReadMarker(marker);
                        Check(!(bool)readyData["hasConsole"] && String.Equals((string)readyData["workingDirectory"], root, StringComparison.OrdinalIgnoreCase)
                            && String.Equals((string)readyData["hostArgument"], Path.Combine(root, "host.mjs"), StringComparison.OrdinalIgnoreCase), "Hidden launch/working directory/argument mismatch.");
                        store.RequestShutdown();
                        DaemonStopResult result = child.StopAfterGracePeriod(2000);
                        Check(result.Exited && !result.Forced && result.ExitCode == 0, "Normal shutdown was not graceful.");
                    }
                    finally { if (!child.HasExited) { store.RequestShutdown(); child.StopAfterGracePeriod(1000); } }
                }
                WaitFor(delegate { return File.Exists(Path.Combine(root, "runtime", "test.stdout.log")) && File.Exists(Path.Combine(root, "runtime", "test.stderr.log")); }, "Redirected logs were not delivered.");
                Check(File.ReadAllText(Path.Combine(root, "runtime", "test.stdout.log")).Contains("mock-stdout-ready")
                    && File.ReadAllText(Path.Combine(root, "runtime", "test.stderr.log")).Contains("mock-stderr-ready"), "One redirected stream is missing.");
            });
            run("hung-daemon-termination-uses-only-retained-own-process-handle", delegate
            {
                store.PrepareFirstStart();
                File.WriteAllText(ignore, "synthetic test only");
                using (OwnedDaemon child = OwnedDaemon.Start(root, new BoundedLog(Path.Combine(root, "runtime", "test.stdout.log"), 32768), new BoundedLog(Path.Combine(root, "runtime", "test.stderr.log"), 32768)))
                {
                    try
                    {
                        WaitFor(delegate { Dictionary<string, object> data = ReadMarker(marker); return data != null && Convert.ToInt32(data["pid"]) == child.ProcessId; }, "Hung mock daemon did not report readiness.");
                        store.RequestShutdown();
                        DaemonStopResult result = child.StopAfterGracePeriod(100);
                        Check(result.Exited && result.Forced && result.ExitCode == 224, "Timeout fallback did not terminate the exact owned mock child.");
                    }
                    finally { if (!child.HasExited) child.StopAfterGracePeriod(0); }
                }
                File.Delete(ignore);
            });
            run("external-stop-cli-writes-only-package-control", delegate
            {
                store.PrepareFirstStart();
                ProcessStartInfo start = new ProcessStartInfo(Path.Combine(root, "KakaoTalkInlineGif.exe"), "--stop")
                    { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
                using (Process stop = Process.Start(start))
                {
                    Check(stop.WaitForExit(3000) && stop.ExitCode == 0, "--stop CLI failed.");
                }
                Check(store.Read().Shutdown, "--stop did not set shutdown=true in the package control file.");
            });
            int failed = 0;
            foreach (object test in tests) if (!(bool)test.GetType().GetProperty("passed").GetValue(test, null)) failed++;
            ControlStore.AtomicWrite(report, new JavaScriptSerializer().Serialize(new { success = failed == 0, total = tests.Count, failed = failed,
                scope = "Isolated mock node.exe and local control/log files; no KakaoTalk, Frida, real Node daemon, startup registry, or live tray launch", tests = tests }));
            return failed == 0 ? 0 : 1;
        }
    }
}
