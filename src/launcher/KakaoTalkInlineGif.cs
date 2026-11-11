using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace KakaoTalkInlineGifLauncher
{
    internal sealed class TrayContext : ApplicationContext
    {
        [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);
        private readonly string root;
        private readonly ControlStore store;
        private readonly BoundedLog log;
        private readonly NotifyIcon tray;
        private readonly ToolStripMenuItem toggle, quit;
        private readonly ContextMenuStrip menu;
        private readonly System.Windows.Forms.Timer timer;
        private readonly Control dispatcher;
        private readonly Icon enabledIcon, pausedIcon, busyIcon;
        private OwnedDaemon daemon;
        private Task startupTask;
        private bool enabled, busy, exiting, disposed;
        private string previousReadError;
        internal TrayContext(string appRoot, BoundedLog launcherLog)
        {
            root = Path.GetFullPath(appRoot);
            log = launcherLog;
            store = new ControlStore(root);
            enabled = store.PrepareFirstStart().Enabled;
            enabledIcon = MakeIcon(Color.FromArgb(37, 99, 235), false);
            pausedIcon = MakeIcon(Color.FromArgb(100, 116, 139), true);
            busyIcon = MakeIcon(Color.FromArgb(217, 119, 6), true);
            dispatcher = new Control();
            IntPtr hiddenDispatcher = dispatcher.Handle;
            toggle = new ToolStripMenuItem("인라인 GIF 사용") { Checked = enabled, CheckOnClick = false };
            quit = new ToolStripMenuItem("종료");
            toggle.Click += delegate { Toggle(); };
            quit.Click += delegate { BeginExit(true); };
            menu = new ContextMenuStrip();
            menu.Items.Add(toggle); menu.Items.Add(new ToolStripSeparator()); menu.Items.Add(quit);
            tray = new NotifyIcon { ContextMenuStrip = menu, Icon = busyIcon, Text = "카카오톡 인라인 GIF · 시작 중", Visible = true };
            timer = new System.Windows.Forms.Timer { Interval = 200 };
            timer.Tick += Poll;
            busy = true;
            startupTask = Task.Factory.StartNew(delegate
            {
                try
                {
                    OwnedDaemon started = OwnedDaemon.Start(root,
                        new BoundedLog(Path.Combine(root, "runtime", "launcher.stdout.log"), 384 * 1024),
                        new BoundedLog(Path.Combine(root, "runtime", "launcher.stderr.log"), 384 * 1024));
                    daemon = started;
                    Dispatch(delegate
                    {
                        if (exiting) return;
                        busy = false; UpdateTray(); WriteState("running", null); timer.Start();
                        log.Write("Owned daemon started, pid=" + daemon.ProcessId);
                    });
                }
                catch (Exception exception)
                {
                    log.Write("Daemon startup failed: " + exception);
                    Dispatch(delegate { WriteState("start-failed", exception.Message); ExitThread(); });
                }
            });
        }
        private static Icon MakeIcon(Color background, bool paused)
        {
            using (Bitmap bitmap = new Bitmap(32, 32))
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.Clear(Color.Transparent);
                using (Brush brush = new SolidBrush(background)) graphics.FillEllipse(brush, 1, 1, 30, 30);
                if (paused) { graphics.FillRectangle(Brushes.White, 10, 9, 4, 14); graphics.FillRectangle(Brushes.White, 18, 9, 4, 14); }
                else graphics.FillPolygon(Brushes.White, new Point[] { new Point(12, 8), new Point(24, 16), new Point(12, 24) });
                IntPtr handle = bitmap.GetHicon();
                try { using (Icon borrowed = Icon.FromHandle(handle)) return (Icon)borrowed.Clone(); }
                finally { DestroyIcon(handle); }
            }
        }
        private void Dispatch(Action action)
        {
            try { if (!disposed) dispatcher.BeginInvoke(action); } catch (InvalidOperationException) { }
        }
        private void UpdateTray()
        {
            if (disposed) return;
            toggle.Checked = enabled;
            toggle.Enabled = !busy && !exiting;
            tray.Icon = busy || exiting ? busyIcon : (enabled ? enabledIcon : pausedIcon);
            tray.Text = exiting ? "카카오톡 인라인 GIF · 정리 중" : busy ? "카카오톡 인라인 GIF · 처리 중"
                : enabled ? "카카오톡 인라인 GIF · 사용 중" : "카카오톡 인라인 GIF · 일시 중지";
        }
        private void Toggle()
        {
            if (busy || exiting) return;
            bool next = !enabled;
            busy = true; UpdateTray();
            Task.Factory.StartNew(delegate
            {
                try
                {
                    ControlState state = store.SetEnabled(next);
                    Dispatch(delegate { enabled = state.Enabled; busy = false; UpdateTray(); WriteState("running", null); if (state.Shutdown) BeginExit(false); });
                }
                catch (Exception exception)
                {
                    log.Write("Control update failed: " + exception);
                    Dispatch(delegate { busy = false; UpdateTray(); WriteState("control-error", exception.Message); });
                }
            });
        }
        private void Poll(object sender, EventArgs eventArgs)
        {
            if (exiting || busy || disposed) return;
            try
            {
                ControlState state = store.Read();
                previousReadError = null;
                enabled = state.Enabled; UpdateTray();
                if (state.Shutdown) { BeginExit(false); return; }
            }
            catch (Exception exception)
            {
                if (previousReadError != exception.Message) { previousReadError = exception.Message; log.Write("Control read failed: " + exception.Message); }
            }
            if (daemon != null && daemon.HasExited) { log.Write("Owned daemon exited."); BeginExit(false); }
        }
        private void BeginExit(bool requestShutdown)
        {
            if (exiting || disposed) return;
            exiting = true; timer.Stop(); UpdateTray(); WriteState("stopping", null);
            Task.Factory.StartNew(delegate
            {
                string error = null;
                DaemonStopResult result = null;
                try { if (requestShutdown) store.RequestShutdown(); }
                catch (Exception exception) { error = exception.Message; log.Write("Shutdown signal failed: " + exception); }
                try
                {
                    // Startup is owned too: do not exit before its process result
                    // is known, otherwise an early tray Exit could orphan node.
                    if (startupTask != null) startupTask.Wait();
                    if (daemon != null) result = daemon.StopAfterGracePeriod(8000);
                }
                catch (Exception exception) { error = exception.Message; log.Write("Owned daemon cleanup failed: " + exception); }
                if (result != null) log.Write("Owned daemon stop: exited=" + result.Exited + ", forced=" + result.Forced + ", exitCode=" + result.ExitCode);
                Dispatch(delegate { WriteState(result != null && result.Forced ? "stopped-after-timeout" : "stopped", error); ExitThread(); });
            });
        }
        private void WriteState(string state, string error)
        {
            try
            {
                string file = Path.Combine(root, "runtime", "launcher-state.json");
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                ControlStore.AtomicWrite(file, new JavaScriptSerializer().Serialize(new { schemaVersion = 1, launcherPid = Process.GetCurrentProcess().Id,
                    childPid = daemon != null ? daemon.ProcessId : 0, utc = DateTime.UtcNow.ToString("o"), enabled = enabled, state = state, error = error }));
            }
            catch (Exception exception) { log.Write("Launcher state delivery failed: " + exception.Message); }
        }
        protected override void ExitThreadCore()
        {
            if (!disposed)
            {
                disposed = true;
                timer.Stop(); timer.Dispose();
                tray.Visible = false; tray.Dispose(); menu.Dispose();
                if (daemon != null) { daemon.Dispose(); daemon = null; }
                dispatcher.Dispose(); enabledIcon.Dispose(); pausedIcon.Dispose(); busyIcon.Dispose();
            }
            base.ExitThreadCore();
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            BoundedLog log = null;
            try
            {
                log = new BoundedLog(Path.Combine(root, "runtime", "launcher.log"), 128 * 1024);
                if (args.Length == 1 && args[0] == "--stop") { new ControlStore(root).RequestShutdown(); return 0; }
                if (args.Length != 0) { log.Write("Unsupported launcher argument."); return 2; }
                using (Mutex instance = new Mutex(false, AppNames.InstanceMutex))
                {
                    bool owned = false;
                    try
                    {
                        try { owned = instance.WaitOne(0); } catch (AbandonedMutexException) { owned = true; }
                        if (!owned) return 0;
                        Application.EnableVisualStyles();
                        Application.SetCompatibleTextRenderingDefault(false);
                        using (TrayContext context = new TrayContext(root, log)) Application.Run(context);
                        return 0;
                    }
                    finally { if (owned) instance.ReleaseMutex(); }
                }
            }
            catch (Exception exception) { if (log != null) log.Write("Launcher failed: " + exception); return 1; }
        }
    }
}
