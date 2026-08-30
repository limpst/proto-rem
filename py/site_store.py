"""홈페이지 분석 결과 보관소 — 한 번 읽은 회사는 다시 읽지 않는다.

왜 필요한가
    지금까지 리서치 캐시는 작업(job) 안에서만 살아 있었다. 그래서
    같은 회사 명함이 다음 실행에 또 들어오면 홈페이지를 다시 읽고
    AI 도 다시 불렀다. 회사 홈페이지는 하루 이틀에 바뀌지 않으므로
    낭비이고, 상대 서버에도 반복 부담이다.

무엇을 저장하는가
    회사 단위 사실이다. 사람마다 다를 이유가 없으므로 URL 을 키로 둔다.
    같은 회사에 명함이 다섯 장이면 한 번만 분석하고 다섯 명이 나눠 쓴다.

언제 다시 읽는가
    - 저장된 지 SITE_PROFILE_TTL_DAYS(기본 30일) 가 지났을 때
    - 사람이 [다시 분석] 을 눌렀을 때 (force)
    - 근거가 하나도 없이 저장된 실패 기록일 때는 짧은 주기로 재시도
"""
from __future__ import annotations

import time
from urllib.parse import urlsplit

from . import store
from .env import env_int

#: meta 에 들어가는 키
KEY = "siteProfiles"

#: 실패 기록은 오래 붙들지 않는다. 사이트가 고쳐졌을 수 있다.
FAIL_TTL_HOURS = 6


def norm_url(url: str | None) -> str:
    """비교용 정규화. 스킴·www·끝 슬래시 차이로 같은 사이트를 두 번 읽지 않도록."""
    u = (url or "").strip()
    if not u:
        return ""
    if "://" not in u:
        u = "https://" + u
    p = urlsplit(u)
    host = (p.netloc or "").lower().removeprefix("www.")
    path = (p.path or "").rstrip("/")
    return f"{host}{path}" if host else ""


def _all(st: dict | None = None) -> dict:
    st = st or store.load()
    v = st.get(KEY)
    return v if isinstance(v, dict) else {}


def get(url: str, st: dict | None = None) -> dict | None:
    """살아 있는 분석 결과. 없거나 기한이 지났으면 None."""
    key = norm_url(url)
    if not key:
        return None
    rec = _all(st).get(key)
    if not rec:
        return None

    age_h = (time.time() - float(rec.get("savedAt") or 0)) / 3600
    facts = ((rec.get("signals") or {}).get("facts")) or []
    ttl_h = FAIL_TTL_HOURS if not facts else env_int("SITE_PROFILE_TTL_DAYS", 30) * 24
    if age_h > ttl_h:
        return None
    return rec


def put(url: str, site: dict, signals: dict) -> None:
    """분석 결과를 보관한다. 같은 URL 은 덮어쓴다."""
    key = norm_url(url)
    if not key:
        return

    def apply(st):
        profiles = dict(_all(st))
        profiles[key] = {
            "url": url,
            "fetch": {"ok": site.get("ok"), "reason": site.get("reason"),
                      "chars": len(site.get("text") or "")},
            "signals": signals,
            "savedAt": time.time(),
        }
        st[KEY] = profiles
    store.update(apply)


def forget(url: str) -> bool:
    """[다시 분석] 용. 보관본을 지운다."""
    key = norm_url(url)
    if not key:
        return False
    hit = {"v": False}

    def apply(st):
        profiles = dict(_all(st))
        if key in profiles:
            del profiles[key]
            hit["v"] = True
        st[KEY] = profiles
    store.update(apply)
    return hit["v"]


def summary(st: dict | None = None) -> dict:
    """화면에 보여줄 요약 — 몇 개 회사를 얼마나 오래 들고 있는지."""
    profiles = _all(st)
    now = time.time()
    items = []
    for key, rec in profiles.items():
        facts = ((rec.get("signals") or {}).get("facts")) or []
        items.append({
            "key": key,
            "url": rec.get("url"),
            "facts": len(facts),
            "chars": (rec.get("fetch") or {}).get("chars"),
            "ageHours": round((now - float(rec.get("savedAt") or 0)) / 3600, 1),
        })
    items.sort(key=lambda x: x["ageHours"])
    return {"count": len(items), "items": items}
