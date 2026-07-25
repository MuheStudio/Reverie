"""Reverie's irreducible persona kernel.

Feature modules may disappear or fail.  The sealed identity, command ledger,
conversation history, consent policy, and domain-event journal must remain.
"""

from .command_bus import CommandBus
from .contracts import (
    CommandEnvelopeV3,
    CommandResultV3,
    DomainError,
    DomainEventV3,
    PersonaScopeV3,
)
from .modules import CapabilityManifest, ModuleRegistry, ModuleState
from .storage import KernelStore

__all__ = [
    "CapabilityManifest",
    "CommandBus",
    "CommandEnvelopeV3",
    "CommandResultV3",
    "DomainError",
    "DomainEventV3",
    "KernelStore",
    "ModuleRegistry",
    "ModuleState",
    "PersonaScopeV3",
]
