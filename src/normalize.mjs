/**
 * 리멤버 API 응답을 우리 명함 스키마로 정규화한다.
 *
 * 실제 응답에서 확인된 형태:
 *   name  : { first: "이종하", last: "" }        ← 객체
 *   phone : { international_code: "82",
 *             national_number: "01091048279" }   ← 객체
 *   그리고 회사명만 있고 name 이 빈 객체 — 이건 명함이 아니라
 *   회사 자동완성 후보다. 걸러내야 한다.
 */

/** 명함처럼 생긴 객체를 재귀로 찾는다. */
const CARD_KEYS = ['name', 'company', 'companyName', 'mobile', 'email', 'department', 'position'];

export function harvest(node, out = [], depth = 0) {
  if (!node || depth > 8) return out;
  if (Array.isArray(node)) { for (const v of node) harvest(v, out, depth + 1); return out; }
  if (typeof node !== 'object') return out;
  const keys = Object.keys(node);
  if (CARD_KEYS.filter(k => keys.includes(k)).length >= 3) out.push(node);
  for (const v of Object.values(node)) harvest(v, out, depth + 1);
  return out;
}

export function flatName(v) {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object') return [v.last, v.first].filter(Boolean).join(' ').trim();
  return '';
}

export function flatPhone(v) {
  if (typeof v === 'string') return v.trim();
  if (!v || typeof v !== 'object') return '';
  const n = String(v.national_number ?? v.normalized_number ?? '').replace(/\D/g, '');
  if (!n) return '';
  // 010-1234-5678 / 02-123-4567 형태로만 정리한다.
  if (n.length === 11) return `${n.slice(0, 3)}-${n.slice(3, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}`;
  return n;
}

const str = v => (typeof v === 'string' ? v.trim() : '');

/* ── 텍스트 붙여넣기 파서 ────────────────────────────────────
   명함이 몇 건뿐일 때는 브라우저를 거치는 것보다 그냥 붙여넣는 게 훨씬 빠르다.
   엑셀에서 복사한 표(탭 구분), CSV, 그리고 리멤버 화면에서 긁은 덩어리 텍스트를
   모두 받아 준다. 규칙 기반으로 먼저 시도하고, 안 되면 호출부가 LLM 파서로 넘긴다. */

const HEADER_MAP = {
  name: ['이름', '성명', '담당자', 'name'],
  title: ['직함', '직위', '직책', 'title', 'position'],
  company: ['회사', '회사명', '소속', 'company'],
  dept: ['부서', '팀', 'dept', 'department'],
  email: ['이메일', '메일', 'email', 'e-mail'],
  phone: ['전화', '휴대폰', '연락처', '핸드폰', 'phone', 'mobile'],
  site: ['홈페이지', '사이트', 'url', 'site', 'homepage'],
};

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /(0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4})/;
const URL_RE = /((?:https?:\/\/)?(?:www\.)?[\w-]+\.(?:com|co\.kr|kr|net|org|io|cloud|ac\.kr|or\.kr|go\.kr)(?:\/\S*)?)/i;

const headerKey = cell => {
  const v = String(cell ?? '').trim().toLowerCase();
  for (const [k, aliases] of Object.entries(HEADER_MAP)) {
    if (aliases.some(a => v === a || v.includes(a))) return k;
  }
  return null;
};

/**
 * 붙여넣은 텍스트를 명함 배열로 만든다.
 * @returns {{cards: object[], mode: 'table'|'freeform'|'none'}}
 *   mode==='freeform' 이면 규칙으로 못 나눈 것이라 LLM 파싱이 필요하다.
 */
export function parseText(text) {
  const lines = String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { cards: [], mode: 'none' };

  // 1) 표 형태 — 탭 또는 쉼표로 2칸 이상 나뉘는 줄이 과반이면 표로 본다.
  const split = l => (l.includes('\t') ? l.split('\t') : l.split(','));
  const tabular = lines.filter(l => split(l).length >= 2).length >= Math.ceil(lines.length / 2);

  if (tabular) {
    const rows = lines.map(l => split(l).map(c => c.trim()));
    const head = rows[0].map(headerKey);
    const hasHeader = head.filter(Boolean).length >= 2;
    const cols = hasHeader ? head : ['name', 'title', 'company', 'email', 'phone', 'site'];
    const body = hasHeader ? rows.slice(1) : rows;

    const cards = [];
    for (const r of body) {
      const c = {};
      r.forEach((cell, i) => { if (cols[i]) c[cols[i]] = cell; });
      // 열 위치가 어긋나도 이메일/전화/URL 은 내용으로 찾아 바로잡는다.
      const joined = r.join(' ');
      if (!EMAIL_RE.test(c.email ?? '')) c.email = (joined.match(EMAIL_RE) ?? [''])[0];
      if (!PHONE_RE.test(c.phone ?? '')) c.phone = (joined.match(PHONE_RE) ?? [''])[0];
      if (!c.site) c.site = (joined.match(URL_RE) ?? [''])[0];
      if (c.name) cards.push(c);
    }
    if (cards.length) return { cards: toCards(cards), mode: 'table' };
  }

  // 2) 덩어리 텍스트 — 빈 줄로 나뉜 블록마다 한 사람으로 본다.
  const blocks = String(text).split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const cards = [];
  for (const b of blocks) {
    const bl = b.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const email = (b.match(EMAIL_RE) ?? [''])[0];
    const phone = (b.match(PHONE_RE) ?? [''])[0];
    const site = (b.match(URL_RE) ?? [''])[0];
    // 이메일·전화·URL 이 아닌 줄들 중 첫 줄을 이름, 나머지를 직함/회사로 본다.
    const plain = bl.filter(l => !EMAIL_RE.test(l) && !PHONE_RE.test(l) && !URL_RE.test(l));
    if (!plain.length) continue;
    cards.push({
      name: plain[0], title: plain[1] ?? '', company: plain[2] ?? plain[1] ?? '',
      email, phone, site: site && site !== email ? site : '',
    });
  }
  if (cards.length) return { cards: toCards(cards), mode: 'freeform' };
  return { cards: [], mode: 'none' };
}

/**
 * 수집한 원본 객체들을 명함 배열로 만든다.
 * 이름이 없는 항목은 명함이 아니므로 버린다 (회사 자동완성 후보 등).
 */
export function toCards(found) {
  const seen = new Set();
  const cards = [];
  for (const c of found) {
    const name = flatName(c.name);
    const company = str(c.company) || str(c.companyName);
    if (!name) continue;

    const phone = flatPhone(c.phone ?? c.mobile);
    const key = `${name}|${company}|${phone}`;
    if (seen.has(key)) continue;
    seen.add(key);

    cards.push({
      id: `r${String(cards.length).padStart(4, '0')}`,
      name,
      title: str(c.position) || str(c.title),
      company,
      dept: str(c.department),
      email: str(c.email),
      phone,
      site: str(c.homepage) || str(c.website),
      met_at: '명함 교환',
      note: str(c.memo),
    });
  }
  return cards;
}
