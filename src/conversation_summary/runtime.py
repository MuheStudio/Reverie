"""Post-commit summary jobs, with bounded lifetime and revocable writes.

All durable success callbacks acquire locks in this order: persona registry,
usage policy, KernelStore. No lock crosses an await. A provider result never
reaches storage outside that callback, including after timeout or shutdown.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from typing import Any, Callable

from src.api.budget import ApiBudgetExceeded
from src.config.usage_policy import UsageLease, UsagePolicyDenied, UsagePolicyRevoked
from src.local_mode import LocalModeBlocked
from src.persona.identity import PersonaEpochRegistry, PersonaEpochToken, StalePersonaEpoch

from .engine import CONTRACT_VERSION, TRIGGER_BUDGET, StoredSummary, build_summary_prompt, render_context
from .store import SummaryStore


logger = logging.getLogger("reverie.conversation_summary")
MAX_SUMMARY_CHARS = 1000
GENERATION_DEADLINE_SECONDS = 20.0
CLEANUP_DEADLINE_SECONDS = 0.25


class SummaryCleanupError(RuntimeError):
    """An outstanding provider still owns resources; remount must wait."""


class SummaryProviderChanged(RuntimeError):
    pass


def current_runtime_settings(fallback: Any) -> Any:
    """Read the live bridge authority, including whole-settings replacements."""
    from src.bridge.ws_bridge import bridge_state

    return bridge_state.settings if bridge_state.settings is not None else fallback


class ConversationSummaryRuntime:
    """One background generation at a time; chat only reads committed output."""

    def __init__(
        self,
        store: SummaryStore,
        adapter: Any,
        *,
        registry: PersonaEpochRegistry,
        token: PersonaEpochToken,
        enabled: Callable[[], bool],
        llm_settings_provider: Callable[[], Any] | None = None,
        clock: Callable[[], float] = time.time,
        deadline_seconds: float = GENERATION_DEADLINE_SECONDS,
    ) -> None:
        self.store = store
        self.adapter = adapter
        self.registry = registry
        self.token = token
        self.enabled = enabled
        # The bridge durably swaps authoritative settings before awaiting
        # chat cancellation and updating adapter.settings. Read the authority
        # during that await window, so an old-model result cannot slip in.
        self.llm_settings_provider = llm_settings_provider or (lambda: adapter.settings)
        self.clock = clock
        self.policy = adapter.usage_policy
        self.deadline_seconds = min(
            GENERATION_DEADLINE_SECONDS, max(0.001, float(deadline_seconds))
        )
        self._task: asyncio.Task | None = None
        self._provider_task: asyncio.Task | None = None
        self._closed = False
        self._cleanup_error: str | None = None

    def require_current(self) -> None:
        if self._closed:
            raise StalePersonaEpoch("Summary runtime is closed")
        self.registry.require_current(self.token)

    def commit_local(self, callback: Callable[[], Any]) -> Any:
        """Linearize local imports against persona switches; no AI grant needed."""
        self.require_current()
        return self.registry.commit_if_current(self.token, callback)

    def _available(self) -> bool:
        return (
            not self._closed
            and bool(self.enabled())
            and self.registry.is_current(self.token)
            and self.policy.allowed("conversation_summary")
        )

    @property
    def running(self) -> bool:
        return any(
            task is not None and not task.done()
            for task in (self._task, self._provider_task)
        )

    @property
    def cleanup_confirmed(self) -> bool:
        return not self.running

    def _provider_snapshot(self) -> dict[str, str]:
        provider, origin = self.policy.current_provider_binding()
        settings = self.llm_settings_provider()
        configuration = settings.model_dump(mode="json", exclude={"api_key"})
        encoded = json.dumps(configuration, sort_keys=True, ensure_ascii=False,
                             separators=(",", ":"))
        return {
            "algorithm_version": CONTRACT_VERSION,
            "provider": provider,
            "origin": origin,
            "model": str(settings.model),
            "settings_digest": hashlib.sha256(encoded.encode("utf-8")).hexdigest(),
        }

    def capture_context(self, conversation_id: str, query: str) -> str:
        """Read only; never start work or wait for an outstanding generation."""
        try:
            if not self._available():
                return ""
            return self.registry.commit_if_current(
                self.token,
                lambda: render_context(
                    self.store.active_summaries(conversation_id or "default"),
                    query,
                    budget=800,
                    top_k=3,
                ),
            )
        except (StalePersonaEpoch, ValueError):
            return ""
        except Exception:
            logger.warning("summary_context_unavailable")
            return ""

    def detail(self, conversation_id: str, summary_id: str) -> StoredSummary | None:
        """Read stored output under the current epoch without a model grant."""
        self.require_current()
        return self.registry.commit_if_current(
            self.token, lambda: self.store.get_summary(conversation_id, summary_id),
        )

    def status(self, conversation_id: str) -> dict[str, Any]:
        def snapshot() -> dict[str, Any]:
            stored = self.store.status(conversation_id or "default", now=self.clock())
            enabled = bool(self.enabled()) and not self._closed
            authorized = self.policy.allowed("conversation_summary")
            running = self.running
            previous = str(stored.get("status") or "")
            if not enabled:
                state = "disabled"
            elif not authorized:
                state = "unauthorized"
            elif self._cleanup_error and running:
                state = "failed"
            elif running:
                state = "running"
            elif previous in {"failed", "outcome_unknown"}:
                # Failed/uncertain work is not a retryable cooldown. Preserve
                # its failure state and errorCode until a new attempt exists.
                state = previous
            elif float(stored.get("cooldownRemainingSeconds") or 0) > 0:
                state = "cooldown"
            elif int(stored.get("activeCount") or 0) > 0:
                state = "ready"
            elif int(stored.get("pendingBudget") or 0) <= TRIGGER_BUDGET:
                state = "below_threshold"
            else:
                state = "no_source" if stored.get("sourceDiagnostics") else "idle"
            return {
                **stored,
                "status": state,
                "enabled": enabled,
                "consent_effective": authorized,
                "authorized": authorized,
                "running": running,
                "cleanup_confirmed": self.cleanup_confirmed,
                "cleanup_error": self._cleanup_error,
            }

        return self.registry.commit_if_current(
            self.token, snapshot,
        )

    def on_chat_committed(self, conversation_id: str, request_id: str) -> None:
        """Called only after the canonical ledger transaction has committed."""
        if not request_id or self.running or not self._available():
            return
        self._cleanup_error = None
        self._task = asyncio.create_task(
            self._generate(conversation_id or "default"),
            name="conversation-summary",
        )
        self._task.add_done_callback(self._consume_task)

    @staticmethod
    def _consume_task(task: asyncio.Task) -> None:
        if not task.cancelled():
            task.exception()

    def _commit(self, lease: UsageLease, callback: Callable[[], Any]) -> Any:
        def authorized() -> Any:
            if self._closed or not self.enabled():
                raise UsagePolicyRevoked("conversation_summary")
            return self.policy.commit(lease, callback)

        return self.registry.commit_if_current(self.token, authorized)

    def _record_failure(self, attempt: Any, code: str) -> None:
        if attempt is None:
            return
        try:
            # Failure metadata contains no generated output. Revocation must
            # not erase the existing, durable attempt or make it retryable.
            self.registry.commit_if_current(
                self.token,
                lambda: self.store.fail_attempt(attempt, code, now=self.clock()),
            )
        except StalePersonaEpoch:
            # The existing pending attempt remains a non-retryable tombstone.
            pass
        except Exception:
            logger.warning("summary_attempt_outcome_unavailable")

    async def _generate(self, conversation_id: str) -> None:
        lease = None
        attempt = None
        provider_task = None
        try:
            if not self._available():
                return
            lease = self.policy.begin("conversation_summary")
            selection = self.registry.commit_if_current(
                self.token, lambda: self.store.select_source(conversation_id)
            )
            if selection.source is None:
                return
            provider_snapshot = self._provider_snapshot()
            attempt = self._commit(
                lease,
                lambda: self.store.claim_attempt(
                    selection.source, now=self.clock(), provenance=provider_snapshot
                ),
            )
            if attempt is None:
                return
            provider_task = asyncio.create_task(
                self.adapter.chat(
                    build_summary_prompt(selection.source),
                    purpose="memory_summary",
                    background=True,
                    temperature=0,
                    max_tokens=600,
                    model=provider_snapshot["model"],
                ),
                name="conversation-summary-provider",
            )
            self._provider_task = provider_task
            provider_task.add_done_callback(self._consume_task)
            done, _pending = await asyncio.wait(
                {provider_task}, timeout=self.deadline_seconds
            )
            if not done:
                provider_task.cancel()
                self._record_failure(attempt, "timeout_unknown")
                return
            response = provider_task.result()
            text = getattr(response, "content", None)
            if not isinstance(text, str) or not text.strip():
                self._record_failure(attempt, "empty_output")
                return
            text = text.strip()
            if len(text) > MAX_SUMMARY_CHARS:
                self._record_failure(attempt, "oversized_output")
                return
            def save_result() -> Any:
                if self._provider_snapshot() != provider_snapshot:
                    raise SummaryProviderChanged()
                return self.store.complete_attempt(attempt, text, now=self.clock())

            self._commit(lease, save_result)
        except (UsagePolicyDenied, UsagePolicyRevoked):
            self._record_failure(attempt, "consent_revoked")
        except StalePersonaEpoch:
            self._record_failure(attempt, "persona_changed")
        except SummaryProviderChanged:
            self._record_failure(attempt, "provider_binding_changed")
        except ApiBudgetExceeded:
            self._record_failure(attempt, "budget_denied")
        except LocalModeBlocked:
            self._record_failure(attempt, "local_mode_blocked")
        except asyncio.CancelledError:
            self._record_failure(attempt, "cancelled_unknown")
            raise
        except Exception:
            self._record_failure(attempt, "provider_or_storage_failure")
            logger.warning("summary_provider_or_storage_failure")
        finally:
            try:
                if provider_task is not None and not provider_task.done():
                    provider_task.cancel()
                    try:
                        await asyncio.wait({provider_task}, timeout=CLEANUP_DEADLINE_SECONDS)
                    except asyncio.CancelledError:
                        pass
                    if not provider_task.done():
                        self._cleanup_error = "provider_cleanup_unconfirmed"
                        logger.warning("summary_provider_cleanup_unconfirmed")
            finally:
                if lease is not None:
                    self.policy.finish(lease)

    async def aclose(self) -> None:
        self._closed = True
        await self.cancel_pending()

    async def cancel_pending(self) -> None:
        """Cancel work on a live switch without preventing a later re-enable."""
        tasks = {
            task for task in (self._task, self._provider_task)
            if task is not None and not task.done()
        }
        for task in tasks:
            task.cancel()
        if tasks:
            _done, pending = await asyncio.wait(
                tasks, timeout=CLEANUP_DEADLINE_SECONDS * 2
            )
            if pending:
                self._cleanup_error = "provider_cleanup_unconfirmed"
                raise SummaryCleanupError("summary_provider_cleanup_unconfirmed")
