"""Budget settings at the real encrypted ledger and shared adapter boundary.

Every durable path is inside pytest's isolated tmp_path. Only the provider
transport is replaced; consent, the adapter, SQLCipher and summary storage run
their production code. These tests do not contact a model or read user data.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from src.api import budget as budget_module
from src.api.adapter import ChatResponse, LLMAdapter
from src.api.budget import ApiBudgetExceeded, ApiBudgetTracker
from src.bridge import ws_bridge
from src.config import settings as settings_module
from src.config.settings import FeatureSettings, LLMSettings, _Settings
from src.config.usage_policy import UsagePolicy
from src.conversation_summary.runtime import ConversationSummaryRuntime, current_runtime_settings
from src.conversation_summary.store import SummaryStore
from src.kernel.contracts import CommandEnvelopeV4, PersonaScopeV4
from src.kernel.storage import KernelStore
from src.local_mode import LocalModeGate
from src.persona.identity import PersonaEpochRegistry
from src.persona.persona_card import default_persona
from src.storage.encrypted_sqlite import (
    SQLITE_HEADER,
    clear_storage_key_for_testing,
    install_storage_key,
)


@pytest.fixture
def budget_env(tmp_path, monkeypatch):
    clear_storage_key_for_testing()
    install_storage_key(b"B" * 32, require_encryption=True)
    try:
        config = tmp_path / "config.json"
        monkeypatch.setattr(settings_module, "CONFIG_FILE", config)
        settings = _Settings(
            llm=LLMSettings(
                provider="ollama", model="isolated-budget-model",
                base_url="http://127.0.0.1:11434/v1", max_tokens=98,
            ),
            features=FeatureSettings(
                hypa_compression_enabled=True,
                api_budget_tracking_enabled=True,
                api_background_budget_enforced=True,
                api_background_daily_request_budget=1,
                api_background_daily_token_budget=10_000,
            ),
        )
        for name in (
            "emotion", "session", "timeline", "keepsakes", "proactive",
            "web_surfing", "backup_manager",
        ):
            monkeypatch.setattr(ws_bridge.bridge_state, name, None)
        monkeypatch.setattr(ws_bridge.bridge_state, "recovery_state", "clean")
        monkeypatch.setattr(ws_bridge.bridge_state, "settings", settings)
        tracker = ApiBudgetTracker(
            settings.features,
            path=tmp_path / "budget.sqlite3",
            settings_provider=lambda: current_runtime_settings(settings).features,
        )
        monkeypatch.setattr(ws_bridge.bridge_state, "api_budget", tracker)
        policy = UsagePolicy(
            lambda: current_runtime_settings(settings),
            save_callback=settings_module.write_settings_file,
        )
        policy.grant("conversation_summary")
        adapter = LLMAdapter(
            settings.llm, budget_tracker=tracker, usage_policy=policy,
            local_mode_gate=LocalModeGate(desktop=False), resolve_settings=False,
        )
        monkeypatch.setattr(ws_bridge.bridge_state, "adapter", adapter)
        provider = SimpleNamespace(calls=[], usage={"prompt_tokens": 3, "completion_tokens": 2})

        async def reply(messages, temperature=None, max_tokens=None, model=None, **_kwargs):
            provider.calls.append({"messages": messages, "model": model, "max_tokens": max_tokens})
            return ChatResponse(content="隔离提供方结果。", model=str(model), usage=dict(provider.usage))

        monkeypatch.setattr(adapter, "_openai_chat", reply)
        _assert_encrypted(tracker)
        try:
            yield SimpleNamespace(
                settings=settings, tracker=tracker, adapter=adapter, policy=policy,
                provider=provider, config=config, root=tmp_path,
            )
        finally:
            asyncio.run(adapter.close())
    finally:
        clear_storage_key_for_testing()


def _assert_encrypted(tracker):
    assert tracker.path.is_file()
    assert not tracker.path.read_bytes().startswith(SQLITE_HEADER)
    with tracker._connect() as connection:
        assert connection.execute("PRAGMA cipher_version").fetchone()[0]


def _call(env, *, background=True, max_tokens=98):
    return asyncio.run(env.adapter.chat(
        [{"role": "user", "content": "abcd"}],
        purpose="memory_summary" if background else "chat_reply",
        background=background, max_tokens=max_tokens,
    ))


def _save(**fields):
    return asyncio.run(ws_bridge.handle_settings_update({"section": "personality", **fields}, object()))


def _read():
    return asyncio.run(ws_bridge.handle_settings_get({}, object()))


def _runtime(*, tracking=True, enforced=True, requests=1, tokens=10_000):
    return {
        "tracking_enabled": tracking, "background_enforced": enforced,
        "request_budget": requests, "token_budget": tokens,
    }


def test_request_limit_blocks_only_background_and_denied_calls_leave_no_ledger_row(budget_env):
    env = budget_env
    assert _call(env).content == "隔离提供方结果。"
    with pytest.raises(ApiBudgetExceeded, match="请求预算"):
        _call(env)
    assert _call(env, background=False).content == "隔离提供方结果。"

    snapshot = env.tracker.snapshot()
    assert len(env.provider.calls) == 2
    assert snapshot["requests"] == snapshot["succeeded"] == 2
    assert snapshot["failed"] == 0 and snapshot["background"]["requests"] == 1
    with env.tracker._connect() as connection:
        rows = connection.execute("SELECT purpose,status FROM api_usage_calls ORDER BY purpose").fetchall()
    assert [tuple(row) for row in rows] == [("chat_reply", "success"), ("memory_summary", "success")]


def test_reported_tokens_replace_the_reservation_and_allow_the_exact_token_limit(budget_env):
    env = budget_env
    env.settings.features.api_background_daily_request_budget = 10
    env.settings.features.api_background_daily_token_budget = 1000
    env.provider.usage = {"prompt_tokens": 700, "completion_tokens": 100}
    _call(env, max_tokens=98)  # Reserve 100; the provider actually reports 800.
    env.provider.usage = {"prompt_tokens": 150, "completion_tokens": 50}
    _call(env, max_tokens=198)  # Exactly 800 + 200 is allowed.
    with pytest.raises(ApiBudgetExceeded, match="Token"):
        _call(env, max_tokens=1)

    snapshot = env.tracker.snapshot()
    assert len(env.provider.calls) == 2 and snapshot["background"]["requests"] == 2
    assert snapshot["background"]["tokens"] == 1000
    assert snapshot["prompt_tokens"] == 850 and snapshot["completion_tokens"] == 150
    assert snapshot["estimated_unreported_tokens"] == 0


def test_unreported_tokens_keep_the_estimate_at_the_exact_token_limit(budget_env):
    env = budget_env
    env.settings.features.api_background_daily_request_budget = 10
    env.settings.features.api_background_daily_token_budget = 1000
    env.provider.usage = {}
    _call(env, max_tokens=498)
    _call(env, max_tokens=498)
    with pytest.raises(ApiBudgetExceeded, match="Token"):
        _call(env, max_tokens=1)

    snapshot = env.tracker.snapshot()
    assert len(env.provider.calls) == 2 and snapshot["requests"] == 2
    assert snapshot["background"]["tokens"] == snapshot["estimated_unreported_tokens"] == 1000
    assert snapshot["prompt_tokens"] == snapshot["completion_tokens"] == 0
    assert _call(env, background=False, max_tokens=2000).content == "隔离提供方结果。"
    after_chat = env.tracker.snapshot()
    assert len(env.provider.calls) == 3 and after_chat["requests"] == 3
    assert after_chat["background"]["requests"] == 2 and after_chat["background"]["tokens"] == 1000


def test_measured_and_estimated_calls_share_the_same_token_limit(budget_env):
    env = budget_env
    env.settings.features.api_background_daily_request_budget = 10
    env.settings.features.api_background_daily_token_budget = 1000
    env.provider.usage = {"prompt_tokens": 600, "completion_tokens": 0}
    _call(env)
    env.provider.usage = {}
    _call(env, max_tokens=398)
    with pytest.raises(ApiBudgetExceeded, match="Token"):
        _call(env, max_tokens=1)

    snapshot = env.tracker.snapshot()
    assert snapshot["background"]["tokens"] == 1000 and snapshot["requests"] == 2
    assert snapshot["prompt_tokens"] == 600 and snapshot["estimated_unreported_tokens"] == 400


def test_personality_save_changes_the_next_request_decision_without_reconstruction(budget_env):
    env = budget_env
    original_features = env.settings.features
    _call(env)
    with pytest.raises(ApiBudgetExceeded):
        _call(env)

    result = _save(api_background_daily_request_budget=2)
    assert result["ok"] is True and result["budgetRuntime"] == _runtime(requests=2)
    assert env.settings.features is original_features and env.adapter.budget_tracker is env.tracker
    assert json.loads(env.config.read_text())["features"]["api_background_daily_request_budget"] == 2
    _call(env)
    with pytest.raises(ApiBudgetExceeded):
        _call(env)
    assert len(env.provider.calls) == 2 and env.tracker.snapshot()["background"]["requests"] == 2


def test_personality_save_raises_and_lowers_the_next_token_decision(budget_env):
    env = budget_env
    env.settings.features.api_background_daily_request_budget = 10
    env.settings.features.api_background_daily_token_budget = 1000
    env.provider.usage = {"prompt_tokens": 600, "completion_tokens": 0}
    _call(env, max_tokens=598)
    with pytest.raises(ApiBudgetExceeded, match="Token"):
        _call(env, max_tokens=498)

    raised = _save(api_background_daily_token_budget=2000)
    assert raised["ok"] is True and raised["budgetRuntime"] == _runtime(requests=10, tokens=2000)
    env.provider.usage = {"prompt_tokens": 500, "completion_tokens": 0}
    _call(env, max_tokens=498)
    lowered = _save(api_background_daily_token_budget=1000)
    assert lowered["ok"] is True and lowered["budgetRuntime"] == _runtime(requests=10, tokens=1000)
    with pytest.raises(ApiBudgetExceeded, match="Token"):
        _call(env, max_tokens=1)
    assert len(env.provider.calls) == 2 and env.tracker.snapshot()["background"]["tokens"] == 1100


def test_whole_settings_replacement_reaches_the_existing_tracker_and_adapter(budget_env, monkeypatch):
    env = budget_env
    _call(env)
    replacement = env.settings.model_copy(deep=True)
    replacement.features.api_background_daily_request_budget = 2
    replacement.features.api_background_daily_token_budget = 1000
    monkeypatch.setattr(ws_bridge.bridge_state, "settings", replacement)
    assert env.tracker.settings is env.settings.features
    assert env.tracker.settings is not replacement.features
    env.provider.usage = {"prompt_tokens": 995, "completion_tokens": 0}
    _call(env, max_tokens=993)
    with pytest.raises(ApiBudgetExceeded):
        _call(env, max_tokens=1)

    assert _read()["budgetRuntime"] == _runtime(requests=2, tokens=1000)
    snapshot = env.tracker.snapshot()
    assert snapshot["background"] == {"requests": 2, "request_budget": 2, "tokens": 1000, "token_budget": 1000}
    assert len(env.provider.calls) == 2


def test_disabling_the_background_limit_keeps_recording_calls(budget_env):
    env = budget_env
    env.settings.features.api_background_daily_token_budget = 1000
    env.provider.usage = {}
    _call(env, max_tokens=998)
    result = _save(api_background_budget_enforced=False)
    assert result["ok"] is True and result["budgetRuntime"] == _runtime(enforced=False, tokens=1000)
    _call(env, max_tokens=998)
    snapshot = env.tracker.snapshot()
    assert len(env.provider.calls) == snapshot["background"]["requests"] == 2
    assert snapshot["succeeded"] == 2 and snapshot["background_enforced"] is False
    assert snapshot["background"]["tokens"] == 2000


def test_disabled_tracking_bypasses_the_limit_and_does_not_add_rows(budget_env, monkeypatch):
    env = budget_env
    env.settings.features.api_background_daily_token_budget = 1000
    env.provider.usage = {}
    _call(env, max_tokens=998)
    replacement = env.settings.model_copy(deep=True)
    replacement.features.api_budget_tracking_enabled = False
    monkeypatch.setattr(ws_bridge.bridge_state, "settings", replacement)
    _call(env, max_tokens=2000)
    _call(env, max_tokens=2000)
    assert _read()["budgetRuntime"] == _runtime(tracking=False, tokens=1000)
    snapshot = env.tracker.snapshot()
    assert snapshot["tracking_enabled"] is False and snapshot["background_enforced"] is True
    assert len(env.provider.calls) == 3 and snapshot["requests"] == snapshot["background"]["requests"] == 1
    assert snapshot["background"]["tokens"] == 1000


def test_a_real_ledger_insert_error_does_not_block_the_provider(budget_env, caplog):
    env = budget_env
    with env.tracker._connect() as connection:
        connection.execute("""CREATE TRIGGER reject_budget_insert BEFORE INSERT ON api_usage_calls
            BEGIN SELECT RAISE(ABORT,'isolated budget insert failure'); END""")
    assert _call(env).content == "隔离提供方结果。"
    assert len(env.provider.calls) == 1 and env.tracker.snapshot()["requests"] == 0
    assert "API budget ledger unavailable; provider call continues" in caplog.text
    _assert_encrypted(env.tracker)


def test_a_real_ledger_completion_error_returns_the_response_and_keeps_the_estimate(budget_env, caplog):
    env = budget_env
    with env.tracker._connect() as connection:
        connection.execute("""CREATE TRIGGER reject_budget_completion BEFORE UPDATE OF status ON api_usage_calls
            WHEN NEW.status='success' BEGIN SELECT RAISE(ABORT,'isolated budget completion failure'); END""")
    assert _call(env).content == "隔离提供方结果。"
    snapshot = env.tracker.snapshot()
    assert len(env.provider.calls) == 1 and snapshot["requests"] == 1
    assert snapshot["succeeded"] == snapshot["failed"] == 0
    assert snapshot["background"]["tokens"] == snapshot["estimated_unreported_tokens"] == 100
    assert "API usage could not be written to budget ledger" in caplog.text


def test_injected_local_midnight_starts_a_new_daily_budget(budget_env, monkeypatch):
    env = budget_env
    clock = SimpleNamespace(current=datetime(2026, 10, 21, 23, 59))

    class BudgetDateTime:
        @staticmethod
        def now():
            return clock.current

    monkeypatch.setattr(budget_module, "datetime", BudgetDateTime)
    _call(env)
    with pytest.raises(ApiBudgetExceeded):
        _call(env)
    first = env.tracker.snapshot()
    clock.current += timedelta(minutes=1)
    _call(env)
    second = env.tracker.snapshot()
    assert (first["local_day"], second["local_day"]) == ("2026-10-21", "2026-10-22")
    assert first["background"]["requests"] == second["background"]["requests"] == 1
    assert len(env.provider.calls) == 2
    with env.tracker._connect() as connection:
        rows = connection.execute("SELECT local_day,COUNT(*) FROM api_usage_calls GROUP BY local_day ORDER BY local_day").fetchall()
    assert [tuple(row) for row in rows] == [("2026-10-21", 1), ("2026-10-22", 1)]


def test_reconstructed_tracker_preserves_the_same_days_encrypted_count(budget_env, monkeypatch):
    env = budget_env
    _call(env)
    restarted = ApiBudgetTracker(
        env.settings.features, path=env.tracker.path,
        settings_provider=lambda: current_runtime_settings(env.settings).features,
    )
    env.adapter.budget_tracker = restarted
    monkeypatch.setattr(ws_bridge.bridge_state, "api_budget", restarted)
    with pytest.raises(ApiBudgetExceeded, match="请求预算"):
        _call(env)
    assert restarted is not env.tracker and len(env.provider.calls) == 1
    assert restarted.snapshot()["background"]["requests"] == 1
    _assert_encrypted(restarted)


def test_an_independent_process_reads_the_same_encrypted_daily_ledger(budget_env):
    env = budget_env
    _call(env)
    _call(env, background=False)
    before = env.tracker.snapshot()
    child_data = env.root / "independent-process-data"
    child_tmp = env.root / "independent-process-tmp"
    child_data.mkdir(mode=0o700)
    child_tmp.mkdir(mode=0o700)
    child_env = {
        key: os.environ[key]
        for key in ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "SYSTEMROOT")
        if key in os.environ
    }
    child_env.update({
        "REVERIE_DATA_DIR": str(child_data),
        "TMPDIR": str(child_tmp),
        "PYTHON_DOTENV_DISABLED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    # -I excludes cwd/PYTHONPATH. Only this explicit first-party source path is
    # added, and the synthetic key travels through the child's private stdin.
    program = """
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, sys.argv[1])
from src.api.budget import ApiBudgetTracker
from src.config.settings import FeatureSettings
from src.storage.encrypted_sqlite import install_storage_key, clear_storage_key_for_testing

key = sys.stdin.buffer.read(33)
if len(key) != 32:
    raise RuntimeError("isolated reader requires a fixed-length private input")
install_storage_key(key, require_encryption=True)
del key
try:
    features = FeatureSettings(
        api_budget_tracking_enabled=True,
        api_background_budget_enforced=True,
        api_background_daily_request_budget=1,
        api_background_daily_token_budget=10000,
    )
    tracker = ApiBudgetTracker(features, path=Path(sys.argv[2]))
    with tracker._connect() as connection:
        if not connection.execute("PRAGMA cipher_version").fetchone()[0]:
            raise RuntimeError("isolated reader requires encrypted storage")
    snapshot = tracker.snapshot()
    print(json.dumps({
        "pid": os.getpid(),
        "local_day": snapshot["local_day"],
        "requests": snapshot["requests"],
        "succeeded": snapshot["succeeded"],
        "failed": snapshot["failed"],
        "background": snapshot["background"],
        "runtime": tracker.runtime_settings(),
    }, sort_keys=True))
finally:
    clear_storage_key_for_testing()
"""
    child = subprocess.run(
        [sys.executable, "-I", "-B", "-c", program,
         str(Path(__file__).resolve().parents[1]), str(env.tracker.path)],
        input=b"B" * 32, capture_output=True, timeout=20, check=False,
        cwd=child_data, env=child_env,
    )
    assert child.returncode == 0, "isolated encrypted ledger reader failed"
    observed = json.loads(child.stdout)
    assert set(observed) == {"pid", "local_day", "requests", "succeeded", "failed", "background", "runtime"}
    assert type(observed["pid"]) is int and observed["pid"] > 0 and observed["pid"] != os.getpid()
    assert type(observed["requests"]) is int and observed["requests"] == before["requests"] == 2
    assert type(observed["succeeded"]) is int and observed["succeeded"] == before["succeeded"] == 2
    assert type(observed["failed"]) is int and observed["failed"] == before["failed"] == 0
    assert observed["local_day"] == before["local_day"]
    assert observed["background"] == before["background"] == {
        "requests": 1, "request_budget": 1, "tokens": 5, "token_budget": 10_000,
    }
    assert all(type(value) is int for value in observed["background"].values())
    assert observed["runtime"] == _runtime()
    assert env.tracker.snapshot()["background"] == before["background"]
    assert len(env.provider.calls) == 2
    _assert_encrypted(env.tracker)


def test_runtime_settings_resolve_the_provider_once_and_never_open_a_database(budget_env):
    env = budget_env
    active = FeatureSettings(
        api_budget_tracking_enabled=False, api_background_budget_enforced=False,
        api_background_daily_request_budget=120, api_background_daily_token_budget=100_000,
    )
    reads = []

    def current():
        reads.append(active)
        return active

    env.tracker._settings_provider = current
    unopened = env.root / "metadata-must-not-create-a-database.sqlite3"
    env.tracker.path = unopened
    assert env.tracker.runtime_settings() == _runtime(tracking=False, enforced=False, requests=120, tokens=100_000)
    assert reads == [active] and not unopened.exists()


def test_runtime_settings_without_a_provider_follow_the_constructor_features(budget_env):
    env = budget_env
    tracker = ApiBudgetTracker(env.settings.features, path=env.root / "fallback.sqlite3")
    env.settings.features.api_background_daily_request_budget = 240
    assert tracker.runtime_settings() == _runtime(requests=240)
    assert tracker.snapshot()["background"]["request_budget"] == 240
    _assert_encrypted(tracker)


def test_settings_read_reports_the_ledgers_provider_even_when_saved_features_differ(budget_env):
    env = budget_env
    active = env.settings.features.model_copy(deep=True)
    active.api_background_daily_request_budget = 120
    active.api_background_daily_token_budget = 100_000
    env.tracker._settings_provider = lambda: active
    read = _read()
    assert read["ok"] is True and read["features"]["api_background_daily_request_budget"] == 1
    assert read["budgetRuntime"] == _runtime(requests=120, tokens=100_000)
    snapshot = env.tracker.snapshot()
    assert snapshot["background"]["request_budget"] == read["budgetRuntime"]["request_budget"]
    assert snapshot["background"]["token_budget"] == read["budgetRuntime"]["token_budget"]


def test_personality_save_reports_the_ledgers_settings_instead_of_echoing_saved_values(budget_env):
    env = budget_env
    active = env.settings.features.model_copy(deep=True)
    env.tracker._settings_provider = lambda: active
    _call(env)
    saved = _save(api_background_daily_request_budget=120, api_background_daily_token_budget=100_000)
    assert saved["ok"] is True and saved["budgetRuntime"] == _runtime()
    assert saved["features"]["api_background_daily_request_budget"] == 120
    assert saved["features"]["api_background_daily_token_budget"] == 100_000
    assert json.loads(env.config.read_text())["features"]["api_background_daily_request_budget"] == 120
    with pytest.raises(ApiBudgetExceeded):
        _call(env)
    assert len(env.provider.calls) == 1 and env.tracker.snapshot()["background"]["request_budget"] == 1


def test_missing_ledger_returns_null_in_settings_read_and_personality_save(budget_env, monkeypatch):
    env = budget_env
    monkeypatch.setattr(ws_bridge.bridge_state, "api_budget", None)
    assert _read()["budgetRuntime"] is None
    saved = _save(api_background_daily_request_budget=120)
    assert saved["ok"] is True and saved["budgetRuntime"] is None
    assert env.settings.features.api_background_daily_request_budget == 120


def test_uninitialized_settings_and_ledger_return_null_without_defaulting_to_disabled(budget_env, monkeypatch):
    monkeypatch.setattr(ws_bridge.bridge_state, "settings", None)
    monkeypatch.setattr(ws_bridge.bridge_state, "api_budget", None)
    read = _read()
    saved = _save(api_background_daily_request_budget=120)
    assert read["ok"] is False and read["budgetRuntime"] is None
    assert saved["ok"] is False and saved["budgetRuntime"] is None


def test_a_runtime_settings_provider_error_returns_null_in_reads_and_save_receipts(budget_env, caplog):
    env = budget_env

    def unavailable():
        raise RuntimeError("isolated runtime settings unavailable")

    env.tracker._settings_provider = unavailable
    with pytest.raises(RuntimeError, match="runtime settings unavailable"):
        env.tracker.runtime_settings()
    assert _read()["budgetRuntime"] is None
    saved = _save(api_background_daily_request_budget=120)
    assert saved["ok"] is True and saved["budgetRuntime"] is None
    assert json.loads(env.config.read_text())["features"]["api_background_daily_request_budget"] == 120
    assert "Could not read running API budget settings" in caplog.text


def test_a_real_settings_write_failure_preserves_live_budget_and_ledger_decisions(budget_env, monkeypatch):
    env = budget_env
    _call(env)
    previous_config = env.config.read_bytes()
    blocked_parent = env.root / "blocked-config-parent"
    blocked_parent.write_text("a file cannot be a directory", encoding="utf-8")
    monkeypatch.setattr(settings_module, "CONFIG_FILE", blocked_parent / "config.json")
    saved = _save(api_background_daily_request_budget=120, api_background_daily_token_budget=100_000)
    assert saved["ok"] is False and saved["budgetRuntime"] == _runtime()
    assert env.settings.features.api_background_daily_request_budget == 1
    assert env.settings.features.api_background_daily_token_budget == 10_000
    assert env.config.read_bytes() == previous_config and _read()["budgetRuntime"] == _runtime()
    with pytest.raises(ApiBudgetExceeded):
        _call(env)
    assert len(env.provider.calls) == 1 and env.tracker.snapshot()["requests"] == 1


def test_a_postwrite_apply_error_reports_unconfirmed_with_the_actual_running_budget(budget_env, monkeypatch):
    env = budget_env
    _call(env)
    original_features = env.settings.features
    applied = []

    def fail_after_write(**_kwargs):
        applied.append(env.tracker.runtime_settings())
        raise RuntimeError("isolated post-save apply failure")

    monkeypatch.setattr(ws_bridge.bridge_state, "keepsakes", SimpleNamespace(apply_settings=fail_after_write))
    saved = _save(api_background_daily_request_budget=120, api_background_daily_token_budget=100_000)
    expected_runtime = _runtime(requests=120, tokens=100_000)
    assert saved["ok"] is False and saved["code"] == "settings_runtime_unconfirmed"
    assert saved["budgetRuntime"] == expected_runtime and applied == [expected_runtime]
    assert saved["features"]["api_background_daily_request_budget"] == 120
    assert saved["features"]["api_background_daily_token_budget"] == 100_000
    written = json.loads(env.config.read_text())
    assert written["features"]["api_background_daily_request_budget"] == 120
    assert written["features"]["api_background_daily_token_budget"] == 100_000
    assert env.settings.features is original_features
    assert env.tracker.runtime_settings() == _read()["budgetRuntime"] == expected_runtime
    # The overall apply is unconfirmed; the ledger still uses the committed
    # feature object immediately, so a second background call is now allowed.
    assert _call(env).content == "隔离提供方结果。"
    snapshot = env.tracker.snapshot()
    assert len(env.provider.calls) == snapshot["background"]["requests"] == 2
    assert snapshot["background"]["request_budget"] == 120
    assert snapshot["background"]["token_budget"] == 100_000


def test_invalid_budget_input_leaves_settings_disk_and_runtime_unchanged(budget_env):
    env = budget_env
    previous_config = env.config.read_bytes()
    saved = _save(api_background_daily_request_budget="not-a-number", api_background_budget_enforced=False)
    assert saved["ok"] is False and saved["budgetRuntime"] == _runtime()
    assert env.settings.features.api_background_budget_enforced is True
    assert env.settings.features.api_background_daily_request_budget == 1
    assert env.config.read_bytes() == previous_config


def _commit_exchange(kernel, token, index):
    request_id = f"isolated-summary-{index}"
    user_text = f"隔离资料{index}：" + "资料" * 150
    scope = PersonaScopeV4(persona_id=token.persona_id, epoch=token.epoch, fingerprint=token.fingerprint)
    command = CommandEnvelopeV4(
        request_id=request_id, idempotency_key=request_id, command="chat:send",
        persona=scope, payload={"text": user_text},
    )
    kernel.begin_command(command)
    kernel.append_user_message(
        request_id=request_id, conversation_id="isolated-summary", persona_id=token.persona_id,
        text=user_text,
    )
    kernel.commit_chat_exchange(
        command, conversation_id="isolated-summary", user_text=user_text,
        assistant_bubbles=[f"隔离回应{index}：" + "回应" * 150],
    )
    return request_id


def test_budget_denied_summary_source_stays_excluded_after_cooldown_raise_and_restart(budget_env, monkeypatch):
    env = budget_env

    async def scenario():
        # Exhaust the real shared adapter budget before requesting a summary.
        await env.adapter.chat(
            [{"role": "user", "content": "abcd"}], purpose="memory_summary",
            background=True, max_tokens=98,
        )
        registry = PersonaEpochRegistry()
        persona = default_persona()
        token = registry.activate_initial(persona)
        path = env.root / "summary-kernel.sqlite3"
        kernel = KernelStore(path)
        clock = SimpleNamespace(current=1000.0)
        runtime = None

        def compose(store, current_registry, current_token):
            return ConversationSummaryRuntime(
                store, env.adapter, registry=current_registry, token=current_token,
                enabled=lambda: current_runtime_settings(env.settings).features.hypa_compression_enabled,
                llm_settings_provider=lambda: current_runtime_settings(env.settings).llm,
                clock=lambda: clock.current,
            )

        async def committed(index):
            request_id = _commit_exchange(kernel, token, index)
            runtime.on_chat_committed("isolated-summary", request_id)
            if runtime._task is not None:
                await runtime._task

        try:
            store = SummaryStore(kernel, token)
            for index in range(40):
                _commit_exchange(kernel, token, index)
            original = store.select_source("isolated-summary").source
            assert original is not None
            old_ids = {message.message_id for message in original.messages}
            runtime = compose(store, registry, token)
            runtime.on_chat_committed("isolated-summary", "isolated-summary-39")
            await runtime._task
            denied = store.status("isolated-summary", now=clock.current)
            assert denied["errorCode"] == "budget_denied" and denied["attempts"] == {"failed": 1}
            assert len(env.provider.calls) == 1 and env.tracker.snapshot()["requests"] == 1
            waiting_source = store.select_source("isolated-summary").source
            assert waiting_source is not None and old_ids.isdisjoint(message.message_id for message in waiting_source.messages)

            clock.current = 1001.0
            await committed(40)
            saved = await ws_bridge.handle_settings_update({
                "section": "personality", "api_background_daily_request_budget": 2,
                "api_background_daily_token_budget": 100_000,
            }, object())
            assert saved["ok"] is True and saved["budgetRuntime"] == _runtime(requests=2, tokens=100_000)
            clock.current = 1002.0
            await committed(41)
            assert len(env.provider.calls) == 1 and store.status("isolated-summary", now=clock.current)["attempts"] == {"failed": 1}
            clock.current = 1301.0
            assert store.claim_attempt(original, now=clock.current) is None

            await runtime.aclose()
            kernel.close()
            kernel = KernelStore(path)
            registry = PersonaEpochRegistry()
            token = registry.activate_initial(persona)
            store = SummaryStore(kernel, token)
            clock.current = 10_000.0
            assert store.claim_attempt(original, now=clock.current) is None
            next_source = store.select_source("isolated-summary").source
            assert next_source is not None
            assert old_ids.isdisjoint(message.message_id for message in next_source.messages)
            restarted_budget = ApiBudgetTracker(
                env.settings.features, path=env.tracker.path,
                settings_provider=lambda: current_runtime_settings(env.settings).features,
            )
            env.adapter.budget_tracker = restarted_budget
            monkeypatch.setattr(ws_bridge.bridge_state, "api_budget", restarted_budget)
            runtime = compose(store, registry, token)
            await committed(42)
            summaries = store.active_summaries("isolated-summary")
            assert len(env.provider.calls) == 2 and len(summaries) == 1
            assert old_ids.isdisjoint(summaries[0].source_ids)
            assert store.status("isolated-summary", now=clock.current)["attempts"] == {"completed": 1, "failed": 1}
            assert restarted_budget.snapshot()["background"]["requests"] == 2
            assert not path.read_bytes().startswith(SQLITE_HEADER)
        finally:
            if runtime is not None:
                await runtime.aclose()
            kernel.close()

    asyncio.run(scenario())
