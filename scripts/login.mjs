/**
 * 1회성 수동 로그인 스크립트.
 *
 *   npm run login
 *
 * 창이 열리면 사용자가 직접 구글 계정으로 리멤버에 로그인한다.
 * (비밀번호는 사용자만 입력한다. 스크립트는 입력하지 않는다.)
 * 로그인 완료가 감지되면 세션이 .auth/chrome-profile 에 저장되고,
 * 이후 probe/수집 스크립트는 로그인 상태를 그대로 재사용한다.
 */
import { openBrowser } from './browser.mjs';

const LOGIN_URL = 'https://rememberapp.co.kr/';
const TIMEOUT_MS = 10 * 60 * 1000;

const { ctx, page } = await openBrowser();

console.log('\n=== 리멤버 로그인 ===');
console.log('열린 창에서 직접 구글 계정으로 로그인해 주세요.');
console.log('로그인이 끝나면 자동으로 감지하고 세션을 저장합니다. (최대 10분 대기)\n');

await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

const deadline = Date.now() + TIMEOUT_MS;
let loggedIn = false;

while (Date.now() < deadline) {
  const cookies = await ctx.cookies();
  const hasSession = cookies.some(c =>
    /rememberapp\.co\.kr$/.test(c.domain.replace(/^\./, '')) &&
    /session|token|auth|SID/i.test(c.name) && c.value.length > 20
  );
  const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const looksLoggedIn = hasSession && !/로그인하기|회원가입/.test(body.slice(0, 400));

  if (looksLoggedIn) { loggedIn = true; break; }
  await page.waitForTimeout(2000);
}

if (loggedIn) {
  console.log('\n로그인 감지됨. 세션 저장 완료 (.auth/chrome-profile)');
  console.log('다음 단계:  npm run probe\n');
} else {
  console.log('\n시간 내에 로그인이 감지되지 않았습니다. 창을 닫고 다시 실행해 주세요.\n');
}

await ctx.close();
process.exit(loggedIn ? 0 : 1);
