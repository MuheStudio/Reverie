"""Reverie's irreducible persona kernel.

Feature modules may disappear or fail.  The sealed identity, command ledger,
conversation history, consent policy, and domain-event journal must remain.
"""

from .command_bus import CommandBus
from .contracts import (
    CommandEnvelopeV4,
    CommandResultV4,
    DomainError,
    DomainEventV4,
    PersonaScopeV4,
)
from .modules import CapabilityManifest, ModuleRegistry, ModuleState
from .storage import KernelStore

__all__ = [
    "CapabilityManifest",
    "CommandBus",
    "CommandEnvelopeV4",
    "CommandResultV4",
    "DomainError",
    "DomainEventV4",
    "KernelStore",
    "ModuleRegistry",
    "ModuleState",
    "PersonaScopeV4",
]
