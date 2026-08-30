/**
 * LLM 백엔드 어댑터.
 *
 * 기본은 **Ollama**(로컬호스트 11434). 명함은 개인정보이므로 PC 밖으로 내보내지 않는 것이 기본값이다.
 * 대시보드(AI 엔진 패널)에서 백엔드와 모델을 런타임에 바꿀 수 있고, 그 선택은 store 에 남는다.
 *
 * 우선순위 (LLM_BACKEND 로 강제 지정 가능: ollama | claude-api | claude-cli)
 *   1. ollama       — 로컬 실행. 데이터가 PC 밖으로 나가지 않는다.
 *   2. claude-api   — ANTHROPIC_API_KEY 가 있을 때
 *   3. claude-cli   — 설치된 Claude Code CLI 경유 (키 발급 불필요)
 *
 * 백엔드가 바뀌어도 호출부(enrich/generate/copy-ai)는 complete() 하나만 쓴다.
 */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { env } from './env.mjs';
import { load, update } from './store.mjs';

export const CLAUDE_MODEL = 'claude-sonnet-5';
export const OLLAMA_URL = env('OLLAMA_URL', 'http://127.0.0.1:11434');
export const DEFAULT_OLLAMA_MODEL = env('OLLAMA_MODEL', 'exaone3.5:7.8b');

let cachedBackend = null;
let cliAvailable = null;

/** claude CLI 가 실제로 설치돼 있는지 확인한다.
    배포 서버에는 없다. 확인 없이 고르면 "spawn claude ENOENT" 로 터진다. */
function claudeCliExists() {
  if (cliAvailable !== null) return cliAvailable;
  try {
    const r = spawnSync('claude', ['--version'], {
      windowsHide: true, shell: process.platform === 'win32', timeout: 8000,
    });
    cliAvailable = r.status === 0;
  } catch { cliAvailable = false; }
  return cliAvailable;
}
let cachedOverride = undefined;   // undefined = 아직 안 읽음, null = 저장된 선택 없음

/**
 * Ollama 모델 이름이 클라우드 경유인지 판정한다.
 * 이름이 -cloud 로 끝나거나 remote_model 이 있으면 ollama.com 을 거치므로
 * "로컬이라 안전하다"는 설명이 성립하지 않는다. 화면에서 반드시 갈라 보여야 한다.
 */
export const isCloudModel = m =>
  /[-:]cloud$/.test(String(m?.name ?? m ?? '')) || Boolean(m?.remote_model);

function override() {
  if (cachedOverride === undefined) {
    try { cachedOverride = load().llm ?? null; } catch { cachedOverride = null; }
  }
  return cachedOverride;
}

/** 대시보드에서 백엔드·모델을 바꾼다. 선택은 SQLite meta 에 남아 재시작해도 유지된다. */
export function setBackend({ name, model }) {
  const next = { ...(override() ?? {}) };
  if (name) next.name = name;
  if (model) next.model = model;
  cachedOverride = next;
  cachedBackend = null;
  update(st => { st.llm = next; });
  return next;
}

/** 어떤 백엔드가 실제로 쓰이는지 확인한다. 대시보드가 이 값을 표시한다. */
export async function resolveBackend({ refresh = false } = {}) {
  if (refresh) { cachedBackend = null; cachedOverride = undefined; }
  if (cachedBackend) return cachedBackend;

  const ov = override();
  const forced = ov?.name ?? env('LLM_BACKEND');
  const picked = ov?.model;
  const source = ov?.name ? 'dashboard' : env('LLM_BACKEND') ? 'env' : 'auto';

  if (forced === 'ollama' || (!forced && await ollamaAlive())) {
    const model = picked ?? DEFAULT_OLLAMA_MODEL;
    cachedBackend = {
      name: 'ollama', model, url: OLLAMA_URL, source,
      alive: await ollamaAlive(), cloud: isCloudModel(model),
    };
  } else if (forced === 'claude-cli' && !claudeCliExists()) {
    // 강제 지정이라도 실행할 수 없으면 소용없다.
    // 배포 서버에 LLM_BACKEND=claude-cli 가 남아 있어 "spawn claude ENOENT" 가 났다.
    cachedBackend = env('ANTHROPIC_API_KEY')
      ? {
          name: 'claude-api', model: CLAUDE_MODEL, source, cloud: true,
          note: 'LLM_BACKEND=claude-cli 로 지정됐지만 이 서버에 Claude CLI 가 없어 API 로 대체했습니다.',
        }
      : {
          name: 'none', model: null, source, cloud: false,
          hint: 'LLM_BACKEND=claude-cli 로 지정됐지만 이 서버에는 Claude CLI 가 없습니다. '
              + 'ANTHROPIC_API_KEY 를 설정하고 LLM_BACKEND 를 claude-api 로 바꾸세요.',
        };
  } else if (forced) {
    cachedBackend = { name: forced, model: CLAUDE_MODEL, source, cloud: true };
  } else if (env('ANTHROPIC_API_KEY')) {
    cachedBackend = { name: 'claude-api', model: CLAUDE_MODEL, source, cloud: true };
  } else if (claudeCliExists()) {
    cachedBackend = { name: 'claude-cli', model: CLAUDE_MODEL, source, cloud: true };
  } else {
    // 셋 다 없다. 여기서 정직하게 멈춰야 한다.
    // 예전에는 claude-cli 로 넘어가 배포 서버에서 "spawn claude ENOENT" 로 터졌다.
    cachedBackend = {
      name: 'none', model: null, source, cloud: false,
      hint: 'AI 백엔드가 없습니다. 배포 환경이라면 ANTHROPIC_API_KEY 환경변수를 설정하고, '
          + '내 컴퓨터라면 Ollama 를 실행하거나 Claude Code 를 설치하세요.',
    };
  }
  return cachedBackend;
}

async function ollamaAlive() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

/**
 * 설치된 Ollama 모델 목록. 대시보드의 모델 선택기가 쓴다.
 * 로컬/클라우드를 갈라 표시해야 하므로 cloud 플래그를 같이 준다.
 */
export async function listOllamaModels() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return { ok: false, reason: `http-${r.status}`, models: [] };
    const j = await r.json();
    const models = (j.models ?? []).map(m => ({
      name: m.name,
      params: m.details?.parameter_size ?? '',
      quant: m.details?.quantization_level ?? '',
      ctx: m.details?.context_length ?? null,
      cloud: isCloudModel(m),
    })).sort((a, b) => Number(a.cloud) - Number(b.cloud) || a.name.localeCompare(b.name));
    return { ok: true, models };
  } catch (e) {
    return { ok: false, reason: String(e.message ?? e), models: [] };
  }
}

export async function complete(prompt, opts = {}) {
  const backend = await resolveBackend();
  if (backend.name === 'ollama') return viaOllama(prompt, { model: backend.model, ...opts });
  if (backend.name === 'claude-api') return viaApi(prompt, opts.maxTokens ?? 1500);
  if (backend.name === 'claude-cli') return viaCli(prompt);
  throw new Error(backend.hint ?? 'AI 백엔드가 설정되지 않았습니다.');
}

/**
 * 로컬 Ollama. 명함 정보가 외부로 나가지 않는다 (이름에 -cloud 가 붙은 모델은 예외).
 *
 * 전역 fetch(undici)는 헤더 응답까지 300초 상한이 걸려 있고 요청 단위로 못 바꾼다.
 * 로컬 7.8B 모델은 CPU에서 그 이상 걸리는 경우가 있어 node:http 로 직접 호출한다.
 */
function viaOllama(prompt, { model, maxTokens, temperature } = {}) {
  const timeout = Number(env('OLLAMA_TIMEOUT_MS', 900000));
  const url = new URL('/api/generate', OLLAMA_URL);
  const payload = JSON.stringify({
    model: model ?? DEFAULT_OLLAMA_MODEL,
    prompt,
    stream: false,
    // 호출 사이에 모델이 메모리에서 내려가면 다음 호출에 재로딩(수 분)이 붙는다.
    // 캠페인 한 번은 연속 호출이므로 상주시켜 둔다.
    keep_alive: env('OLLAMA_KEEP_ALIVE', '30m'),
    options: {
      temperature: temperature ?? 0.4,
      num_ctx: 8192,
      // 출력 길이를 묶어 두면 생성 시간의 상한도 같이 묶인다.
      num_predict: Number(maxTokens ?? env('OLLAMA_NUM_PREDICT', 500)),
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
    child.on('error', e => reject(new Error(
      e.code === 'ENOENT'
        ? 'Claude CLI 를 찾지 못했습니다. 배포 환경이라면 ANTHROPIC_API_KEY 를 설정하세요.'
        : `Claude CLI 실행 실패: ${e.message}`)));
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`Claude CLI 오류 (exit ${code}): ${err.slice(0, 300)}`));
      resolve(out.trim());
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
