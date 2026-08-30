/* ═══════════════════════════════════════════════════════════════════════
   proto-rem 대시보드 프런트엔드
   백엔드는 Python(py/server.py). 이 파일은 서버 구현과 무관하게 /api/* 만 쓴다.
   ═══════════════════════════════════════════════════════════════════════ */
const $ = s => document.querySelector(s);
const esc = t => String(t ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let S = null, busy = false;
let viewStep = 1;                 // 1~7 또는 'all'
let promptPreview = null;
const openPrompts = new Set();
/* 지금 편집 중인 명함 id. 표는 매 렌더마다 통째로 다시 그려지므로
   "어느 행이 편집 모드인가"는 DOM 이 아니라 여기에 둔다. */
const editing = new Set();

/* 문구 스튜디오 상태 — 서버가 아니라 화면에 둔다. 고르는 중에는 저장할 게 없다. */
let palette = null;
const pickedKw = new Set();
const pickedTone = new Set(['calm', 'urgent', 'benefit']);
const pickedCopy = new Set();
let llmModels = null;

/* ── 로그 콘솔 ─────────────────────────────────────────────────────────
   서버(/api/logs)와 브라우저에서 나는 일을 한 창에 합친다.
   화면에서 안 보이는 곳(크롤·LLM·SMTP)이 대부분이라, 이게 없으면
   "누른 뒤 아무 일도 안 일어나는 것처럼" 보인다. */
const LOG = {
  rows: [],
  since: 0,
  levels: new Set(['info', 'ok', 'warn', 'error', 'net', 'ai', 'ui']),
  max: 1200,
  push(level, tag, msg, meta) {
    this.rows.push({ t: new Date().toISOString(), level, tag, msg: String(msg ?? ''), meta });
    if (this.rows.length > this.max) this.rows.splice(0, this.rows.length - this.max);
    this.paint();
  },
  merge(events) {
    for (const e of events) this.rows.push(e);
    this.rows.sort((a, b) => String(a.t).localeCompare(String(b.t)));
    if (this.rows.length > this.max) this.rows.splice(0, this.rows.length - this.max);
    this.paint();
  },
  paint() {
    const errs = this.rows.filter(r => r.level === 'error').length;
    const cnt = $('#conCount');
    if (cnt) {
      cnt.textContent = errs ? `${this.rows.length} · 오류 ${errs}` : String(this.rows.length);
      cnt.className = `pill ${errs ? 'err' : 'live'}`;
    }
    const last = this.rows[this.rows.length - 1];
    const lastEl = $('#conLast');
    if (lastEl && last) lastEl.textContent = `[${last.tag}] ${last.msg}`;
    const box = $('#conLogs');
    if (!box || !$('#console')?.classList.contains('open')) return;
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    box.innerHTML = this.rows
      .filter(r => this.levels.has(r.level))
      .slice(-500)
      .map(r => `<div class="lg ${esc(r.level)}">
        <span class="tm">${esc(String(r.t).slice(11, 23))}</span>
        <span class="tg">${esc(r.tag)}</span>
        <span class="mg">${esc(r.msg)}${r.meta ? ` <span class="mt">${esc(JSON.stringify(r.meta))}</span>` : ''}</span>
      </div>`).join('');
    if (stick) box.scrollTop = box.scrollHeight;
  },
  async poll() {
    try {
      const r = await fetch(`/api/logs?since=${this.since}`);
      const j = await r.json();
      if (j.events?.length) { this.since = j.seq; this.merge(j.events); }
      else if (typeof j.seq === 'number') this.since = j.seq;
    } catch { /* 서버가 잠깐 죽어도 콘솔은 계속 돈다 */ }
  },
};

/* 브라우저 쪽 사고도 전부 콘솔로 끌어온다 */
window.addEventListener('error', e => LOG.push('error', 'js', `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', e => LOG.push('error', 'js', `처리되지 않은 거부: ${e.reason?.message ?? e.reason}`));

/* ── API ─────────────────────────────────────────────────────────────── */
const api = async (p, body) => {
  const t0 = performance.now();
  LOG.push('net', 'ui→', `${body ? 'POST' : 'GET'} ${p}`, body ? shrink(body) : undefined);
  let r;
  try {
    r = await fetch(p, body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'GET' });
  } catch (e) {
    LOG.push('error', 'ui→', `${p} 연결 실패 — ${e.message}`);
    return { error: `서버에 연결하지 못했습니다.\n${e.message}` };
  }
  // 서버가 500 을 HTML 로 뱉는 경우가 있어 무조건 JSON 으로 믿지 않는다.
  const txt = await r.text();
  const ms = Math.round(performance.now() - t0);
  try {
    const j = JSON.parse(txt);
    LOG.push(j.error ? 'error' : 'ok', '←ui', `${p} ${r.status}`, { ms, ...(j.error ? { error: j.error } : {}) });
    return j;
  } catch {
    LOG.push('error', '←ui', `${p} ${r.status} — JSON 아님`, { ms });
    return { error: `서버 응답을 해석하지 못했습니다 (HTTP ${r.status})\n${txt.slice(0, 300)}` };
  }
};
/* 로그에 명함 전체·본문 전체가 박히지 않게 줄인다 */
const shrink = o => Object.fromEntries(Object.entries(o).map(([k, v]) => {
  if (Array.isArray(v)) return [k, `${v.length}건`];
  if (typeof v === 'string' && v.length > 60) return [k, `${v.slice(0, 60)}…`];
  return [k, v];
}));

/* 응답을 화면 상태 S 에 반영한다.
   응답에 steps 같은 메타가 빠져 있어도 이전 값을 살린다. 부분 응답이 S 를 통째로
   덮어쓰면 사이드바가 사라지고 render() 가 S.steps[0] 에서 터진다. */
/* 버튼이 실제로 무엇을 하는지 — 누르기 전에 알 수 있어야 한다.
   이름만으로는 부작용(기존 데이터가 갱신되는지, 삭제되는지)이 드러나지 않는다. */
const BTN_HELP = {
  ingest: '저장된 명함 파일(data/cards.json, 없으면 샘플)을 읽어 목록에 넣습니다. '
        + '이름+전화가 같은 명함은 덮어쓰지 않고 갱신하고, 없던 것만 추가합니다(UPSERT). '
        + '기존 분류·근거·문안·승인 이력은 그대로 보존됩니다.',
  paste: '위 입력창에 붙여넣은 내용을 명함으로 만듭니다. 엑셀 표·CSV·덩어리 텍스트 모두 인식하고, '
       + '이메일·전화·홈페이지는 위치가 달라도 내용으로 찾아냅니다. 기존 명함과 겹치면 갱신합니다.',
  reset: '⚠ 이 테넌트의 명함·문안·승인·발송 이력을 전부 삭제합니다. 되돌릴 수 없습니다.',
  exportcsv: '명함·고객군·리서치 근거·문안·검증결과·발송이력을 CSV 한 장으로 내려받습니다. 엑셀에서 바로 열립니다.',

  rlogin: '이 프로그램 전용 크롬 창을 엽니다. 그 창에서 직접 로그인하시면 세션이 저장되어 '
        + '다음부터는 버튼 하나로 수집합니다. 비밀번호는 프로그램이 다루지 않습니다.',
  rexport: '저장된 전용 프로필 세션으로 리멤버 명함을 자동 수집합니다. 먼저 [브라우저 열어 로그인]이 필요합니다.',
  rexportcdp: '디버깅 포트로 실행한 크롬에 접속해 명함을 수집합니다. 크롬을 완전히 종료한 뒤 '
            + '--remote-debugging-port=9222 로 다시 실행해 두어야 합니다.',
  copysnippet: '리멤버 페이지 콘솔에 붙여넣을 수집 스크립트를 클립보드에 복사합니다.',

  source: '에이톰 홈페이지를 다시 읽어 서비스 목록·공신력 근거·레퍼런스를 갱신합니다. '
        + '메일에 인용할 자사 실적의 출처가 됩니다.',
  resolvesites: '각 회사의 홈페이지 주소를 찾습니다. ① 명함에 적힌 URL → ② 이메일 도메인(gmail 등 무료메일은 제외) '
              + '→ ③ 회사명으로 AI 추정, 순서로 시도합니다. 어느 경우든 실제로 접속되는 주소만 채택하므로 '
              + 'AI가 없는 주소를 지어내도 결과에 들어가지 않습니다. 못 찾으면 표에서 직접 입력하시면 됩니다.',

  enrich: '확보된 홈페이지를 실제로 열어 읽고, 메일에 인용할 사실(준공연도·규모·시설 현황 등)을 뽑아냅니다. '
        + '근거를 하나도 못 찾은 회사는 다음 단계에서 메일 생성이 자동 차단됩니다.',
  prompt: 'AI에게 보낼 지시문 전문을 그대로 보여줍니다. 메일을 만들지는 않습니다. '
        + '이 지시문이 이 프로그램의 실제 로직입니다.',

  segment: '회사명·직함에 담긴 키워드로 7개 고객군에 배정합니다. 즉시 끝나지만 '
         + '"노바엣지테크놀로지"처럼 이름에 업종이 안 드러나면 미분류로 남습니다.',
  segmentai: '키워드가 놓친 건만 AI에게 물어봅니다. 7개 고객군 밖을 만들지 못하게 막았고, '
           + '확신이 없으면 미분류로 두게 했습니다. 억지 분류가 곧 스팸이 되기 때문입니다. 건당 수십 초 걸립니다.',

  generate: '선택한 대상에게 보낼 메일 문안을 만듭니다. 1:1은 회사별 근거를 인용해 한 통씩, '
          + '1:N은 고객군마다 한 통을 만들고 이름·회사만 치환합니다. (광고) 표기와 수신거부 문구는 코드가 강제로 넣습니다.',

  deliver: '전송하지 않습니다. 승인된 건을 발송 큐에만 올려 결과 표를 확인하는 연습용입니다.',
  send: '⚠ 승인된 메일을 실제로 발송합니다. 확인 창이 한 번 더 뜹니다. 되돌릴 수 없습니다.',
};

const META = ['steps', 'segments', 'company', 'personas', 'backend', 'smtp', 'copyKinds', 'copyTones', 'runtime'];
function adopt(r) {
  if (!r) return S;
  if (r.error) { toast(r.error, true); return S; }
  for (const k of META) if (r[k] === undefined && S?.[k] !== undefined) r[k] = S[k];
  S = r;
  return S;
}

const run = async (label, fn, ctx) => {
  if (busy || !fn) return;
  busy = true;
  try {
    render(label);
    adopt(await fn(ctx));
  } catch (e) {
    LOG.push('error', 'ui', e?.stack ?? String(e));
    toast(e?.message ?? String(e), true);
  } finally {
    busy = false;
    render();
  }
};

function toast(msg, bad) {
  LOG.push(bad ? 'error' : 'info', 'ui', msg);
  alert(msg);
}

const seg = id => (S?.segments ?? []).find(s => s.id === id);

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
  raw: { i: '⬇', t: '가져온 데이터 — 리멤버 원본 그대로', c: 'var(--tx2)' },
  ai: { i: '✧', t: 'AI 추정 — 사람이 확인 후 쓰세요', c: 'var(--br)' },
  calc: { i: '∑', t: '계산값 — 다른 값에서 자동 산출', c: 'var(--ok)' },
  man: { i: '✎', t: '직접 입력', c: 'var(--warn)' },
};
const srcTag = (k, extra = '') => {
  const s2 = SRC[k]; if (!s2) return '';
  return `<span title="${esc(s2.t)}${extra ? ' · ' + esc(extra) : ''}"
    style="color:${s2.c};font-size:11px;margin-left:4px;cursor:help">${s2.i}</span>`;
};

/* ── 현재 상황 계산 ────────────────────────────────────────────────────
   진행도를 "몇 번 메뉴를 눌렀나"가 아니라 "데이터가 실제로 어디까지 왔나"로 센다. */
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
  const p = (S.personas ?? []).find(y => y.id === S.personaId)?.label ?? '-';
  return {
    1: x.total === 0
      ? { t: '지금 할 일', m: '명함을 넣으세요', s: '아래 [붙여넣기] 가 가장 빠릅니다. 표·여러 줄·한 줄 무엇이든 됩니다.' }
      : { t: '완료', m: `명함 ${x.total}건이 준비됐습니다`, s: `이 중 ${x.dropped}건은 자사·본인 프로필이라 발송 대상에서 빠집니다. 실제 대상은 ${x.usable.length}건입니다.`, done: true },
    2: { t: S.personaId && S.mode ? '확인' : '지금 할 일', m: '누구 이름으로, 어떻게 보낼지 정하세요',
         s: `현재 ${p} 명의 · ${S.mode} 방식입니다. 홈페이지가 없는 회사는 자동으로 찾거나 직접 입력하세요. (확보 ${x.site}/${x.usable.length}건)`,
         done: Boolean(S.personaId && S.mode) },
    3: x.site === 0
      ? { t: '막힘', m: '홈페이지 주소가 하나도 없습니다', s: 'STEP 2 에서 [홈페이지 자동 찾기] 를 누르거나 주소를 직접 입력하세요. 홈페이지가 없으면 메일을 만들 수 없습니다.', blocked: true }
      : x.facts === 0
        ? { t: '지금 할 일', m: '회사 홈페이지를 읽어 근거를 뽑으세요', s: `${x.site}개 회사의 주소가 확보됐습니다. 각 회사에서 메일에 인용할 사실을 찾아냅니다.` }
        : { t: '완료', m: `${x.facts}개 회사에서 근거를 찾았습니다`, s: '근거가 없는 회사는 다음 단계에서 메일 생성이 자동으로 막힙니다.', done: true },
    4: x.classified === 0
      ? { t: '지금 할 일', m: '고객군을 나누세요', s: '회사 이름 규칙으로 먼저 나누고, 남는 건만 AI 에게 물어봅니다.' }
      : x.selected === 0
        ? { t: '지금 할 일', m: '보낼 사람을 직접 고르세요', s: '분류는 자동이지만 선택은 사람이 합니다. 지금 연락해도 되는 관계인지는 담당자만 압니다.' }
        : { t: '완료', m: `${x.selected}명을 발송 대상으로 정했습니다`, s: 'STEP 5 에서 문구를 고르고 메일을 만듭니다.', done: true },
    5: x.selected === 0
      ? { t: '막힘', m: '발송 대상이 없습니다', s: 'STEP 4 에서 보낼 사람을 먼저 선택하세요.', blocked: true }
      : x.drafted === 0
        ? { t: '지금 할 일', m: '키워드를 고르고 문구를 받아 보세요', s: '아래 문구 스튜디오에서 키워드 몇 개만 누르면 광고 문구 수십 개를 뽑아 줍니다. 마음에 드는 것을 찜하면 그 방향으로 메일이 만들어집니다.' }
        : { t: '완료', m: `초안 ${x.drafted}건이 만들어졌습니다`, s: x.held ? `${x.held}건은 홈페이지 근거가 없어 만들지 않았습니다.` : 'STEP 6 에서 읽어보고 승인하세요.', done: true },
    6: x.drafted === 0
      ? { t: '막힘', m: '검토할 메일이 없습니다', s: 'STEP 5 에서 먼저 만드세요.', blocked: true }
      : x.approved === 0
        ? { t: '지금 할 일', m: '메일을 읽어보고 승인하세요', s: '제목과 본문을 직접 고칠 수 있습니다. 승인한 것만 발송 단계로 넘어갑니다.' }
        : { t: '완료', m: `${x.approved}건을 승인했습니다`, s: 'STEP 7 에서 발송합니다.', done: true },
    7: !S.smtp?.configured
      ? { t: '막힘', m: '발송 계정이 설정되지 않았습니다', s: '.env 에 GMAIL_USER 와 GMAIL_APP_PASSWORD 를 넣고 서버를 다시 시작하세요.', blocked: true }
      : x.approved === 0
        ? { t: '지금 할 일', m: '먼저 테스트 메일을 한 통 보내 보세요', s: '아래에서 받는 사람·제목·본문만 넣으면 바로 보냅니다. 캠페인 메일은 STEP 6 에서 승인한 것만 나갑니다.' }
        : x.sent === 0
          ? { t: '지금 할 일', m: `승인된 ${x.approved}건을 발송하세요`, s: S.smtp.dryRun ? 'DRY_RUN=1 이라 실제로는 나가지 않습니다. 연습해 보세요.' : '실제로 메일이 나갑니다. 확인 창이 한 번 더 뜹니다.' }
          : { t: '완료', m: `${x.sent}건 처리됐습니다`, s: '아래 표에서 결과를 확인하세요.', done: true },
  }[n];
}

const SHORT = {
  ingest: '붙여넣기 · 리멤버 · 파일',
  resolve: '명의 · 1:1/1:N · 홈페이지',
  enrich: '홈페이지 읽고 근거 추출',
  segment: '분류 후 사람이 확정',
  generate: '문구 고르고 문안 생성',
  review: '고치고 승인/반려',
  deliver: '테스트 발송 · 실제 발송',
};

/* ── 렌더 ──────────────────────────────────────────────────────────── */
function render(loading) {
  try { draw(loading); }
  catch (e) {
    LOG.push('error', 'render', e?.stack ?? String(e));
    $('#view').innerHTML = `<div class="panel"><div class="cap">화면을 그리지 못했습니다</div>
      <pre>${esc(e?.stack ?? e)}</pre>
      <div class="row" style="margin-top:10px"><button id="reload">새로고침</button></div></div>`;
    const rb = $('#reload');
    if (rb) rb.onclick = () => location.reload();
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
    const rb = $('#reload'); if (rb) rb.onclick = () => location.reload();
    return;
  }
  const x = stats();

  /* 좌측 레일 — 전체 보기 + 7단계. 어느 화면에서도 항상 그린다. */
  $('#rail').innerHTML = `
    <div class="step ${viewStep === 'all' ? 'active' : ''}" data-n="all"
      title="7단계를 한 화면에 세로로 펼쳐 봅니다. 전체 흐름을 훑거나 여러 단계를 오가며 작업할 때 씁니다.">
      <div class="num">▤</div>
      <div><div class="lb">전체 보기</div><div class="sb">7단계를 한 화면에</div></div>
    </div>` + steps.map(s => {
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

  const b = S.backend ?? {};
  // 백엔드가 없으면 STEP 3·5 가 반드시 실패한다. 시도하기 전에 사이드바에서 먼저 보여준다.
  const noAi = b.name === 'none';
  $('#stat').innerHTML = `
    <dt>AI</dt><dd title="${esc(noAi ? (b.hint ?? '') : `${b.model ?? ''} · ${b.cloud ? '외부 전송' : '이 PC 안에서 처리'}`)}"
      style="color:${noAi ? 'var(--bad)' : b.cloud ? 'var(--warn)' : 'var(--ok)'}">
      ${noAi ? '⚠ 없음' : `${b.cloud ? '☁' : '🖥'} ${esc(b.name ?? '-')}`}</dd>
    <dt>메일</dt><dd style="color:${S.smtp?.configured ? (S.smtp.dryRun ? 'var(--warn)' : 'var(--ok)') : 'var(--tx3)'}">
      ${S.smtp?.configured ? (S.smtp.dryRun ? '연습모드' : '발송가능') : '미설정'}</dd>
    <dt>서버</dt><dd>${esc(S.runtime === 'python' ? 'Python' : 'Node')} · SQLite</dd>`;

  $('#flow').innerHTML = [
    ['명함', x.total], ['대상', x.usable.length], ['홈페이지', x.site], ['근거', x.facts],
    ['선택', x.selected], ['초안', x.drafted], ['승인', x.approved], ['발송', x.sent],
  ].map(([k, v]) =>
    `<div class="cell ${v ? 'good' : 'zero'}"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');

  if (viewStep === 'all') {
    $('#head').innerHTML = `
      <div class="eyebrow">전체 흐름</div>
      <h2>7단계를 한 화면에</h2>
      <div class="desc">명함 수집부터 발송까지 전부 펼쳐 놓았습니다. 위에서부터 순서대로 내려가시면 됩니다.</div>`;
    $('#todo').innerHTML = loading
      ? `<div class="todo"><div class="t">진행 중</div><div class="spin" style="margin-top:8px">${esc(loading)}</div></div>` : '';
    $('#view').innerHTML = steps.map(s => {
      const t = todoFor(s.n, x) ?? { t: '', m: s.label, s: '' };
      return `
      <div style="margin:26px 0 9px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span class="tag ${stepDone(s.n, x) ? 'ok' : ''}">STEP ${s.n}</span>
        <span style="font-size:17px;font-weight:700;letter-spacing:-.4px">${esc(s.label)}</span>
        ${s.hitl ? '<span class="hitl">HUMAN</span>' : ''}
      </div>
      <div class="todo ${t.blocked ? 'blocked' : ''} ${t.done ? 'done' : ''}">
        <div class="t">${esc(t.t)}</div><div class="m">${esc(t.m)}</div><div class="s">${esc(t.s)}</div>
        ${PRIMARY[s.id] ? PRIMARY[s.id](x) : ''}</div>
      ${VIEWS[s.id] ? VIEWS[s.id](x) : ''}`;
    }).join('');
    bind();
    return;
  }

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

/* ── 버튼 툴팁 문구 ────────────────────────────────────────────────────
   버튼 이름만으로는 "누르면 무슨 일이 벌어지는지"를 알 수 없다. 특히 되돌릴 수 없는
   동작(초기화·실제 발송)과 오래 걸리는 동작(리서치·생성)이 같은 줄에 섞여 있다. */
const T = {
  ingest: '서버의 data/cards.json(리멤버 반출·스니펫·붙여넣기 결과)을 읽어 명함 목록을 새로 채웁니다. 파일이 없으면 샘플 시드를 씁니다. 기존 목록은 대체됩니다.',
  copysnippet: '리멤버 페이지 콘솔(F12)에 붙여넣을 수집 스크립트를 클립보드에 복사합니다. 서버로 나가는 것은 없습니다.',
  reset: '명함·초안·승인·발송 이력을 모두 지웁니다. 되돌릴 수 없습니다. 확인 창이 한 번 더 뜹니다.',
  rlogin: '이 프로그램 전용 크롬 창을 엽니다. 그 창에서 직접 로그인하면 로그인 상태만 저장됩니다(비밀번호는 다루지 않습니다). 서버가 내 PC 에서 돌 때만 동작합니다.',
  rexport: '저장된 로그인으로 리멤버 명함첩을 훑어 data/cards.json 으로 반출합니다. 건수에 따라 수 분 걸립니다.',
  rexportcdp: '--remote-debugging-port=9222 로 켜 둔 크롬에 붙어 명함을 반출합니다. 크롬을 완전히 종료한 뒤 재실행해야 합니다.',
  paste: '위 상자의 텍스트를 표·덩어리·한 줄 중 무엇이든 해석해 명함을 만듭니다. 기존 명함 목록은 대체됩니다.',
  addcard: '명함 한 건을 직접 추가합니다. 기존 목록은 그대로 두고 맨 뒤에 붙습니다.',
  delcard: '이 명함을 목록에서 완전히 지웁니다. 되돌릴 수 없습니다.',
  editcard: '이름·직함·회사·이메일·전화를 이 자리에서 고칩니다. [저장]을 눌러야 반영됩니다.',
  savecard: '고친 내용을 저장합니다. 회사명이 바뀌면 고객군도 다시 판정됩니다. (홈페이지 주소는 입력칸을 벗어나는 즉시 따로 저장됩니다)',
  cancelcard: '고치던 내용을 버리고 원래 값으로 되돌립니다.',
  source: '에이톰엔지니어링 홈페이지를 다시 읽어 서비스·레퍼런스 목록을 갱신합니다. 메일에 인용할 자사 실적의 출처입니다.',
  resolvesites: '명함의 URL → 이메일 도메인 → 회사명 AI 추정 순으로 찾습니다. 실제로 접속되는 주소만 채택합니다. 회사 수만큼 접속하므로 시간이 걸립니다.',
  enrich: '확보된 홈페이지를 실제로 열어 메일에 인용할 사실(근거)을 뽑습니다. 회사당 수 초 걸리고, 근거가 없으면 다음 단계에서 메일 생성이 막힙니다.',
  prompt: '메일을 만들지 않습니다. AI 에게 실제로 보낼 지시문 원문만 보여줍니다.',
  segment: '회사명 키워드 규칙으로 7개 고객군에 배정합니다. AI 호출이 없어 즉시 끝나고, 애매한 건은 미분류로 남습니다.',
  segmentai: '규칙이 미분류로 남긴 명함만 AI 에게 물어봅니다. 건당 호출이라 시간이 걸리고, 결과는 추정이라 사람 확인이 필요합니다.',
  interests: '선택한 사람들의 명함·홈페이지 근거를 보고 "지금 무엇에 관심이 있을지"를 AI 가 추정합니다. 문구 스튜디오와 메일 생성이 이 추정을 재료로 씁니다.',
  channel: '만들 문안의 형식입니다. 문자(LMS)·리멤버 메시지는 제목 없이 본문만 만듭니다.',
  generate: '선택한 대상에게 보낼 문안을 만듭니다. 1건씩 순차로 진행하며 한 통에 1~2분 걸릴 수 있습니다. 기존 초안은 다시 만들어집니다.',
  suggest: '고른 키워드·톤으로 광고 문구 후보를 한 번에 뽑습니다. AI 가 느리거나 꺼져 있으면 규칙 조합으로 채웁니다(카드에 표시됩니다).',
  pickcopy: '찜한 문구를 저장합니다. 다음에 [메일 만들기] 를 누르면 이 문구들의 어조·소구점이 지시문에 얹힙니다.',
  deliver: '실제로 보내지 않습니다. 승인된 건의 상태만 QUEUED 로 바꿔 발송 직전 점검에 씁니다.',
  send: '승인된 건을 Gmail SMTP 로 실제 전송합니다. 되돌릴 수 없습니다. 확인 창이 한 번 더 뜹니다.',
  testsend: '파이프라인과 무관하게 이 폼의 내용만으로 한 통 보냅니다. SMTP 설정과 스팸함 도착 여부를 확인하는 용도입니다. (광고) 표기와 수신거부 문구는 자동으로 붙습니다.',
  approve: '고친 제목·본문을 저장하고 발송 대상으로 확정합니다. 승인한 건만 STEP 7 로 넘어갑니다.',
  reject: '이 건을 발송에서 제외합니다. 초안은 남습니다.',
  saveEdit: '승인 상태는 그대로 두고 고친 제목·본문만 저장합니다.',
  promptOne: '이 메일을 만들 때 AI 에게 보낸 지시문 원문을 펼쳐 봅니다.',
  pickNone: '선택을 모두 해제합니다. 명함이 지워지지는 않습니다.',
  pickAll: '자사·제외를 뺀 모든 명함을 발송 대상으로 선택합니다.',
  siteIn: '홈페이지 주소를 직접 넣습니다. 입력 칸을 벗어나면 바로 저장됩니다.',
  pickOne: '이 명함을 발송 대상에 넣거나 뺍니다. 자사·제외 명함은 서버에서도 걸러집니다.',
  drop: '리멤버에서 받은 cards.json 파일을 올립니다. 기존 명함 목록은 대체됩니다.',
  setSeg: 'AI 가 확신이 없으면 미분류로 둡니다. 담당자가 아는 정보로 여기서 직접 고르면 그 고객군의 통증·실적으로 메일이 만들어집니다.',
  llmreload: '이 PC 의 Ollama 에 설치된 모델 목록을 다시 읽습니다.',
};

/* 각 단계의 주 버튼 — "지금 할 일" 상자 안에 둔다 */
const PRIMARY = {
  ingest: () => `
    <div class="panel">
      <div class="cap">데이터 인터페이스 — 사내 시스템과 주고받기</div>
      <div class="row">
        <a href="/api/export-csv" download
           style="text-decoration:none"><button class="ghost sm"
             title="현재 명함 목록 전체를 CSV 파일로 내려받습니다. 엑셀에서 열어 보거나 백업용으로 쓰세요.">전체 CSV 내보내기</button></a>
        <span class="muted" style="font-size:12px">명함·고객군·문안·검증결과·발송이력을 한 장으로. 엑셀에서 바로 열립니다</span>
      </div>
    </div><div class="row">
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
      <button class="ghost" data-act="segmentai" title="${T.segmentai}">AI 로 마저 분류</button>
      <button class="ghost" data-act="interests" ${x.usable.length ? '' : 'disabled'} title="${T.interests}">관심사 추정</button>
      ${x.classified ? '<span class="muted" style="font-size:12px">아래 표에서 체크박스로 대상을 고르세요</span>' : ''}</div>`,
  generate: x => `<div class="row">
      <select id="ch" title="${T.channel}">
        <option value="email">이메일</option><option value="sms">문자(LMS)</option><option value="remember">리멤버 메시지</option>
      </select>
      <button data-act="generate" ${x.selected ? '' : 'disabled'}
        title="${x.selected ? T.generate : '발송 대상이 없습니다. STEP 4 에서 먼저 고르세요.'}">메일 만들기 (${x.selected}건)</button>
      ${pickedCopy.size ? `<span class="tag seg">문구 ${pickedCopy.size}개 반영됨</span>` : ''}</div>`,
  review: () => '',
  deliver: x => `<div class="row">
      <button class="ghost" data-act="deliver" ${x.approved ? '' : 'disabled'}
        title="${x.approved ? T.deliver : '승인된 메일이 없습니다. STEP 6 에서 먼저 승인하세요.'}">발송 큐에 넣기 (전송 안 함)</button>
      <button class="bad" data-act="send" ${x.approved && S.smtp?.configured ? '' : 'disabled'}
        title="${!x.approved ? '승인된 메일이 없습니다. STEP 6 에서 먼저 승인하세요.'
          : !S.smtp?.configured ? '발송 계정(.env 의 GMAIL_USER · GMAIL_APP_PASSWORD)이 설정되지 않았습니다.'
          : T.send}">실제 발송</button></div>`,
};

/* ── 명함 표 ───────────────────────────────────────────────────────── */
const LEGEND = `<div class="muted" style="font-size:11px;margin-bottom:9px;display:flex;gap:14px;flex-wrap:wrap">
  ${Object.values(SRC).map(v => `<span><b style="color:${v.c}">${v.i}</b> ${esc(v.t.split(' — ')[0])}</span>`).join('')}
</div>`;

/* 리서치 근거 칸 — 왜 비었는지를 반드시 말한다.
   예전에는 홈페이지를 못 읽었을 때도, AI 호출이 터졌을 때도, 아직 안 돌렸을 때도
   똑같이 "아직 안 읽음"으로 보였다. 원인이 다르면 할 일도 다르다. */
function factsCell(c) {
  const s = c.signals ?? null;
  if (s?.facts?.length) {
    return `${srcTag('ai', '홈페이지에서 AI가 추출')}<ul class="facts">${
      s.facts.map(f => `<li>${esc(f)}</li>`).join('')}</ul>`;
  }
  if (s?._error) {
    return `<span class="chk f" title="AI 호출 자체가 실패했습니다. STEP 5 의 [AI 엔진] 에서 백엔드를 확인하세요.">AI 호출 실패</span>
      <div class="muted" style="font-size:10.5px;margin-top:4px">${esc(s._error)}</div>`;
  }
  if (s?._skipped) {
    return `<span class="tag warn">건너뜀</span>
      <div class="muted" style="font-size:10.5px;margin-top:4px">${esc(s._skipped)}</div>`;
  }
  if (s && !s.facts?.length) {
    return `<span class="tag">근거 없음</span>
      <div class="muted" style="font-size:10.5px;margin-top:4px">홈페이지는 읽었지만 인용할 사실을 찾지 못했습니다.</div>`;
  }
  if (c.siteFetch && !c.siteFetch.ok) {
    return `<span class="tag bad">읽기 실패</span>
      <div class="muted" style="font-size:10.5px;margin-top:4px">${esc(c.siteFetch.reason)}</div>`;
  }
  return `<span class="muted" style="font-size:11.5px">${
    c.siteUrl ? '아직 안 읽음 — STEP 3 에서 리서치를 실행하세요' : '홈페이지 주소가 없습니다'}</span>`;
}

const cardRows = (cards, { pick = true } = {}) => !cards.length
  ? '<div class="muted" style="padding:8px 0">명함이 없습니다. 아래에서 추가하거나 STEP 1 에서 가져오세요.</div>'
  : LEGEND + `<div class="tw"><table><thead><tr>
      ${pick ? '<th style="width:34px"></th>' : ''}
      <th>담당자</th><th style="width:28%">회사 · 홈페이지</th><th>고객군 · 관심사</th><th>리서치 근거</th><th style="width:74px">관리</th>
    </tr></thead><tbody>
    ${cards.map(c => {
      const off = c.excluded || c.segmentId === 'internal';
      return `<tr class="${off ? 'off' : ''}">
      ${pick ? `<td>${off ? '' : `<input type="checkbox" class="pick" value="${c.id}" title="${T.pickOne}" ${(S.selection ?? []).includes(c.id) ? 'checked' : ''}>`}</td>` : ''}
      <td>${editing.has(c.id)
        ? `<input class="inp f-name" value="${esc(c.name)}" placeholder="이름 *"
             title="필수. 이름을 비우면 저장되지 않습니다." style="width:100%;margin-bottom:4px">
           <input class="inp f-title" value="${esc(c.title)}" placeholder="직함"
             title="직함 — 메일의 호칭에 쓰입니다." style="width:100%;margin-bottom:4px">
           <input class="inp f-email" value="${esc(c.email)}" placeholder="이메일"
             title="수신 주소. 비어 있으면 발송 단계에서 걸립니다." style="width:100%">`
        : `<b>${esc(c.name)}</b>${srcTag('raw')}
           <div class="muted" style="font-size:11.5px">${esc(c.title)}</div>
           <div class="muted" style="font-size:11px">${esc(c.email)}</div>`}</td>
      <td>${editing.has(c.id)
        ? `<input class="inp f-company" value="${esc(c.company)}" placeholder="회사"
             title="회사명 — 고객군 판정의 근거입니다. 바꾸면 다시 판정됩니다." style="width:100%;margin-bottom:4px">
           <input class="inp f-phone" value="${esc(c.phone)}" placeholder="전화"
             title="전화번호 — 문자(LMS) 발송에 쓰입니다." style="width:100%">`
        : esc(c.company)}
        <div style="margin-top:5px"><input class="site-in" data-site="${c.id}" title="${T.siteIn}"
          value="${esc(c.siteUrl || c.site)}" placeholder="홈페이지 주소 (직접 입력 가능)"></div>
        ${c.siteResolve ? `<div class="muted" style="font-size:10.5px;margin-top:4px">
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
          ? `<div class="muted" style="font-size:10.5px;margin-top:4px">${esc(c.segmentAi.reason)}</div>` : ''}
        ${c.interests?.interests?.length
          ? `<div style="margin-top:5px">${srcTag('ai', '관심사 추정')}
              <span class="muted" style="font-size:10.5px">${esc(c.interests.interests.join(' · '))}</span></div>` : ''}
        <div style="margin-top:6px"><select class="site-in" data-seg="${c.id}"
          title="${T.setSeg}" style="max-width:190px">
          <option value="unclassified"${!c.segmentId || c.segmentId === 'unclassified' ? ' selected' : ''}>— 미분류 —</option>
          ${(S.segments ?? []).map(s => `<option value="${s.id}"${c.segmentId === s.id ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}
          <option value="internal"${c.segmentId === 'internal' ? ' selected' : ''}>자사 (발송 제외)</option>
        </select></div></td>
      <td>${factsCell(c)}</td>
      <td>${editing.has(c.id)
        ? `<button class="ok xs" data-save="${c.id}" title="${T.savecard}">저장</button>
           <button class="ghost xs" data-cancel="${c.id}" style="margin-top:5px"
             title="${T.cancelcard}">취소</button>`
        : `<button class="ghost xs" data-edit="${c.id}" title="${T.editcard}">수정</button>
           <button class="ghost xs" data-ex="${c.id}" data-exv="${c.excluded ? '0' : '1'}" style="margin-top:5px"
             title="${c.excluded ? '이 명함을 다시 발송 대상 후보로 되돌립니다.' : '명함이 아닌 항목(본인 프로필 등)을 발송 대상에서 뺍니다. 데이터는 남습니다.'}">${c.excluded ? '되돌리기' : '제외'}</button>
           <button class="ghost xs" data-del="${c.id}" style="margin-top:5px;color:var(--bad)"
             title="${T.delcard}">삭제</button>`}
      </td>
    </tr>`; }).join('')}
    </tbody></table></div>`;

/** 명함 직접 추가 폼 — 표 아래에 둔다 (CRUD 의 C) */
const addCardForm = () => `
  <div class="panel">
    <div class="cap">명함 직접 추가</div>
    <div class="row" style="align-items:flex-end">
      <input class="inp" id="acName" placeholder="이름 *" style="width:110px" title="필수. 이름이 없으면 명함으로 보지 않습니다.">
      <input class="inp" id="acTitle" placeholder="직함" style="width:120px"
        title="직함 — 메일의 호칭에 쓰입니다. (예: 시설관리팀장)">
      <input class="inp" id="acCompany" placeholder="회사" style="width:170px"
        title="회사명 — 고객군 자동 판정의 근거입니다. 비우면 미분류로 들어갑니다.">
      <input class="inp" id="acEmail" placeholder="이메일" style="width:200px"
        title="수신 주소. 비어 있으면 발송 단계에서 걸립니다.">
      <input class="inp" id="acPhone" placeholder="전화" style="width:140px"
        title="전화번호 — 문자(LMS) 발송에 쓰입니다.">
      <input class="inp" id="acSite" placeholder="홈페이지" style="width:180px"
        title="회사 홈페이지 주소. 비워 두면 STEP 2 에서 이메일 도메인으로 자동 탐색합니다.">
      <button data-act="addcard" title="${T.addcard}">추가</button>
    </div>
  </div>`;

/* AI 백엔드가 못 쓰는 상태면 어느 화면에서든 먼저 알려 준다.
   리서치·분류·생성이 전부 여기에 걸려 있어서, 이걸 모르면 "그냥 안 되는" 것으로 보인다. */
function aiBanner() {
  const b = S.backend ?? {};
  if (b.name === 'none') {
    return `<div class="banner">
      <b>AI 백엔드가 없어 이 단계를 실행할 수 없습니다.</b><br>${esc(b.hint ?? '')}</div>`;
  }
  if (b.note) return `<div class="banner info">${esc(b.note)}</div>`;
  return '';
}

/* ── AI 엔진 패널 ─────────────────────────────────────────────────── */
function enginePanel() {
  const b = S.backend ?? {};
  const models = llmModels?.models ?? [];
  return `<details class="panel">
    <summary><b>AI 엔진</b> — 지금 ${esc(b.name ?? '-')} / ${esc(b.model ?? '-')}
      ${b.cloud ? '<span class="tag warn" style="margin-left:6px">외부 전송</span>'
                : '<span class="tag ok" style="margin-left:6px">이 PC 안에서 처리</span>'}</summary>
    <div class="body">
      <div class="muted" style="font-size:12.5px;margin-bottom:13px">
        명함은 개인정보라 <b>로컬 Ollama</b> 를 기본으로 둡니다. 이름에 <code>-cloud</code> 가 붙은 모델은
        ollama.com 을 거치므로 데이터가 이 PC 를 벗어납니다. 빠른 대신 그 점을 감수하는 선택입니다.
      </div>
      <div class="row" style="margin-bottom:13px">
        ${['ollama', 'claude-api', 'claude-cli'].map(n => `
          <button class="${b.name === n ? '' : 'ghost'} sm" data-llm="${n}"
            title="${n === 'ollama' ? '이 PC 의 Ollama 를 씁니다. 데이터가 밖으로 나가지 않습니다.'
              : n === 'claude-api' ? 'ANTHROPIC_API_KEY 로 Claude API 를 호출합니다. 빠르지만 외부 전송입니다.'
              : '설치된 Claude Code CLI 를 경유합니다. CLI 가 없는 서버에서는 spawn ENOENT 가 납니다.'}">${n}</button>`).join('')}
        <button class="ghost sm" data-act="llmreload" title="${T.llmreload}">모델 목록 새로고침</button>
      </div>
      ${llmModels && !llmModels.ok
        ? `<div class="banner">Ollama 에 연결하지 못했습니다 (${esc(llmModels.reason ?? '')}).
             <code>ollama serve</code> 가 떠 있는지 확인하세요.</div>`
        : models.length ? `<div class="grid2">
            ${models.map(m => `<button class="opt ${b.model === m.name ? 'on' : ''}" data-model="${esc(m.name)}"
              title="${m.cloud ? '클라우드 경유 모델 — 명함 정보가 ollama.com 으로 전송됩니다. 대신 빠릅니다.'
                : '로컬 모델 — 이 PC 안에서 처리됩니다. CPU 만 쓰면 한 건에 수 분 걸릴 수 있습니다.'}">
              <b>${m.cloud ? '☁' : '🖥'} ${esc(m.name)}</b>
              <span>${esc(m.params || '')} ${esc(m.quant || '')} ${m.ctx ? `· ctx ${m.ctx}` : ''}
                ${m.cloud ? '· <b style="color:var(--warn)">외부 전송</b>' : '· 로컬'}</span></button>`).join('')}
          </div>` : '<div class="muted" style="font-size:12.5px">[모델 목록 새로고침] 을 눌러 설치된 모델을 확인하세요.</div>'}
    </div>
  </details>`;
}

/* ── 문구 스튜디오 ─────────────────────────────────────────────────── */
function copyStudio() {
  const items = S.copy?.items ?? [];
  const kinds = S.copyKinds ?? [];
  const tones = S.copyTones ?? [];
  const g = palette?.groups ?? [];

  return `<div class="panel">
    <div class="cap">문구 스튜디오
      ${palette?.target?.company ? `<span class="tag seg">${esc(palette.target.company)} 기준</span>` : ''}
      <span class="muted" style="font-weight:400">키워드 몇 개만 고르면 광고 문구를 한 번에 여러 개 뽑아 드립니다</span></div>

    ${g.length ? g.map(gr => `
      <div class="kwgroup">
        <div class="kh">${esc(gr.label)} <em>${esc(gr.note ?? '')}</em></div>
        <div class="chips">
          ${gr.items.map(it => `<span class="chip ${pickedKw.has(it) ? 'on' : ''}" data-kw="${esc(it)}"
            title="이 키워드를 문구에 녹입니다. 여러 개 고를수록 문구가 구체적으로 바뀝니다.">${esc(it)}</span>`).join('')}
        </div>
      </div>`).join('')
      : '<div class="muted" style="font-size:12.5px;margin-bottom:12px">키워드를 불러오는 중입니다…</div>'}

    <div class="kwgroup">
      <div class="kh">톤 <em>같은 내용도 어조에 따라 반응이 갈립니다</em></div>
      <div class="chips">
        ${tones.map(t => `<span class="chip tone ${pickedTone.has(t.id) ? 'on' : ''}" data-tone="${esc(t.id)}"
          title="${esc(t.desc)}">${esc(t.label)}</span>`).join('')}
      </div>
    </div>

    <div class="row" style="margin-top:16px">
      <select id="cpCount" title="한 번에 만들 문구 개수입니다. 많을수록 오래 걸립니다.">
        <option value="18">18개</option><option value="30" selected>30개</option><option value="45">45개</option>
      </select>
      <button data-act="suggest" title="${T.suggest}">문구 추천 받기</button>
      <span class="muted" style="font-size:12px">고른 키워드 ${pickedKw.size}개 · 톤 ${pickedTone.size}개</span>
    </div>
  </div>

  ${items.length ? `<div class="panel">
    <div class="cap">추천 문구 ${items.length}개
      ${S.copy?.source === 'rule' ? '<span class="tag warn">규칙 생성 — AI 미사용</span>'
        : S.copy?.source === 'mixed' ? '<span class="tag warn">일부 규칙 생성</span>'
        : '<span class="tag ok">AI 생성</span>'}
      ${S.copy?.flagged ? `<span class="tag bad">검증 경고 ${S.copy.flagged}건 — 지어낸 숫자·과장 표현</span>` : ''}
      <span class="muted" style="font-weight:400">마음에 드는 것을 눌러 찜하세요. 찜한 문구의 어조가 메일에 반영됩니다.</span></div>
    ${kinds.map(k => {
      const list = items.filter(i => i.kind === k.id);
      if (!list.length) return '';
      return `<div class="kwgroup">
        <div class="kh">${esc(k.label)} <em>${esc(k.hint)}</em></div>
        <div class="copygrid">
          ${list.map(i => `<div class="copy ${pickedCopy.has(i.text) ? 'on' : ''}" data-copy="${esc(i.text)}">
            <div class="mk">✓</div>
            <div class="kind">${esc(i.tone || k.id)}</div>
            <div class="txt">${esc(i.text)}</div>
            <div class="why">${esc(i.why || '')}
              ${i.source === 'rule' ? '<span class="tag warn" style="font-size:9px">규칙</span>' : ''}
              ${i.risk ? `<span class="tag bad" style="font-size:9px"
                title="${esc(`검증에 걸린 문구입니다 — ${i.risk}. 그대로 쓰면 근거 없는 주장이 됩니다.`)}">⚠ ${esc(i.risk)}</span>` : ''}</div>
          </div>`).join('')}
        </div>
      </div>`;
    }).join('')}
    <div class="row" style="margin-top:14px">
      <button data-act="pickcopy" ${pickedCopy.size ? '' : 'disabled'}
        title="${T.pickcopy}">찜한 ${pickedCopy.size}개 문구로 확정</button>
      <button class="ghost sm" data-act="clearcopy" title="찜한 문구를 모두 해제합니다.">선택 해제</button>
    </div>
  </div>` : ''}`;
}

/* ── 단계별 본문 ───────────────────────────────────────────────────── */
const VIEWS = {
  ingest: () => `
    <details class="panel" open>
      <summary><b>가장 빠른 방법 — 명함 정보를 그냥 붙여넣기</b> (몇 건이면 이게 제일 빠릅니다)</summary>
      <div class="body">
        <div class="muted" style="font-size:12.5px;margin-bottom:10px">
          엑셀에서 복사한 표, 쉼표로 구분한 줄, 여러 줄로 긁은 덩어리,
          <b>한 줄로 이어 쓴 명함</b> 모두 됩니다. 이메일·전화·홈페이지는 위치가 달라도 알아서 찾아냅니다.</div>
        <textarea id="paste" class="inp" placeholder="예) 한 줄로
호은성 전무이사 에이톰엔지니어링 atom@atom-eng.co.kr 010-8247-2177

예) 엑셀에서 복사 (탭 구분)
이름	직함	회사	이메일	전화
호은성	전무이사	에이톰엔지니어링	atom@atom-eng.co.kr	010-8247-2177

예) 덩어리로
호은성
전무이사
에이톰엔지니어링
atom@atom-eng.co.kr"
          style="width:100%;min-height:160px;line-height:1.7;font-family:ui-monospace,Consolas,monospace"></textarea>
        <div class="row" style="margin-top:10px">
          <button data-act="paste" title="${T.paste}">붙여넣은 내용으로 명함 만들기</button></div>
      </div>
    </details>

    <details class="panel">
      <summary><b>명함 불러오기 전제 조건</b> — 이게 안 맞으면 0건으로 나옵니다</summary>
      <div class="body">
        <div class="tw"><table><thead><tr><th style="width:34%">조건</th><th>왜 필요한가 · 확인하는 법</th></tr></thead><tbody>
          <tr><td><b>① 리멤버에 로그인되어 있을 것</b></td>
            <td>이 프로그램은 <b>비밀번호를 다루지 않습니다.</b> 이미 로그인된 브라우저의 화면을 빌려 쓰는 방식입니다.<br>
              확인: 크롬에서 <code>card.rememberapp.co.kr</code> 접속 시 명함 목록이 바로 보이면 OK.</td></tr>
          <tr><td><b>② 명함첩에 명함이 있을 것</b></td>
            <td>리멤버 화면 상단의 <b>전체 명함 (N)</b> 숫자와 이 프로그램의 숫자가 같아야 정상입니다.</td></tr>
          <tr><td><b>③ 목록을 끝까지 스크롤할 것</b></td>
            <td>리멤버는 화면을 내릴 때마다 조금씩 불러옵니다(무한 스크롤). <b>화면에 보인 만큼만</b> 수집됩니다.</td></tr>
          <tr><td><b>④ 이 프로그램이 켜져 있을 것</b></td>
            <td>스니펫이 수집한 명함을 이 서버로 보냅니다. 서버 창을 닫지 마세요.</td></tr>
          <tr><td><b>⑤ 같은 컴퓨터에서 할 것</b></td>
            <td>스니펫은 <code>localhost</code> 로 보냅니다. 다른 PC 라면 JSON 파일로 저장 후 옮겨 올리세요.</td></tr>
        </tbody></table></div>
      </div>
    </details>

    <details class="panel">
      <summary><b>보안 — 이 프로그램이 무엇을 하고, 무엇을 하지 않는가</b></summary>
      <div class="body">
        <div class="cap">하지 않는 것</div>
        <div class="tw"><table><tbody>
          <tr><td style="width:34%"><b>비밀번호를 받지 않습니다</b></td>
            <td>리멤버·구글·네이버 비밀번호를 입력받는 화면이 아예 없습니다.</td></tr>
          <tr><td><b>비밀번호를 저장하지 않습니다</b></td>
            <td>저장하는 자격증명은 <code>.env</code> 의 Gmail <b>앱 비밀번호</b> 하나뿐이고,
              이 파일은 <code>.gitignore</code> 로 저장소에서 제외됩니다.</td></tr>
          <tr><td><b>남의 명함을 가져오지 않습니다</b></td>
            <td>수집 범위는 <b>본인 계정이 이미 화면에서 볼 수 있는 명함</b>뿐입니다.</td></tr>
        </tbody></table></div>

        <div class="cap" style="margin-top:18px">데이터가 어디로 가는가</div>
        <div class="tw"><table><thead><tr><th style="width:34%">단계</th><th>경로</th></tr></thead><tbody>
          <tr><td>수집</td><td>리멤버 페이지 안에서만 동작 → <code>localhost</code> 의 이 서버로 전송</td></tr>
          <tr><td>저장</td><td><code>data/proto-rem.db</code> (이 컴퓨터). 저장소에 커밋되지 않음</td></tr>
          <tr><td>홈페이지 리서치</td><td>대상 회사의 <b>공개 홈페이지</b>만 읽음</td></tr>
          <tr><td>메일 작성</td><td>현재 AI: <b>${esc(S.backend?.name)} / ${esc(S.backend?.model)}</b>.
            ${S.backend?.cloud
              ? '<b style="color:var(--warn)">이 설정은 이름·회사·직함이 외부로 전송됩니다.</b> STEP 5 의 [AI 엔진] 에서 로컬 모델로 바꿀 수 있습니다.'
              : '<b>로컬 모델이라 이 컴퓨터를 벗어나지 않습니다.</b>'}</td></tr>
          <tr><td>발송</td><td>Gmail SMTP. 승인한 건만, 확인 창을 거쳐서만 나갑니다</td></tr>
        </tbody></table></div>

        <div class="cap" style="margin-top:18px">알아두실 위험</div>
        <ul class="muted" style="font-size:12.5px;line-height:1.9;margin:0;padding-left:18px">
          <li><b>명함은 개인정보입니다.</b> <code>data/</code> 폴더를 메신저·메일로 공유하지 마세요.</li>
          <li><b>이 서버에는 로그인이 없습니다.</b> 인터넷에 열어 둘 때는 접근 통제를 먼저 붙여야 합니다.</li>
          <li><b>스니펫은 페이지의 네트워크 응답을 가로챕니다.</b> 붙여넣기 전에
            <a href="/collect-snippet.js" target="_blank" style="color:var(--br)">원문</a>을 확인하실 수 있습니다.</li>
          <li><b>광고성 메일은 사전 수신동의가 원칙입니다</b>(정보통신망법 제50조).
            (광고) 표기·수신거부·야간 차단은 프로그램이 처리하지만 <b>동의 확보는 사람이 해야 합니다.</b></li>
        </ul>
      </div>
    </details>

    <details class="panel">
      <summary>리멤버에서 자동으로 가져오기 (브라우저 자동화 · 내 PC 에서 실행할 때만)</summary>
      <div class="body">
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
          <input type="file" id="file" accept=".json" hidden
            title="리멤버에서 받은 cards.json 파일을 고릅니다."></div>

        <div class="cap" style="margin-top:18px">방법 ① 전용 브라우저 로그인 <span class="tag">반복 수집에 유리</span></div>
        <div class="muted" style="font-size:12.5px;margin-bottom:10px">
          전용 크롬 창이 열립니다. 한 번만 로그인해 두면 다음부터는 버튼 하나로 끝납니다.<br>
          <span style="color:var(--warn)">구글 로그인은 자동화 창에서 차단됩니다. 네이버·카카오를 쓰세요.</span></div>
        <div class="row">
          <button class="ghost sm" data-act="rlogin" title="${T.rlogin}">브라우저 열어 로그인</button>
          <button class="ghost sm" data-act="rexport" title="${T.rexport}">전부 가져오기</button>
        </div>

        <div class="cap" style="margin-top:18px">방법 ③ CDP 접속 <span class="tag">크롬 재시작 필요</span></div>
        <pre style="margin-top:0">Get-Process chrome | Stop-Process -Force
&amp; "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222</pre>
        <div class="row" style="margin-top:9px">
          <button class="ghost sm" data-act="rexportcdp" title="${T.rexportcdp}">CDP 로 가져오기</button></div>
      </div>
    </details>

    <div class="panel">
      <div class="cap">가져온 명함 · 출처 ${S.source === 'remember-export' ? '리멤버' : S.source === 'paste' ? '직접 입력' : '샘플 시드'}
        <button class="ghost xs" data-act="reset" title="${T.reset}">전체 초기화</button></div>
      ${cardRows(S.cards ?? [], { pick: false })}
    </div>
    ${addCardForm()}`,

  resolve: x => `
    <div class="panel">
      <div class="cap">보내는 회사 — 고정입니다</div>
      <div style="font-size:17px;font-weight:700;letter-spacing:-.3px">${esc(S.company?.name)}</div>
      <div class="muted" style="font-size:12.5px;margin-top:3px">
        ${esc(S.company?.tagline)} · 업력 ${S.company?.years}년 · 누적 진단 ${S.company?.projects}건<br>
        ${esc(S.company?.addr)} · ${esc(S.company?.tel)}</div>
      <div class="row" style="margin-top:12px">
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
          title="수신자 한 명당 한 통을 따로 만듭니다. 그 회사 홈페이지 근거를 인용하므로 답장률이 높지만 한 통에 1~2분 걸립니다.">
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
      <div class="muted" style="font-size:12px;margin-bottom:11px">
        찾는 순서: 명함의 URL → 이메일 도메인 → 회사명 AI 추정.
        <b>어느 경우든 실제로 접속되는 주소만</b> 채택합니다. 못 찾으면 표에서 직접 입력하세요.</div>
      ${cardRows(S.cards ?? [], { pick: false })}
    </div>`,

  enrich: x => `
    ${aiBanner()}
    ${S.warning ? `<div class="banner">${esc(S.warning)}</div>` : ''}
    <div class="panel">
      <div class="cap">리서치 현황</div>
      <div class="muted" style="font-size:12.5px">
        홈페이지 확보 <b style="color:var(--tx)">${x.site}</b>건 · 근거 확보 <b style="color:var(--tx)">${x.facts}</b>건 ·
        읽기 실패 <b style="color:var(--tx)">${(S.cards ?? []).filter(c => c.siteFetch && !c.siteFetch.ok).length}</b>건 ·
        AI 실패 <b style="color:var(--tx)">${(S.cards ?? []).filter(c => c.signals?._error).length}</b>건<br>
        근거를 못 찾은 회사는 STEP 5 에서 메일 생성이 자동으로 막힙니다 (없는 사실을 지어내지 않기 위해서입니다).
      </div>
    </div>
    ${promptPreview ? `
      <div class="panel">
        <div class="cap">AI 에게 실제로 보내는 지시문 · ${esc(promptPreview.mode ?? '')}
          ${esc(promptPreview.target ?? promptPreview.segment ?? '')}</div>
        ${promptPreview.note ? `<span class="chk f">${esc(promptPreview.note)}</span>` : ''}
        <pre style="max-height:480px">${esc(promptPreview.prompt)}</pre>
        <div class="muted" style="font-size:11.5px;margin-top:9px">
          이 지시문이 이 프로그램의 핵심입니다. 고칠 곳은
          <code>py/domain.py</code>(고객군 정의)와 <code>py/generate.py</code>(글쓰기 규칙)입니다.</div>
      </div>` : ''}
    <div class="panel">${cardRows(S.cards ?? [], { pick: false })}</div>`,

  segment: () => `
    ${aiBanner()}
    <div class="panel">
      <div class="cap">고객군을 한 번에 선택하기</div>
      <div class="row">
        ${(S.segments ?? []).map(s => {
          const n = (S.cards ?? []).filter(c => c.segmentId === s.id).length;
          return `<button class="ghost sm" data-pick="${s.id}" ${n ? '' : 'disabled'}
            title="${n ? `이 고객군 ${n}건만 발송 대상으로 한 번에 선택합니다. 기존 선택은 대체됩니다.` : '이 고객군에 해당하는 명함이 없습니다.'}">${esc(s.label)}${n ? ` (${n})` : ''}</button>`;
        }).join('')}
        <button class="ghost sm" data-pick="all" title="${T.pickAll}">전체 선택</button>
        <button class="ghost sm" data-pick="none" title="${T.pickNone}">선택 해제</button>
      </div>
    </div>
    <div class="panel">${cardRows(S.cards ?? [])}</div>`,

  generate: () => aiBanner() + enginePanel() + copyStudio() + ((S.cards ?? []).filter(c => c.message).length
    ? '<div class="cap" style="margin:22px 0 10px;font-size:12px;color:var(--tx2);font-weight:600">만들어진 초안</div>'
      + (S.cards ?? []).filter(c => c.message).map(msgCard).join('')
    : ''),

  review: () => (S.cards ?? []).filter(c => c.message).length
    ? (S.cards ?? []).filter(c => c.message).map(msgCard).join('')
    : '<div class="panel muted">검토할 메일이 없습니다. STEP 5 에서 먼저 만드세요.</div>',

  deliver: () => `
    <div class="panel">
      <div class="cap">테스트 발송 <span class="tag ${S.smtp?.dryRun ? 'warn' : 'ok'}">
        ${S.smtp?.configured ? (S.smtp.dryRun ? 'DRY_RUN — 실제로 안 나감' : '실제 발송됨') : '계정 미설정'}</span>
        <span class="muted" style="font-weight:400">파이프라인과 무관하게 한 통만 보내 봅니다</span></div>
      <div style="display:grid;gap:9px;max-width:660px">
        <label class="muted" style="font-size:11.5px">보내는 사람 (고정 — .env 의 GMAIL_USER)</label>
        <input class="inp" value="${esc(S.smtp?.user ?? '미설정')}" disabled
          title="보내는 주소는 .env 의 GMAIL_USER 로 고정됩니다. 화면에서는 바꿀 수 없습니다.">
        <label class="muted" style="font-size:11.5px">받는 사람</label>
        <input class="inp" id="tsTo" placeholder="test@example.com" value="${esc(S.smtp?.user ?? '')}"
          title="테스트 메일을 받을 주소입니다. 본인 주소를 넣어 스팸함 도착 여부까지 확인해 보세요.">
        <label class="muted" style="font-size:11.5px">제목</label>
        <input class="inp" id="tsSubject" value="테스트 발송 — 에이톰엔지니어링"
          title="(광고) 표기는 발송 시 자동으로 앞에 붙습니다.">
        <label class="muted" style="font-size:11.5px">본문</label>
        <textarea class="inp" id="tsBody" style="min-height:150px;line-height:1.8"
          title="수신거부 안내와 서명은 자동으로 뒤에 붙습니다.">안녕하세요.
㈜에이톰엔지니어링입니다. 발송 설정 확인용 테스트 메일입니다.</textarea>
      </div>
      <div class="row" style="margin-top:12px">
        <button data-act="testsend" ${S.smtp?.configured ? '' : 'disabled'}
          title="${S.smtp?.configured ? T.testsend : '.env 에 GMAIL_USER / GMAIL_APP_PASSWORD 를 먼저 넣으세요.'}">테스트 메일 보내기</button>
      </div>
    </div>

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
        승인한 메일만 나갑니다 · 밤 9시~아침 8시 발송 차단 · (광고) 표기와 수신거부 안내 자동 삽입</div>
    </div>
    <div class="panel">
      <div class="cap">발송 이력</div>
      <div class="tw"><table><thead><tr><th>담당자</th><th>회사</th><th>수신</th><th>상태</th><th>시각</th></tr></thead><tbody>
      ${(S.cards ?? []).filter(c => c.message).map(c => `<tr>
        <td>${esc(c.name)}</td><td>${esc(c.company)}</td>
        <td class="muted">${esc(c.email) || '-'}</td>
        <td><span class="tag ${c.status === 'SENT' ? 'ok' : ''}">${esc(c.status)}</span>
          ${c.deliverError ? `<div class="chk f" style="margin-top:4px">${esc(c.deliverError)}</div>` : ''}</td>
        <td class="muted">${esc(c.deliveredAt ?? c.queuedAt) || '-'}</td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">아직 없습니다.</td></tr>'}
      </tbody></table></div>
    </div>`,
};

function msgCard(c) {
  const m = c.message;
  if (m.error) {
    const why = m.error === 'insufficient-evidence' ? '홈페이지에서 인용할 사실을 찾지 못했습니다'
      : m.error === 'unclassified-segment' ? '고객군이 정해지지 않았습니다 — 미분류 대상에는 보내지 않습니다'
      : m.error;
    return `<div class="msg"><div class="to"><b style="color:var(--tx)">${esc(c.name)}</b> · ${esc(c.company)}</div>
      <span class="chk f">만들지 않음 — ${esc(why)}</span>
      <div class="muted" style="font-size:11.5px;margin-top:8px">
        STEP 2 에서 이 회사 홈페이지 주소를 넣고 STEP 3 리서치를 다시 돌리면 만들어집니다.</div></div>`;
  }
  const st = m.reviewStatus;
  return `<div class="msg ${st === 'APPROVED' ? 'approved' : ''} ${st === 'REJECTED' ? 'rejected' : ''}" data-id="${c.id}">
    <div class="to"><b style="color:var(--tx)">${esc(c.name)}</b> ${esc(c.title)} · ${esc(c.company)}
      <span class="tag seg">${esc(seg(c.segmentId)?.label ?? '-')}</span>
      <span class="tag">${esc(m.mode ?? '1:1')}</span>
      <span class="tag ${st === 'APPROVED' ? 'ok' : st === 'REJECTED' ? 'bad' : ''}">
        ${st === 'APPROVED' ? '승인됨' : st === 'REJECTED' ? '반려됨' : '검토 대기'}</span></div>
    <div class="checks">${(m.checks ?? []).map(k =>
      `<span class="chk ${k.pass ? 'p' : 'f'}">${k.pass ? '✓' : '✕'} ${esc(k.label)}</span>`).join('')}</div>
    ${m.channel === 'email' ? `<input class="f-subject" value="${esc(m.subject)}">` : ''}
    <textarea class="f-body">${esc(m.body)}</textarea>
    <div class="muted" style="font-size:11.5px;margin-bottom:10px">
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

/* ── 툴팁 ──────────────────────────────────────────────────────────────
   title 을 그대로 두면 OS 기본 툴팁이 1초쯤 뒤에 작은 글씨로 뜬다. 문장이 길어
   실제로는 읽히지 않는다. 렌더 뒤 title 을 data-tip 으로 옮겨 직접 그린다.
   aria-label 로 남겨 스크린리더·키보드 사용자도 같은 설명을 받는다. */
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
  tipTimer = setTimeout(() => showTip(el), 200);
});
document.addEventListener('mouseout', e => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) return;
  if (e.relatedTarget && el.contains(e.relatedTarget)) return;
  hideTip();
});
document.addEventListener('focusin', e => {
  const el = e.target.closest?.('[data-tip]');
  if (el) showTip(el);
});
document.addEventListener('focusout', hideTip);
document.addEventListener('click', hideTip, true);
window.addEventListener('scroll', hideTip, true);

/* ── 이벤트 ────────────────────────────────────────────────────────────
   중요: 입력값은 **누른 순간** 읽어 ctx 로 넘긴다.
   run() 이 진행 표시를 위해 먼저 render() 를 부르는데, 그때 #view 가 통째로
   다시 그려져 textarea·select 가 새것으로 바뀐다. 핸들러 안에서 읽으면
   빈 값이 잡힌다(= "붙여넣은 내용이 없습니다" 버그의 원인). */
const val = id => $(id)?.value ?? '';
const ctxNow = () => ({
  paste: val('#paste'),
  channel: val('#ch') || 'email',
  count: Number(val('#cpCount') || 30),
  to: val('#tsTo'), subject: val('#tsSubject'), body: val('#tsBody'),
  card: {
    name: val('#acName'), title: val('#acTitle'), company: val('#acCompany'),
    email: val('#acEmail'), phone: val('#acPhone'), site: val('#acSite'),
  },
});

function bind() {
  const acts = {
    ingest: () => api('/api/ingest', {}),
    reset: () => confirm('가져온 명함과 만든 메일이 모두 지워집니다. 계속할까요?')
      ? api('/api/reset', {}) : api('/api/state'),
    enrich: () => api('/api/enrich', {}),
    segment: () => api('/api/segment', {}),
    segmentai: () => api('/api/segment', { useAi: true }),
    interests: () => api('/api/interests', {}),
    source: () => api('/api/source-profile', {}),
    resolvesites: () => api('/api/resolve-sites', {}),
    deliver: () => api('/api/deliver', { confirm: false }),

    addcard: async ctx => {
      if (!ctx.card.name.trim()) { toast('이름은 반드시 넣어야 합니다.', true); return api('/api/state'); }
      return api('/api/card-add', { card: ctx.card });
    },

    llmreload: async () => {
      llmModels = await api('/api/llm-models');
      return api('/api/state');
    },

    suggest: async ctx => {
      const r = await api('/api/copy-suggest', {
        keywords: [...pickedKw], tones: [...pickedTone],
        channel: ctx.channel, count: ctx.count,
        segmentId: palette?.target?.segmentId, id: palette?.target?.id,
      });
      if (r?.copy?.error) LOG.push('warn', 'copy', `AI 실패, 규칙 폴백 — ${r.copy.error}`);
      return r;
    },
    pickcopy: async () => {
      const r = await api('/api/copy-pick', {
        segmentId: palette?.target?.segmentId, texts: [...pickedCopy],
      });
      toast(`문구 ${pickedCopy.size}개를 확정했습니다.\n[메일 만들기] 를 누르면 이 방향으로 만들어집니다.`);
      return r;
    },
    clearcopy: () => { pickedCopy.clear(); return api('/api/state'); },

    generate: async ctx => {
      let r = await api('/api/generate', { channel: ctx.channel, batch: 1, restart: true });
      let guard = 0;
      while (r?.remaining > 0 && guard++ < 300) {
        adopt(r); render(`메일 만드는 중 — ${r.remaining}건 남음`);
        r = await api('/api/generate', { channel: ctx.channel, batch: 1 });
        if (r?.error) break;
      }
      return r;
    },

    testsend: async ctx => {
      if (!ctx.to.trim()) { toast('받는 사람 주소를 넣어 주세요.', true); return api('/api/state'); }
      const r = await api('/api/test-send', { to: ctx.to, subject: ctx.subject, body: ctx.body });
      if (r.error) { toast(r.error, true); return api('/api/state'); }
      toast(`${r.ok ? '성공' : '실패'} — ${r.note}\n\n받는 사람: ${ctx.to}`, !r.ok);
      return api('/api/state');
    },

    send: async () => {
      const n = (S.cards ?? []).filter(c => c.message?.reviewStatus === 'APPROVED').length;
      if (!confirm(`승인된 ${n}건을 실제로 발송합니다.\n되돌릴 수 없습니다. 계속할까요?`)) return api('/api/state');
      const r = await api('/api/deliver', { confirm: true });
      const sent = (r.results ?? []).filter(y => y.sent).length;
      toast(`발송 ${sent}/${(r.results ?? []).length}건 성공`);
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
      toast('전용 크롬 창이 열립니다.\n그 창에서 직접 로그인해 주세요.');
      const r = await api('/api/remember-login', {});
      toast(r.ok ? '로그인 저장 완료. [전부 가져오기]를 누르세요.' : `로그인이 확인되지 않았습니다.\n\n${r.log}`, !r.ok);
      return api('/api/state');
    },
    rexport: async () => {
      const r = await api('/api/remember-export', { via: 'profile' });
      toast(r.ok ? '가져오기 완료. [명함 불러오기]를 누르세요.' : `실패\n\n${r.log}`, !r.ok);
      return api('/api/state');
    },
    rexportcdp: async () => {
      const r = await api('/api/remember-export', { via: 'cdp' });
      toast(r.ok ? '가져오기 완료. [명함 불러오기]를 누르세요.' : `실패\n\n${r.log}`, !r.ok);
      return api('/api/state');
    },

    paste: async ctx => {
      if (!ctx.paste.trim()) { toast('붙여넣은 내용이 없습니다.', true); return api('/api/state'); }
      const r = await api('/api/paste-cards', { text: ctx.paste });
      if (r.error) { toast(r.error, true); return api('/api/state'); }
      const how = { table: '표 형식', oneline: '한 줄', freeform: '덩어리 텍스트' }[r.parsedAs] ?? r.parsedAs;
      toast(`명함 ${(r.cards ?? []).length}건을 만들었습니다. (${how}으로 인식)`);
      return r;
    },
    copysnippet: async () => {
      const code = await (await fetch('/collect-snippet.js')).text();
      await navigator.clipboard.writeText(code);
      toast('복사했습니다.\n\ncard.rememberapp.co.kr 에서 F12 → Console 에 붙여넣으세요.');
      return api('/api/state');
    },
  };

  document.querySelectorAll('[data-act]').forEach(b => {
    if (!b.title && BTN_HELP[b.dataset.act]) b.title = BTN_HELP[b.dataset.act];
    b.onclick = () => run(b.textContent.trim(), acts[b.dataset.act], ctxNow());
  });
  document.querySelectorAll('.step').forEach(el => {
    el.onclick = () => {
      viewStep = el.dataset.n === 'all' ? 'all' : Number(el.dataset.n);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      render();
      if (viewStep === 5 || viewStep === 'all') loadPalette();
    };
  });
  document.querySelectorAll('[data-mode]').forEach(b => {
    b.onclick = async () => { adopt(await api('/api/mode', { mode: b.dataset.mode })); render(); };
  });
  document.querySelectorAll('[data-persona]').forEach(b => {
    b.onclick = async () => { adopt(await api('/api/mode', { personaId: b.dataset.persona })); render(); };
  });
  document.querySelectorAll('[data-llm]').forEach(b => {
    b.onclick = async () => { adopt(await api('/api/llm', { name: b.dataset.llm })); render(); };
  });
  document.querySelectorAll('[data-model]').forEach(b => {
    b.onclick = async () => { adopt(await api('/api/llm', { model: b.dataset.model })); render(); };
  });
  document.querySelectorAll('[data-kw]').forEach(el => {
    el.onclick = () => {
      const k = el.dataset.kw;
      pickedKw.has(k) ? pickedKw.delete(k) : pickedKw.add(k);
      el.classList.toggle('on');
    };
  });
  document.querySelectorAll('[data-tone]').forEach(el => {
    el.onclick = () => {
      const k = el.dataset.tone;
      pickedTone.has(k) ? pickedTone.delete(k) : pickedTone.add(k);
      el.classList.toggle('on');
    };
  });
  document.querySelectorAll('[data-copy]').forEach(el => {
    el.onclick = () => {
      const k = el.dataset.copy;
      pickedCopy.has(k) ? pickedCopy.delete(k) : pickedCopy.add(k);
      el.classList.toggle('on');
      // 확정 버튼의 개수만 갱신한다 (전체 재렌더는 스크롤이 튄다)
      const btn = document.querySelector('[data-act="pickcopy"]');
      if (btn) { btn.textContent = `찜한 ${pickedCopy.size}개 문구로 확정`; btn.disabled = !pickedCopy.size; }
    };
  });
  document.querySelectorAll('[data-prompt]').forEach(b => {
    b.onclick = () => {
      const id = b.dataset.prompt;
      openPrompts.has(id) ? openPrompts.delete(id) : openPrompts.add(id);
      render();
    };
  });
  document.querySelectorAll('[data-seg]').forEach(sel => {
    sel.onchange = async () => {
      adopt(await api('/api/set-segment', { id: sel.dataset.seg, segmentId: sel.value }));
      render();
    };
  });
  document.querySelectorAll('[data-site]').forEach(inp => {
    inp.onchange = async () => {
      adopt(await api('/api/set-site', { id: inp.dataset.site, site: inp.value }));
      render();
    };
  });
  document.querySelectorAll('[data-ex]').forEach(b => {
    b.onclick = async () => {
      adopt(await api('/api/exclude', { id: b.dataset.ex, excluded: b.dataset.exv === '1' }));
      render();
    };
  });
  document.querySelectorAll('[data-edit]').forEach(b => {
    b.onclick = () => { editing.add(b.dataset.edit); render(); };
  });
  document.querySelectorAll('[data-cancel]').forEach(b => {
    b.onclick = () => { editing.delete(b.dataset.cancel); render(); };
  });
  document.querySelectorAll('[data-save]').forEach(b => {
    b.onclick = async () => {
      // 값은 렌더가 지우기 전에, 클릭 시점에 그 행에서 바로 읽는다.
      const tr = b.closest('tr');
      const v = k => tr.querySelector(`.f-${k}`)?.value ?? '';
      if (!v('name').trim()) { toast('이름은 비울 수 없습니다.', true); return; }
      editing.delete(b.dataset.save);
      adopt(await api('/api/card-update', {
        id: b.dataset.save,
        name: v('name').trim(), title: v('title').trim(), company: v('company').trim(),
        email: v('email').trim(), phone: v('phone').trim(),
      }));
      render();
    };
  });
  document.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('이 명함을 완전히 지웁니다. 되돌릴 수 없습니다. 계속할까요?')) return;
      adopt(await api('/api/card-delete', { id: b.dataset.del }));
      render();
    };
  });
  document.querySelectorAll('.pick').forEach(cb => {
    cb.onchange = async () => {
      const ids = [...document.querySelectorAll('.pick:checked')].map(y => y.value);
      adopt(await api('/api/selection', { ids }));
      render();
    };
  });
  document.querySelectorAll('[data-pick]').forEach(b => {
    b.onclick = async () => {
      const t = b.dataset.pick;
      const ids = t === 'none' ? []
        : t === 'all' ? (S.cards ?? []).filter(c => !c.excluded && c.segmentId !== 'internal').map(c => c.id)
        : (S.cards ?? []).filter(c => c.segmentId === t).map(c => c.id);
      adopt(await api('/api/selection', { ids }));
      render();
    };
  });
  document.querySelectorAll('[data-rev]').forEach(b => {
    b.onclick = async () => {
      const box = b.closest('.msg');
      adopt(await api('/api/review', {
        id: box.dataset.id, action: b.dataset.rev,
        subject: box.querySelector('.f-subject')?.value,
        body: box.querySelector('.f-body')?.value,
      }));
      render();
    };
  });

  const drop = $('#drop'), file = $('#file');
  if (drop && file) {
    drop.onclick = () => file.click();
    drop.ondragover = e => { e.preventDefault(); drop.style.borderColor = 'var(--br)'; };
    drop.ondragleave = () => { drop.style.borderColor = ''; };
    drop.ondrop = e => { e.preventDefault(); drop.style.borderColor = ''; upload(e.dataTransfer.files[0]); };
    file.onchange = () => upload(file.files[0]);
  }

  moveTitles();
}

async function upload(f) {
  if (!f) return;
  let cards;
  try { cards = JSON.parse(await f.text()); }
  catch { return toast('JSON 파일이 아닙니다.', true); }
  if (!Array.isArray(cards)) return toast('명함 목록이 아닙니다.', true);
  const r = await api('/api/upload-cards', { cards });
  if (r.error) return toast(r.error, true);
  adopt(r);
  toast(`${(r.cards ?? []).length}건 불러왔습니다.`);
  render();
}

/** 문구 스튜디오의 키워드 팔레트를 미리 받아 둔다 (LLM 호출 없음 — 즉시 온다). */
async function loadPalette() {
  const r = await api('/api/copy-keywords', {});
  if (!r?.error) { palette = r; render(); }
}

/* ── 콘솔 UI ───────────────────────────────────────────────────────── */
function initConsole() {
  const box = $('#console');
  $('#conbar').onclick = () => { box.classList.toggle('open'); LOG.paint(); };
  $('#conTools').innerHTML =
    ['info', 'ok', 'warn', 'error', 'net', 'ai', 'ui'].map(l =>
      `<span class="filt on" data-lv="${l}">${l}</span>`).join('')
    + `<button class="ghost xs" data-con="clear" style="margin-left:auto">지우기</button>
       <button class="ghost xs" data-con="copy">전체 복사</button>`;
  $('#conTools').querySelectorAll('[data-lv]').forEach(el => {
    el.onclick = () => {
      const l = el.dataset.lv;
      LOG.levels.has(l) ? LOG.levels.delete(l) : LOG.levels.add(l);
      el.classList.toggle('on');
      LOG.paint();
    };
  });
  $('#conTools').querySelector('[data-con="clear"]').onclick = async () => {
    LOG.rows = []; await fetch('/api/logs/clear', { method: 'POST' }).catch(() => {}); LOG.paint();
  };
  $('#conTools').querySelector('[data-con="copy"]').onclick = async () => {
    const txt = LOG.rows.map(r => `${r.t} [${r.level}] [${r.tag}] ${r.msg}`
      + (r.meta ? ` ${JSON.stringify(r.meta)}` : '')).join('\n');
    try { await navigator.clipboard.writeText(txt); toast('로그를 복사했습니다.'); }
    catch { toast('복사에 실패했습니다.', true); }
  };
  LOG.push('info', 'ui', '대시보드 시작');
  LOG.poll();
  setInterval(() => LOG.poll(), 2000);
}

/* ── 시작 ──────────────────────────────────────────────────────────── */
(async () => {
  initConsole();
  adopt(await api('/api/state'));
  render();
  loadPalette();
})();
