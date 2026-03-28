"""
Wake Word Detection — "Hey Agent"
Uses Porcupine (pvporcupine) if available, falls back to openWakeWord.
Listens on the default mic and prints JSON events to stdout when triggered.

Usage:
  python scripts/wake-word.py [--engine porcupine|openwakeword] [--sensitivity 0.6]

Requires one of:
  pip install pvporcupine pvrecorder
  pip install openwakeword sounddevice numpy
"""

import sys, os, json, argparse, time

def run_porcupine(sensitivity: float):
    """Porcupine-based wake word detection."""
    import pvporcupine
    from pvrecorder import PvRecorder

    access_key = os.environ.get("PORCUPINE_ACCESS_KEY", "")
    if not access_key:
        print(json.dumps({"error": "Set PORCUPINE_ACCESS_KEY env var"}), flush=True)
        sys.exit(1)

    # Use a custom keyword path if available, otherwise built-in "hey google" as base
    keyword_path = os.environ.get("PORCUPINE_KEYWORD_PATH")
    if keyword_path and os.path.exists(keyword_path):
        porcupine = pvporcupine.create(
            access_key=access_key,
            keyword_paths=[keyword_path],
            sensitivities=[sensitivity],
        )
    else:
        # Train a custom "Hey Agent" keyword at console.picovoice.ai
        # For now, use "computer" as a built-in stand-in
        porcupine = pvporcupine.create(
            access_key=access_key,
            keywords=["computer"],
            sensitivities=[sensitivity],
        )

    recorder = PvRecorder(frame_length=porcupine.frame_length)
    recorder.start()

    print(json.dumps({"status": "listening", "engine": "porcupine"}), flush=True)

    try:
        while True:
            pcm = recorder.read()
            keyword_index = porcupine.process(pcm)
            if keyword_index >= 0:
                print(json.dumps({
                    "event": "wake",
                    "timestamp": time.time(),
                    "engine": "porcupine",
                    "confidence": sensitivity,
                }), flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        recorder.stop()
        recorder.delete()
        porcupine.delete()


def run_openwakeword(sensitivity: float):
    """openWakeWord-based detection with custom or built-in model."""
    import numpy as np
    import sounddevice as sd
    from openwakeword.model import Model

    # openWakeWord ships with "hey_jarvis" and others; we use it as base
    # Custom "hey_agent" model can be trained via openWakeWord toolkit
    model_path = os.environ.get("OWW_MODEL_PATH")
    if model_path and os.path.exists(model_path):
        oww = Model(wakeword_models=[model_path], inference_framework="onnx")
    else:
        oww = Model(inference_framework="onnx")

    CHUNK = 1280  # 80ms at 16kHz
    RATE = 16000

    print(json.dumps({"status": "listening", "engine": "openwakeword"}), flush=True)

    def audio_callback(indata, frames, time_info, status):
        audio = (indata[:, 0] * 32767).astype(np.int16)
        prediction = oww.predict(audio)
        for model_name, score in prediction.items():
            if score > sensitivity:
                print(json.dumps({
                    "event": "wake",
                    "timestamp": time.time(),
                    "engine": "openwakeword",
                    "model": model_name,
                    "confidence": float(score),
                }), flush=True)
                oww.reset()

    with sd.InputStream(
        samplerate=RATE,
        channels=1,
        dtype="float32",
        blocksize=CHUNK,
        callback=audio_callback,
    ):
        try:
            while True:
                time.sleep(0.1)
        except KeyboardInterrupt:
            pass


def main():
    parser = argparse.ArgumentParser(description="Wake word detection for Open Agent X")
    parser.add_argument("--engine", choices=["porcupine", "openwakeword", "auto"], default="auto")
    parser.add_argument("--sensitivity", type=float, default=0.6)
    args = parser.parse_args()

    engine = args.engine

    if engine == "auto":
        try:
            import pvporcupine
            engine = "porcupine"
        except ImportError:
            try:
                import openwakeword
                engine = "openwakeword"
            except ImportError:
                print(json.dumps({"error": "No wake word engine found. Install pvporcupine or openwakeword"}), flush=True)
                sys.exit(1)

    if engine == "porcupine":
        run_porcupine(args.sensitivity)
    else:
        run_openwakeword(args.sensitivity)


if __name__ == "__main__":
    main()
