import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:5199';
const say = m => console.log(m);
const err = [];

const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1560, height: 950 } })).newPage();
p.on('pageerror', e => err.push(['pageerror', String(e).slice(0, 200)]));
p.on('console', m => { if (m.type() === 'error') err.push(['console', m.text().slice(0, 200)]); });
p.on('response', r => { if (r.status() >= 400) err.push(['http', `${r.status()} ${r.url()}`]); });
p.on('dialog', async d => {
  say(`   [${d.type()}] ${d.message().replace(/\n/g, ' | ').slice(0, 120)}`);
  if (d.type() === 'confirm') await d.accept(); else await d.accept();
});

await p.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
await p.waitForSelector('.step');

const rowCount = () => p.locator('#view table tbody tr').count();
const nameOf = i => p.locator('#view table tbody tr').nth(i).locator('td').nth(0).innerText();

say(`시작 행 수: ${await rowCount()}`);

// ---- C: 추가 ----
say('\n[C] 명함 추가');
await p.fill('#acName', '테스트 홍길동');
await p.fill('#acTitle', '차장');
await p.fill('#acCompany', '테스트리테일몰');
await p.fill('#acEmail', 'gd.hong@test-retail.co.kr');
await p.fill('#acPhone', '010-1111-2222');
await p.click('button[data-act="addcard"]');
await p.waitForTimeout(1500);
const n1 = await rowCount();
say(`  행 수 ${n1} · 마지막 행: ${(await nameOf(n1 - 1)).replace(/\s+/g, ' ')}`);

// ---- U: 수정 → 저장 ----
say('\n[U] 수정 → 저장');
const last = () => p.locator('#view table tbody tr').nth(n1 - 1);
await last().locator('button[data-edit]').click();
await p.waitForTimeout(400);
await last().locator('.f-name').fill('테스트 홍길순');
await last().locator('.f-title').fill('부장');
await last().locator('.f-company').fill('테스트대학교병원');
await last().locator('button[data-save]').click();
await p.waitForTimeout(1500);
say(`  저장 후: ${(await nameOf(n1 - 1)).replace(/\s+/g, ' ')}`);
say(`  회사·고객군: ${(await last().locator('td').nth(1).innerText()).replace(/\s+/g, ' ').slice(0, 40)}`
  + ` / ${(await last().locator('td').nth(2).innerText()).replace(/\s+/g, ' ').slice(0, 30)}`);

// ---- 취소 동작 ----
say('\n[U] 수정 → 취소 (값이 되돌아가야 함)');
await last().locator('button[data-edit]').click();
await p.waitForTimeout(300);
await last().locator('.f-name').fill('버려질이름');
await last().locator('button[data-cancel]').click();
await p.waitForTimeout(600);
say(`  취소 후: ${(await nameOf(n1 - 1)).replace(/\s+/g, ' ')}`);

// ---- 이름 비우고 저장 시도 ----
say('\n[U] 이름 비우고 저장 (막혀야 함)');
await last().locator('button[data-edit]').click();
await p.waitForTimeout(300);
await last().locator('.f-name').fill('');
await last().locator('button[data-save]').click();
await p.waitForTimeout(600);
say(`  결과: ${(await nameOf(n1 - 1)).replace(/\s+/g, ' ')}`);
await last().locator('button[data-cancel]').click().catch(() => {});
await p.waitForTimeout(400);

// ---- D: 삭제 ----
say('\n[D] 삭제');
await p.locator('#view table tbody tr').nth(n1 - 1).locator('button[data-del]').click();
await p.waitForTimeout(1500);
say(`  행 수 ${await rowCount()}`);

say(`\n에러 ${err.length}건`);
[...new Set(err.map(e => e.join(' ')))].forEach(say);
await b.close();
