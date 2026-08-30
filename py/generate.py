"""STEP 5 생성.

  1:1 모드 — 수신자 회사 홈페이지 근거를 인용한 개별 문안
  1:N 모드 — 고객군 공통 문안 1건 + 수신자별 병합필드 치환

공통 규칙: 근거 없는 문장 금지, 실적은 화이트리스트에서만 인용,
          첫 접촉은 무상 제공물로 마무리, 컴플라이언스는 코드가 강제.

build_prompt / build_segment_prompt 는 대시보드가 프롬프트 원문을 그대로 보여줄 수 있도록
공개한다. 프롬프트가 곧 이 제품의 로직이므로 사용자가 읽고 고칠 수 있어야 한다.
"""
from __future__ import annotations

import json
import re

from . import llm
from .domain import COMPANY, persona, segment as seg_of
from .schema import facility_facts

CHANNEL_SPEC = {
    "email": {"label": "이메일", "limit": "제목 1줄 + 본문 250~400자", "extra": "제목은 반드시 \"(광고)\"로 시작"},
    "sms": {"label": "문자(LMS)", "limit": "250자 이내",
            "extra": "첫 줄에 \"(광고) ㈜에이톰엔지니어링\", 마지막 줄에 무료수신거부 번호"},
    "remember": {"label": "리멤버 메시지", "limit": "150자 이내",
                 "extra": "명함 교환 맥락을 첫 문장에 언급, 말미에 수신거부 안내 한 줄"},
}


def _persona_block(p: dict) -> str:
    return (f"# 발신자 역할: {p['label']} ({COMPANY['name']} {p['signer']})\n"
            f"톤: {p['tone']}\n권한 범위: {p['authority']}")


def _copy_block(copy_guide: list | None) -> str:
    """STEP 5 문구 스튜디오에서 사람이 고른 문구를 프롬프트에 얹는다.

    고른 문구를 그대로 쓰라고 하지 않고 '방향'으로 준다.
    본문 규칙(근거 인용·단정 금지)이 문구보다 우선해야 하기 때문이다.
    """
    picked = [str(t).strip() for t in (copy_guide or []) if str(t).strip()]
    if not picked:
        return ""
    lines = "\n".join(f"- {t}" for t in picked[:12])
    return f"""
# 사람이 고른 문구 방향 (반드시 반영)
아래는 담당자가 직접 고른 표현이다. 이 어조와 소구점을 살려서 쓴다.
가능하면 표현을 그대로 살리되, 아래 작성 규칙과 충돌하면 규칙을 따른다.
{lines}
"""


def _interest_block(interests: dict | None) -> str:
    if not interests or not (interests.get("interests") or interests.get("hot_button")):
        return ""
    items = ", ".join(interests.get("interests") or [])
    return f"""
# 이 수신자의 관심사 (AI 추정 — 단정하지 말 것)
관심사: {items or '(불명)'}
가장 먼저 반응할 지점: {interests.get('hot_button') or '(불명)'}
피해야 할 말: {interests.get('avoid') or '(없음)'}
"""


def build_prompt(card, segment, signals, channel="email", persona_id=None,
                 source_profile=None, copy_guide=None) -> str:
    """1:1 개별 문안 프롬프트"""
    ch = CHANNEL_SPEC.get(channel, CHANNEL_SPEC["email"])
    p = persona(persona_id)
    creds = (source_profile or {}).get("credentials") or []
    src = (f"자사 홈페이지에서 확인된 공신력 근거: {', '.join(creds)}"
           if creds else f"{COMPANY['tagline']} / {COMPANY['grade']}")
    facts = (signals or {}).get("facts") or []

    return f"""너는 B2B 아웃바운드 영업 카피라이터다. 발신 주체는 {COMPANY['name']}({COMPANY['tagline']}, 업력 {COMPANY['years']}년, 누적 진단 {COMPANY['projects']}건)이다.
{src}

{_persona_block(p)}

# 수신자
이름: {card.get('name', '')} {card.get('title', '')}
회사: {card.get('company', '')} / {card.get('dept', '')}
만난 계기: {card.get('met_at') or '명함 교환'}
명함 메모: {card.get('note') or '(없음)'}
{_interest_block(card.get('interests'))}
# 이 수신자의 고객군
{segment['label']}
법정/수요 트리거: {segment['trigger']}
이 고객군의 통증: {segment['pain']}
인용 가능한 실제 실적(이 목록 밖의 실적을 지어내지 말 것):
{chr(10).join('- ' + r for r in segment['refs'])}
첫 제안(클로징은 반드시 이것으로): {segment['offer']}

# 담당자가 직접 확인해 입력한 시설 정보 (가장 신뢰도 높음 — 그대로 인용해도 된다)
{chr(10).join('- ' + f for f in facility_facts(card)) or '- (입력된 시설 정보 없음)'}

# 수신자 홈페이지에서 확인된 사실 (이 중 최소 1개를 반드시 인용)
{chr(10).join('- ' + str(f) for f in facts) or '- (확인된 사실 없음)'}
건물 신호: {json.dumps((signals or {}).get('building_signals') or {}, ensure_ascii=False)}
{_copy_block(copy_guide)}
# 작성 규칙 (위반 시 실패)
1. 홈페이지 사실 최소 1개를 자연스럽게 인용한다. 사실이 하나도 없으면 본문 대신 "INSUFFICIENT_EVIDENCE"만 출력한다.
2. 법정 점검 해당 여부를 단정하지 않는다. "해당하는 경우가 많습니다", "확인해 보시길 권합니다" 같은 확인 제안형으로 쓴다.
3. 실적은 위 목록에서만 인용한다. 숫자나 고객사를 새로 만들지 않는다.
4. 첫 메일에서 견적·계약을 요구하지 않는다. 무상 제공물 수령 여부만 묻는다.
5. 과장 표현("최고", "완벽", "100% 보장") 금지. 담백한 실무 톤.
6. 분량: {ch['limit']}. {ch['extra']}
7. 채널: {ch['label']}

# 출력 형식 (JSON만, 설명 금지)
{{
  "subject": "이메일일 때만 제목, 아니면 빈 문자열",
  "body": "본문 전문",
  "evidence_used": ["실제로 인용한 홈페이지 사실"],
  "refs_used": ["실제로 인용한 실적"],
  "cta": "이 메시지가 요구하는 단 하나의 다음 행동"
}}"""


def build_segment_prompt(segment, channel="email", persona_id=None,
                         source_profile=None, copy_guide=None) -> str:
    """1:N 고객군 공통 문안 프롬프트"""
    ch = CHANNEL_SPEC.get(channel, CHANNEL_SPEC["email"])
    p = persona(persona_id)
    creds = (source_profile or {}).get("credentials") or []

    return f"""너는 B2B 아웃바운드 영업 카피라이터다. 발신 주체는 {COMPANY['name']}({COMPANY['tagline']}, 업력 {COMPANY['years']}년, 누적 진단 {COMPANY['projects']}건)이다.
{('자사 공신력 근거: ' + ', '.join(creds)) if creds else ''}

{_persona_block(p)}

# 과제
아래 고객군 전체에 보낼 **공통 문안 1건**을 쓴다. 수신자 이름과 회사명은 병합필드로 남긴다.

# 고객군
{segment['label']}
법정/수요 트리거: {segment['trigger']}
이 고객군의 통증: {segment['pain']}
인용 가능한 실제 실적(이 목록 밖을 지어내지 말 것):
{chr(10).join('- ' + r for r in segment['refs'])}
첫 제안(클로징은 반드시 이것으로): {segment['offer']}
{_copy_block(copy_guide)}
# 작성 규칙
1. 수신자 이름은 {{{{name}}}}, 직함은 {{{{title}}}}, 회사명은 {{{{company}}}} 로 표기한다. 그 외 병합필드는 만들지 않는다.
2. 개별 회사의 구체적 사실을 아는 척하지 않는다. 고객군 공통의 통증과 트리거로만 설득한다.
3. 법정 점검 해당 여부를 단정하지 않는다. 확인 제안형으로 쓴다.
4. 실적은 위 목록에서만 인용한다.
5. 첫 문안에서 견적·계약을 요구하지 않는다.
6. 분량: {ch['limit']}. {ch['extra']}

# 출력 형식 (JSON만, 설명 금지)
{{
  "subject": "이메일일 때만 제목, 아니면 빈 문자열",
  "body": "본문 전문 (병합필드 포함)",
  "evidence_used": ["인용한 고객군 공통 트리거"],
  "refs_used": ["인용한 실적"],
  "cta": "요구하는 단 하나의 다음 행동"
}}"""


def apply_compliance(msg: dict, channel: str, persona_id: str | None) -> dict:
    """컴플라이언스 요소는 LLM 에 맡기지 않고 시스템이 강제 삽입한다.

    (광고) 표기와 수신거부 안내는 누락 시 법 위반이므로 생성 품질에 의존시키면 안 된다.
    """
    out = dict(msg)
    p = persona(persona_id)
    sig = {
        "email": (f"\n\n{COMPANY['name']} {p['signer']} | {COMPANY['tagline']}\n{COMPANY['addr']}\n"
                  f"Tel {COMPANY['tel']} | {COMPANY['email']}\n\n"
                  "※ 본 메일은 명함 교환을 통해 수집된 연락처로 발송된 광고성 정보입니다.\n"
                  "※ 수신을 원치 않으시면 회신 제목에 [수신거부]를 적어 보내주세요. 즉시 영구 차단됩니다."),
        "sms": f"\n\n{COMPANY['tel']}\n무료수신거부 080-000-0000",
        "remember": "\n\n— 광고성 안내입니다. 원치 않으시면 회신 주시면 더 보내지 않겠습니다.",
    }.get(channel, "")

    body = str(out.get("body") or "")
    if channel == "email":
        subj = str(out.get("subject") or "")
        if subj and not subj.startswith("(광고)"):
            out["subject"] = f"(광고) {subj}"
    elif channel == "sms":
        if not body.startswith("(광고)"):
            body = f"(광고) {COMPANY['name']}\n\n{body}"
    if not re.search(r"수신거부|수신 거부", body):
        body = f"{body}{sig}"
    out["body"] = body
    return out


def validate(msg: dict, channel: str, mode: str = "1:1") -> dict:
    """6단계 검토 게이트에 표시할 자동 검증 결과"""
    text = f"{msg.get('subject') or ''}\n{msg.get('body') or ''}"
    checks = [
        {"id": "C1",
         "label": "고객군 공통 트리거 인용" if mode == "1:N" else "홈페이지 사실 인용",
         "pass": len(msg.get("evidence_used") or []) > 0},
        {"id": "C2", "label": "실적 레퍼런스 인용", "pass": len(msg.get("refs_used") or []) > 0},
        {"id": "C3", "label": "법정 해당 여부 단정 안 함",
         "pass": not re.search(r"반드시 대상입니다|의무입니다|해야 합니다", text)},
        {"id": "C4", "label": "(광고) 표기", "pass": True if channel == "remember" else "(광고)" in text},
        {"id": "C5", "label": "수신거부 안내", "pass": bool(re.search(r"수신거부|수신 거부|080", text))},
        {"id": "C8", "label": "첫 접촉에 견적 요구 없음",
         "pass": not re.search(r"견적서를 보내|계약을 진행|금액을 확정", text)},
    ]
    if mode == "1:N":
        checks.append({"id": "C9", "label": "병합필드 잔여 없음",
                       "pass": not re.search(r"\{\{\w+\}\}", text)})
    return {"checks": checks, "blocked": any(not c["pass"] for c in checks)}


def generate_message(card, segment_id, signals, channel="email", persona_id=None,
                     source_profile=None, copy_guide=None) -> dict:
    segment = seg_of(segment_id)
    if not segment:
        return {"error": "unknown-segment"}

    prompt = build_prompt(card, segment, signals, channel, persona_id, source_profile, copy_guide)
    try:
        raw = llm.complete(prompt, max_tokens=1200)
    except Exception as e:
        return {"error": f"llm-failed: {e}", "prompt": prompt}
    if "INSUFFICIENT_EVIDENCE" in str(raw):
        return {"error": "insufficient-evidence", "prompt": prompt}

    parsed = llm.parse_json(raw)
    if not isinstance(parsed, dict):
        return {"error": "unparsable", "raw": str(raw)[:1200], "prompt": prompt}

    msg = apply_compliance(parsed, channel, persona_id)
    return {**msg, "channel": channel, "mode": "1:1", "personaId": persona_id,
            "prompt": prompt, **validate(msg, channel, "1:1")}


def generate_segment_template(segment_id, channel="email", persona_id=None,
                              source_profile=None, copy_guide=None) -> dict:
    segment = seg_of(segment_id)
    if not segment:
        return {"error": "unknown-segment"}

    prompt = build_segment_prompt(segment, channel, persona_id, source_profile, copy_guide)
    try:
        raw = llm.complete(prompt, max_tokens=1200)
    except Exception as e:
        return {"error": f"llm-failed: {e}", "prompt": prompt}
    parsed = llm.parse_json(raw)
    if not isinstance(parsed, dict):
        return {"error": "unparsable", "raw": str(raw)[:1200], "prompt": prompt}

    tpl = apply_compliance(parsed, channel, persona_id)
    return {**tpl, "channel": channel, "segmentId": segment_id, "mode": "1:N",
            "personaId": persona_id, "prompt": prompt}


def render_template(tpl: dict, card: dict, channel: str) -> dict:
    """템플릿의 병합필드를 수신자 정보로 치환한다."""
    def fill(t):
        return (str(t or "")
                .replace("{{name}}", card.get("name") or "")
                .replace("{{title}}", card.get("title") or "")
                .replace("{{company}}", card.get("company") or ""))

    msg = {**tpl, "subject": fill(tpl.get("subject")), "body": fill(tpl.get("body"))}
    return {**msg, **validate(msg, channel, "1:N")}
