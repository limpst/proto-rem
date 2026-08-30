import { chromium } from 'playwright';

const BASE = process.env.BASE || 'https://proto-rem.onrender.com';
const SKIP = ['send', 'reset'];
const err = [];
const say = m => console.log(m);
const one = e => String(e && e.message || e).split('\n')[0].slice(0, 140);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
const p = await ctx.newPage();

p.on('console', m => { if (m.type() === 'error') err.push(['console', m.text().slice(0, 300)]); });
p.on('pageerror', e => err.push(['pageerror', String(e).slice(0, 300)]));
p.on('requestfailed', r => err.push(['reqfail', `${r.method()} ${r.url()} — ${r.failure()?.errorText}`]));
p.on('response', async r => {
  if (r.status() >= 400) {
    let body = ''; try { body = (await r.text()).slice(0, 200); } catch {}
    err.push(['http', `${r.status()} ${r.url()} ${body}`]);
  }
});
p.on('dialog', async d => {
  say(`     [${d.type()}] ${d.message().replace(/\n/g, ' | ').slice(0, 200)}`);
  if (d.type() === 'confirm') await d.dismiss(); else await d.accept();
});

await p.goto(BASE, { waitUntil: 'networkidle', timeout: 90000 });
await p.waitForSelector('.step', { timeout: 30000 });

const steps = await p.$$eval('.step', els => els.map(e => ({ n: e.dataset.n, lb: e.querySelector('.lb').textContent.replace(/\s+/g, ' ').trim() })));
say('STEPS: ' + steps.map(s => s.n + '.' + s.lb).join(' | '));

for (const s of steps) {
  say(`\n===== STEP ${s.n} ${s.lb} =====`);
  try {
    await p.click(`.step[data-n="${s.n}"]`, { timeout: 10000 });
  } catch (e) {
    say('  X 사이드바 진입 실패: ' + one(e));
    const html = await p.$eval('#view', el => el.innerText.slice(0, 400)).catch(() => '?');
    say('  VIEW: ' + html.replace(/\s+/g, ' '));
    continue;
  }
  await p.waitForTimeout(400);
  await p.$$eval('details', ds => ds.forEach(d => { d.open = true; })).catch(() => {});
  await p.waitForTimeout(200);

  const before = err.length;
  const n0 = (await p.$$('main button, main .opt')).length;
  say(`  버튼 ${n0}개`);

  for (let i = 0; i < n0; i++) {
    const list = await p.$$('main button, main .opt');
    const el = list[i];
    if (!el) { say(`  #${i} (리렌더로 사라짐)`); continue; }
    let label = '', act = null, dis = false;
    try {
      label = (await el.innerText()).replace(/\s+/g, ' ').trim().slice(0, 44);
      act = await el.getAttribute('data-act');
      dis = await el.isDisabled();
    } catch (e) { say(`  #${i} 접근 실패 ${one(e)}`); continue; }
    if (dis) { say(`  #${i} [${label}] disabled`); continue; }
    if (SKIP.includes(act)) say(`  #${i} [${label}] (파괴적 — confirm 취소)`);

    const t0 = Date.now();
    try {
      await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await el.click({ timeout: 6000 });
      await p.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
      await p.waitForTimeout(250);
      say(`  #${i} [${label}] ok ${Date.now() - t0}ms`);
    } catch (e) {
      say(`  #${i} [${label}] X ${one(e)}`);
    }
    // 클릭 후 details 가 닫혔을 수 있으니 다시 펼침
    await p.$$eval('details', ds => ds.forEach(d => { d.open = true; })).catch(() => {});
  }
  const dn = err.length - before;
  if (dn) say(`  ! 이 단계 에러 ${dn}건`);
}

const noTitle = [];
for (const s of steps) {
  await p.click(`.step[data-n="${s.n}"]`, { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(250);
  await p.$$eval('details', ds => ds.forEach(d => { d.open = true; })).catch(() => {});
  const rows = await p.$$eval('main button, main .opt', els => els.map(e => ({
    t: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 34), has: !!e.getAttribute('title'),
  }))).catch(() => []);
  rows.filter(r => !r.has && r.t).forEach(r => noTitle.push(`S${s.n} ${r.t}`));
}
say('\n===== title(툴팁) 없는 버튼 =====');
say([...new Set(noTitle)].join('\n'));

say(`\n===== 에러 ${err.length}건 =====`);
const seen = new Set();
for (const [k, v] of err) {
  const key = k + v.slice(0, 120);
  if (seen.has(key)) continue;
  seen.add(key);
  say(`[${k}] ${v}`);
}

await b.close();
