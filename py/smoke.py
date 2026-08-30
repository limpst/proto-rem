"""전체 프로세스 스모크 테스트 — STEP 1~7 을 자동으로 한 번 통과시킨다.

    python -m py.smoke                       # DRY_RUN 존중 (실제 발송 안 함)
    python -m py.smoke --to me@example.com   # 그 주소로 테스트 메일 1통
    python -m py.smoke --to me@example.com --real   # DRY_RUN 을 무시하고 실제 발송
    python -m py.smoke --model gemma4:31b-cloud     # 이 실행에 쓸 AI 모델 지정

돌아가는 서버(python -m py.server)에 HTTP 로 붙어 화면과 **똑같은 경로**를 탄다.
따로 만든 지름길이 아니라 실제 API 를 순서대로 두드리므로, 여기서 통과하면
대시보드에서도 같은 순서로 통과한다.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("SMOKE_BASE", "http://127.0.0.1:5173")

# 붙여넣기 파서까지 같이 검증하려고 텍스트로 넣는다 (한 줄 / 여러 줄 혼합).
SAMPLE = """이종하 상무 노바엣지테크놀로지 jh.lee@novaedgetek.com

호은성
전무이사
에이톰엔지니어링
atom@atom-eng.co.kr
010-8247-2177

Hwayoung Lee Quantitative Researcher MEISTER TRADING hwayoung.lee80@gmail.com
"""

ok_count, fail_count = 0, 0


def call(path: str, body: dict | None = None, timeout: int = 600):
    data = json.dumps(body or {}, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=data,
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}"}
    except Exception as e:
        return {"error": str(e)}


def wait_job(r: dict, label: str = "", timeout: int = 1800) -> dict:
    """202 로 받은 작업이 끝날 때까지 기다렸다가 최종 상태를 돌려준다.

    홈페이지 탐색·리서치·문안 생성은 로컬 모델이면 건당 수 분이 걸린다. 그래서
    서버가 응답을 붙잡지 않고 작업 번호만 즉시 주고 백그라운드에서 돈다.
    예전처럼 응답에서 바로 cards 를 꺼내면 KeyError: 'cards' 가 난다.

    작업이 끝나면 /api/job 이 전체 상태(cards 포함)를 펼쳐서 주므로,
    호출부는 예전과 똑같이 r["cards"] 를 쓸 수 있다.
    """
    jid = r.get("jobId")
    if not jid:
        return r                      # 잡이 아니면 그대로 — 동기 응답과도 호환된다
    t0 = time.time()
    last = -1
    while time.time() - t0 < timeout:
        j = call(f"/api/job?id={jid}")
        if j.get("error"):
            return j
        done, total = j.get("done", 0), j.get("total", 0)
        if label and done != last:
            last = done
            cur = (j.get("current") or "")[:30]
            print(f"     · {label} {done}/{total} {cur}", flush=True)
        if j.get("status") == "failed":
            return {"error": j.get("error") or "작업 실패"}
        if j.get("status") == "done":
            return j
        time.sleep(1.0)
    return {"error": f"작업이 {timeout}초 안에 끝나지 않았습니다 ({jid})"}


def job_note(j: dict) -> str:
    """건별 실패가 있었으면 꼬리에 덧붙일 문구. 없으면 빈 문자열."""
    n = j.get("failed") or 0
    if not n:
        return ""
    first = (j.get("errors") or ["-"])[0][:60]
    return f" · 건너뜀 {n}건 (예: {first})"


def step(n, title, fn):
    global ok_count, fail_count
    t0 = time.time()
    print(f"\n── STEP {n} · {title} " + "─" * max(0, 46 - len(title)), flush=True)
    try:
        msg = fn()
        ok_count += 1
        print(f"   ✔ {msg}   ({time.time() - t0:.1f}s)", flush=True)
        return True
    except AssertionError as e:
        fail_count += 1
        print(f"   ✘ 실패: {e}   ({time.time() - t0:.1f}s)", flush=True)
        return False
    except Exception as e:
        fail_count += 1
        print(f"   ✘ 오류: {type(e).__name__}: {e}   ({time.time() - t0:.1f}s)", flush=True)
        return False


def main():
    # Windows 콘솔 기본 코드페이지(cp949)는 ✔ ✘ 같은 기호를 못 찍고 죽는다.
    # 결과를 못 보는 것보다 인코딩을 맞추는 편이 낫다.
    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--to", default="", help="테스트 메일을 받을 주소")
    ap.add_argument("--real", action="store_true", help="DRY_RUN 을 무시하고 실제로 보낸다")
    ap.add_argument("--model", default="", help="이 실행에 쓸 Ollama 모델")
    ap.add_argument("--mode", default="1:N", choices=["1:1", "1:N"],
                    help="1:N 은 고객군당 1통이라 빠르다 (기본)")
    args = ap.parse_args()

    if args.real:
        # deliver 는 매 호출마다 .env 를 읽지 않고 os.environ 을 먼저 본다.
        # 이 프로세스는 클라이언트라 서버 쪽 환경을 못 바꾸므로, 서버를 DRY_RUN=0 으로
        # 띄워야 실제로 나간다. 여기서는 안내만 한다.
        print("※ --real 은 서버가 DRY_RUN=0 으로 떠 있을 때만 의미가 있습니다.")

    print(f"대상 서버: {BASE}")
    st = call("/api/state")
    if st.get("error"):
        print(f"서버에 연결하지 못했습니다: {st['error']}\n먼저 `python -m py.server` 를 띄우세요.")
        sys.exit(2)
    print(f"런타임: {st.get('runtime')} · AI: {st['backend']['name']}/{st['backend']['model']} "
          f"· SMTP: {'설정됨' if st['smtp']['configured'] else '미설정'}"
          f"{' (DRY_RUN)' if st['smtp']['dryRun'] else ''}")

    if args.model:
        r = call("/api/llm", {"name": "ollama", "model": args.model})
        print(f"AI 모델 변경 → {r.get('backend', {}).get('model')}"
              f"{'  ⚠ 클라우드 경유(외부 전송)' if r.get('backend', {}).get('cloud') else '  (로컬)'}")

    # ── STEP 1 수집 ────────────────────────────────────────────────
    def s1():
        call("/api/reset", {})
        r = call("/api/paste-cards", {"text": SAMPLE})
        assert not r.get("error"), r.get("error")
        n = len(r.get("cards") or [])
        assert n >= 3, f"명함이 {n}건만 만들어졌습니다 (3건 기대)"
        names = ", ".join(c["name"] for c in r["cards"])
        return f"명함 {n}건 생성 ({r.get('parsedAs')}) — {names}"

    # ── STEP 2 발신·모드 + 홈페이지 ────────────────────────────────
    def s2():
        r = call("/api/mode", {"personaId": "sales", "mode": args.mode})
        assert not r.get("error"), r.get("error")
        r = wait_job(call("/api/resolve-sites", {}), "홈페이지 탐색")
        assert not r.get("error"), r.get("error")
        got = [c for c in r["cards"] if c.get("siteUrl")]
        assert got, "홈페이지를 하나도 찾지 못했습니다"
        return (f"{r['personaId']} 명의 · {r['mode']} · 홈페이지 {len(got)}/{len(r['cards'])}건 확보 — "
                + ", ".join(f"{c['company']}→{c['siteUrl']}" for c in got[:3]) + job_note(r))

    # ── STEP 3 리서치 ──────────────────────────────────────────────
    def s3():
        r = wait_job(call("/api/enrich", {}), "리서치")
        assert not r.get("error"), r.get("error")
        withfacts = [c for c in r["cards"] if (c.get("signals") or {}).get("facts")]
        assert withfacts, "근거를 뽑은 회사가 없습니다"
        f0 = withfacts[0]
        return (f"{len(withfacts)}개 회사에서 근거 확보 · 예) {f0['company']}: "
                f"{(f0['signals']['facts'] or ['-'])[0][:60]}" + job_note(r))

    # ── STEP 4 분류 + 관심사 + 대상 확정 ───────────────────────────
    def s4():
        r = call("/api/segment", {})
        r = call("/api/segment", {"useAi": True})
        assert not r.get("error"), r.get("error")
        usable = [c for c in r["cards"] if not c.get("excluded") and c.get("segmentId") != "internal"]
        ids = [c["id"] for c in usable]
        r = call("/api/selection", {"ids": ids})
        r = call("/api/interests", {})
        assert not r.get("error"), r.get("error")
        segs = {c["id"]: c.get("segmentId") for c in r["cards"]}
        got = [c for c in r["cards"] if (c.get("interests") or {}).get("interests")]
        return (f"분류 {sum(1 for v in segs.values() if v not in (None, 'unclassified'))}건 · "
                f"관심사 추정 {len(got)}건 · 발송 대상 {len(r['selection'])}명")

    # ── STEP 5 문구 스튜디오 + 문안 생성 ───────────────────────────
    def s5():
        kw = call("/api/copy-keywords", {})
        assert kw.get("groups"), "키워드 팔레트가 비었습니다"
        picks = []
        for g in kw["groups"]:
            picks += g["items"][:2]
        picks = picks[:6]
        r = call("/api/copy-suggest", {"keywords": picks, "tones": ["urgent", "benefit"],
                                       "count": 18, "segmentId": kw["target"]["segmentId"]})
        items = (r.get("copy") or {}).get("items") or []
        assert len(items) >= 6, f"문구가 {len(items)}개만 나왔습니다"
        texts = [i["text"] for i in items[:5]]
        call("/api/copy-pick", {"segmentId": kw["target"]["segmentId"], "texts": texts})
        print(f"     · 키워드 {len(picks)}개 선택 → 문구 {len(items)}개 ({(r.get('copy') or {}).get('source')})")
        for t in texts[:3]:
            print(f"       “{t}”")

        # 문안 생성 — 서버가 작업으로 돌린다. 끝날 때까지 기다린다 (화면과 같은 방식)
        g = wait_job(call("/api/generate", {"channel": "email", "batch": 1, "restart": True}),
                     "문안 생성")
        assert not g.get("error"), g.get("error")
        drafted = [c for c in g["cards"] if c.get("message") and not c["message"].get("error")]
        held = [c for c in g["cards"] if (c.get("message") or {}).get("error")]
        assert drafted, f"초안이 0건입니다 (보류 {len(held)}건: " \
                        f"{[c['message'].get('error') for c in held][:2]})"
        d0 = drafted[0]["message"]
        print(f"     · 예) 제목: {d0.get('subject', '')[:70]}")
        return f"초안 {len(drafted)}건 생성 (보류 {len(held)}건)" + job_note(g)

    # ── STEP 6 승인 ────────────────────────────────────────────────
    def s6():
        st2 = call("/api/state")
        n = 0
        for c in st2["cards"]:
            if c.get("message") and not c["message"].get("error"):
                r = call("/api/review", {"id": c["id"], "action": "approve"})
                n += 1
        assert n, "승인할 초안이 없습니다"
        return f"{n}건 승인"

    # ── STEP 7 발송 ────────────────────────────────────────────────
    def s7():
        r = call("/api/deliver", {"confirm": False})
        queued = [x for x in (r.get("results") or [])]
        out = f"큐 적재 {len(queued)}건"
        if args.to:
            t = call("/api/test-send", {
                "to": args.to,
                "subject": "에이톰엔지니어링 — 전체 프로세스 테스트 발송",
                "body": "안녕하세요.\n㈜에이톰엔지니어링 아웃바운드 콘솔의 STEP 1~7 전체 프로세스 "
                        "스모크 테스트에서 발송된 확인용 메일입니다.\n이 메일이 도착했다면 SMTP 설정이 정상입니다.",
            })
            assert not t.get("error"), t.get("error")
            out += f" · 테스트 메일 → {args.to}: {t.get('note')}"
            assert t.get("ok"), t.get("note")
        return out

    ok = True
    ok &= step(1, "명함 수집 (붙여넣기 파서)", s1)
    ok &= step(2, "발신·모드 + 홈페이지 탐색", s2)
    ok &= step(3, "홈페이지 리서치", s3)
    ok &= step(4, "고객군 분류 + 관심사 + 대상 확정", s4)
    ok &= step(5, "문구 스튜디오 + 문안 생성", s5)
    ok &= step(6, "검토·승인", s6)
    ok &= step(7, "발송", s7)

    print("\n" + "═" * 60)
    print(f"결과: 통과 {ok_count} / 실패 {fail_count}")
    print("═" * 60)
    sys.exit(0 if fail_count == 0 else 1)


if __name__ == "__main__":
    main()
