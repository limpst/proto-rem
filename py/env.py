"""의존성 없는 .env 로더.

os.environ 이 항상 우선한다 (PORT=8787 python -m py.server 같은 실행 시점 지정을 살리기 위해).
파일은 한 번만 읽어 캐시한다. Node 판 src/env.mjs 와 같은 규칙.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

from . import paths

ROOT = Path(__file__).resolve().parent.parent
_LINE = re.compile(r"^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$")


def env_file() -> Path:
    """.env 가 실제로 놓이는 자리.

    영구 디스크를 쓰는 배포 환경에서는 그쪽에 둔다. 저장소 폴더에 두면
    ⚙ 설정 화면에서 넣은 API 키·앱 비밀번호가 재배포마다 사라져,
    매번 다시 넣어야 한다.

    영구 자리에 아직 파일이 없고 저장소 쪽에만 있으면 한 번 옮겨 이어받는다.
    영구 자리를 쓰지 않는 환경(로컬 개발)에서는 지금까지처럼 저장소 루트를 쓴다.
    """
    if not paths.PERSISTENT:
        return ROOT / ".env"
    p = paths.STATE / ".env"
    old = ROOT / ".env"
    if not p.exists() and old.exists():
        try:
            p.write_text(old.read_text(encoding="utf-8"), encoding="utf-8")
        except OSError:
            return old            # 옮기지 못하면 원래 자리를 그대로 쓴다
    return p
_cache: dict[str, str] | None = None


def _load() -> dict[str, str]:
    global _cache
    if _cache is not None:
        return _cache
    _cache = {}
    f = env_file()
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


# ─────────────────────────────────────────────────────────────────────────
# 관리자 설정 화면(⚙)용 — .env 를 읽고 쓴다.
#
# 이 서버에는 로그인이 없다. 그래서 비밀값은 기본적으로 가려서 내보내고,
# 관리자가 명시적으로 요청할 때만 원문을 준다. 공용망에 열어두지 말 것.
# ─────────────────────────────────────────────────────────────────────────

#: 각 변수가 무슨 뜻이고 업무상 무엇을 바꾸는지. 화면에 그대로 보여준다.
ENV_SPEC = [
    {
        "key": "GMAIL_USER", "group": "메일 발송", "label": "보내는 사람 주소",
        "secret": False, "placeholder": "yourname@gmail.com",
        "what": "영업 메일이 나갈 때 '보낸사람'으로 찍히는 지메일 주소입니다.",
        "why": "받는 분이 답장하면 이 주소로 옵니다. 회신을 실제로 확인하는 주소를 넣으세요.",
    },
    {
        "key": "GMAIL_APP_PASSWORD", "group": "메일 발송", "label": "앱 비밀번호 (16자리)",
        "secret": True, "placeholder": "abcdefghijklmnop",
        "what": "구글이 프로그램 전용으로 발급하는 16자리 비밀번호입니다.",
        "why": "구글 계정 비밀번호나 2단계 인증 백업 코드는 여기서 작동하지 않습니다. "
               "구글 계정 > 보안 > 2단계 인증 > 앱 비밀번호 에서 새로 발급하세요.",
    },
    {
        "key": "GMAIL_FROM_NAME", "group": "메일 발송", "label": "보내는 사람 이름",
        "secret": False, "placeholder": "에이톰엔지니어링",
        "what": "받는 분의 메일함에 표시되는 이름입니다.",
        "why": "'atom@...' 대신 '에이톰엔지니어링'으로 보이면 열람률이 올라갑니다.",
    },
    {
        "key": "DRY_RUN", "group": "메일 발송", "label": "연습 모드", "type": "bool",
        "secret": False, "placeholder": "1",
        "what": "1이면 보내는 척만 하고 실제로는 나가지 않습니다. 0이면 진짜로 발송합니다.",
        "why": "⚠ 0으로 바꾸는 순간부터 실제 메일이 나갑니다. 실전 캠페인 직전에만 0으로 두세요.",
    },
    {
        "key": "TEST_REDIRECT_TO", "group": "메일 발송", "label": "테스트 수신 주소",
        "secret": False, "placeholder": "me@example.com",
        "what": "여기에 주소를 넣으면 모든 메일이 진짜 수신자 대신 이 주소로만 갑니다. "
                "원래 수신자는 제목과 본문 머리에 남습니다.",
        "why": "⚠ 실전 발송 전에는 반드시 비우세요. 비우지 않으면 고객에게 한 통도 가지 않습니다.",
    },
    {
        "key": "ALLOW_NIGHT_SEND", "group": "메일 발송", "label": "야간 발송 허용", "type": "bool",
        "secret": False, "placeholder": "0",
        "what": "1이면 밤 9시~아침 8시에도 발송합니다. 비워두면 그 시간대는 차단됩니다.",
        "why": "정보통신망법상 광고성 정보의 야간 전송은 제한됩니다. "
               "본인 주소로 테스트할 때만 잠깐 1로 두고, 실제 캠페인 전에 반드시 되돌리세요.",
    },
    {
        "key": "LLM_BACKEND", "group": "AI", "label": "AI 백엔드",
        "secret": False, "placeholder": "claude-api",
        "what": "메일 문구를 쓰는 AI 를 무엇으로 할지 고릅니다. "
                "claude-api(인터넷·빠름) / claude-cli(내 PC의 Claude Code) / ollama(로컬 모델).",
        "why": "비워두면 자동으로 고릅니다. 배포 서버에는 Claude Code 가 없으므로 claude-api 로 두세요.",
    },
    {
        "key": "ANTHROPIC_API_KEY", "group": "AI", "label": "Anthropic API 키",
        "secret": True, "placeholder": "sk-ant-api03-...",
        "what": "claude-api 를 쓸 때 필요한 열쇠입니다. console.anthropic.com 에서 발급합니다.",
        "why": "이 키가 있어야 홈페이지 분석·고객군 분류·문구 생성이 전부 동작합니다. "
               "사용한 만큼 요금이 부과되며, 노출되면 즉시 폐기하고 새로 발급하세요.",
    },
    {
        "key": "LLM_STEP_TIMEOUT_SEC", "group": "AI", "label": "백엔드 전환 대기 시간(초)",
        "secret": False, "placeholder": "150",
        "what": "AI 한 곳에 최대 몇 초까지 기다릴지입니다. 넘기면 실패로 보고 다음 AI 로 넘어갑니다.",
        "why": "로컬 모델은 한 건에 5분이 넘기도 합니다. 무한정 기다리면 화면이 먼저 끊겨 "
               "'그냥 안 된다'로만 보입니다. 짧게 잡으면 빠른 AI 로 일찍 넘어가고, "
               "길게 잡으면 로컬에서 끝까지 시도합니다.",
    },
    {
        "key": "OLLAMA_MODEL", "group": "AI", "label": "Ollama 모델",
        "secret": False, "placeholder": "exaone3.5:7.8b",
        "what": "로컬 AI 를 쓸 때 어떤 모델을 쓸지 지정합니다.",
        "why": "이름에 -cloud 가 붙은 모델은 로컬이 아니라 외부로 전송됩니다. "
               "명함 정보를 PC 밖으로 내보내지 않으려면 -cloud 가 없는 모델을 쓰세요.",
    },
    {
        "key": "OLLAMA_NUM_PREDICT", "group": "AI", "label": "생성 길이 상한",
        "secret": False, "placeholder": "500",
        "what": "로컬 모델이 한 번에 만들 수 있는 글자 수 상한입니다.",
        "why": "크게 잡으면 문장이 길어지지만 생성 시간도 같이 늘어납니다.",
    },
    {
        "key": "OLLAMA_KEEP_ALIVE", "group": "AI", "label": "모델 상주 시간",
        "secret": False, "placeholder": "30m",
        "what": "로컬 모델을 메모리에 얼마나 붙잡아 둘지입니다.",
        "why": "짧으면 호출 사이에 모델이 내려가 다음 호출에 재로딩(수 분)이 붙습니다.",
    },
    {
        "key": "PORT", "group": "서버", "label": "접속 포트",
        "secret": False, "placeholder": "5173",
        "what": "이 화면의 주소 뒤에 붙는 번호입니다 (localhost:5173).",
        "why": "다른 프로그램과 겹칠 때만 바꾸세요. 바꾸면 서버를 다시 켜야 합니다.",
    },
    {
        "key": "TENANT_ID", "group": "서버", "label": "테넌트 ID",
        "secret": False, "placeholder": "atom-eng",
        "what": "데이터를 구분하는 칸 이름입니다. 회사가 여럿일 때 서로 섞이지 않게 합니다.",
        "why": "바꾸면 빈 데이터로 시작합니다. 기존 명함은 이전 값에 그대로 남아 있습니다.",
    },
]

_MASK = "••••••••"


def read_env_file() -> dict[str, str]:
    """.env 원문을 키-값으로 읽는다 (캐시를 거치지 않는다)."""
    out: dict[str, str] = {}
    f = env_file()
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.lstrip().startswith("#"):
                continue
            m = _LINE.match(line)
            if m:
                out[m.group(1)] = m.group(2).strip("\"'")
    return out


def settings_view(reveal: bool = False) -> list[dict]:
    """설정 화면에 내려보낼 목록. 비밀값은 reveal=True 일 때만 원문을 준다."""
    cur = read_env_file()
    known = {s["key"] for s in ENV_SPEC}
    items = []

    for spec in ENV_SPEC:
        raw = cur.get(spec["key"], "")
        items.append({
            **spec,
            "value": (_MASK if (raw and spec.get("secret") and not reveal) else raw),
            "set": bool(raw),
            "fromOsEnv": spec["key"] in os.environ,
        })

    # .env 에 있지만 우리가 모르는 키도 숨기지 않는다. 관리자가 직접 넣은 것일 수 있다.
    for k, v in cur.items():
        if k in known:
            continue
        items.append({
            "key": k, "group": "기타", "label": k, "secret": False,
            "what": "이 프로그램이 정의하지 않은 항목입니다.", "why": "직접 추가하신 값으로 보입니다.",
            "value": v, "set": bool(v), "fromOsEnv": k in os.environ,
        })
    return items


def write_env(updates: dict[str, str]) -> dict:
    """.env 를 갱신한다. 주석과 순서는 최대한 보존하고, 없던 키는 끝에 덧붙인다.

    값이 마스킹 문자열 그대로 오면 '바꾸지 않음' 으로 본다.
    빈 문자열이 오면 해당 줄을 지운다(기본값으로 되돌리기).
    """
    global _cache
    f = env_file()
    lines = f.read_text(encoding="utf-8").splitlines() if f.exists() else []
    seen: set[str] = set()
    out: list[str] = []
    removed: list[str] = []

    for line in lines:
        m = _LINE.match(line)
        if not m or line.lstrip().startswith("#"):
            out.append(line)
            continue
        k = m.group(1)
        if k not in updates:
            out.append(line)
            continue
        seen.add(k)
        v = updates[k]
        if v == _MASK:            # 가려진 값을 그대로 되돌려보낸 것 — 변경 아님
            out.append(line)
        elif v == "":
            removed.append(k)     # 줄 자체를 제거한다
        else:
            out.append(f"{k}={v}")

    added = []
    for k, v in updates.items():
        if k in seen or v in ("", _MASK):
            continue
        out.append(f"{k}={v}")
        added.append(k)

    f.write_text("\n".join(out) + "\n", encoding="utf-8")
    _cache = None                 # 다음 env() 호출부터 새 값이 보이게 캐시를 버린다
    changed = [k for k in updates if k in seen and updates[k] not in ("", _MASK)]
    return {"changed": changed, "added": added, "removed": removed}
