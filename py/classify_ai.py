"""AI 고객군 분류 + 고객 관심사 추정.

키워드 분류(domain.classify)는 "백화점", "대학" 처럼 회사명에 업종이 드러날 때만 맞는다.
"노바엣지테크놀로지", "MEISTER TRADING" 같은 이름은 규칙으로는 아무것도 알 수 없다.
그래서 키워드가 놓친 건에 한해 LLM 에게 물어본다.

원칙:
  - 7개 고객군 중에서만 고르게 한다. 새 분류를 만들지 못한다.
  - 확신이 없으면 unclassified 를 돌려주게 한다. 억지로 배정하면 엉뚱한 메일이 나간다.
  - 결과에는 근거와 확신도를 함께 받아 화면에 표시한다. 사람이 STEP 4 에서 뒤집을 수 있어야 한다.
"""
from __future__ import annotations

import re

from . import llm
from .domain import SEGMENTS

VALID = {s["id"] for s in SEGMENTS} | {"unclassified"}


def _domain_of(email: str | None) -> str:
    m = re.search(r"@([^@\s]+)$", str(email or ""))
    return m.group(1) if m else ""


def _prompt(card: dict) -> str:
    segs = "\n".join(f"- {s['id']} : {s['label']} — {s['pain']}" for s in SEGMENTS)
    return f"""너는 B2B 영업 데이터 애널리스트다. 아래 명함 한 장을 보고
㈜에이톰엔지니어링(건축물 안전진단 전문기관)의 고객군 중 어디에 속하는지 판단하라.

# 명함
회사: {card.get('company', '')}
이름: {card.get('name', '')}
직함: {card.get('title', '')}
부서: {card.get('dept', '')}
이메일 도메인: {_domain_of(card.get('email')) or '(없음)'}
메모: {card.get('note') or '(없음)'}

# 고를 수 있는 고객군 (이 목록 밖을 만들지 말 것)
{segs}
- unclassified : 위 어디에도 해당하지 않거나, 근거가 부족해 판단할 수 없음

# 판단 규칙
1. 회사가 **건물·시설을 보유하거나 운영하는 쪽**인지가 핵심이다.
   소프트웨어 회사, 금융 트레이딩 회사처럼 시설 수요가 뚜렷하지 않으면 unclassified 로 둔다.
2. 회사명만으로 업종을 모르겠으면 억지로 배정하지 말고 unclassified 를 고른다.
   틀린 분류는 엉뚱한 내용의 메일로 이어진다.
3. 확신도(confidence)를 정직하게 매긴다. high 는 업종이 명확할 때만.

# 출력 (JSON 만, 설명 금지)
{{"segmentId":"...","confidence":"high|medium|low","reason":"한 문장 근거"}}"""


def classify_one(card: dict) -> dict:
    """명함 한 장을 AI 로 분류한다. 실패하면 unclassified."""
    try:
        r = llm.parse_json(llm.complete(_prompt(card), max_tokens=300))
    except Exception as e:
        return {"segmentId": "unclassified", "confidence": "low", "reason": f"AI 호출 실패: {e}"}
    if not isinstance(r, dict):
        return {"segmentId": "unclassified", "confidence": "low", "reason": "AI 응답을 해석하지 못했습니다"}
    sid = r.get("segmentId") if r.get("segmentId") in VALID else "unclassified"
    conf = r.get("confidence") if r.get("confidence") in ("high", "medium", "low") else "low"
    return {"segmentId": sid, "confidence": conf, "reason": str(r.get("reason") or "")[:200]}


def infer_interests(card: dict, signals: dict | None, segment: dict | None) -> dict:
    """고객 **관심사**를 추정한다 — 문구를 그 사람 쪽으로 겨누기 위한 재료.

    명함(직함·부서)과 홈페이지 리서치 결과를 근거로,
    "이 사람이 무엇 때문에 골치가 아플지"를 추정한다. 추정임을 화면에 밝히고 쓴다.
    """
    facts = (signals or {}).get("facts") or []
    seg_line = f"{segment['label']} / 통증: {segment['pain']}" if segment else "(미분류)"
    prompt = f"""너는 B2B 영업 리서처다. 아래 인물이 **지금 무엇에 관심이 있을지** 추정하라.
발신자는 ㈜에이톰엔지니어링(건축물 안전진단 전문기관)이고, 이 추정은 그에게 보낼
메일의 첫 문장을 정하는 데 쓰인다.

# 인물
이름: {card.get('name', '')} / 직함: {card.get('title', '')} / 부서: {card.get('dept', '')}
회사: {card.get('company', '')}
고객군: {seg_line}

# 이 회사 홈페이지에서 확인된 사실
{chr(10).join('- ' + str(f) for f in facts) or '- (없음)'}

# 규칙
1. 직함에서 읽히는 **업무 책임**을 근거로 삼는다. (예: 시설팀장 → 점검 일정과 예산)
2. 확인된 사실이 없으면 추측을 부풀리지 말고 general 로 표시한다.
3. 한국어로, 각 항목 20자 이내.

# 출력 (JSON 만)
{{
  "interests": ["이 사람의 관심사 3개"],
  "hot_button": "가장 먼저 반응할 한 가지",
  "avoid": "이 사람에게 하면 역효과인 말 한 가지",
  "confidence": "high|medium|low"
}}"""
    try:
        r = llm.parse_json(llm.complete(prompt, max_tokens=400))
    except Exception as e:
        return {"interests": [], "hot_button": "", "avoid": "", "confidence": "low", "error": str(e)}
    if not isinstance(r, dict):
        return {"interests": [], "hot_button": "", "avoid": "", "confidence": "low"}
    return {
        "interests": [str(x)[:40] for x in (r.get("interests") or [])][:5],
        "hot_button": str(r.get("hot_button") or "")[:80],
        "avoid": str(r.get("avoid") or "")[:80],
        "confidence": r.get("confidence") if r.get("confidence") in ("high", "medium", "low") else "low",
    }
