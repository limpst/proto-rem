"""명함 UPSERT — 새 데이터를 받아도 기존 작업을 날리지 않는다.

붙여넣기·업로드·불러오기가 cards 를 통째로 갈아끼우면
이미 해둔 고객군 분류, 리서치 근거, 생성한 문안, 승인 이력, 발송 기록이
전부 사라진다. 명함 두 장을 더 넣으려다 캠페인 하나를 잃는 셈이다.

매칭 기준 (위에서부터)
    1) 전화번호 숫자 + 이름   — 가장 확실하다. 동명이인을 가른다
    2) 전화번호 숫자만        — 이름 표기가 바뀐 경우 (Hong Gildong ↔ 홍길동)
    3) 이름 + 회사명(정규화)  — 전화번호가 없는 명함

갱신 규칙
    - 연락처는 새 값이 비어 있지 않을 때만 덮어쓴다. 빈 값으로 지우지 않는다
    - 파이프라인 상태(분류·근거·문안·승인·발송)는 건드리지 않는다
    - 단, 회사나 이메일이 실제로 바뀌었으면 리서치 근거는 낡은 것이므로 버린다
"""
from __future__ import annotations

import re

_CO_NOISE = re.compile(r"㈜|\(주\)|주식회사|\(유\)|유한회사|\s+")

#: 새 값이 있으면 갱신하는 연락처 필드
CONTACT = ["name", "title", "company", "dept", "email", "phone", "site", "met_at", "note"]


def _digits(v) -> str:
    return re.sub(r"\D", "", str(v or ""))


def _squash(v) -> str:
    return re.sub(r"\s+", "", str(v or "")).lower()


def _norm_co(v) -> str:
    return _CO_NOISE.sub("", str(v or "")).lower()


def _index(cards: list[dict]) -> dict:
    by_phone_name, by_phone, by_name_co = {}, {}, {}
    for i, c in enumerate(cards):
        p, n = _digits(c.get("phone")), _squash(c.get("name"))
        if len(p) >= 9 and n:
            by_phone_name.setdefault(f"{p}|{n}", i)
        if len(p) >= 9:
            by_phone.setdefault(p, i)
        if n:
            by_name_co.setdefault(f"{n}|{_norm_co(c.get('company'))}", i)
    return {"phone_name": by_phone_name, "phone": by_phone, "name_co": by_name_co}


def _find(idx: dict, inc: dict):
    p, n = _digits(inc.get("phone")), _squash(inc.get("name"))
    if len(p) >= 9 and n and f"{p}|{n}" in idx["phone_name"]:
        return idx["phone_name"][f"{p}|{n}"], "phone+name"
    if len(p) >= 9 and p in idx["phone"]:
        return idx["phone"][p], "phone"
    key = f"{n}|{_norm_co(inc.get('company'))}"
    if n and key in idx["name_co"]:
        return idx["name_co"][key], "name+company"
    return None, None


def _next_id_factory(cards: list[dict]):
    mx = -1
    for c in cards:
        m = re.match(r"^r(\d+)$", str(c.get("id") or ""))
        if m:
            mx = max(mx, int(m.group(1)))
    counter = {"n": mx}

    def nxt() -> str:
        counter["n"] += 1
        return f"r{counter['n']:04d}"
    return nxt


def upsert_cards(existing: list[dict], incoming: list[dict], mode: str = "upsert") -> dict:
    """@return {cards, inserted, updated, unchanged, replaced, details}"""
    if mode == "replace":
        cards = [{**c, "id": f"r{i:04d}", "status": "NEW"} for i, c in enumerate(incoming)]
        return {"cards": cards, "inserted": len(cards), "updated": 0,
                "unchanged": 0, "replaced": True, "details": []}

    cards = [dict(c) for c in existing]
    idx = _index(cards)
    nxt = _next_id_factory(cards)
    inserted = updated = unchanged = 0
    details: list[dict] = []

    for inc in incoming:
        if not str(inc.get("name") or "").strip():
            continue
        at, by = _find(idx, inc)

        if at is None:
            card = {**inc, "id": nxt(), "status": "NEW"}
            cards.append(card)
            # 같은 배치 안의 중복이 또 들어가지 않도록 즉시 색인에 반영한다
            p, n = _digits(card.get("phone")), _squash(card.get("name"))
            pos = len(cards) - 1
            if len(p) >= 9 and n:
                idx["phone_name"].setdefault(f"{p}|{n}", pos)
            if len(p) >= 9:
                idx["phone"].setdefault(p, pos)
            if n:
                idx["name_co"].setdefault(f"{n}|{_norm_co(card.get('company'))}", pos)
            inserted += 1
            details.append({"id": card["id"], "name": card["name"], "action": "insert"})
            continue

        cur = cards[at]
        changed: list[str] = []
        co_changed = bool(inc.get("company")) and _norm_co(inc["company"]) != _norm_co(cur.get("company"))
        mail_changed = bool(inc.get("email")) and _squash(inc["email"]) != _squash(cur.get("email"))

        for k in CONTACT:
            v = inc.get(k)
            if v is None or str(v).strip() == "":     # 빈 값으로 지우지 않는다
                continue
            if str(cur.get(k) or "") == str(v):
                continue
            cur[k] = v
            changed.append(k)

        # 회사·이메일이 바뀌면 기존 리서치 근거는 다른 회사의 것이다
        if co_changed or mail_changed:
            cur.pop("signals", None)
            cur.pop("siteFetch", None)
            if co_changed:
                cur.pop("siteUrl", None)
                cur.pop("siteResolve", None)
            changed.append("리서치 초기화")

        if changed:
            updated += 1
            details.append({"id": cur["id"], "name": cur.get("name"),
                            "action": "update", "by": by, "changed": changed})
        else:
            unchanged += 1

    return {"cards": cards, "inserted": inserted, "updated": updated,
            "unchanged": unchanged, "replaced": False, "details": details}
