"""The proactive silence effect is claimed in the encrypted per-persona state."""

from datetime import timedelta

import pytest

from src.chat.proactive import ProactiveChat
from src.persona.persona_card import default_persona
from tests.test_preview_proactive import preview


def _remount(env, persona=None):
    return ProactiveChat(persona or env.runtime._session.persona, env.state.adapter, env.state.emotion,
                         world_clock=env.state.world_clock, kernel_store=env.kernel,
                         persona_epoch_registry=env.epochs, preview_mode=True)


def _apply_and_count(env, state):
    before = dict(state.emotion.values)
    state._apply_silence_emotion_if_needed()
    return state.emotion.values["sadness"] - before["sadness"]


def test_silence_marker_is_committed_before_the_effect_and_survives_remount(preview, monkeypatch):
    state = preview.state
    state._record_successful_trigger("morning_greeting", {})
    sent_at = preview.now.value.isoformat()
    preview.now.value += timedelta(hours=4)
    apply = state.emotion.apply_user_silence

    def assert_saved_before_emotion(hours):
        saved = preview.kernel.read_proactive_trigger_state(preview.token.persona_id)
        assert saved["silence_handled_for"] == sent_at
        return apply(hours)

    monkeypatch.setattr(state.emotion, "apply_user_silence", assert_saved_before_emotion)
    assert _apply_and_count(preview, state) > 0
    preview.now.value += timedelta(hours=2)
    assert _apply_and_count(preview, _remount(preview)) == 0


def test_silence_marker_survives_switching_persona_and_back(preview):
    persona = preview.runtime._session.persona
    preview.state._record_successful_trigger("morning_greeting", {})
    preview.now.value += timedelta(hours=4)
    assert _apply_and_count(preview, preview.state) > 0

    def switch(target):
        authorization = preview.epochs.authorize_update(actor="owner", reason="synthetic silence switch",
                                                        user_confirmed=True)
        preview.epochs.activate_update(target, authorization)

    other = default_persona()
    other.identity = {**other.identity, "persona_id": "silence-other-persona"}
    switch(other)
    assert _apply_and_count(preview, _remount(preview, other)) == 0
    assert preview.kernel.read_proactive_trigger_state("silence-other-persona") is None
    switch(persona)
    assert _apply_and_count(preview, _remount(preview, persona)) == 0


def test_next_unanswered_proactive_message_is_handled_once(preview):
    state = preview.state
    state._record_successful_trigger("morning_greeting", {})
    preview.now.value += timedelta(hours=4)
    assert _apply_and_count(preview, state) > 0
    state._record_successful_trigger("evening_checkin", {})
    sent_at = preview.now.value.isoformat()
    preview.now.value += timedelta(hours=4)
    assert _apply_and_count(preview, state) > 0
    assert _apply_and_count(preview, state) == 0
    assert preview.kernel.read_proactive_trigger_state(preview.token.persona_id)["silence_handled_for"] == sent_at


@pytest.mark.parametrize("age_hours", [3, 4, 8])
def test_legacy_trigger_state_marks_only_already_due_silence_as_handled(preview, age_hours):
    sent_at = preview.now.value - timedelta(hours=age_hours)
    preview.kernel.write_proactive_trigger_state(preview.token.persona_id, {
        "last_proactive_at": sent_at.isoformat(), "last_proactive_replied": False,
    })
    state = _remount(preview)
    assert _apply_and_count(preview, state) == 0
    preview.now.value += timedelta(hours=1)
    changed = _apply_and_count(preview, state)
    assert (changed > 0) == (age_hours < 4)
    assert _apply_and_count(preview, state) == 0


def test_reply_and_save_failure_leave_emotions_untouched(preview, monkeypatch, caplog):
    state = preview.state
    state._record_successful_trigger("morning_greeting", {})
    state.mark_user_replied("合成保密资料")
    preview.now.value += timedelta(hours=4)
    assert _apply_and_count(preview, state) == 0
    state._record_successful_trigger("evening_checkin", {})
    preview.now.value += timedelta(hours=4)

    def fail(*_args):
        raise OSError("合成保密资料")

    with monkeypatch.context() as patch:
        patch.setattr(preview.kernel, "write_proactive_trigger_state", fail)
        assert _apply_and_count(preview, state) == 0
    assert "could not save the silence marker" in caplog.text
    assert "合成保密资料" not in caplog.text
    assert _apply_and_count(preview, state) > 0
