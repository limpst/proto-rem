import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILE_DIR = path.join(ROOT, '.auth', 'chrome-profile');

/**
 * 로그인 세션이 디스크에 남는 영속 프로필로 브라우저를 연다.
 * 한 번 수동 로그인해두면 이후 실행에서는 로그인 상태가 유지된다.
 */
export async function openBrowser({ headless = false } = {}) {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    channel: 'chrome',          // 설치된 실제 Chrome 사용 (구글 로그인 차단 회피에 유리)
    viewport: null,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  return { ctx, page };
}
