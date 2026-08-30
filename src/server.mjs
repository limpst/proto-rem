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
import { load, save, update, reset } from './store.mjs';
import { SEGMENTS, COMPANY, classify } from './domain.mjs';
import { fetchSite, extractSignals, buildSourceProfile } from './enrich.mjs';
import {
  generateMessage, generateSegmentTemplate, renderTemplate,
  buildPrompt, buildSegmentPrompt, PERSONAS,
} from './generate.mjs';
import { resolveBackend } from './llm.mjs';
import { sendEmail, smtpStatus } from './deliver.mjs';
import { toCards } from './normalize.mjs';
import { resolveSite } from './resolve.mjs';
import { classifyOne } from './classify-ai.mjs';
import { upsertCards } from './upsert.mjs';
import { parseText } from './normalize.mjs';

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

/**
 * 화면 한 장이 필요로 하는 전체 상태.
 *
 * 왜 헬퍼로 묶는가: 클라이언트는 응답을 S 에 통째로 대입한다. 어느 한 엔드포인트가
 * steps/segments/personas 를 빠뜨리면 사이드바가 통째로 사라지고 render() 가
 * S.steps[0] 에서 터진다(= 새로고침 전까지 앱 사용 불가). 응답을 한 곳에서
 * 조립해 그 사고를 구조적으로 막는다.
 */
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
const readBody = req => new Promise(r => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => r(b ? JSON.parse(b) : {}));
});

const fullState = async (st, extra = {}) => ({
  ...st,
  steps: STEPS, segments: SEGMENTS, company: COMPANY, personas: PERSONAS,
  backend: await resolveBackend(), smtp: smtpStatus(),
  ...extra,
});
const sendState = async (res, st, extra) => json(res, 200, await fullState(st, extra));

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
    if (p === '/api/state') return sendState(res, load());

    if (p === '/api/reset' && req.method === 'POST') {
      return sendState(res, reset());
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
      return sendState(res, update(st => { st.sourceProfile = profile; }));
    }

    // --- 1-c. 콘솔 스니펫으로 받은 cards.json 업로드 ----------------------
    if (p === '/api/upload-cards' && req.method === 'POST') {
      const body = await readBody(req);
      // 구버전 스니펫이 name/phone 을 객체 그대로 보낼 수 있으므로 서버에서도 정규화한다.
      const incoming = toCards(body.cards ?? []);
      if (!incoming.length) return json(res, 400, { error: '이름이 있는 명함이 없습니다' });

      const st = load();
      const r = upsertCards(st.cards ?? [], incoming, { mode: body.mode ?? 'upsert' });
      st.cards = r.cards;
      st.source = 'remember-export';
      save(st);
      return json(res, 200, {
        ...load(), upsert: { inserted: r.inserted, updated: r.updated, unchanged: r.unchanged, details: r.details },
        steps: STEPS, segments: SEGMENTS, company: COMPANY,
        personas: PERSONAS, backend: await resolveBackend(), smtp: smtpStatus(),
      });
    }

    // --- 1-e. CSV 내보내기 ------------------------------------------------
    // 사내 시스템과 주고받는 표준 인터페이스. 명함·분류·문안·발송결과를 한 장에 담는다.
    if (p === '/api/export-csv') {
      const st = load();
      const cols = ['id', '이름', '직함', '회사', '부서', '이메일', '전화', '홈페이지',
        '고객군', '분류출처', '제외', '근거수', '근거', '상태',
        '채널', '모드', '제목', '본문', '검토상태', '검증통과', '발송시각'];
      const q = v => {
        const t = String(v ?? '').replace(/
?
/g, ' ');
        return /[",]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      };
      const rows = st.cards.map(c => {
        const m = c.message ?? {};
        const checks = m.checks ?? [];
        return [
          c.id, c.name, c.title, c.company, c.dept, c.email, c.phone, c.siteUrl || c.site,
          SEGMENTS.find(x => x.id === c.segmentId)?.label ?? c.segmentId ?? '',
          c.segmentSource ?? '', c.excluded ? 'Y' : '',
          c.signals?.facts?.length ?? 0, (c.signals?.facts ?? []).join(' | '),
          c.status ?? '',
          m.channel ?? '', m.mode ?? '', m.subject ?? '', m.body ?? '',
          m.reviewStatus ?? '',
          checks.length ? `${checks.filter(k => k.pass).length}/${checks.length}` : '',
          c.deliveredAt ?? c.queuedAt ?? '',
        ].map(q).join(',');
      });
      // 엑셀이 UTF-8 을 알아보게 BOM 을 붙인다. 없으면 한글이 깨진다.
      const csv = '﻿' + [cols.join(','), ...rows].join('

');
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="safelead-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
      return res.end(csv);
    }

    // --- 1. 수집 -------------------------------------------------------
    if (p === '/api/ingest' && req.method === 'POST') {
      const { mode = 'upsert' } = await readBody(req);
      const exported = path.join(ROOT, 'data', 'cards.json');
      const hasExport = fs.existsSync(exported);
      const src = JSON.parse(fs.readFileSync(
        hasExport ? exported : path.join(ROOT, 'data', 'seed-cards.json'), 'utf8'));

      const st = load();
      const r = upsertCards(st.cards ?? [], toCards(src), { mode });
      st.cards = r.cards;
      st.source = hasExport ? 'remember-export' : 'seed-sample';
      st.step = Math.max(st.step ?? 1, 1);
      save(st);
      return json(res, 200, {
        ...load(), upsert: { inserted: r.inserted, updated: r.updated, unchanged: r.unchanged, details: r.details },
        steps: STEPS, segments: SEGMENTS, company: COMPANY,
        personas: PERSONAS, backend: await resolveBackend(), smtp: smtpStatus(),
      });
    }

    // --- 2. 발신 설정 + 발송 모드 (HITL) ---------------------------------
    if (p === '/api/mode' && req.method === 'POST') {
      const { mode, personaId } = await readBody(req);
      return sendState(res, update(st => {
        if (mode) st.mode = mode === '1:N' ? '1:N' : '1:1';
        if (personaId) st.personaId = personaId;
        for (const c of st.cards) {
          if (!c.siteUrl) c.siteUrl = c.site || '';
          if (c.status === 'NEW') c.status = 'RESOLVED';
        }
        st.step = 2;
      }));
    }

    // --- 2-b. 홈페이지 자동 탐색 (이메일 도메인 기반) ----------------------
    if (p === '/api/resolve-sites' && req.method === 'POST') {
      const st = load();
      const targets = st.cards.filter(c => !c.excluded && c.segmentId !== 'internal');
      for (const c of targets) {
        if (c.siteUrl && c.siteResolve?.via === 'card') continue;
        const r = await resolveSite(c);
        c.siteUrl = r.siteUrl;
        c.siteResolve = { via: r.via, tried: r.tried };
        c.resolved = Boolean(r.siteUrl);
        if (c.status === 'NEW') c.status = 'RESOLVED';
      }
      st.step = 2;
      return sendState(res, save(st));
    }

    // --- 2-c. 홈페이지 수동 입력 ------------------------------------------
    if (p === '/api/set-site' && req.method === 'POST') {
      const { id, site } = await readBody(req);
      return sendState(res, update(st => {
        const c = st.cards.find(x => x.id === id);
        if (!c) return;
        const u = String(site ?? '').trim();
        c.siteUrl = u ? (u.startsWith('http') ? u : `https://${u}`) : '';
        c.siteResolve = { via: u ? 'manual' : 'none', tried: [] };
        c.resolved = Boolean(c.siteUrl);
      }));
    }

    // --- 3. 리서치 ------------------------------------------------------
    if (p === '/api/enrich' && req.method === 'POST') {
      const { ids } = await readBody(req);
      const st = load();
      if (!st.sourceProfile) st.sourceProfile = await buildSourceProfile();
      // 제외·자사 명함과 홈페이지가 없는 명함은 읽을 것이 없다. 헛 요청을 줄인다.
      const targets = st.cards.filter(c =>
        (!ids?.length || ids.includes(c.id))
        && !c.excluded && c.segmentId !== 'internal' && c.siteUrl);
      for (const c of targets) {
        const site = await fetchSite(c.siteUrl);
        c.siteFetch = { ok: site.ok, reason: site.reason, chars: site.text.length };
        c.signals = await extractSignals(c, site.text);
        c.status = 'ENRICHED';
      }
      st.step = 3;
      return sendState(res, save(st));
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
      const { useAi = false } = await readBody(req);

      // 1차: 키워드 규칙
      let st = update(s2 => {
        for (const c of s2.cards) {
          const { segmentId, score } = classify(c);
          c.segmentId = segmentId;
          c.segmentScore = score;
          c.segmentSource = ['internal', 'excluded'].includes(segmentId) ? 'rule'
            : segmentId === 'unclassified' ? null : 'keyword';
          c.status = 'SCORED';
        }
        s2.step = 4;
      });

      // 2차: 규칙이 놓친 건만 AI 에게 물어본다. 건당 호출이라 대상만 추린다.
      if (useAi) {
        const st2 = load();
        for (const c of st2.cards) {
          if (c.excluded || c.segmentId !== 'unclassified') continue;
          const r = await classifyOne(c);
          c.segmentId = r.segmentId;
          c.segmentSource = r.segmentId === 'unclassified' ? null : 'ai';
          c.segmentAi = { confidence: r.confidence, reason: r.reason };
        }
        st = save(st2);
      }
      return sendState(res, st);
    }

    // --- 1-d. 텍스트로 명함 직접 입력 -------------------------------------
    // 명함이 몇 건뿐일 때 브라우저를 거치는 것보다 이쪽이 훨씬 빠르다.
    if (p === '/api/paste-cards' && req.method === 'POST') {
      const { text, mode = 'upsert' } = await readBody(req);
      const { cards: incoming, mode: parsedAs } = parseText(text);
      if (!incoming.length) {
        return json(res, 400, { error: '명함을 찾지 못했습니다. 이름이 포함된 줄이 있어야 합니다.' });
      }
      const st = load();
      const r = upsertCards(st.cards ?? [], incoming, { mode });
      st.cards = r.cards;
      st.source = 'paste';
      st.step = Math.max(st.step ?? 1, 1);
      save(st);
      return json(res, 200, {
        ...load(), parsedAs, upsert: { inserted: r.inserted, updated: r.updated, unchanged: r.unchanged, details: r.details },
        steps: STEPS, segments: SEGMENTS, company: COMPANY,
        personas: PERSONAS, backend: await resolveBackend(), smtp: smtpStatus(),
      });
    }

    // --- 명함 개별 제외 (본인 프로필 등) ---------------------------------
    if (p === '/api/exclude' && req.method === 'POST') {
      const { id, excluded = true } = await readBody(req);
      return sendState(res, update(st => {
        const c = st.cards.find(x => x.id === id);
        if (!c) return;
        c.excluded = Boolean(excluded);
        c.segmentId = classify(c).segmentId;
        st.selection = st.selection.filter(x => x !== id || !c.excluded);
      }));
    }

    if (p === '/api/selection' && req.method === 'POST') {
      const { ids } = await readBody(req);
      return sendState(res, update(st => {
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
        return sendState(res, load(), { remaining, done });
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
      return sendState(res, load(), { remaining, done });
    }

    // --- 6. 검토·승인 (HITL) --------------------------------------------
    if (p === '/api/review' && req.method === 'POST') {
      const { id, action, subject, body } = await readBody(req);
      return sendState(res, update(st => {
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
      // 화면(STEP 7)이 "같은 사람에게 30일 내 재발송 차단"을 약속한다. 여기서 실제로 막는다.
      // 연습모드(DRY_RUN)는 실제로 나간 적이 없으므로 이 제한을 적용하지 않는다.
      const dry = smtpStatus().dryRun;
      const RESEND_BLOCK_MS = 30 * 24 * 60 * 60 * 1000;

      for (const c of approved) {
        const lastSent = c.status === 'SENT' && c.deliveredAt ? Date.parse(c.deliveredAt) : 0;
        if (confirm && !dry && lastSent && Date.now() - lastSent < RESEND_BLOCK_MS) {
          const days = Math.ceil((RESEND_BLOCK_MS - (Date.now() - lastSent)) / 86400000);
          results.push({ id: c.id, to: c.email, sent: false, note: `30일 재발송 차단 — ${days}일 뒤 가능` });
          continue;
        }
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
      return sendState(res, load(), { results });
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

server.listen(PORT, () => console.log(`\nSafeLead 대시보드 → http://localhost:${PORT}\n`));
