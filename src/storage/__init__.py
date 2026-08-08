"""Durable storage security boundary for the packaged desktop runtime."""

from .encrypted_sqlite import (
    EncryptedStorageError,
    connect_database,
    initialize_storage_from_environment,
)
from .private_documents import PrivateDocumentStore

__all__ = [
    "EncryptedStorageError",
    "connect_database",
    "initialize_storage_from_environment",
    "PrivateDocumentStore",
]
