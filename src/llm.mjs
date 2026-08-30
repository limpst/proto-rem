/**
 * LLM 백엔드 어댑터.
 * 1순위: ANTHROPIC_API_KEY 가 있으면 Claude API 직접 호출
 * 2순위: 없으면 로컬 Claude Code CLI(`claude -p`)를 사용 → 별도 키 발급 없이 동작
 */
import { spawn } from 'node:child_process';

const MODEL = 'claude-sonnet-5';

export async function complete(prompt, { maxTokens = 1500 } = {}) {
  if (process.env.ANTHROPIC_API_KEY) return viaApi(prompt, maxTokens);
  return viaCli(prompt);
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
      model: MODEL,
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
    const child = spawn('claude', ['-p', '--model', MODEL, '--output-format', 'text'], {
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
