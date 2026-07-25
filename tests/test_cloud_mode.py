from src.cloud import LocalOnly, create_cloud_service


def test_cloud_mode_degrades_to_local_only(caplog) -> None:
    service = create_cloud_service("cloud")

    assert isinstance(service, LocalOnly)
    assert "falling back to local-only mode" in caplog.text
