import os
import threading
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import CrossEncoder, SentenceTransformer
import torch

EMBEDDING_MODEL = os.getenv("R3_EMBEDDING_MODEL", "tencent/R3-embedding-0.6b")
RERANK_MODEL = os.getenv("R3_RERANK_MODEL", "tencent/R3-rerank-0.6b")
RERANK_INSTRUCTION = (
    "Given a vague description of a LinkedIn post, retrieve posts that are "
    "relevant to what the user remembers."
)

app = FastAPI(title="LinkedIn R3 Search")
embedding_lock = threading.Lock()
reranker_lock = threading.Lock()
reranker: CrossEncoder | None = None

if not torch.cuda.is_available():
    raise RuntimeError("CUDA is required for the R3 search service; CPU fallback is disabled")

embedding_model = SentenceTransformer(
    EMBEDDING_MODEL,
    device="cuda",
    model_kwargs={"torch_dtype": torch.float16},
)


class EmbeddingRequest(BaseModel):
    model: str | None = None
    input: str | list[str]


class RerankRequest(BaseModel):
    model: str | None = None
    query: str
    documents: list[str]
    top_n: int | None = None


def get_reranker() -> CrossEncoder:
    global reranker
    if reranker is None:
        with reranker_lock:
            if reranker is None:
                reranker = CrossEncoder(
                    RERANK_MODEL,
                    device="cuda",
                    model_kwargs={"torch_dtype": torch.float16},
                    prompts={"search": RERANK_INSTRUCTION},
                    default_prompt_name="search",
                    max_length=4096,
                )
    return reranker


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "embedding_model": EMBEDDING_MODEL,
        "reranker_model": RERANK_MODEL,
        "reranker_loaded": reranker is not None,
    }


@app.post("/v1/embeddings")
def embeddings(request: EmbeddingRequest) -> dict[str, Any]:
    inputs = [request.input] if isinstance(request.input, str) else request.input
    if not inputs:
        raise HTTPException(status_code=400, detail="input must not be empty")
    with embedding_lock:
        vectors = embedding_model.encode(
            inputs,
            batch_size=min(16, len(inputs)),
            show_progress_bar=False,
            normalize_embeddings=True,
            convert_to_numpy=True,
        )
    return {
        "object": "list",
        "model": EMBEDDING_MODEL,
        "data": [
            {
                "object": "embedding",
                "index": index,
                "embedding": vector.tolist(),
            }
            for index, vector in enumerate(vectors)
        ],
    }


@app.post("/rerank")
def rerank(request: RerankRequest) -> dict[str, Any]:
    if not request.documents:
        return {"results": []}
    model = get_reranker()
    top_n = min(request.top_n or len(request.documents), len(request.documents))
    with reranker_lock:
        ranked = model.rank(
            request.query,
            request.documents,
            top_k=top_n,
            prompt=RERANK_INSTRUCTION,
            batch_size=4,
            show_progress_bar=False,
        )
    return {
        "results": [
            {
                "index": int(item["corpus_id"]),
                "relevance_score": float(item["score"]),
            }
            for item in ranked
        ]
    }
