using System;
using System.Diagnostics;
using System.IO;

class Launcher {
    static int Main() {
        try {
            var dir = Path.GetDirectoryName(typeof(Launcher).Assembly.Location);
            var bat = Path.Combine(dir, "install.bat");
            if (!File.Exists(bat)) {
                Console.Error.WriteLine("ERROR: install.bat not found next to this launcher.");
                Console.Error.WriteLine("Expected at: " + bat);
                Console.WriteLine();
                Console.WriteLine("Press any key to close...");
                Console.ReadKey();
                return 1;
            }
            var psi = new ProcessStartInfo("cmd.exe", "/c \"\"" + bat + "\"\"") {
                WorkingDirectory = dir,
                UseShellExecute = false
            };
            var p = Process.Start(psi);
            p.WaitForExit();
            if (p.ExitCode != 0) {
                Console.WriteLine();
                Console.WriteLine("Install exited with code " + p.ExitCode + ".");
                Console.WriteLine("Press any key to close...");
                Console.ReadKey();
            }
            return p.ExitCode;
        } catch (Exception ex) {
            Console.Error.WriteLine("ERROR: " + ex.Message);
            Console.WriteLine();
            Console.WriteLine("Press any key to close...");
            Console.ReadKey();
            return 1;
        }
    }
}
