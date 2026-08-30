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

export const CLAUDE_MODEL = 'claude-sonnet-5';
export const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'exaone3.5:7.8b';

let cachedBackend = null;

/** 어떤 백엔드가 실제로 쓰이는지 확인한다. 대시보드가 이 값을 표시한다. */
export async function resolveBackend({ refresh = false } = {}) {
  if (cachedBackend && !refresh) return cachedBackend;

  const forced = process.env.LLM_BACKEND;
  if (forced) {
    cachedBackend = { name: forced, model: forced === 'ollama' ? OLLAMA_MODEL : CLAUDE_MODEL, forced: true };
    return cachedBackend;
  }
  if (await ollamaAlive()) {
    cachedBackend = { name: 'ollama', model: OLLAMA_MODEL, url: OLLAMA_URL };
  } else if (process.env.ANTHROPIC_API_KEY) {
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

/** 로컬 Ollama. 명함 정보가 외부로 나가지 않는다. */
async function viaOllama(prompt) {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.4, num_ctx: 8192 },
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return String(json.response ?? '').trim();
}

async function viaApi(prompt, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
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
