"""문구 스튜디오 — 키워드 몇 개만 고르면 광고 문구 수십 개를 뽑아 준다.

왜 이 단계가 따로 있나:
  메일 한 통을 통째로 생성하면 마음에 안 들 때 "어디가 마음에 안 드는지"를 말할 수가 없다.
  그래서 **문구 단위**로 먼저 고르게 한다. 담당자는 제목·첫 문장·클로징을 각각 몇 개 찜하고,
  그 선택이 STEP 5 본문 생성 프롬프트에 그대로 얹힌다. (generate._copy_block)

재료 (많을수록 문구가 뾰족해진다):
  ① 명함        — 직함·부서에서 그 사람의 업무 책임을 읽는다
  ② 홈페이지 리서치 — STEP 3 에서 뽑은 그 회사의 사실
  ③ 관심사 추정  — classify_ai.infer_interests
  ④ 고객군 통증·법정 트리거 — domain.SEGMENTS
  ⑤ 에이톰의 강점 — COMPANY + 자사 홈페이지 프로파일

AI 가 느리거나 죽어도 화면이 비지 않도록 규칙 기반 폴백을 같이 둔다.
"""
from __future__ import annotations

import re

from . import llm
from . import log as L
from .domain import COMPANY, SEGMENTS, persona
from .domain import segment as seg_of

# 문구 종류 — 화면에서 그룹으로 묶어 보여준다.
KINDS = [
    {"id": "subject", "label": "메일 제목", "hint": "열어보게 만드는 한 줄"},
    {"id": "hook", "label": "첫 문장", "hint": "3초 안에 '내 얘기'라고 느끼게"},
    {"id": "value", "label": "핵심 가치", "hint": "무엇이 좋아지는가"},
    {"id": "proof", "label": "신뢰 근거", "hint": "왜 에이톰인가"},
    {"id": "cta", "label": "행동 유도", "hint": "다음 한 걸음"},
    {"id": "ps", "label": "추신", "hint": "부담 없이 한 번 더 찌르기"},
]

# 톤 — 사람이 고르는 축. 같은 내용도 톤에 따라 반응이 갈린다.
TONES = [
    {"id": "calm", "label": "담백하게", "desc": "정보 전달 위주. 영업 냄새 최소"},
    {"id": "urgent", "label": "시점을 짚어", "desc": "도래 시점·주기를 앞세움"},
    {"id": "risk", "label": "리스크 중심", "desc": "놓쳤을 때 생기는 일"},
    {"id": "benefit", "label": "이득 중심", "desc": "비용·시간이 얼마나 줄어드는가"},
    {"id": "peer", "label": "동종사 사례", "desc": "같은 업종은 이렇게 합니다"},
    {"id": "question", "label": "질문형", "desc": "묻고 답을 유도"},
]

# 에이톰 강점 — 문구가 인용할 수 있는 화이트리스트. 여기 없는 자랑은 만들지 않는다.
def strengths(source_profile: dict | None = None) -> list[str]:
    out = [
        COMPANY["tagline"],
        COMPANY["grade"],
        f"업력 {COMPANY['years']}년",
        f"누적 진단 {COMPANY['projects']}건",
        "드론 활용 고소 점검",
        "해체계획서~감리 원스톱",
        "구조설계·구조감리 자체 수행",
    ]
    for c in (source_profile or {}).get("credentials") or []:
        if c and c not in out:
            out.append(str(c))
    for pp in (source_profile or {}).get("proof_points") or []:
        if pp and pp not in out:
            out.append(str(pp))
    return out[:12]


def keyword_palette(card: dict | None, segment: dict | None, source_profile: dict | None = None) -> list[dict]:
    """고를 수 있는 키워드 칩. LLM 없이 즉시 만든다 (화면이 기다리지 않게).

    고객군이 정해져 있으면 그 고객군의 통증·트리거가 팔레트 맨 앞에 온다.
    """
    interests = (card or {}).get("interests") or {}
    facts = ((card or {}).get("signals") or {}).get("facts") or []

    pain: list[str] = []
    if segment:
        pain += [p.strip() for p in re.split(r"[,·/]", segment["pain"]) if len(p.strip()) > 3][:4]
        pain += [t.strip() for t in re.split(r"[,·/]", segment["trigger"]) if len(t.strip()) > 3][:3]
    pain += ["지하주차장 균열·누수", "노후 철골 처짐·부식", "점검 주기 누락", "중대재해처벌법 대응",
             "예산 편성 시점", "영업/가동 중단 부담"]

    benefit = ["영업 중단 없이 점검", "동별 점검 로드맵", "연간 점검 캘린더", "예산 산정 근거 확보",
               "발주 누락 방지", "사전조사로 분쟁 예방", "고소작업 없이 드론으로", "보고서 표지만으로 검토"]

    cta = ["무상 검토 받아보기", "보고서 표지 1장만 회신", "건물 목록만 주시면 작성", "짧게 통화 15분",
           "현장 방문 일정 협의", "샘플 로드맵 보기", "회신 한 줄이면 충분"]

    groups = [
        {"id": "interest", "label": "이 사람의 관심사", "note": "AI 추정 — 확인 후 쓰세요",
         "items": (interests.get("interests") or [])[:5] + ([interests["hot_button"]] if interests.get("hot_button") else [])},
        {"id": "fact", "label": "홈페이지에서 확인된 사실", "note": "STEP 3 리서치 결과",
         "items": [str(f)[:40] for f in facts][:5]},
        {"id": "pain", "label": "통증 · 법정 트리거", "note": "고객군에서 파생",
         "items": _uniq(pain)[:10]},
        {"id": "benefit", "label": "이익 · 소구점", "note": "무엇이 좋아지는가",
         "items": benefit},
        {"id": "proof", "label": "에이톰 강점", "note": "여기 없는 자랑은 만들지 않습니다",
         "items": strengths(source_profile)},
        {"id": "cta", "label": "행동 유도", "note": "다음 한 걸음",
         "items": cta},
    ]
    return [g for g in groups if g["items"]]


def _uniq(xs):
    seen, out = set(), []
    for x in xs:
        k = str(x).strip()
        if k and k not in seen:
            seen.add(k)
            out.append(k)
    return out


def _prompt(card, segment, keywords, tone_ids, channel, count, source_profile) -> str:
    p = persona((card or {}).get("_personaId"))
    facts = ((card or {}).get("signals") or {}).get("facts") or []
    interests = (card or {}).get("interests") or {}
    tones = [t for t in TONES if t["id"] in (tone_ids or [])] or TONES[:3]
    kinds = "\n".join(f"- {k['id']} : {k['label']} — {k['hint']}" for k in KINDS)

    return f"""너는 국내 최고 수준의 B2B 광고 카피라이터다.
발신 주체는 {COMPANY['name']} — {COMPANY['tagline']}, 업력 {COMPANY['years']}년, 누적 진단 {COMPANY['projects']}건, {COMPANY['grade']}.
목표는 **읽히고, 답장이 오고, 결국 발주로 이어지는 문구**를 만드는 것이다.

# 받는 사람
이름/직함: {(card or {}).get('name', '')} {(card or {}).get('title', '')}
회사/부서: {(card or {}).get('company', '')} {(card or {}).get('dept', '')}
고객군: {segment['label'] if segment else '(미분류)'}
이 고객군의 통증: {segment['pain'] if segment else '(불명)'}
법정/수요 트리거: {segment['trigger'] if segment else '(불명)'}
첫 제안: {segment['offer'] if segment else '(불명)'}

# 이 회사 홈페이지에서 확인된 사실 (지어내지 말 것)
{chr(10).join('- ' + str(f) for f in facts) or '- (없음)'}

# 이 사람의 관심사 (AI 추정)
{', '.join(interests.get('interests') or []) or '(불명)'}
가장 먼저 반응할 지점: {interests.get('hot_button') or '(불명)'}

# 인용 가능한 에이톰 강점 (이 목록 밖의 자랑을 만들지 말 것)
{chr(10).join('- ' + s for s in strengths(source_profile))}

# 담당자가 고른 키워드 (전부 어딘가에 녹여라)
{chr(10).join('- ' + str(k) for k in (keywords or [])) or '- (선택 없음 — 위 재료에서 알아서 고를 것)'}

# 요구하는 톤
{chr(10).join(f"- {t['label']}: {t['desc']}" for t in tones)}

# 문구 종류
{kinds}

# 규칙
1. 정확히 {count}개를 만든다. 종류별로 고르게 배분한다.
2. 한 문구는 한 줄. 제목은 30자 내외, 나머지는 45자 내외.
3. 법정 점검 해당 여부를 **단정하지 않는다**. "확인해 보시길 권합니다" 같은 제안형.
4. 과장 금지("최고", "완벽", "100% 보장"). 숫자는 위 강점 목록의 숫자만 쓴다.
5. 실적·고객사를 새로 지어내지 않는다.
6. 첫 접촉이므로 견적·계약을 요구하지 않는다. 무상 제공물까지만.
7. 서로 비슷한 문구를 반복하지 말고, 각 문구가 다른 각도를 노리게 한다.

# 출력 (JSON 배열만, 설명 금지)
[
  {{"kind":"subject","tone":"calm","text":"문구","why":"이 문구가 왜 반응을 부르는지 15자 이내"}},
  ...
]"""


def _fallback(card, segment, keywords, count) -> list[dict]:
    """AI 를 못 쓸 때도 리스트가 비지 않게 한다.

    조합으로 만든 문구라 AI 만큼 날카롭지는 않다. 화면에서 '규칙 생성'으로 표시한다.
    """
    co = (card or {}).get("company") or "귀사"
    nm = (card or {}).get("name") or "담당자"
    seg_label = segment["label"] if segment else "시설 보유 기업"
    trigger = (segment or {}).get("trigger", "정기 안전점검 주기")
    offer = (segment or {}).get("offer", "무상 사전 검토")
    kws = [str(k) for k in (keywords or [])] or [trigger]

    out: list[dict] = []
    for kw in kws:
        short = kw[:24]
        out += [
            {"kind": "subject", "tone": "urgent", "text": f"{co} — {short}, 다음 도래 시점 확인해 보셨나요"},
            {"kind": "subject", "tone": "calm", "text": f"{short} 관련, 표지 1장만으로 검토해 드립니다"},
            {"kind": "hook", "tone": "peer", "text": f"{seg_label}에서 {short} 문의가 최근 늘고 있습니다."},
            {"kind": "hook", "tone": "question", "text": f"{nm}님, {short}은 지금 어느 부서가 챙기고 계신가요?"},
            {"kind": "value", "tone": "benefit", "text": f"{short} — 영업/가동 중단 없이 점검 동선을 설계합니다."},
            {"kind": "proof", "tone": "calm", "text": f"{COMPANY['grade']} · 누적 {COMPANY['projects']}건의 진단 경험."},
            {"kind": "cta", "tone": "calm", "text": f"{offer[:30]} — 회신 한 줄이면 됩니다."},
            {"kind": "ps", "tone": "risk", "text": f"추신: {short}은 놓치면 소급이 안 되는 항목입니다."},
        ]
    # 요청 개수만큼 자르되, 종류가 한쪽으로 쏠리지 않게 라운드로빈으로 섞는다.
    by_kind: dict[str, list] = {}
    for it in out:
        by_kind.setdefault(it["kind"], []).append(it)
    mixed, i = [], 0
    while len(mixed) < min(count, len(out)):
        added = False
        for k in KINDS:
            lst = by_kind.get(k["id"]) or []
            if i < len(lst):
                mixed.append(lst[i])
                added = True
                if len(mixed) >= count:
                    break
        if not added:
            break
        i += 1
    for n, it in enumerate(mixed):
        it["id"] = f"f{n}"
        it["source"] = "rule"
        it["why"] = it.get("why") or "규칙 조합"
    return mixed


def suggest(card: dict | None, segment_id: str | None, keywords: list | None = None,
            tones: list | None = None, channel: str = "email", count: int = 30,
            source_profile: dict | None = None, persona_id: str | None = None) -> dict:
    """문구 후보를 count 개 만든다.

    @return {"items":[...], "source":"ai"|"rule"|"mixed", "error": str|None}
    """
    segment = seg_of(segment_id) if segment_id else None
    card = dict(card or {})
    card["_personaId"] = persona_id
    count = max(6, min(int(count or 30), 60))

    prompt = _prompt(card, segment, keywords, tones, channel, count, source_profile)
    items, err = [], None
    try:
        # 문구는 짧지만 개수가 많다. 출력 상한을 넉넉히 준다.
        raw = llm.complete(prompt, max_tokens=min(2400, 70 * count), temperature=0.85)
        arr = llm.parse_json(raw, want_list=True)
        if isinstance(arr, list):
            valid_kinds = {k["id"] for k in KINDS}
            for n, it in enumerate(arr):
                if not isinstance(it, dict):
                    continue
                text = str(it.get("text") or "").strip()
                if not text:
                    continue
                items.append({
                    "id": f"a{n}",
                    "kind": it.get("kind") if it.get("kind") in valid_kinds else "hook",
                    "tone": str(it.get("tone") or "")[:20],
                    "text": text[:140],
                    "why": str(it.get("why") or "")[:60],
                    "source": "ai",
                })
    except Exception as e:
        err = str(e)
        L.log("warn", "copy", f"문구 생성 실패, 규칙 폴백으로 전환 — {e}")

    src = "ai"
    if len(items) < count:
        # 모자란 만큼만 규칙으로 채운다. 화면에서 어느 쪽인지 갈라 보인다.
        need = count - len(items)
        items += _fallback(card, segment, keywords, need)
        src = "rule" if not any(i["source"] == "ai" for i in items) else "mixed"

    L.log("ok", "copy", f"문구 {len(items)}개 생성", {"source": src, "segment": segment_id})
    return {"items": items[:count], "source": src, "error": err, "prompt": prompt}
