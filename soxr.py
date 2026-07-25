"""Compatibility shim for environments without the `soxr` package."""

from __future__ import annotations

import numpy as np
from typing import Any


class ResampleStream:
    def __init__(self, src_rate: int, dst_rate: int, *args: Any, **kwargs: Any) -> None:
        self.src_rate = int(src_rate)
        self.dst_rate = int(dst_rate)

    def resample_chunk(self, audio_float: np.ndarray) -> np.ndarray:
        return resample(audio_float, self.src_rate, self.dst_rate)


def resample(audio_float: np.ndarray, src_rate: int, dst_rate: int, *args: Any, **kwargs: Any) -> np.ndarray:
    audio_float = np.asarray(audio_float, dtype=np.float32)
    if src_rate == dst_rate:
        return audio_float.copy()
    src_len = int(audio_float.shape[0])
    if src_len <= 1:
        return audio_float.copy()
    target_len = max(1, int(round(src_len * float(dst_rate) / float(src_rate))))
    src_x = np.linspace(0.0, 1.0, src_len, endpoint=True)
    dst_x = np.linspace(0.0, 1.0, target_len, endpoint=True)
    return np.interp(dst_x, src_x, audio_float).astype(np.float32)
