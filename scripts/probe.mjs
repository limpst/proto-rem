/**
 * 로그인된 세션으로 명함 화면을 열고, 페이지가 실제로 호출하는
 * 내부 API(XHR/fetch)를 기록한다. 이 결과를 보고 수집기를 붙인다.
 *
 *   npm run probe
 *
 * 결과: data/raw/api-calls.json  (URL/메서드/상태/응답 일부)
 */
import { openBrowser } from './browser.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './browser.mjs';

const TARGETS = [
  'https://rememberapp.co.kr/#/namecard',
  'https://rememberapp.co.kr/#/setting/config',
];

const { ctx, page } = await openBrowser();
const calls = [];

page.on('response', async (res) => {
  const req = res.request();
  const url = res.url();
  if (req.resourceType() !== 'xhr' && req.resourceType() !== 'fetch') return;
  if (!/rememberapp\.co\.kr/.test(url)) return;
  let preview = '';
  try {
    const text = await res.text();
    preview = text.slice(0, 1500);
  } catch { /* 본문 없음 */ }
  calls.push({ method: req.method(), url, status: res.status(), preview });
  console.log(`${res.status()} ${req.method()} ${url}`);
});

for (const t of TARGETS) {
  console.log(`\n--- ${t} ---`);
  await page.goto(t, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(6000);
}

const out = path.join(ROOT, 'data', 'raw', 'api-calls.json');
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, JSON.stringify(calls, null, 2), 'utf8');
console.log(`\n${calls.length}건 기록 -> ${out}`);

await ctx.close();
