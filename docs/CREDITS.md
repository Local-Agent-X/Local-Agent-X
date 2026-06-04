# Credits & Open-Source Acknowledgments

Local Agent X stands on a large body of open-source work. This file credits the
projects we depend on, bundle, download at install time, or wrap as sidecars.
Grouped by what they power. Licenses are listed for convenience — the upstream
project's own LICENSE is authoritative.

> Transitive/utility npm packages (build tooling, small helpers) are not listed
> individually; they're covered by `package.json` + `package-lock.json`. This
> file focuses on the projects that materially power a feature.

---

## Speech-to-text (STT)

| Project | Author / Org | License | Powers |
|---|---|---|---|
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | SYSTRAN | MIT | GPU voice sidecar transcription |
| [CTranslate2](https://github.com/OpenNMT/CTranslate2) | OpenNMT | MIT | Inference engine bundled by faster-whisper |
| [Whisper](https://github.com/openai/whisper) | OpenAI | MIT | The underlying STT model weights |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | k2-fsa | Apache-2.0 | Native/desktop on-device STT (whisper-tiny.en ONNX) |
| [silero-vad](https://github.com/snakers4/silero-vad) | Silero Team | MIT | Voice-activity detection / endpointing |

## Text-to-speech (TTS) & voice cloning

| Project | Author / Org | License | Powers |
|---|---|---|---|
| [Kokoro TTS](https://github.com/hexgrad/kokoro) ([kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx), [kokoro-js](https://github.com/hexgrad/kokoro)) | hexgrad / thewh1teagle | Apache-2.0 | Lite-tier built-in voices |
| [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) | RVC-Boss | MIT | Studio-Trained voice tier |
| [Chatterbox](https://github.com/resemble-ai/chatterbox) (chatterbox-streaming) | Resemble AI | MIT | Studio tier reference-clip cloning |
| [Ultimate RVC](https://github.com/JackismyShephard/ultimate-rvc) / [RVC](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) | community | MIT | Legacy Pro RVC tier (:7009) |
| [msedge-tts](https://github.com/Migushthe2nd/MsEdgeTTS) | Migushthe2nd | MIT | Microsoft Edge cloud TTS voices |
| [mpg123-decoder](https://github.com/eshaz/mpg123-decoder) | eshaz | LGPL-2.1 | MP3 decoding for audio playback |

## ML runtime & image/video generation

| Project | Author / Org | License | Powers |
|---|---|---|---|
| [PyTorch](https://github.com/pytorch/pytorch) (torch / torchaudio / torchvision) | PyTorch / Meta | BSD-3-Clause | All Python ML sidecars |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (onnxruntime / -gpu) | Microsoft | MIT | Kokoro + sherpa ONNX inference |
| [NumPy](https://github.com/numpy/numpy) | NumPy | BSD-3-Clause | Array math across sidecars |
| [soundfile](https://github.com/bastibe/python-soundfile) (libsndfile) | Bastian Bechtold | BSD-3-Clause | Audio I/O |
| [Diffusers](https://github.com/huggingface/diffusers) / [Transformers](https://github.com/huggingface/transformers) / [accelerate](https://github.com/huggingface/accelerate) / [safetensors](https://github.com/huggingface/safetensors) | Hugging Face | Apache-2.0 | `generate_image` / `generate_video` pipelines |
| [Stable Diffusion v1.5](https://huggingface.co/runwayml/stable-diffusion-v1-5) | RunwayML / CompVis | CreativeML OpenRAIL-M | Image generation model |
| [CogVideoX-2b](https://huggingface.co/THUDM/CogVideoX-2b) | THUDM | Custom (see model card) | Video generation model |
| NVIDIA cuBLAS / cuDNN wheels | NVIDIA | NVIDIA proprietary | CUDA runtime for faster-whisper on Windows |

## Python web/server (voice sidecars)

| Project | Author / Org | License | Powers |
|---|---|---|---|
| [FastAPI](https://github.com/fastapi/fastapi) | Sebastián Ramírez | MIT | Sidecar HTTP/WS servers |
| [Uvicorn](https://github.com/encode/uvicorn) | Encode | BSD-3-Clause | ASGI server |
| [websockets](https://github.com/python-websockets/websockets) | Aymeric Augustin | BSD-3-Clause | Streaming audio transport |
| [HTTPX](https://github.com/encode/httpx) | Encode | BSD-3-Clause | SoVITS server shim HTTP client |

## Core agent runtime (Node)

| Project | Author / Org | License | Powers |
|---|---|---|---|
| [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) | Anthropic | MIT | Claude provider |
| [openai](https://github.com/openai/openai-node) | OpenAI | Apache-2.0 | OpenAI/Codex provider |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | WiseLibs | MIT | Local databases (audit, memory, tokens) |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | Alex Garcia | Apache-2.0 / MIT | Vector search for memory |
| [Playwright](https://github.com/microsoft/playwright) | Microsoft | Apache-2.0 | `browser` automation tool |
| [Baileys](https://github.com/WhiskeySockets/Baileys) | WhiskeySockets | MIT | WhatsApp bridge |
| [ImapFlow](https://github.com/postalsys/imapflow) / [Nodemailer](https://github.com/nodemailer/nodemailer) | Postal Systems / Andris Reinman | MIT | Email read/send |
| [ws](https://github.com/websockets/ws) | websockets/ws | MIT | WebSocket server |
| [undici](https://github.com/nodejs/undici) | Node.js | MIT | HTTP client |
| [zod](https://github.com/colinhacks/zod) | Colin McDonnell | MIT | Schema validation |
| [fast-glob](https://github.com/mrmlnc/fast-glob) | Denis Malinochkin | MIT | File globbing |
| [clipboardy](https://github.com/sindresorhus/clipboardy) | Sindre Sorhus | MIT | Clipboard tools |
| [jsdiff](https://github.com/kpdecker/jsdiff) (diff) | Kevin Decker | BSD-3-Clause | Edit/patch diffing |

## Documents & office tooling

| Project | Author / Org | License | Powers |
|---|---|---|---|
| [docx](https://github.com/dolanmiu/docx) | Dolan Miu | MIT | Word document creation |
| [ExcelJS](https://github.com/exceljs/exceljs) | exceljs | MIT | Spreadsheet read/write |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | Andrew Dillon | MIT | PDF create/merge |
| [pdfkit](https://github.com/foliojs/pdfkit) | FolioJS | MIT | PDF generation |
| [pdf-parse](https://www.npmjs.com/package/pdf-parse) | — | MIT | PDF text extraction |
| [PptxGenJS](https://github.com/gitbrent/PptxGenJS) | Brent Ely | MIT | Presentation generation |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | Michael Williamson | BSD-2-Clause | .docx → HTML/text |
| [node-qrcode](https://github.com/soldair/node-qrcode) / [qrcode-terminal](https://github.com/gtanner/qrcode-terminal) | Ryan Day / Gord Tanner | MIT | QR codes (WhatsApp pairing) |

## Desktop app

| Project | Author / Org | License | Powers |
|---|---|---|---|
| [Electron](https://github.com/electron/electron) | OpenJS Foundation | MIT | Desktop companion shell |
| [electron-builder](https://github.com/electron-userland/electron-builder) | electron-userland | MIT | Packaging / installers |
| [FFmpeg](https://ffmpeg.org/) | FFmpeg team | LGPL/GPL | Screen capture (`gdigrab`) — external binary |

## Installer (.NET / Avalonia)

| Project | Author / Org | License | Powers |
|---|---|---|---|
| [Avalonia UI](https://github.com/AvaloniaUI/Avalonia) | Avalonia | MIT | Cross-platform installer GUI |
| [CommunityToolkit.Mvvm](https://github.com/CommunityToolkit/dotnet) | .NET Foundation | MIT | Installer view-model binding |

---

*Missing or miscredited? Open an issue. Licenses noted here are a convenience
summary — defer to each project's own LICENSE.*
