"""
CogVideoX Video Generation Server for Secret Agent X
Runs locally on port 7861. Generates videos from text prompts.

Uses CogVideoX-2B (~4GB download, fits in 12GB VRAM with optimizations).
Generates ~6 second videos at 480x720.

First run downloads the model. Subsequent runs are instant.
"""

import argparse
import io
import json
import os
import time
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

pipe = None
device = None


def load_model(model_id: str = "THUDM/CogVideoX-2b"):
    """Load CogVideoX pipeline. Downloads model on first run (~4GB)."""
    global pipe, device
    import torch
    from diffusers import CogVideoXPipeline

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32

    print(f"[video] Loading {model_id} on {device} ({dtype})...")
    start = time.time()

    pipe = CogVideoXPipeline.from_pretrained(
        model_id,
        torch_dtype=dtype,
    )
    pipe = pipe.to(device)

    # Memory optimizations for 12GB VRAM
    if device == "cuda":
        pipe.enable_model_cpu_offload()
        pipe.vae.enable_tiling()

    elapsed = time.time() - start
    print(f"[video] Model loaded in {elapsed:.1f}s on {device}")


def generate_video(prompt: str, num_frames: int = 49, guidance: float = 6.0,
                   num_steps: int = 50, seed: int = -1) -> str:
    """Generate a video and return the saved file path."""
    import torch
    from diffusers.utils import export_to_video

    generator = None
    if seed >= 0:
        generator = torch.Generator(device="cpu").manual_seed(seed)

    start = time.time()
    print(f"[video] Generating {num_frames} frames: {prompt[:60]}...")

    result = pipe(
        prompt=prompt,
        num_videos_per_prompt=1,
        num_inference_steps=num_steps,
        num_frames=num_frames,
        guidance_scale=guidance,
        generator=generator,
    )

    elapsed = time.time() - start
    print(f"[video] Generated in {elapsed:.1f}s")

    # Save video
    videos_dir = Path(__file__).parent.parent / "videos"
    videos_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex[:12]}_{int(time.time())}.mp4"
    filepath = videos_dir / filename

    export_to_video(result.frames[0], str(filepath), fps=8)

    file_size = filepath.stat().st_size
    print(f"[video] Saved: {filepath} ({file_size / 1024:.0f}KB)")

    return str(filepath), filename, file_size


class VideoHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/generate":
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length > 0 else {}

        prompt = body.get("prompt", "")
        if not prompt:
            self.send_error(400, "prompt is required")
            return

        num_frames = min(81, max(17, body.get("num_frames", 49)))
        num_steps = min(80, max(20, body.get("steps", 50)))
        guidance = body.get("guidance", 6.0)
        seed = body.get("seed", -1)

        try:
            filepath, filename, file_size = generate_video(
                prompt, num_frames, guidance, num_steps, seed
            )

            response = {
                "filename": filename,
                "path": filepath,
                "size": file_size,
                "frames": num_frames,
                "prompt": prompt,
                "steps": num_steps,
                "guidance": guidance,
            }

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())

        except Exception as e:
            import traceback
            traceback.print_exc()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def do_GET(self):
        if self.path == "/health":
            status = {
                "status": "ok",
                "model_loaded": pipe is not None,
                "device": str(device),
                "type": "video",
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(status).encode())
        else:
            self.send_error(404)

    def log_message(self, format, *args):
        print(f"[video-server] {args[0]}" if args else "")


def main():
    parser = argparse.ArgumentParser(description="CogVideoX Video Generation Server")
    parser.add_argument("--port", type=int, default=7861)
    parser.add_argument("--model", type=str, default="THUDM/CogVideoX-2b")
    parser.add_argument("--host", type=str, default="127.0.0.1")
    args = parser.parse_args()

    load_model(args.model)

    server = HTTPServer((args.host, args.port), VideoHandler)
    print(f"\n[video] Server running at http://{args.host}:{args.port}")
    print(f'[video] POST /generate  {{"prompt": "...", "num_frames": 49, "steps": 50}}')
    print(f"[video] GET  /health\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[video] Shutting down")
        server.server_close()


if __name__ == "__main__":
    main()
