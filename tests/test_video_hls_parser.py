"""RFC 8216 HLS parser tests (src/video_download/hls.py)."""

import pytest

from src.video_download.hls import (
    HlsError,
    MasterPlaylist,
    MediaPlaylist,
    is_master_playlist,
    parse_media,
    parse_playlist,
    resolve_url,
)

BASE = "https://cdn.example.com/videos/show/index.m3u8"


def test_rejects_non_m3u8_text():
    with pytest.raises(HlsError):
        parse_playlist("this is not a playlist", BASE)


def test_parses_simple_media_playlist_with_relative_uris():
    text = (
        "#EXTM3U\n"
        "#EXT-X-VERSION:3\n"
        "#EXT-X-TARGETDURATION:10\n"
        "#EXT-X-MEDIA-SEQUENCE:0\n"
        "#EXTINF:9.9,\n"
        "seg0.ts\n"
        "#EXTINF:9.9,\n"
        "seg1.ts\n"
        "#EXT-X-ENDLIST\n"
    )
    playlist = parse_playlist(text, BASE)
    assert isinstance(playlist, MediaPlaylist)
    assert playlist.target_duration == 10.0
    assert len(playlist.segments) == 2
    assert playlist.segments[0].uri == "https://cdn.example.com/videos/show/seg0.ts"
    assert playlist.segments[1].sequence == 1
    assert playlist.is_encrypted is False
    assert playlist.is_fmp4 is False
    assert playlist.total_duration == pytest.approx(19.8)


def test_master_playlist_detection_and_best_variant():
    text = (
        "#EXTM3U\n"
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"\n'
        "low/index.m3u8\n"
        "#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720\n"
        "high/index.m3u8\n"
    )
    assert is_master_playlist(text) is True
    master = parse_playlist(text, BASE)
    assert isinstance(master, MasterPlaylist)
    assert len(master.variants) == 2
    best = master.best_by_bandwidth()
    assert best is not None
    assert best.bandwidth == 2400000
    assert best.uri == "https://cdn.example.com/videos/show/high/index.m3u8"
    # Quoted CODECS containing a comma must not be split into a bogus variant.
    assert master.variants[0].codecs == "avc1.4d401e,mp4a.40.2"
    assert master.variants[0].resolution == "640x360"


def test_aes128_explicit_iv_is_used():
    text = (
        "#EXTM3U\n"
        "#EXT-X-TARGETDURATION:6\n"
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001\n'
        "#EXTINF:6.0,\n"
        "seg0.ts\n"
    )
    playlist = parse_media(text, BASE)
    assert playlist.is_encrypted is True
    key = playlist.segments[0].key
    assert key is not None
    assert key.method == "AES-128"
    assert key.uri == "https://cdn.example.com/videos/show/key.bin"
    assert key.iv == (1).to_bytes(16, "big")


def test_aes128_implicit_iv_derives_from_media_sequence():
    text = (
        "#EXTM3U\n"
        "#EXT-X-MEDIA-SEQUENCE:7\n"
        '#EXT-X-KEY:METHOD=AES-128,URI="https://k.example.com/k"\n'
        "#EXTINF:6.0,\n"
        "seg7.ts\n"
        "#EXTINF:6.0,\n"
        "seg8.ts\n"
    )
    playlist = parse_media(text, BASE)
    first = playlist.segments[0].key
    second = playlist.segments[1].key
    assert first is not None and second is not None
    # No explicit IV -> derived from the segment's media sequence number.
    assert first.iv == (7).to_bytes(16, "big")
    assert second.iv == (8).to_bytes(16, "big")
    # Absolute key URI is preserved.
    assert first.uri == "https://k.example.com/k"


def test_key_none_clears_encryption_for_following_segments():
    text = (
        "#EXTM3U\n"
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n'
        "#EXTINF:6.0,\n"
        "enc.ts\n"
        "#EXT-X-KEY:METHOD=NONE\n"
        "#EXTINF:6.0,\n"
        "plain.ts\n"
    )
    playlist = parse_media(text, BASE)
    assert playlist.segments[0].key is not None
    assert playlist.segments[1].key is None


def test_sample_aes_and_drm_methods_are_refused():
    for method in ("SAMPLE-AES", "SAMPLE-AES-CTR", "com.apple.streamingkeydelivery"):
        text = (
            "#EXTM3U\n"
            f'#EXT-X-KEY:METHOD={method},URI="skd://key"\n'
            "#EXTINF:6.0,\n"
            "seg0.ts\n"
        )
        with pytest.raises(HlsError):
            parse_media(text, BASE)


def test_fmp4_init_section_and_byterange():
    text = (
        "#EXTM3U\n"
        '#EXT-X-MAP:URI="init.mp4"\n'
        "#EXTINF:6.0,\n"
        "#EXT-X-BYTERANGE:75232@0\n"
        "media.mp4\n"
        "#EXTINF:6.0,\n"
        "#EXT-X-BYTERANGE:82112\n"
        "media.mp4\n"
    )
    playlist = parse_media(text, BASE)
    assert playlist.is_fmp4 is True
    assert playlist.init_section is not None
    assert playlist.init_section.uri == "https://cdn.example.com/videos/show/init.mp4"
    first = playlist.segments[0].byte_range
    second = playlist.segments[1].byte_range
    assert first is not None and first.length == 75232 and first.offset == 0
    # A length-only sub-range continues from the previous range's end.
    assert second is not None and second.length == 82112 and second.offset == 75232


def test_resolve_url_rejects_empty_reference():
    with pytest.raises(HlsError):
        resolve_url(BASE, "   ")
