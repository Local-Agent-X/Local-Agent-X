"""
Stable Diffusion API Server for Secret Agent X
Runs locally on port 7860. Generates images from text prompts.

Uses SD 1.5 by default (fast, 4GB VRAM).
Can upgrade to SDXL or Flux for higher quality.

First run downloads the model (~4GB). Subsequent runs are instant.
"""

import argparse
import io
import json
import os
import sys
import time
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# Lazy import torch/diffusers (only when server starts)
pipe = None
device = None


def load_model(model_id: str = "runwayml/stable-diffusion-v1-5"):
    """Load the Stable Diffusion pipeline. Downloads model on first run."""
    global pipe, device
    import torch
    from diffusers import StableDiffusionPipeline, DPMSolverMultistepScheduler

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32

    print(f"[sd] Loading {model_id} on {device} ({dtype})...")
    start = time.time()

    pipe = StableDiffusionPipeline.from_pretrained(
        model_id,
        torch_dtype=dtype,
        safety_checker=None,  # Disable NSFW filter for speed
        requires_safety_checker=False,
    )
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config)
    pipe = pipe.to(device)

    # Enable memory optimizations
    if device == "cuda":
        pipe.enable_attention_slicing()
        try:
            pipe.enable_xformers_memory_efficient_attention()
            print("[sd] xformers enabled")
        except Exception:
            pass

    elapsed = time.time() - start
    print(f"[sd] Model loaded in {elapsed:.1f}s on {device}")


def generate(prompt: str, width: int = 512, height: int = 512,
             steps: int = 25, guidance: float = 7.5, seed: int = -1) -> bytes:
    """Generate an image and return PNG bytes."""
    import torch

    generator = None
    if seed >= 0:
        generator = torch.Generator(device=device).manual_seed(seed)

    start = time.time()
    result = pipe(
        prompt=prompt,
        width=width,
        height=height,
        num_inference_steps=steps,
        guidance_scale=guidance,
        generator=generator,
    )
    elapsed = time.time() - start
    print(f"[sd] Generated in {elapsed:.1f}s: {prompt[:60]}")

    # Convert to PNG bytes
    img = result.images[0]
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class SDHandler(BaseHTTPRequestHandler):
    """Simple HTTP handler for image generation requests."""

    def do_POST(self):
        if self.path != "/generate":
            self.send_error(404)
            return

        # Read request body
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length > 0 else {}

        prompt = body.get("prompt", "")
        if not prompt:
            self.send_error(400, "prompt is required")
            return

        width = min(1024, max(256, body.get("width", 512)))
        height = min(1024, max(256, body.get("height", 512)))
        steps = min(50, max(10, body.get("steps", 25)))
        guidance = body.get("guidance", 7.5)
        seed = body.get("seed", -1)

        try:
            png_bytes = generate(prompt, width, height, steps, guidance, seed)

            # Save to workspace/images/
            images_dir = Path(__file__).parent.parent / "images"
            images_dir.mkdir(parents=True, exist_ok=True)
            filename = f"{uuid.uuid4().hex[:12]}_{int(time.time())}.png"
            filepath = images_dir / filename
            filepath.write_bytes(png_bytes)

            # Return metadata
            response = {
                "filename": filename,
                "path": str(filepath),
                "size": len(png_bytes),
                "width": width,
                "height": height,
                "prompt": prompt,
                "steps": steps,
                "guidance": guidance,
                "seed": seed,
            }

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())

        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def do_GET(self):
        if self.path == "/health":
            status = {"status": "ok", "model_loaded": pipe is not None, "device": str(device)}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(status).encode())
        else:
            self.send_error(404)

    def log_message(self, format, *args):
        # Quieter logging
        print(f"[sd-server] {args[0]}" if args else "")


def main():
    parser = argparse.ArgumentParser(description="Stable Diffusion API Server")
    parser.add_argument("--port", type=int, default=7860)
    parser.add_argument("--model", type=str, default="runwayml/stable-diffusion-v1-5")
    parser.add_argument("--host", type=str, default="127.0.0.1")
    args = parser.parse_args()

    load_model(args.model)

    server = HTTPServer((args.host, args.port), SDHandler)
    print(f"\n[sd] Server running at http://{args.host}:{args.port}")
    print(f"[sd] POST /generate  {{\"prompt\": \"...\", \"width\": 512, \"height\": 512}}")
    print(f"[sd] GET  /health\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[sd] Shutting down")
        server.server_close()


if __name__ == "__main__":
    main()
