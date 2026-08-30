const $ = s => document.querySelector(s);
let S = null, busy = false;
let viewStep = 1;
let promptPreview = null;
const openPrompts = new Set();

/* 입력값은 DOM 이 아니라 여기에 둔다.
   run() 은 동작을 시작하기 전에 render(진행중) 로 #todo·#view 를 갈아엎는다.
   그래서 동작 함수가 그때 가서 $('#ch')/$('#paste') 를 읽으면 이미 없다.
   (이 때문에 [메일 만들기]는 늘 "Cannot read properties of null",
    [붙여넣은 내용으로 명함 만들기]는 늘 "붙여넣은 내용이 없습니다" 로 끝났다.)
   값을 여기에 들고 있으면 다시 그려도 살아남는다. */
let channel = 'email';
let pasteText = '';

/* ── 시스템 로그 ─────────────────────────────────────────────
   화면 하단 접힘 콘솔(#console). 어떤 호출이 언제 무엇을 돌려줬는지 남긴다.
   무엇이 왜 안 됐는지를 사용자가 스스로 볼 수 있어야 한다. */
const LOGS = [];
let logFilter = 'all';

function log(kind, tag, msg, detail) {
  LOGS.push({ t: new Date(), kind, tag, msg, detail });
  if (LOGS.length > 500) LOGS.shift();
  paintLogs();
}

const hhmmss = d => d.toTimeString().slice(0, 8);
const esc0 = t => String(t ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const LOG_FILTERS = [
  ['all', '전체'], ['net', '통신'], ['ai', 'AI'], ['ui', '조작'], ['error', '오류'],
];

function paintLogs() {
  const box = document.querySelector('#conLogs');
  if (!box) return;
  const count = document.querySelector('#conCount');
  const last = document.querySelector('#conLast');
  const tools = document.querySelector('#conTools');

  const errs = LOGS.filter(l => l.kind === 'error').length;
  if (count) count.textContent = errs ? `${LOGS.length} · 오류 ${errs}` : String(LOGS.length);
  if (last) {
    const l = LOGS[LOGS.length - 1];
    last.textContent = l ? `${hhmmss(l.t)}  ${l.msg}` : '대기 중…';
    last.style.color = l?.kind === 'error' ? 'var(--bad)' : '';
  }

  if (tools) {
    tools.innerHTML = LOG_FILTERS.map(([k, lb]) =>
      `<span class="filt ${logFilter === k ? 'on' : ''}" data-lf="${k}">${lb}</span>`).join('')
      + '<span class="filt" data-lf="clear" style="margin-left:auto">지우기</span>';
    tools.querySelectorAll('[data-lf]').forEach(b => {
      b.onclick = e => {
        e.stopPropagation();
        if (b.dataset.lf === 'clear') LOGS.length = 0; else logFilter = b.dataset.lf;
        paintLogs();
      };
    });
  }

  const rows = LOGS.filter(l => logFilter === 'all' || l.kind === logFilter);
  box.innerHTML = rows.slice(-250).reverse().map(l => `
    <div class="lg ${l.kind}">
      <span class="tm">${hhmmss(l.t)}</span>
      <span class="tg">${esc0(l.tag)}</span>
      <span class="mg">${esc0(l.msg)}${l.detail ? `<span class="mt">  ${esc0(l.detail)}</span>` : ''}</span>
    </div>`).join('') || '<div class="mg" style="padding:10px 4px;color:#5b6577">기록 없음</div>';
}

function initConsole() {
  const con = document.querySelector('#console');
  const bar = document.querySelector('#conbar');
  if (!con || !bar || bar.dataset.ready) return;
  bar.dataset.ready = '1';
  bar.onclick = () => con.classList.toggle('open');
  paintLogs();
}

/** API 경로를 사람이 읽는 이름으로 */
const API_LABEL = {
  '/api/state': '상태 조회', '/api/ingest': '명함 불러오기', '/api/reset': '초기화',
  '/api/paste-cards': '붙여넣기 파싱', '/api/upload-cards': '파일 업로드',
  '/api/remember-export': '리멤버 반출', '/api/remember-login': '리멤버 로그인 창',
  '/api/source-profile': '자사 홈페이지 분석', '/api/mode': '발신 설정',
  '/api/resolve-sites': '홈페이지 자동 찾기', '/api/set-site': '홈페이지 입력',
  '/api/enrich': '홈페이지 리서치', '/api/prompt-preview': '프롬프트 미리보기',
  '/api/segment': '고객군 분류', '/api/selection': '대상 선택', '/api/exclude': '명함 제외',
  '/api/generate': '메일 생성', '/api/review': '검토 반영', '/api/deliver': '발송',
};

const api = async (p, body) => {
  const t0 = Date.now();
  const label = API_LABEL[p] ?? p;
  let r;
  try {
    r = await fetch(p, body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'GET' });
  } catch (e) {
    log('error', '통신', `${label} — 서버에 연결하지 못했습니다`, e.message);
    return { error: `서버에 연결하지 못했습니다.
${e.message}` };
  }
  // 서버가 500 을 HTML 로 뱉는 경우가 있어 무조건 JSON 으로 믿지 않는다.
  const txt = await r.text();
  const ms = Date.now() - t0;
  try {
    const j = JSON.parse(txt);
    if (j?.error) log('error', '통신', `${label} 실패 — ${j.error}`, `${ms}ms`);
    else if (p !== '/api/state') {
      // 모델을 호출하는 단계는 별도 색으로 구분해 둔다 (오래 걸리는 이유가 보이게)
      const isAi = ['/api/generate', '/api/enrich', '/api/segment',
                    '/api/source-profile', '/api/resolve-sites'].includes(p);
      log(isAi ? 'ai' : 'net', isAi ? 'AI' : '통신', label, `${ms}ms`);
    }
    return j;
  } catch {
    log('error', '통신', `${label} — 응답 해석 실패 (HTTP ${r.status})`, txt.slice(0, 200));
    return { error: `서버 응답을 해석하지 못했습니다 (HTTP ${r.status})
${txt.slice(0, 300)}` };
  }
};

/* 응답을 화면 상태 S 에 반영한다.
   응답에 steps 같은 메타가 빠져 있어도 이전 값을 살린다. 예전에는 부분 응답이
   S 를 통째로 덮어써 사이드바가 사라지고 render() 가 S.steps[0] 에서 터졌다. */
const META = ['steps', 'segments', 'company', 'personas', 'backend', 'smtp'];
function adopt(r) {
  if (!r) return S;
  if (r.error) { alert(r.error); return S; }
  for (const k of META) if (r[k] === undefined && S?.[k] !== undefined) r[k] = S[k];
  S = r;
  return S;
}
const post = async (p, body) => adopt(await api(p, body));

const run = async (label, fn) => {
  if (busy || !fn) return;
  log('ui', '조작', label);
  busy = true;
  try {
    render(label);
    adopt(await fn());
  } catch (e) {
    alert(e?.message ?? String(e));
  } finally {
    // busy 해제를 finally 에 둔다. 렌더가 터져도 버튼이 영구히 잠기지 않는다.
    busy = false;
    render();
  }
};

/* 리멤버 자동화(전용 크롬 창·CDP 접속)는 이 서버가 사용자의 PC 에서 돌 때만 뜻이 있다.
   배포본(onrender.com)에서 누르면 서버 쪽에서 크롬을 띄우려다 실패할 뿐이다. */
const isLocal = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

/* 클립보드는 권한·컨텍스트에 따라 막힌다. 실패하면 조용히 죽지 않고 대안을 준다. */
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch { /* 아래로 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

const seg = id => (S.segments ?? []).find(s => s.id === id);
const esc = t => String(t ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const VIA = {
  card: '명함에 적힌 주소',
  'email-domain': '이메일 도메인에서 확인',
  'llm-guess': 'AI 추정 후 접속 확인',
  manual: '직접 입력',
  none: '찾지 못함 — 직접 입력해 주세요',
};

/* 데이터 출처 아이콘 — 어디서 온 값인지 한눈에 구분한다.
   추정값을 원본처럼 믿고 쓰면 엉뚱한 메일이 나가므로, 화면에서 반드시 갈라 보인다. */
const SRC = {
  raw:  { i: '⬇', t: '가져온 데이터 — 리멤버 원본 그대로', c: 'var(--tx2)' },
  ai:   { i: '✧', t: 'AI 추정 — 사람이 확인 후 쓰세요', c: 'var(--accent)' },
  calc: { i: '∑', t: '계산값 — 다른 값에서 자동 산출', c: 'var(--ok)' },
  man:  { i: '✎', t: '직접 입력', c: 'var(--warn)' },
};
const srcTag = (k, extra = '') => {
  const s2 = SRC[k]; if (!s2) return '';
  return `<span title="${esc(s2.t)}${extra ? ' · ' + esc(extra) : ''}"
    style="color:${s2.c};font-size:11px;margin-left:4px;cursor:help">${s2.i}</span>`;
};

/* ── 현재 상황 계산 ──────────────────────────────────────────
   진행도를 "몇 번 메뉴를 눌렀나"가 아니라 "데이터가 실제로 어디까지 왔나"로 센다.
   이래야 새로고침하거나 순서를 건너뛰어도 화면이 거짓말을 하지 않는다. */
function stats() {
  const cards = S.cards ?? [];
  const usable = cards.filter(c => !c.excluded && c.segmentId !== 'internal');
  const sel = cards.filter(c => (S.selection ?? []).includes(c.id));
  const msgs = cards.filter(c => c.message);
  return {
    cards, usable, sel,
    total: cards.length,
    dropped: cards.length - usable.length,
    site: usable.filter(c => c.siteUrl).length,
    facts: usable.filter(c => c.signals?.facts?.length).length,
    classified: usable.filter(c => c.segmentId && c.segmentId !== 'unclassified').length,
    selected: sel.length,
    drafted: msgs.filter(c => !c.message.error).length,
    held: msgs.filter(c => c.message.error).length,
    approved: cards.filter(c => c.message?.reviewStatus === 'APPROVED').length,
    sent: cards.filter(c => ['SENT', 'QUEUED'].includes(c.status)).length,
  };
}

/** 각 단계가 끝났는지 — 데이터로 판정한다. */
function stepDone(n, x) {
  return [
    false,
    x.total > 0,                       // 1 수집
    Boolean(S.personaId && S.mode),    // 2 발신·모드
    x.facts > 0,                       // 3 리서치
    x.selected > 0,                    // 4 대상 확정
    x.drafted > 0,                     // 5 생성
    x.approved > 0,                    // 6 승인
    x.sent > 0,                        // 7 발송
  ][n];
}

/** 지금 해야 할 일 하나 — 각 단계 맨 위에 크게 띄운다. */
function todoFor(n, x) {
  const persona = (S.personas ?? []).find(p => p.id === S.personaId)?.label ?? '-';
  const T = {
    1: x.total === 0
      ? { t: '지금 할 일', m: '리멤버에서 명함을 가져오세요', s: '아래 방법 ② 콘솔 스니펫이 가장 빠릅니다. 크롬을 껐다 켜지 않아도 됩니다.' }
      : { t: '완료', m: `명함 ${x.total}건이 준비됐습니다`, s: `이 중 ${x.dropped}건은 자사·본인 프로필이라 발송 대상에서 빠집니다. 실제 대상은 ${x.usable.length}건입니다.`, done: true },
    2: { t: S.personaId && S.mode ? '확인' : '지금 할 일', m: '누구 이름으로, 어떻게 보낼지 정하세요',
         s: `현재 ${persona} 명의 · ${S.mode} 방식입니다. 홈페이지가 없는 회사는 아래에서 자동으로 찾거나 직접 입력하세요. (확보 ${x.site}/${x.usable.length}건)`,
         done: Boolean(S.personaId && S.mode) },
    3: x.site === 0
      ? { t: '막힘', m: '홈페이지 주소가 하나도 없습니다', s: 'STEP 2 로 돌아가 [홈페이지 자동 찾기] 를 누르거나 주소를 직접 입력하세요. 홈페이지가 없으면 메일을 만들 수 없습니다.', blocked: true }
      : x.facts === 0
        ? { t: '지금 할 일', m: '회사 홈페이지를 읽어 근거를 뽑으세요', s: `${x.site}개 회사의 홈페이지 주소가 확보됐습니다. 각 회사에서 메일에 인용할 사실을 찾아냅니다.` }
        : { t: '완료', m: `${x.facts}개 회사에서 근거를 찾았습니다`, s: '근거가 없는 회사는 다음 단계에서 메일 생성이 자동으로 막힙니다.', done: true },
    4: x.classified === 0
      ? { t: '지금 할 일', m: '고객군을 나누세요', s: '회사 이름을 보고 7가지 고객군으로 자동 분류합니다.' }
      : x.selected === 0
        ? { t: '지금 할 일', m: '보낼 사람을 직접 고르세요', s: '분류는 자동이지만 선택은 사람이 합니다. 지금 연락해도 되는 관계인지는 담당자만 압니다.' }
        : { t: '완료', m: `${x.selected}명을 발송 대상으로 정했습니다`, s: 'STEP 5 에서 이분들에게 보낼 메일을 만듭니다.', done: true },
    5: x.selected === 0
      ? { t: '막힘', m: '발송 대상이 없습니다', s: 'STEP 4 에서 보낼 사람을 먼저 선택하세요.', blocked: true }
      : x.drafted === 0
        ? { t: '지금 할 일', m: `${x.selected}명에게 보낼 메일을 만드세요`, s: `${S.mode === '1:N' ? '고객군마다 한 통씩 만들고 이름·회사만 바꿔 넣습니다.' : '한 사람당 한 통씩, 그 회사 홈페이지 내용을 인용해서 만듭니다.'} 한 통에 1~2분 걸립니다.` }
        : { t: '완료', m: `초안 ${x.drafted}건이 만들어졌습니다`, s: x.held ? `${x.held}건은 홈페이지 근거가 없어 만들지 않았습니다.` : 'STEP 6 에서 읽어보고 승인하세요.', done: true },
    6: x.drafted === 0
      ? { t: '막힘', m: '검토할 메일이 없습니다', s: 'STEP 5 에서 먼저 만드세요.', blocked: true }
      : x.approved === 0
        ? { t: '지금 할 일', m: '메일을 읽어보고 승인하세요', s: '제목과 본문을 직접 고칠 수 있습니다. 승인한 것만 발송 단계로 넘어갑니다.' }
        : { t: '완료', m: `${x.approved}건을 승인했습니다`, s: 'STEP 7 에서 발송합니다.', done: true },
    7: x.approved === 0
      ? { t: '막힘', m: '승인된 메일이 없습니다', s: 'STEP 6 에서 먼저 승인하세요.', blocked: true }
      : !S.smtp?.configured
        ? { t: '막힘', m: '발송 계정이 설정되지 않았습니다', s: '.env 파일에 GMAIL_USER 와 GMAIL_APP_PASSWORD 를 넣고 프로그램을 다시 시작하세요.', blocked: true }
        : x.sent === 0
          ? { t: '지금 할 일', m: `승인된 ${x.approved}건을 발송하세요`, s: S.smtp.dryRun ? 'DRY_RUN=1 이라 실제로는 나가지 않습니다. 연습해 보세요.' : '실제로 메일이 나갑니다. 확인 창이 한 번 더 뜹니다.' }
          : { t: '완료', m: `${x.sent}건 처리됐습니다`, s: '아래 표에서 결과를 확인하세요.', done: true },
  };
  return T[n];
}

const SHORT = {
  ingest: '리멤버 · 스니펫 · 파일',
  resolve: '명의 · 1:1/1:N · 홈페이지',
  enrich: '홈페이지 읽고 근거 추출',
  segment: '분류 후 사람이 확정',
  generate: '지시문으로 문안 생성',
  review: '고치고 승인/반려',
  deliver: '승인 건만 전송',
};

/* ── 렌더 ──────────────────────────────────────────────────
   draw() 가 어떤 이유로든 터져도 화면이 통째로 멎지 않도록 감싼다. */
function render(loading) {
  try {
    draw(loading);
  } catch (e) {
    console.error(e);
    $('#view').innerHTML = `<div class="panel"><div class="cap">화면을 그리지 못했습니다</div>
      <pre>${esc(e?.stack ?? e)}</pre>
      <div class="row"><button id="reload">새로고침</button></div></div>`;
    const rb = $('#reload');
    if (rb) { rb.dataset.tip = '페이지를 다시 불러와 서버 상태부터 새로 받습니다'; rb.onclick = () => location.reload(); }
  }
}

function draw(loading) {
  if (!S) return;
  if (S.error && !S.steps) {
    $('#view').innerHTML = `<div class="panel"><div class="cap">서버 오류</div><pre>${esc(S.error)}</pre></div>`;
    return;
  }
  const steps = S.steps ?? [];
  if (!steps.length) {
    $('#view').innerHTML = `<div class="panel"><div class="cap">단계 정보를 받지 못했습니다</div>
      <div class="muted">서버 응답이 불완전합니다. 새로고침하면 복구됩니다.</div>
      <div class="row" style="margin-top:10px"><button id="reload">새로고침</button></div></div>`;
    const rb = $('#reload');
    if (rb) { rb.dataset.tip = '페이지를 다시 불러와 서버 상태부터 새로 받습니다'; rb.onclick = () => location.reload(); }
    return;
  }
  const x = stats();

  $('#rail').innerHTML = steps.map(s => {
    const done = stepDone(s.n, x);
    const isNext = !done && steps.filter(y => y.n < s.n).every(y => stepDone(y.n, x));
    return `
    <div class="step ${viewStep === s.n ? 'active' : ''} ${done ? 'done' : ''} ${isNext ? 'ready' : ''}" data-n="${s.n}">
      <div class="num">${done ? '✓' : s.n}</div>
      <div>
        <div class="lb">${esc(s.label)}
          ${s.hitl ? '<span class="hitl">HUMAN</span>' : ''}
          ${isNext ? '<span class="dot"></span>' : ''}</div>
        <div class="sb">${esc(SHORT[s.id] ?? '')}</div>
      </div>
    </div>`;
  }).join('');
  document.querySelectorAll('.step').forEach(el => {
    el.onclick = () => { viewStep = Number(el.dataset.n); render(); };
  });

  const b = S.backend ?? {};
  $('#stat').innerHTML = `
    <dt>AI</dt><dd title="${esc(b.model)}">${esc(b.name)}</dd>
    <dt>메일</dt><dd style="color:${S.smtp?.configured ? (S.smtp.dryRun ? 'var(--warn)' : 'var(--ok)') : 'var(--tx3)'}">
      ${S.smtp?.configured ? (S.smtp.dryRun ? '연습모드' : '발송가능') : '미설정'}</dd>
    <dt>저장</dt><dd>SQLite</dd>`;

  $('#flow').innerHTML = [
    ['명함', x.total], ['대상', x.usable.length], ['홈페이지', x.site], ['근거', x.facts],
    ['선택', x.selected], ['초안', x.drafted], ['승인', x.approved], ['발송', x.sent],
  ].map(([k, v]) =>
    `<div class="cell ${v ? 'good' : 'zero'}"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');

  const step = steps.find(s => s.n === viewStep) ?? steps[0];
  $('#head').innerHTML = `
    <div class="eyebrow">STEP ${step.n}${step.hitl ? ' · 사람이 결정하는 단계' : ''}</div>
    <h2>${esc(step.label)}</h2>
    <div class="desc">${esc(step.desc)}</div>`;

  const t = todoFor(step.n, x) ?? { t: '', m: step.label, s: '' };
  $('#todo').innerHTML = loading
    ? `<div class="todo"><div class="t">진행 중</div><div class="spin" style="margin-top:8px">${esc(loading)}</div></div>`
    : `<div class="todo ${t.blocked ? 'blocked' : ''} ${t.done ? 'done' : ''}">
        <div class="t">${esc(t.t)}</div><div class="m">${esc(t.m)}</div><div class="s">${esc(t.s)}</div>
        ${PRIMARY[step.id] ? PRIMARY[step.id](x) : ''}</div>`;

  $('#view').innerHTML = VIEWS[step.id]
    ? VIEWS[step.id](x)
    : `<div class="panel muted">알 수 없는 단계입니다: ${esc(step.id)}</div>`;
  bind();
}

/* ── 버튼 툴팁 문구 ──────────────────────────────
   버튼 이름만으로는 "누르면 무슨 일이 벌어지는지"를 알 수 없다.
   특히 되돌릴 수 없는 동작(초기화·실제 발송)과 오래 걸리는 동작(리서치·생성)이
   같은 줄에 섞여 있어, 누르기 전에 결과·소요·부작용을 밝힌다. */
const T = {
  ingest: '서버의 data/cards.json(리멤버 반출·스니펫·붙여넣기 결과)을 읽어 명함 목록을 새로 채웁니다. 파일이 없으면 샘플 시드를 씁니다. 기존 목록은 대체됩니다.',
  copysnippet: '리멤버 페이지 콘솔(F12)에 붙여넣을 수집 스크립트를 클립보드에 복사합니다. 서버로 나가는 것은 없습니다.',
  reset: '명함·초안·승인·발송 이력을 모두 지웁니다. 되돌릴 수 없습니다. 확인 창이 한 번 더 뜹니다.',
  rlogin: '이 프로그램 전용 크롬 창을 엽니다. 그 창에서 직접 로그인하면 로그인 상태만 저장됩니다(비밀번호는 다루지 않습니다). 서버가 내 PC 에서 돌 때만 동작합니다.',
  rexport: '저장된 로그인으로 리멤버 명함첩을 훑어 data/cards.json 으로 반출합니다. 건수에 따라 수 분 걸립니다.',
  rexportcdp: '--remote-debugging-port=9222 로 켜 둔 크롬에 붙어 명함을 반출합니다. 크롬을 완전히 종료한 뒤 재실행해야 합니다.',
  paste: '위 상자의 텍스트를 표/덩어리로 해석해 명함을 만듭니다. 기존 명함 목록은 대체됩니다.',
  source: '에이톰엔지니어링 홈페이지를 다시 읽어 서비스·레퍼런스 목록을 갱신합니다. 메일에 인용할 자사 실적의 출처입니다.',
  resolvesites: '명함의 URL → 이메일 도메인 → 회사명 AI 추정 순으로 찾습니다. 실제로 접속되는 주소만 채택합니다. 회사 수만큼 접속하므로 시간이 걸립니다.',
  enrich: '확보된 홈페이지를 실제로 열어 메일에 인용할 사실(근거)을 뽑습니다. 회사당 수 초 걸리고, 근거가 없으면 다음 단계에서 메일 생성이 막힙니다.',
  prompt: '메일을 만들지 않습니다. AI 에게 실제로 보낼 지시문 원문만 보여줍니다.',
  segment: '회사명 키워드 규칙으로 7개 고객군에 배정합니다. AI 호출이 없어 즉시 끝나고, 애매한 건은 미분류로 남습니다.',
  segmentai: '규칙이 미분류로 남긴 명함만 AI 에게 물어봅니다. 건당 호출이라 시간이 걸리고, 결과는 추정이라 사람 확인이 필요합니다.',
  channel: '만들 문안의 형식입니다. 문자(LMS)·리멤버 메시지는 제목 없이 본문만 만듭니다.',
  generate: '선택한 대상에게 보낼 문안을 만듭니다. 1건씩 순차로 진행하며 한 통에 1~2분 걸릴 수 있습니다. 기존 초안은 다시 만들어집니다.',
  deliver: '실제로 보내지 않습니다. 승인된 건의 상태만 QUEUED 로 바꿔 발송 직전 점검에 씁니다.',
  send: '승인된 건을 Gmail SMTP 로 실제 전송합니다. 되돌릴 수 없습니다. 확인 창이 한 번 더 뜹니다.',
  approve: '고친 제목·본문을 저장하고 발송 대상으로 확정합니다. 승인한 건만 STEP 7 로 넘어갑니다.',
  reject: '이 건을 발송에서 제외합니다. 초안은 남습니다.',
  saveEdit: '승인 상태는 그대로 두고 고친 제목·본문만 저장합니다.',
  promptOne: '이 메일을 만들 때 AI 에게 보낸 지시문 원문을 펼쳐 봅니다.',
  pickNone: '선택을 모두 해제합니다. 명함이 지워지지는 않습니다.',
  siteIn: '홈페이지 주소를 직접 넣습니다. 입력 칸을 벗어나면 바로 저장됩니다.',
  pickOne: '이 명함을 발송 대상에 넣거나 뺍니다. 자사·제외 명함은 서버에서도 걸러집니다.',
  drop: '리멤버에서 받은 cards.json 파일을 올립니다. 기존 명함 목록은 대체됩니다.',
  remote: '이 기능은 프로그램을 내 PC 에서 직접 실행할 때만 동작합니다. 지금은 배포 서버에 접속 중이라, 눌러도 서버 쪽에서 크롬을 열려다 실패합니다. 아래 [붙여넣기]나 cards.json 업로드를 쓰세요.',
};

/* 각 단계의 주 버튼 — "지금 할 일" 상자 안에 둔다 */
const PRIMARY = {
  ingest: () => `<div class="row">
      <button data-act="ingest" title="${T.ingest}">명함 불러오기</button>
      <button class="ghost" data-act="copysnippet" title="${T.copysnippet}">스니펫 복사</button></div>`,
  resolve: () => `<div class="row">
      <button data-act="resolvesites" title="${T.resolvesites}">홈페이지 자동 찾기</button></div>`,
  enrich: x => `<div class="row">
      <button data-act="enrich" ${x.site ? '' : 'disabled'}
        title="${x.site ? T.enrich : '홈페이지 주소가 하나도 없어 실행할 수 없습니다. STEP 2 에서 먼저 확보하세요.'}">전체 리서치 실행</button>
      <button class="ghost" data-act="prompt" title="${T.prompt}">AI 에게 보낼 지시문 미리보기</button></div>`,
  segment: x => `<div class="row">
      <button data-act="segment" title="${T.segment}">고객군 분류 (규칙)</button>
      <button data-act="segmentai" title="${T.segmentai}">AI 로 마저 분류</button>
      ${x.classified ? '<span class="muted" style="font-size:12px">아래 표에서 체크박스로 대상을 고르세요</span>' : ''}</div>`,
  generate: x => `<div class="row">
      <select id="ch" title="${T.channel}"
        style="background:var(--sunk);color:var(--tx);border:1px solid var(--line);border-radius:7px;padding:8px 10px">
        ${[['email', '이메일'], ['sms', '문자(LMS)'], ['remember', '리멤버 메시지']]
          .map(([v, l]) => `<option value="${v}" ${channel === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <button data-act="generate" ${x.selected ? '' : 'disabled'}
        title="${x.selected ? T.generate : '발송 대상이 없습니다. STEP 4 에서 먼저 고르세요.'}">메일 만들기 (${x.selected}건)</button></div>`,
  review: () => '',
  deliver: x => `<div class="row">
      <button class="ghost" data-act="deliver" ${x.approved ? '' : 'disabled'}
        title="${x.approved ? T.deliver : '승인된 메일이 없습니다. STEP 6 에서 먼저 승인하세요.'}">발송 큐에 넣기 (전송 안 함)</button>
      <button class="bad" data-act="send" ${x.approved && S.smtp?.configured ? '' : 'disabled'}
        title="${!x.approved ? '승인된 메일이 없습니다. STEP 6 에서 먼저 승인하세요.'
          : !S.smtp?.configured ? '발송 계정(.env 의 GMAIL_USER · GMAIL_APP_PASSWORD)이 설정되지 않았습니다.'
          : T.send}">실제 발송</button></div>`,
};

/* ── 명함 표 ─────────────────────────────────────────────── */
const LEGEND = `<div class="muted" style="font-size:11px;margin-bottom:8px;display:flex;gap:14px;flex-wrap:wrap">
  ${Object.values(SRC).map(v => `<span><b style="color:${v.c}">${v.i}</b> ${esc(v.t.split(' — ')[0])}</span>`).join('')}
</div>`;

const cardRows = (cards, { pick = true } = {}) => !cards.length
  ? '<div class="muted" style="padding:8px 0">명함이 없습니다. STEP 1 에서 가져오세요.</div>'
  : LEGEND + `<table><thead><tr>
      ${pick ? '<th style="width:26px"></th>' : ''}
      <th>담당자</th><th style="width:33%">회사 · 홈페이지</th><th>고객군</th><th>리서치 근거</th>
    </tr></thead><tbody>
    ${cards.map(c => {
      const off = c.excluded || c.segmentId === 'internal';
      return `<tr class="${off ? 'off' : ''}">
      ${pick ? `<td>${off ? '' : `<input type="checkbox" class="pick" value="${c.id}" title="${T.pickOne}" ${(S.selection ?? []).includes(c.id) ? 'checked' : ''}>`}</td>` : ''}
      <td><b>${esc(c.name)}</b>${srcTag('raw')}
        <div class="muted" style="font-size:11.5px">${esc(c.title)}</div>
        <div class="muted" style="font-size:11px">${esc(c.email)}</div></td>
      <td>${esc(c.company)}
        <div style="margin-top:4px"><input class="site-in" data-site="${c.id}" title="${T.siteIn}"
          value="${esc(c.siteUrl || c.site)}" placeholder="홈페이지 주소 (직접 입력 가능)"></div>
        ${c.siteResolve ? `<div class="muted" style="font-size:10.5px;margin-top:3px">
          ${srcTag({ card: 'raw', 'email-domain': 'calc', 'llm-guess': 'ai', manual: 'man' }[c.siteResolve.via] ?? '')}
          ${esc(VIA[c.siteResolve.via] ?? c.siteResolve.via)}</div>` : ''}</td>
      <td>${c.excluded ? '<span class="tag bad">제외됨</span>'
        : c.segmentId === 'internal' ? '<span class="tag warn">자사</span>'
        : c.segmentId && c.segmentId !== 'unclassified'
          ? `<span class="tag seg">${esc(seg(c.segmentId)?.label ?? c.segmentId)}</span>`
            + srcTag(c.segmentSource === 'ai' ? 'ai' : 'calc',
                     c.segmentSource === 'ai' ? `확신도 ${c.segmentAi?.confidence ?? '-'}` : '회사명 키워드로 판정')
          : '<span class="tag">미분류</span>'}
        ${c.segmentSource === 'ai' && c.segmentAi?.reason
          ? `<div class="muted" style="font-size:10.5px;margin-top:3px">${esc(c.segmentAi.reason)}</div>` : ''}
        <div style="margin-top:5px"><button class="ghost xs" data-ex="${c.id}" data-exv="${c.excluded ? '0' : '1'}"
          title="${c.excluded ? '이 명함을 다시 발송 대상 후보로 되돌립니다.' : '명함이 아닌 항목(본인 프로필 등)을 발송 대상에서 뺍니다. 데이터는 남습니다.'}">${c.excluded ? '되돌리기' : '제외'}</button></div></td>
      <td>${c.signals?.facts?.length
        ? `${srcTag('ai', '홈페이지에서 AI가 추출')}<ul class="facts">${c.signals.facts.map(f => `<li>${esc(f)}</li>`).join('')}</ul>`
        : `<span class="muted" style="font-size:11.5px">${c.siteFetch ? `읽기 실패 (${esc(c.siteFetch.reason)})` : '아직 안 읽음'}</span>`}</td>
    </tr>`; }).join('')}
    </tbody></table>`;

/* ── 단계별 본문 ─────────────────────────────────────────── */
const VIEWS = {
  ingest: () => `
    <details class="panel">
      <summary><b>명함 불러오기 전제 조건</b> — 이게 안 맞으면 0건으로 나옵니다</summary>
      <div class="body">
        <table><thead><tr><th style="width:34%">조건</th><th>왜 필요한가 · 확인하는 법</th></tr></thead><tbody>
          <tr><td><b>① 리멤버에 로그인되어 있을 것</b></td>
            <td>이 프로그램은 <b>비밀번호를 다루지 않습니다.</b> 이미 로그인된 브라우저의 화면을 빌려 쓰는 방식입니다.<br>
              확인: 크롬에서 <code>card.rememberapp.co.kr</code> 접속 시 명함 목록이 바로 보이면 OK.
              로그인 화면으로 넘어가면 먼저 로그인하세요.</td></tr>
          <tr><td><b>② 명함첩에 명함이 있을 것</b></td>
            <td>리멤버 화면 상단의 <b>전체 명함 (N)</b> 숫자와 이 프로그램의 숫자가 같아야 정상입니다.<br>
              다르면 스크롤이 덜 됐거나, 본인 프로필이 섞인 것입니다.</td></tr>
          <tr><td><b>③ 목록을 끝까지 스크롤할 것</b></td>
            <td>리멤버는 화면을 내릴 때마다 명함을 조금씩 불러옵니다(무한 스크롤).
              <b>화면에 보인 만큼만</b> 수집됩니다. 맨 아래까지 내려야 전부 들어옵니다.</td></tr>
          <tr><td><b>④ 이 프로그램이 켜져 있을 것</b></td>
            <td>스니펫이 수집한 명함을 이 서버로 보냅니다. 터미널의 <code>npm start</code> 창을 닫지 마세요.</td></tr>
          <tr><td><b>⑤ 같은 컴퓨터에서 할 것</b></td>
            <td>스니펫은 <code>localhost</code> 로 보냅니다. 다른 PC의 크롬에서는 전달되지 않습니다.
              그 경우 <b>[JSON 파일로 저장]</b> 후 파일을 옮겨 올리세요.</td></tr>
        </tbody></table>

        <div class="cap" style="margin-top:16px">방법별 추가 조건</div>
        <table><thead><tr><th style="width:34%">방법</th><th>추가로 필요한 것</th></tr></thead><tbody>
          <tr><td>① 전용 브라우저 로그인</td>
            <td>그 창에서 <b>네이버 또는 카카오</b>로 로그인. 구글은 자동화 창을 차단합니다
              (<code>accounts.google.com/v3/signin/rejected</code>).</td></tr>
          <tr><td>② 콘솔 스니펫</td>
            <td>크롬 개발자도구(F12) 사용. 붙여넣기가 막히면 콘솔에 <code>allow pasting</code> 입력 후 재시도.</td></tr>
          <tr><td>③ CDP 접속</td>
            <td>크롬을 <b>완전히 종료</b>한 뒤 <code>--remote-debugging-port=9222</code> 로 재실행.
              창이 하나라도 살아 있으면 새 인스턴스가 뜨지 않아 실패합니다.</td></tr>
        </tbody></table>
      </div>
    </details>

    <details class="panel">
      <summary><b>보안 — 이 프로그램이 무엇을 하고, 무엇을 하지 않는가</b></summary>
      <div class="body">
        <div class="cap">하지 않는 것</div>
        <table><tbody>
          <tr><td style="width:34%"><b>비밀번호를 받지 않습니다</b></td>
            <td>리멤버·구글·네이버 비밀번호를 입력받는 화면이 아예 없습니다.
              로그인은 사용자가 브라우저에서 직접 하고, 이 프로그램은 그 결과만 빌려 씁니다.</td></tr>
          <tr><td><b>비밀번호를 저장하지 않습니다</b></td>
            <td>저장하는 자격증명은 <code>.env</code> 의 Gmail <b>앱 비밀번호</b> 하나뿐이고,
              이 파일은 <code>.gitignore</code> 로 저장소에서 제외됩니다.</td></tr>
          <tr><td><b>남의 명함을 가져오지 않습니다</b></td>
            <td>수집 범위는 <b>본인 계정이 이미 화면에서 볼 수 있는 명함</b>뿐입니다.
              권한을 넘어서는 조회는 하지 않습니다.</td></tr>
        </tbody></table>

        <div class="cap" style="margin-top:16px">데이터가 어디로 가는가</div>
        <table><thead><tr><th style="width:34%">단계</th><th>경로</th></tr></thead><tbody>
          <tr><td>수집</td><td>리멤버 페이지 안에서만 동작 → <code>localhost</code> 의 이 서버로 전송. 외부 서버 경유 없음</td></tr>
          <tr><td>저장</td><td><code>data/proto-rem.db</code> (이 컴퓨터). 저장소에 커밋되지 않음</td></tr>
          <tr><td>홈페이지 리서치</td><td>대상 회사의 <b>공개 홈페이지</b>만 읽음</td></tr>
          <tr><td>메일 작성</td><td>현재 AI 백엔드: <b>${esc(S.backend?.name)}</b>.
            이름·회사·직함이 AI 에 전달됩니다.
            ${S.backend?.name === 'ollama'
              ? '<b>로컬 모델이라 이 컴퓨터를 벗어나지 않습니다.</b>'
              : '외부로 나가는 것이 부담되면 <code>.env</code> 에 <code>LLM_BACKEND=ollama</code> 를 넣으세요(느려집니다).'}</td></tr>
          <tr><td>발송</td><td>Gmail SMTP. 승인한 건만, 확인 창을 거쳐서만 나갑니다</td></tr>
        </tbody></table>

        <div class="cap" style="margin-top:16px">알아두실 위험</div>
        <ul class="muted" style="font-size:12.5px;line-height:1.9;margin:0;padding-left:18px">
          <li><b>명함은 개인정보입니다.</b> <code>data/</code> 폴더를 메신저·메일로 공유하지 마세요.</li>
          <li><b>이 서버에는 로그인이 없습니다.</b> 같은 네트워크의 다른 사람이 접근할 수 있으므로
            사내망·공용 와이파이에서 포트를 열어두지 마세요. 인터넷 배포 시에는 접근 통제를 먼저 붙여야 합니다.</li>
          <li><b>스니펫은 페이지의 네트워크 응답을 가로챕니다.</b> 붙여넣기 전에
            <a href="/collect-snippet.js" target="_blank" style="color:var(--accent)">원문</a>을 확인하실 수 있습니다.
            출처가 불분명한 콘솔 스니펫은 어떤 사이트에서도 붙여넣지 마세요.</li>
          <li><b>광고성 메일은 사전 수신동의가 원칙입니다</b>(정보통신망법 제50조).
            (광고) 표기·수신거부·야간 차단은 프로그램이 처리하지만 <b>동의 확보는 사람이 해야 합니다.</b></li>
          <li><b>2단계 인증 백업 코드를 앱 비밀번호 자리에 넣지 마세요.</b> 형식이 다르고 작동하지 않습니다.</li>
        </ul>
      </div>
    </details>

    <details class="panel" ${S.cards?.length ? '' : 'open'}>
      <summary>리멤버에서 가져오는 방법 3가지 — 처음이라면 펼쳐 보세요</summary>
      <div class="body">
        ${isLocal() ? '' : `<div class="banner info">
          지금은 <b>배포 서버</b>에 접속 중입니다. 아래 <b>방법 ①·③</b>(전용 크롬 창 · CDP)은
          프로그램을 내 PC 에서 직접 실행할 때만 동작하므로 잠겨 있습니다.
          <b>방법 ② 콘솔 스니펫</b>과 <b>붙여넣기</b>는 그대로 쓸 수 있습니다.</div>`}
        <div class="cap">방법 ② 콘솔 스니펫 <span class="tag ok">가장 쉬움</span></div>
        <ol class="muted" style="font-size:12.5px;margin:0 0 10px;padding-left:18px;line-height:1.95">
          <li>쓰시던 크롬에서 <code>card.rememberapp.co.kr</code> 접속 (로그인 상태 그대로)</li>
          <li><b>F12</b> → 위쪽 <b>Console</b> 탭</li>
          <li>위 <b>[스니펫 복사]</b> 를 누른 뒤 콘솔에 붙여넣고 Enter<br>
            <span style="font-size:11.5px">붙여넣기가 막히면 콘솔에 <code>allow pasting</code> 을 치고 Enter 후 다시</span></li>
          <li>오른쪽 아래 상자가 뜨면 <b>명함 목록을 끝까지 스크롤</b></li>
          <li><b>[대시보드로 바로 보내기]</b> → 이 화면에서 <b>[명함 불러오기]</b></li>
        </ol>
        <div class="drop" id="drop" title="${T.drop}">파일로 받으셨다면 cards.json 을 여기에 끌어다 놓으세요
          <input type="file" id="file" accept=".json" hidden></div>

        <div class="cap" style="margin-top:18px">방법 ① 전용 브라우저 로그인 <span class="tag">반복 수집에 유리</span></div>
        <div class="muted" style="font-size:12.5px;margin-bottom:9px">
          이 프로그램 전용 크롬 창이 열립니다. 거기서 한 번만 로그인해 두면 다음부터는 버튼 하나로 끝납니다.
          평소 크롬은 건드리지 않습니다.<br>
          <span style="color:var(--warn)">구글 로그인은 자동화 창에서 차단됩니다. 네이버·카카오를 쓰세요.</span></div>
        <div class="row">
          <button class="ghost sm" data-act="rlogin" ${isLocal() ? '' : 'disabled'}
            title="${isLocal() ? T.rlogin : T.remote}">브라우저 열어 로그인</button>
          <button class="ghost sm" data-act="rexport" ${isLocal() ? '' : 'disabled'}
            title="${isLocal() ? T.rexport : T.remote}">전부 가져오기</button>
        </div>

        <div class="cap" style="margin-top:18px">방법 ③ CDP 접속 <span class="tag">크롬 재시작 필요</span></div>
        <pre style="margin-top:0">Get-Process chrome | Stop-Process -Force
&amp; "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222</pre>
        <div class="row" style="margin-top:9px"><button class="ghost sm" data-act="rexportcdp" ${isLocal() ? '' : 'disabled'}
          title="${isLocal() ? T.rexportcdp : T.remote}">CDP 로 가져오기</button></div>
      </div>
    </details>

    <details class="panel" open>
      <summary><b>가장 빠른 방법 — 명함 정보를 그냥 붙여넣기</b> (몇 건이면 이게 제일 빠릅니다)</summary>
      <div class="body">
        <div class="muted" style="font-size:12.5px;margin-bottom:9px">
          엑셀에서 복사한 표, 쉼표로 구분한 줄, 명함 정보를 그대로 긁은 덩어리 모두 됩니다.
          이메일·전화·홈페이지는 위치가 달라도 알아서 찾아냅니다.</div>
        <textarea id="paste" placeholder="예) 엑셀에서 복사
이름	직함	회사	이메일	전화
호은성	전무이사	에이톰엔지니어링	atom@atom-eng.co.kr	010-8247-2177

예) 덩어리로 붙여넣기
호은성
전무이사
에이톰엔지니어링
atom@atom-eng.co.kr
010-8247-2177"
          style="width:100%;min-height:150px;background:var(--sunk);border:1px solid var(--line);
          color:var(--tx);border-radius:8px;padding:11px;font-size:12.5px;line-height:1.7;
          font-family:ui-monospace,Consolas,monospace">${esc(pasteText)}</textarea>
        <div class="row" style="margin-top:9px"><button data-act="paste" title="${T.paste}">붙여넣은 내용으로 명함 만들기</button></div>
      </div>
    </details>

    <div class="panel">
      <div class="cap">가져온 명함 · 출처 ${S.source === 'remember-export' ? '리멤버' : S.source === 'paste' ? '직접 입력' : '샘플 시드'}
        <button class="ghost xs" data-act="reset" style="margin-left:8px" title="${T.reset}">전체 초기화</button></div>
      ${cardRows(S.cards ?? [], { pick: false })}
    </div>`,

  resolve: x => `
    <div class="panel">
      <div class="cap">보내는 회사 — 고정입니다</div>
      <div style="font-size:16px;font-weight:600">${esc(S.company?.name)}</div>
      <div class="muted" style="font-size:12.5px;margin-top:2px">
        ${esc(S.company?.tagline)} · 업력 ${S.company?.years}년 · 누적 진단 ${S.company?.projects}건<br>
        ${esc(S.company?.addr)} · ${esc(S.company?.tel)}</div>
      <div class="row" style="margin-top:11px">
        <button class="ghost sm" data-act="source" title="${T.source}">자사 홈페이지 다시 읽기</button>
        ${S.sourceProfile ? `<span class="tag ok">서비스 ${(S.sourceProfile.services ?? []).length}종 · 레퍼런스 ${(S.sourceProfile.reference_projects ?? []).length}건</span>` : ''}
      </div>
    </div>

    <div class="panel">
      <div class="cap">누구 이름으로 보낼까요 — 고르는 사람에 따라 말투가 달라집니다</div>
      <div class="grid2">
        ${(S.personas ?? []).map(p => `
          <button class="opt ${S.personaId === p.id ? 'on' : ''}" data-persona="${p.id}"
            title="이 명의로 메일을 씁니다 — ${esc(p.tone)}">
            <b>${esc(p.label)}</b><span>${esc(p.tone)}</span></button>`).join('')}
      </div>
    </div>

    <div class="panel">
      <div class="cap">한 명씩 따로 쓸까요, 그룹에 같은 글을 보낼까요</div>
      <div class="grid2">
        <button class="opt ${S.mode === '1:1' ? 'on' : ''}" data-mode="1:1"
          title="수신자 한 명당 한 통을 따로 만듭니다. 그 회사 홈페이지에서 뽑은 근거를 인용하므로 답장률이 높지만 한 통에 1~2분 걸립니다.">
          <b>1 : 1 개별 맞춤</b>
          <span>그 회사 홈페이지 내용을 인용해 한 통씩 씁니다. 답장률이 높지만 한 통에 1~2분 걸립니다.</span></button>
        <button class="opt ${S.mode === '1:N' ? 'on' : ''}" data-mode="1:N"
          title="고객군마다 공통 문안 한 통을 만들고 이름·회사만 바꿔 넣습니다. 빠르지만 내용이 일반적입니다.">
          <b>1 : N 고객군 공통</b>
          <span>고객군마다 한 통을 쓰고 이름·회사만 바꿔 넣습니다. 빠르지만 내용이 일반적입니다.</span></button>
      </div>
    </div>

    <div class="panel">
      <div class="cap">회사 홈페이지 — 확보 ${x.site} / ${x.usable.length}건. 다음 단계 리서치의 재료입니다</div>
      <div class="muted" style="font-size:12px;margin-bottom:10px">
        찾는 순서: 명함의 URL → 이메일 도메인 → 회사명 AI 추정.
        <b>어느 경우든 실제로 접속되는 주소만</b> 채택합니다. 못 찾으면 표에서 직접 입력하세요.</div>
      ${cardRows(S.cards ?? [], { pick: false })}
    </div>`,

  enrich: () => `
    ${promptPreview ? `
      <div class="panel">
        <div class="cap">AI 에게 실제로 보내는 지시문 · ${esc(promptPreview.mode ?? '')}
          ${esc(promptPreview.target ?? promptPreview.segment ?? '')}</div>
        ${promptPreview.note ? `<span class="chk f">${esc(promptPreview.note)}</span>` : ''}
        <pre style="max-height:480px">${esc(promptPreview.prompt)}</pre>
        <div class="muted" style="font-size:11.5px;margin-top:8px">
          이 지시문이 이 프로그램의 핵심입니다. 고칠 곳은
          <code>src/domain.mjs</code>(고객군 정의)와 <code>src/generate.mjs</code>(글쓰기 규칙)입니다.</div>
      </div>` : ''}
    <div class="panel">${cardRows(S.cards ?? [], { pick: false })}</div>`,

  segment: () => `
    <div class="panel">
      <div class="cap">고객군을 한 번에 선택하기</div>
      <div class="row">
        ${(S.segments ?? []).map(s => {
          const n = (S.cards ?? []).filter(c => c.segmentId === s.id).length;
          return `<button class="ghost sm" data-pick="${s.id}" ${n ? '' : 'disabled'}
            title="${n ? `이 고객군 ${n}건만 발송 대상으로 한 번에 선택합니다. 기존 선택은 대체됩니다.` : '이 고객군에 해당하는 명함이 없습니다.'}">${esc(s.label)}${n ? ` (${n})` : ''}</button>`;
        }).join('')}
        <button class="ghost sm" data-pick="none" title="${T.pickNone}">선택 해제</button>
      </div>
    </div>
    <div class="panel">${cardRows(S.cards ?? [])}</div>`,

  generate: () => (S.cards ?? []).filter(c => c.message).length
    ? (S.cards ?? []).filter(c => c.message).map(msgCard).join('')
    : '<div class="panel muted">아직 만들어진 메일이 없습니다.</div>',

  review: () => (S.cards ?? []).filter(c => c.message).length
    ? (S.cards ?? []).filter(c => c.message).map(msgCard).join('')
    : '<div class="panel muted">검토할 메일이 없습니다. STEP 5 에서 먼저 만드세요.</div>',

  deliver: () => `
    ${!S.smtp?.configured ? `<div class="banner">
      실제 발송을 하려면 프로젝트 폴더에 <code>.env</code> 파일을 만들고 아래를 넣으세요.
      앱 비밀번호는 Google 계정 &gt; 보안 &gt; 2단계 인증 &gt; 앱 비밀번호 에서 발급합니다(16자리).
      <pre style="margin:8px 0 0">GMAIL_USER=보내는주소@gmail.com
GMAIL_APP_PASSWORD=앱비밀번호16자리
GMAIL_FROM_NAME=에이톰엔지니어링
DRY_RUN=1</pre></div>` : ''}
    <div class="panel">
      <div class="cap">자동으로 걸리는 안전장치</div>
      <div class="muted" style="font-size:12.5px">
        승인한 메일만 나갑니다 · 밤 9시~아침 8시 발송 차단 · 같은 사람에게 30일 내 재발송 차단</div>
    </div>
    <div class="panel">
      <table><thead><tr><th>담당자</th><th>회사</th><th>수신</th><th>상태</th><th>시각</th></tr></thead><tbody>
      ${(S.cards ?? []).filter(c => c.message).map(c => `<tr>
        <td>${esc(c.name)}</td><td>${esc(c.company)}</td>
        <td class="muted">${esc(c.email) || '-'}</td>
        <td><span class="tag ${c.status === 'SENT' ? 'ok' : ''}">${esc(c.status)}</span>
          ${c.deliverError ? `<div class="chk f" style="margin-top:4px">${esc(c.deliverError)}</div>` : ''}</td>
        <td class="muted">${esc(c.deliveredAt ?? c.queuedAt) || '-'}</td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">아직 없습니다.</td></tr>'}
      </tbody></table>
    </div>`,
};

function msgCard(c) {
  const m = c.message;
  if (m.error) {
    const why = m.error === 'insufficient-evidence' ? '홈페이지에서 인용할 사실을 찾지 못했습니다' : m.error;
    return `<div class="msg"><div class="to"><b>${esc(c.name)}</b> · ${esc(c.company)}</div>
      <span class="chk f">만들지 않음 — ${esc(why)}</span>
      <div class="muted" style="font-size:11.5px;margin-top:7px">
        STEP 2 에서 이 회사 홈페이지 주소를 넣고 STEP 3 리서치를 다시 돌리면 만들어집니다.</div></div>`;
  }
  const st = m.reviewStatus;
  return `<div class="msg ${st === 'APPROVED' ? 'approved' : ''} ${st === 'REJECTED' ? 'rejected' : ''}" data-id="${c.id}">
    <div class="to"><b>${esc(c.name)}</b> ${esc(c.title)} · ${esc(c.company)}
      <span class="tag seg" style="margin-left:6px">${esc(seg(c.segmentId)?.label)}</span>
      <span class="tag" style="margin-left:4px">${esc(m.mode ?? '1:1')}</span>
      <span class="tag ${st === 'APPROVED' ? 'ok' : st === 'REJECTED' ? 'bad' : ''}" style="margin-left:4px">
        ${st === 'APPROVED' ? '승인됨' : st === 'REJECTED' ? '반려됨' : '검토 대기'}</span></div>
    <div class="checks">${(m.checks ?? []).map(k =>
      `<span class="chk ${k.pass ? 'p' : 'f'}">${k.pass ? '✓' : '✕'} ${esc(k.label)}</span>`).join('')}</div>
    ${m.channel === 'email' ? `<input class="f-subject" value="${esc(m.subject)}">` : ''}
    <textarea class="f-body">${esc(m.body)}</textarea>
    <div class="muted" style="font-size:11.5px;margin-bottom:9px">
      이 메일이 요구하는 행동: ${esc(m.cta) || '-'}<br>
      인용한 실적: ${esc((m.refs_used ?? []).join(', ')) || '없음'}</div>
    <div class="row">
      <button class="ok sm" data-rev="approve" title="${T.approve}">승인</button>
      <button class="bad sm" data-rev="reject" title="${T.reject}">반려</button>
      <button class="ghost sm" data-rev="save" title="${T.saveEdit}">고친 내용만 저장</button>
      ${m.prompt ? `<button class="ghost sm" data-prompt="${c.id}" title="${T.promptOne}">
        ${openPrompts.has(c.id) ? '지시문 접기' : '이 메일을 만든 지시문 보기'}</button>` : ''}
    </div>
    ${m.prompt && openPrompts.has(c.id) ? `<pre style="max-height:420px">${esc(m.prompt)}</pre>` : ''}
  </div>`;
}

/* ── 툴팁 ──────────────────────────────────────────────────
   title 을 그대로 두면 OS 기본 툴팁이 1초쯤 뒤에 작은 글씨로 뜬다. 문장이 길어
   실제로는 읽히지 않는다. 그래서 렌더 뒤 title 을 data-tip 으로 옮겨 직접 그린다.
   aria-label 로 남겨 두어 스크린리더·키보드 사용자도 같은 설명을 받는다. */
const tipBox = document.createElement('div');
tipBox.className = 'tip';
tipBox.hidden = true;
document.body.appendChild(tipBox);
let tipTimer = null, tipFor = null;

function moveTitles(root = document) {
  root.querySelectorAll('[title]').forEach(el => {
    const t = el.getAttribute('title');
    el.dataset.tip = t;
    if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', t);
    el.removeAttribute('title');
  });
}

function showTip(el) {
  const msg = el.dataset.tip;
  if (!msg) return;
  tipFor = el;
  tipBox.textContent = msg;
  tipBox.hidden = false;
  const r = el.getBoundingClientRect();
  const w = tipBox.offsetWidth, h = tipBox.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  let top = r.top - h - 8;
  if (top < 8) top = Math.min(r.bottom + 8, innerHeight - h - 8);
  tipBox.style.left = `${left}px`;
  tipBox.style.top = `${Math.max(8, top)}px`;
}

function hideTip() { clearTimeout(tipTimer); tipBox.hidden = true; tipFor = null; }

document.addEventListener('mouseover', e => {
  const el = e.target.closest?.('[data-tip]');
  if (!el || el === tipFor) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => showTip(el), 180);
});
document.addEventListener('mouseout', e => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) return;
  if (e.relatedTarget && el.contains(e.relatedTarget)) return;  // 자식으로 이동한 것뿐
  hideTip();
});
document.addEventListener('focusin', e => {
  const el = e.target.closest?.('[data-tip]');
  if (el) showTip(el);
});
document.addEventListener('focusout', hideTip);
document.addEventListener('click', hideTip, true);
window.addEventListener('scroll', hideTip, true);

/* ── 이벤트 ──────────────────────────────────────────────── */
function bind() {
  const acts = {
    ingest: () => api('/api/ingest', {}),
    reset: () => confirm('가져온 명함과 만든 메일이 모두 지워집니다. 계속할까요?')
      ? api('/api/reset', {}) : api('/api/state'),
    enrich: () => api('/api/enrich', {}),
    segment: () => api('/api/segment', {}),
    segmentai: () => api('/api/segment', { useAi: true }),
    source: () => api('/api/source-profile', {}),
    resolvesites: () => api('/api/resolve-sites', {}),
    deliver: () => api('/api/deliver', { confirm: false }),

    generate: async () => {
      let r = await api('/api/generate', { channel, batch: 1, restart: true });
      let guard = 0;
      while (r?.remaining > 0 && guard++ < 300) {
        adopt(r); render(`메일 만드는 중 — ${r.remaining}건 남음`);
        r = await api('/api/generate', { channel, batch: 1 });
        if (r?.error) break;
      }
      return r;
    },

    send: async () => {
      const n = (S.cards ?? []).filter(c => c.message?.reviewStatus === 'APPROVED').length;
      if (!confirm(`승인된 ${n}건을 실제로 발송합니다.\n되돌릴 수 없습니다. 계속할까요?`)) return api('/api/state');
      const r = await api('/api/deliver', { confirm: true });
      const sent = (r.results ?? []).filter(y => y.sent).length;
      alert(`발송 ${sent}/${(r.results ?? []).length}건 성공`);
      return r;
    },

    prompt: async () => {
      const first = (S.cards ?? []).find(c => (S.selection ?? []).includes(c.id)) ?? S.cards?.[0];
      promptPreview = await api('/api/prompt-preview', {
        id: first?.id, segmentId: first?.segmentId, channel: 'email',
      });
      return api('/api/state');
    },

    rlogin: async () => {
      alert('전용 크롬 창이 열립니다.\n그 창에서 직접 로그인해 주세요. 명함 목록이 뜨면 자동으로 감지합니다.');
      const r = await api('/api/remember-login', {});
      alert(r.ok ? '로그인 저장 완료. [전부 가져오기]를 누르세요.' : `로그인이 확인되지 않았습니다.\n\n${r.log}`);
      return api('/api/state');
    },
    rexport: async () => {
      const r = await api('/api/remember-export', { via: 'profile' });
      alert(r.ok ? '가져오기 완료. [명함 불러오기]를 누르세요.' : `실패\n\n${r.log}`);
      return api('/api/state');
    },
    rexportcdp: async () => {
      const r = await api('/api/remember-export', { via: 'cdp' });
      alert(r.ok ? '가져오기 완료. [명함 불러오기]를 누르세요.' : `실패\n\n${r.log}`);
      return api('/api/state');
    },
    paste: async () => {
      const t = pasteText;
      if (!t.trim()) { alert('붙여넣은 내용이 없습니다.'); return api('/api/state'); }
      const r = await api('/api/paste-cards', { text: t });
      if (r.error) { alert(r.error); return api('/api/state'); }
      alert(`명함 ${(r.cards ?? []).length}건을 만들었습니다. (${r.parsedAs === 'table' ? '표 형식' : '덩어리 텍스트'}로 인식)`);
      pasteText = '';
      return r;
    },
    copysnippet: async () => {
      // 스니펫은 리멤버 페이지에서 실행되므로 이 대시보드 주소를 스스로 알 수 없다.
      // 복사 시점에 현재 주소를 앞줄에 박아 준다. (기본값 localhost 로는 배포본에 못 붙는다)
      const raw = await (await fetch('/collect-snippet.js')).text();
      const code = `window.__protoRemDash = ${JSON.stringify(location.origin)};\n${raw}`;
      if (await copyText(code)) {
        alert(`복사했습니다.\n\ncard.rememberapp.co.kr 에서 F12 → Console 에 붙여넣으세요.\n`
          + `보낼 주소로 ${location.origin} 이 함께 들어갔습니다.`);
      } else {
        window.open('/collect-snippet.js', '_blank');
        alert('클립보드가 막혀 있어 스니펫 원문을 새 탭으로 열었습니다.\n'
          + 'Ctrl+A → Ctrl+C 로 복사한 뒤, 콘솔 첫 줄에\n'
          + `window.__protoRemDash = "${location.origin}";\n을 먼저 입력해 주세요.`);
      }
      return api('/api/state');
    },
  };

  document.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = () => run(b.textContent.trim(), acts[b.dataset.act]);
  });
  document.querySelectorAll('[data-mode]').forEach(b => {
    b.onclick = async () => { await post('/api/mode', { mode: b.dataset.mode }); render(); };
  });
  document.querySelectorAll('[data-persona]').forEach(b => {
    b.onclick = async () => { await post('/api/mode', { personaId: b.dataset.persona }); render(); };
  });
  document.querySelectorAll('[data-prompt]').forEach(b => {
    b.onclick = () => {
      const id = b.dataset.prompt;
      openPrompts.has(id) ? openPrompts.delete(id) : openPrompts.add(id);
      render();
    };
  });
  document.querySelectorAll('[data-site]').forEach(inp => {
    inp.onchange = async () => {
      await post('/api/set-site', { id: inp.dataset.site, site: inp.value });
      render();
    };
  });
  document.querySelectorAll('[data-ex]').forEach(b => {
    b.onclick = async () => {
      await post('/api/exclude', { id: b.dataset.ex, excluded: b.dataset.exv === '1' });
      render();
    };
  });
  document.querySelectorAll('.pick').forEach(cb => {
    cb.onchange = async () => {
      const ids = [...document.querySelectorAll('.pick:checked')].map(y => y.value);
      await post('/api/selection', { ids });
      render();
    };
  });
  document.querySelectorAll('[data-pick]').forEach(b => {
    b.onclick = async () => {
      const t = b.dataset.pick;
      const ids = t === 'none' ? [] : (S.cards ?? []).filter(c => c.segmentId === t).map(c => c.id);
      await post('/api/selection', { ids });
      render();
    };
  });
  document.querySelectorAll('[data-rev]').forEach(b => {
    b.onclick = async () => {
      const box = b.closest('.msg');
      await post('/api/review', {
        id: box.dataset.id, action: b.dataset.rev,
        subject: box.querySelector('.f-subject')?.value,
        body: box.querySelector('.f-body')?.value,
      });
      render();
    };
  });

  const chSel = $('#ch');
  if (chSel) { chSel.value = channel; chSel.onchange = () => { channel = chSel.value; }; }
  const pasteBox = $('#paste');
  if (pasteBox) pasteBox.oninput = () => { pasteText = pasteBox.value; };

  const drop = $('#drop'), file = $('#file');
  if (drop && file) {
    drop.onclick = () => file.click();
    drop.ondragover = e => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; };
    drop.ondragleave = () => { drop.style.borderColor = ''; };
    drop.ondrop = e => { e.preventDefault(); drop.style.borderColor = ''; upload(e.dataTransfer.files[0]); };
    file.onchange = () => upload(file.files[0]);
  }

  // 이번 렌더로 새로 생긴 title 들을 툴팁으로 넘긴다.
  moveTitles();
}

async function upload(f) {
  if (!f) return;
  let cards;
  try { cards = JSON.parse(await f.text()); }
  catch { return alert('JSON 파일이 아닙니다.'); }
  if (!Array.isArray(cards)) return alert('명함 목록이 아닙니다.');
  const r = await api('/api/upload-cards', { cards });
  if (r.error) return alert(r.error);
  adopt(r);
  alert(`${(r.cards ?? []).length}건 불러왔습니다.`);
  render();
}

(async () => {
  initConsole();
  log('ok', '시작', `proto-rem 콘솔 · ${location.host}`);
  await post('/api/state');
  render();
  initConsole();   // render 가 DOM 을 갈아엎어도 콘솔 바는 살아 있어야 한다
})();
