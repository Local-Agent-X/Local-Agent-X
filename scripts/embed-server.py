"""
Embedding HTTP server — exposes sentence-transformers models over HTTP.

Used for running benchmarks with models that aren't available in Ollama
(like gte-large, bge-large, e5-large). Starts on port 11435 by default
to avoid conflicts with Ollama (11434).

Usage:
    python scripts/embed-server.py --model thenlper/gte-large --port 11435
"""

from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
import argparse
import uvicorn

app = FastAPI()
model = None
model_name = ""

class EmbedRequest(BaseModel):
    input: list[str] | str
    model: str | None = None

@app.get("/api/tags")
def list_tags():
    return {"models": [{"name": model_name, "model": model_name}]}

@app.post("/api/embed")
def embed(req: EmbedRequest):
    texts = req.input if isinstance(req.input, list) else [req.input]
    if not texts:
        return {"embeddings": []}
    embeddings = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
    return {"embeddings": [e.tolist() for e in embeddings]}

@app.get("/")
def root():
    return {"status": "ok", "model": model_name, "dimensions": model.get_sentence_embedding_dimension()}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="thenlper/gte-large", help="HuggingFace model name")
    parser.add_argument("--port", type=int, default=11435)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    print(f"Loading {args.model}...")
    model = SentenceTransformer(args.model)
    model_name = args.model
    dims = model.get_sentence_embedding_dimension()
    print(f"Loaded. Dimensions: {dims}")
    print(f"Starting server on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
