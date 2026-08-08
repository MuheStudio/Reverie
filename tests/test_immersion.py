import asyncio

from src.config.settings import FeatureSettings
from src.immersion import ImmersionManager


class FakePOIItem:
    def __init__(self, name: str, distance_m: int = 120) -> None:
        self.name = name
        self.address = "测试街 1 号"
        self.type_name = "餐饮"
        self.distance_m = distance_m


class FakePOIResult:
    provider = "fake"

    def __init__(self, items: list[FakePOIItem]) -> None:
        self.items = items


class FakePOIService:
    async def search(self, query: str, *_args, **_kwargs) -> FakePOIResult:
        return FakePOIResult([FakePOIItem(f"{query}小店")])


class FailingPOIService:
    async def search(self, *_args, **_kwargs) -> FakePOIResult:
        raise RuntimeError("network down")


def test_nearby_context_requires_user_enabled_location() -> None:
    manager = ImmersionManager(FeatureSettings(immersion_location_enabled=False))

    result = manager.nearby_life_context(latitude=39.9042, longitude=116.4074)

    assert result["ok"] is False
    assert result["places"] == []


def test_nearby_context_handles_bad_coordinates_without_raising() -> None:
    manager = ImmersionManager(FeatureSettings(immersion_location_enabled=True))

    result = manager.nearby_life_context(latitude="bad", longitude=116.4, radius_m="bad")

    assert result["ok"] is False
    assert result["error"] == "Invalid coordinates"


def test_nearby_context_rounds_location_and_filters_types() -> None:
    manager = ImmersionManager(FeatureSettings(immersion_location_enabled=True))

    result = manager.nearby_life_context(
        latitude=39.9042123,
        longitude=116.4074123,
        place_types=["restaurant", "politics", "shop"],
        radius_m=99999,
    )

    assert result["ok"] is True
    assert result["coarse_location"] == {"latitude": 39.904, "longitude": 116.407}
    assert result["radius_m"] == 5000
    assert [place["kind"] for place in result["places"]] == ["restaurant", "shop"]
    assert result["suggestions"][0]["ideas"]


def test_nearby_context_can_use_real_poi_adapter_without_returning_coordinates() -> None:
    manager = ImmersionManager(
        FeatureSettings(immersion_location_enabled=True),
        poi_service_factory=FakePOIService,
    )

    result = asyncio.run(
        manager.nearby_life_context_async(
            latitude=39.9042,
            longitude=116.4074,
            place_types=["restaurant"],
        )
    )

    assert result["ok"] is True
    assert result["poi_status"] == "ok"
    assert result["real_places"][0]["name"] == "餐厅小店"
    assert "lat" not in result["real_places"][0]
    assert "lon" not in result["real_places"][0]


def test_nearby_context_falls_back_when_poi_adapter_fails() -> None:
    manager = ImmersionManager(
        FeatureSettings(immersion_location_enabled=True),
        poi_service_factory=FailingPOIService,
    )

    result = asyncio.run(
        manager.nearby_life_context_async(
            latitude=39.9042,
            longitude=116.4074,
            place_types=["restaurant"],
        )
    )

    assert result["ok"] is True
    assert result["poi_status"] in {"failed", "empty"}
    assert result["suggestions"][0]["ideas"]


def test_nearby_context_does_not_discover_an_undeclared_network_adapter() -> None:
    manager = ImmersionManager(FeatureSettings(immersion_location_enabled=True))

    result = asyncio.run(
        manager.nearby_life_context_async(
            latitude=39.9042,
            longitude=116.4074,
            place_types=["restaurant"],
        )
    )

    assert result["ok"] is True
    assert result["provider"] == "local-privacy-preserving"
    assert result["poi_status"] == "unavailable"


def test_closeups_and_smart_home_are_opt_in_dry_runs() -> None:
    disabled = ImmersionManager(FeatureSettings())
    assert disabled.closeup_prompt_plan("meal")["ok"] is False
    assert disabled.smart_home_command(provider="xiaomi", device="灯", action="打开")["ok"] is False

    enabled = ImmersionManager(
        FeatureSettings(
            immersion_closeups_enabled=True,
            immersion_smart_home_enabled=True,
        )
    )
    closeup = enabled.closeup_prompt_plan("shopping")
    assert closeup["ok"] is True
    assert closeup["requires_multimodal_api"] is True

    command = enabled.smart_home_command(provider="xiaomi", device="灯", action="打开")
    assert command["ok"] is True
    assert command["dry_run"] is True


def test_smart_home_vendor_adapter_only_activates_with_credentials() -> None:
    class FakeAdapter:
        def execute(self, *, device: str, action: str) -> dict:
            return {"applied": True, "device": device, "action": action}

    configured = ImmersionManager(
        FeatureSettings(immersion_smart_home_enabled=True),
        vendor_adapter_factory=lambda provider: FakeAdapter() if provider == "xiaomi" else None,
    )
    controlled = configured.smart_home_command(provider="xiaomi", device="灯", action="打开")
    assert controlled["ok"] is True
    assert controlled["dry_run"] is False
    assert controlled["controller"] == "xiaomi"
    assert controlled["result"]["applied"] is True

    # Vendor without injected credentials stays a dry run.
    no_credentials = ImmersionManager(
        FeatureSettings(immersion_smart_home_enabled=True),
        vendor_adapter_factory=lambda provider: None,
    )
    still_dry = no_credentials.smart_home_command(provider="huawei", device="空调", action="26 度")
    assert still_dry["ok"] is True
    assert still_dry["dry_run"] is True

    # A raising factory must never fall through to a real device call.
    raising = ImmersionManager(
        FeatureSettings(immersion_smart_home_enabled=True),
        vendor_adapter_factory=lambda provider: (_ for _ in ()).throw(RuntimeError("no creds")),
    )
    safe = raising.smart_home_command(provider="xiaomi", device="灯", action="打开")
    assert safe["ok"] is True
    assert safe["dry_run"] is True
