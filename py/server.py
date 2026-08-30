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

import json
import mimetypes
import os
import subprocess
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import classify_ai, copy_ai, deliver, enrich, generate, llm, normalize, resolve, store
from . import log as L
from .domain import COMPANY, PERSONAS, SEGMENTS, classify
from .domain import segment as seg_of
from .env import settings_view, write_env

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
DATA = ROOT / "data"
PORT = int(os.environ.get("PORT", 5173))

STEPS = [
    {"n": 1, "id": "ingest", "label": "명함 수집", "hitl": False, "desc": "리멤버/CSV에서 명함을 가져온다"},
    {"n": 2, "id": "resolve", "label": "발신·발송모드", "hitl": True,
     "desc": "발신은 에이톰엔지니어링 고정. 발신자 역할과 1:1 / 1:N 을 사람이 선택한다"},
    {"n": 3, "id": "enrich", "label": "홈페이지 분석", "hitl": False,
     "desc": "source(자사)·target(고객) 홈페이지를 읽어 근거를 뽑고, 그 근거로 프롬프트를 조립한다"},
    {"n": 4, "id": "segment", "label": "고객군 선택", "hitl": True,
     "desc": "고객군 자동 분류 → 사람이 발송 대상 확정"},
    {"n": 5, "id": "generate", "label": "문구·카피 생성", "hitl": False,
     "desc": "키워드로 문구를 고르고, 그 방향으로 문안을 생성한다"},
    {"n": 6, "id": "review", "label": "검토·승인", "hitl": True, "desc": "사람이 문안 수정 후 승인/반려"},
    {"n": 7, "id": "deliver", "label": "발송·추적", "hitl": False, "desc": "승인 건만 발송, 이력·응답 기록"},
]


def full_state(st: dict, **extra) -> dict:
    return {**st, "steps": STEPS, "segments": SEGMENTS, "company": COMPANY,
            "personas": PERSONAS, "copyKinds": copy_ai.KINDS, "copyTones": copy_ai.TONES,
            "backend": llm.resolve_backend(), "smtp": deliver.smtp_status(),
            "runtime": "python", **extra}


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


# ── 라우트 ────────────────────────────────────────────────────────────
def route(path: str, method: str, body: dict, query: dict):
    """(status, payload) 를 돌려준다. payload 가 dict 면 JSON 으로 나간다."""

    if path == "/api/state":
        return 200, full_state(store.load())

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

        def apply(st):
            st["cards"] = [{**c, "status": "NEW"} for c in cards]
            st["source"] = "remember-export"
            st["selection"] = []
            st["step"] = 1
        return 200, full_state(store.update(apply))

    # --- 1. 수집 ---------------------------------------------------------
    if path == "/api/ingest" and method == "POST":
        exported = DATA / "cards.json"
        seed = DATA / "seed-cards.json"
        src_file = exported if exported.exists() else seed
        if not src_file.exists():
            return 400, {"error": "가져올 명함 파일이 없습니다 (data/cards.json). 붙여넣기나 스니펫을 먼저 쓰세요."}
        try:
            src = json.loads(src_file.read_text(encoding="utf-8"))
        except ValueError as e:
            return 400, {"error": f"{src_file.name} 을 읽지 못했습니다: {e}"}
        L.log("ok", "ingest", f"{src_file.name} 에서 {len(src)}건 불러옴")

        def apply(st):
            st["cards"] = [{**c, "status": "NEW"} for c in src]
            st["source"] = "remember-export" if src_file == exported else "seed-sample"
            st["step"] = 1
        return 200, full_state(store.update(apply))

    # --- 1-d. 텍스트로 명함 직접 입력 -------------------------------------
    if path == "/api/paste-cards" and method == "POST":
        parsed = normalize.parse_text(body.get("text") or "")
        if not parsed["cards"]:
            return 400, {"error": "명함을 찾지 못했습니다. 이름이 포함된 줄이 있어야 합니다."}
        DATA.mkdir(parents=True, exist_ok=True)
        (DATA / "cards.json").write_text(json.dumps(parsed["cards"], ensure_ascii=False, indent=2), encoding="utf-8")
        L.log("ok", "ingest", f"붙여넣기 {len(parsed['cards'])}건 ({parsed['mode']})")

        def apply(st):
            st["cards"] = [{**c, "status": "NEW", "source": "paste"} for c in parsed["cards"]]
            st["source"] = "paste"
            st["selection"] = []
            st["step"] = 1
        return 200, full_state(store.update(apply), parsedAs=parsed["mode"])

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
        targets = _usable(st)
        L.log("info", "resolve", f"홈페이지 탐색 시작 — {len(targets)}건")
        for c in targets:
            if c.get("siteUrl") and (c.get("siteResolve") or {}).get("via") == "card":
                continue
            r = resolve.resolve_site(c)
            c["siteUrl"] = r["siteUrl"]
            c["siteResolve"] = {"via": r["via"], "tried": r["tried"]}
            if c.get("status") == "NEW":
                c["status"] = "RESOLVED"
        st["step"] = 2
        return 200, full_state(store.save(st))

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

    # --- 관리자 설정 (톱니바퀴) ---------------------------------------------
    # .env 를 화면에서 직접 읽고 고친다. 이 서버에는 로그인이 없으므로
    # 비밀값은 기본적으로 가려서 내보내고, 명시적으로 요청할 때만 원문을 준다.
    if path == "/api/settings" and method == "GET":
        return 200, {"items": settings_view(reveal=False)}

    if path == "/api/settings" and method == "POST":
        if body.get("reveal"):
            return 200, {"items": settings_view(reveal=True)}
        updates = body.get("updates") or {}
        if not isinstance(updates, dict) or not updates:
            return 400, {"error": "바꿀 항목이 없습니다."}
        r = write_env({str(k): str(v) for k, v in updates.items()})
        llm.resolve_backend(refresh=True)       # 백엔드 설정이 바뀌었을 수 있다
        L.log("ok", "settings", f"설정 변경 — 수정 {len(r['changed'])} · 추가 {len(r['added'])} · 삭제 {len(r['removed'])}",
              {"keys": r["changed"] + r["added"] + r["removed"]})
        needs_restart = any(k in ("PORT", "TENANT_ID") for k in updates)
        return 200, {"items": settings_view(reveal=False), "result": r, "needsRestart": needs_restart}

    # --- 3. 리서치 --------------------------------------------------------
    if path == "/api/enrich" and method == "POST":
        # AI 를 못 쓰는 상태면 12건을 다 돌려 12번 똑같이 실패시키지 않는다.
        # 원인을 한 줄로 알려주고 즉시 멈추는 편이 낫다.
        b = llm.resolve_backend(refresh=True)
        if b["name"] == "none":
            L.log("error", "enrich", f"리서치 불가 — {b.get('hint')}")
            return 400, {"error": "AI 백엔드가 없어 리서치를 할 수 없습니다.\n"
                                  + str(b.get("hint", ""))}

        st = store.load()
        if not st.get("sourceProfile"):
            st["sourceProfile"] = enrich.build_source_profile()
        ids = body.get("ids") or []
        targets = [c for c in st["cards"] if not ids or c["id"] in ids]
        L.log("info", "enrich", f"리서치 시작 — {len(targets)}건",
              {"backend": b["name"], "model": b["model"]})

        ai_fail = 0
        for c in targets:
            site = enrich.fetch_site(c.get("siteUrl"))
            c["siteFetch"] = {"ok": site["ok"], "reason": site["reason"], "chars": len(site["text"])}
            if not site["ok"]:
                # 홈페이지를 못 읽었으면 AI 를 부를 이유가 없다. 호출 낭비를 막는다.
                c["signals"] = {"facts": [], "building_signals": {}, "confidence": "low",
                                "_skipped": f"홈페이지를 읽지 못함 ({site['reason']})"}
                c["status"] = "ENRICHED"
                continue
            c["signals"] = enrich.extract_signals(c, site["text"])
            c["status"] = "ENRICHED"
            if c["signals"].get("_error"):
                ai_fail += 1
                # 첫 건이 AI 호출 자체로 실패하면 나머지도 같은 이유로 실패한다. 즉시 멈춘다.
                if ai_fail == 1 and len(targets) > 1:
                    L.log("error", "enrich",
                          f"AI 호출 실패로 중단 — {c['signals']['_error']}")
                    store.save(st)
                    return 200, full_state(store.load(),
                                           warning=f"AI 호출이 실패해 리서치를 중단했습니다: "
                                                   f"{c['signals']['_error']}")
        st["step"] = 3
        return 200, full_state(store.save(st))

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
        def rule(st):
            for c in st["cards"]:
                r = classify(c)
                c["segmentId"] = r["segmentId"]
                c["segmentScore"] = r["score"]
                c["segmentSource"] = ("rule" if r["segmentId"] in ("internal", "excluded")
                                      else (None if r["segmentId"] == "unclassified" else "keyword"))
                c["status"] = "SCORED"
            st["step"] = 4
        st = store.update(rule)

        if body.get("useAi"):
            st = store.load()
            todo = [c for c in st["cards"] if not c.get("excluded") and c.get("segmentId") == "unclassified"]
            L.log("info", "segment", f"AI 분류 — {len(todo)}건")
            for c in todo:
                r = classify_ai.classify_one(c)
                c["segmentId"] = r["segmentId"]
                c["segmentSource"] = None if r["segmentId"] == "unclassified" else "ai"
                c["segmentAi"] = {"confidence": r["confidence"], "reason": r["reason"]}
            st = store.save(st)
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
        made = normalize.to_cards([body.get("card") or {}])
        if not made:
            return 400, {"error": "이름이 없습니다. 이름은 반드시 필요합니다."}
        c = made[0]

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
            for k in ("name", "title", "company", "dept", "email", "phone", "site", "note"):
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
        r = copy_ai.suggest(c, sid, keywords=body.get("keywords"), tones=body.get("tones"),
                            channel=body.get("channel", "email"), count=body.get("count", 30),
                            source_profile=st.get("sourceProfile"), persona_id=st.get("personaId"))

        def apply(s):
            s.setdefault("copy", {})[sid or "_"] = {"items": r["items"], "source": r["source"]}
        return 200, full_state(store.update(apply), copy=r, copySegmentId=sid)

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
    if path == "/api/generate" and method == "POST":
        channel = body.get("channel", "email")
        batch = int(body.get("batch", 1))
        st = store.load()
        sel = set(st.get("selection") or [])
        targets = [c for c in st["cards"] if c["id"] in sel]
        picked = st.get("copyPicked") or {}
        common = dict(channel=channel, persona_id=st.get("personaId"),
                      source_profile=st.get("sourceProfile"))

        if body.get("restart"):
            st["templates"] = {}
            for c in targets:
                c.pop("message", None)

        done = 0
        if st.get("mode") == "1:N":
            tpls = dict(st.get("templates") or {})
            needed = [s for s in dict.fromkeys(c.get("segmentId") for c in targets) if s and s not in tpls]
            for sid in needed[:batch]:
                L.log("info", "generate", f"1:N 공통 문안 생성 — {sid}")
                tpls[sid] = generate.generate_segment_template(
                    sid, copy_guide=picked.get(sid) or [], **common)
                done += 1
            st["templates"] = tpls
            for c in targets:
                tpl = tpls.get(c.get("segmentId"))
                if not tpl:
                    continue
                c["message"] = ({**tpl, "mode": "1:N"} if tpl.get("error")
                                else generate.render_template(tpl, c, channel))
                c["message"].setdefault("reviewStatus", "PENDING")
                c["status"] = "HELD" if c["message"].get("error") else "DRAFTED"
            st["step"] = 5
            store.save(st)
            remaining = len([s for s in dict.fromkeys(c.get("segmentId") for c in targets)
                             if s and s not in tpls])
            return 200, full_state(store.load(), remaining=remaining, done=done)

        for c in [x for x in targets if not x.get("message")][:batch]:
            L.log("info", "generate", f"1:1 문안 생성 — {c.get('name')} · {c.get('company')}")
            c["message"] = generate.generate_message(
                c, c.get("segmentId"), c.get("signals") or {"facts": []},
                copy_guide=picked.get(c.get("segmentId")) or [], **common)
            c["message"]["reviewStatus"] = "PENDING"
            c["status"] = "HELD" if c["message"].get("error") else "DRAFTED"
            done += 1
        st["step"] = 5
        store.save(st)
        remaining = len([c for c in store.load()["cards"] if c["id"] in sel and not c.get("message")])
        return 200, full_state(store.load(), remaining=remaining, done=done)

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
        approved = [c for c in st["cards"] if (c.get("message") or {}).get("reviewStatus") == "APPROVED"]
        results = []
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()
        L.log("info", "deliver", f"{'실제 발송' if confirm else '큐 적재(dry-run)'} — {len(approved)}건")
        for c in approved:
            if not confirm:
                c["status"] = "QUEUED"
                c["queuedAt"] = now
                results.append({"id": c["id"], "to": c.get("email"), "sent": False, "note": "dry-run (큐 적재만)"})
                continue
            r = deliver.send_email(c.get("email"), c["message"].get("subject"), c["message"].get("body"))
            c["status"] = "SENT" if r["ok"] else "SEND_FAILED"
            c["deliveredAt"] = now
            c["deliverError"] = None if r["ok"] else r.get("error")
            results.append({"id": c["id"], "to": c.get("email"), "sent": r["ok"],
                            "note": r.get("messageId") or r.get("error")})
        st["step"] = 7
        store.save(st)
        return 200, full_state(store.load(), results=results)

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

        if path.startswith("/api/"):
            # 로그 폴링은 그 자체가 로그를 만들면 무한히 불어나므로 기록하지 않는다.
            if path != "/api/logs":
                L.log("net", "http", f"{method} {path}",
                      {k: v for k, v in body.items() if k not in ("cards", "text")} or None)
            try:
                r = route(path, method, body, query)
            except Exception as e:
                L.log("error", "http", f"{method} {path} 처리 실패 — {e}")
                traceback.print_exc()
                return self._send(500, {"error": f"{type(e).__name__}: {e}"})
            if r is None:
                return self._send(404, {"error": f"not found: {method} {path}"})
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
