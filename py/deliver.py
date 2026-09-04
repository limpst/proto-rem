"""STEP 7 발송 — Gmail SMTP (표준 라이브러리 smtplib).

자격증명은 코드나 저장소에 두지 않는다. 프로젝트 루트 .env 에 넣는다:

    GMAIL_USER=보내는주소@gmail.com
    GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx      # 앱 비밀번호 16자리 (계정 비밀번호 아님)
    GMAIL_FROM_NAME=에이톰엔지니어링

앱 비밀번호는 Google 계정 > 보안 > 2단계 인증 > 앱 비밀번호 에서 사용자가 직접 발급한다.
(.env 는 .gitignore 에 포함되어 커밋되지 않는다.)

안전장치:
  - 승인(APPROVED)된 건만 전송된다. (server 가 강제)
  - 21~08시에는 전송하지 않는다 (정보통신망법상 야간 광고 전송 제한).
  - DRY_RUN=1 이면 전송 대신 성공만 반환한다.
"""
from __future__ import annotations

import re
import smtplib
import ssl
from datetime import datetime
from email.header import Header
from email.mime.text import MIMEText
from email.utils import formataddr

from . import log as L
from .env import env, env_int


def smtp_status() -> dict:
    user = env("GMAIL_USER")
    return {
        "configured": bool(user and env("GMAIL_APP_PASSWORD")),
        "user": re.sub(r"(.{2}).*(@.*)", r"\1***\2", user) if user else None,
        "dryRun": env("DRY_RUN") == "1",
        "redirectTo": env("TEST_REDIRECT_TO") or None,
        # 화면의 [테스트 메일 보내기] 받는 사람 기본값.
        # user 는 가려진 값(hy***@...)이라 그대로는 보낼 수 없다.
        "testTo": env("TEST_SEND_TO") or env("GMAIL_USER") or "",
    }


def _night_blocked() -> bool:
    """정보통신망법상 광고성 정보의 야간(21~08시) 전송 제한.

    자가 테스트(본인 주소로 보내보기)는 광고성 전송이 아니므로 막을 이유가 없다.
    그래서 삭제하지 않고 스위치로 둔다: .env 의 ALLOW_NIGHT_SEND=1 이면 해제.
    실제 캠페인 전에는 반드시 0(또는 삭제)으로 되돌릴 것.
    """
    if env("ALLOW_NIGHT_SEND") == "1":
        return False
    h = datetime.now().hour
    return h >= 21 or h < 8


def send_email(to: str, subject: str, body: str) -> dict:
    if not to:
        return {"ok": False, "error": "수신 이메일 주소 없음"}
    user, pw = env("GMAIL_USER"), env("GMAIL_APP_PASSWORD")
    if not user or not pw:
        return {"ok": False, "error": ".env 에 GMAIL_USER / GMAIL_APP_PASSWORD 가 없습니다"}
    if env("DRY_RUN") == "1":
        L.log("info", "smtp", f"DRY_RUN — 실제 전송 안 함 → {to}")
        return {"ok": True, "messageId": "dry-run"}
    if _night_blocked():
        return {"ok": False,
                "error": "야간(21~08시) 광고 전송 제한 — 자가 테스트라면 .env 에 ALLOW_NIGHT_SEND=1"}

    # 테스트 중에는 진짜 수신자에게 나가면 안 된다. TEST_REDIRECT_TO 가 있으면
    # 모든 메일을 그 주소로만 보내고, 원래 수신자는 제목·본문 머리에 남긴다.
    # (실전 발송 전에는 반드시 비워야 한다. 화면 좌측 [메일] 칸에 표시된다.)
    redirect = env("TEST_REDIRECT_TO")
    real_to = to
    if redirect:
        to = redirect
        subject = f"[테스트→{real_to}] {subject or ''}"
        body = f"※ 테스트 발송입니다. 원래 수신자: {real_to}\n" + ("-" * 40) + "\n\n" + (body or "")

    msg = MIMEText(body or "", "plain", "utf-8")
    msg["Subject"] = Header(subject or "", "utf-8")
    msg["From"] = formataddr((str(Header(env("GMAIL_FROM_NAME", "에이톰엔지니어링"), "utf-8")), user))
    msg["To"] = to

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context(), timeout=30) as s:
            s.login(user, re.sub(r"\s+", "", pw))
            s.sendmail(user, [to], msg.as_string())
        L.log("ok", "smtp", f"발송 완료 → {to}" + (f" (원래 수신자 {real_to})" if redirect else ""))
        return {"ok": True, "messageId": "sent" + (f" → 테스트 주소 {to}" if redirect else "")}
    except Exception as e:
        L.log("error", "smtp", f"발송 실패 → {to}: {e}")
        return {"ok": False, "error": str(e)}

# ─────────────────────────────────────────────────────────────────────
# 발송 게이트 — 화면에서 전부 켜고 끌 수 있다.
#
# 여기 있는 것들은 "있다고 적어 두면 사람이 믿는" 종류다.
# 그래서 안내 문구와 실제 동작이 어긋나면 안 된다.
# ─────────────────────────────────────────────────────────────────────

def consent_blocked(card: dict) -> str | None:
    """수신 동의가 '거부' 인 사람에게는 보내지 않는다.

    광고성 정보는 사전 동의가 원칙이다. 거부 의사를 명함에 적어 두고도
    발송되면, 기록이 남아 있다는 점 때문에 오히려 더 무겁다.
    """
    if env("RESPECT_CONSENT", "1") != "1":
        return None
    if (card.get("consent") or "").strip() == "거부":
        return "수신 거부로 표시된 분입니다. 발송하지 않습니다."
    return None


def resend_blocked(card: dict) -> str | None:
    """같은 사람에게 너무 자주 보내지 않는다.

    같은 내용을 반복해 받으면 스팸 신고로 이어지고, 도메인 평판이 상한다.
    한 번 상한 평판은 되돌리기 어렵다.
    """
    days = env_int("RESEND_BLOCK_DAYS", 30)
    if days <= 0:
        return None
    last = card.get("deliveredAt")
    if not last:
        return None
    try:
        prev = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
    except ValueError:
        return None
    if prev.tzinfo:
        prev = prev.replace(tzinfo=None)
    gap = (datetime.now() - prev).days
    if gap < days:
        return f"{gap}일 전에 이미 보냈습니다. {days}일 이내 재발송은 막혀 있습니다."
    return None


def daily_limit_reached(sent_today: int) -> str | None:
    """하루 발송 상한. Gmail 개인 계정은 하루 500통 안팎에서 계정이 잠긴다."""
    cap = env_int("DAILY_SEND_LIMIT", 0)
    if cap <= 0:
        return None
    if sent_today >= cap:
        return f"오늘 {sent_today}건을 보냈습니다. 하루 상한({cap}건)에 도달했습니다."
    return None


def send_interval_sec() -> float:
    """연속 발송 사이 간격. 한꺼번에 쏟아내면 스팸 필터에 걸리기 쉽다."""
    try:
        return max(0.0, float(env("SEND_INTERVAL_SEC", "2")))
    except ValueError:
        return 2.0


def preflight(card: dict, sent_today: int = 0) -> str | None:
    """발송 전 점검. 막을 이유가 있으면 그 이유를 돌려준다."""
    if not (card.get("email") or "").strip():
        return "이메일 주소가 없습니다."
    for check in (consent_blocked(card), resend_blocked(card),
                  daily_limit_reached(sent_today)):
        if check:
            return check
    return None
