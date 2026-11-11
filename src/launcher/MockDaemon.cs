using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

internal static class MockDaemon
{
    [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
    private static int Main(string[] args)
    {
        string root = Environment.CurrentDirectory;
        Directory.CreateDirectory(Path.Combine(root, "runtime"));
        JavaScriptSerializer json = new JavaScriptSerializer();
        File.WriteAllText(Path.Combine(root, "runtime", "mock-ready.json"), json.Serialize(new { pid = Process.GetCurrentProcess().Id,
            hasConsole = GetConsoleWindow() != IntPtr.Zero, workingDirectory = root, hostArgument = args.Length == 1 ? args[0] : "invalid" }));
        Console.WriteLine("mock-stdout-ready");
        Console.Error.WriteLine("mock-stderr-ready");
        Stopwatch timeout = Stopwatch.StartNew();
        while (timeout.ElapsedMilliseconds < 30000)
        {
            if (!File.Exists(Path.Combine(root, "ignore-shutdown")))
            {
                try
                {
                    using (FileStream stream = new FileStream(Path.Combine(root, "control.json"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    using (StreamReader reader = new StreamReader(stream))
                    {
                        Dictionary<string, object> state = json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                        object shutdown;
                        if (state.TryGetValue("shutdown", out shutdown) && shutdown is bool && (bool)shutdown) return 0;
                    }
                }
                catch { }
            }
            Thread.Sleep(20);
        }
        return 9;
    }
}
