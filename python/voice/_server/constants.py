"""Pipeline tuning constants for the voice sidecar."""

MIC_SR = 16000             # Browser mic comes in at 16kHz
TTS_SR = 24000             # Kokoro outputs at 24kHz
VAD_FRAME = 512            # Silero VAD wants 512 samples at 16kHz (32ms)
VAD_THRESH = 0.5           # Silero speech-prob threshold
SILENCE_FRAMES_END = 8     # ~256ms silence -> end of speech (was 384ms;
                           # tightened because faster-whisper-turbo on GPU
                           # absorbs the tighter cut without choking)
SPEECH_FRAMES_START = 3    # ~96ms speech -> start of speech
PARTIAL_INTERVAL_S = 0.5   # Run partial STT every 500ms during active speech
MIN_UTTERANCE_S = 0.25     # Skip Whisper on shorter
TTS_CHUNK_MS = 80          # WebSocket out-chunk size for TTS
