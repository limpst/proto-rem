import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILE_DIR = path.join(ROOT, '.auth', process.env.PROTO_REM_PROFILE ?? 'rem-profile');

/**
 * 로그인 세션이 디스크에 남는 영속 프로필로 브라우저를 연다.
 * 한 번 수동 로그인해두면 이후 실행에서는 로그인 상태가 유지된다.
 */
export async function openBrowser({ headless = false } = {}) {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    // 기본은 Playwright 번들 Chromium.
    // 시스템 Chrome(channel:'chrome')은 이미 실행 중이면 "Opening in existing browser session"으로
    // 제어권을 잃으므로, 쓰려면 Chrome을 완전히 종료한 뒤 PROTO_REM_CHANNEL=chrome 로 지정한다.
    ...(process.env.PROTO_REM_CHANNEL ? { channel: process.env.PROTO_REM_CHANNEL } : {}),
    viewport: null,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  return { ctx, page };
}
