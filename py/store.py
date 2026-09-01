"""상태 저장소 — SQLite (data/proto-rem.db).

Node 판 src/store.mjs 와 같은 스키마를 쓴다. 기존 DB 를 그대로 이어 읽는다.

설계:
  - cards 테이블에 명함을 행 단위로 저장 (나중에 세그먼트별 질의를 위해)
  - 나머지 설정(mode, personaId, sourceProfile, llm, copy...)은 meta 키-값
  - tenant 컬럼을 처음부터 둔다. SaaS 전환 때 스키마를 다시 짜지 않기 위해

load()/save()/update() 의 겉모습은 Node 판과 같다. 호출부는 이 셋만 쓴다.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from pathlib import Path

from . import paths
from .env import env

ROOT = Path(__file__).resolve().parent.parent
# 읽기 전용 자산(seed)과 살아남아야 할 상태(DB)는 자리가 다르다. paths.py 참고.
ASSETS = paths.ASSETS
DATA = paths.STATE
DB_PATH = os.environ.get("DB_PATH") or str(DATA / "proto-rem.db")
# os.environ 만 보면 ⚙ 설정 화면에서 넣은 값(.env)이 무시된다.
# 화면에 칸을 열어두고 고쳐도 아무 일이 없어, 서버를 껐다 켜도 그대로였다.
TENANT = env("TENANT_ID", "atom-eng")

DEFAULTS = {
    "tenantId": TENANT,
    "cards": [], "selection": [], "step": 1,
    "mode": "1:1",         # 1:1 개별 맞춤 / 1:N 고객군 공통
    "personaId": "sales",  # 발신자 명의
}

# 명함 행에서 그대로 열로 저장하는 필드
from .schema import TEXT_KEYS

# 명함 필드는 schema.py 한 곳에서 정의한다. 여기에 따로 적으면 반드시 어긋난다.
# siteUrl/segmentId/status 는 시스템이 채우는 값이라 스키마 밖에 둔다.
COLS = [*TEXT_KEYS, "siteUrl", "segmentId", "status"]
# 객체라서 JSON 문자열로 저장하는 필드
JSON_COLS = ["signals", "siteFetch", "siteResolve", "message", "segmentAi", "interests"]
EXTRA_COLS = ["deliveredAt", "queuedAt", "deliverError"]

_local = threading.local()
_write_lock = threading.Lock()


def _ensure_columns(conn: sqlite3.Connection) -> None:
    """schema.py 에 필드를 추가하면 기존 DB 에도 열을 붙인다.

    ALTER TABLE ADD COLUMN 은 기존 행을 건드리지 않는다. 그래서 이미 쌓인
    명함·문안·승인·발송이력을 그대로 둔 채 차원만 늘릴 수 있다.
    """
    have = {r["name"] for r in conn.execute("PRAGMA table_info(cards)")}
    for col in COLS:
        if col not in have:
            conn.execute(f"ALTER TABLE cards ADD COLUMN {col} TEXT")
    conn.commit()


def _db() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is not None:
        return conn
    DATA.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS meta (
          tenant TEXT NOT NULL,
          key    TEXT NOT NULL,
          value  TEXT,
          PRIMARY KEY (tenant, key)
        );
        CREATE TABLE IF NOT EXISTS cards (
          tenant       TEXT NOT NULL,
          id           TEXT NOT NULL,
          -- 텍스트 필드는 아래 _ensure_columns() 가 schema.py 를 보고 채운다.
          name         TEXT, company TEXT,
          siteUrl      TEXT, segmentId TEXT, status TEXT,
          excluded     INTEGER DEFAULT 0,
          selected     INTEGER DEFAULT 0,
          ord          INTEGER DEFAULT 0,
          signals      TEXT, siteFetch TEXT, siteResolve TEXT, message TEXT,
          deliveredAt  TEXT, queuedAt  TEXT, deliverError TEXT,
          updated_at   TEXT,
          PRIMARY KEY (tenant, id)
        );
        CREATE INDEX IF NOT EXISTS idx_cards_seg ON cards(tenant, segmentId);
        """
    )
    # 열이 늘어나면 기존 DB 에도 붙인다. ALTER TABLE ADD COLUMN 은 기존 행을
    # 건드리지 않으므로, 쌓인 명함·문안·발송이력을 그대로 둔 채 차원만 늘어난다.
    _ensure_columns(conn)
    have = {r["name"] for r in conn.execute("PRAGMA table_info(cards)")}
    for col in ("segmentAi", "interests", "segmentSource", "segmentScore"):
        if col not in have:
            conn.execute(f"ALTER TABLE cards ADD COLUMN {col} TEXT")
    conn.commit()
    _local.conn = conn
    return conn


def _parse(v):
    if v is None:
        return None
    try:
        return json.loads(v)
    except (TypeError, ValueError):
        return None


def _row_to_card(r: sqlite3.Row) -> dict:
    c = {"id": r["id"], "excluded": bool(r["excluded"])}
    keys = r.keys()
    for k in COLS + ["segmentSource"]:
        if k in keys and r[k] is not None:
            c[k] = r[k]
    for k in JSON_COLS:
        if k in keys:
            v = _parse(r[k])
            if v is not None:
                c[k] = v
    if "segmentScore" in keys and r["segmentScore"] is not None:
        c["segmentScore"] = _parse(r["segmentScore"])
    for k in EXTRA_COLS:
        if r[k] is not None:
            c[k] = r[k]
    return c


def load() -> dict:
    d = _db()
    meta = {r["key"]: _parse(r["value"]) for r in
            d.execute("SELECT key, value FROM meta WHERE tenant = ?", (TENANT,))}
    rows = list(d.execute("SELECT * FROM cards WHERE tenant = ? ORDER BY ord, id", (TENANT,)))
    state = {**DEFAULTS, **{k: v for k, v in meta.items() if v is not None},
             "cards": [_row_to_card(r) for r in rows],
             "selection": [r["id"] for r in rows if r["selected"]]}

    # 최초 실행이고 DB 가 비어 있으면 샘플 시드를 넣는다. 시드가 없으면 빈 상태로 시작.
    if not state["cards"] and not meta.get("__seeded"):
        seed = ASSETS / "seed-cards.json"
        if seed.exists():
            try:
                state["cards"] = [{**c, "status": "NEW"} for c in json.loads(seed.read_text(encoding="utf-8"))]
                state["source"] = "seed-sample"
            except (ValueError, OSError):
                pass          # 시드가 깨졌으면 그냥 빈 상태
        state["__seeded"] = True
        save(state)
    return state


def save(state: dict) -> dict:
    d = _db()
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    selected = set(state.get("selection") or [])
    cards = state.get("cards") or []

    all_cols = (["tenant", "id"] + COLS + ["excluded", "selected", "ord"]
                + JSON_COLS + ["segmentSource", "segmentScore"] + EXTRA_COLS + ["updated_at"])
    placeholders = ",".join("?" for _ in all_cols)
    updates = ", ".join(f"{c} = excluded.{c}" for c in all_cols if c not in ("tenant", "id"))

    with _write_lock:
        try:
            d.execute("BEGIN")
            put_meta = "INSERT INTO meta (tenant, key, value) VALUES (?, ?, ?) " \
                       "ON CONFLICT(tenant, key) DO UPDATE SET value = excluded.value"
            for k, v in state.items():
                if k in ("cards", "selection"):
                    continue
                d.execute(put_meta, (TENANT, k, json.dumps(v, ensure_ascii=False, default=str)))

            ids = [c["id"] for c in cards]
            if ids:
                q = ",".join("?" for _ in ids)
                d.execute(f"DELETE FROM cards WHERE tenant = ? AND id NOT IN ({q})", (TENANT, *ids))
            else:
                d.execute("DELETE FROM cards WHERE tenant = ?", (TENANT,))

            sql = (f"INSERT INTO cards ({','.join(all_cols)}) VALUES ({placeholders}) "
                   f"ON CONFLICT(tenant, id) DO UPDATE SET {updates}")
            for i, c in enumerate(cards):
                d.execute(sql, (
                    TENANT, c["id"],
                    *[c.get(k) for k in COLS],
                    1 if c.get("excluded") else 0,
                    1 if c["id"] in selected else 0,
                    i,
                    *[None if c.get(k) is None else json.dumps(c[k], ensure_ascii=False, default=str)
                      for k in JSON_COLS],
                    c.get("segmentSource"),
                    None if c.get("segmentScore") is None else json.dumps(c["segmentScore"]),
                    *[c.get(k) for k in EXTRA_COLS],
                    now,
                ))
            d.execute("COMMIT")
        except Exception:
            d.execute("ROLLBACK")
            raise
    return state


def update(fn) -> dict:
    s = load()
    fn(s)
    return save(s)


def reset() -> dict:
    """초기화 — 이 테넌트의 데이터만 지운다."""
    d = _db()
    with _write_lock:
        d.execute("DELETE FROM cards WHERE tenant = ?", (TENANT,))
        d.execute("DELETE FROM meta  WHERE tenant = ?", (TENANT,))
        d.commit()
    return load()


def db_path() -> str:
    return DB_PATH
