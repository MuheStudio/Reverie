"""Local embedding model loader and inference.

Uses sentence-transformers to run BAAI/bge-small-en-v1.5 locally.
If the model is not already cached, falls back to deterministic hash
embeddings so Reverie can still run offline.
"""

from __future__ import annotations

import hashlib
import logging
import threading
from dataclasses import dataclass

import numpy as np

logger = logging.getLogger("reverie.memory.embedding")

VECTOR_DIM = 384
_embedding_models: dict[str, object] = {}
_embedding_load_failures: set[str] = set()
_embedding_lock = threading.RLock()


@dataclass(frozen=True)
class EmbeddingRuntime:
    """Exact identity of the vector space active in this process."""

    requested_model: str
    model_version: str
    dimensions: int
    backend: str


def get_embedding_model(model_name: str = "BAAI/bge-small-en-v1.5"):
    """Load one cached model without downloading it implicitly."""
    requested = (model_name or "BAAI/bge-small-en-v1.5").strip()
    with _embedding_lock:
        if requested in _embedding_models:
            return _embedding_models[requested]
        if requested in _embedding_load_failures:
            return None
        try:
            from sentence_transformers import SentenceTransformer

            logger.info("Loading cached local embedding model: %s", requested)
            model = SentenceTransformer(requested, local_files_only=True)
            _embedding_models[requested] = model
            return model
        except Exception as exc:
            _embedding_load_failures.add(requested)
            logger.warning(
                "Embedding model %s unavailable; using deterministic fallback vectors (%s)",
                requested, exc,
            )
            return None


def embedding_runtime_info(model_name: str = "BAAI/bge-small-en-v1.5") -> EmbeddingRuntime:
    """Return a stable version tag that detects fallback-to-model drift."""
    requested = (model_name or "BAAI/bge-small-en-v1.5").strip()
    model = get_embedding_model(requested)
    if model is None:
        return EmbeddingRuntime(
            requested_model=requested,
            model_version=f"reverie-hash-v1:{VECTOR_DIM}",
            dimensions=VECTOR_DIM,
            backend="deterministic_hash",
        )
    getter = getattr(model, "get_embedding_dimension", None)
    if not callable(getter):
        getter = getattr(model, "get_sentence_embedding_dimension")
    dimensions = int(getter())
    try:
        import sentence_transformers
        library_version = str(getattr(sentence_transformers, "__version__", "unknown"))
    except Exception:
        library_version = "unknown"
    return EmbeddingRuntime(
        requested_model=requested,
        model_version=f"sentence-transformers:{requested}:{library_version}:{dimensions}",
        dimensions=dimensions,
        backend="sentence_transformers",
    )


def embed_texts(texts: list[str], model_name: str = "BAAI/bge-small-en-v1.5") -> np.ndarray:
    """Convert a list of strings to embedding vectors.

    The shape is determined by the active runtime and may change across models.
    """
    if not texts:
        dimensions = embedding_runtime_info(model_name).dimensions
        return np.empty((0, dimensions), dtype=np.float32)

    model = get_embedding_model(model_name)
    if model is None:
        return np.vstack([_hash_embedding(text) for text in texts]).astype(np.float32)

    embeddings = model.encode(texts, convert_to_numpy=True, show_progress_bar=False)
    return np.asarray(embeddings, dtype=np.float32)


def embed_query(query: str, model_name: str = "BAAI/bge-small-en-v1.5") -> np.ndarray:
    """Embed a search query with the appropriate BGE prefix."""
    model = get_embedding_model(model_name)
    if model is None:
        return _hash_embedding(query)
    prepared = query
    if "bge" in model_name.lower() and not query.startswith("Represent this sentence"):
        prepared = f"Represent this sentence for searching relevant passages: {query}"
    embedding = model.encode(
        [prepared],
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    return embedding[0].astype(np.float32)


def _hash_embedding(text: str) -> np.ndarray:
    """Create a deterministic normalized fallback vector for offline mode."""
    seed = hashlib.sha256(text.encode("utf-8", errors="replace")).digest()
    values: list[float] = []
    counter = 0
    while len(values) < VECTOR_DIM:
        block = hashlib.sha256(seed + counter.to_bytes(4, "big")).digest()
        values.extend((byte / 127.5) - 1.0 for byte in block)
        counter += 1
    arr = np.array(values[:VECTOR_DIM], dtype=np.float32)
    norm = np.linalg.norm(arr)
    if norm > 0:
        arr = arr / norm
    return arr.astype(np.float32)
