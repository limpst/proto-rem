"""업종 판별 — 회사명과 홈페이지 본문으로 KSIC 대분류를 추정하고 고객군에 매핑한다.

왜 유료 기업정보 API 없이 하는가
    KSIC 코드를 '공식적으로 확정' 하려면 사업자등록번호가 필요하고, 회사명으로
    역검색하려면 유료 기업정보 서비스를 써야 한다. 하지만 우리에게 필요한 것은
    법적 확정이 아니라 **어떤 이야기를 할 고객군인가** 이다.
    그 정도는 이미 읽고 있는 홈페이지 본문으로 충분히 판별된다.

3단 판별
    ① 홈페이지 본문 + 회사명 → LLM 이 KSIC 대분류 추정      (가장 정확)
    ② 회사명 키워드 규칙 → KSIC 추정                        (본문이 없을 때)
    ③ 판별 실패 → unclassified. 억지 배정하지 않는다

정확도에 대한 정직한 태도
    ①도 추정이다. 그래서 confidence 와 근거(evidence)를 함께 남기고,
    화면은 ✧(추정)으로 표시한다. 사람이 STEP 4 에서 뒤집을 수 있어야 한다.
"""
from __future__ import annotations

import re

#: KSIC 대분류(알파벳) — 우리가 구분해야 하는 것만 추린다.
#: 전체 21개를 다 넣으면 LLM 이 헷갈리고, 안 쓰는 분류는 판단만 흐린다.
KSIC_SECTIONS = {
    "F": "건설업",
    "G": "도매 및 소매업",
    "H": "운수 및 창고업",
    "J": "정보통신업",
    "K": "금융 및 보험업",
    "L": "부동산업",
    "M": "전문·과학 및 기술 서비스업",
    "N": "사업시설 관리·사업 지원 서비스업",
    "O": "공공행정·국방 및 사회보장 행정",
    "P": "교육 서비스업",
    "Q": "보건업 및 사회복지 서비스업",
    "C": "제조업",
    "R": "예술·스포츠 및 여가 관련 서비스업",
}

#: KSIC 대분류(+ 세부 힌트) → 고객군.
#: 한 대분류가 여러 고객군에 걸치는 경우 세부 힌트로 가른다.
#: 예) M 전문·과학·기술 중 건축기술·엔지니어링만 safety 로 본다.
SECTION_TO_SEGMENT = {
    "G": "retail",        # 도소매 — 백화점·마트·복합몰
    "P": "campus",        # 교육 — 대학·학교
    "Q": "campus",        # 보건 — 병원·의료재단
    "L": "office",        # 부동산 — 임대·자산관리
    "K": "office",        # 금융 — 리츠·운용사
    "J": "tower",         # 정보통신 — 통신·방송
    "F": "demolition",    # 건설 — 시공사·정비사업
    "C": "industrial",    # 제조
    "H": "industrial",    # 운수·창고 — 물류센터
    "O": "public",        # 공공행정
    "N": "public",        # 사업시설 관리 — 시설관리공단
    "M": "safety",        # 전문·과학·기술 — 건축기술·엔지니어링
    "R": "retail",        # 예술·스포츠·여가 — 대형 시설 운영
}

#: 본문이 없을 때 쓰는 회사명 키워드 → KSIC 대분류.
#: 규칙은 빠르고 공짜지만 이름에 업종이 드러날 때만 맞는다.
NAME_HINTS: list[tuple[str, str]] = [
    ("건설|건축|시공|토목|종합건설", "F"),
    ("엔지니어링|기술사|구조|안전진단|감리|진단", "M"),
    ("유통|백화점|마트|쇼핑|리테일|몰", "G"),
    ("대학|학교|학원|교육", "P"),
    ("병원|의료|메디|재단|클리닉", "Q"),
    ("리츠|자산운용|부동산|에셋|임대", "L"),
    ("은행|증권|보험|캐피탈|금융|파이낸스|트레이딩", "K"),
    ("통신|텔레콤|방송|미디어|네트웍|네트워크", "J"),
    ("물류|창고|운송|택배|로지스", "H"),
    ("제조|산업|정밀|중공업|화학|전자|소재", "C"),
    ("공단|공사|시청|구청|군청|지자체|재단법인", "O"),
    ("시설관리|FM|파실리티", "N"),
    ("리조트|레저|스포츠|골프|호텔", "R"),
]


def by_name(company: str | None) -> dict | None:
    """회사명 키워드로 KSIC 대분류를 추정한다. 본문이 없을 때 쓰는 2순위."""
    name = str(company or "")
    if not name.strip():
        return None
    for pattern, section in NAME_HINTS:
        if re.search(pattern, name):
            return {
                "section": section,
                "sectionLabel": KSIC_SECTIONS.get(section, ""),
                "segmentId": SECTION_TO_SEGMENT.get(section),
                "confidence": "low",
                "source": "name",
                "evidence": f"회사명에 '{re.search(pattern, name).group()}' 이 들어 있습니다",
            }
    return None


def _prompt(company: str, title: str, site_text: str) -> str:
    sections = "\n".join(f"  {k} : {v}" for k, v in KSIC_SECTIONS.items())
    body = (site_text or "")[:6000]
    return f"""너는 기업 업종 분류 애널리스트다. 아래 회사가 한국표준산업분류(KSIC)
대분류 중 어디에 속하는지 판단하라.

# 회사
이름: {company}
직함(참고): {title or '(없음)'}

# 홈페이지 본문
\"\"\"
{body or '(본문 없음 — 회사명만으로 판단하되, 근거가 약하면 confidence 를 low 로)'}
\"\"\"

# 고를 수 있는 대분류 (이 목록 밖을 만들지 말 것)
{sections}
  ? : 판단할 근거가 부족함

# 규칙
1. 홈페이지에 적힌 사업 내용을 우선한다. 회사명은 보조 근거다.
2. 근거가 약하면 억지로 고르지 말고 "?" 를 선택한다. 틀린 분류는 엉뚱한 메일로 이어진다.
3. evidence 에는 본문에서 근거가 된 표현을 그대로 인용한다. 없으면 빈 문자열.

# 출력 (JSON 만, 설명 금지)
{{"section":"F","confidence":"high|medium|low","evidence":"근거가 된 본문 표현"}}"""


def by_homepage(card: dict, site_text: str, complete_fn) -> dict | None:
    """홈페이지 본문으로 업종을 추정한다. 1순위.

    complete_fn 은 llm.complete 를 받는다 (import 순환을 피하려고 주입한다).
    """
    try:
        raw = complete_fn(_prompt(card.get("company") or "", card.get("title") or "", site_text),
                          max_tokens=300)
    except Exception:
        return None

    m = re.search(r"\{[\s\S]*?\}", str(raw))
    if not m:
        return None
    try:
        import json
        r = json.loads(m.group(0))
    except ValueError:
        return None

    section = str(r.get("section") or "").strip().upper()
    if section not in KSIC_SECTIONS:
        return None
    conf = r.get("confidence")
    return {
        "section": section,
        "sectionLabel": KSIC_SECTIONS[section],
        "segmentId": SECTION_TO_SEGMENT.get(section),
        "confidence": conf if conf in ("high", "medium", "low") else "low",
        "source": "homepage" if site_text else "llm-name",
        "evidence": str(r.get("evidence") or "")[:200],
    }


def resolve(card: dict, site_text: str | None, complete_fn=None) -> dict | None:
    """① 홈페이지 → ② 회사명 규칙 → ③ 없음.

    결과에는 반드시 source 와 confidence 가 들어간다.
    화면이 '확인된 사실' 과 '추정' 을 갈라 보여줘야 하기 때문이다.
    """
    if complete_fn and (site_text or "").strip():
        hit = by_homepage(card, site_text, complete_fn)
        if hit:
            return hit
    return by_name(card.get("company"))
