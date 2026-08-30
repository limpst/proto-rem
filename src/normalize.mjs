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
