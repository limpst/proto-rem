/**
 * 7단계 파이프라인 프로토타입 서버.
 * HITL 게이트: 4단계(대상 선택), 6단계(메시지 승인) — 이 두 곳은 사람 없이 넘어가지 않는다.
 *   npm start  ->  http://localhost:5173
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, save, update } from './store.mjs';
import { SEGMENTS, COMPANY, classify } from './domain.mjs';
import { fetchSite, extractSignals, buildSourceProfile } from './enrich.mjs';
import { spawn } from 'node:child_process';
import { generateMessage } from './generate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 5173;

export const STEPS = [
  { n: 1, id: 'ingest',   label: '명함 수집',     hitl: false, desc: '리멤버/CSV에서 명함을 가져온다' },
  { n: 2, id: 'resolve',  label: '회사 식별',     hitl: false, desc: '회사명 정규화 + 홈페이지 URL 확정' },
  { n: 3, id: 'enrich',   label: '홈페이지 리서치', hitl: false, desc: '홈페이지를 읽어 근거 사실 추출' },
  { n: 4, id: 'segment',  label: '고객군 선택',   hitl: true,  desc: '세그먼트 자동 분류 → 사람이 발송 대상 확정' },
  { n: 5, id: 'generate', label: '카피 생성',     hitl: false, desc: '세그먼트별 프롬프트로 1:1 메시지 생성' },
  { n: 6, id: 'review',   label: '검토·승인',     hitl: true,  desc: '사람이 문안 수정 후 승인/반려' },
  { n: 7, id: 'deliver',  label: '발송·추적',     hitl: false, desc: '승인 건만 발송, 이력·응답 기록' },
];

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b ? JSON.parse(b) : {})); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (p === '/api/state') return json(res, 200, { ...load(), steps: STEPS, segments: SEGMENTS, company: COMPANY });

    if (p === '/api/reset' && req.method === 'POST') {
      fs.rmSync(path.join(ROOT, 'data', 'state.json'), { force: true });
      return json(res, 200, load());
    }

    // --- 1-a. 리멤버 반출 (이미 로그인된 Chrome에 CDP로 접속) --------------
    if (p === '/api/remember-export' && req.method === 'POST') {
      const log = await new Promise(resolve => {
        const child = spawn('npm', ['run', 'export'], {
          cwd: ROOT, shell: process.platform === 'win32', windowsHide: true,
        });
        let out = '';
        child.stdout.on('data', d => out += d);
        child.stderr.on('data', d => out += d);
        child.on('close', () => resolve(out));
        child.on('error', e => resolve(String(e.message)));
      });
      const ok = fs.existsSync(path.join(ROOT, 'data', 'cards.json'));
      return json(res, 200, { ok, log: log.slice(-2500) });
    }

    // --- 1-b. 자사(에이톰) 홈페이지 프로파일 ------------------------------
    if (p === '/api/source-profile' && req.method === 'POST') {
      const profile = await buildSourceProfile();
      return json(res, 200, update(st => { st.sourceProfile = profile; }));
    }

    // --- 1. 수집 -------------------------------------------------------
    if (p === '/api/ingest' && req.method === 'POST') {
      const s = update(st => {
        const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed-cards.json'), 'utf8'));
        const exported = path.join(ROOT, 'data', 'cards.json');
        const src = fs.existsSync(exported) ? JSON.parse(fs.readFileSync(exported, 'utf8')) : seed;
        st.cards = src.map(c => ({ ...c, status: 'NEW' }));
        st.source = fs.existsSync(exported) ? 'remember-export' : 'seed-sample';
        st.step = 1;
      });
      return json(res, 200, s);
    }

    // --- 2. 회사 식별 ---------------------------------------------------
    if (p === '/api/resolve' && req.method === 'POST') {
      const s = update(st => {
        for (const c of st.cards) {
          c.siteUrl = c.site || '';
          c.resolved = Boolean(c.siteUrl);
          c.status = 'RESOLVED';
        }
        st.step = 2;
      });
      return json(res, 200, s);
    }

    // --- 3. 리서치 ------------------------------------------------------
    if (p === '/api/enrich' && req.method === 'POST') {
      const { ids } = await readBody(req);
      const st = load();
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

    // --- 4. 세그먼트 분류 (HITL 선택은 /api/selection) -------------------
    if (p === '/api/segment' && req.method === 'POST') {
      const s = update(st => {
        for (const c of st.cards) {
          const { segmentId, score } = classify(c);
          c.segmentId = segmentId;
          c.segmentScore = score;
          c.status = 'SCORED';
        }
        st.step = 4;
      });
      return json(res, 200, s);
    }

    if (p === '/api/selection' && req.method === 'POST') {
      const { ids } = await readBody(req);
      return json(res, 200, update(st => { st.selection = ids ?? []; }));
    }

    // --- 5. 생성 --------------------------------------------------------
    if (p === '/api/generate' && req.method === 'POST') {
      const { channel = 'email' } = await readBody(req);
      const st = load();
      const targets = st.cards.filter(c => st.selection.includes(c.id));
      for (const c of targets) {
        c.message = await generateMessage({
          card: c, segmentId: c.segmentId, signals: c.signals ?? { facts: [] }, channel,
        });
        c.message.reviewStatus = 'PENDING';
        c.status = c.message.error ? 'HELD' : 'DRAFTED';
      }
      st.step = 5;
      return json(res, 200, save(st));
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

    // --- 7. 발송 (프로토타입: 실제 전송 미연결, 발송 큐에만 적재) ---------
    if (p === '/api/deliver' && req.method === 'POST') {
      return json(res, 200, update(st => {
        for (const c of st.cards) {
          if (c.message?.reviewStatus === 'APPROVED') {
            c.status = 'QUEUED';
            c.deliveredAt = new Date().toISOString();
          }
        }
        st.step = 7;
      }));
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
