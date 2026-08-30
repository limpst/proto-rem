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


def put(url: str, site: dict, signals: dict, segment_id: str | None = None,
        company: str | None = None) -> None:
    """분석 결과를 보관한다. 같은 URL 은 덮어쓴다.

    고객군·회사명도 같이 남긴다. 나중에 같은 업종의 다른 회사가 들어왔을 때
    참고자료(프록시)로 꺼내 쓰기 위해서다.
    """
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
            "segmentId": segment_id,
            "company": company,
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


def proxy_for(segment_id: str | None, exclude_url: str | None = None,
              st: dict | None = None) -> dict | None:
    """같은 고객군의 다른 회사에서 이미 분석해 둔 근거를 참고자료로 꺼낸다.

    그 회사 홈페이지를 못 읽었을 때, 업종 표준값(일반론)보다는
    **같은 업종 실제 회사에서 확인된 사실**이 한 단계 더 구체적이다.

    다만 이것도 그 회사에서 확인한 것이 아니다. 그래서
      - kind='proxy' 로 표시해 화면이 ✧(추정)으로 구분하고
      - 어느 회사에서 가져온 것인지 note 에 남긴다
      - 문안에서는 "이런 시설은 보통" 수준으로만 쓰이도록 근거 문구를 그대로 넘긴다
    """
    if not segment_id:
        return None
    ex = norm_url(exclude_url)
    best, best_age = None, None
    for key, rec in _all(st).items():
        if key == ex or rec.get("segmentId") != segment_id:
            continue
        facts = ((rec.get("signals") or {}).get("facts")) or []
        if not facts:
            continue
        age = time.time() - float(rec.get("savedAt") or 0)
        if best_age is None or age < best_age:
            best, best_age = rec, age
    if not best:
        return None

    src = best.get("company") or best.get("url") or "같은 업종의 다른 회사"
    facts = ((best.get("signals") or {}).get("facts")) or []
    return {
        # 다른 회사에서 확인한 사실을 그대로 넘기면 안 된다.
        # 문안 생성 프롬프트는 이 목록을 "수신자 홈페이지에서 확인된 사실" 로 제목 붙여
        # 넘기고 "최소 1개를 반드시 인용" 하라고 지시한다. 라벨 없이 넣으면
        # A사의 실적이 B사의 실적처럼 메일에 적힌다. 문장 자체에 출처를 박아
        # 인용되더라도 '같은 업종 사례' 로만 읽히게 한다.
        "facts": [f"같은 업종 사례({src}) — {f}" for f in facts],
        "building_signals": (best.get("signals") or {}).get("building_signals") or {},
        "confidence": "low",
        "kind": "proxy",
        "proxyFrom": src,
        "note": (f"이 회사 홈페이지를 읽지 못해 같은 업종({segment_id})의 "
                 f"'{src}' 분석을 참고자료로 씁니다. "
                 "그 회사에서 확인한 내용이 아니므로 검토에서 반드시 확인하세요."),
    }
