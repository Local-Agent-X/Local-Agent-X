import sys
print("python", sys.version.split()[0])
import faster_whisper
print("faster_whisper", faster_whisper.__version__)
import kokoro_onnx
print("kokoro_onnx", kokoro_onnx.__version__)
import onnxruntime as ort
print("onnxruntime", ort.__version__, "providers:", ort.get_available_providers())
try:
    import torch
    print("torch", torch.__version__, "cuda:", torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else "")
except Exception as e:
    print("torch import failed:", e)
