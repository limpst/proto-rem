/**
 * 상태 저장소 — SQLite (data/proto-rem.db).
 *
 * 왜 SQLite 인가:
 *   JSON 파일 한 장은 프로토타입에서는 편하지만, 명함이 늘면 매 요청마다 전체를
 *   읽고 쓰게 되고 동시 쓰기에서 깨진다. SQLite 는 파일 하나로 끝나면서
 *   트랜잭션과 질의를 준다. Node 22+ 에 내장(node:sqlite)이라 의존성도 없다.
 *
 * 설계:
 *   - cards 테이블에 명함을 행 단위로 저장한다 (나중에 세그먼트별 질의를 위해)
 *   - 나머지 설정(mode, personaId, sourceProfile...)은 meta 키-값
 *   - tenant 컬럼을 처음부터 둔다. SaaS 전환 때 스키마를 다시 짜지 않기 위해
 *
 * load()/save()/update() 의 겉모습은 이전 JSON 버전과 같다.
 * 호출부(server.mjs)는 바뀌지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const DB_PATH = process.env.DB_PATH ?? path.join(DATA, 'proto-rem.db');
const TENANT = process.env.TENANT_ID ?? 'atom-eng';

const DEFAULTS = {
  tenantId: TENANT,
  cards: [], selection: [], step: 1,
  mode: '1:1',        // 1:1 개별 맞춤 / 1:N 고객군 공통
  personaId: 'sales', // 발신자 명의
};

/** 명함 행에서 그대로 열로 저장하는 필드 */
const COLS = ['name', 'title', 'company', 'dept', 'email', 'phone', 'site', 'siteUrl',
  'met_at', 'note', 'segmentId', 'status'];
/** 객체라서 JSON 문자열로 저장하는 필드 */
const JSON_COLS = ['signals', 'siteFetch', 'siteResolve', 'message'];

let db = null;

function open() {
  if (db) return db;
  fs.mkdirSync(DATA, { recursive: true });

  // node:sqlite 는 Node 22+ 내장. 없으면 즉시 알 수 있게 그대로 던진다.
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (
      tenant TEXT NOT NULL,
      key    TEXT NOT NULL,
      value  TEXT,
      PRIMARY KEY (tenant, key)
    );
    CREATE TABLE IF NOT EXISTS cards (
      tenant       TEXT NOT NULL,
      id           TEXT NOT NULL,
      name         TEXT, title  TEXT, company TEXT, dept TEXT,
      email        TEXT, phone  TEXT, site    TEXT, siteUrl TEXT,
      met_at       TEXT, note   TEXT,
      segmentId    TEXT, status TEXT,
      excluded     INTEGER DEFAULT 0,
      selected     INTEGER DEFAULT 0,
      ord          INTEGER DEFAULT 0,
      signals      TEXT, siteFetch TEXT, siteResolve TEXT, message TEXT,
      deliveredAt  TEXT, queuedAt  TEXT, deliverError TEXT,
      updated_at   TEXT,
      PRIMARY KEY (tenant, id)
    );
    CREATE INDEX IF NOT EXISTS idx_cards_seg ON cards(tenant, segmentId);
  `);
  return db;
}

// ESM 에서 require 를 쓰기 위한 최소 브리지 (node:sqlite 는 named export 가 CJS 스타일)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const parse = v => { try { return v == null ? undefined : JSON.parse(v); } catch { return undefined; } };

function rowToCard(r) {
  const c = { id: r.id, excluded: Boolean(r.excluded) };
  for (const k of COLS) if (r[k] != null) c[k] = r[k];
  for (const k of JSON_COLS) { const v = parse(r[k]); if (v !== undefined) c[k] = v; }
  for (const k of ['deliveredAt', 'queuedAt', 'deliverError']) if (r[k] != null) c[k] = r[k];
  return c;
}

export function load() {
  const d = open();

  const meta = {};
  for (const r of d.prepare('SELECT key, value FROM meta WHERE tenant = ?').all(TENANT)) {
    meta[r.key] = parse(r.value);
  }

  const rows = d.prepare('SELECT * FROM cards WHERE tenant = ? ORDER BY ord, id').all(TENANT);
  const cards = rows.map(rowToCard);
  const selection = rows.filter(r => r.selected).map(r => r.id);

  const state = { ...DEFAULTS, ...meta, cards, selection };

  // 최초 실행이고 DB가 비어 있으면 샘플 시드를 넣는다. 시드가 없으면 빈 상태로 시작한다.
  if (!cards.length && !meta.__seeded) {
    const seed = path.join(ROOT, 'data', 'seed-cards.json');
    if (fs.existsSync(seed)) {
      try {
        state.cards = JSON.parse(fs.readFileSync(seed, 'utf8')).map(c => ({ ...c, status: 'NEW' }));
        state.source = 'seed-sample';
      } catch { /* 시드가 깨졌으면 그냥 빈 상태 */ }
    }
    state.__seeded = true;
    save(state);
  }
  return state;
}

export function save(state) {
  const d = open();
  const now = new Date().toISOString();
  const selected = new Set(state.selection ?? []);

  const tx = d.exec.bind(d);
  tx('BEGIN');
  try {
    // meta — cards/selection 을 뺀 나머지 전부
    const putMeta = d.prepare(
      'INSERT INTO meta (tenant, key, value) VALUES (?, ?, ?) ' +
      'ON CONFLICT(tenant, key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(state)) {
      if (k === 'cards' || k === 'selection') continue;
      putMeta.run(TENANT, k, JSON.stringify(v ?? null));
    }

    // cards — 현재 상태를 그대로 반영 (없어진 명함은 삭제)
    const ids = (state.cards ?? []).map(c => c.id);
    if (ids.length) {
      d.prepare(`DELETE FROM cards WHERE tenant = ? AND id NOT IN (${ids.map(() => '?').join(',')})`)
        .run(TENANT, ...ids);
    } else {
      d.prepare('DELETE FROM cards WHERE tenant = ?').run(TENANT);
    }

    const cols = ['tenant', 'id', ...COLS, 'excluded', 'selected', 'ord',
      ...JSON_COLS, 'deliveredAt', 'queuedAt', 'deliverError', 'updated_at'];
    const put = d.prepare(
      `INSERT INTO cards (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ` +
      `ON CONFLICT(tenant, id) DO UPDATE SET ` +
      cols.filter(c => c !== 'tenant' && c !== 'id').map(c => `${c} = excluded.${c}`).join(', '));

    (state.cards ?? []).forEach((c, i) => {
      put.run(
        TENANT, c.id,
        ...COLS.map(k => c[k] ?? null),
        c.excluded ? 1 : 0,
        selected.has(c.id) ? 1 : 0,
        i,
        ...JSON_COLS.map(k => (c[k] === undefined ? null : JSON.stringify(c[k]))),
        c.deliveredAt ?? null, c.queuedAt ?? null, c.deliverError ?? null,
        now,
      );
    });
    tx('COMMIT');
  } catch (e) {
    tx('ROLLBACK');
    throw e;
  }
  return state;
}

export function update(fn) { const s = load(); fn(s); return save(s); }

/** 초기화 — 이 테넌트의 데이터만 지운다. */
export function reset() {
  const d = open();
  d.prepare('DELETE FROM cards WHERE tenant = ?').run(TENANT);
  d.prepare('DELETE FROM meta  WHERE tenant = ?').run(TENANT);
  return load();
}

export const dbPath = () => DB_PATH;
