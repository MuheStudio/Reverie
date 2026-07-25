from types import SimpleNamespace

import src.web as web_module
from src.config.settings import DATA_DIR, FeatureSettings
from src.persona.persona_card import default_persona
from src.ui.tui import ReverieTUI


def test_tui_draft_file_uses_configured_data_dir() -> None:
    assert ReverieTUI.DRAFT_FILE == DATA_DIR / "draft.txt"


def test_tui_creates_web_manager_when_feature_enabled(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(web_module, "WEB_CACHE_DIR", tmp_path / "web_cache")
    settings = SimpleNamespace(features=FeatureSettings(web_surfing_enabled=True))
    session = SimpleNamespace(
        persona=default_persona(),
        adapter=object(),
        memory=SimpleNamespace(
            autonomous_enabled=False,
            autonomous_llm_enabled=False,
        ),
        web=None,
    )
    app = ReverieTUI(session, settings=settings)

    app._sync_runtime_settings()

    assert app._web_surfing is not None
    assert session.web is app._web_surfing
    assert app._web_surfing.data_dir == tmp_path / "web_cache"
