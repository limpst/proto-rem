/**
 * 명함 UPSERT — 새 데이터를 받아도 기존 작업을 날리지 않는다.
 *
 * 지금까지는 붙여넣기·업로드가 st.cards 를 통째로 갈아끼웠다.
 * 그러면 이미 해둔 고객군 분류, 홈페이지 리서치 근거, 생성한 문안, 승인 이력,
 * 발송 기록이 전부 사라진다. 명함 두 장을 더 넣으려다 캠페인 하나를 잃는 셈이다.
 *
 * 매칭 기준 (위에서부터 시도):
 *   1) 전화번호 숫자 + 이름      — 가장 확실하다. 동명이인을 가른다.
 *   2) 전화번호 숫자만            — 이름 표기가 바뀐 경우 (Hong Gildong ↔ 홍길동)
 *   3) 이름 + 회사명(정규화)      — 전화번호가 없는 명함
 *
 * 갱신 규칙:
 *   - 연락처 필드는 새 값이 비어 있지 않을 때만 덮어쓴다. 빈 값으로 지우지 않는다.
 *   - 파이프라인 상태(분류·근거·문안·승인·발송)는 건드리지 않는다.
 *   - 단, 회사나 이메일이 실제로 바뀌었으면 리서치 근거는 낡은 것이므로 비운다.
 */

const digits = v => String(v ?? '').replace(/\D/g, '');
const squash = v => String(v ?? '').replace(/\s+/g, '').toLowerCase();
const normCo = v => squash(v).replace(/㈜|\(주\)|주식회사|\(유\)|유한회사/g, '');

/** 연락처 필드 — 새 값이 있으면 갱신 대상 */
const CONTACT = ['name', 'title', 'company', 'dept', 'email', 'phone', 'site', 'met_at', 'note'];

function indexOf(cards) {
  const byPhoneName = new Map();
  const byPhone = new Map();
  const byNameCo = new Map();
  cards.forEach((c, i) => {
    const p = digits(c.phone);
    const n = squash(c.name);
    if (p.length >= 9 && n) byPhoneName.set(`${p}|${n}`, i);
    if (p.length >= 9 && !byPhone.has(p)) byPhone.set(p, i);
    if (n) byNameCo.set(`${n}|${normCo(c.company)}`, i);
  });
  return { byPhoneName, byPhone, byNameCo };
}

function findMatch(idx, inc) {
  const p = digits(inc.phone);
  const n = squash(inc.name);
  if (p.length >= 9 && n && idx.byPhoneName.has(`${p}|${n}`)) {
    return { at: idx.byPhoneName.get(`${p}|${n}`), by: 'phone+name' };
  }
  if (p.length >= 9 && idx.byPhone.has(p)) {
    return { at: idx.byPhone.get(p), by: 'phone' };
  }
  if (n && idx.byNameCo.has(`${n}|${normCo(inc.company)}`)) {
    return { at: idx.byNameCo.get(`${n}|${normCo(inc.company)}`), by: 'name+company' };
  }
  return null;
}

/** 다음 id 를 만든다. 기존 id 와 겹치지 않게 최대값 다음부터. */
function nextIdFactory(cards) {
  let max = -1;
  for (const c of cards) {
    const m = String(c.id ?? '').match(/^r(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max;
  return () => `r${String(++n).padStart(4, '0')}`;
}

/**
 * @param {object[]} existing 현재 DB 의 명함
 * @param {object[]} incoming 새로 들어온 명함
 * @param {{mode?: 'upsert'|'replace'}} opts
 * @returns {{cards, inserted, updated, unchanged, replaced, details}}
 */
export function upsertCards(existing, incoming, { mode = 'upsert' } = {}) {
  if (mode === 'replace') {
    return {
      cards: incoming.map((c, i) => ({ ...c, id: `r${String(i).padStart(4, '0')}`, status: 'NEW' })),
      inserted: incoming.length, updated: 0, unchanged: 0, replaced: true, details: [],
    };
  }

  const cards = existing.map(c => ({ ...c }));
  const idx = indexOf(cards);
  const nextId = nextIdFactory(cards);
  let inserted = 0, updated = 0, unchanged = 0;
  const details = [];

  for (const inc of incoming) {
    if (!String(inc.name ?? '').trim()) continue;
    const hit = findMatch(idx, inc);

    if (!hit) {
      const card = { ...inc, id: nextId(), status: 'NEW' };
      cards.push(card);
      // 새로 넣은 것도 즉시 색인에 반영해야 같은 배치 안의 중복이 또 들어가지 않는다.
      const p = digits(card.phone), n = squash(card.name);
      if (p.length >= 9 && n) idx.byPhoneName.set(`${p}|${n}`, cards.length - 1);
      if (p.length >= 9 && !idx.byPhone.has(p)) idx.byPhone.set(p, cards.length - 1);
      if (n) idx.byNameCo.set(`${n}|${normCo(card.company)}`, cards.length - 1);
      inserted += 1;
      details.push({ id: card.id, name: card.name, action: 'insert' });
      continue;
    }

    const cur = cards[hit.at];
    const changed = [];
    const coChanged = inc.company && normCo(inc.company) !== normCo(cur.company);
    const mailChanged = inc.email && squash(inc.email) !== squash(cur.email);

    for (const k of CONTACT) {
      const v = inc[k];
      if (v == null || String(v).trim() === '') continue;   // 빈 값으로 지우지 않는다
      if (String(cur[k] ?? '') === String(v)) continue;
      cur[k] = v;
      changed.push(k);
    }

    // 회사·이메일이 바뀌면 기존 리서치 근거는 다른 회사의 것이다. 버린다.
    if (coChanged || mailChanged) {
      delete cur.signals;
      delete cur.siteFetch;
      if (coChanged) { delete cur.siteUrl; delete cur.siteResolve; }
      changed.push('리서치 초기화');
    }

    if (changed.length) { updated += 1; details.push({ id: cur.id, name: cur.name, action: 'update', by: hit.by, changed }); }
    else { unchanged += 1; }
  }

  return { cards, inserted, updated, unchanged, replaced: false, details };
}
