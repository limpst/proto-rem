"""STEP 2 회사 식별 — 명함에 홈페이지가 없을 때 찾아낸다.

명함에 URL 이 적혀 있는 경우는 드물다. 대신 이메일 도메인이 거의 항상 회사 도메인이다.
    jh.lee@novaedgetek.com  ->  https://novaedgetek.com

다만 gmail/naver 같은 무료 메일은 회사 도메인이 아니므로 걸러야 한다.
후보를 만든 뒤 실제로 응답하는지 확인해서, **살아 있는 주소만** 채택한다.
"""
from __future__ import annotations

import re
import urllib.request

from . import llm
from . import log as L

# 회사 도메인이 아닌 무료·포털 메일
FREE_MAIL = {
    "gmail.com", "googlemail.com", "naver.com", "daum.net", "hanmail.net", "kakao.com",
    "nate.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "yahoo.co.kr",
    "icloud.com", "me.com", "protonmail.com", "proton.me", "qq.com", "163.com",
}
UA = "Mozilla/5.0 (compatible; proto-rem/0.2; +research)"


def domain_from_email(email: str | None) -> str:
    m = re.search(r"@([^@\s]+)$", str(email or ""))
    if not m:
        return ""
    d = m.group(1).lower().strip()
    return "" if d in FREE_MAIL else d


def candidates(card: dict) -> list[str]:
    """도메인 하나로 만들 수 있는 홈페이지 후보들"""
    out: list[str] = []

    def push(u):
        if u and u not in out:
            out.append(u)

    site = (card.get("site") or "").strip()
    if site:
        push(site if site.startswith("http") else f"https://{site}")

    d = domain_from_email(card.get("email"))
    if d:
        push(f"https://{d}")
        push(f"https://www.{d}")
        # 메일만 별도 도메인을 쓰는 경우 (mail.example.com 등)
        bare = re.sub(r"^(mail|mx|smtp|email)\.", "", d)
        if bare != d:
            push(f"https://{bare}")
            push(f"https://www.{bare}")
    return out


def _alive(url: str) -> str | None:
    """실제로 응답하는지 확인한다. 리다이렉트된 최종 주소를 돌려준다."""
    try:
        req = urllib.request.Request(url, headers={"user-agent": UA})
        with urllib.request.urlopen(req, timeout=8) as r:
            if r.status != 200:
                return None
            return r.geturl() or url
    except Exception:
        return None


def _guess_by_name(card: dict) -> list[str]:
    """3순위 — 회사명으로 LLM 에게 후보를 물어본다.

    LLM 은 없는 주소를 만들어낼 수 있으므로 **제안만 받고 채택은 하지 않는다.**
    반환된 후보를 전부 실제로 접속해 보고 살아 있는 것만 채택하므로,
    환각이 결과를 오염시키지 못한다.
    """
    if not card.get("company"):
        return []
    prompt = f"""\"{card['company']}\" 라는 한국 회사의 공식 홈페이지 주소를 추정하라.
{f"참고 - 이 회사 직원 이메일: {card['email']}" if card.get("email") else ""}
{f"참고 - 직함: {card['title']}" if card.get("title") else ""}

확실하지 않아도 된다. 가능성이 높은 순서로 최대 4개의 URL 후보만 출력하라.
실제 접속 가능 여부는 별도로 검증하므로, 추측이어도 형식만 맞으면 된다.

JSON 배열만 출력하라. 설명 금지.
["https://example.com", "https://www.example.co.kr"]"""
    try:
        arr = llm.parse_json(llm.complete(prompt, max_tokens=300), want_list=True)
    except Exception as e:
        L.log("warn", "resolve", f"LLM 후보 생성 실패 — {e}")
        return []
    if not isinstance(arr, list):
        return []
    return [u for u in arr if isinstance(u, str) and u.startswith("http")][:4]


def resolve_site(card: dict, use_llm: bool = True) -> dict:
    """명함 하나의 홈페이지를 확정한다.

    순서: ① 명함에 적힌 URL ② 이메일 도메인 ③ 회사명으로 LLM 후보
    어느 단계든 **실제 응답하는 주소만** 채택한다.
    """
    tried = candidates(card)
    for i, url in enumerate(tried):
        found = _alive(url)
        if found:
            via = "card" if (i == 0 and card.get("site")) else "email-domain"
            L.log("ok", "resolve", f"{card.get('company')} → {found}", {"via": via})
            return {"siteUrl": found, "via": via, "tried": tried}

    if use_llm:
        for url in _guess_by_name(card):
            tried.append(url)
            found = _alive(url)
            if found:
                L.log("ok", "resolve", f"{card.get('company')} → {found}", {"via": "llm-guess"})
                return {"siteUrl": found, "via": "llm-guess", "tried": tried}

    L.log("warn", "resolve", f"{card.get('company')} 홈페이지 못 찾음", {"tried": len(tried)})
    return {"siteUrl": "", "via": "none", "tried": tried}
