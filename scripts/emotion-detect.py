"""
Emotion Detection — analyzes voice pitch, tempo, and energy for mood estimation.
Reads a WAV file and outputs JSON with detected emotion and confidence scores.

Usage:
  python scripts/emotion-detect.py <wav_file> [--output json|text]

Requires: librosa, numpy
  pip install librosa numpy
"""

import sys, json, argparse, os
import numpy as np


def extract_features(wav_path: str) -> dict:
    """Extract acoustic features relevant to emotion."""
    import librosa

    y, sr = librosa.load(wav_path, sr=16000, mono=True)
    duration = len(y) / sr

    if duration < 0.3:
        return {"error": "Audio too short for analysis"}

    # Pitch (fundamental frequency) via pyin
    f0, voiced_flag, _ = librosa.pyin(y, fmin=50, fmax=500, sr=sr)
    f0_clean = f0[~np.isnan(f0)] if f0 is not None else np.array([])

    pitch_mean = float(np.mean(f0_clean)) if len(f0_clean) > 0 else 0
    pitch_std = float(np.std(f0_clean)) if len(f0_clean) > 0 else 0
    pitch_range = float(np.ptp(f0_clean)) if len(f0_clean) > 0 else 0

    # Energy / loudness
    rms = librosa.feature.rms(y=y)[0]
    energy_mean = float(np.mean(rms))
    energy_std = float(np.std(rms))

    # Speech rate (onset detection as proxy for syllable rate)
    onsets = librosa.onset.onset_detect(y=y, sr=sr, units="time")
    speech_rate = len(onsets) / duration if duration > 0 else 0

    # Spectral centroid (brightness)
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    brightness = float(np.mean(centroid))

    # Zero crossing rate (noisiness/breathiness)
    zcr = librosa.feature.zero_crossing_rate(y)[0]
    zcr_mean = float(np.mean(zcr))

    # MFCCs for general timbre
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    mfcc_means = [float(np.mean(mfcc[i])) for i in range(13)]

    return {
        "duration": round(duration, 2),
        "pitch_mean": round(pitch_mean, 1),
        "pitch_std": round(pitch_std, 1),
        "pitch_range": round(pitch_range, 1),
        "energy_mean": round(energy_mean, 6),
        "energy_std": round(energy_std, 6),
        "speech_rate": round(speech_rate, 2),
        "brightness": round(brightness, 1),
        "zcr_mean": round(zcr_mean, 4),
        "mfcc": [round(m, 2) for m in mfcc_means],
    }


def classify_emotion(features: dict) -> dict:
    """Rule-based emotion classification from acoustic features."""
    if "error" in features:
        return {"emotion": "unknown", "confidence": 0, "detail": features["error"]}

    scores = {
        "neutral": 0.3,
        "happy": 0.0,
        "sad": 0.0,
        "angry": 0.0,
        "anxious": 0.0,
        "calm": 0.0,
    }

    pitch = features["pitch_mean"]
    pitch_var = features["pitch_std"]
    energy = features["energy_mean"]
    rate = features["speech_rate"]
    brightness = features["brightness"]

    # High pitch + high energy + fast rate → happy/excited
    if pitch > 200 and energy > 0.05 and rate > 4:
        scores["happy"] += 0.5
    if pitch_var > 40:
        scores["happy"] += 0.2

    # Low pitch + low energy + slow rate → sad
    if pitch < 150 and energy < 0.03 and rate < 3:
        scores["sad"] += 0.5
    if pitch_var < 20:
        scores["sad"] += 0.2

    # High energy + high pitch variability + fast → angry
    if energy > 0.06 and pitch_var > 50 and rate > 4:
        scores["angry"] += 0.5
    if brightness > 3000:
        scores["angry"] += 0.2

    # Fast rate + high pitch + moderate energy → anxious
    if rate > 5 and pitch > 180 and energy < 0.05:
        scores["anxious"] += 0.4
    if features["zcr_mean"] > 0.1:
        scores["anxious"] += 0.2

    # Low energy + steady pitch + slow rate → calm
    if energy < 0.04 and pitch_var < 25 and rate < 3.5:
        scores["calm"] += 0.5

    # Normalize
    total = sum(scores.values())
    if total > 0:
        scores = {k: round(v / total, 3) for k, v in scores.items()}

    top_emotion = max(scores, key=scores.get)
    return {
        "emotion": top_emotion,
        "confidence": scores[top_emotion],
        "scores": scores,
        "features": features,
    }


def main():
    parser = argparse.ArgumentParser(description="Voice emotion detection")
    parser.add_argument("wav_file", help="Path to WAV audio file")
    parser.add_argument("--output", choices=["json", "text"], default="json")
    args = parser.parse_args()

    if not os.path.exists(args.wav_file):
        print(json.dumps({"error": f"File not found: {args.wav_file}"}))
        sys.exit(1)

    features = extract_features(args.wav_file)
    result = classify_emotion(features)

    if args.output == "text":
        e = result["emotion"]
        c = result["confidence"]
        print(f"Detected emotion: {e} (confidence: {c:.0%})")
        if "scores" in result:
            for k, v in sorted(result["scores"].items(), key=lambda x: -x[1]):
                bar = "█" * int(v * 20)
                print(f"  {k:>8}: {v:.1%} {bar}")
    else:
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
