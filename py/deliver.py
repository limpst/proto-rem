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
from .env import env


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
