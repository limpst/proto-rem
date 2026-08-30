/**
 * 화면 스모크 테스트 — 실제 브라우저로 1~7단계를 눌러 본다.
 *
 *   node scripts/ui-smoke.mjs
 *
 * API 만 두드리는 e2e 와 다르다. 여기서는 사람이 하는 것처럼 버튼을 클릭하고,
 * 그 사이에 터지는 **브라우저 오류(ReferenceError 등)** 를 잡는다.
 * "log is not defined" 같은 건 API 테스트로는 절대 안 잡힌다.
 */
import { chromium } from 'playwright';

const BASE = process.env.UI_BASE ?? 'http://localhost:8787';
const errors = [];
const dialogs = [];

const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

// 브라우저에서 터지는 것을 전부 모은다. 이게 이 테스트의 핵심이다.
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => {
  if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`);
});
// alert/confirm 은 자동으로 넘긴다. 내용은 기록한다.
page.on('dialog', async d => {
  dialogs.push(`${d.type()}: ${d.message().slice(0, 160)}`);
  await (d.type() === 'confirm' ? d.accept() : d.dismiss());
});

const step = async (name, fn) => {
  const t0 = Date.now();
  const before = errors.length;
  try {
    await fn();
    const ms = ((Date.now() - t0) / 1000).toFixed(1);
    const bad = errors.length - before;
    console.log(`  ${bad ? '✕' : '✔'} ${name}  (${ms}s)${bad ? ` — 오류 ${bad}건` : ''}`);
    return !bad;
  } catch (e) {
    console.log(`  ✕ ${name}  — ${String(e.message).split('\n')[0].slice(0, 120)}`);
    errors.push(`${name}: ${e.message}`);
    return false;
  }
};

/** 화면에 보이는 버튼을 글자로 찾아 누른다. 없으면 조용히 건너뛴다. */
async function click(text, { wait = 1200, must = false } = {}) {
  const b = page.getByRole('button', { name: text, exact: false }).first();
  if (!(await b.count())) {
    if (must) throw new Error(`버튼을 찾지 못했습니다: ${text}`);
    console.log(`      · '${text}' 버튼 없음 — 건너뜀`);
    return false;
  }
  if (await b.isDisabled()) {
    console.log(`      · '${text}' 비활성 — 건너뜀`);
    return false;
  }
  await b.click();
  await page.waitForTimeout(wait);
  return true;
}

const goStep = async (n) => {
  await page.locator(`.step[data-n="${n}"]`).click();
  await page.waitForTimeout(500);
};

console.log(`\n화면 스모크 — ${BASE}\n`);

await step('페이지 로딩', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#rail .step', { timeout: 20000 });
});

await step('사이드바 · 흐름도 렌더', async () => {
  const steps = await page.locator('#rail .step').count();
  const nodes = await page.locator('.fnode').count();
  if (steps < 8) throw new Error(`사이드바 항목이 ${steps}개뿐입니다`);
  if (!nodes) throw new Error('흐름도가 그려지지 않았습니다');
});

await step('관리자 설정 열기', async () => {
  await page.locator('.step[data-n="settings"]').click();
  await page.waitForTimeout(1500);
  const n = await page.locator('[data-setting], [data-set]').count();
  if (!n) throw new Error('설정 항목이 하나도 없습니다');
});

await step('STEP 1 · 명함 수집', async () => {
  await goStep(1);
  await click('명함 불러오기');
});

await step('STEP 2 · 발신·홈페이지', async () => {
  await goStep(2);
  await click('홈페이지 자동 찾기', { wait: 3000 });
});

await step('STEP 3 · 저장된 분석으로 건너뛰기', async () => {
  await goStep(3);
  await click('저장된 분석으로 건너뛰기', { wait: 2500 });
});

await step('STEP 4 · 고객군 분류 + 대상 선택', async () => {
  await goStep(4);
  await click('고객군 분류', { wait: 2500 });
  const boxes = page.locator('.pick:not(:disabled)');
  const n = Math.min(await boxes.count(), 2);
  for (let i = 0; i < n; i++) { await boxes.nth(i).check(); await page.waitForTimeout(400); }
});

await step('STEP 5 · 화면 렌더', async () => {
  await goStep(5);
  await page.waitForTimeout(800);
});

await step('STEP 6 · 화면 렌더', async () => {
  await goStep(6);
  await page.waitForTimeout(800);
});

await step('STEP 7 · 발송 이력 (검색·정렬·페이징)', async () => {
  await goStep(7);
  await page.waitForTimeout(800);
  const q = page.locator('[data-tq="deliver"]');
  if (await q.count()) {
    await q.fill('테스트');
    await page.waitForTimeout(700);
    await q.fill('');
    await page.waitForTimeout(700);
  }
  const th = page.locator('[data-tsort]').first();
  if (await th.count()) { await th.click(); await page.waitForTimeout(600); }
});

await step('전체 보기', async () => {
  await page.locator('.step[data-n="all"]').click();
  await page.waitForTimeout(1500);
});

await step('시스템 로그 콘솔 열기', async () => {
  const bar = page.locator('#conbar');
  if (await bar.count()) { await bar.click(); await page.waitForTimeout(600); }
});

console.log('\n' + '─'.repeat(60));
if (errors.length) {
  console.log(`브라우저 오류 ${errors.length}건\n`);
  [...new Set(errors)].slice(0, 20).forEach(e => console.log('  •', e));
} else {
  console.log('브라우저 오류 없음');
}
if (dialogs.length) {
  console.log(`\n대화상자 ${dialogs.length}건`);
  dialogs.slice(0, 10).forEach(d => console.log('  ·', d));
}
console.log('─'.repeat(60) + '\n');

await browser.close();
process.exit(errors.length ? 1 : 0);
