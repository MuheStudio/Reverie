import asyncio
import json

import httpx
import pytest

from src.immersion.amap import (
    AROUND_URL,
    CONVERT_URL,
    MAX_RESPONSE_BYTES,
    AmapError,
    AmapPOIService,
)
from src.local_mode import get_local_mode_gate


def _json_response(request: httpx.Request, value: dict) -> httpx.Response:
    return httpx.Response(200, request=request, content=json.dumps(value).encode())


def test_wgs84_conversion_precedes_exact_around_request_and_output_is_private() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        assert request.method == "GET"
        assert request.url.host == "restapi.amap.com"
        if str(request.url).startswith(CONVERT_URL):
            assert dict(request.url.params) == {
                "key": "owner-key",
                "locations": "116.4074000,39.9042000",
                "coordsys": "gps",
            }
            return _json_response(request, {"status": "1", "locations": "116.413,39.905"})
        assert str(request.url).startswith(AROUND_URL)
        assert dict(request.url.params) == {
            "key": "owner-key",
            "location": "116.413,39.905",
            "types": "050000",
            "radius": "1200",
            "sortrule": "distance",
            "page_size": "3",
            "page_num": "1",
        }
        return _json_response(request, {
            "status": "1",
            "pois": [{
                "name": "测试餐厅",
                "distance": "321",
                "adname": "东城区",
                "address": "测试街 1 号",
                "location": "must-not-return",
                "type": "raw-provider-type",
            }],
        })

    service = AmapPOIService("owner-key", transport=httpx.MockTransport(handler))
    result = asyncio.run(service.search_category(
        "restaurant", 39.9042, 116.4074, radius=1200, limit=3
    ))

    assert [request.url.path for request in seen] == [
        "/v3/assistant/coordinate/convert", "/v5/place/around"
    ]
    item = result.items[0].to_dict()
    assert set(item) == {
        "name", "broad_category", "distance_band", "district",
        "short_address", "provider", "observed_at",
    }
    serialized = json.dumps(item, ensure_ascii=False)
    assert "116." not in serialized
    assert "owner-key" not in serialized
    assert "raw-provider-type" not in serialized
    assert item["distance_band"] == "250-500m"


def test_local_mode_blocks_before_transport_or_dns() -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise AssertionError("network must not start")

    gate = get_local_mode_gate()
    previous = gate.snapshot()
    gate.set(True, epoch=previous.epoch + 1, session_id="amap-test")
    try:
        service = AmapPOIService("owner-key", transport=httpx.MockTransport(handler))
        with pytest.raises(Exception):
            asyncio.run(service.search_category(
                "cafe", 39.9, 116.4, radius=500, limit=3
            ))
        assert calls == 0
    finally:
        gate.set(False, epoch=previous.epoch + 2, session_id="amap-test-end")


@pytest.mark.parametrize("payload", [
    pytest.param(b"not-json", id="invalid-json"),
    pytest.param(json.dumps({"status": "1", "locations": "bad"}).encode(), id="bad-coordinate"),
    pytest.param(b"x" * (MAX_RESPONSE_BYTES + 1), id="oversized"),
])
def test_malformed_and_oversized_conversion_responses_are_redacted(payload: bytes) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request, content=payload)

    service = AmapPOIService("secret-canary", transport=httpx.MockTransport(handler))
    with pytest.raises(AmapError) as raised:
        asyncio.run(service.search_category(
            "restaurant", 39.9, 116.4, radius=500, limit=3
        ))
    assert raised.value.code == "unavailable"
    assert "secret-canary" not in str(raised.value)


@pytest.mark.parametrize(("infocode", "expected"), [("10003", "quota"), ("99999", "unavailable")])
def test_provider_errors_have_stable_redacted_codes(infocode: str, expected: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return _json_response(request, {"status": "0", "infocode": infocode, "info": "sensitive"})

    service = AmapPOIService("secret-canary", transport=httpx.MockTransport(handler))
    with pytest.raises(AmapError) as raised:
        asyncio.run(service.search_category(
            "restaurant", 39.9, 116.4, radius=500, limit=3
        ))
    assert raised.value.code == expected
    assert str(raised.value) == expected


def test_transport_timeout_has_stable_redacted_code_and_no_retry() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("sensitive transport detail", request=request)

    service = AmapPOIService("secret-canary", transport=httpx.MockTransport(handler))
    with pytest.raises(AmapError) as raised:
        asyncio.run(service.search_category(
            "restaurant", 39.9, 116.4, radius=500, limit=3
        ))
    assert raised.value.code == "timeout"
    assert str(raised.value) == "timeout"
    assert calls == 1
