"""리멤버 API 응답 → 명함 스키마 정규화, 그리고 붙여넣기 텍스트 파서.

실제 리멤버 응답에서 확인된 형태:
    name  : {"first": "이종하", "last": ""}                    ← 객체
    phone : {"international_code": "82",
             "national_number": "01091048279"}                 ← 객체
  그리고 회사명만 있고 name 이 빈 객체 — 이건 명함이 아니라 회사 자동완성 후보다. 걸러낸다.
"""
from __future__ import annotations

import re

CARD_KEYS = ["name", "company", "companyName", "mobile", "email", "department", "position"]


def harvest(node, out: list | None = None, depth: int = 0) -> list:
    """명함처럼 생긴 객체를 재귀로 찾는다."""
    if out is None:
        out = []
    if node is None or depth > 8:
        return out
    if isinstance(node, list):
        for v in node:
            harvest(v, out, depth + 1)
        return out
    if not isinstance(node, dict):
        return out
    if sum(1 for k in CARD_KEYS if k in node) >= 3:
        out.append(node)
    for v in node.values():
        harvest(v, out, depth + 1)
    return out


def flat_name(v) -> str:
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, dict):
        return " ".join(x for x in (v.get("last"), v.get("first")) if x).strip()
    return ""


def flat_phone(v) -> str:
    if isinstance(v, str):
        return v.strip()
    if not isinstance(v, dict):
        return ""
    n = re.sub(r"\D", "", str(v.get("national_number") or v.get("normalized_number") or ""))
    if not n:
        return ""
    if len(n) == 11:
        return f"{n[:3]}-{n[3:7]}-{n[7:]}"
    if len(n) == 10:
        return f"{n[:3]}-{n[3:6]}-{n[6:]}"
    return n


def _s(v) -> str:
    return v.strip() if isinstance(v, str) else ""


# ── 텍스트 붙여넣기 파서 ────────────────────────────────────────────────
# 명함이 몇 건뿐일 때는 브라우저를 거치는 것보다 그냥 붙여넣는 게 훨씬 빠르다.
# 엑셀 표(탭 구분), CSV, 덩어리 텍스트, 그리고 **한 줄로 붙여넣은 명함**까지 받는다.

HEADER_MAP = {
    "name": ["이름", "성명", "담당자", "name"],
    "title": ["직함", "직위", "직책", "title", "position"],
    "company": ["회사", "회사명", "소속", "company"],
    "dept": ["부서", "팀", "dept", "department"],
    "email": ["이메일", "메일", "email", "e-mail"],
    "phone": ["전화", "휴대폰", "연락처", "핸드폰", "phone", "mobile"],
    "site": ["홈페이지", "사이트", "url", "site", "homepage"],
}

EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
PHONE_RE = re.compile(r"(0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4})")
URL_RE = re.compile(
    r"((?:https?://)?(?:www\.)?[\w-]+\.(?:com|co\.kr|kr|net|org|io|cloud|ac\.kr|or\.kr|go\.kr)(?:/\S*)?)",
    re.I)
# 직함으로 자주 쓰이는 말 — 한 줄 붙여넣기에서 이름/직함/회사를 가르는 힌트로 쓴다.
TITLE_RE = re.compile(
    r"(회장|부회장|사장|부사장|전무|상무|이사|본부장|실장|센터장|소장|부장|차장|과장|팀장|대리|주임|사원|"
    r"대표|CEO|CTO|CFO|COO|매니저|연구원|기사|기술사|박사)")
NAME_RE = re.compile(r"^[가-힣]{2,4}$")


def _header_key(cell) -> str | None:
    v = str(cell or "").strip().lower()
    for k, aliases in HEADER_MAP.items():
        if any(v == a or a in v for a in aliases):
            return k
    return None


def _find(rx, text) -> str:
    m = rx.search(text or "")
    return m.group(0) if m else ""


def _from_tokens(tokens: list[str], email: str, phone: str, site: str) -> dict | None:
    """이메일·전화·URL 을 걷어낸 나머지 토큰으로 이름/직함/회사를 배정한다.

    한 줄 붙여넣기("호은성 전무이사 에이톰엔지니어링 atom@... 010-...")를 살리기 위한 경로다.
    이름은 2~4자 한글, 직함은 직함 사전으로 잡고, 남는 것을 회사로 본다.
    """
    toks = [t for t in tokens if t and not EMAIL_RE.fullmatch(t)
            and not PHONE_RE.fullmatch(t) and t != site]
    if not toks:
        return None

    name = next((t for t in toks if NAME_RE.match(t)), None) or toks[0]
    rest = [t for t in toks if t != name]
    title = next((t for t in rest if TITLE_RE.search(t)), "")
    company = " ".join(t for t in rest if t != title).strip()
    # 이름 하나만 남았는데 회사가 비면, 이메일 도메인이라도 회사 자리에 둔다.
    if not company and email:
        company = email.split("@")[-1]
    return {"name": name, "title": title, "company": company,
            "email": email, "phone": phone, "site": site}


def parse_text(text: str) -> dict:
    """붙여넣은 텍스트를 명함 배열로 만든다.

    @return {"cards": [...], "mode": "table"|"freeform"|"oneline"|"none"}
    """
    raw = str(text or "")
    lines = [l.strip() for l in raw.splitlines() if l.strip()]
    if not lines:
        return {"cards": [], "mode": "none"}

    # 1) 표 형태 — 탭 또는 쉼표로 2칸 이상 나뉘는 줄이 과반이면 표로 본다.
    def split(l):
        return l.split("\t") if "\t" in l else l.split(",")

    if sum(1 for l in lines if len(split(l)) >= 2) >= -(-len(lines) // 2):
        rows = [[c.strip() for c in split(l)] for l in lines]
        head = [_header_key(c) for c in rows[0]]
        has_header = sum(1 for h in head if h) >= 2
        cols = head if has_header else ["name", "title", "company", "email", "phone", "site"]
        body = rows[1:] if has_header else rows

        cards = []
        for r in body:
            c = {}
            for i, cell in enumerate(r):
                if i < len(cols) and cols[i]:
                    c[cols[i]] = cell
            # 열 위치가 어긋나도 이메일/전화/URL 은 내용으로 찾아 바로잡는다.
            joined = " ".join(r)
            if not EMAIL_RE.search(c.get("email", "")):
                c["email"] = _find(EMAIL_RE, joined)
            if not PHONE_RE.search(c.get("phone", "")):
                c["phone"] = _find(PHONE_RE, joined)
            if not c.get("site"):
                c["site"] = _find(URL_RE, joined)
            if c.get("name"):
                cards.append(c)
        if cards:
            return {"cards": to_cards(cards), "mode": "table"}

    # 2) 덩어리 텍스트 — 빈 줄로 나뉜 블록마다 한 사람으로 본다.
    blocks = [b.strip() for b in re.split(r"\n\s*\n", raw) if b.strip()]
    cards, oneline = [], True
    for b in blocks:
        bl = [l.strip() for l in b.splitlines() if l.strip()]
        email, phone = _find(EMAIL_RE, b), _find(PHONE_RE, b)
        site = _find(URL_RE, b)
        if site and site == email:
            site = ""
        # 이메일·전화·URL 이 아닌 줄들 중 첫 줄을 이름, 나머지를 직함/회사로 본다.
        plain = [l for l in bl if not EMAIL_RE.search(l) and not PHONE_RE.search(l) and not URL_RE.search(l)]
        if len(plain) >= 2:
            oneline = False
            cards.append({"name": plain[0], "title": plain[1] if len(plain) > 1 else "",
                          "company": plain[2] if len(plain) > 2 else (plain[1] if len(plain) > 1 else ""),
                          "email": email, "phone": phone, "site": site})
            continue
        # 3) 한 줄짜리 — 공백으로 나눠 이름/직함/회사를 배정한다.
        c = _from_tokens(re.split(r"[\s,|/]+", b), email, phone, site)
        if c and c.get("name"):
            cards.append(c)

    if cards:
        return {"cards": to_cards(cards), "mode": "oneline" if oneline else "freeform"}
    return {"cards": [], "mode": "none"}


def to_cards(found: list) -> list:
    """수집한 원본 객체들을 명함 배열로 만든다.

    이름이 없는 항목은 명함이 아니므로 버린다 (회사 자동완성 후보 등).
    """
    seen, cards = set(), []
    for c in found:
        name = flat_name(c.get("name"))
        company = _s(c.get("company")) or _s(c.get("companyName"))
        if not name:
            continue
        phone = flat_phone(c.get("phone") or c.get("mobile"))
        key = f"{name}|{company}|{phone}"
        if key in seen:
            continue
        seen.add(key)
        cards.append({
            "id": f"r{len(cards):04d}",
            "name": name,
            "title": _s(c.get("position")) or _s(c.get("title")),
            "company": company,
            "dept": _s(c.get("department")) or _s(c.get("dept")),
            "email": _s(c.get("email")),
            "phone": phone,
            "site": _s(c.get("homepage")) or _s(c.get("website")) or _s(c.get("site")),
            "met_at": "명함 교환",
            "note": _s(c.get("memo")) or _s(c.get("note")),
        })
    return cards
