/**
 * 1회성 수동 로그인 스크립트.
 *
 *   npm run login
 *
 * 창이 열리면 사용자가 직접 로그인한다 (구글/네이버/카카오 무엇이든).
 * 비밀번호는 사용자만 입력한다 — 스크립트는 자격증명을 다루지 않는다.
 *
 * 로그인 판정은 "명함 API가 실제로 응답했는가"로 한다.
 * 쿠키 존재만으로 판정하면 로그인 페이지에 머물러도 통과하는 오탐이 난다.
 */
import { openBrowser, PROFILE_DIR } from './browser.mjs';

const LOGIN_URL = 'https://card.rememberapp.co.kr/';
const TIMEOUT_MS = 15 * 60 * 1000;

const { ctx, page } = await openBrowser();

let sawCardApi = false;
const seen = new Set();

page.on('response', (res) => {
  const url = res.url();
  if (!/api\.rememberapp\.co\.kr/.test(url)) return;
  if (/\/support\/client_config/.test(url)) return;   // 로그아웃 상태에서도 호출됨
  if (res.status() >= 400) return;
  seen.add(url.split('?')[0]);
  sawCardApi = true;
});

console.log('\n=== 리멤버 로그인 ===');
console.log('열린 창에서 직접 로그인해 주세요. (구글/네이버/카카오 모두 가능)');
console.log('로그인 후 명함 목록이 뜨면 자동으로 감지합니다. (최대 15분 대기)\n');

await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

const deadline = Date.now() + TIMEOUT_MS;
let lastUrl = '';

while (Date.now() < deadline) {
  const url = page.url();
  if (url !== lastUrl) { console.log(`  현재 페이지: ${url}`); lastUrl = url; }

  const onCardApp = /card\.rememberapp\.co\.kr/.test(url) && !/\/login/.test(url);
  if (onCardApp && sawCardApi) break;

  await page.waitForTimeout(2000).catch(() => {});
  if (page.isClosed()) break;
}

if (sawCardApi) {
  console.log('\n로그인 확인됨 — 명함 API 응답을 받았습니다.');
  console.log('감지된 엔드포인트:');
  for (const u of seen) console.log(`  ${u}`);
  console.log(`\n세션 저장 위치: ${PROFILE_DIR}`);
  console.log('다음 단계:  npm run probe\n');
} else {
  console.log('\n로그인이 확인되지 않았습니다 (명함 API 응답 없음). 다시 실행해 주세요.\n');
}

await ctx.close().catch(() => {});
process.exit(sawCardApi ? 0 : 1);
