"""7단계 파이프라인 서버 (Python 표준 라이브러리만).

    python -m py.server        ->  http://localhost:5173

HITL 게이트 3곳: STEP2(발신·모드), STEP4(대상 선택), STEP6(문안 승인).

설계 메모
  - 프런트(public/)는 Node 판과 동일한 것을 그대로 쓴다. 바뀐 건 백엔드뿐이다.
  - 모든 상태 응답은 full_state() 하나로 조립한다. 어느 엔드포인트가 steps/segments 를
    빠뜨리면 클라이언트의 사이드바가 통째로 사라지므로, 그 사고를 구조적으로 막는다.
  - 오래 걸리는 작업(LLM 생성)은 batch 건씩 끊어 처리하고 remaining 을 돌려준다.
    클라이언트가 remaining 이 0이 될 때까지 반복 호출하며 진행률을 보여준다.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import classify_ai, copy_ai, deliver, enrich, generate, llm, normalize, resolve
from . import schema
from . import sector_fallback as SF
from . import site_store as SITE
from . import upsert as UP
from . import paths
from . import store
from . import log as L
from .domain import COMPANY, PERSONAS, SEGMENTS, classify
from .domain import persona as persona_of
from .domain import segment as seg_of
from .env import env, settings_view, write_env

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
# 업로드본은 살아남아야 하고, 시드는 저장소에 커밋된 읽기 전용 자산이다.
DATA = paths.STATE
ASSETS = paths.ASSETS
PORT = int(os.environ.get("PORT", 5173))

STEPS = [
    {"n": 1, "id": "ingest", "label": "명함 수집", "hitl": False, "desc": "리멤버/CSV에서 명함을 가져온다"},
    {"n": 2, "id": "resolve", "label": "발신·발송모드", "hitl": True,
     "desc": "발신은 에이톰엔지니어링 고정. 발신자 역할과 1:1 / 1:N 을 사람이 선택한다"},
    # 3단계는 선택이다. 저장된 분석이 있으면 건너뛰어도 5단계가 돌아간다.
    # 근거가 없으면 업종 표준값으로 대체되므로 파이프라인이 끊기지 않는다.
    {"n": 3, "id": "enrich", "label": "홈페이지 분석", "hitl": False, "optional": True,
     "desc": "선택 단계. 회사 홈페이지를 읽어 그 회사에만 해당하는 근거를 뽑습니다. "
             "건너뛰면 저장된 분석이나 업종 표준값을 씁니다"},
    {"n": 4, "id": "segment", "label": "고객군 선택", "hitl": True,
     "desc": "고객군 자동 분류 → 사람이 발송 대상 확정"},
    {"n": 5, "id": "generate", "label": "문구·카피 생성", "hitl": False,
     "desc": "키워드로 문구를 고르고, 그 방향으로 문안을 생성한다"},
    {"n": 6, "id": "review", "label": "검토·승인", "hitl": True, "desc": "사람이 문안 수정 후 승인/반려"},
    {"n": 7, "id": "deliver", "label": "발송·추적", "hitl": False, "desc": "승인 건만 발송, 이력·응답 기록"},
]


# ─────────────────────────────────────────────────────────────────────
# 백그라운드 작업
#
# 로컬 모델은 문안 한 건에 5분이 넘게 걸린다. 그동안 HTTP 응답을 붙잡고 있으면
# 브라우저와 클라이언트가 300초에서 먼저 끊어 버린다(실측 318.9초에 끊김).
# 그래서 오래 걸리는 단계는 즉시 작업 번호를 돌려주고, 화면이 진행률을 물어본다.
# ─────────────────────────────────────────────────────────────────────
_JOBS: dict[str, dict] = {}
_JOB_LOCK = threading.Lock()


def _job_new(kind: str, total: int) -> str:
    jid = f"{kind}-{int(time.time() * 1000)}"
    with _JOB_LOCK:
        _JOBS[jid] = {"id": jid, "kind": kind, "status": "running",
                      "total": total, "done": 0, "current": "", "error": None,
                      # 건별 실패는 여기 쌓고 작업은 계속 간다.
                      # 한 건 때문에 전체가 멈추면 나머지 대상이 통째로 날아간다.
                      "failed": 0, "errors": [], "startedAt": time.time()}
    return jid


def _job_cancel(jid: str) -> bool:
    """중지 요청. 작업 스레드를 강제로 죽이지 않고 협조적으로 멈춘다.

    강제 종료는 SQLite 쓰기 도중에 끊길 수 있어 상태가 깨진다.
    대신 루프가 매 건 시작 전에 플래그를 보고, 남은 대상은 표준값으로 채운 뒤 끝낸다.
    """
    with _JOB_LOCK:
        j = _JOBS.get(jid)
        if not j or j.get("status") != "running":
            return False
        j["cancel"] = True
        j["status"] = "cancelling"
    L.log("warn", "job", f"{jid} 중지 요청 — 남은 건은 표준값으로 채웁니다")
    return True


def _job_cancelled(jid: str) -> bool:
    with _JOB_LOCK:
        return bool(_JOBS.get(jid, {}).get("cancel"))


def _job_set(jid: str, **kw):
    with _JOB_LOCK:
        if jid in _JOBS:
            _JOBS[jid].update(kw)


def _job_get(jid: str) -> dict | None:
    with _JOB_LOCK:
        j = _JOBS.get(jid)
        return dict(j) if j else None


def _job_fail_item(jid: str, label: str, err: Exception):
    """건별 실패를 기록하고 넘어간다. 작업 자체는 실패로 만들지 않는다."""
    with _JOB_LOCK:
        j = _JOBS.get(jid)
        if j:
            j["failed"] = j.get("failed", 0) + 1
            j.setdefault("errors", []).append(f"{label}: {type(err).__name__}: {err}"[:200])
    L.log("warn", "job", f"{label} 건너뜀 — {err}")


def _job_run(jid: str, fn):
    """작업 본체를 별도 스레드에서 돌린다. 예외는 작업에 기록하고 서버는 살려 둔다."""
    def wrap():
        try:
            fn(jid)
            if _job_cancelled(jid):
                # current 에는 작업이 남긴 "남은 N건은 표준값으로 채웠습니다" 가 들어 있다.
                # 여기서 비우면 화면이 왜 멈췄는지 말해 줄 문장을 잃는다.
                _job_set(jid, status="cancelled")
            else:
                _job_set(jid, status="done", current="")
        except Exception as e:
            L.log("error", "job", f"{jid} 실패 — {e}")
            _job_set(jid, status="failed", error=f"{type(e).__name__}: {e}")
    threading.Thread(target=wrap, daemon=True).start()


# ── 접속 인증 ───────────────────────────────────────────────────────────
# 이 화면에는 명함(개인정보)과 발송 설정이 들어 있다. 사내망에 올려 두면
# 주소를 아는 사람은 누구나 열 수 있으므로, APP_PASSWORD 가 있으면 전부 잠근다.
# 비워 두면 지금까지처럼 무인증으로 뜬다(내 PC 개발용).
#
# 세션은 비밀번호에서 파생한 값 하나를 쿠키에 담는 방식이다. 서버에 세션 저장소를
# 두지 않아 재시작해도 로그인이 풀리지 않고, 비밀번호를 바꾸면 전부 로그아웃된다.
COOKIE = "pr_session"


#: 아이디를 따로 정하지 않으면 이것을 쓴다.
DEFAULT_USER = "atom"


def _auth_on() -> bool:
    return bool(env("APP_PASSWORD"))


def _auth_user() -> str:
    return (env("APP_USER") or DEFAULT_USER).strip()


def _token() -> str:
    # 아이디까지 섞는다. 아이디를 바꾸면 기존 세션도 끊긴다.
    key = ((_auth_user() + "\x00" + (env("APP_PASSWORD") or "")).encode())
    return hmac.new(key, b"proto-rem-session-v2", hashlib.sha256).hexdigest()


def _authed(cookie_header: str) -> bool:
    for part in (cookie_header or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == COOKIE:
            return hmac.compare_digest(v.strip(), _token())
    return False


def _is_local(peer: str) -> bool:
    """요청이 이 컴퓨터 안에서 왔는가. 비밀값 원문 노출을 여기로만 제한한다."""
    return peer in ("127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1")


def full_state(st: dict, **extra) -> dict:
    return {**st, "steps": STEPS, "segments": SEGMENTS, "company": COMPANY,
            "personas": PERSONAS, "copyKinds": copy_ai.KINDS, "copyTones": copy_ai.TONES,
            "backend": llm.resolve_backend(), "smtp": deliver.smtp_status(),
            # 데이터가 재배포를 견디는 자리에 있는지 화면이 사실대로 말할 수 있게 싣는다.
            "storage": paths.describe(), "auth": {"enabled": _auth_on()},
            "runtime": "python", "cardFields": schema.by_group(), **extra}


def _card(st, cid):
    return next((c for c in st["cards"] if c["id"] == cid), None)


def _usable(st):
    return [c for c in st["cards"] if not c.get("excluded") and c.get("segmentId") != "internal"]


def _run_npm(args: list[str]) -> str:
    """리멤버 반출 스크립트는 Playwright(Node) 라 그대로 둔다. 여기서는 호출만 한다."""
    try:
        p = subprocess.run(["npm", *args], cwd=str(ROOT), capture_output=True, text=True,
                           encoding="utf-8", errors="replace", shell=(sys.platform == "win32"),
                           timeout=600)
        return (p.stdout or "") + (p.stderr or "")
    except Exception as e:
        return str(e)


def _fill_sector_messages(job_id, rest, sel, channel, persona_id, mode="1:1"):
    """중지된 생성 작업의 남은 대상을 업종 기본 문안으로 채운다.

    중지를 눌렀다고 그 대상들이 빈손이면 6·7단계에서 통째로 사라진다.
    "중지 = 여기서부터는 표준 문안으로 간다" 가 되도록 채워 두고,
    kind='sector' 로 표시해 검토 화면에서 AI 생성분과 갈라 보이게 한다.
    """
    p = persona_of(persona_id)
    cur = store.load()
    filled = 0
    if mode == "1:N":
        tpls = dict(cur.get("templates") or {})
        for sid in rest:
            seg = seg_of(sid)
            if not seg:
                continue
            tpl = generate.apply_compliance(SF.template_for(seg, p, COMPANY), channel, persona_id)
            tpl["kind"] = "sector"
            tpl["fallbackFrom"] = "사용자가 생성을 중지함"
            tpls[sid] = tpl
            for c in cur["cards"]:
                if c["id"] in sel and c.get("segmentId") == sid:
                    c["message"] = generate.render_template(tpl, c, channel)
                    c["message"]["kind"] = "sector"
                    c["message"]["fallbackFrom"] = "사용자가 생성을 중지함"
                    c["message"].setdefault("reviewStatus", "PENDING")
                    c["status"] = "DRAFTED"
                    filled += 1
        cur["templates"] = tpls
    else:
        for r in rest:
            seg = seg_of(r.get("segmentId"))
            c = _card(cur, r["id"])
            if not seg or c is None or c.get("message"):
                continue
            tpl = generate.apply_compliance(SF.template_for(seg, p, COMPANY), channel, persona_id)
            c["message"] = generate.render_template(tpl, c, channel)
            c["message"]["kind"] = "sector"
            c["message"]["fallbackFrom"] = "사용자가 생성을 중지함"
            c["message"]["reviewStatus"] = "PENDING"
            c["status"] = "DRAFTED"
            filled += 1
    cur["step"] = 5
    store.save(cur)
    _job_set(job_id, current=f"중지됨 — 남은 {filled}건은 업종 기본 문안으로 채웠습니다")
    L.log("warn", "generate", f"중지 — {filled}건 업종 기본 문안 대체")


# ── 라우트 ────────────────────────────────────────────────────────────
def route(path: str, method: str, body: dict, query: dict, peer: str = ""):
    """(status, payload) 를 돌려준다. payload 가 dict 면 JSON 으로 나간다."""

    if path == "/api/state":
        return 200, full_state(store.load())

    if path == "/api/job-cancel" and method == "POST":
        return 200, {"ok": _job_cancel(body.get("id") or ""), "job": _job_get(body.get("id") or "")}

    if path == "/api/logs":
        return 200, L.since(int((query.get("since") or ["0"])[0] or 0))

    if path == "/api/logs/clear" and method == "POST":
        return 200, L.clear()

    if path == "/api/reset" and method == "POST":
        L.log("warn", "reset", "전체 초기화")
        return 200, full_state(store.reset())

    # --- AI 엔진 (백엔드·모델 전환) --------------------------------------
    if path == "/api/llm-models":
        return 200, {**llm.list_ollama_models(), "backend": llm.resolve_backend(refresh=True)}

    if path == "/api/llm" and method == "POST":
        llm.set_backend(body.get("name"), body.get("model"))
        return 200, full_state(store.load(), backend=llm.resolve_backend(refresh=True))

    # --- 1-a. 리멤버 반출 (이미 로그인된 Chrome 에 CDP 로 접속) -----------
    if path == "/api/remember-export" and method == "POST":
        log = _run_npm(["run", "export", "--", f"--via={body.get('via', 'profile')}"])
        ok = "건 반출" in log
        L.log("ok" if ok else "error", "ingest", f"리멤버 반출 {'성공' if ok else '실패'}")
        return 200, {"ok": ok, "log": log[-2500:]}

    # --- 1-a2. 전용 프로필에 로그인 창 띄우기 -----------------------------
    if path == "/api/remember-login" and method == "POST":
        log = _run_npm(["run", "login"])
        return 200, {"ok": "로그인 확인됨" in log, "log": log[-2000:]}

    # --- 1-b. 자사(에이톰) 홈페이지 프로파일 ------------------------------
    if path == "/api/source-profile" and method == "POST":
        with L.timed("enrich", "자사 홈페이지 프로파일 갱신"):
            profile = enrich.build_source_profile(force=True)
        return 200, full_state(store.update(lambda st: st.__setitem__("sourceProfile", profile)))

    # --- 1-c. 스니펫으로 받은 cards.json 업로드 ---------------------------
    if path == "/api/upload-cards" and method == "POST":
        cards = normalize.to_cards(body.get("cards") or [])
        if not cards:
            return 400, {"error": "이름이 있는 명함이 없습니다"}
        DATA.mkdir(parents=True, exist_ok=True)
        (DATA / "cards.json").write_text(json.dumps(cards, ensure_ascii=False, indent=2), encoding="utf-8")
        L.log("ok", "ingest", f"업로드 {len(cards)}건")

        st = store.load()
        r = UP.upsert_cards(st.get("cards") or [], cards, mode=body.get("mode") or "upsert")
        st["cards"] = r["cards"]
        st["source"] = "remember-export"
        store.save(st)
        L.log("ok", "ingest",
              f"UPSERT — 추가 {r['inserted']} · 갱신 {r['updated']} · 변화없음 {r['unchanged']}")
        return 200, full_state(store.load(),
                               upsert={k: r[k] for k in ("inserted", "updated", "unchanged", "details")})

    # --- 1. 수집 ---------------------------------------------------------
    if path == "/api/ingest" and method == "POST":
        exported = DATA / "cards.json"
        seed = ASSETS / "seed-cards.json"
        src_file = exported if exported.exists() else seed
        if not src_file.exists():
            return 400, {"error": "가져올 명함 파일이 없습니다 (data/cards.json). 붙여넣기나 스니펫을 먼저 쓰세요."}
        try:
            src = json.loads(src_file.read_text(encoding="utf-8"))
        except ValueError as e:
            return 400, {"error": f"{src_file.name} 을 읽지 못했습니다: {e}"}
        L.log("ok", "ingest", f"{src_file.name} 에서 {len(src)}건 불러옴")

        st = store.load()
        r = UP.upsert_cards(st.get("cards") or [], normalize.to_cards(src),
                            mode=body.get("mode") or "upsert")
        st["cards"] = r["cards"]
        st["source"] = "remember-export" if src_file == exported else "seed-sample"
        st["step"] = max(st.get("step") or 1, 1)
        store.save(st)
        L.log("ok", "ingest",
              f"UPSERT — 추가 {r['inserted']} · 갱신 {r['updated']} · 변화없음 {r['unchanged']}")
        return 200, full_state(store.load(),
                               upsert={k: r[k] for k in ("inserted", "updated", "unchanged", "details")})

    # --- 1-d. 텍스트로 명함 직접 입력 -------------------------------------
    if path == "/api/paste-cards" and method == "POST":
        parsed = normalize.parse_text(body.get("text") or "")
        if not parsed["cards"]:
            return 400, {"error": "명함을 찾지 못했습니다. 이름이 포함된 줄이 있어야 합니다."}
        DATA.mkdir(parents=True, exist_ok=True)
        (DATA / "cards.json").write_text(json.dumps(parsed["cards"], ensure_ascii=False, indent=2), encoding="utf-8")
        L.log("ok", "ingest", f"붙여넣기 {len(parsed['cards'])}건 ({parsed['mode']})")

        st = store.load()
        r = UP.upsert_cards(st.get("cards") or [], parsed["cards"],
                            mode=body.get("mode") or "upsert")
        st["cards"] = r["cards"]
        st["source"] = "paste"
        st["step"] = max(st.get("step") or 1, 1)
        store.save(st)
        L.log("ok", "ingest",
              f"UPSERT — 추가 {r['inserted']} · 갱신 {r['updated']} · 변화없음 {r['unchanged']}")
        return 200, full_state(store.load(), parsedAs=parsed["mode"],
                               upsert={k: r[k] for k in ("inserted", "updated", "unchanged", "details")})

    # --- 2. 발신 설정 + 발송 모드 (HITL) ----------------------------------
    if path == "/api/mode" and method == "POST":
        def apply(st):
            if body.get("mode"):
                st["mode"] = "1:N" if body["mode"] == "1:N" else "1:1"
            if body.get("personaId"):
                st["personaId"] = body["personaId"]
            for c in st["cards"]:
                if not c.get("siteUrl"):
                    c["siteUrl"] = c.get("site") or ""
                if c.get("status") == "NEW":
                    c["status"] = "RESOLVED"
            st["step"] = 2
        return 200, full_state(store.update(apply))

    # --- 2-b. 홈페이지 자동 탐색 ------------------------------------------
    if path == "/api/resolve-sites" and method == "POST":
        st = store.load()
        targets = [c for c in st["cards"]
                   if not c.get("excluded") and c.get("segmentId") != "internal"]
        if not targets:
            return 400, {"error": "홈페이지를 찾을 대상이 없습니다."}
        jid = _job_new("resolve", len(targets))

        def work(job_id: str):
            # 같은 회사 명함이 여러 장이면 홈페이지도 한 곳이다. 명함 수만큼 찾으면
            # 같은 주소를 반복해서 조회하고 AI 추정까지 여러 번 부른다(에이톰 5장 = 5회).
            # 회사명 기준으로 한 번만 찾아 나머지 장에 그대로 나눠 준다.
            done_by_company: dict[str, dict] = {}
            for i, t in enumerate(targets):
                if _job_cancelled(job_id):
                    _job_set(job_id, done=len(targets),
                             current=f"중지됨 — {i}건까지 처리")
                    L.log("warn", "resolve", f"중지 — {i}/{len(targets)}건까지 처리")
                    return
                _job_set(job_id, current=t.get("company") or t.get("name"), done=i)
                cur = store.load()
                c = _card(cur, t["id"])
                if c is None:
                    continue
                if c.get("siteUrl") and (c.get("siteResolve") or {}).get("via") == "card":
                    _job_set(job_id, done=i + 1)
                    continue
                key = (c.get("company") or "").strip().lower()
                if key and key in done_by_company:
                    r = dict(done_by_company[key])
                    r["via"] = "same-company"      # 같은 회사의 결과를 물려받았다
                else:
                    try:
                        r = resolve.resolve_site(c)
                    except Exception as e:
                        # 한 회사를 못 찾아도 나머지는 계속 찾는다. 빈 값이 곧 기본값이다.
                        _job_fail_item(job_id, t.get("company") or t.get("name"), e)
                        r = {"siteUrl": "", "via": "none", "tried": []}
                    if key:
                        done_by_company[key] = r
                c["siteUrl"] = r["siteUrl"]
                c["siteResolve"] = {"via": r["via"], "tried": r["tried"]}
                c["resolved"] = bool(r["siteUrl"])
                if c.get("status") == "NEW":
                    c["status"] = "RESOLVED"
                cur["step"] = 2
                store.save(cur)
                _job_set(job_id, done=i + 1)

        _job_run(jid, work)
        return 202, {"jobId": jid, "total": len(targets), "status": "running"}


    # --- 2-c. 홈페이지 수동 입력 ------------------------------------------
    if path == "/api/set-site" and method == "POST":
        def apply(st):
            c = _card(st, body.get("id"))
            if not c:
                return
            u = str(body.get("site") or "").strip()
            c["siteUrl"] = (u if u.startswith("http") else f"https://{u}") if u else ""
            c["siteResolve"] = {"via": "manual" if u else "none", "tried": []}
        return 200, full_state(store.update(apply))

    # --- 홈페이지 분석 보관본 -----------------------------------------------
    if path == "/api/site-store" and method == "GET":
        return 200, SITE.summary()

    if path == "/api/site-store" and method == "POST":
        # 특정 회사만 다시 분석하고 싶을 때 보관본을 지운다
        if body.get("forget"):
            return 200, {"ok": SITE.forget(body["forget"]), **SITE.summary()}
        return 200, SITE.summary()

    # --- 3-b. 리서치 건너뛰기 -------------------------------------------------
    # 저장된 분석이 있으면 그것으로 채우고 STEP 3 을 통과시킨다.
    # 매번 홈페이지를 다시 읽을 이유가 없다는 요구를 그대로 구현한 것.
    if path == "/api/enrich-skip" and method == "POST":
        used = missing = proxied = 0

        def apply(st):
            nonlocal used, missing, proxied
            for c in st["cards"]:
                if c.get("excluded") or c.get("segmentId") == "internal":
                    continue
                if (c.get("signals") or {}).get("facts"):
                    used += 1
                    continue
                # ① 그 회사의 최근 분석 → ② 같은 업종 다른 회사(프록시) → ③ 업종 표준값
                saved = SITE.get(c.get("siteUrl"), st)
                if saved:
                    c["siteFetch"] = {**(saved.get("fetch") or {}), "fromStore": True}
                    c["signals"] = saved.get("signals") or {}
                    c["status"] = "ENRICHED"
                    used += 1
                    continue

                px = SITE.proxy_for(c.get("segmentId"), c.get("siteUrl"), st)
                if px:
                    c["siteFetch"] = {"ok": False, "reason": "proxy", "chars": 0, "fromStore": True}
                    c["signals"] = px
                    c["status"] = "ENRICHED"
                    proxied += 1
                    continue

                c["signals"] = SF.signals_for(c.get("segmentId"), "저장된 분석·유사업종 자료 없음")
                c["status"] = "ENRICHED"
                missing += 1
            st["step"] = 3
        st2 = store.update(apply)
        L.log("ok", "enrich",
              f"리서치 건너뜀 — 보관본 {used}건 · 유사업종 {proxied}건 · 업종 표준값 {missing}건")
        return 200, full_state(st2, skipped={"used": used, "proxy": proxied, "fallback": missing})

    # --- 발송 이력 전체 삭제 -----------------------------------------------
    # 문안·승인·발송 기록만 지운다. 명함과 리서치 근거는 남긴다.
    # 명함까지 지우려면 [전체 초기화] 를 쓴다 — 둘을 갈라 두어야
    # "이력만 정리하려다 명함을 통째로 잃는" 사고가 안 난다.
    if path == "/api/clear-history" and method == "POST":
        n = 0

        def apply(st):
            nonlocal n
            for c in st["cards"]:
                if not c.get("message"):
                    continue
                n += 1
                for k in ("message", "deliveredAt", "queuedAt", "deliverError"):
                    c.pop(k, None)
                # 상태는 리서치까지 되돌린다. 근거가 있으면 ENRICHED, 없으면 분류 상태.
                c["status"] = "ENRICHED" if (c.get("signals") or {}).get("facts") else "SCORED"
            st["templates"] = {}
            st["step"] = 4
        st2 = store.update(apply)
        L.log("warn", "deliver", f"발송 이력 전체 삭제 — {n}건 (명함·근거는 유지)")
        return 200, full_state(st2, cleared=n)

    # --- 시나리오 실행 기록 -------------------------------------------------
    # 화면 메모리에만 두면 새로고침에 사라진다. 어제 돌린 결과를 오늘 다시
    # 봐야 하는 일이 잦으므로 DB(meta)에 남긴다.
    if path == "/api/scenario" and method == "POST":
        run = body.get("run") or {}

        def apply(st):
            st["scenarioRun"] = {
                "results": run.get("results") or {},
                "startedAt": run.get("startedAt"),
                "finishedAt": run.get("finishedAt"),
                "status": run.get("status") or "running",
                "savedAt": time.time(),
            }
        return 200, full_state(store.update(apply))

    if path == "/api/scenario" and method == "GET":
        return 200, {"run": store.load().get("scenarioRun")}

    # --- 관리자 설정 (톱니바퀴) ---------------------------------------------
    # .env 를 화면에서 직접 읽고 고친다. 이 서버에는 로그인이 없으므로
    # 비밀값은 기본적으로 가려서 내보내고, 명시적으로 요청할 때만 원문을 준다.
    if path == "/api/settings" and method == "GET":
        return 200, {"items": settings_view(reveal=False)}

    if path == "/api/settings" and method == "POST":
        if body.get("reveal"):
            # 이 서버에는 로그인이 없다. 배포해 두면 주소를 아는 누구나 이 엔드포인트를
            # 두드려 .env 원문(API 키·앱 비밀번호)을 그대로 받아 갈 수 있다.
            # 그래서 원문은 이 컴퓨터에서 연 화면(루프백)에만 준다.
            # 배포 환경의 비밀값은 화면이 아니라 호스팅의 환경변수로 넣는 것이 맞다.
            if not _is_local(peer):
                return 403, {"error": "비밀값 원문은 이 프로그램을 실행한 컴퓨터에서만 볼 수 있습니다. "
                                      "배포된 주소에서는 열 수 없습니다. "
                                      "배포 환경의 비밀값은 호스팅(Render 등)의 환경변수로 넣으세요."}
            return 200, {"items": settings_view(reveal=True)}
        updates = body.get("updates") or {}
        if not isinstance(updates, dict) or not updates:
            return 400, {"error": "바꿀 항목이 없습니다."}
        try:
            r = write_env({str(k): str(v) for k, v in updates.items()})
        except ValueError as e:
            # 파일을 깨뜨릴 입력. 화면에 그대로 보여 준다 (500 으로 삼키면 원인을 알 수 없다).
            L.log("error", "settings", f"설정 저장 거부 — {e}")
            return 400, {"error": str(e)}
        llm.resolve_backend(refresh=True)       # 백엔드 설정이 바뀌었을 수 있다
        L.log("ok", "settings", f"설정 변경 — 수정 {len(r['changed'])} · 추가 {len(r['added'])} · 삭제 {len(r['removed'])}",
              {"keys": r["changed"] + r["added"] + r["removed"]})
        needs_restart = any(k in ("PORT", "TENANT_ID") for k in updates)
        return 200, {"items": settings_view(reveal=False), "result": r, "needsRestart": needs_restart}

    # --- 3. 리서치 --------------------------------------------------------
    if path == "/api/enrich" and method == "POST":
        # AI 가 없어도 멈추지 않는다. 여기서 400 을 돌려주면 4~7단계가 통째로 안 열려
        # "AI 가 잠깐 죽으면 오늘 캠페인을 못 돈다"가 된다.
        # 대신 홈페이지는 그대로 읽고, 사실 추출만 업종 표준값으로 대체한다.
        # 대체분은 kind='sector' 로 표시돼 화면·검토에서 확인된 사실과 갈라 보인다.
        b = llm.resolve_backend(refresh=True)
        no_ai = b["name"] == "none"
        if no_ai:
            L.log("warn", "enrich",
                  f"AI 없이 진행 — 업종 표준값으로 대체합니다. ({b.get('hint', '')})")

        st = store.load()
        ids = body.get("ids") or []
        targets = [c for c in st["cards"] if not ids or c["id"] in ids]
        if not targets:
            return 400, {"error": "리서치할 대상이 없습니다."}
        jid = _job_new("enrich", len(targets))

        def work(job_id: str):
            cur = store.load()
            # 업종 표준값은 고객군을 알아야 고를 수 있는데, 분류는 4단계라 아직 안 돌았다.
            # 그대로 두면 리서치가 실패했을 때 대체값이 빈 목록이 되어 대체의 의미가 없다.
            # 회사명 키워드 분류는 AI 를 쓰지 않아 즉시 끝나므로 여기서 먼저 채워 둔다.
            # (4단계에서 사람이 다시 바꿀 수 있고, AI 분류도 그때 덧씌운다.)
            pre = 0
            for c in cur["cards"]:
                if not c.get("segmentId") or c["segmentId"] == "unclassified":
                    r = classify(c)
                    if r["segmentId"] not in ("unclassified", "excluded"):
                        c["segmentId"] = r["segmentId"]
                        c["segmentSource"] = "keyword"
                        pre += 1
            if pre:
                L.log("info", "enrich", f"표준값을 고르기 위해 {pre}건을 키워드로 미리 분류했습니다")
                store.save(cur)
                # targets 는 이 작업이 시작될 때 떠 둔 스냅샷이라 방금 채운 고객군이 없다.
                # 그대로 두면 SF.signals_for(None) 이 되어 표준값이 빈 목록으로 나온다.
                fresh = {c["id"]: c for c in cur["cards"]}
                targets[:] = [fresh.get(t["id"], t) for t in targets]
            if not cur.get("sourceProfile"):
                cur["sourceProfile"] = enrich.build_source_profile()
                store.save(cur)
            # 같은 주소를 명함 수만큼 읽으면 상대 서버에도 부담이고 AI 비용도 그만큼 든다.
            # 주소 하나당 한 번만 읽고, 뽑아낸 근거는 같은 주소·같은 고객군끼리 나눠 쓴다.
            seen_site: dict[str, dict] = {}
            seen_signals: dict[tuple, dict] = {}
            for i, t in enumerate(targets):
                if _job_cancelled(job_id):
                    # 사람이 중지를 눌렀다. 여기서 그냥 멈추면 남은 대상은 근거가 없어
                    # 5단계에서 통째로 빠진다. 표준값으로 채워 7단계까지 갈 수 있게 둔다.
                    rest = targets[i:]
                    cur = store.load()
                    for r in rest:
                        c = _card(cur, r["id"])
                        if c is None or (c.get("signals") or {}).get("facts"):
                            continue
                        c["signals"] = SF.signals_for(r.get("segmentId"), "사용자가 리서치를 중지함")
                        c["status"] = "ENRICHED"
                    cur["step"] = 3
                    store.save(cur)
                    _job_set(job_id, done=len(targets),
                             current=f"중지됨 — 남은 {len(rest)}건은 업종 표준값으로 채웠습니다")
                    L.log("warn", "enrich", f"중지 — 남은 {len(rest)}건 표준값 대체")
                    return
                _job_set(job_id, current=t.get("company") or t.get("name"), done=i)
                url_key = (t.get("siteUrl") or "").strip().lower()
                # 지난 실행에서 이미 분석해 둔 회사면 그대로 쓴다.
                # 회사 홈페이지는 하루 이틀에 바뀌지 않는다. 다시 읽을 이유가 없고,
                # 상대 서버에도 반복 부담이다. (기한·강제 재분석은 site_store 가 판단)
                if not body.get("force"):
                    saved = SITE.get(t.get("siteUrl"))
                    if saved:
                        cur = store.load()
                        c = _card(cur, t["id"])
                        if c is not None:
                            c["siteFetch"] = {**(saved.get("fetch") or {}), "fromStore": True}
                            c["signals"] = saved.get("signals") or {}
                            c["status"] = "ENRICHED"
                        cur["step"] = 3
                        store.save(cur)
                        _job_set(job_id, done=i + 1)
                        L.log("ok", "enrich",
                              f"{t.get('company')} — 저장된 분석 재사용 "
                              f"({round(float(saved.get('savedAt', 0)) and (time.time()-float(saved['savedAt']))/3600 or 0, 1)}시간 전)")
                        continue

                if url_key and url_key in seen_site:
                    site = seen_site[url_key]
                else:
                    try:
                        site = enrich.fetch_site(t.get("siteUrl"))
                    except Exception as e:
                        _job_fail_item(job_id, t.get("company") or t.get("name"), e)
                        site = {"ok": False, "reason": f"fetch-error: {e}"[:80], "text": ""}
                    if url_key:
                        seen_site[url_key] = site
                # 본문이 비었으면 AI 를 부르지 않는다.
                # 읽은 게 없는데 회사명만 보고 "안전진단 서비스 제공" 같은 문장을 지어내면,
                # 그게 화면에 "확인된 사실" 로 올라가 그대로 메일에 인용된다.
                # 업종 기본값은 최소한 일반론이라고 표시되지만 이건 표시조차 안 된다.
                MIN_CHARS = 200
                if len(site.get("text") or "") < MIN_CHARS:
                    L.log("warn", "enrich",
                          f"{t.get('company')} — 본문 {len(site.get('text') or '')}자, "
                          f"AI 추출을 건너뛰고 업종 기본값을 씁니다")
                    signals = SF.signals_for(
                        t.get("segmentId"),
                        f"홈페이지 본문 {len(site.get('text') or '')}자 (자바스크립트 렌더링 등)")
                    # 이번에 분석한 결과를 보관한다. 다음 실행에서 같은 회사는 다시 읽지 않는다.
                    SITE.put(t.get("siteUrl"), site, signals,
                         segment_id=t.get("segmentId"), company=t.get("company"))
                    cur = store.load()
                    c = _card(cur, t["id"])
                    if c is not None:
                        c["siteFetch"] = {"ok": site["ok"], "reason": site["reason"],
                                          "chars": len(site.get("text") or "")}
                        c["signals"] = signals
                        c["status"] = "ENRICHED"
                    cur["step"] = 3
                    store.save(cur)
                    _job_set(job_id, done=i + 1)
                    continue

                sig_key = (url_key, t.get("segmentId"))
                if no_ai:
                    # AI 가 아예 없으면 72번 호출해 72번 실패시킬 이유가 없다.
                    signals = SF.signals_for(t.get("segmentId"), "AI 백엔드 없음")
                elif url_key and sig_key in seen_signals:
                    signals = seen_signals[sig_key]        # 같은 회사 = 같은 근거
                else:
                    try:
                        signals = enrich.extract_signals(t, site["text"])
                    except Exception as e:
                        # AI 가 실패해도 파이프라인은 멈추지 않는다.
                        _job_fail_item(job_id, t.get("company") or t.get("name"), e)
                        # 표준값보다 같은 업종 실제 회사의 분석이 한 단계 더 구체적이다.
                        # (이 대입은 반드시 except 안에 있어야 한다. 밖에 두면 홈페이지를
                        #  제대로 읽어 뽑은 사실까지 덮어쓰고, e 가 없어 NameError 로 죽는다.)
                        signals = (SITE.proxy_for(t.get("segmentId"), t.get("siteUrl"))
                                   or SF.signals_for(t.get("segmentId"), f"{type(e).__name__}"))
                    if url_key:
                        seen_signals[sig_key] = signals

                # AI 는 성공했는데 건질 사실이 없는 경우(자바스크립트 렌더링 사이트 등)도
                # 같은 취급을 한다. 근거 0개로 두면 그 대상만 통째로 빠진다.
                if not (signals or {}).get("facts"):
                    fb = SF.signals_for(t.get("segmentId"), site.get("reason") or "근거 없음")
                    if fb["facts"]:
                        signals = fb
                cur = store.load()
                c = _card(cur, t["id"])
                if c is not None:
                    c["siteFetch"] = {"ok": site["ok"], "reason": site["reason"],
                                      "chars": len(site["text"])}
                    c["signals"] = signals
                    c["status"] = "ENRICHED"
                cur["step"] = 3
                store.save(cur)
                _job_set(job_id, done=i + 1)

        _job_run(jid, work)
        return 202, {"jobId": jid, "total": len(targets), "status": "running"}


    # --- 3-b. 프롬프트 미리보기 -------------------------------------------
    if path == "/api/prompt-preview" and method == "POST":
        st = store.load()
        common = dict(channel=body.get("channel", "email"), persona_id=st.get("personaId"),
                      source_profile=st.get("sourceProfile"))
        cid = body.get("id")
        if st.get("mode") == "1:N" or not cid:
            sid = body.get("segmentId") or next((c.get("segmentId") for c in st["cards"] if c.get("segmentId")), None)
            sg = seg_of(sid)
            if not sg:
                return 200, {"prompt": "", "note": "고객군을 먼저 분류하세요 (STEP 4)."}
            guide = (st.get("copyPicked") or {}).get(sid) or []
            return 200, {"mode": "1:N", "segment": sg["label"],
                         "prompt": generate.build_segment_prompt(sg, copy_guide=guide, **common)}
        c = _card(st, cid)
        sg = seg_of((c or {}).get("segmentId"))
        if not c or not sg:
            return 200, {"prompt": "", "note": "고객군을 먼저 분류하세요 (STEP 4)."}
        guide = (st.get("copyPicked") or {}).get(sg["id"]) or []
        return 200, {"mode": "1:1", "target": f"{c.get('name')} · {c.get('company')}",
                     "prompt": generate.build_prompt(c, sg, c.get("signals") or {"facts": []},
                                                     copy_guide=guide, **common)}

    # --- 4. 고객군 분류 + 선택 (HITL) --------------------------------------
    if path == "/api/segment" and method == "POST":
        # 사람이 표에서 직접 고른 고객군과 AI 가 판단한 결과는 다시 덮지 않는다.
        # 규칙은 회사명만 보므로, 사람·AI 가 더 많은 근거로 내린 판단을 이길 수 없다.
        # force:true 를 주면 전부 다시 판정한다.
        KEEP_SOURCES = ("manual", "ai", "fallback")
        force = bool(body.get("force"))
        rescored = {"n": 0, "kept": 0}

        def rule(st):
            for c in st["cards"]:
                if not force and c.get("segmentSource") in KEEP_SOURCES:
                    rescored["kept"] += 1
                    if c.get("status") in (None, "NEW", "RESOLVED"):
                        c["status"] = "SCORED"
                    continue
                r = classify(c)
                c["segmentId"] = r["segmentId"]
                c["segmentScore"] = r["score"]
                c["segmentSource"] = ("rule" if r["segmentId"] in ("internal", "excluded")
                                      else (None if r["segmentId"] == "unclassified" else "keyword"))
                c["status"] = "SCORED"
                rescored["n"] += 1
            st["step"] = 4
        st = store.update(rule)
        if rescored["kept"]:
            L.log("ok", "segment",
                  f"규칙 분류 {rescored['n']}건 · 사람/AI 판단 {rescored['kept']}건은 그대로 둠")

        if body.get("useAi"):
            st = store.load()
            # 이미 AI 가 판단한 건은 다시 묻지 않는다. 같은 입력에 같은 답이 나오고,
            # 건당 수 초씩 걸리므로 반복 호출은 시간과 토큰만 쓴다.
            todo = [c for c in st["cards"]
                    if not c.get("excluded") and c.get("segmentId") == "unclassified"
                    and not (c.get("segmentAi") and not force)]
            skipped = sum(1 for c in st["cards"]
                          if c.get("segmentAi") and c.get("segmentId") == "unclassified")
            L.log("info", "segment",
                  f"AI 분류 — {len(todo)}건"
                  + (f" (이미 판단한 {skipped}건은 건너뜀)" if skipped and not force else ""))
            if not todo:
                return 200, full_state(store.load(), nothingToDo=True)
            for c in todo:
                r = classify_ai.classify_one(c)
                c["segmentId"] = r["segmentId"]
                c["segmentSource"] = None if r["segmentId"] == "unclassified" else "ai"
                c["segmentAi"] = {"confidence": r["confidence"], "reason": r["reason"]}
            st = store.save(st)

        # 끝내 분류되지 않은 명함을 기본 고객군으로 대체한다.
        # 미분류는 발송 대상에서 빠져 파이프라인이 거기서 끊긴다.
        # 대신 segmentSource='fallback' 으로 표시해 검토에서 구분되게 한다.
        # 기본값은 '대체함' 이다. 미분류로 두면 그 명함은 발송 대상에서 통째로 빠져
        # 5~7단계가 아예 열리지 않는다(대상 0건). fallback:false 로 끔 수 있다.
        if body.get("fallback", True):
            default_seg = body.get("defaultSegment") or env("DEFAULT_SEGMENT") or "office"

            if default_seg and seg_of(default_seg):
                def apply_fb(st):
                    n = 0
                    for c in st["cards"]:
                        if c.get("excluded") or c.get("segmentId") != "unclassified":
                            continue
                        c["segmentId"] = default_seg
                        c["segmentSource"] = "fallback"
                        n += 1
                    if n:
                        L.log("warn", "segment",
                              f"미분류 {n}건을 기본 고객군 '{default_seg}' 으로 대체했습니다")
                store.update(apply_fb)
                return 200, full_state(store.load())
        return 200, full_state(st)

    # --- 4-a2. 고객군 수동 지정 --------------------------------------------
    # AI 는 확신이 없으면 unclassified 로 두도록 설계돼 있다(억지 분류가 엉뚱한 메일이 되므로).
    # 그래서 사람이 뒤집을 수단이 반드시 있어야 한다. 이 엔드포인트가 그 수단이다.
    if path == "/api/set-segment" and method == "POST":
        sid = body.get("segmentId")
        valid = {s["id"] for s in SEGMENTS} | {"unclassified", "internal"}
        if sid not in valid:
            return 400, {"error": f"알 수 없는 고객군입니다: {sid}"}

        def apply(st):
            c = _card(st, body.get("id"))
            if not c:
                return
            c["segmentId"] = sid
            c["segmentSource"] = "manual"
            c["segmentAi"] = None
            if sid == "internal":
                st["selection"] = [i for i in st.get("selection", []) if i != c["id"]]
        L.log("ok", "segment", f"수동 지정 — {body.get('id')} → {sid}")
        return 200, full_state(store.update(apply))

    # --- 4-b. 관심사 추정 --------------------------------------------------
    if path == "/api/interests" and method == "POST":
        st = store.load()
        ids = body.get("ids") or ([body["id"]] if body.get("id") else None)
        targets = [c for c in _usable(st) if not ids or c["id"] in ids]
        if not ids:
            targets = [c for c in targets if c["id"] in (st.get("selection") or [])] or targets
        L.log("info", "interest", f"관심사 추정 — {len(targets)}건")
        for c in targets:
            c["interests"] = classify_ai.infer_interests(c, c.get("signals"), seg_of(c.get("segmentId")))
        return 200, full_state(store.save(st))

    # --- 명함 CRUD ---------------------------------------------------------
    if path == "/api/card-add" and method == "POST":
        raw = body.get("card") or {}
        made = normalize.to_cards([raw])
        if not made:
            return 400, {"error": "이름이 없습니다. 이름은 반드시 필요합니다."}
        c = made[0]
        # to_cards 는 연락처 기본 필드만 알고, met_at 같은 곳에 기본값('명함 교환')을
        # 채워 넣는다. 사람이 직접 입력한 값이 그 기본값에 덮이면 안 되므로
        # 입력이 있으면 무조건 입력을 이긴다. 스키마에 있는 키만 받아 오염을 막는다.
        for k in schema.TEXT_KEYS:
            v = raw.get(k)
            if v not in (None, ""):
                c[k] = v

        def apply(st):
            # id 는 기존 목록과 겹치지 않게 새로 준다 (to_cards 는 0번부터 매긴다).
            used = {x["id"] for x in st["cards"]}
            n = 0
            while f"m{n:04d}" in used:
                n += 1
            c["id"] = f"m{n:04d}"
            c["status"] = "NEW"
            c["segmentId"] = classify(c)["segmentId"]
            st["cards"].append(c)
        L.log("ok", "card", f"명함 추가 — {c.get('name')} · {c.get('company')}")
        return 200, full_state(store.update(apply))

    if path == "/api/send-one" and method == "POST":
        # 발송 이력에서 한 건만 바로 보낸다. 전체 발송과 같은 함수를 타므로
        # DRY_RUN·야간 차단 같은 안전장치가 그대로 적용된다.
        from datetime import datetime, timezone
        c = _card(store.load(), body.get("id"))
        if not c or not c.get("message"):
            return 400, {"error": "그런 문안이 없습니다."}
        if (c.get("message") or {}).get("reviewStatus") != "APPROVED":
            return 400, {"error": "승인된 문안만 보낼 수 있습니다. STEP 6 에서 먼저 승인하세요."}
        if c.get("excluded") or c.get("segmentId") == "internal":
            return 400, {"error": f"{c.get('name')} 님은 자사·제외 명함이라 발송할 수 없습니다."}
        if not c.get("email"):
            return 400, {"error": f"{c.get('name')} 님의 수신 이메일 주소가 없습니다. "
                                  f"STEP 1 표에서 [수정]으로 넣어 주세요."}
        r = deliver.send_email(c["email"], c["message"].get("subject"), c["message"].get("body"))
        now = datetime.now(timezone.utc).isoformat()

        def apply(st):
            t2 = _card(st, c["id"])
            if not t2:
                return
            t2["status"] = "SENT" if r["ok"] else "SEND_FAILED"
            t2["deliveredAt"] = now
            t2["deliverError"] = None if r["ok"] else r.get("error")
        L.log("ok" if r["ok"] else "error", "deliver",
              f"즉시 발송 {c.get('name')} — {'성공' if r['ok'] else r.get('error')}")
        return 200, full_state(store.update(apply),
                               results=[{"id": c["id"], "to": c["email"], "sent": r["ok"],
                                         "note": r.get("messageId") or r.get("error")}])

    if path == "/api/dequeue" and method == "POST":
        # 큐 적재는 되돌릴 수 있어야 한다. 승인 상태는 건드리지 않고 큐에서만 뺀다.
        # (id 를 주면 그 건만, 없으면 큐에 있는 것 전부)
        cid = body.get("id")

        def apply(st):
            n = 0
            for c in st["cards"]:
                if c.get("status") != "QUEUED" or (cid and c["id"] != cid):
                    continue
                approved = (c.get("message") or {}).get("reviewStatus") == "APPROVED"
                c["status"] = "APPROVED" if approved else "DRAFTED"
                c["queuedAt"] = None
                n += 1
            L.log("ok", "deliver", f"큐에서 뺌 — {n}건")
        return 200, full_state(store.update(apply))

    if path == "/api/logout" and method == "POST":
        return 200, {"ok": True, "__clear_cookie": True}

    if path == "/api/card-top" and method == "POST":
        # 표의 순서는 store 가 목록 순서(ord)로 저장한다. 목록에서 앞으로 옮기면 그대로 남는다.
        cid = body.get("id")

        def apply(st):
            cards = st["cards"]
            i = next((k for k, c in enumerate(cards) if c["id"] == cid), None)
            if i is None or i == 0:
                return
            cards.insert(0, cards.pop(i))
        return 200, full_state(store.update(apply))

    if path == "/api/card-delete" and method == "POST":
        cid = body.get("id")

        def apply(st):
            st["cards"] = [x for x in st["cards"] if x["id"] != cid]
            st["selection"] = [i for i in st.get("selection", []) if i != cid]
        L.log("warn", "card", f"명함 삭제 — {cid}")
        return 200, full_state(store.update(apply))

    if path == "/api/card-update" and method == "POST":
        def apply(st):
            c = _card(st, body.get("id"))
            if not c:
                return
            for k in schema.TEXT_KEYS:
                if body.get(k) is not None:
                    c[k] = body[k]
            c["segmentId"] = classify(c)["segmentId"]
        return 200, full_state(store.update(apply))

    # --- 명함 개별 제외 ----------------------------------------------------
    if path == "/api/exclude" and method == "POST":
        def apply(st):
            c = _card(st, body.get("id"))
            if not c:
                return
            c["excluded"] = bool(body.get("excluded", True))
            c["segmentId"] = classify(c)["segmentId"]
            if c["excluded"]:
                st["selection"] = [x for x in st.get("selection", []) if x != c["id"]]
        return 200, full_state(store.update(apply))

    if path == "/api/selection" and method == "POST":
        def apply(st):
            # 자사(에이톰) 명함은 어떤 경로로도 발송 대상이 되지 않게 서버에서 막는다.
            blocked = {c["id"] for c in st["cards"]
                       if c.get("segmentId") in ("internal", "excluded") or c.get("excluded")}
            st["selection"] = [i for i in (body.get("ids") or []) if i not in blocked]
        return 200, full_state(store.update(apply))

    # --- 5-a. 문구 스튜디오 -------------------------------------------------
    # --- 통계 -------------------------------------------------------------
    # 화면이 직접 세지 않고 서버가 한 번에 준다. 같은 수를 두 곳에서 따로 세면
    # 어느 쪽이 맞는지 알 수 없게 되고, 실제로 그런 어긋남이 몇 번 있었다.
    if path == "/api/stats" and method == "GET":
        st = store.load()
        cards = st.get("cards") or []
        sel = set(st.get("selection") or [])
        usable = [c for c in cards if not c.get("excluded") and c.get("segmentId") != "internal"]

        def facts_of(c):
            return ((c.get("signals") or {}).get("facts")) or []

        def msg_of(c):
            return c.get("message") or {}

        drafted = [c for c in cards if msg_of(c) and not msg_of(c).get("error")]
        held = [c for c in cards if msg_of(c).get("error")]
        approved = [c for c in cards if msg_of(c).get("reviewStatus") == "APPROVED"]
        rejected = [c for c in cards if msg_of(c).get("reviewStatus") == "REJECTED"]
        sent = [c for c in cards if c.get("status") == "SENT"]

        # 퍼널: 앞 단계의 부분집합이라 줄어드는 것이 정상이다.
        funnel = [
            {"key": "대상", "n": len(usable), "note": "자사·제외를 뺀 발송 후보"},
            {"key": "홈페이지", "n": sum(1 for c in usable if c.get("siteUrl")), "note": "주소를 확보한 회사"},
            {"key": "근거", "n": sum(1 for c in usable if facts_of(c)), "note": "메일에 인용할 사실이 있는 회사"},
            {"key": "선택", "n": sum(1 for c in usable if c["id"] in sel), "note": "사람이 고른 발송 대상"},
            # 퍼널은 앞 단계의 부분집합이어야 읽힌다. 그래서 '대상' 안에서만 센다.
            # (자사·제외 명함이 예전 실행의 문안을 갖고 있으면 전체 수는 대상보다 커진다)
            {"key": "초안", "n": sum(1 for c in usable if msg_of(c) and not msg_of(c).get("error")),
             "note": "문안이 만들어진 건"},
            {"key": "승인", "n": sum(1 for c in usable if msg_of(c).get("reviewStatus") == "APPROVED"),
             "note": "사람이 승인한 건"},
            {"key": "발송", "n": sum(1 for c in usable if c.get("status") == "SENT"),
             "note": "실제로 나간 건"},
        ]
        # 대상 밖(자사·제외)에 남아 있는 문안. 있으면 화면이 이유를 밝힌다.
        stale = [c for c in cards
                 if c.get("message") and (c.get("excluded") or c.get("segmentId") == "internal")]

        # 고객군별
        by = {}
        for c in usable:
            sid = c.get("segmentId") or "unclassified"
            b = by.setdefault(sid, {
                "segmentId": sid,
                "label": (seg_of(sid) or {}).get("label") if seg_of(sid) else "미분류",
                "target": 0, "facts": 0, "drafted": 0, "approved": 0, "sent": 0,
            })
            b["target"] += 1
            if facts_of(c):
                b["facts"] += 1
            m = msg_of(c)
            if m and not m.get("error"):
                b["drafted"] += 1
            if m.get("reviewStatus") == "APPROVED":
                b["approved"] += 1
            if c.get("status") == "SENT":
                b["sent"] += 1
        segments = sorted(by.values(), key=lambda b: (-b["target"], b["label"]))

        # 근거가 어디서 왔는가 — 추정과 확인을 갈라 세는 것이 이 화면의 요점이다.
        EV = {"홈페이지 직접 분석": 0, "같은 업종 사례": 0, "업종 표준값": 0, "근거 없음": 0}
        for c in usable:
            sg = c.get("signals") or {}
            if not sg.get("facts"):
                EV["근거 없음"] += 1
            elif sg.get("kind") == "sector":
                EV["업종 표준값"] += 1
            elif sg.get("kind") == "proxy":
                EV["같은 업종 사례"] += 1
            else:
                EV["홈페이지 직접 분석"] += 1

        VIA_LABEL = {"card": "명함에 적힌 주소", "email-domain": "이메일 도메인",
                     "llm-guess": "AI 추정", "manual": "직접 입력",
                     "same-company": "같은 회사에서 물려받음", "none": "찾지 못함"}
        via = {}
        for c in usable:
            v = (c.get("siteResolve") or {}).get("via")
            key = VIA_LABEL.get(v) or ("있음" if c.get("siteUrl") else "탐색 안 함")
            via[key] = via.get(key, 0) + 1

        status = {}
        for c in cards:
            if not c.get("message"):
                continue
            k = c.get("status") or "-"
            status[k] = status.get(k, 0) + 1

        errors = {}
        for c in cards:
            e = (c.get("deliverError") or "").strip()
            if e:
                errors[e[:70]] = errors.get(e[:70], 0) + 1

        return 200, {
            "totals": {
                "cards": len(cards), "usable": len(usable),
                "excluded": sum(1 for c in cards if c.get("excluded")),
                "internal": sum(1 for c in cards if c.get("segmentId") == "internal"),
                "selected": len(sel), "drafted": len(drafted), "held": len(held),
                "approved": len(approved), "rejected": len(rejected), "sent": len(sent),
                "noEmail": sum(1 for c in usable if not c.get("email")),
                "staleOutside": len(stale),
            },
            "funnel": funnel,
            "segments": segments,
            "evidence": [{"key": k, "n": v} for k, v in EV.items()],
            "siteVia": sorted([{"key": k, "n": v} for k, v in via.items()], key=lambda r: -r["n"]),
            "status": sorted([{"key": k, "n": v} for k, v in status.items()], key=lambda r: -r["n"]),
            "errors": sorted([{"key": k, "n": v} for k, v in errors.items()], key=lambda r: -r["n"])[:8],
            "scenario": st.get("scenarioRun") or None,
        }

    if path == "/api/copy-keywords" and method == "POST":
        st = store.load()
        c = _card(st, body.get("id")) if body.get("id") else None
        if c is None:
            sel = st.get("selection") or []
            c = next((x for x in st["cards"] if x["id"] in sel), None) or next(iter(_usable(st)), None)
        sid = body.get("segmentId") or (c or {}).get("segmentId")
        return 200, {"groups": copy_ai.keyword_palette(c, seg_of(sid), st.get("sourceProfile")),
                     "tones": copy_ai.TONES, "kinds": copy_ai.KINDS,
                     "target": {"id": (c or {}).get("id"), "name": (c or {}).get("name"),
                                "company": (c or {}).get("company"), "segmentId": sid}}

    if path == "/api/copy-suggest" and method == "POST":
        st = store.load()
        c = _card(st, body.get("id")) if body.get("id") else None
        if c is None:
            sel = st.get("selection") or []
            c = next((x for x in st["cards"] if x["id"] in sel), None) or next(iter(_usable(st)), None)
        sid = body.get("segmentId") or (c or {}).get("segmentId")
        # 문구 추천은 AI 호출이라 20~30초가 걸린다(실측 24.1초). 그동안 HTTP 응답을
        # 붙잡고 있으면 연결이 먼저 끊겨, 화면에서는 눌러도 아무 일이 일어나지 않는다.
        # 리서치·문안 생성·발송과 똑같이 작업으로 돌리고 진행률을 물어보게 한다.
        jid = _job_new("copy", 1)

        def work(job_id: str):
            _job_set(job_id, current="문구 뽑는 중")
            r = copy_ai.suggest(c, sid, keywords=body.get("keywords"), tones=body.get("tones"),
                                channel=body.get("channel", "email"), count=body.get("count", 30),
                                source_profile=st.get("sourceProfile"), persona_id=st.get("personaId"))

            def apply(s):
                s.setdefault("copy", {})[sid or "_"] = {"items": r["items"], "source": r["source"]}
            store.update(apply)
            # /api/job 이 끝날 때 full_state 위에 이 값들을 얹어 준다. 화면은 S.copy 를 읽는다.
            _job_set(job_id, done=1, copy=r, copySegmentId=sid)

        _job_run(jid, work)
        return 202, {"jobId": jid, "total": 1, "status": "running"}

    if path == "/api/copy-pick" and method == "POST":
        sid = body.get("segmentId") or "_"

        def apply(st):
            picked = dict(st.get("copyPicked") or {})
            picked[sid] = [str(t) for t in (body.get("texts") or [])]
            st["copyPicked"] = picked
        return 200, full_state(store.update(apply))

    # --- 5-b. 문안 생성 -----------------------------------------------------
    # 로컬 모델은 1건에 1분 안팎이 걸린다. 한 요청에 전부 처리하면 HTTP 타임아웃에
    # 걸리므로 batch 건만 만들고 remaining 을 돌려준다.
    # --- 5. 문안 생성 (백그라운드 작업) --------------------------------------
    # 로컬 모델은 한 건에 5분이 넘는다. 응답을 붙잡고 기다리면 클라이언트가 먼저 끊는다.
    # 즉시 작업 번호를 주고, 화면은 /api/job 으로 진행률을 물어본다.
    if path == "/api/generate" and method == "POST":
        channel = body.get("channel", "email")
        restart = bool(body.get("restart"))

        st = store.load()
        sel = set(st.get("selection") or [])
        targets = [c for c in st["cards"] if c["id"] in sel]
        if not targets:
            return 400, {"error": "발송 대상이 없습니다. STEP 4 에서 먼저 선택하세요."}

        # 승인된 문안은 사람이 읽고 손본 결과다. 다시 만들기로 덮어쓰면
        # 그 검토가 통째로 사라진다. 명시적으로 force 를 주지 않는 한 지킨다.
        keep = {c["id"] for c in targets
                if (c.get("message") or {}).get("reviewStatus") == "APPROVED"}
        if restart and not body.get("force"):
            targets_before = len(targets)
            targets = [c for c in targets if c["id"] not in keep]
            if keep:
                L.log("warn", "generate",
                      f"승인된 {len(keep)}건은 다시 만들지 않습니다 (전체 {targets_before}건 중)")

        if restart:
            st["templates"] = {}
            for c in targets:
                if c["id"] in keep:
                    continue
                c.pop("message", None)
            store.save(st)

        mode = st.get("mode")
        if not restart:
            # 아직 문안이 없는 대상만 만든다. 매번 전부 다시 만들 이유가 없다.
            targets = [c for c in targets if not c.get("message")]
            if not targets:
                return 200, full_state(store.load(), nothingToDo=True)

        total = (len({c.get("segmentId") for c in targets if c.get("segmentId")})
                 if mode == "1:N" else len(targets))
        jid = _job_new("generate", total)

        def work(job_id: str):
            picked = (store.load().get("copyPicked") or {})
            common = dict(channel=channel, persona_id=store.load().get("personaId"),
                          source_profile=store.load().get("sourceProfile"))

            if mode == "1:N":
                seg_ids = [x for x in dict.fromkeys(c.get("segmentId") for c in targets) if x]
                for i, sid in enumerate(seg_ids):
                    if _job_cancelled(job_id):
                        _fill_sector_messages(job_id, seg_ids[i:], sel, channel,
                                              common.get("persona_id"), mode="1:N")
                        return
                    _job_set(job_id, current=f"고객군 {sid}", done=i)
                    L.log("info", "generate", f"1:N 공통 문안 생성 — {sid}")
                    try:
                        tpl = generate.generate_segment_template(
                            sid, copy_guide=picked.get(sid) or [], **common)
                    except Exception as e:
                        _job_fail_item(job_id, f"고객군 {sid}", e)
                        tpl = None
                    if not tpl or tpl.get("error"):
                        seg = seg_of(sid)
                        if seg:
                            base = SF.template_for(seg, persona_of(common.get("persona_id")), COMPANY)
                            tpl = generate.apply_compliance(base, channel, common.get("persona_id"))
                            tpl["kind"] = "sector"
                            tpl.pop("error", None)
                            L.log("warn", "generate", f"고객군 {sid} — 업종 기본 문안으로 대체")
                    cur = store.load()
                    tpls = dict(cur.get("templates") or {})
                    tpls[sid] = tpl
                    cur["templates"] = tpls
                    for c in cur["cards"]:
                        if c["id"] not in sel or c.get("segmentId") != sid:
                            continue
                        c["message"] = ({**tpl, "mode": "1:N"} if tpl.get("error")
                                        else generate.render_template(tpl, c, channel))
                        # render_template 은 새 dict 를 만든다. 왜 대체됐는지가 여기서 사라지면
                        # 검토 화면이 "AI 가 쓴 것" 과 구분할 근거를 잃는다.
                        for k in ("kind", "fallbackFrom"):
                            if tpl.get(k):
                                c["message"][k] = tpl[k]
                        c["message"].setdefault("reviewStatus", "PENDING")
                        c["status"] = "HELD" if c["message"].get("error") else "DRAFTED"
                    cur["step"] = 5
                    store.save(cur)
                    _job_set(job_id, done=i + 1)
                return

            for i, t in enumerate(targets):
                if _job_cancelled(job_id):
                    _fill_sector_messages(job_id, targets[i:], sel, channel,
                                          common.get("persona_id"), mode="1:1")
                    return
                _job_set(job_id, current=f"{t.get('name')} · {t.get('company')}", done=i)
                L.log("info", "generate", f"1:1 문안 생성 — {t.get('name')} · {t.get('company')}")
                try:
                    msg = generate.generate_message(
                        t, t.get("segmentId"), t.get("signals") or {"facts": []},
                        copy_guide=picked.get(t.get("segmentId")) or [], **common)
                except Exception as e:
                    _job_fail_item(job_id, t.get("name"), e)
                    msg = None

                # AI 가 실패했거나 "근거 부족" 등으로 문안을 못 냈으면
                # 업종 기본 문안으로 대체한다. 어떤 경우에도 빈손으로 다음 단계에
                # 넘기지 않는다. 대신 kind='sector' 로 표시해 검토에서 구분되게 한다.
                if not msg or msg.get("error"):
                    seg = seg_of(t.get("segmentId"))
                    if seg:
                        tpl = SF.template_for(seg, persona_of(common.get("persona_id")), COMPANY)
                        msg = generate.render_template(
                            generate.apply_compliance(tpl, channel, common.get("persona_id")),
                            t, channel)
                        msg["kind"] = "sector"
                        msg["fallbackFrom"] = (msg.get("error") or "AI 생성 실패")
                        msg.pop("error", None)
                        L.log("warn", "generate", f"{t.get('name')} — 업종 기본 문안으로 대체")
                cur = store.load()
                c = _card(cur, t["id"])
                if c is not None:
                    c["message"] = msg
                    c["message"]["reviewStatus"] = "PENDING"
                    c["status"] = "HELD" if msg.get("error") else "DRAFTED"
                cur["step"] = 5
                store.save(cur)
                _job_set(job_id, done=i + 1)

        _job_run(jid, work)
        return 202, {"jobId": jid, "total": total, "status": "running"}

    # --- 작업 진행률 --------------------------------------------------------
    if path == "/api/job" and method == "GET":
        jid = (query.get("id") or [""])[0]
        j = _job_get(jid)
        if not j:
            return 404, {"error": "그런 작업이 없습니다."}
        if j["status"] in ("done", "failed"):
            # 상태를 먼저 펼치고 작업 정보를 덮어써야 failed/errors 가 살아남는다.
            return 200, {**full_state(store.load()), **j}
        return 200, j


    # --- 6. 검토·승인 (HITL) ------------------------------------------------
    if path == "/api/review" and method == "POST":
        def apply(st):
            c = _card(st, body.get("id"))
            if not c or not c.get("message"):
                return
            if body.get("subject") is not None:
                c["message"]["subject"] = body["subject"]
            if body.get("body") is not None:
                c["message"]["body"] = body["body"]
            if body.get("action") == "approve":
                c["message"]["reviewStatus"] = "APPROVED"
                c["status"] = "APPROVED"
            if body.get("action") == "reject":
                c["message"]["reviewStatus"] = "REJECTED"
                c["status"] = "REJECTED"
            st["step"] = 6
        return 200, full_state(store.update(apply))

    # --- 7-a. 테스트 발송 ----------------------------------------------------
    # 파이프라인을 다 돌리지 않고 "수신자·제목·본문"만 넣어 한 통 보내 본다.
    # SMTP 설정과 스팸함 여부를 확인하는 용도라, 승인 게이트를 거치지 않는다.
    # 대신 컴플라이언스(광고 표기·수신거부)는 실제 발송과 똑같이 강제한다.
    if path == "/api/test-send" and method == "POST":
        to = str(body.get("to") or "").strip()
        if not to or "@" not in to:
            return 400, {"error": "받는 사람 이메일 주소를 확인해 주세요."}
        st = store.load()
        msg = generate.apply_compliance(
            {"subject": str(body.get("subject") or "(제목 없음)"), "body": str(body.get("body") or "")},
            "email", body.get("personaId") or st.get("personaId"))
        r = deliver.send_email(to, msg["subject"], msg["body"])
        smtp = deliver.smtp_status()
        note = ("DRY_RUN=1 이라 실제로 나가지 않았습니다 (.env 에서 0 으로 바꾸면 실제 발송)"
                if smtp["dryRun"] else ("발송 완료" if r["ok"] else r.get("error")))
        return 200, {"ok": r["ok"], "note": note, "dryRun": smtp["dryRun"],
                     "sent": {"to": to, "from": smtp["user"], **msg}}

    # --- 7. 발송 -------------------------------------------------------------
    if path == "/api/deliver" and method == "POST":
        confirm = bool(body.get("confirm"))
        st = store.load()
        # 자사·제외 명함은 어떤 경우에도 내보내지 않는다.
        # selection 에서는 막고 있었지만, 예전 실행에서 만들어진 문안이 남아 있으면
        # 승인 상태만으로 발송 대상에 끼어들었다(자사 주소로 광고 메일이 나간다).
        approved = [c for c in st["cards"]
                    if (c.get("message") or {}).get("reviewStatus") == "APPROVED"
                    and not c.get("excluded") and c.get("segmentId") != "internal"]
        blocked = [c for c in st["cards"]
                   if (c.get("message") or {}).get("reviewStatus") == "APPROVED"
                   and (c.get("excluded") or c.get("segmentId") == "internal")]
        if blocked:
            L.log("warn", "deliver",
                  f"자사·제외 {len(blocked)}건은 승인돼 있어도 발송하지 않습니다 — "
                  + ", ".join(c.get("name") or c["id"] for c in blocked[:5]))
        results = []
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()
        L.log("info", "deliver", f"{'실제 발송' if confirm else '큐 적재(dry-run)'} — {len(approved)}건")

        if not confirm:
            # 큐 적재는 즉시 끝난다. 예전처럼 동기 응답.
            for c in approved:
                c["status"] = "QUEUED"
                c["queuedAt"] = now
                results.append({"id": c["id"], "to": c.get("email"), "sent": False, "note": "dry-run (큐 적재만)"})
            st["step"] = 7
            store.save(st)
            return 200, full_state(store.load(), results=results)

        # 실제 발송은 건당 SMTP 연결에 최대 30초가 걸린다. 몇 건만 돼도 HTTP 응답을
        # 붙잡고 있다가 배포 플랫폼이 연결을 끊어 버린다("Failed to fetch").
        # 그래서 다른 긴 단계와 똑같이 작업으로 돌리고 진행률을 물어보게 한다.
        jid = _job_new("deliver", len(approved))

        def work(job_id: str):
            sent_results = []
            for i, c0 in enumerate(approved):
                _job_set(job_id, current=f"{c0.get('name')} · {c0.get('company')}", done=i)
                if not c0.get("email"):
                    # 주소는 지어낼 수 없다. 실패로 기록하면 이력이 빨갛게 뒤덮여
                    # 진짜 실패(인증 오류 등)가 묻힌다. 건너뛴 것으로 남긴다.
                    def skip(st2, cid=c0["id"]):
                        t2 = _card(st2, cid)
                        if t2:
                            t2["status"] = "NO_EMAIL"
                            t2["deliverError"] = "수신 이메일 주소 없음 — 발송 이력에서 [수정]으로 넣으세요"
                    store.update(skip)
                    sent_results.append({"id": c0["id"], "to": "", "sent": False,
                                         "note": "건너뜀 — 수신 주소 없음"})
                    _job_set(job_id, done=i + 1, results=sent_results)
                    continue
                try:
                    r = deliver.send_email(c0.get("email"), c0["message"].get("subject"),
                                           c0["message"].get("body"))
                except Exception as e:                     # 한 건 때문에 나머지를 잃지 않는다
                    _job_fail_item(job_id, c0.get("name") or c0["id"], e)
                    r = {"ok": False, "error": f"{type(e).__name__}: {e}"}

                def apply(st2, cid=c0["id"], rr=r):
                    t2 = _card(st2, cid)
                    if not t2:
                        return
                    t2["status"] = "SENT" if rr["ok"] else "SEND_FAILED"
                    t2["deliveredAt"] = now
                    t2["deliverError"] = None if rr["ok"] else rr.get("error")
                    st2["step"] = 7
                store.update(apply)
                sent_results.append({"id": c0["id"], "to": c0.get("email"), "sent": r["ok"],
                                     "note": r.get("messageId") or r.get("error")})
                _job_set(job_id, done=i + 1, results=sent_results)

        _job_run(jid, work)
        return 202, {"jobId": jid, "total": len(approved), "status": "running"}

    return None


# ── HTTP ────────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    server_version = "proto-rem/0.2"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):   # 기본 stderr 로그는 끄고 L.log 로 통일
        pass

    def _send(self, code: int, payload, ctype="application/json; charset=utf-8", headers=None):
        raw = payload if isinstance(payload, bytes) else json.dumps(
            payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(raw)))
        # 캐시 금지가 기본이다.
        # API 응답은 화면 상태 그 자체라 한 번이라도 캐시되면 거짓 화면이 된다.
        # 프런트(app.js)도 마찬가지다 — 배포해도 브라우저가 옛 파일을 계속 쓰면
        # "고쳤는데 화면은 그대로"가 되어 없는 버그를 쫓게 된다.
        # 정적 파일만 아래에서 no-cache + ETag 로 덮어쓴다(재검증은 하되 재다운로드는 아낀다).
        hdrs = headers or {}
        if not any(k.lower() == "cache-control" for k in hdrs):
            self.send_header("cache-control", "no-store")
        for k, v in hdrs.items():
            self.send_header(k, v)
        # 리멤버 페이지에 붙여넣은 스니펫이 이 서버로 직접 명함을 보낼 수 있어야 하므로
        # CORS 를 연다. 로컬 전용 도구라 허용 범위를 넓게 둔다.
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-headers", "content-type")
        self.send_header("access-control-allow-methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self._send(204, b"", "text/plain")

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def _handle(self, method: str):
        u = urlparse(self.path)
        path, query = u.path, parse_qs(u.query)
        body = {}
        if method == "POST":
            n = int(self.headers.get("content-length") or 0)
            if n:
                try:
                    body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
                except ValueError as e:
                    return self._send(400, {"error": f"요청 본문을 해석하지 못했습니다: {e}"})

        # --- 접속 인증 게이트 -------------------------------------------
        if _auth_on() and not _authed(self.headers.get("cookie", "")):
          try:
            # 로그인 화면이 힌트를 읽어야 하므로 이것만 인증 전에 연다.
            # 비밀값은 담지 않는다 — 관리자가 힌트에 적어 넣은 문구만 그대로 돌려준다.
            if path == "/api/login-info" and method == "GET":
                return self._send(200, {"user": _auth_user(), "hint": env("APP_HINT") or ""})
            if path == "/api/login" and method == "POST":
                ok_id = hmac.compare_digest(str(body.get("user") or "").strip(), _auth_user())
                ok_pw = hmac.compare_digest(str(body.get("password") or ""), env("APP_PASSWORD") or "")
                if ok_id and ok_pw:
                    L.log("ok", "auth", f"로그인 — {self.client_address[0]}")
                    return self._send(200, {"ok": True}, headers={
                        "set-cookie": f"{COOKIE}={_token()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"})
                time.sleep(1.0)          # 무차별 대입 속도를 늦춘다
                L.log("warn", "auth", f"로그인 실패 - {self.client_address[0]}")
                # 어느 쪽이 틀렸는지 알려 주지 않는다. 아이디 존재 여부가 새어 나간다.
                return self._send(401, {"error": "아이디 또는 비밀번호가 다릅니다."})
            if path.startswith("/api/"):
                return self._send(401, {"error": "로그인이 필요합니다.", "login": True})
            if path != "/login.html":
                # 어떤 주소로 들어와도 로그인 화면부터 보여준다
                return self._send(200, (PUBLIC / "login.html").read_bytes(),
                                  "text/html; charset=utf-8")
          except Exception as _e:
            traceback.print_exc()
            return self._send(500, {"error": f"AUTHGATE {type(_e).__name__}: {_e}"})

        if path.startswith("/api/"):
            # 로그 폴링은 그 자체가 로그를 만들면 무한히 불어나므로 기록하지 않는다.
            if path != "/api/logs":
                L.log("net", "http", f"{method} {path}",
                      {k: v for k, v in body.items() if k not in ("cards", "text")} or None)
            try:
                r = route(path, method, body, query, peer=self.client_address[0])
            except Exception as e:
                L.log("error", "http", f"{method} {path} 처리 실패 — {e}")
                traceback.print_exc()
                return self._send(500, {"error": f"{type(e).__name__}: {e}"})
            if r is None:
                return self._send(404, {"error": f"not found: {method} {path}"})
            if isinstance(r[1], dict) and r[1].pop("__clear_cookie", False):
                return self._send(r[0], r[1],
                                  headers={"set-cookie": f"{COOKIE}=; Path=/; Max-Age=0"})
            return self._send(r[0], r[1])

        # --- 정적 파일 ---
        rel = "index.html" if path == "/" else path.lstrip("/")
        fp = (PUBLIC / rel).resolve()
        if not str(fp).startswith(str(PUBLIC.resolve())) or not fp.is_file():
            return self._send(404, {"error": "not found"})
        ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"

        # no-cache = "쓰기 전에 매번 물어봐라"(캐시 금지가 아니다).
        # 파일이 그대로면 304 로 답해 재다운로드는 아끼고, 바뀌면 즉시 새 파일이 간다.
        st = fp.stat()
        etag = f'W/"{int(st.st_mtime)}-{st.st_size}"'
        if self.headers.get("if-none-match") == etag:
            self.send_response(304)
            self.send_header("etag", etag)
            self.send_header("cache-control", "no-cache")
            self.end_headers()
            return
        self._send(200, fp.read_bytes(), ctype,
                   {"etag": etag, "cache-control": "no-cache"})


def main():
    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass
    b = llm.resolve_backend()
    L.log("ok", "boot", f"proto-rem (Python) 시작 → http://localhost:{PORT}",
          {"backend": b["name"], "model": b["model"], "db": store.db_path()})
    print(f"\nproto-rem 대시보드 → http://localhost:{PORT}\n", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
