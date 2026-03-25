#!/usr/bin/env node
/**
 * Open Agent X — AI Model Setup Script
 *
 * Downloads and configures local AI models for image and video generation.
 * Run: npm run setup-ai
 *
 * This script:
 * 1. Checks Python + PyTorch + CUDA
 * 2. Installs missing Python dependencies
 * 3. Downloads Stable Diffusion model (~4GB)
 * 4. Optionally downloads CogVideoX model (~4GB)
 * 5. Tests everything works
 */

import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 30000, ...opts }).trim();
  } catch {
    return null;
  }
}

function print(msg) {
  console.log(`\x1b[32m[setup]\x1b[0m ${msg}`);
}
function warn(msg) {
  console.log(`\x1b[33m[setup]\x1b[0m ${msg}`);
}
function fail(msg) {
  console.log(`\x1b[31m[setup]\x1b[0m ${msg}`);
}

async function main() {
  console.log("\n  ╔═══════════════════════════════════╗");
  console.log("  ║   OPEN AGENT X — AI SETUP       ║");
  console.log("  ╚═══════════════════════════════════╝\n");

  // 1. Check Python
  print("Checking Python...");
  const pyVersion = run("python --version") || run("python3 --version");
  if (!pyVersion) {
    fail("Python not found. Install Python 3.10+ from https://python.org");
    process.exit(1);
  }
  print(`Found ${pyVersion}`);

  // 2. Check GPU
  print("Checking GPU...");
  const gpu = run('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader');
  if (gpu) {
    print(`Found GPU: ${gpu}`);
  } else {
    warn("No NVIDIA GPU detected. Image/video generation will be VERY slow on CPU.");
    const cont = await ask("Continue anyway? (y/n) ");
    if (cont.toLowerCase() !== "y") process.exit(0);
  }

  // 3. Check/install PyTorch
  print("Checking PyTorch...");
  const torchCheck = run('python -c "import torch; print(torch.__version__, torch.cuda.is_available())"');
  if (torchCheck && torchCheck.includes("True")) {
    print(`PyTorch OK: ${torchCheck}`);
  } else {
    print("Installing PyTorch with CUDA support (~2.5GB download)...");
    try {
      execSync("pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124", {
        stdio: "inherit",
        timeout: 600000,
      });
    } catch {
      fail("PyTorch installation failed. Try manually: pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124");
      process.exit(1);
    }
  }

  // 4. Check/install diffusers
  print("Checking diffusers...");
  const diffCheck = run('python -c "from diffusers import StableDiffusionPipeline; print(\'ok\')"');
  if (diffCheck === "ok") {
    print("Diffusers OK");
  } else {
    print("Installing diffusers...");
    execSync("pip install diffusers transformers accelerate safetensors imageio imageio-ffmpeg", {
      stdio: "inherit",
      timeout: 300000,
    });
  }

  // 5. Download SD model
  print("\n--- Image Generation (Stable Diffusion 1.5) ---");
  const sdChoice = await ask("Download Stable Diffusion model? (~4GB) (y/n) ");
  if (sdChoice.toLowerCase() === "y") {
    print("Downloading SD 1.5 model (this takes a few minutes)...");
    try {
      execSync('python -c "from diffusers import StableDiffusionPipeline; StableDiffusionPipeline.from_pretrained(\'runwayml/stable-diffusion-v1-5\', safety_checker=None, requires_safety_checker=False); print(\'SD model downloaded!\')"', {
        stdio: "inherit",
        timeout: 600000,
      });
      print("SD 1.5 model ready!");
    } catch {
      warn("SD download failed — will download on first use instead.");
    }
  }

  // 6. Download CogVideoX model
  print("\n--- Video Generation (CogVideoX-2B) ---");
  const vidChoice = await ask("Download CogVideoX video model? (~4GB) (y/n) ");
  if (vidChoice.toLowerCase() === "y") {
    print("Downloading CogVideoX-2B model (this takes a few minutes)...");
    try {
      execSync('python -c "from diffusers import CogVideoXPipeline; CogVideoXPipeline.from_pretrained(\'THUDM/CogVideoX-2b\'); print(\'CogVideoX model downloaded!\')"', {
        stdio: "inherit",
        timeout: 600000,
      });
      print("CogVideoX model ready!");
    } catch {
      warn("CogVideoX download failed — will download on first use instead.");
    }
  }

  // 7. Test
  print("\n--- Testing ---");
  const finalCheck = run('python -c "import torch; print(f\'PyTorch {torch.__version__}, CUDA: {torch.cuda.is_available()}, GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else \\\"N/A\\\"}\')"');
  print(finalCheck || "PyTorch check failed");

  console.log("\n  ╔═══════════════════════════════════╗");
  console.log("  ║   SETUP COMPLETE!                  ║");
  console.log("  ╚═══════════════════════════════════╝");
  console.log("\n  To start image generation:");
  console.log("    python workspace/sd-server/server.py");
  console.log("\n  To start video generation:");
  console.log("    python workspace/sd-server/video-server.py");
  console.log("\n  Then ask your agent: 'generate an image of...'");
  console.log("");

  rl.close();
}

main().catch(console.error);
