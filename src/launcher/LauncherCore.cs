using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace KakaoTalkInlineGifLauncher
{
    internal static class AppNames
    {
        internal static string UserIdentity
        {
            get
            {
                using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
                    return identity.User != null ? identity.User.Value : Environment.UserDomainName + "\\" + Environment.UserName;
            }
        }
        internal static string Hash(string value)
        {
            using (SHA256 hash = SHA256.Create())
                return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").Substring(0, 24);
        }
        internal static string InstanceMutex { get { return @"Local\KakaoTalkInlineGif.Launcher." + Hash(UserIdentity); } }
        internal static string ControlMutex(string root) { return @"Local\KakaoTalkInlineGif.Control." + Hash(UserIdentity + "|" + Path.GetFullPath(root).ToUpperInvariant()); }
    }

    internal sealed class BoundedLog
    {
        private readonly string path;
        private readonly int maximumBytes;
        private readonly object sync = new object();
        internal BoundedLog(string file, int maximum)
        {
            path = Path.GetFullPath(file);
            maximumBytes = maximum;
            Directory.CreateDirectory(Path.GetDirectoryName(path));
        }
        internal void Write(string line)
        {
            if (line == null) return;
            try
            {
                if (line.Length > 32768) line = line.Substring(0, 32768) + " [truncated]";
                byte[] bytes = Encoding.UTF8.GetBytes(DateTime.UtcNow.ToString("o") + " " + line + Environment.NewLine);
                if (bytes.Length > maximumBytes) bytes = Encoding.UTF8.GetBytes("[oversized log record omitted]" + Environment.NewLine);
                lock (sync)
                {
                    using (FileStream file = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete))
                    {
                        if (file.Length + bytes.Length > maximumBytes)
                        {
                            int retain = (int)Math.Min(file.Length, maximumBytes / 2);
                            byte[] tail = new byte[retain];
                            file.Position = file.Length - retain;
                            int offset = 0;
                            while (offset < tail.Length)
                            {
                                int read = file.Read(tail, offset, tail.Length - offset);
                                if (read == 0) break;
                                offset += read;
                            }
                            int start = 0;
                            while (start < offset && tail[start] != 10) start++;
                            if (start < offset) start++;
                            file.SetLength(0);
                            file.Write(tail, start, offset - start);
                        }
                        file.Position = file.Length;
                        file.Write(bytes, 0, bytes.Length);
                    }
                }
            }
            catch { /* Logging must never show a technical UI or stop cleanup. */ }
        }
    }

    internal sealed class ControlState
    {
        internal bool Enabled;
        internal bool Shutdown;
        internal Dictionary<string, object> Values;
    }

    internal sealed class ControlStore
    {
        private readonly string root, path, mutexName;
        internal string PathName { get { return path; } }
        internal ControlStore(string appRoot)
        {
            root = Path.GetFullPath(appRoot);
            path = Path.Combine(root, "control.json");
            mutexName = AppNames.ControlMutex(root);
        }
        private static JavaScriptSerializer Serializer()
        {
            return new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 16 };
        }
        internal ControlState Read()
        {
            if (!File.Exists(path)) return new ControlState { Enabled = true, Shutdown = false, Values = new Dictionary<string, object>(StringComparer.Ordinal) };
            string text;
            using (FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                if (file.Length > 65536) throw new InvalidDataException("control.json exceeds 64 KiB.");
                using (StreamReader reader = new StreamReader(file, Encoding.UTF8, true)) text = reader.ReadToEnd();
            }
            Dictionary<string, object> values = Serializer().DeserializeObject(text) as Dictionary<string, object>;
            if (values == null) throw new InvalidDataException("control.json must contain a JSON object.");
            bool enabled = ReadBoolean(values, "enabled", true), shutdown = ReadBoolean(values, "shutdown", false);
            object schema;
            if (values.TryGetValue("schemaVersion", out schema) && (!(schema is int) || (int)schema != 1))
                throw new InvalidDataException("Unsupported control.json schemaVersion.");
            return new ControlState { Enabled = enabled, Shutdown = shutdown, Values = values };
        }
        private static bool ReadBoolean(Dictionary<string, object> values, string key, bool fallback)
        {
            object value;
            if (!values.TryGetValue(key, out value)) return fallback;
            if (!(value is bool)) throw new InvalidDataException("control.json " + key + " must be a boolean.");
            return (bool)value;
        }
        internal ControlState PrepareFirstStart() { return Update(delegate(ControlState state) { state.Shutdown = false; }); }
        internal ControlState SetEnabled(bool enabled) { return Update(delegate(ControlState state) { state.Enabled = enabled; }); }
        internal ControlState RequestShutdown() { return Update(delegate(ControlState state) { state.Shutdown = true; }); }
        private ControlState Update(Action<ControlState> mutation)
        {
            using (Mutex mutex = new Mutex(false, mutexName))
            {
                bool acquired = false;
                try
                {
                    try { acquired = mutex.WaitOne(2000); } catch (AbandonedMutexException) { acquired = true; }
                    if (!acquired) throw new TimeoutException("Timed out acquiring the local control-file lock.");
                    ControlState state = Read();
                    mutation(state);
                    state.Values["schemaVersion"] = 1;
                    state.Values["enabled"] = state.Enabled;
                    state.Values["shutdown"] = state.Shutdown;
                    AtomicWrite(path, Serializer().Serialize(state.Values));
                    return state;
                }
                finally { if (acquired) mutex.ReleaseMutex(); }
            }
        }
        internal static void AtomicWrite(string file, string text)
        {
            string temporary = file + ".tmp-" + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture) + "-" + Thread.CurrentThread.ManagedThreadId.ToString(CultureInfo.InvariantCulture);
            File.WriteAllText(temporary, text, new UTF8Encoding(false));
            if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file);
        }
    }

    internal sealed class DaemonStopResult
    {
        internal bool Exited;
        internal bool Forced;
        internal int? ExitCode;
    }

    internal sealed class OwnedDaemon : IDisposable
    {
        [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess, out IntPtr targetHandle, uint access, bool inherit, uint options);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        private Process child;
        private IntPtr ownedHandle;
        private readonly object sync = new object();
        internal int ProcessId { get; private set; }
        internal bool HasExited
        {
            get { lock (sync) return ownedHandle == IntPtr.Zero || WaitForSingleObject(ownedHandle, 0) == 0; }
        }
        internal static OwnedDaemon Start(string appRoot, BoundedLog stdout, BoundedLog stderr)
        {
            string root = Path.GetFullPath(appRoot), node = Path.Combine(root, "bin", "node.exe"), host = Path.Combine(root, "host.mjs");
            if (!File.Exists(node) || !File.Exists(host)) throw new FileNotFoundException("The packaged node.exe or host.mjs is missing.");
            ProcessStartInfo start = new ProcessStartInfo(node, "\"" + host + "\"");
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            OwnedDaemon daemon = new OwnedDaemon();
            daemon.child = new Process { StartInfo = start, EnableRaisingEvents = true };
            daemon.child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) { stdout.Write(args.Data); };
            daemon.child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) { stderr.Write(args.Data); };
            try
            {
                if (!daemon.child.Start()) throw new InvalidOperationException("Packaged daemon did not start.");
                daemon.ProcessId = daemon.child.Id;
                // Keep a handle to this exact process object, never rediscover a PID.
                if (!DuplicateHandle(GetCurrentProcess(), daemon.child.Handle, GetCurrentProcess(), out daemon.ownedHandle, 0x00100001, false, 0))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                daemon.child.BeginOutputReadLine();
                daemon.child.BeginErrorReadLine();
                return daemon;
            }
            catch
            {
                // child was created by this object only; do not search or touch KakaoTalk.
                if (daemon.child != null)
                {
                    try { if (daemon.ProcessId != 0 && !daemon.child.HasExited) daemon.child.Kill(); } catch { }
                }
                daemon.Dispose();
                throw;
            }
        }
        internal DaemonStopResult StopAfterGracePeriod(int milliseconds)
        {
            lock (sync)
            {
                DaemonStopResult result = new DaemonStopResult();
                if (ownedHandle == IntPtr.Zero) { result.Exited = true; return result; }
                uint wait = WaitForSingleObject(ownedHandle, (uint)Math.Max(0, milliseconds));
                if (wait == 0xFFFFFFFF) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (wait == 0x102)
                {
                    result.Forced = true;
                    if (!TerminateProcess(ownedHandle, 224)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    wait = WaitForSingleObject(ownedHandle, 2000);
                }
                result.Exited = wait == 0;
                if (result.Exited) { try { result.ExitCode = child.ExitCode; } catch { } }
                return result;
            }
        }
        public void Dispose()
        {
            lock (sync)
            {
                if (ownedHandle != IntPtr.Zero) { CloseHandle(ownedHandle); ownedHandle = IntPtr.Zero; }
                if (child != null) { child.Dispose(); child = null; }
            }
        }
    }
}
