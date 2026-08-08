"""Small dependency-inversion boundary for encrypted JSON state."""

from __future__ import annotations

from typing import Any, Protocol


class PrivateDocumentStore(Protocol):
    """Read and atomically replace a bounded host-owned document."""

    def read_private_document(self, document_name: str) -> dict[str, Any] | None: ...

    def write_private_document(
        self,
        document_name: str,
        payload: dict[str, Any],
    ) -> None: ...
