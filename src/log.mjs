/**
 * 시스템 로그 링버퍼.
 *
 * 이 도구는 "안 보이는 곳에서 뭔가 오래 돌아가는" 종류라
 * (홈페이지 크롤 → LLM 호출 → SMTP) 사용자가 멈춘 건지 도는 건지 알 수가 없다.
 * 그래서 서버에서 일어나는 모든 흐름을 한 줄씩 남기고, 대시보드 하단 콘솔이
 * /api/logs 로 이어 받아 클라이언트 로그와 같은 창에 합쳐 보여준다.
 *
 * 메모리에만 둔다. 로그에 명함 개인정보가 섞이므로 파일로 떨구지 않는다.
 */
const MAX = 800;
const buf = [];
let seq = 0;

/** 명함·본문이 통째로 로그에 박히지 않게 자른다. */
const clip = (v, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s == null ? '' : (s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s);
};

/**
 * @param {'info'|'ok'|'warn'|'error'|'net'|'ai'} level
 * @param {string} tag   어느 단계에서 나온 로그인지 (ingest / llm / smtp …)
 * @param {string} msg
 * @param {object} [meta] 숫자·상태 같은 짧은 부가정보
 */
export function log(level, tag, msg, meta) {
  const e = {
    seq: ++seq,
    t: new Date().toISOString(),
    level, tag,
    msg: clip(msg, 400),
    meta: meta ? Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, clip(v, 120)])) : undefined,
  };
  buf.push(e);
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  // 터미널에도 같은 줄을 남긴다. npm start 창만 봐도 흐름이 읽히도록.
  const line = `[${tag}] ${e.msg}${e.meta ? ' ' + JSON.stringify(e.meta) : ''}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  return e;
}

/** since 이후의 로그만. 대시보드 콘솔이 폴링으로 이어 받는다. */
export function since(n = 0) {
  return { seq, events: buf.filter(e => e.seq > Number(n || 0)) };
}

export function clear() { buf.length = 0; return { seq, events: [] }; }

/** 오래 걸리는 작업을 감싸 시작·끝·소요시간을 한 쌍으로 남긴다. */
export async function timed(tag, msg, fn, meta) {
  const t0 = Date.now();
  log('info', tag, `▶ ${msg}`, meta);
  try {
    const r = await fn();
    log('ok', tag, `✔ ${msg}`, { ...meta, ms: Date.now() - t0 });
    return r;
  } catch (e) {
    log('error', tag, `✘ ${msg} — ${String(e?.message ?? e)}`, { ...meta, ms: Date.now() - t0 });
    throw e;
  }
}
