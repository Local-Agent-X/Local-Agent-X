"""
XTTS Voice Server for Open Agent X
Runs a local TTS API with voice cloning support.
Endpoints:
  POST /tts          — generate speech from text (returns WAV audio)
  POST /clone        — upload a voice sample for cloning
  GET  /voices       — list available voice samples
  DELETE /voices/:id — delete a voice sample
  GET  /health       — health check
"""

import os, sys, json, io, wave, hashlib, time, glob
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote as _url_unquote

# Configurable
PORT = int(os.environ.get("XTTS_PORT", "7862"))
VOICES_DIR = Path(os.environ.get("XTTS_VOICES_DIR", os.path.expanduser("~/.sax/voices")))
VOICES_DIR.mkdir(parents=True, exist_ok=True)

# Lazy-load model (heavy, only load on first request)
_tts = None
_device = None

def get_tts():
    global _tts, _device
    if _tts is None:
        print("[xtts] Loading XTTS v2 model (first request, may take 30-60s)...")
        import torch
        # Auto-agree to CPML license (non-commercial use)
        os.environ["COQUI_TOS_AGREED"] = "1"
        from TTS.api import TTS
        _device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"[xtts] Using device: {_device} (CUDA available: {torch.cuda.is_available()})")
        _tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(_device)
        print(f"[xtts] Model loaded on {_device}")
    return _tts

def list_voices():
    """Return list of available voice samples."""
    voices = []
    for f in sorted(VOICES_DIR.glob("*.wav")):
        voices.append({
            "id": f.stem,
            "name": f.stem.replace("_", " ").title(),
            "file": f.name,
            "size": f.stat().st_size,
            "created": f.stat().st_ctime,
        })
    # Also include any .mp3 files
    for f in sorted(VOICES_DIR.glob("*.mp3")):
        voices.append({
            "id": f.stem,
            "name": f.stem.replace("_", " ").title(),
            "file": f.name,
            "size": f.stat().st_size,
            "created": f.stat().st_ctime,
        })
    return voices

def generate_speech(text, voice_id=None, language="en"):
    """Generate speech audio. Returns WAV bytes."""
    tts = get_tts()

    # Find voice sample
    speaker_wav = None
    if voice_id:
        for ext in [".wav", ".mp3"]:
            p = VOICES_DIR / f"{voice_id}{ext}"
            if p.exists():
                speaker_wav = str(p)
                break

    if not speaker_wav:
        # Use first available voice, or default
        voices = list_voices()
        if voices:
            speaker_wav = str(VOICES_DIR / voices[0]["file"])

    if not speaker_wav:
        raise ValueError("No voice samples available. Upload one first via POST /clone")

    # Generate to a temp file then read bytes
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        tts.tts_to_file(
            text=text,
            speaker_wav=speaker_wav,
            language=language,
            file_path=tmp_path,
        )
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(tmp_path)
        except:
            pass

class XTTSHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"[xtts] {args[0]}")

    def _cors(self):
        origin = self.headers.get("Origin", "*")
        self.send_header("Access-Control-Allow-Origin", origin if "127.0.0.1" in origin or "localhost" in origin else "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/health":
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "ok",
                "model": "xtts_v2",
                "loaded": _tts is not None,
                "device": _device or "not loaded yet",
                "voices": len(list_voices()),
            }).encode())
            return

        if path == "/voices":
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(list_voices()).encode())
            return

        # Serve voice audio files for preview
        if path.startswith("/voices/") and path.endswith("/preview"):
            voice_id = _url_unquote(path.split("/")[2])
            # Prevent path traversal
            if ".." in voice_id or "/" in voice_id or "\\" in voice_id or "\x00" in voice_id:
                self.send_response(400)
                self._cors()
                self.end_headers()
                self.wfile.write(b'{"error":"Invalid voice ID"}')
                return
            for ext in [".wav", ".mp3"]:
                p = VOICES_DIR / f"{voice_id}{ext}"
                if p.exists():
                    self.send_response(200)
                    self._cors()
                    ct = "audio/wav" if ext == ".wav" else "audio/mpeg"
                    self.send_header("Content-Type", ct)
                    self.send_header("Content-Length", str(p.stat().st_size))
                    self.end_headers()
                    with open(p, "rb") as f:
                        self.wfile.write(f.read())
                    return
            self.send_response(404)
            self._cors()
            self.end_headers()
            return

        self.send_response(404)
        self._cors()
        self.end_headers()

    def do_POST(self):
        path = urlparse(self.path).path
        content_length = int(self.headers.get("Content-Length", 0))

        MAX_BODY = 50 * 1024 * 1024  # 50MB
        if content_length > MAX_BODY:
            self.send_response(413)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Request body too large"}).encode())
            return

        if path == "/tts":
            try:
                body = json.loads(self.rfile.read(content_length)) if content_length > 0 else {}
                text = body.get("text", "")
                voice_id = body.get("voice_id")
                language = body.get("language", "en")

                if not text:
                    self.send_response(400)
                    self._cors()
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "text is required"}).encode())
                    return

                start = time.time()
                audio_bytes = generate_speech(text, voice_id, language)
                elapsed = time.time() - start

                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(audio_bytes)))
                self.send_header("X-Generation-Time", f"{elapsed:.2f}s")
                self.end_headers()
                self.wfile.write(audio_bytes)
                print(f"[xtts] Generated {len(text)} chars in {elapsed:.2f}s")
            except ValueError as e:
                self.send_response(400)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
            except Exception as e:
                self.send_response(500)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
            return

        if path == "/clone":
            try:
                # Read multipart form data or raw audio
                content_type = self.headers.get("Content-Type", "")

                if "multipart/form-data" in content_type:
                    import cgi
                    form = cgi.FieldStorage(
                        fp=self.rfile,
                        headers=self.headers,
                        environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": content_type},
                    )
                    name = form.getvalue("name", f"voice_{int(time.time())}")
                    audio_data = form["audio"].file.read() if "audio" in form else None
                else:
                    # Raw audio upload with name in query string
                    qs = parse_qs(urlparse(self.path).query)
                    name = qs.get("name", [f"voice_{int(time.time())}"])[0]
                    audio_data = self.rfile.read(content_length) if content_length > 0 else None

                if not audio_data:
                    self.send_response(400)
                    self._cors()
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "No audio data received"}).encode())
                    return

                # Sanitize name
                safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in name).lower()
                if not safe_name:
                    safe_name = f"voice_{int(time.time())}"

                # Save the audio sample
                ext = ".wav"  # Default
                if audio_data[:3] == b"ID3" or audio_data[:2] == b"\xff\xfb":
                    ext = ".mp3"

                out_path = VOICES_DIR / f"{safe_name}{ext}"
                with open(out_path, "wb") as f:
                    f.write(audio_data)

                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "ok": True,
                    "id": safe_name,
                    "name": safe_name.replace("_", " ").title(),
                    "file": out_path.name,
                    "size": len(audio_data),
                }).encode())
                print(f"[xtts] Voice sample saved: {safe_name} ({len(audio_data)} bytes)")
            except Exception as e:
                self.send_response(500)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
            return

        self.send_response(404)
        self._cors()
        self.end_headers()

    def do_DELETE(self):
        path = urlparse(self.path).path

        if path.startswith("/voices/"):
            voice_id = path.split("/")[2]
            deleted = False
            for ext in [".wav", ".mp3"]:
                p = VOICES_DIR / f"{voice_id}{ext}"
                if p.exists():
                    p.unlink()
                    deleted = True

            if deleted:
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True, "deleted": voice_id}).encode())
            else:
                self.send_response(404)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Voice not found"}).encode())
            return

        self.send_response(404)
        self._cors()
        self.end_headers()

if __name__ == "__main__":
    print(f"[xtts] Starting XTTS Voice Server on port {PORT}")
    print(f"[xtts] Voices directory: {VOICES_DIR}")
    print(f"[xtts] Model will load on first TTS request")
    print(f"[xtts] Endpoints:")
    print(f"  POST /tts          — generate speech")
    print(f"  POST /clone        — upload voice sample")
    print(f"  GET  /voices       — list voices")
    print(f"  GET  /health       — health check")

    server = HTTPServer(("127.0.0.1", PORT), XTTSHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[xtts] Server stopped")
