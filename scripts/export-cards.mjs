/**
 * 리멤버 명함 반출.
 *
 * 두 가지 경로를 모두 지원한다.
 *
 *   --via=profile  (기본)
 *     proto-rem 전용 브라우저 프로필(.auth/rem-profile)로 연다.
 *     그 프로필에 한 번 로그인해 두면(npm run login) 이후로는 자동으로 수집한다.
 *     사용자가 평소 쓰는 Chrome 을 건드리지 않는다.
 *
 *   --via=cdp
 *     이미 로그인된 사용자 Chrome 에 CDP 로 붙는다.
 *     Chrome 을 완전히 종료한 뒤 --remote-debugging-port=9222 로 실행해 두어야 한다.
 *
 * 실행:  npm run export            (profile)
 *        npm run export -- --via=cdp
 *
 * 결과:  data/cards.json          (대시보드 STEP 1 이 자동으로 읽는다)
 *        data/raw/remember-api.json  (추출 실패 시 구조 확인용 원본)
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openBrowser, ROOT } from './browser.mjs';

const argv = process.argv.slice(2);
const arg = k => argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const VIA = arg('via') ?? process.env.REMEMBER_VIA ?? 'profile';
const CDP = process.env.CDP_URL ?? 'http://localhost:9222';
const CARD_URL = 'https://card.rememberapp.co.kr/';

/** 응답 JSON 어디에 명함 배열이 있는지 모르므로, 명함처럼 생긴 객체를 재귀 탐색한다. */
const CARD_KEYS = ['name', 'company', 'companyName', 'mobile', 'email', 'department', 'position'];
function harvest(node, out, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) { for (const v of node) harvest(v, out, depth + 1); return; }
  if (typeof node !== 'object') return;
  const keys = Object.keys(node);
  if (CARD_KEYS.filter(k => keys.includes(k)).length >= 3) out.push(node);
  for (const v of Object.values(node)) harvest(v, out, depth + 1);
}

async function open() {
  if (VIA === 'cdp') {
    const browser = await chromium.connectOverCDP(CDP).catch(e => {
      console.error(`\nChrome 에 붙지 못했습니다 (${CDP}).`);
      console.error('Chrome 을 완전히 종료한 뒤 아래로 다시 실행해 주세요:');
      console.error('  & "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222\n');
      console.error(String(e.message ?? e));
      process.exit(1);
    });
    const ctx = browser.contexts()[0];
    return { closer: () => browser.close(), page: await ctx.newPage() };
  }
  const { ctx, page } = await openBrowser({ headless: process.env.HEADLESS === '1' });
  return { closer: () => ctx.close(), page };
}

const { closer, page } = await open();

const raw = [];
page.on('response', async (res) => {
  const url = res.url();
  if (!/api\.rememberapp\.co\.kr/.test(url)) return;
  if (/client_config/.test(url)) return;
  try { raw.push({ url: url.split('?')[0], body: await res.json() }); } catch { /* JSON 아님 */ }
});

console.log(`명함 페이지를 여는 중… (via=${VIA})`);
await page.goto(CARD_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

if (/\/login/.test(page.url())) {
  console.error('\n로그인되어 있지 않습니다.');
  console.error(VIA === 'cdp'
    ? '  이 Chrome 에서 리멤버에 로그인한 뒤 다시 실행해 주세요.'
    : '  먼저 npm run login 으로 이 프로필에 한 번 로그인해 주세요.');
  await closer();
  process.exit(2);
}

// 목록 끝까지 스크롤한다. 새 API 응답이 더 안 들어오면 끝으로 본다.
let idle = 0;
for (let i = 0; i < 200 && idle < 5; i++) {
  const before = raw.length;
  await page.mouse.wheel(0, 4000);
  await page.waitForTimeout(1000);
  idle = raw.length === before ? idle + 1 : 0;
  if (i % 10 === 0) process.stdout.write(`  스크롤 ${i} · API ${raw.length}건\r`);
}
console.log(`\n  API 응답 ${raw.length}건 수집`);

const found = [];
for (const r of raw) harvest(r.body, found);

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
  console.log('\n명함을 찾지 못했습니다.');
  console.log(`API 응답 ${raw.length}건을 data/raw/remember-api.json 에 남겼습니다. 이 구조를 보고 추출 규칙을 맞추면 됩니다.`);
}

await closer();
