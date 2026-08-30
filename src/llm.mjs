/**
 * LLM 백엔드 어댑터.
 *
 * 우선순위 (LLM_BACKEND 환경변수로 강제 지정 가능: ollama | claude-api | claude-cli)
 *   1. ollama       — 로컬 실행. 데이터가 PC 밖으로 나가지 않는다. 명함은 개인정보이므로 기본값으로 둔다.
 *   2. claude-api   — ANTHROPIC_API_KEY 가 있을 때
 *   3. claude-cli   — 설치된 Claude Code CLI 경유 (키 발급 불필요)
 *
 * 백엔드가 바뀌어도 호출부(enrich/generate)는 complete() 하나만 쓴다.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { env } from './env.mjs';

export const CLAUDE_MODEL = 'claude-sonnet-5';
export const OLLAMA_URL = env('OLLAMA_URL', 'http://127.0.0.1:11434');
export const OLLAMA_MODEL = env('OLLAMA_MODEL', 'exaone3.5:2.4b');

let cachedBackend = null;

/** 어떤 백엔드가 실제로 쓰이는지 확인한다. 대시보드가 이 값을 표시한다. */
export async function resolveBackend({ refresh = false } = {}) {
  if (cachedBackend && !refresh) return cachedBackend;

  const forced = env('LLM_BACKEND');
  if (forced) {
    cachedBackend = { name: forced, model: forced === 'ollama' ? OLLAMA_MODEL : CLAUDE_MODEL, forced: true };
    return cachedBackend;
  }
  if (await ollamaAlive()) {
    cachedBackend = { name: 'ollama', model: OLLAMA_MODEL, url: OLLAMA_URL };
  } else if (env('ANTHROPIC_API_KEY')) {
    cachedBackend = { name: 'claude-api', model: CLAUDE_MODEL };
  } else {
    cachedBackend = { name: 'claude-cli', model: CLAUDE_MODEL };
  }
  return cachedBackend;
}

async function ollamaAlive() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

export async function complete(prompt, { maxTokens = 1500 } = {}) {
  const backend = await resolveBackend();
  if (backend.name === 'ollama') return viaOllama(prompt);
  if (backend.name === 'claude-api') return viaApi(prompt, maxTokens);
  return viaCli(prompt);
}

/**
 * 로컬 Ollama. 명함 정보가 외부로 나가지 않는다.
 *
 * 전역 fetch(undici)는 헤더 응답까지 300초 상한이 걸려 있고 요청 단위로 못 바꾼다.
 * 로컬 7.8B 모델은 CPU에서 그 이상 걸리는 경우가 있어 node:http 로 직접 호출한다.
 */
function viaOllama(prompt) {
  const timeout = Number(env('OLLAMA_TIMEOUT_MS', 900000));
  const url = new URL('/api/generate', OLLAMA_URL);
  const payload = JSON.stringify({
    model: OLLAMA_MODEL,
    prompt,
    stream: false,
    // 호출 사이에 모델이 메모리에서 내려가면 다음 호출에 재로딩(수 분)이 붙는다.
    // 캠페인 한 번은 연속 호출이므로 상주시켜 둔다.
    keep_alive: env('OLLAMA_KEEP_ALIVE', '30m'),
    options: {
      temperature: 0.4,
      num_ctx: 8192,
      // 출력 길이를 묶어 두면 생성 시간의 상한도 같이 묶인다.
      num_predict: Number(env('OLLAMA_NUM_PREDICT', 500)),
    },
  });

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Ollama ${res.statusCode}: ${body.slice(0, 300)}`));
        try { resolve(String(JSON.parse(body).response ?? '').trim()); }
        catch (e) { reject(new Error(`Ollama 응답 파싱 실패: ${String(e.message)}`)); }
      });
    });

    req.setTimeout(timeout, () => { req.destroy(new Error(`Ollama 타임아웃 (${timeout}ms)`)); });
    req.on('error', reject);
    req.end(payload);
  });
}

async function viaApi(prompt, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.content.map(b => b.text ?? '').join('');
}

/**
 * 프롬프트는 stdin으로 넘긴다.
 * 인자로 넘기면 Windows에서 줄바꿈이 깨지면서 빈 프롬프트로 전달된다.
 */
function viaCli(prompt) {
  // Windows에서 claude 는 .cmd 래퍼라 shell 없이는 spawn EINVAL 이 난다.
  // 프롬프트는 stdin으로 넘기므로 인자에는 단순 플래그만 있어 shell 사용이 안전하다.
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--model', CLAUDE_MODEL, '--output-format', 'text'], {
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`claude CLI exit ${code}: ${err.slice(0, 500)}`));
      resolve(out.trim());
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
