"""LLM 백엔드 어댑터.

기본은 **Ollama**(로컬호스트 11434). 명함은 개인정보이므로 PC 밖으로 내보내지 않는 것이 기본값이다.
대시보드의 [AI 엔진] 패널에서 백엔드와 모델을 런타임에 바꿀 수 있고, 그 선택은 store 에 남는다.

우선순위 (LLM_BACKEND 로 강제 지정 가능: ollama | claude-api | claude-cli)
  1. ollama       — 로컬 실행. 데이터가 PC 밖으로 나가지 않는다.
  2. claude-api   — ANTHROPIC_API_KEY 가 있을 때
  3. claude-cli   — 설치된 Claude Code CLI 경유 (키 발급 불필요)

백엔드가 바뀌어도 호출부(enrich/generate/copy_ai)는 complete() 하나만 쓴다.
"""
from __future__ import annotations

import json
import re
import subprocess
import time
import urllib.error
import urllib.request

from . import log as L
from . import store
from .env import env, env_int

CLAUDE_MODEL = "claude-sonnet-5"
OLLAMA_URL = env("OLLAMA_URL", "http://127.0.0.1:11434")
DEFAULT_OLLAMA_MODEL = env("OLLAMA_MODEL", "exaone3.5:7.8b")

_cached_backend: dict | None = None
_cached_override: dict | None | str = "unread"

_CLOUD_RE = re.compile(r"[-:]cloud$")


def is_cloud_model(m) -> bool:
    """이름이 -cloud 로 끝나거나 remote_model 이 있으면 ollama.com 을 거친다.

    그 경우 "로컬이라 안전하다"는 설명이 성립하지 않으므로 화면에서 갈라 보여야 한다.
    """
    if isinstance(m, dict):
        return bool(m.get("remote_model")) or bool(_CLOUD_RE.search(str(m.get("name") or "")))
    return bool(_CLOUD_RE.search(str(m or "")))


def _override() -> dict | None:
    global _cached_override
    if _cached_override == "unread":
        try:
            _cached_override = store.load().get("llm")
        except Exception:
            _cached_override = None
    return _cached_override  # type: ignore[return-value]


def set_backend(name: str | None = None, model: str | None = None) -> dict:
    """대시보드에서 백엔드·모델을 바꾼다. 선택은 meta 에 남아 재시작해도 유지된다."""
    global _cached_override, _cached_backend
    nxt = dict(_override() or {})
    if name:
        nxt["name"] = name
    if model:
        nxt["model"] = model
    _cached_override = nxt
    _cached_backend = None
    store.update(lambda st: st.__setitem__("llm", nxt))
    L.log("info", "llm", f"AI 엔진 변경 → {nxt.get('name')} / {nxt.get('model') or '-'}")
    return nxt


def ollama_alive() -> bool:
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


def resolve_backend(refresh: bool = False) -> dict:
    """어떤 백엔드가 실제로 쓰이는지. 대시보드가 이 값을 표시한다."""
    global _cached_backend, _cached_override
    if refresh:
        _cached_backend = None
        _cached_override = "unread"
    if _cached_backend:
        return _cached_backend

    ov = _override() or {}
    forced = ov.get("name") or env("LLM_BACKEND")
    picked = ov.get("model")
    source = "dashboard" if ov.get("name") else ("env" if env("LLM_BACKEND") else "auto")

    if forced == "ollama" or (not forced and ollama_alive()):
        model = picked or DEFAULT_OLLAMA_MODEL
        _cached_backend = {"name": "ollama", "model": model, "url": OLLAMA_URL,
                           "source": source, "alive": ollama_alive(), "cloud": is_cloud_model(model)}
    elif forced:
        _cached_backend = {"name": forced, "model": CLAUDE_MODEL, "source": source, "cloud": True}
    elif env("ANTHROPIC_API_KEY"):
        _cached_backend = {"name": "claude-api", "model": CLAUDE_MODEL, "source": source, "cloud": True}
    else:
        _cached_backend = {"name": "claude-cli", "model": CLAUDE_MODEL, "source": source, "cloud": True}
    return _cached_backend


def list_ollama_models() -> dict:
    """설치된 Ollama 모델 목록. 대시보드의 모델 선택기가 쓴다."""
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=2.5) as r:
            j = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"ok": False, "reason": str(e), "models": []}
    models = [{
        "name": m.get("name"),
        "params": (m.get("details") or {}).get("parameter_size", ""),
        "quant": (m.get("details") or {}).get("quantization_level", ""),
        "ctx": (m.get("details") or {}).get("context_length"),
        "cloud": is_cloud_model(m),
    } for m in (j.get("models") or [])]
    models.sort(key=lambda m: (m["cloud"], m["name"] or ""))
    return {"ok": True, "models": models}


def complete(prompt: str, max_tokens: int | None = None, temperature: float | None = None) -> str:
    b = resolve_backend()
    t0 = time.time()
    L.log("ai", "llm", f"요청 → {b['name']} / {b['model']}",
          {"prompt": len(prompt), "cloud": b.get("cloud")})
    try:
        if b["name"] == "ollama":
            out = _via_ollama(prompt, b["model"], max_tokens, temperature)
        elif b["name"] == "claude-api":
            out = _via_api(prompt, max_tokens or 1500)
        else:
            out = _via_cli(prompt)
    except Exception as e:
        L.log("error", "llm", f"실패 — {e}", {"ms": int((time.time() - t0) * 1000)})
        raise
    L.log("ok", "llm", "응답 수신", {"chars": len(out), "ms": int((time.time() - t0) * 1000)})
    return out


def _via_ollama(prompt: str, model: str, max_tokens: int | None, temperature: float | None) -> str:
    """로컬 Ollama. 이름에 -cloud 가 붙은 모델만 외부(ollama.com)를 거친다.

    로컬 CPU 추론은 한 건에 수 분이 걸릴 수 있어 타임아웃을 넉넉히 둔다.
    출력 길이(num_predict)를 묶어 두면 생성 시간의 상한도 같이 묶인다.
    """
    payload = json.dumps({
        "model": model,
        "prompt": prompt,
        "stream": False,
        # 호출 사이에 모델이 메모리에서 내려가면 다음 호출에 재로딩(수 분)이 붙는다.
        "keep_alive": env("OLLAMA_KEEP_ALIVE", "30m"),
        "options": {
            "temperature": 0.4 if temperature is None else temperature,
            "num_ctx": 8192,
            "num_predict": int(max_tokens or env_int("OLLAMA_NUM_PREDICT", 500)),
        },
    }).encode("utf-8")

    req = urllib.request.Request(f"{OLLAMA_URL}/api/generate", data=payload,
                                 headers={"content-type": "application/json"})
    timeout = env_int("OLLAMA_TIMEOUT_MS", 900000) / 1000
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return str(json.loads(r.read().decode("utf-8")).get("response") or "").strip()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Ollama {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from e


def _via_api(prompt: str, max_tokens: int) -> str:
    if not env("ANTHROPIC_API_KEY"):
        # 배포 서버에서 가장 흔한 사고. 원인을 화면에 그대로 띄워 준다.
        raise RuntimeError(
            "ANTHROPIC_API_KEY 가 없습니다. Render 대시보드의 Environment 에 키를 넣으세요. "
            "(로컬이라면 STEP 5 의 [AI 엔진] 에서 ollama 로 바꾸면 키 없이 됩니다.)")
    payload = json.dumps({
        "model": CLAUDE_MODEL,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=payload, headers={
        "content-type": "application/json",
        "x-api-key": env("ANTHROPIC_API_KEY") or "",
        "anthropic-version": "2023-06-01",
    })
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            j = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Claude API {e.code}: {e.read().decode('utf-8', 'replace')[:400]}") from e
    return "".join(b.get("text", "") for b in j.get("content", []))


def _via_cli(prompt: str) -> str:
    """프롬프트는 stdin 으로 넘긴다. 인자로 넘기면 Windows 에서 줄바꿈이 깨진다."""
    try:
        p = subprocess.run(
            ["claude", "-p", "--model", CLAUDE_MODEL, "--output-format", "text"],
            input=prompt, capture_output=True, text=True, encoding="utf-8",
            shell=(__import__("sys").platform == "win32"),
        )
    except FileNotFoundError as e:
        # 배포 서버에는 Claude Code CLI 가 없다. "spawn claude ENOENT" 의 정체.
        raise RuntimeError(
            "이 서버에는 claude CLI 가 설치돼 있지 않습니다. "
            "LLM_BACKEND 를 claude-api(키 필요) 또는 ollama 로 바꾸세요.") from e
    if p.returncode != 0:
        raise RuntimeError(f"claude CLI exit {p.returncode}: {(p.stderr or '')[:500]}")
    return (p.stdout or "").strip()


_OBJ = re.compile(r"\{[\s\S]*\}")
_ARR = re.compile(r"\[[\s\S]*\]")


def parse_json(raw: str, want_list: bool = False):
    """모델 출력에서 JSON 만 건져낸다. 작은 로컬 모델은 설명을 덧붙이는 일이 잦다."""
    m = (_ARR if want_list else _OBJ).search(str(raw or ""))
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except ValueError:
        # 흔한 깨짐 하나만 보정한다: 마지막 항목 뒤 쉼표.
        try:
            return json.loads(re.sub(r",(\s*[\]}])", r"\1", m.group(0)))
        except ValueError:
            return None
