import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:5199';
const say = m => console.log(m);
const err = [];
const call = async (p, body) => (await fetch(BASE + p, body
  ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  : {})).json();

// 1) API 로 STEP 5 직전까지 상태를 만든다 (LLM 호출을 1건으로 줄이기 위해)
await call('/api/reset', {});
const seed = JSON.parse(await (await import('node:fs/promises')).readFile('./data/seed-cards.json', 'utf8'));
await call('/api/upload-cards', { cards: seed });
// 1:N 이면 고객군당 문안 1건만 만들면 되므로 LLM 호출이 1회로 끝난다
await call('/api/mode', { mode: '1:N', personaId: 'sales' });
let st = await call('/api/segment', {});
const target = st.cards.find(c => !c.excluded && c.segmentId && !['internal', 'unclassified', 'excluded'].includes(c.segmentId));
if (!target) { console.log('분류된 대상이 없습니다'); process.exit(1); }
await call('/api/selection', { ids: [target.id] });
say(`대상 1건 준비: ${target.name} · ${target.company} · ${target.segmentId}`);

// 2) 브라우저로 STEP 5 → 6 → 7 버튼을 실제로 누른다
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
p.on('pageerror', e => err.push(['pageerror', String(e).slice(0, 300)]));
p.on('console', m => { if (m.type() === 'error') err.push(['console', m.text().slice(0, 300)]); });
p.on('response', async r => { if (r.status() >= 400) err.push(['http', `${r.status()} ${r.url()}`]); });
p.on('dialog', async d => {
  say(`   [${d.type()}] ${d.message().replace(/\n/g, ' | ').slice(0, 160)}`);
  if (d.type() === 'confirm') await d.dismiss(); else await d.accept();
});

await p.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });

const step = async n => { await p.click(`.step[data-n="${n}"]`); await p.waitForTimeout(400); };
const hit = async (sel, name) => {
  const el = p.locator(sel).first();
  if (!(await el.count())) return say(`  [${name}] 없음`);
  if (await el.isDisabled()) return say(`  [${name}] disabled`);
  const t0 = Date.now();
  await el.click();
  await p.waitForLoadState('networkidle', { timeout: 300000 }).catch(() => {});
  await p.waitForTimeout(400);
  say(`  [${name}] ok ${Date.now() - t0}ms`);
};

say('\n===== STEP 5 =====');
await step(5);
await hit('button[data-act="generate"]', '메일 만들기');
// networkidle 은 SPA 의 진행 중 fetch 를 기다려 주지 않는다. 초안 수로 판정한다.
await p.waitForFunction(() => {
  const c = [...document.querySelectorAll('.flow .cell')].find(e => e.querySelector('.k')?.textContent === '초안');
  return c && c.querySelector('.v').textContent !== '0';
}, null, { timeout: 600000 }).catch(() => say('  ! 초안이 만들어지지 않음'));
await p.waitForTimeout(500);
say('  ' + (await p.locator('.flow .cell').nth(5).innerText()).replace(/\s+/g, ' '));

say('\n===== STEP 6 =====');
await step(6);
await hit('button[data-rev="save"]', '고친 내용만 저장');
await hit('button[data-rev="reject"]', '반려');
await hit('button[data-prompt]', '지시문 보기');
await hit('button[data-rev="approve"]', '승인');

say('\n===== STEP 7 =====');
await step(7);
await hit('button[data-act="deliver"]', '발송 큐에 넣기');
await hit('button[data-act="send"]', '실제 발송(confirm 취소)');

say('\n===== 진행 현황 =====');
say((await p.locator('.flow').innerText()).replace(/\s+/g, ' '));
say(`\n===== 에러 ${err.length}건 =====`);
[...new Set(err.map(e => e.join(' ')))].forEach(say);
await b.close();
