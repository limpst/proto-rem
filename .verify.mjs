import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:5199';
const say = m => console.log(m);
const err = [];
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1560, height: 950 } })).newPage();
p.on('pageerror', e => err.push(['pageerror', String(e).slice(0, 200)]));
p.on('console', m => { if (m.type() === 'error') err.push(['console', m.text().slice(0, 200)]); });
p.on('response', r => { if (r.status() >= 400) err.push(['http', `${r.status()} ${r.url()}`]); });
p.on('dialog', async d => { await d.dismiss(); });
await p.goto(BASE, { waitUntil: 'networkidle', timeout: 90000 });
await p.waitForSelector('.step');
let total = 0, noTip = 0;
for (const n of await p.$$eval('.step', e => e.map(x => x.dataset.n))) {
  await p.click(`.step[data-n="${n}"]`);
  await p.waitForTimeout(450);
  await p.$$eval('details', ds => ds.forEach(d => { d.open = true; })).catch(() => {});
  // 첫 행을 편집 모드로 열어 편집용 입력칸까지 검사한다
  await p.locator('#view button[data-edit]').first().click({ timeout: 2000 }).catch(() => {});
  await p.waitForTimeout(350);
  const rows = await p.$$eval('main button, main .opt, main input, main select', els => els.map(e => ({
    t: (e.innerText || e.placeholder || e.tagName).replace(/\s+/g, ' ').trim().slice(0, 24),
    tip: !!(e.dataset.tip || e.getAttribute('title')),
  })));
  total += rows.length;
  const miss = rows.filter(r => !r.tip);
  if (n === '7') say('  S7 상세: ' + JSON.stringify(rows));
  noTip += miss.length;
  say(`STEP ${n}: 클릭요소 ${rows.length} · 툴팁없음 ${miss.length}${miss.length ? ' → ' + miss.map(r => r.t).join(', ') : ''}`);
}
say(`\n합계 ${total}개 중 툴팁 없음 ${noTip}개`);
say(`에러 ${err.length}건`);
[...new Set(err.map(e => e.join(' ')))].forEach(say);
await b.close();
