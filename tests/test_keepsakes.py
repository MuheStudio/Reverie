from pathlib import Path

from src.keepsakes import KeepsakeManager


def test_keepsake_manager_persists_independent_collection(tmp_path: Path) -> None:
    manager = KeepsakeManager(data_dir=tmp_path, random_func=lambda: 0.0)
    item = manager.add(
        kind="photo",
        title="一起看的月亮",
        content="她觉得这张照片很适合以后翻出来",
        media_data_url="data:image/png;base64,abc",
        tags=["照片", "夜晚"],
    )

    reloaded = KeepsakeManager(data_dir=tmp_path, random_func=lambda: 0.0)
    items = reloaded.list_recent()

    assert item.id
    assert (tmp_path / "keepsakes.json").exists()
    assert items[0].title == "一起看的月亮"
    assert items[0].media_data_url.startswith("data:image/png")
    assert items[0].tags == ["照片", "夜晚"]


def test_keepsake_recall_context_is_probability_gated(tmp_path: Path) -> None:
    never = KeepsakeManager(data_dir=tmp_path / "never", random_func=lambda: 0.99)
    never.add(kind="special_memory", title="不会翻出", content="概率不够")

    always = KeepsakeManager(data_dir=tmp_path / "always", random_func=lambda: 0.0)
    always.add(kind="special_memory", title="会翻出", content="她收起来的回忆")

    assert never.maybe_recall_context() == ""
    context = always.maybe_recall_context()
    assert "MEMORY COLLECTION" in context
    assert "会翻出" in context


def test_keepsake_rejects_non_image_data_urls(tmp_path: Path) -> None:
    manager = KeepsakeManager(data_dir=tmp_path)
    item = manager.add(
        kind="sticker",
        title="奇怪文件",
        media_data_url="data:text/html;base64,PHNjcmlwdA==",
    )

    assert item.media_data_url == ""
