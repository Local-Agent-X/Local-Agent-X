// lax-speech-mac — line-protocol wrapper around SFSpeechRecognizer.
//
// Replaces Electron's missing webkitSpeechRecognition for the Browser voice
// tier on macOS. Electron-Chromium ships without Google's Speech API key,
// so we shell out to this helper which uses Apple's on-device recognizer
// (or its cloud fallback on older hardware) — same engine Safari uses.
//
// Protocol (all newline-delimited):
//   stdin  ← {"cmd":"start"}
//          ← {"cmd":"stop"}
//          ← {"cmd":"quit"}
//   stdout → {"type":"ready"}                        on launch + permission OK
//          → {"type":"auth","status":"denied"}       if user denied permission
//          → {"type":"result","text":"…","isFinal":false|true}
//          → {"type":"error","code":"…","message":"…"}
//          → {"type":"stopped"}                      after a clean stop
//
// One recognition task per `start`; multiple start/stop cycles per process.
// Quit on stdin EOF too — the parent process going away should kill us.

import Foundation
import AVFoundation
import Speech

// Sidecar log — Finder-launched .apps swallow stdout/stderr, so we keep
// our own breadcrumb trail in ~/.lax/logs/lax-speech-mac.log alongside
// the server's stdio log. Anyone debugging "the helper started but no
// transcripts arrived" reads this file. Cheap (a few hundred bytes per
// session); rolled by user manually if it ever matters.
let logPath: String = {
    let home = NSHomeDirectory()
    let dir = "\(home)/.lax/logs"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return "\(dir)/lax-speech-mac.log"
}()
let logHandle: FileHandle? = {
    if !FileManager.default.fileExists(atPath: logPath) {
        FileManager.default.createFile(atPath: logPath, contents: nil)
    }
    let h = FileHandle(forWritingAtPath: logPath)
    h?.seekToEndOfFile()
    return h
}()
func dlog(_ msg: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "\(stamp) \(msg)\n"
    logHandle?.write(Data(line.utf8))
}

// stdout/stderr line emitter. Apple's print() uses \n which is fine, but we
// flush explicitly so the parent doesn't sit on buffered output during long
// pauses between transcripts.
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
    if let t = obj["type"] as? String { dlog("emit \(t) \(obj)") }
}

func emitError(_ code: String, _ message: String) {
    emit(["type": "error", "code": code, "message": message])
}

// SFSpeechRecognizer enforces a ~1-minute cap per task. For continuous
// dictation we tear down and respawn the request whenever we hit that
// boundary — the user-visible behavior stays "mic stays hot until I stop."
final class SpeechSession {
    private let recognizer: SFSpeechRecognizer
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var running = false
    // Track the last emitted final transcript per task so the rotation
    // boundary doesn't double-emit. Each fresh task starts a new logical
    // utterance window from the consumer's perspective.
    private var lastFinalText = ""

    init?() {
        // Force en-US explicitly. SFSpeechRecognizer() default uses the
        // current system locale, but if the user's locale has no installed
        // model (which we can't detect at init time), the recognizer
        // silently produces zero results. en-US ships with macOS and is
        // safe; we can expose a tier-config knob later if non-English
        // users need it.
        guard let r = SFSpeechRecognizer(locale: Locale(identifier: "en-US")) else { return nil }
        self.recognizer = r
    }

    func start() {
        guard !running else { return }
        running = true
        lastFinalText = ""
        beginTask()
    }

    func stop() {
        guard running else { return }
        running = false
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        request = nil
        task?.cancel()
        task = nil
        emit(["type": "stopped"])
    }

    private func beginTask() {
        // Each task gets a fresh request — SFSpeechRecognitionRequest can't
        // be reused after endAudio. Reuse the AVAudioEngine to avoid the
        // mic re-acquire delay.
        let authStatus = SFSpeechRecognizer.authorizationStatus()
        let authLabel: String = {
            switch authStatus {
            case .authorized: return "authorized"
            case .denied: return "denied"
            case .restricted: return "restricted"
            case .notDetermined: return "notDetermined"
            @unknown default: return "unknown(\(authStatus.rawValue))"
            }
        }()
        dlog("beginTask: locale=\(recognizer.locale.identifier) supportsOnDevice=\(recognizer.supportsOnDeviceRecognition) isAvailable=\(recognizer.isAvailable) auth=\(authLabel)")
        if authStatus != .authorized {
            // Surface to parent — usually means user clicked "Don't Allow"
            // on the Speech Recognition prompt (separate from Microphone).
            // System Settings → Privacy & Security → Speech Recognition is
            // the only way to flip this back on.
            emit(["type": "auth", "status": authLabel])
            running = false
            return
        }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        // taskHint = .dictation tells the recognizer this is free-form
        // user dictation (vs. .search / .confirmation / .unspecified),
        // which biases the language model toward natural sentences
        // rather than command keywords.
        req.taskHint = .dictation
        // Server-side recognition by default. On-device is preferred on
        // paper (privacy, offline) but in practice the model isn't always
        // downloaded for the system locale, and SFSpeechRecognizer
        // silently produces zero results when requiresOnDevice=true and
        // no model is present.
        req.requiresOnDeviceRecognition = false
        self.request = req

        // Audio engine setup. The input node's format must match what we
        // hand SFSpeechAudioBufferRecognitionRequest — installTap with the
        // node's native format and let the recognizer resample internally.
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        // Defensive: a sample rate of 0 means the input device isn't ready
        // (happens briefly on cold start). Bail with a recoverable error so
        // the parent can retry instead of crashing the helper.
        if format.sampleRate == 0 {
            emitError("audio_input_unavailable", "Input device reported sample rate 0")
            running = false
            return
        }

        dlog("beginTask: input format sr=\(format.sampleRate) ch=\(format.channelCount)")
        input.removeTap(onBus: 0)
        var bufCount: Int = 0
        // Tee the first ~5s of mic audio to a WAV file so we can verify
        // it's real speech (rather than silence / garbage / wrong device).
        // If dictation isn't transcribing, the diagnostic question is:
        // "is the recognizer getting good audio?" — open the WAV to find
        // out. Capped at 80 buffers (~5s @ 16kHz/1600-frame buffers) so
        // it doesn't bloat indefinitely.
        let wavPath = "\(NSHomeDirectory())/.lax/logs/lax-speech-mac.wav"
        let wavURL = URL(fileURLWithPath: wavPath)
        try? FileManager.default.removeItem(at: wavURL)
        var wavFile: AVAudioFile? = nil
        do {
            wavFile = try AVAudioFile(forWriting: wavURL, settings: format.settings)
            dlog("dumping first ~5s to \(wavPath)")
        } catch {
            dlog("could not open WAV dump: \(error)")
        }

        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
            bufCount += 1
            // Write first 80 buffers (~5s) to disk so we can verify the
            // captured audio is actual speech. After 80, just drop the
            // tee so the file stays small.
            if bufCount <= 80, let wf = wavFile {
                do { try wf.write(from: buffer) } catch { dlog("wav write failed: \(error)") }
            }
            // Log first 3 buffers explicitly so we know the tap fired at
            // all, then every 50 after that with max amplitude.
            if bufCount <= 3 || bufCount % 50 == 0 {
                var maxAmp: Float = 0
                if let ch = buffer.floatChannelData?[0] {
                    let n = Int(buffer.frameLength)
                    for i in 0..<n { let v = abs(ch[i]); if v > maxAmp { maxAmp = v } }
                }
                dlog("audio buffers appended: \(bufCount) frameLen=\(buffer.frameLength) maxAmp=\(String(format: "%.4f", maxAmp))")
            }
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
            dlog("audio engine started, isRunning=\(audioEngine.isRunning)")
        } catch {
            dlog("audio engine start failed: \(error)")
            emitError("audio_engine_start_failed", "\(error)")
            running = false
            return
        }

        // Sanity check 1s later. If isRunning has flipped to false, the
        // engine started and immediately died (often a TCC mic denial
        // that doesn't surface as an exception). Helps disambiguate
        // "tap never fires because engine stopped" from "tap never
        // fires because no audio is reaching it."
        DispatchQueue.global().asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self = self else { return }
            dlog("1s post-start: engine.isRunning=\(self.audioEngine.isRunning) running=\(self.running)")
        }

        dlog("creating recognitionTask")
        var callbackCount = 0
        self.task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self else { return }
            callbackCount += 1
            // Log every callback firing — even if result and error are
            // both nil. If we never see "callback fired" lines, the
            // recognitionTask isn't actually processing the audio we're
            // feeding it (separate from auth / engine / format issues).
            dlog("recognitionTask callback #\(callbackCount): hasResult=\(result != nil) hasError=\(error != nil)")
            if let result = result {
                let text = result.bestTranscription.formattedString
                let isFinal = result.isFinal
                dlog("recognitionTask result: isFinal=\(isFinal) text=\"\(text)\"")
                if isFinal {
                    self.lastFinalText = text
                }
                emit(["type": "result", "text": text, "isFinal": isFinal])
                if isFinal && self.running {
                    // Rotate to a fresh task — Apple closes the previous
                    // task after isFinal, and reusing it produces no
                    // further results.
                    self.rotate()
                }
            }
            if let error = error {
                let nsError = error as NSError
                dlog("recognitionTask error: domain=\(nsError.domain) code=\(nsError.code) \(error.localizedDescription)")
                // 203 / "kAFAssistantErrorDomain 203" = no speech detected —
                // routine. Don't spam the parent for that.
                if nsError.code == 203 {
                    if self.running { self.rotate() }
                    return
                }
                emitError("recognition_error", "\(error.localizedDescription) (code \(nsError.code))")
                if self.running { self.rotate() }
            }
        }
        dlog("recognitionTask created")
    }

    private func rotate() {
        // Tear down current request/task and start a fresh one. Keep the
        // audio engine running so there's no mic-acquire gap mid-utterance.
        request?.endAudio()
        request = nil
        task = nil
        audioEngine.inputNode.removeTap(onBus: 0)
        // Re-install tap inside beginTask, which also makes a new request.
        beginTask()
    }
}

// ── Authorization flow ──
// Speech recognition has its own TCC entry (Privacy → Speech Recognition),
// separate from Microphone. requestAuthorization will trigger the system
// prompt the first time — we wait synchronously before emitting "ready" so
// the parent doesn't hand us commands before we can fulfill them.

let session = DispatchSemaphore(value: 0)
var authStatus: SFSpeechRecognizerAuthorizationStatus = .notDetermined
SFSpeechRecognizer.requestAuthorization { status in
    authStatus = status
    session.signal()
}
session.wait()

if authStatus != .authorized {
    let label: String = {
        switch authStatus {
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        default: return "unknown"
        }
    }()
    emit(["type": "auth", "status": label])
    exit(2)
}

guard let speech = SpeechSession() else {
    emitError("recognizer_unavailable", "SFSpeechRecognizer(locale: default) returned nil — locale not supported")
    exit(3)
}

emit(["type": "ready"])

// ── Command loop ──
// FileHandle.readLine() doesn't exist; readLine() from stdin is line-buffered
// on macOS and works for piped stdin. Loop until EOF or {"cmd":"quit"}.
// All commands are non-blocking — start/stop just call into SpeechSession.

while let line = readLine() {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }
    guard let data = trimmed.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let cmd = obj["cmd"] as? String else {
        emitError("bad_command", "Could not parse: \(trimmed)")
        continue
    }
    switch cmd {
    case "start": speech.start()
    case "stop": speech.stop()
    case "quit":
        speech.stop()
        exit(0)
    default:
        emitError("unknown_command", "cmd=\(cmd)")
    }
}

// stdin EOF — parent went away. Clean up and exit.
speech.stop()
exit(0)
