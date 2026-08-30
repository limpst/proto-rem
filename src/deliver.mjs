/**
 * 7단계 발송 — Gmail SMTP.
 *
 * 자격증명은 코드나 저장소에 두지 않는다. 프로젝트 루트 .env 에 넣는다:
 *
 *   GMAIL_USER=보내는주소@gmail.com
 *   GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx      # 앱 비밀번호 16자리 (계정 비밀번호 아님)
 *   GMAIL_FROM_NAME=에이톰엔지니어링
 *
 * 앱 비밀번호는 Google 계정 > 보안 > 2단계 인증 > 앱 비밀번호 에서 사용자가 직접 발급한다.
 * (.env 는 .gitignore 에 포함되어 커밋되지 않는다.)
 *
 * 안전장치:
 *   - 승인(APPROVED)된 건만 전송된다.
 *   - 21~08시에는 전송하지 않는다 (정보통신망법상 야간 광고 전송 제한).
 *   - DRY_RUN=1 이면 전송 대신 로그만 남긴다.
 */
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 의존성 없이 .env 를 읽는다. */
function env() {
  const f = path.join(ROOT, '.env');
  const out = { ...process.env };
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

export function smtpStatus() {
  const e = env();
  return {
    configured: Boolean(e.GMAIL_USER && e.GMAIL_APP_PASSWORD),
    user: e.GMAIL_USER ? e.GMAIL_USER.replace(/(.{2}).*(@.*)/, '$1***$2') : null,
    dryRun: e.DRY_RUN === '1',
  };
}

/**
 * 정보통신망법상 광고성 정보의 야간(21~08시) 전송 제한.
 *
 * 자가 테스트(본인 주소로 보내보기)는 광고성 전송이 아니므로 막을 이유가 없다.
 * 그래서 삭제하지 않고 스위치로 둔다: .env 의 ALLOW_NIGHT_SEND=1 이면 해제된다.
 * 실제 캠페인 전에는 반드시 0(또는 삭제)으로 되돌릴 것.
 */
const nightBlocked = (e) => {
  if (e.ALLOW_NIGHT_SEND === '1') return false;
  const h = new Date().getHours();
  return h >= 21 || h < 8;
};

/** 최소 SMTP 클라이언트 (Gmail: smtp.gmail.com:465, 암묵적 TLS) */
function smtpSend({ user, pass, from, to, subject, body }) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' });
    let buf = '';
    let stage = 0;
    let messageId = '';

    const b64 = s => Buffer.from(s, 'utf8').toString('base64');
    const mime = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${b64(subject)}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(body).replace(/(.{76})/g, '$1\r\n'),
      '.',
    ].join('\r\n');

    const steps = [
      'EHLO localhost',
      'AUTH LOGIN',
      b64(user),
      b64(pass),
      `MAIL FROM:<${user}>`,
      `RCPT TO:<${to}>`,
      'DATA',
      mime,
      'QUIT',
    ];

    const fail = (msg) => { try { socket.destroy(); } catch {} resolve({ ok: false, error: msg }); };

    socket.setTimeout(30000, () => fail('SMTP timeout'));
    socket.on('error', e => fail(String(e.message ?? e)));

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (!/\r\n$/.test(buf)) return;
      const line = buf.trim().split('\r\n').pop() ?? '';
      buf = '';
      const code = Number(line.slice(0, 3));

      if (code >= 400) return fail(line);
      if (/^250 2\.0\.0 OK/.test(line)) messageId = line;

      if (stage < steps.length) {
        socket.write(steps[stage] + (steps[stage] === mime ? '\r\n' : '\r\n'));
        stage += 1;
      } else {
        socket.end();
        resolve({ ok: true, messageId: messageId || 'sent' });
      }
    });
  });
}

export async function sendEmail({ to, subject, body }) {
  const e = env();
  if (!to) return { ok: false, error: '수신 이메일 주소 없음' };
  if (!e.GMAIL_USER || !e.GMAIL_APP_PASSWORD) {
    return { ok: false, error: '.env 에 GMAIL_USER / GMAIL_APP_PASSWORD 가 없습니다' };
  }
  if (e.DRY_RUN === '1') return { ok: true, messageId: 'dry-run' };
  if (nightBlocked(e)) {
    return { ok: false, error: '야간(21~08시) 광고 전송 제한 — 자가 테스트라면 .env 에 ALLOW_NIGHT_SEND=1' };
  }

  const fromName = e.GMAIL_FROM_NAME ?? '에이톰엔지니어링';
  return smtpSend({
    user: e.GMAIL_USER,
    pass: e.GMAIL_APP_PASSWORD.replace(/\s+/g, ''),
    from: `${fromName} <${e.GMAIL_USER}>`,
    to, subject, body,
  });
}
