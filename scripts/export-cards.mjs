/**
 * 리멤버 명함 반출 — 이미 로그인된 사용자 Chrome에 CDP로 붙어서 수집한다.
 *
 * 왜 이 방식인가:
 *   구글/네이버는 Playwright가 띄운 브라우저의 로그인을 차단한다(signin/rejected).
 *   반면 사용자가 평소 쓰는 Chrome은 이미 로그인되어 있다. 그 세션에 붙으면
 *   비밀번호를 다루지 않고도 수집이 가능하다.
 *
 * 사전 준비 (1회):
 *   Chrome을 완전히 종료한 뒤 디버깅 포트를 열어 다시 실행한다.
 *   "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
 *
 * 실행:
 *   npm run export
 *
 * 결과: data/cards.json  (대시보드 STEP 1이 이 파일을 자동으로 읽는다)
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './browser.mjs';

const CDP = process.env.CDP_URL ?? 'http://localhost:9222';
const CARD_URL = 'https://card.rememberapp.co.kr/';

/** 응답 JSON 어디에 명함 배열이 있는지 모르므로, 명함처럼 생긴 객체를 재귀 탐색한다. */
const CARD_KEYS = ['name', 'company', 'companyName', 'mobile', 'email', 'department', 'position'];
function harvest(node, out, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) { for (const v of node) harvest(v, out, depth + 1); return; }
  if (typeof node !== 'object') return;
  const keys = Object.keys(node);
  const hit = CARD_KEYS.filter(k => keys.includes(k)).length;
  if (hit >= 3) out.push(node);
  for (const v of Object.values(node)) harvest(v, out, depth + 1);
}

const browser = await chromium.connectOverCDP(CDP).catch(e => {
  console.error(`\nChrome에 붙지 못했습니다 (${CDP}).`);
  console.error('Chrome을 완전히 종료한 뒤 아래로 다시 실행해 주세요:');
  console.error('  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222\n');
  console.error(String(e.message ?? e));
  process.exit(1);
});

const ctx = browser.contexts()[0];
const page = await ctx.newPage();

const raw = [];
page.on('response', async (res) => {
  const url = res.url();
  if (!/api\.rememberapp\.co\.kr/.test(url)) return;
  if (/client_config/.test(url)) return;
  try {
    const j = await res.json();
    raw.push({ url: url.split('?')[0], body: j });
  } catch { /* JSON 아님 */ }
});

console.log('명함 페이지를 여는 중…');
await page.goto(CARD_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

// 무한 스크롤 형태를 가정하고 목록 끝까지 내린다.
let prev = -1;
for (let i = 0; i < 60; i++) {
  const n = raw.length;
  await page.mouse.wheel(0, 3000);
  await page.waitForTimeout(1200);
  if (n === prev) break;
  prev = n;
}

const found = [];
for (const r of raw) harvest(r.body, found);

// 중복 제거 + 우리 스키마로 정규화
const seen = new Set();
const cards = [];
for (const [i, c] of found.entries()) {
  const key = `${c.name ?? ''}|${c.company ?? c.companyName ?? ''}|${c.mobile ?? c.phone ?? ''}`;
  if (key === '||' || seen.has(key)) continue;
  seen.add(key);
  cards.push({
    id: `r${String(i).padStart(4, '0')}`,
    name: c.name ?? '',
    title: c.position ?? c.title ?? '',
    company: c.company ?? c.companyName ?? '',
    dept: c.department ?? '',
    email: c.email ?? '',
    phone: c.mobile ?? c.phone ?? '',
    site: c.homepage ?? c.website ?? '',
    met_at: '명함 교환',
    note: c.memo ?? '',
  });
}

await fs.mkdir(path.join(ROOT, 'data', 'raw'), { recursive: true });
await fs.writeFile(path.join(ROOT, 'data', 'raw', 'remember-api.json'), JSON.stringify(raw, null, 2), 'utf8');

if (cards.length) {
  await fs.writeFile(path.join(ROOT, 'data', 'cards.json'), JSON.stringify(cards, null, 2), 'utf8');
  console.log(`\n명함 ${cards.length}건 반출 -> data/cards.json`);
} else {
  console.log(`\n명함을 찾지 못했습니다. API 응답 ${raw.length}건을 data/raw/remember-api.json 에 남겼습니다.`);
  console.log('이 파일의 구조를 보고 추출 규칙을 맞추면 됩니다.');
}

await page.close();
await browser.close();
