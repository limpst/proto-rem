/**
 * 의존성 없는 .env 로더.
 *
 * process.env 가 항상 우선한다 (PORT=8787 npm start 같은 실행 시점 지정을 살리기 위해).
 * 파일은 한 번만 읽어 캐시한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let cache = null;

export function env(key, fallback) {
  if (!cache) {
    cache = {};
    const f = path.join(ROOT, '.env');
    if (fs.existsSync(f)) {
      for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && !line.trimStart().startsWith('#')) cache[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  }
  return process.env[key] ?? cache[key] ?? fallback;
}

/** deliver.mjs 처럼 전체 맵이 필요한 곳에서 쓴다. */
export function allEnv() {
  env('__warm');           // 캐시 채우기
  return { ...cache, ...process.env };
}
