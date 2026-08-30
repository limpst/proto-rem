"""명함 스키마 — 화면 입력폼과 DB 컬럼이 이 표 하나에서 나온다.

왜 한 곳에 모으는가
    필드를 늘릴 때마다 폼·DB·정규화·프롬프트 네 군데를 따로 고치면 반드시
    어긋난다. 실제로 그래서 site 필드가 업로드 경로에서 통째로 날아간 적이 있다.
    여기에 한 줄 추가하면 네 곳이 같이 따라오게 만든다.

무엇을 담는가
    ① 담당자   — 누구에게 보내는가
    ② 회사     — 어떤 조직인가
    ③ 시설     — 이 제품의 핵심. 준공연도·연면적이 있으면 법정 점검 주기를
                 추정할 수 있어 "지금 연락할 이유" 가 생긴다
    ④ 영업맥락 — 언제 어떻게 만났는가, 보내도 되는가

수신동의(consent)를 필드로 둔 이유
    광고성 정보는 사전 동의가 원칙이다. 동의 여부를 명함에 붙들어 두지 않으면
    "누구에게 보내도 되는지" 를 매번 기억에 의존하게 된다.
"""
from __future__ import annotations

#: (key, label, group, type, placeholder, help)
#: type: text | tel | email | url | number | date | select | textarea
FIELDS: list[dict] = [
    # ── ① 담당자 ────────────────────────────────────────────────
    {"key": "name", "label": "이름", "group": "담당자", "type": "text",
     "required": True, "placeholder": "홍길동",
     "help": "메일 첫 줄의 호칭에 쓰입니다."},
    {"key": "title", "label": "직함", "group": "담당자", "type": "text",
     "placeholder": "시설관리팀장",
     "help": "직함에 따라 문안의 어조와 제안 깊이가 달라집니다."},
    {"key": "dept", "label": "부서", "group": "담당자", "type": "text",
     "placeholder": "시설관리팀",
     "help": "부서명도 고객군 판정에 함께 쓰입니다. '시설관리팀'처럼 업무가 드러나면 정확해집니다."},
    {"key": "decision", "label": "결정 권한", "group": "담당자", "type": "select",
     "options": ["", "결정권자", "실무 검토", "정보 수집", "모름"],
     "help": "결정권자면 짧고 단정하게, 실무자면 자료 중심으로 씁니다."},
    {"key": "email", "label": "이메일", "group": "담당자", "type": "email",
     "placeholder": "hong@example.co.kr",
     "help": "발송에 반드시 필요합니다. 없으면 대상에서 빠집니다."},
    {"key": "phone", "label": "휴대폰", "group": "담당자", "type": "tel",
     "placeholder": "010-1234-5678",
     "help": "이름과 함께 중복 판정(UPSERT)의 기준이 됩니다."},
    {"key": "tel", "label": "사무실 전화", "group": "담당자", "type": "tel",
     "placeholder": "02-123-4567",
     "help": "메일 회신이 없을 때 쓰는 예비 연락처입니다. 발송에는 쓰이지 않습니다."},

    # ── ② 회사 ──────────────────────────────────────────────────
    {"key": "company", "label": "회사명", "group": "회사", "type": "text",
     "required": True, "placeholder": "○○개발",
     "help": "고객군 분류와 자사 제외 판정의 기준입니다."},
    {"key": "site", "label": "홈페이지", "group": "회사", "type": "url",
     "placeholder": "example.co.kr",
     "help": "비워 두면 이메일 도메인과 AI 추정으로 찾습니다."},
    {"key": "industry", "label": "업종", "group": "회사", "type": "text",
     "placeholder": "부동산 임대·관리",
     "help": "비워 두면 홈페이지 본문으로 추정합니다(KSIC 대분류)."},
    {"key": "region", "label": "지역", "group": "회사", "type": "text",
     "placeholder": "서울 강남구",
     "help": "현장 방문 제안이나 인근 실적 인용에 쓰입니다."},
    {"key": "address", "label": "주소", "group": "회사", "type": "text",
     "placeholder": "서울시 강남구 …",
     "help": "지역별로 담당을 나누거나 방문 일정을 잡을 때 씁니다. 메일 문구에는 쓰지 않습니다."},

    # ── ③ 시설 (이 제품의 핵심) ─────────────────────────────────
    {"key": "building_type", "label": "건물 용도", "group": "시설", "type": "select",
     "options": ["", "업무시설", "판매시설", "교육연구시설", "의료시설",
                 "공장", "창고", "숙박시설", "문화·집회시설", "공동주택",
                 "특수구조물(철탑·굴뚝 등)", "기타"],
     "help": "용도에 따라 적용되는 법정 점검 종류가 달라집니다."},
    {"key": "building_count", "label": "동 수", "group": "시설", "type": "number",
     "placeholder": "3",
     "help": "여러 동이면 동별 점검 로드맵을 제안합니다."},
    {"key": "floor_area", "label": "연면적(㎡)", "group": "시설", "type": "number",
     "placeholder": "12000",
     "help": "연면적이 점검 대상 여부를 가르는 기준이 되는 경우가 많습니다."},
    {"key": "completed_year", "label": "준공연도", "group": "시설", "type": "number",
     "placeholder": "1998",
     "help": "가장 중요한 값입니다. 준공 후 경과연수로 점검 주기를 추정합니다."},
    {"key": "last_inspection", "label": "최근 점검일", "group": "시설", "type": "date",
     "help": "다음 도래 시점을 계산하는 기준입니다."},
    {"key": "inspection_grade", "label": "최근 안전등급", "group": "시설", "type": "select",
     "options": ["", "A", "B", "C", "D", "E", "모름"],
     "help": "C 이하면 보수·보강 제안으로 방향이 바뀝니다."},

    # ── ④ 영업 맥락 ─────────────────────────────────────────────
    {"key": "met_at", "label": "만난 계기", "group": "영업 맥락", "type": "text",
     "placeholder": "2024 리테일시설 세미나",
     "help": "첫 문장에 인용됩니다. 구체적일수록 답장률이 올라갑니다."},
    {"key": "met_date", "label": "만난 날짜", "group": "영업 맥락", "type": "date",
     "help": "너무 오래된 접촉은 첫 문장에서 '지난번 명함' 을 언급하기 어색합니다. 판단 근거로 씁니다."},
    {"key": "owner", "label": "담당 영업", "group": "영업 맥락", "type": "text",
     "placeholder": "김영업",
     "help": "같은 회사에 두 사람이 동시에 접촉하는 것을 막습니다."},
    {"key": "consent", "label": "수신 동의", "group": "영업 맥락", "type": "select",
     "options": ["", "동의", "미확인", "거부"],
     "help": "광고성 정보는 사전 동의가 원칙입니다. '거부'는 발송에서 제외됩니다.",
     "warn": True},
    {"key": "priority", "label": "우선순위", "group": "영업 맥락", "type": "select",
     "options": ["", "높음", "보통", "낮음"],
     "help": "사람이 매기는 값입니다. 발송 순서를 정하거나 대상을 추릴 때 씁니다."},
    {"key": "tags", "label": "태그", "group": "영업 맥락", "type": "text",
     "placeholder": "쉼표로 구분 — 재접촉, 대형과업",
     "help": "나중에 대상을 골라낼 때 씁니다."},
    {"key": "note", "label": "메모", "group": "영업 맥락", "type": "textarea",
     "placeholder": "지하주차장 누수 문의를 받았다는 이야기를 들음",
     "help": "문안 생성에 그대로 참고됩니다. 들은 이야기를 적어두면 문안이 구체적으로 바뀝니다."},
]

#: DB 에 열로 저장할 필드 (문자열)
TEXT_KEYS: list[str] = [f["key"] for f in FIELDS]

#: 그룹 순서
GROUPS: list[str] = ["담당자", "회사", "시설", "영업 맥락"]


def by_group() -> list[dict]:
    """화면 폼이 그대로 쓰는 구조."""
    return [{"group": g, "fields": [f for f in FIELDS if f["group"] == g]} for g in GROUPS]


def facility_facts(card: dict) -> list[str]:
    """사람이 직접 입력한 시설 정보를 문안 근거로 바꾼다.

    홈페이지에서 추정한 것과 달리 이건 **사람이 확인해 넣은 값**이다.
    그래서 AI 추정보다 우선순위가 높고, 문안에서 단정적으로 인용해도 된다.
    """
    out: list[str] = []
    bt = (card.get("building_type") or "").strip()
    yr = str(card.get("completed_year") or "").strip()
    fa = str(card.get("floor_area") or "").strip()
    bc = str(card.get("building_count") or "").strip()
    li = (card.get("last_inspection") or "").strip()
    gr = (card.get("inspection_grade") or "").strip()

    if bt and yr:
        out.append(f"{bt}, {yr}년 준공")
    elif bt:
        out.append(f"용도: {bt}")
    elif yr:
        out.append(f"{yr}년 준공")

    if fa:
        try:
            out.append(f"연면적 약 {int(float(fa)):,}㎡")
        except ValueError:
            out.append(f"연면적 {fa}")
    if bc and bc != "1":
        out.append(f"{bc}개 동 운영")
    if li:
        out.append(f"최근 점검일 {li}")
    if gr and gr not in ("모름",):
        out.append(f"최근 안전등급 {gr}")
    return out
