"""STEP 3 리서치 — 대상 회사 홈페이지를 읽어 메시지 근거가 될 사실을 뽑는다.

홈페이지가 없거나 크롤 실패 시 명함 메모를 근거로 폴백한다. (근거가 없으면 생성 금지)
자사(에이톰) 홈페이지도 똑같이 읽어서, 하드코딩된 서비스 목록이 홈페이지 개편으로
낡는 것을 막고 생성 프롬프트가 "실제로 홈페이지에 적힌 역량"만 인용하게 한다.
"""
from __future__ import annotations

import gzip
import json
import re
import urllib.request
from pathlib import Path

from . import llm
from . import log as L
from .domain import COMPANY

ROOT = Path(__file__).resolve().parent.parent
UA = "Mozilla/5.0 (compatible; proto-rem/0.2; +research)"

_TAG = re.compile(r"<[^>]+>")
_SCRIPT = re.compile(r"<(script|style)[\s\S]*?</\1>", re.I)
_WS = re.compile(r"\s+")


_SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://")


def normalize_url(u: str | None) -> str:
    """스킴 없는 주소를 https:// 로 채운다.

    명함·붙여넣기에서는 "atom-eng.co.kr" 처럼 스킴 없이 들어오는 쪽이 오히려 흔하다.
    그대로 urlopen 에 넘기면 `unknown url type` 으로 무조건 실패해,
    화면에는 "읽기 실패"만 뜨고 왜 실패했는지는 알 수 없다.
    http/https 가 아닌 스킴(file: 등)은 읽지 않는다.
    """
    u = (u or "").strip()
    if not u:
        return ""
    if not _SCHEME.match(u):
        u = "https://" + u
    return u if u.lower().startswith(("http://", "https://")) else ""


def fetch_site(url: str | None) -> dict:
    url = normalize_url(url)
    if not url:
        return {"ok": False, "reason": "no-url", "text": ""}
    try:
        req = urllib.request.Request(url, headers={"user-agent": UA, "accept-encoding": "gzip"})
        with urllib.request.urlopen(req, timeout=15) as r:
            if r.status != 200:
                return {"ok": False, "reason": f"http-{r.status}", "text": ""}
            raw = r.read()
            if (r.headers.get("content-encoding") or "").lower() == "gzip":
                raw = gzip.decompress(raw)
            charset = r.headers.get_content_charset() or "utf-8"
            html = raw.decode(charset, "replace")
    except Exception as e:
        L.log("warn", "enrich", f"홈페이지 읽기 실패 {url} — {e}")
        return {"ok": False, "reason": str(e), "text": ""}

    text = _WS.sub(" ", _TAG.sub(" ", _SCRIPT.sub(" ", html)).replace("&nbsp;", " ")).strip()
    L.log("net", "enrich", f"홈페이지 읽음 {url}", {"chars": len(text)})
    return {"ok": True, "reason": "ok", "text": text[:12000]}


def _extract_prompt(card: dict, site_text: str) -> str:
    return f"""너는 건축물 안전진단 영업을 위한 리서치 애널리스트다.
아래 회사 정보와 홈페이지 본문에서, 건축물 안전관리 수요와 직결되는 사실만 뽑아라.

회사: {card.get('company', '')}
담당자: {card.get('name', '')} {card.get('title', '')}
명함 메모: {card.get('note') or '(없음)'}

홈페이지 본문:
\"\"\"
{site_text or '(홈페이지 정보 없음 — 명함 메모만으로 판단)'}
\"\"\"

다음 JSON만 출력하라. 설명 문장 금지.
{{
  "facts": ["홈페이지에서 확인된 구체적 사실 2~4개. 추측 금지. 근거 없으면 빈 배열."],
  "building_signals": {{"types": ["건물/시설 유형"], "scale": "규모 단서 또는 unknown", "age_hint": "준공/설립 연도 단서 또는 unknown"}},
  "confidence": "high | medium | low"
}}"""


def extract_signals(card: dict, site_text: str) -> dict:
    try:
        raw = llm.complete(_extract_prompt(card, site_text), max_tokens=600)
    except Exception as e:
        return {"facts": [], "building_signals": {}, "confidence": "low", "_error": str(e)}
    parsed = llm.parse_json(raw)
    if not isinstance(parsed, dict):
        return {"facts": [], "building_signals": {}, "confidence": "low", "_raw": str(raw)[:600]}
    parsed.setdefault("facts", [])
    parsed.setdefault("building_signals", {})
    parsed.setdefault("confidence", "low")
    return parsed


def build_source_profile(force: bool = False) -> dict:
    """source(발신 자사) 홈페이지를 target 과 똑같이 읽어 인용 가능한 역량을 캐시한다."""
    cache = ROOT / "data" / "source-profile.json"
    if not force and cache.exists():
        try:
            return json.loads(cache.read_text(encoding="utf-8"))
        except ValueError:
            pass

    site = fetch_site(COMPANY["site"])
    prompt = f"""아래는 {COMPANY['name']} 홈페이지 본문이다. 영업 메시지에 인용할 수 있는 사실만 뽑아라.

\"\"\"
{site['text'] or '(수집 실패)'}
\"\"\"

다음 JSON만 출력하라.
{{
  "services": ["홈페이지에 명시된 서비스명"],
  "credentials": ["지정/인증/평가등급 등 공신력 근거"],
  "proof_points": ["업력, 실적 건수 등 숫자 근거"],
  "reference_projects": [{{"client":"발주처/건물명","service":"수행 서비스"}}]
}}"""

    parsed = None
    if site["ok"]:
        try:
            parsed = llm.parse_json(llm.complete(prompt, max_tokens=900))
        except Exception as e:
            L.log("warn", "enrich", f"자사 프로파일 추출 실패 — {e}")

    from datetime import datetime, timezone
    profile = {
        "site": COMPANY["site"],
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "fetch": {"ok": site["ok"], "reason": site["reason"], "chars": len(site["text"])},
        **(parsed if isinstance(parsed, dict) else {
            "services": COMPANY["services"],
            "credentials": [COMPANY["tagline"], COMPANY["grade"]],
            "proof_points": [f"업력 {COMPANY['years']}년", f"누적 진단 {COMPANY['projects']}건"],
            "reference_projects": [],
        }),
    }
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")
    return profile
