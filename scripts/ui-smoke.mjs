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

const BASE = process.env.UI_BASE ?? 'http://localhost:5173';
const errors = [];
const dialogs = [];

const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

// 브라우저에서 터지는 것을 전부 모은다. 이게 이 테스트의 핵심이다.
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => {
  if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`);
});
// 404 를 콘솔 문자열로만 보면 "무엇이" 없는지 알 수 없다. URL 을 남긴다.
page.on('response', r => {
  if (r.status() >= 400) errors.push(`http ${r.status()} ${r.request().method()} ${r.url()}`);
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

await step('페이지 로딩 · 로그인', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // 로그인 화면이 뜨면 통과한다. 대시보드가 바로 나오면 이미 로그인 상태다.
  const id = page.locator('#id').first();
  if (await id.count() && !(await page.locator('#rail .step').count())) {
    await id.fill(process.env.APP_USER ?? 'atom');
    await page.locator('input[type="password"]').first().fill(process.env.APP_PASSWORD ?? 'atom');
    await page.getByRole('button').first().click();
    await page.waitForTimeout(1500);
  }
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

// 화면에 실제로 있는 버튼 이름으로 확인한다. 없는 이름을 찾다가 '건너뜀' 이
// 되면 테스트는 통과 표시를 주면서 아무것도 검사하지 않는다. 그게 제일 나쁘다.
/** 접힘 패널 안에 있어도 '화면에 있는' 것으로 본다. 접혀 있는 것은 버그가 아니다. */
const hasButtons = async (step, labels) => {
  const found = await page.locator('#view button').evaluateAll(
    els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  const missing = labels.filter(l => !found.some(f => f.includes(l)));
  if (missing.length) throw new Error(`${step}: 버튼 없음 — ${missing.join(', ')}`);
  console.log(`      · 버튼 ${labels.length}개 확인`);
};

const seen = async (label, sel, min = 1) => {
  const n = await page.locator(sel).count();
  if (n < min) throw new Error(`${label}: ${sel} 이 ${n}개 (${min}개 이상이어야 함)`);
  console.log(`      · ${label} ${n}개`);
};

await step('STEP 1 · 명함 목록이 실제로 있는가', async () => {
  await goStep(1);
  await seen('명함 행', '#view [data-cid], #view tbody tr');
  await hasButtons('STEP 1', ['전부 가져오기', 'CDP 로 가져오기', '붙여넣은 내용으로 명함 만들기']);
});

await step('STEP 2 · 발신 명의·발송 방식 고르기', async () => {
  await goStep(2);
  await hasButtons('STEP 2', ['대표', '마케팅 담당자', '1 : 1 개별 맞춤', '1 : N 고객군 공통']);
});

await step('STEP 3 · 홈페이지 분석 결과가 남아 있는가', async () => {
  await goStep(3);
  await page.waitForTimeout(700);
  const txt = await page.locator('#view').innerText();
  if (!txt.trim()) throw new Error('STEP 3 화면이 비어 있습니다');
});

await step('STEP 4 · 고객군 8종 + 대상 선택', async () => {
  await goStep(4);
  await seen('고객군', '#view .seg, #view [data-seg]', 8);
  await hasButtons('STEP 4', ['발송 가능 전체', '선택 해제']);
});

// 승인·반려 버튼은 문안이 만들어진 뒤에야 생긴다. 초안이 없는 환경(갓 배포한
// 서버 등)에서 이걸 실패로 적으면, 진짜 고장과 구분이 안 된다. 상태를 먼저 본다.
const draftCount = async () => page.evaluate(async () => {
  const r = await fetch('/api/state'); const j = await r.json();
  return (j.cards || []).filter(c => c.message).length;
});

await step('STEP 5 · 문구 화면 (AI 호출은 하지 않음)', async () => {
  await goStep(5);
  await page.waitForTimeout(800);
  await hasButtons('STEP 5', ['문구 추천 받기']);
  const n = await draftCount();
  if (n) await hasButtons('STEP 5', ['승인', '반려']);
  else console.log('      · 초안 0건 — 승인·반려 버튼 검사 생략');
});

await step('STEP 6 · 승인 게이트', async () => {
  await goStep(6);
  await page.waitForTimeout(800);
  const n = await draftCount();
  if (n) await hasButtons('STEP 6', ['승인', '반려']);
  else console.log('      · 초안 0건 — 승인 게이트에 검사할 대상 없음');
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

await step('발송 안전장치 4종이 설정 화면에 있는가', async () => {
  await page.locator('.step[data-n="settings"]').click();
  await page.waitForTimeout(1200);
  const txt = await page.locator('#view').innerText();
  const want = ['수신거부 존중', '재발송 차단 기간', '하루 발송 상한', '발송 간격',
                '연습 모드', '야간 발송 허용', '테스트 수신 주소'];
  const missing = want.filter(w => !txt.includes(w));
  if (missing.length) throw new Error(`설정 화면에 없음: ${missing.join(', ')}`);
  console.log(`      · 발송 관련 설정 ${want.length}개 모두 노출됨`);
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
