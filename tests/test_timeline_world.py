import asyncio

from src.config.settings import FeatureSettings
from src.persona.persona_card import default_persona
from src.timeline import TimelineManager


class FakeTimelineResponse:
    def __init__(self, content: str) -> None:
        self.content = content


class FakeTimelineAdapter:
    async def chat(self, _messages: list[dict], **_kwargs) -> FakeTimelineResponse:
        return FakeTimelineResponse("今天把画稿推进了一点，草稿终于不再像乱线团了")


def test_timeline_visual_continuity_metadata(monkeypatch, tmp_path) -> None:
    features = FeatureSettings(timeline_enabled=True, timeline_visuals_enabled=True)
    timeline = TimelineManager(
        default_persona(),
        adapter=FakeTimelineAdapter(),
        feature_settings=features,
        data_dir=tmp_path,
    )
    timeline.create_event("练习画画")
    monkeypatch.setattr("src.timeline.random.random", lambda: 0.0)

    post = asyncio.run(timeline.generate_post("afternoon_update"))

    assert post is not None
    assert post.event_type == "story"
    assert post.media_kind == "sketch"
    assert post.visual_stage == "草稿"
    assert "练习画画" in (post.visual_prompt or "")


def test_timeline_maybe_generate_respects_world_life_switch(tmp_path) -> None:
    features = FeatureSettings(timeline_enabled=True, world_life_enabled=False)
    timeline = TimelineManager(
        default_persona(),
        adapter=FakeTimelineAdapter(),
        feature_settings=features,
        data_dir=tmp_path,
    )

    post = asyncio.run(timeline.maybe_generate())

    assert post is None
