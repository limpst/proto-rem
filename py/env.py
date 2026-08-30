"""의존성 없는 .env 로더.

os.environ 이 항상 우선한다 (PORT=8787 python -m py.server 같은 실행 시점 지정을 살리기 위해).
파일은 한 번만 읽어 캐시한다. Node 판 src/env.mjs 와 같은 규칙.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_LINE = re.compile(r"^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$")
_cache: dict[str, str] | None = None


def _load() -> dict[str, str]:
    global _cache
    if _cache is not None:
        return _cache
    _cache = {}
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.lstrip().startswith("#"):
                continue
            m = _LINE.match(line)
            if m:
                _cache[m.group(1)] = m.group(2).strip("\"'")
    return _cache


def env(key: str, fallback: str | None = None) -> str | None:
    return os.environ.get(key) or _load().get(key) or fallback


def env_int(key: str, fallback: int) -> int:
    try:
        return int(str(env(key, str(fallback))))
    except (TypeError, ValueError):
        return fallback


def env_bool(key: str, fallback: bool = False) -> bool:
    v = env(key)
    if v is None:
        return fallback
    return str(v).strip().lower() in ("1", "true", "yes", "on")
