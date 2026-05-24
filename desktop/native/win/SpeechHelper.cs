// lax-speech-win — line-protocol wrapper around System.Speech.Recognition.
//
// Windows analogue of LaxSpeech.app (the macOS Swift helper). Same stdio
// contract — Electron main process spawns this once, sends start/stop/quit
// as JSON lines on stdin, reads transcript events as JSON lines on stdout.
//
// System.Speech.Recognition is part of .NET Framework (built into every
// Windows install since 4.5). No SDK download, no API key. STT runs on
// the Microsoft Desktop Speech engine that ships with the OS. Quality is
// roughly equivalent to Apple's SFSpeechRecognizer's cloud-fallback path —
// good enough for chat dictation, not Whisper-grade.
//
// Build target: .NET Framework 4.7.2 (default on Windows 10 1803+).
// Compile: csc /target:exe /reference:System.Speech.dll SpeechHelper.cs
//
// Protocol (newline-delimited JSON):
//   stdin  ← {"cmd":"start"}
//          ← {"cmd":"stop"}
//          ← {"cmd":"quit"}
//   stdout → {"type":"ready"}
//          → {"type":"result","text":"…","isFinal":true|false}
//          → {"type":"error","code":"…","message":"…"}
//          → {"type":"stopped"}

using System;
using System.Globalization;
using System.IO;
using System.Speech.Recognition;
using System.Text;
using System.Threading;

class SpeechHelper
{
    static SpeechRecognitionEngine engine;
    static readonly object engineLock = new object();
    static volatile bool running = false;

    // Minimal JSON writer — no Newtonsoft dependency, keeps the .exe to
    // ~10KB. We control all field values so escaping is straightforward.
    static string EscapeJson(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder(s.Length + 8);
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '"':  sb.Append("\\\""); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c);
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    static void EmitReady() => EmitLine("{\"type\":\"ready\"}");
    static void EmitStopped() => EmitLine("{\"type\":\"stopped\"}");
    static void EmitResult(string text, bool isFinal) =>
        EmitLine("{\"type\":\"result\",\"text\":" + EscapeJson(text) + ",\"isFinal\":" + (isFinal ? "true" : "false") + "}");
    static void EmitError(string code, string message) =>
        EmitLine("{\"type\":\"error\",\"code\":" + EscapeJson(code) + ",\"message\":" + EscapeJson(message) + "}");

    static readonly object stdoutLock = new object();
    static void EmitLine(string line)
    {
        lock (stdoutLock)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }

    static void StartEngine()
    {
        lock (engineLock)
        {
            if (running) return;
            try
            {
                // CurrentUICulture picks the installed language pack that
                // matches the user's UI. SpeechRecognitionEngine throws if
                // no recognizer exists for that culture — fall back to
                // en-US which ships on every Windows install.
                SpeechRecognitionEngine eng;
                try { eng = new SpeechRecognitionEngine(CultureInfo.CurrentUICulture); }
                catch { eng = new SpeechRecognitionEngine(new CultureInfo("en-US")); }

                eng.LoadGrammar(new DictationGrammar());
                eng.SetInputToDefaultAudioDevice();
                eng.SpeechHypothesized += (s, e) => EmitResult(e.Result.Text, false);
                eng.SpeechRecognized += (s, e) => EmitResult(e.Result.Text, true);
                eng.SpeechRecognitionRejected += (s, e) =>
                {
                    // Rejected = engine heard speech but couldn't transcribe.
                    // Routine; not an error. Skip to avoid spamming the parent.
                };
                eng.RecognizeAsync(RecognizeMode.Multiple);
                engine = eng;
                running = true;
            }
            catch (Exception ex)
            {
                EmitError("engine_start_failed", ex.Message);
            }
        }
    }

    static void StopEngine()
    {
        lock (engineLock)
        {
            if (!running) return;
            try { engine?.RecognizeAsyncStop(); } catch { }
            try { engine?.Dispose(); } catch { }
            engine = null;
            running = false;
            EmitStopped();
        }
    }

    static int Main(string[] args)
    {
        // System.Speech.Recognition has no permission gate on Windows —
        // Windows treats mic access through the OS-level Privacy setting
        // (Settings → Privacy → Microphone), which the user must enable
        // for the parent app. If denied, SetInputToDefaultAudioDevice will
        // throw and we'll surface the error to the parent.
        EmitReady();

        try
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                line = line.Trim();
                if (string.IsNullOrEmpty(line)) continue;
                // Cheap command parsing — we only ever see three shapes.
                // Avoids pulling in a JSON parser just to read {"cmd":"…"}.
                if (line.IndexOf("\"start\"") >= 0) StartEngine();
                else if (line.IndexOf("\"stop\"") >= 0) StopEngine();
                else if (line.IndexOf("\"quit\"") >= 0)
                {
                    StopEngine();
                    return 0;
                }
                else EmitError("unknown_command", line);
            }
        }
        finally
        {
            StopEngine();
        }
        return 0;
    }
}
