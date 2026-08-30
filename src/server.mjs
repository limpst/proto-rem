/**
 * 7단계 파이프라인 프로토타입 서버.
 * HITL 게이트 3곳: STEP2(발송 모드), STEP4(대상 선택), STEP6(문안 승인).
 *   npm start  ->  http://localhost:5173
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { load, save, update } from './store.mjs';
import { SEGMENTS, COMPANY, classify } from './domain.mjs';
import { fetchSite, extractSignals, buildSourceProfile } from './enrich.mjs';
import {
  generateMessage, generateSegmentTemplate, renderTemplate,
  buildPrompt, buildSegmentPrompt, PERSONAS,
} from './generate.mjs';
import { resolveBackend } from './llm.mjs';
import { sendEmail, smtpStatus } from './deliver.mjs';
import { toCards } from './normalize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 5173;

export const STEPS = [
  { n: 1, id: 'ingest',   label: '명함 수집',      hitl: false, desc: '리멤버/CSV에서 명함을 가져온다' },
  { n: 2, id: 'resolve',  label: '발신·발송모드',   hitl: true,  desc: '발신은 에이톰엔지니어링 고정. 발신자 역할과 1:1 / 1:N 을 사람이 선택한다' },
  { n: 3, id: 'enrich',   label: '홈페이지 분석',   hitl: false, desc: 'source(자사)·target(고객) 홈페이지를 읽어 근거를 뽑고, 그 근거로 프롬프트를 조립한다' },
  { n: 4, id: 'segment',  label: '고객군 선택',     hitl: true,  desc: '고객군 자동 분류 → 사람이 발송 대상 확정' },
  { n: 5, id: 'generate', label: '카피 생성',      hitl: false, desc: '조립된 프롬프트로 문안 생성' },
  { n: 6, id: 'review',   label: '검토·승인',      hitl: true,  desc: '사람이 문안 수정 후 승인/반려' },
  { n: 7, id: 'deliver',  label: '발송·추적',      hitl: false, desc: '승인 건만 발송, 이력·응답 기록' },
];

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
const readBody = req => new Promise(r => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => r(b ? JSON.parse(b) : {}));
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // 리멤버 페이지(card.rememberapp.co.kr)에 붙여넣은 스니펫이 이 서버로 직접
  // 명함을 보낼 수 있어야 하므로 CORS 를 연다. 로컬 전용 도구라 허용 범위를 넓게 둔다.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    if (p === '/api/state') {
      return json(res, 200, {
        ...load(), steps: STEPS, segments: SEGMENTS, company: COMPANY,
        personas: PERSONAS,
        backend: await resolveBackend(),
        smtp: smtpStatus(),
      });
    }

    if (p === '/api/reset' && req.method === 'POST') {
      fs.rmSync(path.join(ROOT, 'data', 'state.json'), { force: true });
      return json(res, 200, load());
    }

    // --- 1-a. 리멤버 반출 (이미 로그인된 Chrome에 CDP로 접속) --------------
    if (p === '/api/remember-export' && req.method === 'POST') {
      const { via = 'profile' } = await readBody(req);
      const log = await new Promise(resolve => {
        const child = spawn('npm', ['run', 'export', '--', `--via=${via}`], {
          cwd: ROOT, shell: process.platform === 'win32', windowsHide: true,
        });
        let out = '';
        child.stdout.on('data', d => out += d);
        child.stderr.on('data', d => out += d);
        child.on('close', () => resolve(out));
        child.on('error', e => resolve(String(e.message)));
      });
      const ok = /명함 \d+건 반출/.test(log);
      return json(res, 200, { ok, log: log.slice(-2500) });
    }

    // --- 1-a2. 전용 프로필에 로그인 창 띄우기 -----------------------------
    // 사용자가 그 창에서 직접 로그인한다. 스크립트는 자격증명을 다루지 않는다.
    if (p === '/api/remember-login' && req.method === 'POST') {
      const log = await new Promise(resolve => {
        const child = spawn('npm', ['run', 'login'], {
          cwd: ROOT, shell: process.platform === 'win32', windowsHide: true,
        });
        let out = '';
        child.stdout.on('data', d => out += d);
        child.stderr.on('data', d => out += d);
        child.on('close', () => resolve(out));
        child.on('error', e => resolve(String(e.message)));
      });
      return json(res, 200, { ok: /로그인 확인됨/.test(log), log: log.slice(-2000) });
    }

    // --- 1-b. 자사(에이톰) 홈페이지 프로파일 ------------------------------
    if (p === '/api/source-profile' && req.method === 'POST') {
      const profile = await buildSourceProfile({ force: true });
      return json(res, 200, update(st => { st.sourceProfile = profile; }));
    }

    // --- 1-c. 콘솔 스니펫으로 받은 cards.json 업로드 ----------------------
    if (p === '/api/upload-cards' && req.method === 'POST') {
      const body = await readBody(req);
      // 구버전 스니펫이 name/phone 을 객체 그대로 보낼 수 있으므로 서버에서도 정규화한다.
      const cards = toCards(body.cards ?? []);
      if (!cards.length) return json(res, 400, { error: '이름이 있는 명함이 없습니다' });
      // 업로드본을 반출본과 같은 자리에 두어 이후 [명함 불러오기]가 그대로 읽게 한다.
      fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'data', 'cards.json'), JSON.stringify(cards, null, 2), 'utf8');
      return json(res, 200, {
        ...update(st => {
          st.cards = cards.map(c => ({ ...c, status: 'NEW' }));
          st.source = 'remember-export';
          st.selection = [];
          st.step = 1;
        }),
        steps: STEPS, segments: SEGMENTS, company: COMPANY,
        personas: PERSONAS, backend: await resolveBackend(), smtp: smtpStatus(),
      });
    }

    // --- 1. 수집 -------------------------------------------------------
    if (p === '/api/ingest' && req.method === 'POST') {
      return json(res, 200, update(st => {
        const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed-cards.json'), 'utf8'));
        const exported = path.join(ROOT, 'data', 'cards.json');
        const hasExport = fs.existsSync(exported);
        const src = hasExport ? JSON.parse(fs.readFileSync(exported, 'utf8')) : seed;
        st.cards = src.map(c => ({ ...c, status: 'NEW' }));
        st.source = hasExport ? 'remember-export' : 'seed-sample';
        st.step = 1;
      }));
    }

    // --- 2. 발신 설정 + 발송 모드 (HITL) ---------------------------------
    if (p === '/api/mode' && req.method === 'POST') {
      const { mode, personaId } = await readBody(req);
      return json(res, 200, update(st => {
        if (mode) st.mode = mode === '1:N' ? '1:N' : '1:1';
        if (personaId) st.personaId = personaId;
        // 홈페이지 URL 확정도 이 단계에서 함께 처리한다
        for (const c of st.cards) {
          c.siteUrl = c.site || '';
          c.resolved = Boolean(c.siteUrl);
          if (c.status === 'NEW') c.status = 'RESOLVED';
        }
        st.step = 2;
      }));
    }

    // --- 3. 리서치 ------------------------------------------------------
    if (p === '/api/enrich' && req.method === 'POST') {
      const { ids } = await readBody(req);
      const st = load();
      if (!st.sourceProfile) st.sourceProfile = await buildSourceProfile();
      const targets = st.cards.filter(c => !ids?.length || ids.includes(c.id));
      for (const c of targets) {
        const site = await fetchSite(c.siteUrl);
        c.siteFetch = { ok: site.ok, reason: site.reason, chars: site.text.length };
        c.signals = await extractSignals(c, site.text);
        c.status = 'ENRICHED';
      }
      st.step = 3;
      return json(res, 200, save(st));
    }

    // --- 3-b. 프롬프트 미리보기 (생성하지 않고 프롬프트 원문만 조립) -------
    if (p === '/api/prompt-preview' && req.method === 'POST') {
      const { id, segmentId, channel = 'email' } = await readBody(req);
      const st = load();
      const common = { channel, personaId: st.personaId, sourceProfile: st.sourceProfile };

      if (st.mode === '1:N' || !id) {
        const segment = SEGMENTS.find(s => s.id === (segmentId ?? st.cards.find(c => c.segmentId)?.segmentId));
        if (!segment) return json(res, 200, { prompt: '', note: '고객군을 먼저 분류하세요 (STEP 4).' });
        return json(res, 200, { mode: '1:N', segment: segment.label, prompt: buildSegmentPrompt({ segment, ...common }) });
      }

      const card = st.cards.find(c => c.id === id);
      const segment = SEGMENTS.find(s => s.id === card?.segmentId);
      if (!card || !segment) return json(res, 200, { prompt: '', note: '고객군을 먼저 분류하세요 (STEP 4).' });
      return json(res, 200, {
        mode: '1:1', target: `${card.name} · ${card.company}`,
        prompt: buildPrompt({ card, segment, signals: card.signals ?? { facts: [] }, ...common }),
      });
    }

    // --- 4. 고객군 분류 + 선택 (HITL) ------------------------------------
    if (p === '/api/segment' && req.method === 'POST') {
      return json(res, 200, update(st => {
        for (const c of st.cards) {
          const { segmentId, score } = classify(c);
          c.segmentId = segmentId;
          c.segmentScore = score;
          c.status = 'SCORED';
        }
        st.step = 4;
      }));
    }

    // --- 명함 개별 제외 (본인 프로필 등) ---------------------------------
    if (p === '/api/exclude' && req.method === 'POST') {
      const { id, excluded = true } = await readBody(req);
      return json(res, 200, update(st => {
        const c = st.cards.find(x => x.id === id);
        if (!c) return;
        c.excluded = Boolean(excluded);
        c.segmentId = classify(c).segmentId;
        st.selection = st.selection.filter(x => x !== id || !c.excluded);
      }));
    }

    if (p === '/api/selection' && req.method === 'POST') {
      const { ids } = await readBody(req);
      return json(res, 200, update(st => {
        // 자사(에이톰) 명함은 어떤 경로로도 발송 대상이 되지 않게 서버에서 막는다.
        const internal = new Set(st.cards
          .filter(c => c.segmentId === 'internal' || c.segmentId === 'excluded' || c.excluded)
          .map(c => c.id));
        st.selection = (ids ?? []).filter(id => !internal.has(id));
      }));
    }

    // --- 5. 생성 --------------------------------------------------------
    // 로컬 모델은 1건에 1분 안팎이 걸린다. 한 요청에 전부 처리하면 HTTP 헤더 타임아웃
    // (undici 기본 300초)에 걸리므로, 한 번에 batch 건만 만들고 remaining 을 돌려준다.
    // 클라이언트가 remaining 이 0이 될 때까지 반복 호출하며 진행률을 보여준다.
    if (p === '/api/generate' && req.method === 'POST') {
      const { channel = 'email', batch = 1, restart = false } = await readBody(req);
      const st = load();
      const targets = st.cards.filter(c => st.selection.includes(c.id));
      const common = { channel, personaId: st.personaId, sourceProfile: st.sourceProfile };

      if (restart) {
        st.templates = {};
        for (const c of targets) delete c.message;
      }

      let done = 0;
      if (st.mode === '1:N') {
        // 고객군당 공통 문안 1건 → 수신자별 병합필드 치환
        st.templates ??= {};
        const needed = [...new Set(targets.map(c => c.segmentId))].filter(sid => !st.templates[sid]);
        for (const sid of needed.slice(0, batch)) {
          st.templates[sid] = await generateSegmentTemplate({ segmentId: sid, ...common });
          done += 1;
        }
        for (const c of targets) {
          const tpl = st.templates[c.segmentId];
          if (!tpl) continue;
          c.message = tpl.error ? { ...tpl, mode: '1:N' } : renderTemplate(tpl, c, channel);
          c.message.reviewStatus ??= 'PENDING';
          c.status = c.message.error ? 'HELD' : 'DRAFTED';
        }
        st.step = 5;
        save(st);
        const remaining = [...new Set(targets.map(c => c.segmentId))].filter(sid => !st.templates[sid]).length;
        return json(res, 200, { ...load(), steps: STEPS, segments: SEGMENTS, company: COMPANY, remaining, done });
      }

      for (const c of targets.filter(c => !c.message).slice(0, batch)) {
        c.message = await generateMessage({
          card: c, segmentId: c.segmentId, signals: c.signals ?? { facts: [] }, ...common,
        });
        c.message.reviewStatus = 'PENDING';
        c.status = c.message.error ? 'HELD' : 'DRAFTED';
        done += 1;
      }
      st.step = 5;
      save(st);
      const remaining = load().cards.filter(c => st.selection.includes(c.id) && !c.message).length;
      return json(res, 200, { ...load(), steps: STEPS, segments: SEGMENTS, company: COMPANY, remaining, done });
    }

    // --- 6. 검토·승인 (HITL) --------------------------------------------
    if (p === '/api/review' && req.method === 'POST') {
      const { id, action, subject, body } = await readBody(req);
      return json(res, 200, update(st => {
        const c = st.cards.find(x => x.id === id);
        if (!c?.message) return;
        if (subject !== undefined) c.message.subject = subject;
        if (body !== undefined) c.message.body = body;
        if (action === 'approve') { c.message.reviewStatus = 'APPROVED'; c.status = 'APPROVED'; }
        if (action === 'reject')  { c.message.reviewStatus = 'REJECTED'; c.status = 'REJECTED'; }
        st.step = 6;
      }));
    }

    // --- 7. 발송 --------------------------------------------------------
    // 기본은 dry-run(큐 적재만). 실제 Gmail 전송은 confirm:true 가 있을 때만.
    if (p === '/api/deliver' && req.method === 'POST') {
      const { confirm = false } = await readBody(req);
      const st = load();
      const approved = st.cards.filter(c => c.message?.reviewStatus === 'APPROVED');
      const results = [];

      for (const c of approved) {
        if (!confirm) {
          c.status = 'QUEUED';
          c.queuedAt = new Date().toISOString();
          results.push({ id: c.id, to: c.email, sent: false, note: 'dry-run (큐 적재만)' });
          continue;
        }
        const r = await sendEmail({
          to: c.email, subject: c.message.subject, body: c.message.body,
        });
        c.status = r.ok ? 'SENT' : 'SEND_FAILED';
        c.deliveredAt = new Date().toISOString();
        c.deliverError = r.ok ? undefined : r.error;
        results.push({ id: c.id, to: c.email, sent: r.ok, note: r.ok ? r.messageId : r.error });
      }
      st.step = 7;
      save(st);
      return json(res, 200, { ...load(), steps: STEPS, segments: SEGMENTS, company: COMPANY, results });
    }

    // --- 정적 파일 ------------------------------------------------------
    const file = p === '/' ? '/index.html' : p;
    const fp = path.join(ROOT, 'public', file);
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const type = fp.endsWith('.js') ? 'text/javascript' : fp.endsWith('.css') ? 'text/css' : 'text/html';
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
      return res.end(fs.readFileSync(fp));
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e.message ?? e) });
  }
});

server.listen(PORT, () => console.log(`\nproto-rem 대시보드 → http://localhost:${PORT}\n`));
