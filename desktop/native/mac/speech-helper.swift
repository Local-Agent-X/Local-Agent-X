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

// stdout/stderr line emitter. Apple's print() uses \n which is fine, but we
// flush explicitly so the parent doesn't sit on buffered output during long
// pauses between transcripts.
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
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
        // Locale default = current. Browser tier uses navigator.language;
        // here we match the OS locale which is the closest equivalent.
        guard let r = SFSpeechRecognizer() else { return nil }
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
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        // On-device when available — privacy + works offline. Falls back to
        // server-side automatically on older hardware where requiresOnDevice
        // would refuse outright. We don't *require* on-device; we prefer it.
        if recognizer.supportsOnDeviceRecognition {
            req.requiresOnDeviceRecognition = true
        }
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

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            emitError("audio_engine_start_failed", "\(error)")
            running = false
            return
        }

        self.task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                let text = result.bestTranscription.formattedString
                let isFinal = result.isFinal
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
