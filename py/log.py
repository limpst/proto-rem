"""시스템 로그 링버퍼.

이 도구는 "안 보이는 곳에서 오래 도는" 종류다 (홈페이지 크롤 → LLM 호출 → SMTP).
사용자 입장에서는 멈춘 건지 도는 건지 알 수가 없으므로, 서버에서 일어나는 흐름을
전부 한 줄씩 남기고 대시보드 하단 콘솔이 /api/logs 로 이어 받는다.

메모리에만 둔다. 로그에 명함 개인정보가 섞이므로 파일로 떨구지 않는다.
"""
from __future__ import annotations

import json
import sys
import threading
import time
from datetime import datetime, timezone

MAX = 800
_buf: list[dict] = []
_seq = 0
_lock = threading.Lock()


def _clip(v, n: int = 160) -> str:
    """명함·본문이 통째로 로그에 박히지 않게 자른다."""
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)
    s = str(s)
    return s if len(s) <= n else f"{s[:n]}…(+{len(s) - n})"


def log(level: str, tag: str, msg: str, meta: dict | None = None) -> dict:
    """level: info | ok | warn | error | net | ai"""
    global _seq
    with _lock:
        _seq += 1
        e = {
            "seq": _seq,
            "t": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "level": level,
            "tag": tag,
            "msg": _clip(msg, 400),
        }
        if meta:
            e["meta"] = {k: _clip(v, 120) for k, v in meta.items() if v is not None}
        _buf.append(e)
        if len(_buf) > MAX:
            del _buf[: len(_buf) - MAX]

    # 터미널에도 같은 줄을 남긴다. 서버 창만 봐도 흐름이 읽히도록.
    line = f"[{tag}] {e['msg']}" + (f" {json.dumps(e.get('meta', {}), ensure_ascii=False)}" if meta else "")
    print(line, file=sys.stderr if level == "error" else sys.stdout, flush=True)
    return e


def since(n: int = 0) -> dict:
    with _lock:
        return {"seq": _seq, "events": [e for e in _buf if e["seq"] > (n or 0)]}


def clear() -> dict:
    with _lock:
        _buf.clear()
    return {"seq": _seq, "events": []}


class timed:
    """오래 걸리는 작업을 감싸 시작·끝·소요시간을 한 쌍으로 남긴다.

        with timed("llm", "문안 생성", {"model": m}):
            ...
    """

    def __init__(self, tag: str, msg: str, meta: dict | None = None):
        self.tag, self.msg, self.meta = tag, msg, dict(meta or {})

    def __enter__(self):
        self.t0 = time.time()
        log("info", self.tag, f"▶ {self.msg}", self.meta)
        return self

    def __exit__(self, exc_type, exc, tb):
        ms = int((time.time() - self.t0) * 1000)
        if exc is None:
            log("ok", self.tag, f"✔ {self.msg}", {**self.meta, "ms": ms})
        else:
            log("error", self.tag, f"✘ {self.msg} — {exc}", {**self.meta, "ms": ms})
        return False
