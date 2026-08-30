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
import sys
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
_cli_available: bool | None = None


def claude_cli_exists() -> bool:
    """claude CLI 가 실제로 설치돼 있는지 확인한다.

    배포 서버(Render)에는 없다. 확인 없이 고르면 호출 시점에 가서야
    FileNotFoundError 로 터진다 — 사용자에게는 "리서치가 그냥 안 됨"으로 보인다.
    """
    global _cli_available
    if _cli_available is not None:
        return _cli_available
    try:
        p = subprocess.run(["claude", "--version"], capture_output=True,
                           timeout=8, shell=(sys.platform == "win32"))
        _cli_available = p.returncode == 0
    except Exception:
        _cli_available = False
    return _cli_available

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


WHY = {
    "ollama": "Ollama 가 응답하지 않습니다 (ollama serve 실행 필요)",
    "claude-api": "ANTHROPIC_API_KEY 가 없습니다",
    "claude-cli": "이 서버에 Claude Code CLI 가 설치돼 있지 않습니다",
}


def usable(name: str) -> bool:
    """그 백엔드를 **지금 실제로 호출할 수 있는지** 확인한다.

    설정이 있다는 것과 쓸 수 있다는 것은 다르다. 이 구분이 없어서
    배포 서버가 LLM_BACKEND=claude-cli 를 붙들고 매번 호출 시점에 터졌다.
    """
    if name == "ollama":
        return ollama_alive()
    if name == "claude-api":
        return bool(env("ANTHROPIC_API_KEY"))
    if name == "claude-cli":
        return claude_cli_exists()
    return False


def _make(name: str, source: str, picked: str | None = None, note: str | None = None) -> dict:
    if name == "ollama":
        model = picked or DEFAULT_OLLAMA_MODEL
        b = {"name": "ollama", "model": model, "url": OLLAMA_URL, "source": source,
             "alive": True, "cloud": is_cloud_model(model)}
    else:
        b = {"name": name, "model": CLAUDE_MODEL, "source": source, "cloud": True}
    if note:
        b["note"] = note
    return b


def resolve_backend(refresh: bool = False) -> dict:
    """어떤 백엔드가 실제로 쓰이는지. 대시보드가 이 값을 표시한다.

    고르는 순서:
      ① 지정된 것(대시보드 선택 > LLM_BACKEND)을 먼저 본다.
      ② 그게 **실제로 호출 가능**하면 그대로 쓴다.
      ③ 불가능하면 쓸 수 있는 것으로 자동 대체하고, 왜 바꿨는지 note 를 남긴다.
      ④ 아무것도 없으면 name='none' 으로 정직하게 멈춘다. 호출 시점에 터지게 두지 않는다.
    """
    global _cached_backend, _cached_override
    if refresh:
        _cached_backend = None
        _cached_override = "unread"
    if _cached_backend:
        return _cached_backend

    ov = _override() or {}
    wanted = ov.get("name") or env("LLM_BACKEND")
    picked = ov.get("model")
    source = "dashboard" if ov.get("name") else ("env" if env("LLM_BACKEND") else "auto")

    if wanted and usable(wanted):
        _cached_backend = _make(wanted, source, picked)
        return _cached_backend

    # 지정된 것을 못 쓴다 → 쓸 수 있는 것으로 대체한다.
    for cand in ("ollama", "claude-api", "claude-cli"):
        if not usable(cand):
            continue
        note = None
        if wanted:
            note = (f"{wanted} 로 지정돼 있지만 {WHY.get(wanted, '사용할 수 없어')} "
                    f"{cand} 로 대체했습니다.")
            L.log("warn", "llm", note)
        _cached_backend = _make(cand, source if not wanted else "fallback",
                                picked if cand == "ollama" else None, note)
        return _cached_backend

    # 셋 다 없다. 예전에는 claude-cli 로 넘어가 배포 서버에서 "spawn claude ENOENT" 로 터졌다.
    _cached_backend = {
        "name": "none", "model": None, "source": source, "cloud": False,
        "hint": ((f"{wanted} 로 지정돼 있는데 {WHY.get(wanted, '사용할 수 없습니다')}. " if wanted else "")
                 + "쓸 수 있는 AI 백엔드가 없습니다. 배포 환경이라면 Render > Environment 에 "
                   "ANTHROPIC_API_KEY 를 넣고 LLM_BACKEND=claude-api 로 두세요. "
                   "내 컴퓨터라면 Ollama 를 실행하세요."),
    }
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


def _run(name: str, model: str | None, prompt: str,
         max_tokens: int | None, temperature: float | None) -> str:
    if name == "ollama":
        return _via_ollama(prompt, model or DEFAULT_OLLAMA_MODEL, max_tokens, temperature)
    if name == "claude-api":
        return _via_api(prompt, max_tokens or 1500)
    if name == "claude-cli":
        return _via_cli(prompt)
    raise RuntimeError("AI 백엔드가 설정되지 않았습니다.")


def _usable_backends() -> list[tuple[str, str | None]]:
    """지금 실제로 쓸 수 있는 백엔드를 선호 순서로 돌려준다.

    claude-api 가 앞에 온다. 로컬 모델은 CPU 에서 한 건에 수 분이 걸려
    화면이 먼저 끊기는 일이 잦기 때문이다. 키가 없으면 자연히 건너뛴다.
    """
    out: list[tuple[str, str | None]] = []
    if env("ANTHROPIC_API_KEY"):
        out.append(("claude-api", CLAUDE_MODEL))
    if ollama_alive():
        out.append(("ollama", (_override() or {}).get("model") or DEFAULT_OLLAMA_MODEL))
    if claude_cli_exists():
        out.append(("claude-cli", CLAUDE_MODEL))
    return out


def complete(prompt: str, max_tokens: int | None = None, temperature: float | None = None) -> str:
    """지정된 백엔드로 먼저 시도하고, 실패하면 쓸 수 있는 다른 백엔드로 넘어간다.

    로컬 모델 타임아웃이나 API 오류 하나로 파이프라인 전체가 멈추면
    사용자는 "메일 만들기가 안 된다" 로만 겪는다. 대체 경로를 두고,
    무엇으로 대체했는지는 로그에 남겨 숨기지 않는다.
    """
    b = resolve_backend()
    chain: list[tuple[str, str | None]] = []
    if b["name"] != "none":
        chain.append((b["name"], b.get("model")))
    for cand in _usable_backends():
        if cand[0] != b["name"]:
            chain.append(cand)

    if not chain:
        raise RuntimeError(b.get("hint") or "AI 백엔드가 설정되지 않았습니다.")

    errors: list[str] = []
    for i, (name, model) in enumerate(chain):
        t0 = time.time()
        if i:
            L.log("warn", "llm", f"대체 백엔드로 재시도 → {name} / {model}",
                  {"이전실패": errors[-1][:120]})
        L.log("ai", "llm", f"요청 → {name} / {model}",
              {"prompt": len(prompt), "cloud": name != "ollama" or is_cloud_model(model)})
        try:
            out = _run(name, model, prompt, max_tokens, temperature)
        except Exception as e:
            msg = f"{name}: {e}"
            errors.append(msg)
            L.log("error", "llm", f"실패 — {msg}", {"ms": int((time.time() - t0) * 1000)})
            continue
        L.log("ok", "llm", "응답 수신",
              {"chars": len(out), "ms": int((time.time() - t0) * 1000),
               "backend": name, "fallback": bool(i)})
        return out

    raise RuntimeError("모든 AI 백엔드가 실패했습니다 — " + " / ".join(errors))


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
    # 한 백엔드에 얼마나 기다릴지. 이 시간을 넘기면 실패로 보고 다음 백엔드로 넘어간다.
    # 무한정 기다리면 화면이 먼저 끊기고, 사용자는 "그냥 안 된다" 로만 겪는다.
    timeout = env_int("LLM_STEP_TIMEOUT_SEC", 150)
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
        with urllib.request.urlopen(req, timeout=env_int("LLM_STEP_TIMEOUT_SEC", 150)) as r:
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
                shell=(sys.platform == "win32"),
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
        # 여는 [ 가 아예 없는 응답도 온다. 객체만 줄줄이 나열하는 경우다.
        return _salvage_objects(raw) if want_list else None
    try:
        return json.loads(m.group(0))
    except ValueError:
        # 흔한 깨짐 하나만 보정한다: 마지막 항목 뒤 쉼표.
        try:
            return json.loads(re.sub(r",(\s*[\]}])", r"\1", m.group(0)))
        except ValueError:
            pass
    return _salvage_objects(raw) if want_list else None


def _salvage_objects(raw: str):
    """대괄호가 없거나 끝이 잘린 응답에서 성한 객체만 건져낸다.

    문구 추천에서 실제로 매번 이런 응답이 온다:
        ```json
          {"kind":"subject","text":"..."},
          {"kind":"subject","text":"..."},
          {"kind":"subject","tone":"calm"        <- 여기서 잘림
    여는 [ 가 없고 마지막 객체가 미완성이라 통째로 파싱에 실패했고,
    그래서 AI 가 만든 문구를 전부 버리고 규칙 폴백으로 떨어졌다(source=rule).
    중괄호 짝을 세어 완성된 객체만 골라내면 앞의 것들은 그대로 쓸 수 있다.
    문자열 안의 중괄호와 이스케이프를 건너뛰어야 짝이 어긋나지 않는다.
    """
    text = str(raw or "")
    out, depth, start, in_str, esc = [], 0, -1, False, False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    try:
                        v = json.loads(text[start:i + 1])
                        if isinstance(v, dict):
                            out.append(v)
                    except ValueError:
                        pass
                    start = -1
    return out or None
