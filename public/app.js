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
/* 발송 이력에서 수신 주소를 고치는 중인 명함. 표가 다시 그려져도 유지한다. */
const editMail = new Set();
let STATS = null;           // /api/stats 결과 (통계 화면)
let lastStep = null;        // 같은 단계를 다시 그릴 때 스크롤을 지키려고 기억한다
let justActed = null;       // 방금 승인·반려한 카드. 다시 그려도 잠깐 표시가 남게 한다
let justTimer = null;

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

/** 흐름을 끊지 않는 알림. 확인 버튼을 누를 필요가 없는 것들에 쓴다. */
let toastTimer = null;
function toast2(msg, bad) {
  let el = document.getElementById('toast2');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast2';
    el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(var(--console-h, 0px) + 26px);'
      + 'z-index:300;padding:9px 16px;border-radius:99px;font-size:12.5px;font-weight:600;'
      + 'box-shadow:0 8px 24px #0009;pointer-events:none;opacity:0;transition:opacity .18s';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.background = bad ? '#231416' : '#12241c';
  el.style.color = bad ? 'var(--bad)' : 'var(--ok)';
  el.style.border = `1px solid ${bad ? '#5a2c2c' : '#2f5a44'}`;
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1600);
}

function toast(msg, bad) {
  LOG.push(bad ? 'error' : 'info', 'ui', msg);
  alert(msg);
}

/* ── 화면 테마 ────────────────────────────────────────────────────
   기본은 시스템 설정을 따른다. 사람마다 낮밤·모니터가 다르므로
   하나를 강요하지 않되, 원하면 고정할 수 있게 둔다. */
const THEMES = ['system', 'light', 'dark'];
const themeNow = () => document.documentElement.dataset.theme || 'system';
const themeLabel = () => ({ system: '시스템', light: '밝게', dark: '어둡게' })[themeNow()];

function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(themeNow()) + 1) % THEMES.length];
  if (next === 'system') {
    delete document.documentElement.dataset.theme;
    try { localStorage.removeItem('pr-theme'); } catch { /* 저장소가 막혀도 이번 세션은 바뀐다 */ }
  } else {
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('pr-theme', next); } catch { /* 위와 같음 */ }
  }
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

/** 각 단계의 상태 — 데이터로 판정한다.
    'done' 실제로 수행됨 · 'skip' 건너뛰고 지나감 · 'todo' 아직

    완료와 건너뜀을 갈라야 하는 이유:
    홈페이지를 하나도 못 읽었는데 ✓ 가 뜨면 "분석이 끝났다" 로 읽힌다.
    그 상태로 문안을 만들면 근거 없는 글이 나가는데 화면은 정상으로 보인다. */
function stepState(n, x) {
  switch (n) {
    case 1: return x.total > 0 ? 'done' : 'todo';
    case 2:
      if (x.site > 0) return 'done';
      // 대상이 있는데 홈페이지가 하나도 없으면 아직 할 일이 남은 것이다.
      return x.usable.length === 0 ? 'todo' : (x.drafted > 0 ? 'skip' : 'todo');
    case 3:
      if (x.facts > 0) return 'done';
      // 3은 선택 단계다. 근거 없이 지나갔으면 완료가 아니라 '건너뜀' 이다.
      return (x.drafted > 0 || x.selected > 0) ? 'skip' : 'todo';
    case 4: return x.selected > 0 ? 'done' : 'todo';
    case 5: return x.drafted > 0 ? 'done' : 'todo';
    case 6: return x.approved > 0 ? 'done' : 'todo';
    case 7: return x.sent > 0 ? 'done' : 'todo';
    default: return 'todo';
  }
}

/** 사이드바·다음단계 계산용 — 건너뜀도 '지나갔다'로 본다. */
function stepDone(n, x) {
  return stepState(n, x) !== 'todo';
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
    5: x.selected > 0 && x.facts === 0 && x.drafted === 0
      ? { t: '주의', m: `대상 ${x.selected}명인데 근거가 하나도 없습니다`,
          s: 'STEP 3 을 아직 하지 않았습니다. 이대로 만들면 회사 고유 내용 없이 업종 일반론으로만 쓰입니다. '
           + '먼저 STEP 3 에서 [저장된 분석으로 건너뛰기] 나 [홈페이지 새로 읽기] 를 눌러 주세요.', blocked: true }
      : x.selected === 0
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
  // 목록 한가운데서 [승인] 을 누르면 화면이 통째로 다시 그려진다.
  // 스크롤을 되돌리지 않으면 맨 위로 튀어, 방금 무엇을 눌렀는지 놓친다.
  const keepY = (lastStep === viewStep) ? window.scrollY : 0;
  try {
    draw(loading);
    lastStep = viewStep;
    if (keepY) window.scrollTo(0, keepY);
  }
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
  // 같은 정보를 화면마다 세 번씩 보여 주지 않도록, 지금 화면을 CSS 에 알린다.
  document.body.dataset.view = String(viewStep);
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

  /* 좌측 레일 — 관리자 설정 · 전체 보기 · 7단계. 어느 화면에서도 항상 그린다.
     설정을 맨 위에 둔다. API 키나 발송 모드가 안 맞으면 아래 단계가 전부 막히므로,
     먼저 확인해야 할 것이 먼저 보이는 편이 낫다. */
  $('#rail').innerHTML = `
    <div class="step ${viewStep === 'settings' ? 'active' : ''}" data-n="settings"
      style="margin-bottom:10px;border-bottom:1px solid var(--line);padding-bottom:13px"
      title="메일 계정·AI 키·발송 안전장치 같은 환경 설정을 여기서 직접 고칩니다.">
      <div class="num">⚙</div>
      <div><div class="lb">관리자 설정</div><div class="sb">메일 · AI 키 · 안전장치</div></div>
    </div>
    <div class="step ${viewStep === 'all' ? 'active' : ''}" data-n="all"
      title="7단계를 한 화면에 세로로 펼쳐 봅니다. 전체 흐름을 훑거나 여러 단계를 오가며 작업할 때 씁니다.">
      <div class="num">▤</div>
      <div><div class="lb">전체 보기</div><div class="sb">7단계를 한 화면에</div></div>
    </div>
    <div class="step ${viewStep === 'stats' ? 'active' : ''}" data-n="stats"
      style="margin-bottom:10px;border-bottom:1px solid var(--line);padding-bottom:13px"
      title="어디까지 왔고 어디서 막혔는지 숫자로 봅니다. 근거가 확인된 것인지 추정인지도 갈라 셉니다.">
      <div class="num">◧</div>
      <div><div class="lb">통계</div><div class="sb">진행률 · 막힌 지점</div></div>
    </div>` + steps.map(s => {
    const stt = stepState(s.n, x);
    const done = stt === 'done';
    const skipped = stt === 'skip';
    const isNext = stt === 'todo' && steps.filter(y => y.n < s.n).every(y => stepDone(y.n, x));
    return `
    <div class="step ${viewStep === s.n ? 'active' : ''} ${done ? 'done' : ''} ${isNext ? 'ready' : ''}" data-n="${s.n}"
      title="${skipped ? '건너뛰고 지나갔습니다 — 이 단계를 실제로 수행하지는 않았습니다. '
        : done ? '끝난 단계입니다. 다시 눌러 결과를 확인하거나 고칠 수 있습니다. '
        : isNext ? '지금 할 차례입니다. ' : ''}${esc(s.desc || SHORT[s.id] || '')}">
      <div class="num" ${skipped ? 'style="border-color:var(--warn-line);background:var(--warn-bg);color:var(--warn)"' : ''}>
        ${done ? '✓' : skipped ? '⤼' : s.n}</div>
      <div>
        <div class="lb">${esc(s.label)}
          ${s.hitl ? '<span class="hitl">HUMAN</span>' : ''}
          ${s.optional ? '<span class="hitl" style="background:#16233a;border-color:#26406b;color:#9dc0ff">선택</span>' : ''}
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
    <dt>메일</dt><dd title="${esc(S.smtp?.redirectTo
        ? `테스트 수신 주소로만 나갑니다 — ${S.smtp.redirectTo}. 고객에게는 한 통도 가지 않습니다. 실전 전에 ⚙ 설정에서 비우세요.`
        : S.smtp?.dryRun ? '연습모드(DRY_RUN=1) — 보내는 척만 하고 실제로는 나가지 않습니다.'
        : S.smtp?.configured ? '실제로 메일이 나갑니다.' : '.env 에 GMAIL_USER / GMAIL_APP_PASSWORD 가 없습니다.')}"
      style="color:${!S.smtp?.configured ? 'var(--tx3)' : (S.smtp.dryRun || S.smtp.redirectTo) ? 'var(--warn)' : 'var(--ok)'}">
      ${!S.smtp?.configured ? '미설정'
        : S.smtp.redirectTo ? '테스트수신' : S.smtp.dryRun ? '연습모드' : '발송가능'}</dd>
    <dt>서버</dt><dd>${esc(S.runtime === 'python' ? 'Python' : 'Node')} · SQLite</dd>
    <dt>저장</dt><dd title="${esc(S.storage?.note ?? '')}${S.storage?.stateDir ? ' · ' + esc(S.storage.stateDir) : ''}"
      style="color:${S.storage ? (S.storage.persistent ? 'var(--ok)' : 'var(--warn)') : 'var(--tx3)'}">
      ${S.storage ? (S.storage.persistent ? '영구' : '⚠ 배포시 초기화') : '-'}</dd>
    <dt>화면</dt><dd><button class="ghost xs" id="theme"
      title="${T.theme}">${themeLabel()}</button></dd>
    ${S.auth?.enabled ? `<dt>접속</dt><dd><button class="ghost xs" id="logout"
      title="${T.logout}">로그아웃</button></dd>` : ''}`;

  const th = $('#theme');
  if (th) th.onclick = () => { cycleTheme(); render(); };

  const lo = $('#logout');
  if (lo) lo.onclick = async () => { await api('/api/logout', {}); location.replace('/login.html'); };

  // 흐름도 — 어느 단계를 지나는지, 무슨 컴포넌트가 도는지 화면 위에 항상 보인다.
  const fd = document.querySelector('#flowdiag-slot');
  if (fd) fd.innerHTML = flowDiagram();

  $('#flow').innerHTML = [
    ['명함', x.total], ['대상', x.usable.length], ['홈페이지', x.site], ['근거', x.facts],
    ['선택', x.selected], ['초안', x.drafted], ['승인', x.approved], ['발송', x.sent],
  ].map(([k, v]) =>
    `<div class="cell ${v ? 'good' : 'zero'}"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');

  if (viewStep === 'stats') {
    $('#head').innerHTML = `
      <div class="eyebrow">통계</div>
      <h2>어디까지 왔나</h2>
      <div class="desc">단계마다 몇 건이 남았고 어디서 막혔는지 봅니다.
        근거가 <b>확인된 사실</b>인지 <b>추정</b>인지도 갈라 세므로, 메일을 내보내기 전에 여기서 한 번 확인하세요.</div>`;
    $('#todo').innerHTML = '';
    $('#view').innerHTML = statsView();
    bind();
    // 들어올 때마다 새로 받는다. 숫자는 낡으면 쓸모가 없다.
    loadStats().then(() => { if (viewStep === 'stats') { $('#view').innerHTML = statsView(); bind(); } });
    return;
  }

  if (viewStep === 'settings') {
    $('#head').innerHTML = `
      <div class="eyebrow">관리자 설정</div>
      <h2>환경 설정</h2>
      <div class="desc">메일 계정, AI 키, 발송 안전장치를 여기서 직접 고칩니다.
        각 항목이 업무상 무엇을 바꾸는지 함께 적어 두었습니다.</div>`;
    $('#todo').innerHTML = loading
      ? `<div class="todo"><div class="t">진행 중</div><div class="spin" style="margin-top:8px">${esc(loading)}</div>${runningJob ? `<div class="row" style="margin-top:12px"><button class="bad sm" data-jobstop="${esc(runningJob.id)}" title="지금 하던 것까지만 저장하고 멈춥니다. 남은 대상은 업종 표준값으로 채워져 다음 단계로 그대로 넘어갑니다.">■ 중지하고 표준값으로 계속</button><span class="muted" style="font-size:11.5px">중지해도 4~7단계는 정상 진행됩니다</span></div>` : ""}</div>` : '';
    $('#view').innerHTML = settingsView();
    bind();
    // 처음 들어왔을 때만 불러온다. 불러온 뒤 한 번 더 그린다.
    if (!SETTINGS) loadSettings().then(() => render());
    return;
  }

  if (viewStep === 'all') {
    $('#head').innerHTML = `
      <div class="eyebrow">전체 흐름</div>
      <h2>7단계를 한 화면에</h2>
      <div class="desc">명함 수집부터 발송까지 전부 펼쳐 놓았습니다. 위에서부터 순서대로 내려가시면 됩니다.</div>`;
    $('#todo').innerHTML = loading
      ? `<div class="todo"><div class="t">진행 중</div><div class="spin" style="margin-top:8px">${esc(loading)}</div>${runningJob ? `<div class="row" style="margin-top:12px"><button class="bad sm" data-jobstop="${esc(runningJob.id)}" title="지금 하던 것까지만 저장하고 멈춥니다. 남은 대상은 업종 표준값으로 채워져 다음 단계로 그대로 넘어갑니다.">■ 중지하고 표준값으로 계속</button><span class="muted" style="font-size:11.5px">중지해도 4~7단계는 정상 진행됩니다</span></div>` : ""}</div>` : '';
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
    ? `<div class="todo"><div class="t">진행 중</div><div class="spin" style="margin-top:8px">${esc(loading)}</div>${runningJob ? `<div class="row" style="margin-top:12px"><button class="bad sm" data-jobstop="${esc(runningJob.id)}" title="지금 하던 것까지만 저장하고 멈춥니다. 남은 대상은 업종 표준값으로 채워져 다음 단계로 그대로 넘어갑니다.">■ 중지하고 표준값으로 계속</button><span class="muted" style="font-size:11.5px">중지해도 4~7단계는 정상 진행됩니다</span></div>` : ""}</div>`
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
  topcard: '이 명함을 목록 맨 위로 올립니다. 순서는 저장돼 다음에 열어도 그대로입니다.',
  logout: '이 브라우저의 접속을 끊고 로그인 화면으로 돌아갑니다. 공용 PC 에서는 자리를 뜨기 전에 눌러 주세요.',
  theme: '화면 밝기를 바꿉니다. 시스템 → 밝게 → 어둡게 순서로 돌아갑니다. 시스템은 OS 설정을 그대로 따릅니다.',
  dequeue: '이 건을 발송 큐에서 뺍니다. 승인 상태와 문안은 그대로 남고, [발송 큐에 넣기] 를 다시 누르면 들어갑니다.',
  dequeueAll: '큐에 올라간 건을 전부 뺍니다. 이미 발송(SENT)된 건은 건드리지 않습니다.',
  sendone: '이 한 건만 지금 바로 보냅니다. 연습모드(DRY_RUN)면 실제로 나가지 않고, 야간 차단 같은 안전장치는 그대로 걸립니다.',
  editmail: '수신 주소를 여기서 바로 고칩니다. 명함에 이메일이 없어 발송이 막힌 건을 STEP 1 로 돌아가지 않고 처리할 수 있습니다.',
  savemail: '고친 수신 주소를 저장합니다. 명함에도 함께 반영됩니다.',
  fSubject: '메일 제목입니다. 여기서 고친 뒤 [승인] 또는 [고친 내용만 저장]을 눌러야 반영됩니다. (광고) 표기는 발송 시 자동으로 붙습니다.',
  fBody: '메일 본문입니다. 여기서 고친 뒤 [승인] 또는 [고친 내용만 저장]을 눌러야 반영됩니다. 수신거부 안내와 서명은 발송 시 자동으로 붙습니다.',
  osEnv: '이 값은 프로그램을 켤 때 정해집니다(PORT·데이터 폴더 등). 여기서 고쳐도 다시 켜기 전에는 바뀌지 않아 잠가 두었습니다.',
  osOver: '호스팅 환경변수에도 값이 있지만, 여기서 정한 값이 우선합니다. 비우면 다시 환경변수 값으로 돌아갑니다.',
  osOnly: '지금은 호스팅 환경변수의 값이 쓰이고 있습니다(보안상 화면에는 보이지 않습니다). 여기에 값을 넣으면 그쪽을 덮어씁니다.',
  setSave: '고친 값을 .env 파일에 씁니다. 항목에 따라 서버를 다시 시작해야 적용되는 것도 있습니다.',
  setReveal: '가려진 비밀값(API 키·앱 비밀번호)을 화면에 그대로 보여줍니다. 화면 공유 중에는 누르지 마세요.',
  setReload: '.env 의 현재 값을 다시 읽어옵니다. 저장하지 않은 입력은 버려집니다.',
  setPending: '고쳐도 바로 반영되지 않습니다 — [변경 저장]을 눌러야 .env 에 씁니다.',
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
      <button data-act="enrich-skip"
        title="홈페이지를 다시 읽지 않습니다. 지난 실행에서 저장해 둔 분석이 있으면 그것을 쓰고, 없으면 업종 표준값으로 채웁니다. 즉시 끝납니다.">저장된 분석으로 건너뛰기</button>
      <button class="ghost" data-act="enrich" ${x.site ? '' : 'disabled'}
        title="${x.site ? T.enrich : '홈페이지 주소가 하나도 없어 실행할 수 없습니다. STEP 2 에서 먼저 확보하세요.'}">홈페이지 새로 읽기</button>
      <button class="ghost" data-act="prompt" title="${T.prompt}">AI 에게 보낼 지시문 미리보기</button></div>`,
  segment: x => {
    const cards = S.cards ?? [];
    const kept = cards.filter(c => ['manual', 'ai', 'fallback'].includes(c.segmentSource)).length;
    const unc = cards.filter(c => !c.excluded && c.segmentId === 'unclassified').length;
    const aiDone = cards.filter(c => c.segmentAi).length;
    return `<div class="row">
      <button data-act="segment"
        title="회사명 키워드로 분류합니다. 사람이 직접 고른 고객군과 AI 판단은 그대로 둡니다.">고객군 분류 (규칙)</button>
      <button class="ghost" data-act="segmentai" ${unc ? '' : 'disabled'}
        title="${unc ? `미분류 ${unc}건만 AI 에게 물어봅니다. 이미 AI 가 판단한 건은 다시 묻지 않습니다.`
          : '미분류가 없습니다. AI 에게 물어볼 것이 없습니다.'}">
        AI 로 마저 분류${unc ? ` (${unc}건)` : ''}</button>
      <button class="ghost" data-act="interests" ${x.usable.length ? '' : 'disabled'} title="${T.interests}">관심사 추정</button>
      <button class="ghost" data-act="segment-force"
        title="사람이 고른 것까지 포함해 전부 규칙으로 다시 판정합니다. 수동 지정이 사라집니다.">전부 다시 판정</button>
      ${kept ? `<span class="tag ok" title="사람이 고르거나 AI 가 판단한 결과는 규칙 분류가 덮지 않습니다">판단 ${kept}건 보호</span>` : ''}
      ${aiDone ? `<span class="tag" title="이미 AI 가 본 명함입니다. 다시 묻지 않습니다">AI 판단 ${aiDone}건</span>` : ''}
      ${x.classified ? '<span class="muted" style="font-size:12px">아래 표에서 체크박스로 대상을 고르세요</span>' : ''}</div>`;
  },
  generate: x => {
    const done = (S.cards ?? []).filter(c => (S.selection ?? []).includes(c.id) && c.message).length;
    const todo = x.selected - done;
    const approved = (S.cards ?? []).filter(c =>
      (S.selection ?? []).includes(c.id) && c.message?.reviewStatus === 'APPROVED').length;
    return `<div class="row">
      <select id="ch" title="${T.channel}">
        <option value="email">이메일</option><option value="sms">문자(LMS)</option><option value="remember">리멤버 메시지</option>
      </select>
      <button data-act="generate" ${todo > 0 ? '' : 'disabled'}
        title="${todo > 0
          ? `아직 문안이 없는 ${todo}건만 만듭니다. 이미 만든 문안은 건드리지 않습니다.`
          : '선택한 대상의 문안이 이미 다 있습니다. 다시 만들려면 오른쪽 [전부 다시 만들기] 를 쓰세요.'}">
        새로 만들 것만 (${todo > 0 ? todo : 0}건)</button>
      <button class="ghost" data-act="generate-all" ${x.selected ? '' : 'disabled'}
        title="선택한 ${x.selected}건을 전부 다시 만듭니다.${approved ? ` 승인된 ${approved}건은 보호되어 그대로 둡니다.` : ''}">
        전부 다시 만들기 (${x.selected}건)</button>
      ${done ? `<span class="tag">이미 ${done}건 있음</span>` : ''}
      ${approved ? `<span class="tag ok" title="승인된 문안은 다시 만들기에서도 덮어쓰지 않습니다">승인 ${approved}건 보호</span>` : ''}
      ${pickedCopy.size ? `<span class="tag seg">문구 ${pickedCopy.size}개 반영됨</span>` : ''}</div>`;
  },
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
  // 업종 기본값이 먼저다. facts 검사보다 앞에 둬야 한다.
  // 뒤에 두면 대체값이 "홈페이지에서 확인한 사실"로 표시돼, 그 회사에서 확인하지도 않은
  // 문장이 근거처럼 보이고 그대로 메일에 인용된다 — 이 도구가 가장 피해야 할 사고다.
  if (s?.kind === 'sector') {
    return `<span class="tag warn" title="${esc(s.note ?? '홈페이지에서 사실을 확보하지 못해 업종 일반 특성으로 대체했습니다.')}">
        ⚠ 업종 일반론 — 확인된 사실 아님</span>
      <ul class="facts" style="opacity:.75">${(s.facts ?? []).map(f => `<li>${esc(f)}</li>`).join('')}</ul>
      <div class="muted" style="font-size:10.5px">이 회사에서 확인한 내용이 아닙니다. STEP 6 검토에서 반드시 확인하세요.</div>`;
  }
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

/* ── 표 페이징 ────────────────────────────────────────────────────────
   명함이 수백 건이면 한 페이지에 다 그리는 순간 화면이 끝없이 길어지고,
   스크롤로 원하는 사람을 찾는 것도 불가능해진다. 표마다 검색·필터·페이지를 둔다.
   상태는 표 종류(key)별로 따로 기억한다 — STEP 을 오가도 보던 페이지가 유지된다. */
let focusAfterRender = null;
let runningJob = null;   // {id, label} — 진행 중 작업. 중지 버튼이 이걸 쓴다.
const tableState = {};
const ts = k => (tableState[k] ??= { page: 1, per: 25, q: '', filter: 'all' });

const FILTERS = [
  { id: 'all', label: '전체' },
  { id: 'selected', label: '발송 대상' },
  { id: 'facts', label: '근거 있음' },
  { id: 'nofacts', label: '근거 없음' },
  { id: 'nosite', label: '홈페이지 없음' },
  { id: 'unclassified', label: '미분류' },
  { id: 'excluded', label: '제외·자사' },
];

function applyFilter(cards, s) {
  const q = s.q.trim().toLowerCase();
  const sel = new Set(S.selection ?? []);
  return cards.filter(c => {
    if (q) {
      const hay = `${c.name ?? ''} ${c.company ?? ''} ${c.email ?? ''} ${c.title ?? ''} ${c.dept ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const off = c.excluded || c.segmentId === 'internal';
    switch (s.filter) {
      case 'selected': return sel.has(c.id);
      case 'facts': return Boolean(c.signals?.facts?.length);
      case 'nofacts': return !c.signals?.facts?.length;
      case 'nosite': return !(c.siteUrl || c.site);
      case 'unclassified': return !c.segmentId || c.segmentId === 'unclassified';
      case 'excluded': return off;
      default: return true;
    }
  });
}

/** 1 2 3 … 페이지 번호. 많아지면 앞뒤 몇 개만 두고 가운데를 접는다. */
function pageNumbers(cur, last) {
  if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1);
  const out = new Set([1, last, cur, cur - 1, cur + 1]);
  if (cur <= 3) [2, 3, 4].forEach(n => out.add(n));
  if (cur >= last - 2) [last - 1, last - 2, last - 3].forEach(n => out.add(n));
  const nums = [...out].filter(n => n >= 1 && n <= last).sort((a, b) => a - b);
  const withGaps = [];
  nums.forEach((n, i) => {
    if (i && n - nums[i - 1] > 1) withGaps.push('…');
    withGaps.push(n);
  });
  return withGaps;
}

function pager(key, total, s) {
  const last = Math.max(1, Math.ceil(total / s.per));
  if (s.page > last) s.page = last;
  const from = total ? (s.page - 1) * s.per + 1 : 0;
  const to = Math.min(s.page * s.per, total);
  return `<div class="row" style="margin-top:12px;justify-content:space-between">
    <span class="muted" style="font-size:11.5px">${total}건 중 ${from}–${to}</span>
    <span class="row" style="gap:4px">
      <button class="ghost xs" data-pg="${key}:${s.page - 1}" ${s.page <= 1 ? 'disabled' : ''}
        title="이전 페이지">‹</button>
      ${pageNumbers(s.page, last).map(n => n === '…'
        ? '<span class="muted" style="padding:0 3px">…</span>'
        : `<button class="${n === s.page ? '' : 'ghost'} xs" data-pg="${key}:${n}"
             title="${n}페이지로">${n}</button>`).join('')}
      <button class="ghost xs" data-pg="${key}:${s.page + 1}" ${s.page >= last ? 'disabled' : ''}
        title="다음 페이지">›</button>
    </span>
  </div>`;
}

function tableBar(key, s, shown, total) {
  return `<div class="row" style="margin-bottom:10px;gap:7px">
    <input class="inp" data-tq="${key}" value="${esc(s.q)}" placeholder="이름·회사·이메일 검색"
      style="width:220px" title="입력하는 대로 걸러집니다. 페이지는 1로 돌아갑니다.">
    <select class="inp" data-tf="${key}" title="보고 싶은 명함만 골라 봅니다.">
      ${FILTERS.map(f => `<option value="${f.id}"${s.filter === f.id ? ' selected' : ''}>${f.label}</option>`).join('')}
    </select>
    <select class="inp" data-tp="${key}" title="한 페이지에 보여줄 줄 수입니다.">
      ${[10, 25, 50, 100].map(n => `<option value="${n}"${s.per === n ? ' selected' : ''}>${n}개씩</option>`).join('')}
    </select>
    ${s.q || s.filter !== 'all'
      ? `<span class="tag seg">${shown}건 걸러짐 / 전체 ${total}건</span>
         <button class="ghost xs" data-tclear="${key}" title="검색어와 필터를 지웁니다.">해제</button>`
      : ''}
  </div>`;
}


/* ── 표 도구 — 검색 · 정렬 · 페이징 ────────────────────────────────
   명함이 수십 건을 넘으면 표가 화면을 넘어가 위쪽 버튼이 안 보이고,
   찾는 사람을 눈으로 훑게 된다. 표마다 따로 상태를 기억한다. */
const TBL = {};                        // { [key]: {page,size,q,sort,dir} }
const PAGE_SIZES = [20, 50, 100, 0];   // 0 = 전체

function tblOf(key) {
  if (!TBL[key]) TBL[key] = { page: 1, size: 20, q: '', sort: '', dir: 1 };
  return TBL[key];
}

const cmp = (a, b) => {
  const na = Number(a), nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== '' && b !== '') return na - nb;
  return String(a ?? '').localeCompare(String(b ?? ''), 'ko');
};

/**
 * @param key   표 구분자
 * @param list  원본 목록
 * @param cols  [{k, label, get}] — 정렬·검색에 쓸 열 정의
 */
function tableTools(key, list, cols, label = '건') {
  const st = tblOf(key);

  // 검색 — 정의된 열의 값을 이어붙여 훑는다
  const q = st.q.trim().toLowerCase();
  let rows = !q ? list : list.filter(r =>
    cols.map(c => String(c.get(r) ?? '')).join(' ').toLowerCase().includes(q));

  // 정렬
  if (st.sort) {
    const col = cols.find(c => c.k === st.sort);
    if (col) rows = [...rows].sort((a, b) => cmp(col.get(a), col.get(b)) * st.dir);
  }

  const total = rows.length;
  const size = st.size || total || 1;
  const pages = Math.max(1, Math.ceil(total / size));
  if (st.page > pages) st.page = pages;
  const from = (st.page - 1) * size;
  const paged = st.size ? rows.slice(from, from + size) : rows;

  const head = `<div class="row" style="margin-bottom:10px">
    <input class="inp" data-tq="${key}" value="${esc(st.q)}" placeholder="검색 — 이름·회사·이메일…"
      style="width:230px" title="정의된 열의 값을 통째로 훑습니다">
    ${st.q || st.sort ? `<button class="ghost xs" data-tclear="${key}"
      title="검색어와 정렬을 지웁니다">필터 지우기</button>` : ''}
    <span style="flex:1"></span>
    <span class="muted" style="font-size:11.5px">
      ${st.q ? `${total.toLocaleString()} / ${list.length.toLocaleString()}${label} (검색됨)`
             : `${total.toLocaleString()}${label}`}</span>
  </div>`;

  const th = (c) => {
    const on = st.sort === c.k;
    return `<th data-tsort="${key}|${c.k}" style="cursor:pointer;user-select:none;white-space:nowrap"
      title="클릭하면 이 열로 정렬합니다">${esc(c.label)}
      <span style="color:${on ? 'var(--br)' : 'var(--tx3)'};font-size:9px">
        ${on ? (st.dir > 0 ? '▲' : '▼') : '⇅'}</span></th>`;
  };

  const btn = (p, lb, on = false, dis = false) =>
    `<button class="ghost xs" data-pg="${key}" data-pgv="${p}" ${dis ? 'disabled' : ''}
      style="${on ? 'border-color:var(--br);color:#cfe0ff' : ''}">${lb}</button>`;

  const nums = [];
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || Math.abs(p - st.page) <= 2) nums.push(p);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }

  const bar = (total <= PAGE_SIZES[0] && st.size === 20) ? '' :
    `<div class="row" style="margin-top:11px;padding-top:11px;border-top:1px solid var(--line)">
      <span class="muted" style="font-size:11.5px">
        ${total ? (from + 1).toLocaleString() : 0}–${Math.min(from + paged.length, total).toLocaleString()} / ${total.toLocaleString()}${label}</span>
      <span style="flex:1"></span>
      ${btn(st.page - 1, '이전', false, st.page <= 1)}
      ${nums.map(p => p === '…'
        ? '<span class="muted" style="font-size:11px;padding:0 3px">…</span>'
        : btn(p, p, p === st.page)).join('')}
      ${btn(st.page + 1, '다음', false, st.page >= pages)}
      <select class="inp" data-pgsize="${key}" style="width:88px;font-size:11.5px;padding:4px 7px"
        title="한 쪽에 보여줄 건수">
        ${PAGE_SIZES.map(n => `<option value="${n}" ${st.size === n ? 'selected' : ''}>${n ? n + '건씩' : '전체'}</option>`).join('')}
      </select>
    </div>`;

  return { rows: paged, head, bar, th, total };
}

/** 목록을 잘라 준다. { rows, bar } — bar 는 표 아래에 붙일 HTML. */
function paginate(key, list, label = '건') {
  const st = pageOf(key);
  const total = list.length;
  const size = st.size || total || 1;
  const pages = Math.max(1, Math.ceil(total / size));
  if (st.page > pages) st.page = pages;
  const from = (st.page - 1) * size;
  const rows = st.size ? list.slice(from, from + size) : list;

  if (total <= PAGE_SIZES[0] && st.size === 20) return { rows, bar: '' };

  const btn = (p, lb, on = false, dis = false) =>
    `<button class="ghost xs" data-pg="${key}" data-pgv="${p}" ${dis ? 'disabled' : ''}
      style="${on ? 'border-color:var(--br);color:#cfe0ff' : ''}">${lb}</button>`;

  // 페이지가 많아도 버튼은 앞뒤 2개씩만 보여준다
  const nums = [];
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || Math.abs(p - st.page) <= 2) nums.push(p);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }

  return {
    rows,
    bar: `<div class="row" style="margin-top:11px;padding-top:11px;border-top:1px solid var(--line)">
      <span class="muted" style="font-size:11.5px">
        ${total.toLocaleString()}${label} 중 ${total ? (from + 1).toLocaleString() : 0}–${Math.min(from + rows.length, total).toLocaleString()}</span>
      <span style="flex:1"></span>
      ${btn(st.page - 1, '이전', false, st.page <= 1)}
      ${nums.map(p => p === '…'
        ? '<span class="muted" style="font-size:11px;padding:0 2px">…</span>'
        : btn(p, p, p === st.page)).join('')}
      ${btn(st.page + 1, '다음', false, st.page >= pages)}
      <select class="inp" data-pgsize="${key}" style="width:88px;font-size:11.5px;padding:4px 7px"
        title="한 쪽에 보여줄 건수">
        ${PAGE_SIZES.map(n => `<option value="${n}" ${st.size === n ? 'selected' : ''}>${n ? n + '건씩' : '전체'}</option>`).join('')}
      </select>
    </div>`,
  };
}

const cardRows = (cards, { pick = true, key = 'cards' } = {}) => {
  if (!cards.length) {
    return '<div class="muted" style="padding:8px 0">명함이 없습니다. 아래에서 추가하거나 STEP 1 에서 가져오세요.</div>';
  }
  const s = ts(key);
  const filtered = applyFilter(cards, s);
  const last = Math.max(1, Math.ceil(filtered.length / s.per));
  if (s.page > last) s.page = last;
  const page = filtered.slice((s.page - 1) * s.per, s.page * s.per);
  return tableBar(key, s, filtered.length, cards.length)
    + (page.length ? cardTable(page, pick) + pager(key, filtered.length, s)
      : '<div class="muted" style="padding:10px 0">조건에 맞는 명함이 없습니다.</div>');
};

const cardTable = (cards, pick) => LEGEND + `<div class="tw"><table><thead><tr>
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
            + srcTag(c.segmentSource === 'ai' ? 'ai' : c.segmentSource === 'fallback' ? 'ai' : 'calc',
                     c.segmentSource === 'ai' ? `확신도 ${c.segmentAi?.confidence ?? '-'}`
                     : c.segmentSource === 'fallback' ? '업종을 못 알아내 기본 고객군으로 대체 — 검토에서 확인하세요'
                     : '회사명 키워드로 판정')
            + (c.segmentSource === 'fallback'
                ? '<span class="tag warn" style="margin-left:5px;font-size:10px">기본값 대체</span>' : '')
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
        : `<button class="ghost xs" data-top="${c.id}" title="${T.topcard}">맨 위로</button>
           <button class="ghost xs" data-edit="${c.id}" style="margin-top:5px" title="${T.editcard}">수정</button>
           <button class="ghost xs" data-ex="${c.id}" data-exv="${c.excluded ? '0' : '1'}" style="margin-top:5px"
             title="${c.excluded ? '이 명함을 다시 발송 대상 후보로 되돌립니다.' : '명함이 아닌 항목(본인 프로필 등)을 발송 대상에서 뺍니다. 데이터는 남습니다.'}">${c.excluded ? '되돌리기' : '제외'}</button>
           <button class="ghost xs" data-del="${c.id}" style="margin-top:5px;color:var(--bad)"
             title="${T.delcard}">삭제</button>`}
      </td>
    </tr>`; }).join('')}
    </tbody></table></div>`;

/** 명함 직접 추가 — 서버의 schema.py 가 정의한 필드를 그대로 그린다.
    필드를 늘릴 때 화면 코드를 고치지 않아도 되도록 서버 정의를 따라간다. */
const AC = {};              // 입력값 (다시 그려도 살아남게 여기에 둔다)
let acOpen = false;         // 접힘 상태

function acField(f) {
  const v = AC[f.key] ?? '';
  const req = f.required ? ' <span style="color:var(--bad)">*</span>' : '';
  const tip = f.help ? esc(f.help) : '';
  const common = `data-ac="${f.key}" title="${tip}"`;

  let input;
  if (f.type === 'select') {
    input = `<select class="inp" ${common} style="width:100%">
      ${(f.options ?? []).map(o =>
        `<option value="${esc(o)}" ${String(v) === o ? 'selected' : ''}>${esc(o || '— 선택 —')}</option>`).join('')}
    </select>`;
  } else if (f.type === 'textarea') {
    input = `<textarea class="inp" ${common} rows="2" style="width:100%;resize:vertical"
      placeholder="${esc(f.placeholder ?? '')}">${esc(v)}</textarea>`;
  } else {
    input = `<input class="inp" ${common} type="${f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}"
      value="${esc(v)}" placeholder="${esc(f.placeholder ?? '')}" style="width:100%">`;
  }

  return `<label style="display:block">
    <span style="display:block;font-size:11px;color:var(--tx2);margin-bottom:4px">
      ${esc(f.label)}${req}${f.warn ? ' <span class="tag warn" style="font-size:9px">주의</span>' : ''}</span>
    ${input}
    ${f.help ? `<span style="display:block;font-size:10.5px;color:var(--tx3);margin-top:3px;line-height:1.45">${esc(f.help)}</span>` : ''}
  </label>`;
}

const GROUP_NOTE = {
  '담당자': '누구에게 보내는가. 이름과 이메일이 없으면 발송 대상이 되지 못합니다.',
  '회사': '어떤 조직인가. 회사명으로 고객군을 판정하고, 홈페이지로 근거를 뽑습니다.',
  '시설': '이 제품의 핵심입니다. 준공연도·연면적이 있으면 법정 점검 주기를 추정해 "지금 연락할 이유"를 만들 수 있습니다. 사람이 확인해 넣은 값이라 AI 추정보다 우선합니다.',
  '영업 맥락': '언제 어떻게 만났고, 보내도 되는 사이인가. 만난 계기는 첫 문장에 인용됩니다.',
};

const addCardForm = () => {
  const groups = S.cardFields ?? [];
  if (!groups.length) return '';
  const filled = Object.values(AC).filter(v => String(v ?? '').trim()).length;

  return `
  <details class="panel" ${acOpen ? 'open' : ''} id="acPanel">
    <summary><b>명함 직접 추가</b>
      <span class="muted" style="font-weight:400"> — ${groups.reduce((n, g) => n + g.fields.length, 0)}개 항목
        ${filled ? ` · 입력 ${filled}개` : ''}</span></summary>
    <div class="body">
      ${groups.map(g => `
        <div style="margin-bottom:18px">
          <div class="cap" style="margin-bottom:4px">${esc(g.group)}</div>
          <div class="muted" style="font-size:11.5px;margin-bottom:10px;line-height:1.6">${esc(GROUP_NOTE[g.group] ?? '')}</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px">
            ${g.fields.map(acField).join('')}
          </div>
        </div>`).join('')}
      <div class="row" style="border-top:1px solid var(--line);padding-top:13px">
        <button data-act="addcard" title="${T.addcard ?? '입력한 내용으로 명함을 추가합니다.'}">명함 추가</button>
        <button class="ghost" data-act="addcard-clear"
          title="이 폼에 입력한 내용만 비웁니다. 이미 추가한 명함은 지워지지 않습니다.">입력 지우기</button>
        <span class="muted" style="font-size:11.5px">이름과 회사만 있어도 추가됩니다. 나머지는 나중에 채워도 됩니다.</span>
      </div>
    </div>
  </details>`;
};

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

/* ── 관리자 설정(⚙) ─────────────────────────────────────────
   .env 를 화면에서 직접 고친다. 각 항목이 "무엇인지" 뿐 아니라
   "바꾸면 업무상 무엇이 달라지는지"를 같이 적어 둔다. */
let SETTINGS = null;        // [{key,label,group,value,secret,set,what,why}]
let settingsReveal = false;
const settingsEdits = {};   // 저장 전 임시 입력값

async function loadSettings(reveal = false) {
  const r = reveal
    ? await api('/api/settings', { reveal: true })
    : await (await fetch('/api/settings')).json();
  SETTINGS = r.items ?? [];
  settingsReveal = reveal;
  return SETTINGS;
}

/** 고친 값이 몇 건인지 화면에 반영한다.
 *
 *  일부러 render() 를 부르지 않는다. 설정 화면에서 다시 그리면 두 가지가 깨진다.
 *    ① 타이핑 중이면 입력칸이 새것으로 바뀌어 커서가 날아간다.
 *    ② 입력칸에서 버튼으로 갈 때(blur) 다시 그리면 누르려던 버튼이 사라져
 *       mouseup 이 다른 요소에 떨어지고 클릭이 통째로 씹힌다.
 *  그래서 바뀌는 곳(저장 버튼과 하단 알림 띠)만 직접 손본다. */
function syncSaveBtn() {
  const n = Object.keys(settingsEdits).length;
  document.querySelectorAll('[data-act="settings-save"]').forEach(b => {
    b.disabled = !n;
    if (!b.dataset.baseLabel) b.dataset.baseLabel = b.textContent.replace(/\s*\(\d+건\)$/, '');
    b.textContent = n ? `${b.dataset.baseLabel} (${n}건)` : b.dataset.baseLabel;
  });
  const bar = document.querySelector('#setDirtyBar');
  if (bar) bar.hidden = !n;
  const cnt = document.querySelector('#setDirtyN');
  if (cnt) cnt.textContent = `저장하지 않은 변경 ${n}건`;
}

function settingsView() {
  if (!SETTINGS) return '<div class="panel muted">설정을 불러오는 중…</div>';
  const groups = [...new Set(SETTINGS.map(i => i.group))];
  const dirty = Object.keys(settingsEdits).length;

  return `
    <div class="banner">이 화면은 <code>.env</code> 파일을 직접 고칩니다.
      <b>이 서버에는 로그인이 없습니다</b> — 사내망이나 공용 와이파이에 포트를 열어두지 마세요.
      비밀값은 가려서 표시하며, 저장하지 않은 채 화면을 옮기면 입력한 내용은 사라집니다.</div>

    <div class="panel">
      <div class="row">
        <button data-act="settings-save" ${dirty ? '' : 'disabled'}
          title="${dirty ? T.setSave : '아직 고친 값이 없습니다. 아래에서 값을 바꾸면 활성화됩니다.'}">변경 저장${dirty ? ` (${dirty}건)` : ''}</button>
        <button class="ghost" data-act="settings-reveal"
          title="${settingsReveal ? '비밀값을 다시 가립니다.' : T.setReveal}">${settingsReveal ? '비밀값 가리기' : '비밀값 보기'}</button>
        <button class="ghost" data-act="settings-reload" title="${T.setReload}">다시 불러오기</button>
        <span class="muted" style="font-size:12px">
          비워서 저장하면 그 항목을 삭제하고 기본값으로 되돌립니다.</span>
      </div>
    </div>

    <!-- 고친 값이 없을 때는 숨기기만 한다. 조건부로 넣었다 뺐다 하면 값을 고친 뒤
         저장을 누르는 순간 화면이 다시 그려져 누르던 버튼이 사라지고 클릭이 먹통이 된다. -->
    <div id="setDirtyBar" ${dirty ? '' : 'hidden'}
      style="position:sticky;bottom:calc(var(--console-h) + 12px);z-index:40;margin:0 0 14px">
      <div style="background:linear-gradient(135deg,#182240,#141b2e);border:1px solid var(--br);
        border-radius:12px;padding:13px 16px;display:flex;align-items:center;gap:12px;
        flex-wrap:wrap;box-shadow:var(--sh-lg)">
        <b style="font-size:13px" id="setDirtyN">저장하지 않은 변경 ${dirty}건</b>
        <span class="muted" style="font-size:12px">화면을 옮기면 사라집니다</span>
        <span style="flex:1"></span>
        <button data-act="settings-save" title="${T.setSave}">변경 저장</button>
        <button class="ghost" data-act="settings-reload" title="${T.setReload}">되돌리기</button>
      </div>
    </div>

    ${groups.map(g => `
      <div class="panel">
        <div class="cap">${esc(g)}</div>
        ${SETTINGS.filter(i => i.group === g).map(i => {
          const val = settingsEdits[i.key] ?? i.value ?? '';
          const isBool = i.type === 'bool';
          return `
          <div style="padding:13px 0;border-bottom:1px solid var(--line)">
            <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
              <b style="font-size:13.5px">${esc(i.label)}</b>
              <code style="font-size:10.5px;color:var(--tx3)">${esc(i.key)}</code>
              ${i.set ? '<span class="tag ok">설정됨</span>' : '<span class="tag">비어 있음</span>'}
              ${i.secret ? '<span class="tag warn">비밀값</span>' : ''}
              ${i.bootOverridden
                ? `<span class="tag warn" title="지금 돌고 있는 서버는 켤 때 받은 값을 쓰고 있습니다. 여기서 고치면 저장은 되고, 서버를 다시 켤 때 이 값이 쓰입니다.">실행 인자 우선 · 다시 켜면 적용</span>`
                : i.needsRestart
                  ? `<span class="tag" title="저장은 즉시 되지만, 이 항목은 서버를 다시 켜야 실제로 바뀝니다.">다시 켜야 적용</span>`
                  : i.overrides ? `<span class="tag seg" title="${T.osOver}">여기 값이 우선</span>`
                  : i.fromOsOnly ? `<span class="tag" title="${T.osOnly}">환경변수 값 사용 중</span>` : ''}
            </div>
            <div class="muted" style="font-size:12px;margin:5px 0 3px">${esc(i.what)}</div>
            <div style="font-size:12px;color:var(--tx2);margin-bottom:8px">${esc(i.why)}</div>
            ${isBool
              ? `<div class="row">
                   <button class="opt ${String(val) === '1' ? 'on' : ''}" style="width:auto;padding:7px 14px"
                     data-set="${i.key}" data-val="1"
                     title="${esc(i.key)} 를 1(켬)로 둡니다. ${T.setPending}">켜기 (1)</button>
                   <button class="opt ${String(val) !== '1' ? 'on' : ''}" style="width:auto;padding:7px 14px"
                     data-set="${i.key}" data-val="" ${i.locked ? 'disabled' : ''}
                     title="${i.locked ? T.osEnv : `${esc(i.key)} 를 비워 끕니다. ${T.setPending}`}">끄기</button>
                 </div>`
              : `<input class="site-in" style="max-width:520px" data-setting="${i.key}"
                   value="${esc(val)}" placeholder="${esc(i.placeholder ?? '')}"
                   ${i.locked ? 'disabled' : ''}
                   title="${i.locked ? T.osEnv
                     : i.overrides ? T.osOver
                     : i.fromOsOnly ? T.osOnly
                     : `${i.secret ? '비밀값입니다 — 화면에는 가려서 나오고 [비밀값 보기] 로만 확인됩니다. ' : ''}${T.setPending} 비워서 저장하면 이 항목을 지우고 기본값으로 되돌립니다.`}"
                   ${i.secret && !settingsReveal ? 'type="password"' : ''}>`}
          </div>`;
        }).join('')}
      </div>`).join('')}

    <div class="panel">
      <div class="cap">새 항목 직접 추가</div>
      <div class="muted" style="font-size:12px;margin-bottom:10px">
        위 목록에 없는 값을 <code>.env</code> 에 직접 넣습니다.
        이 프로그램이 모르는 이름이면 저장 뒤 <b>기타</b> 묶음에 나타납니다.
        이름은 영문 대문자·숫자·밑줄만 씁니다 (예: <code>SMTP_HOST</code>).</div>
      <div class="row">
        <input class="site-in" id="newkey" style="max-width:240px" placeholder="MY_SETTING"
          title="추가할 항목의 이름입니다. 공백이나 한글이 섞이면 파일을 다시 읽을 때 그 줄이 통째로 무시되므로 저장이 거부됩니다.">
        <input class="site-in" id="newval" style="max-width:320px" placeholder="값"
          title="넣을 값입니다. 한 줄로 적어 주세요.">
        <button data-act="settings-add" title="입력한 이름과 값을 .env 에 바로 저장합니다. 위의 [변경 저장]과 달리 이 버튼은 누르는 즉시 파일에 씁니다.">추가하고 저장</button>
      </div>
    </div>`;
}

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
      ${cardRows(S.cards ?? [], { pick: false, key: "ingest" })}
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
      ${cardRows(S.cards ?? [], { pick: false, key: "resolve" })}
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
    <div class="panel">${cardRows(S.cards ?? [], { pick: false, key: "enrich" })}</div>`,

  segment: () => {
    const cards = S.cards ?? [];
    const sel = new Set(S.selection ?? []);
    const segs = S.segments ?? [];

    const inSeg = id => cards.filter(c => c.segmentId === id);
    const unclassified = cards.filter(c => !c.excluded && c.segmentId === 'unclassified');
    const internal = cards.filter(c => c.segmentId === 'internal');
    const excluded = cards.filter(c => c.excluded);
    const classified = segs.reduce((n, s) => n + inSeg(s.id).length, 0);

    /* 고객군을 버튼 나열이 아니라 카드로 편다.
       각 칸에 몇 명이 있고 무슨 이야기를 할 고객군인지 같이 보여야
       "왜 이 사람에게 이 메일이 가는가" 를 고를 때 알 수 있다. */
    const segCard = s => {
      const list = inSeg(s.id);
      const picked = list.filter(c => sel.has(c.id)).length;
      const on = list.length && picked === list.length;
      return `
        <button class="opt ${on ? 'on' : ''}" data-pick="${s.id}" ${list.length ? '' : 'disabled'}
          style="${list.length ? '' : 'opacity:.38'}"
          title="${list.length ? `이 고객군 ${list.length}건을 발송 대상으로 선택합니다. 기존 선택은 대체됩니다.` : '해당하는 명함이 없습니다.'}">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
            <b style="margin:0;flex:1">${esc(s.label)}</b>
            <span class="tag ${picked ? 'ok' : ''}" style="font-size:10.5px">
              ${list.length ? (picked ? `${picked}/${list.length}` : `${list.length}`) : '0'}</span>
          </div>
          <span style="color:var(--tx3);font-size:11px;line-height:1.5">${esc(s.trigger)}</span>
        </button>`;
    };

    const problemRow = (title, list, why, action) => !list.length ? '' : `
      <div style="display:flex;gap:12px;align-items:flex-start;padding:11px 0;border-bottom:1px solid var(--line)">
        <span class="tag warn" style="flex:none;margin-top:1px">${esc(title)} ${list.length}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:12.5px">${list.map(c => esc(c.name)).join(', ')}</div>
          <div class="muted" style="font-size:11.5px;margin-top:3px">${why}</div>
        </div>
        ${action}
      </div>`;

    return `
    ${aiBanner()}

    <div class="panel">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <div class="cap" style="margin:0">고객군 — 칸을 누르면 그 그룹 전체가 발송 대상이 됩니다</div>
        <span style="flex:1"></span>
        <button class="ghost sm" data-pick="all" title="${T.pickAll}">발송 가능 전체</button>
        <button class="ghost sm" data-pick="none" title="${T.pickNone}">선택 해제</button>
      </div>
      <div class="grid2">${segs.map(segCard).join('')}</div>
    </div>

    ${(unclassified.length || internal.length || excluded.length) ? `
    <div class="panel">
      <div class="cap">발송 대상에서 빠진 명함 — 이유와 처리 방법</div>
      ${problemRow('미분류', unclassified,
        '회사 이름만으로는 업종을 알 수 없었습니다. AI 분류를 돌리거나, 표에서 고객군을 직접 골라 주세요.',
        '<button class="sm" data-act="segmentai" style="flex:none">AI 로 분류</button>')}
      ${problemRow('자사', internal,
        '에이톰엔지니어링 소속이라 자동으로 제외됩니다. 우리 회사에 광고를 보내지 않기 위한 규칙입니다.', '')}
      ${problemRow('제외됨', excluded,
        '사람이 직접 제외한 명함입니다. 표의 [되돌리기] 로 되살릴 수 있습니다.', '')}
    </div>` : ''}

    <div class="panel">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px">
        <div class="cap" style="margin:0">명함 ${cards.length}건 · 분류됨 ${classified}건 · 선택 ${sel.size}건</div>
        <span style="flex:1"></span>
        <span class="muted" style="font-size:11.5px">고객군은 표에서 직접 바꿀 수 있습니다</span>
      </div>
      ${cardRows(cards, { key: "segment" })}
    </div>`;
  },

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
        <input class="inp" id="tsTo" placeholder="test@example.com" value="${esc(S.smtp?.testTo ?? '')}"
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
        승인한 메일만 나갑니다 · 밤 9시~아침 8시 차단 · 수신거부 제외 · 같은 사람 30일 내 재발송 차단 · 하루 상한 · (광고) 표기 자동 삽입 <b>(모두 ⚙ 관리자 설정에서 변경)</b></div>
    </div>
    ${(() => {
      const hist = (S.cards ?? []).filter(c => c.message);
      const COLS = [
        { k: 'name', label: '담당자', get: c => c.name },
        { k: 'company', label: '회사', get: c => c.company },
        { k: 'email', label: '수신', get: c => c.email },
        { k: 'status', label: '상태', get: c => c.status },
        { k: 'when', label: '시각', get: c => c.deliveredAt ?? c.queuedAt ?? '' },
      ];
      const t = tableTools('deliver', hist, COLS);
      const cnt = {
        sent: hist.filter(c => c.status === 'SENT').length,
        queued: hist.filter(c => c.status === 'QUEUED').length,
        failed: hist.filter(c => c.status === 'SEND_FAILED' || c.deliverError).length,
        noMail: hist.filter(c => !c.email).length,
      };
      window.__delivRows = t.rows;   // 아래 map 이 쓰도록 넘긴다
      return `
    <div class="panel">
      <div style="display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-bottom:10px">
        <div class="cap" style="margin:0">발송 이력</div>
        <span class="tag ok">발송 ${cnt.sent}</span>
        <span class="tag">큐 ${cnt.queued}</span>
        ${cnt.failed ? `<span class="tag bad">실패 ${cnt.failed}</span>` : ''}
        ${cnt.noMail ? `<span class="tag warn">주소없음 ${cnt.noMail}</span>` : ''}
        <span style="flex:1"></span>
        ${cnt.queued ? `<button class="ghost xs" data-act="dequeueall"
               title="${T.dequeueAll}">큐 비우기</button>` : ''}
        <button class="ghost xs" data-act="clearhistory" ${hist.length ? '' : 'disabled'}
          title="발송 이력과 만들어진 문안을 전부 지웁니다. 명함은 남습니다. 되돌릴 수 없습니다.">이력 전체 삭제</button>
      </div>
      ${t.head}
      <div class="tw"><table><thead><tr>${COLS.map(t.th).join('')}<th style="width:84px">관리</th></tr></thead><tbody>
      ${t.rows.map(c => `<tr>
        <td>${esc(c.name)}</td><td>${esc(c.company)}</td>
        <td class="muted">${editMail.has(c.id)
          ? `<input class="inp f-mail" value="${esc(c.email)}" placeholder="이메일 주소"
               style="max-width:200px;padding:5px 8px;font-size:12px" title="${T.editmail}">
             <button class="ok xs" data-mailsave="${c.id}" style="margin-left:4px" title="${T.savemail}">저장</button>`
          : `${esc(c.email) || '<span style="color:var(--bad)">주소 없음</span>'}
             <button class="ghost xs" data-mailedit="${c.id}" style="margin-left:4px" title="${T.editmail}">수정</button>`}</td>
        <td><span class="tag ${c.status === 'SENT' ? 'ok' : ''}">${esc(c.status)}</span>
          ${c.deliverError ? `<div class="chk f" style="margin-top:4px">${esc(c.deliverError)}</div>` : ''}</td>
        <td class="muted">${esc(c.deliveredAt ?? c.queuedAt) || '-'}</td>
        <td>${(() => {
          // 행마다 버튼이 나타났다 사라지면 "왜 이 줄만 없지?" 가 된다.
          // 모든 줄에 같은 버튼을 두고, 못 누르는 줄은 그 이유를 툴팁으로 밝힌다.
          const off = c.excluded || c.segmentId === 'internal';
          const sent = c.status === 'SENT';
          const queued = c.status === 'QUEUED';
          return `
          <button class="ok xs" data-send1="${c.id}" ${off || sent ? 'disabled' : ''}
            title="${off ? '자사·제외 명함이라 어떤 경로로도 발송되지 않습니다. 표에서 [되돌리기] 하거나 고객군을 바꾸면 대상이 됩니다.'
              : sent ? '이미 발송된 건입니다. 다시 보내려면 STEP 6 에서 문안을 고쳐 다시 승인하세요.'
              : T.sendone}">즉시 발송</button>
          <button class="ghost xs" data-deq="${c.id}" ${queued ? '' : 'disabled'} style="margin-top:5px"
            title="${queued ? T.dequeue : '이 건은 큐에 올라가 있지 않아 뺄 것이 없습니다. [발송 큐에 넣기] 를 누르면 큐에 들어갑니다.'}">큐에서 빼기</button>`;
        })()}</td></tr>`).join('')
      || `<tr><td colspan="6" class="muted">${t.total === 0 && hist.length
            ? '검색 조건에 맞는 건이 없습니다.' : '아직 없습니다.'}</td></tr>`}
      </tbody></table></div>
      ${t.bar}
    </div>`;
    })()}`,
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
  const fresh = justActed === c.id;
  return `<div class="msg ${st === 'APPROVED' ? 'approved' : ''} ${st === 'REJECTED' ? 'rejected' : ''}" data-id="${c.id}"
    ${fresh ? `style="outline:2px solid ${st === 'REJECTED' ? 'var(--bad)' : 'var(--ok)'};outline-offset:2px"` : ''}>
    <div class="to"><b style="color:var(--tx)">${esc(c.name)}</b> ${esc(c.title)} · ${esc(c.company)}
      <span class="tag seg">${esc(seg(c.segmentId)?.label ?? '-')}</span>
      <span class="tag">${esc(m.mode ?? '1:1')}</span>
      <span class="tag rev-state ${st === 'APPROVED' ? 'ok' : st === 'REJECTED' ? 'bad' : ''}">
        ${st === 'APPROVED' ? '승인됨' : st === 'REJECTED' ? '반려됨' : '검토 대기'}</span></div>
    <div class="checks">${(m.checks ?? []).map(k =>
      `<span class="chk ${k.pass ? 'p' : 'f'}">${k.pass ? '✓' : '✕'} ${esc(k.label)}</span>`).join('')}</div>
    ${m.channel === 'email' ? `<input class="f-subject" value="${esc(m.subject)}" title="${T.fSubject}">` : ''}
    <textarea class="f-body" title="${T.fBody}">${esc(m.body)}</textarea>
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
  let left, top;
  // 사이드바 항목은 위/아래로 띄우면 바로 그 메뉴를 덮는다. 옆으로 비켜 세운다.
  const aside = el.closest('aside');
  if (aside) {
    // 항목의 오른쪽이 아니라 사이드바 바깥쪽을 기준으로 민다.
    // 항목 기준이면 안쪽 여백만큼 사이드바에 걸쳐 경계가 지저분해진다.
    const ar = aside.getBoundingClientRect();
    left = Math.min(ar.right + 12, innerWidth - w - 8);
    top = Math.min(Math.max(8, r.top - 4), innerHeight - h - 8);
  } else {
    left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
    top = r.top - h - 8;
    if (top < 8) top = Math.min(r.bottom + 8, innerHeight - h - 8);
  }
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
  newKey: val('#newkey').trim(), newVal: val('#newval').trim(),
  card: {
    name: val('#acName'), title: val('#acTitle'), company: val('#acCompany'),
    email: val('#acEmail'), phone: val('#acPhone'), site: val('#acSite'),
  },
});

/* ── 통계 화면 ────────────────────────────────────────────────────
   막대는 전부 '크기 비교' 하나만 나타낸다. 그래서 색을 여러 개 쓰지 않고
   한 색의 길이로만 보여 준다. 색으로 뜻을 나누기 시작하면 범례가 필요해지고,
   색각 이상에서 구분이 안 되는 문제가 따라온다.
   숫자는 막대 옆에 그대로 적어, 막대를 못 읽어도 값은 항상 읽히게 한다. */

const BAR_H = 'height:9px;border-radius:4px';

function bar(n, max, color = 'var(--br)') {
  const w = max > 0 ? Math.max(n > 0 ? 3 : 0, Math.round((n / max) * 100)) : 0;
  return `<div class="barwrap" style="background:var(--sunk);${BAR_H};overflow:hidden;min-width:60px">
    <div style="width:${w}%;background:${color};${BAR_H}"></div></div>`;
}

/** 이름 · 막대 · 숫자 한 줄. 표로 짜서 숫자 자리가 흔들리지 않게 한다. */
function barRows(rows, { color = 'var(--br)', unit = '건', note = true } = {}) {
  const max = Math.max(1, ...rows.map(r => r.n));
  // 설명을 별도 행으로 빼면 줄 수가 두 배가 되어 한눈에 안 들어온다.
  // 이름 아래에 붙여 한 항목이 한 줄로 읽히게 한다.
  return `<table style="width:100%;border-collapse:separate;border-spacing:0 2px"><tbody>
    ${rows.map(r => `<tr>
      <td style="padding:6px 14px 6px 0;vertical-align:middle;width:1%;white-space:nowrap">
        <div style="font-size:12.5px;font-weight:600;letter-spacing:-.2px">${esc(r.key)}</div>
        ${note && r.note ? `<div class="muted" style="font-size:10.5px;margin-top:1px;font-weight:400">${esc(r.note)}</div>` : ''}
      </td>
      <td style="padding:6px 0;vertical-align:middle;width:100%">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="flex:1;min-width:80px">${bar(r.n, max, r.color || color)}</div>
          <div style="white-space:nowrap;font-variant-numeric:tabular-nums;font-weight:700;font-size:13px;min-width:46px;text-align:right">${r.n}<span class="muted" style="font-weight:400;font-size:10.5px;margin-left:1px">${unit}</span></div>
        </div>
      </td>
    </tr>`).join('')}
  </tbody></table>`;
}

function tile(label, n, tone, tip) {
  const c = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)'
    : tone === 'bad' ? 'var(--bad)' : n ? 'var(--tx)' : 'var(--tx3)';
  return `<div class="panel" style="margin:0;padding:13px 15px" title="${esc(tip || label)}">
    <div style="font-size:23px;font-weight:700;letter-spacing:-.5px;line-height:1.15;color:${c};font-variant-numeric:tabular-nums">${n}</div>
    <div class="muted" style="font-size:11.5px;margin-top:2px">${esc(label)}</div></div>`;
}

function statsView() {
  if (!STATS) return '<div class="panel muted">통계를 불러오는 중…</div>';
  const t = STATS.totals || {};
  // 타일과 아래 퍼널이 다른 기준으로 세면 같은 화면에서 '초안'이 11 과 6 으로
  // 둘 다 나온다. 어느 쪽이 맞는지 알 수 없으므로 기준을 퍼널(대상 안)로 맞춘다.
  const fn = Object.fromEntries((STATS.funnel || []).map(f => [f.key, f.n]));
  const seg = STATS.segments || [];
  const maxT = Math.max(1, ...seg.map(r => r.target));

  return `
  <div class="panel">
    <div class="cap">지금 상태
      <span class="muted" style="font-weight:400">— 모두 <b>발송 대상</b> 안에서 센 수입니다</span></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:9px">
      ${tile('명함', t.cards, '', '가져온 명함 전체입니다.')}
      ${tile('발송 대상', t.usable, '', '자사·제외를 뺀 실제 후보입니다.')}
      ${tile('선택', fn['선택'] ?? t.selected, '', '사람이 고른 발송 대상입니다.')}
      ${tile('초안', fn['초안'] ?? t.drafted, '', '발송 대상 중 문안이 만들어진 건입니다.')}
      ${tile('승인', fn['승인'] ?? t.approved, (fn['승인'] ?? t.approved) ? 'ok' : '', '발송 대상 중 사람이 승인한 건. 이것만 나갑니다.')}
      ${tile('발송', fn['발송'] ?? t.sent, (fn['발송'] ?? t.sent) ? 'ok' : '', '실제로 나간 건입니다.')}
      ${tile('보류', t.held, t.held ? 'warn' : '', '근거가 없어 문안을 만들지 않은 건입니다.')}
      ${tile('반려', t.rejected, t.rejected ? 'warn' : '', '사람이 반려한 건입니다.')}
      ${tile('주소 없음', t.noEmail, t.noEmail ? 'bad' : '', '수신 이메일이 없어 발송이 막히는 건입니다. STEP 7 이력에서 [수정]으로 넣으세요.')}
      ${tile('자사·제외', (t.internal || 0) + (t.excluded || 0), '', '어떤 경로로도 발송되지 않는 명함입니다.')}
    </div>
    ${t.staleOutside ? `<div class="banner" style="margin:12px 0 0">
      대상 밖(자사·제외) 명함에 예전 문안 ${t.staleOutside}건이 남아 있습니다.
      발송되지는 않지만 발송 이력 표에 함께 보입니다.</div>` : ''}
  </div>

  <div class="panel">
    <div class="cap">단계별로 얼마나 남았나
      <span class="muted" style="font-weight:400">— 뒤로 갈수록 줄어드는 것이 정상입니다</span></div>
    ${barRows((STATS.funnel || []).map(f => ({ key: f.key, n: f.n, note: f.note })))}
  </div>

  <div class="panel">
    <div class="cap">근거가 어디서 왔나
      <span class="muted" style="font-weight:400">— 확인한 것과 추정한 것을 갈라 셉니다</span></div>
    ${barRows((STATS.evidence || []).map(e => ({
      key: e.key, n: e.n,
      color: e.key === '홈페이지 직접 분석' ? 'var(--ok)' : e.key === '근거 없음' ? 'var(--bad)' : 'var(--warn)',
      note: e.key === '홈페이지 직접 분석' ? '그 회사 홈페이지에서 실제로 읽은 사실입니다.'
        : e.key === '같은 업종 사례' ? '다른 회사에서 확인된 사실을 사례로 빌려 왔습니다. 문장에 출처가 붙습니다.'
        : e.key === '업종 표준값' ? '그 업종이면 대체로 참인 일반론입니다. 회사별 사실이 아닙니다.'
        : '인용할 사실이 없어 문안이 일반적으로 나옵니다.',
    })), { note: true })}
  </div>

  <div class="panel">
    <div class="cap">고객군별 진행</div>
    ${seg.length ? `<div class="tw"><table><thead><tr>
      <th style="width:30%">고객군</th><th>진행</th>
      <th style="text-align:right">대상</th><th style="text-align:right">근거</th>
      <th style="text-align:right">초안</th><th style="text-align:right">승인</th><th style="text-align:right">발송</th>
    </tr></thead><tbody>
      ${seg.map(r => `<tr>
        <td style="font-size:12.5px">${esc(r.label)}</td>
        <td style="min-width:120px" title="대상 ${r.target}건 중 ${r.sent}건 발송">${bar(r.target, maxT)}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${r.target}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums" class="${r.facts ? '' : 'muted'}">${r.facts}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums" class="${r.drafted ? '' : 'muted'}">${r.drafted}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums" class="${r.approved ? '' : 'muted'}">${r.approved}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums" class="${r.sent ? '' : 'muted'}">${r.sent}</td>
      </tr>`).join('')}
    </tbody></table></div>` : '<div class="muted">아직 분류된 대상이 없습니다. STEP 4 에서 고객군을 나누세요.</div>'}
  </div>

  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:13px">
    <div class="panel">
      <div class="cap">홈페이지를 어떻게 찾았나</div>
      ${(STATS.siteVia || []).length
        ? barRows(STATS.siteVia.map(v => ({ key: v.key, n: v.n })), { note: false })
        : '<div class="muted">아직 없습니다.</div>'}
    </div>
    <div class="panel">
      <div class="cap">발송 상태</div>
      ${(STATS.status || []).length
        ? barRows(STATS.status.map(v => ({
            key: v.key, n: v.n,
            color: v.key === 'SENT' ? 'var(--ok)' : v.key === 'SEND_FAILED' ? 'var(--bad)'
              : v.key === 'NO_EMAIL' ? 'var(--warn)' : 'var(--br)',
          })), { note: false })
        : '<div class="muted">아직 없습니다.</div>'}
    </div>
  </div>

  ${(STATS.errors || []).length ? `<div class="panel">
    <div class="cap">막힌 이유 <span class="muted" style="font-weight:400">— 많은 순서</span></div>
    ${barRows(STATS.errors.map(e => ({ key: e.key, n: e.n, color: 'var(--bad)' })), { note: false })}
  </div>` : ''}`;
}

async function loadStats() {
  const r = await api('/api/stats');
  if (!r?.error) STATS = r;
  return STATS;
}

function bind() {
  const acts = {
    ingest: () => api('/api/ingest', {}),
    scenario: async () => { runScenario(); return null; },
    'scenario-clear': async () => { SC.results = {}; return null; },
    'settings-reveal': async () => { await loadSettings(!settingsReveal); return null; },
    'settings-reload': async () => { Object.keys(settingsEdits).forEach(k => delete settingsEdits[k]); await loadSettings(settingsReveal); return null; },
    // 입력값은 여기서 읽지 않는다. run() 이 진행 표시를 위해 fn 보다 먼저 render() 를
    // 부르는데, 그때 #view 가 통째로 다시 그려져 입력칸이 빈 새것으로 바뀐다.
    // 그래서 누른 순간 ctxNow() 가 읽어 둔 값을 받아 쓴다.
    'settings-add': async (ctx) => {
      const key = ctx?.newKey ?? '';
      const value = ctx?.newVal ?? '';
      if (!key) { alert('추가할 항목의 이름을 넣어 주세요.'); return null; }
      if (!value) { alert(`'${key}' 에 넣을 값이 비어 있습니다. 값이 없는 항목은 만들 필요가 없습니다.`); return null; }
      const r = await api('/api/settings', { updates: { [key]: value } });
      if (r.error) { alert(r.error); return null; }
      SETTINGS = r.items ?? SETTINGS;
      alert(`${key} 를 저장했습니다.`);
      return null;
    },
    'settings-save': async () => {
      const updates = { ...settingsEdits };
      if (!Object.keys(updates).length) return null;
      const r = await api('/api/settings', { updates });
      if (r.error) { alert(r.error); return null; }
      Object.keys(settingsEdits).forEach(k => delete settingsEdits[k]);
      SETTINGS = r.items ?? SETTINGS;
      const c = r.result ?? {};
      alert([
        '저장했습니다.',
        `수정 ${(c.changed ?? []).length} · 추가 ${(c.added ?? []).length} · 삭제 ${(c.removed ?? []).length}`,
        r.needsRestart ? '' : null,
        r.needsRestart ? '⚠ PORT / TENANT_ID 는 서버를 다시 켜야 적용됩니다.' : null,
      ].filter(v => v !== null).join('\n'));
      return api('/api/state');
    },
    reset: () => confirm('가져온 명함과 만든 메일이 모두 지워집니다. 계속할까요?')
      ? api('/api/reset', {}) : api('/api/state'),
    enrich: async () => { await runJob('/api/enrich', {}, '홈페이지 리서치'); return null; },
    'enrich-skip': async () => {
      const r = await api('/api/enrich-skip', {});
      if (r.error) { toast(r.error, true); return null; }
      const k = r.skipped ?? {};
      toast('리서치를 건너뛰었습니다.\n'
        + `저장된 분석 ${k.used ?? 0}건 · 유사업종 참고 ${k.proxy ?? 0}건 · 업종 표준값 ${k.fallback ?? 0}건`);
      return r;
    },
    segment: () => api('/api/segment', {}),
    'segment-force': async () => {
      const n = (S.cards ?? []).filter(c => c.segmentSource === 'manual').length;
      if (n && !confirm(`전부 규칙으로 다시 판정합니다.
직접 고르신 고객군 ${n}건이 회사명 기준으로 덮어써집니다.

계속할까요?`)) return null;
      return api('/api/segment', { force: true });
    },
    segmentai: async () => {
      const r = await api('/api/segment', { useAi: true });
      if (r?.nothingToDo) { toast('AI 에게 물어볼 미분류 명함이 없습니다.'); return null; }
      return r;
    },
    interests: () => api('/api/interests', {}),
    source: () => api('/api/source-profile', {}),
    resolvesites: async () => { await runJob('/api/resolve-sites', {}, '홈페이지 찾는 중'); return null; },
    deliver: () => api('/api/deliver', { confirm: false }),
    dequeueall: () => api('/api/dequeue', {}),
    clearhistory: async () => {
      const n = (S.cards ?? []).filter(c => c.message).length;
      if (!confirm(`발송 이력과 만들어진 문안 ${n}건을 전부 지웁니다.
명함은 남습니다. 되돌릴 수 없습니다.

계속할까요?`)) return null;
      const r = await api('/api/clear-history', {});
      if (r.error) { toast(r.error, true); return null; }
      toast(`이력 ${r.cleared ?? n}건을 지웠습니다.`);
      return r;
    },

    addcard: async () => {
      if (!String(AC.name ?? '').trim()) { toast('이름은 반드시 필요합니다.', true); return null; }
      const r = await api('/api/card-add', { card: { ...AC } });
      if (r.error) { toast(r.error, true); return null; }
      const n = Object.keys(AC).filter(k => String(AC[k] ?? '').trim()).length;
      toast(`${AC.name} 님을 추가했습니다. (입력 ${n}개 항목)`);
      Object.keys(AC).forEach(k => delete AC[k]);
      return r;
    },
    'addcard-clear': async () => {
      Object.keys(AC).forEach(k => delete AC[k]);
      toast('입력을 지웠습니다.');
      return null;
    },

    llmreload: async () => {
      llmModels = await api('/api/llm-models');
      return api('/api/state');
    },

    suggest: async ctx => {
      // 20~30초 걸리는 AI 호출이다. 응답을 기다리면 연결이 끊겨 아무 일도 안 일어난다.
      const r = await runJob('/api/copy-suggest', {
        keywords: [...pickedKw], tones: [...pickedTone],
        channel: ctx.channel, count: ctx.count,
        segmentId: palette?.target?.segmentId, id: palette?.target?.id,
      }, '문구 뽑는 중');
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
      // 서버가 작업 번호만 주고 즉시 끝나므로, 여기서 진행률을 물어보며 기다린다.
      // 예전에는 요청 하나가 5분 넘게 붙잡혀 브라우저가 먼저 끊었다.
      const r = await runJob('/api/generate', { channel: ctx.channel }, '메일 만드는 중');
      if (r?.nothingToDo) toast('새로 만들 문안이 없습니다. 선택한 대상은 이미 다 있습니다.');
      return null;
    },

    'generate-all': async ctx => {
      const n = (S.cards ?? []).filter(c => (S.selection ?? []).includes(c.id) && c.message).length;
      if (n && !confirm(`선택한 대상의 문안을 전부 다시 만듭니다.
기존 초안 ${n}건은 새 문안으로 바뀝니다.
(승인된 건은 보호되어 그대로 둡니다)

계속할까요?`)) return null;
      await runJob('/api/generate', { channel: ctx.channel, restart: true }, '전부 다시 만드는 중');
      return null;
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
      const to = S.smtp?.redirectTo;
      const warn = to ? `\n테스트 수신 주소(${to})로만 갑니다. 고객에게는 가지 않습니다.`
        : S.smtp?.dryRun ? '\n(연습모드라 실제로는 나가지 않습니다.)'
        : '\n되돌릴 수 없습니다.';
      if (!confirm(`승인된 ${n}건을 발송합니다.${warn}\n계속할까요?`)) return api('/api/state');
      // 건당 SMTP 연결에 최대 30초가 걸린다. 응답을 붙잡고 있으면 배포 환경에서
      // 연결이 끊겨 "Failed to fetch" 가 된다. 그래서 작업으로 돌린다.
      const r = await runJob('/api/deliver', { confirm: true }, '메일 발송');
      const res = r?.results ?? [];
      const sent = res.filter(y => y.sent).length;
      toast(`발송 ${sent}/${res.length}건 성공`
        + (sent < res.length ? ` · 실패 예) ${res.find(y => !y.sent)?.note ?? ''}`.slice(0, 120) : ''),
        sent < res.length);
      return null;
    },

    prompt: async () => {
      // 자사·제외·미분류 명함은 만들 프롬프트가 없다. 그런 걸 고르면
      // 빈 응답이 와서 "아무 반응 없음" 으로 보인다. 쓸 수 있는 대상을 먼저 찾는다.
      const usable = (S.cards ?? []).filter(c =>
        !c.excluded && c.segmentId && !['internal', 'excluded', 'unclassified'].includes(c.segmentId));
      const first = usable.find(c => (S.selection ?? []).includes(c.id)) ?? usable[0];
      if (!first) {
        toast([
          '미리보기를 만들 대상이 없습니다.',
          '',
          'STEP 4 에서 고객군을 먼저 분류하세요.',
          '자사·제외·미분류 명함은 문안을 만들지 않습니다.',
        ].join('\n'), true);
        return null;
      }
      promptPreview = await api('/api/prompt-preview', {
        id: first.id, segmentId: first.segmentId, channel: 'email',
      });
      if (!promptPreview?.prompt) {
        toast(promptPreview?.note || '지시문을 만들지 못했습니다.', true);
      }
      viewStep = 3;
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
      // 'all', 'settings' 처럼 숫자가 아닌 화면도 있다.
      // Number() 를 그냥 태우면 NaN 이 되어 아무 화면도 못 찾고 클릭이 먹통이 된다.
      const n = el.dataset.n;
      viewStep = /^\d+$/.test(n) ? Number(n) : n;
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
  /* ── 표 페이징·검색·필터 ──────────────────────────────────────
     서버를 다시 부르지 않는다. 이미 받아 둔 목록을 화면에서만 나눠 보여준다. */
  document.querySelectorAll('[data-jobstop]').forEach(b => {
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = '중지하는 중…';
      // 서버는 스레드를 죽이지 않고 플래그만 세운다. 지금 처리 중인 한 건이
      // 끝나면 남은 대상을 표준값으로 채우고 작업이 'cancelled' 로 끝난다.
      const r = await api('/api/job-cancel', { id: b.dataset.jobstop });
      if (!r.ok) toast('이미 끝났거나 중지할 수 없는 작업입니다.', true);
    };
  });
  document.querySelectorAll('[data-pg]').forEach(b => {
    b.onclick = () => {
      const [key, n] = b.dataset.pg.split(':');
      ts(key).page = Math.max(1, Number(n));
      render();
      b.closest('.panel')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    };
  });
  document.querySelectorAll('[data-tq]').forEach(inp => {
    inp.oninput = () => {
      const key = inp.dataset.tq;
      const s = ts(key);
      s.q = inp.value;
      s.page = 1;                       // 걸러낸 뒤에도 5페이지에 머물면 빈 화면이 된다
      focusAfterRender = `[data-tq="${key}"]`;
      render();
    };
  });
  document.querySelectorAll('[data-tf]').forEach(sel => {
    sel.onchange = () => { const s = ts(sel.dataset.tf); s.filter = sel.value; s.page = 1; render(); };
  });
  document.querySelectorAll('[data-tp]').forEach(sel => {
    sel.onchange = () => { const s = ts(sel.dataset.tp); s.per = Number(sel.value); s.page = 1; render(); };
  });
  document.querySelectorAll('[data-tclear]').forEach(b => {
    b.onclick = () => { Object.assign(ts(b.dataset.tclear), { q: '', filter: 'all', page: 1 }); render(); };
  });

  // 검색창은 매 글자마다 화면을 다시 그리므로 포커스와 커서를 되돌려 놔야 한다.
  if (focusAfterRender) {
    const el = document.querySelector(focusAfterRender);
    focusAfterRender = null;
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }

  document.querySelectorAll('[data-seg]').forEach(sel => {
    sel.onchange = async () => {
      adopt(await api('/api/set-segment', { id: sel.dataset.seg, segmentId: sel.value }));
      render();
    };
  });
  // 명함 추가 폼 — 값은 AC 에 들고 있는다. render() 가 DOM 을 갈아엎어도 살아남는다.
  // 표 도구 — 검색·정렬·페이징. 상태는 TBL 에 두어 다시 그려도 유지된다.
  document.querySelectorAll('[data-tq]').forEach(el => {
    el.oninput = () => { const st = tblOf(el.dataset.tq); st.q = el.value; st.page = 1; render(); 
      const again = document.querySelector(`[data-tq="${el.dataset.tq}"]`);
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); } };
  });
  document.querySelectorAll('[data-tsort]').forEach(el => {
    el.onclick = () => {
      const [key, col] = el.dataset.tsort.split('|');
      const st = tblOf(key);
      if (st.sort === col) st.dir = -st.dir; else { st.sort = col; st.dir = 1; }
      render();
    };
  });
  document.querySelectorAll('[data-pg]').forEach(el => {
    el.onclick = () => { tblOf(el.dataset.pg).page = Number(el.dataset.pgv); render(); };
  });
  document.querySelectorAll('[data-pgsize]').forEach(el => {
    el.onchange = () => { const st = tblOf(el.dataset.pgsize); st.size = Number(el.value); st.page = 1; render(); };
  });
  document.querySelectorAll('[data-tclear]').forEach(el => {
    el.onclick = () => { const st = tblOf(el.dataset.tclear); st.q = ''; st.sort = ''; st.dir = 1; st.page = 1; render(); };
  });

  // 표 도구 — 검색·정렬·페이징. 상태는 TBL 에 두어 다시 그려도 유지된다.
  document.querySelectorAll('[data-tq]').forEach(el => {
    el.oninput = () => {
      const key = el.dataset.tq;
      const st = tblOf(key);
      st.q = el.value; st.page = 1;
      render();
      // 다시 그리면 입력칸이 새로 생겨 포커스가 날아간다. 커서를 되돌려 놓는다.
      const again = document.querySelector(`[data-tq="${key}"]`);
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    };
  });
  document.querySelectorAll('[data-tsort]').forEach(el => {
    el.onclick = () => {
      const [key, col] = el.dataset.tsort.split('|');
      const st = tblOf(key);
      if (st.sort === col) st.dir = -st.dir; else { st.sort = col; st.dir = 1; }
      render();
    };
  });
  document.querySelectorAll('[data-pg]').forEach(el => {
    el.onclick = () => { tblOf(el.dataset.pg).page = Number(el.dataset.pgv); render(); };
  });
  document.querySelectorAll('[data-pgsize]').forEach(el => {
    el.onchange = () => { const st = tblOf(el.dataset.pgsize); st.size = Number(el.value); st.page = 1; render(); };
  });
  document.querySelectorAll('[data-tclear]').forEach(el => {
    el.onclick = () => { const st = tblOf(el.dataset.tclear); st.q = ''; st.sort = ''; st.dir = 1; st.page = 1; render(); };
  });

  document.querySelectorAll('[data-ac]').forEach(el => {
    const k = el.dataset.ac;
    el.oninput = () => { AC[k] = el.value; };
    el.onchange = () => { AC[k] = el.value; };
  });
  const acp = document.querySelector('#acPanel');
  if (acp) acp.ontoggle = () => { acOpen = acp.open; };

  document.querySelectorAll('[data-setting]').forEach(inp => {
    // 타이핑 중에는 다시 그리지 않는다 — #view 를 새로 그리면 커서가 날아간다.
    // 대신 [변경 저장] 버튼만 손으로 켠다. 이게 없으면 값을 고쳐도 버튼이 잠긴 채라,
    // 누르려 해도 disabled 라서 아무 일도 일어나지 않는다(포커스가 그대로라 blur 도 안 난다).
    inp.oninput = () => { settingsEdits[inp.dataset.setting] = inp.value; syncSaveBtn(); };
    inp.onchange = () => { settingsEdits[inp.dataset.setting] = inp.value; syncSaveBtn(); };
  });
  document.querySelectorAll('[data-set]').forEach(b => {
    // 켜기/끄기는 눌린 쪽 표시가 바뀌어야 하므로 여기서는 다시 그린다.
    // 입력칸이 아니라 버튼이라 blur 로 클릭이 씹히는 문제가 없다.
    b.onclick = () => { settingsEdits[b.dataset.set] = b.dataset.val; render(); };
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
  document.querySelectorAll('[data-mailedit]').forEach(b => {
    b.onclick = () => { editMail.add(b.dataset.mailedit); render(); };
  });
  document.querySelectorAll('[data-mailsave]').forEach(b => {
    b.onclick = async () => {
      // 값은 렌더가 지우기 전에, 클릭 시점에 그 행에서 읽는다.
      const v = b.closest('tr')?.querySelector('.f-mail')?.value?.trim() ?? '';
      editMail.delete(b.dataset.mailsave);
      adopt(await api('/api/card-update', { id: b.dataset.mailsave, email: v }));
      render();
    };
  });
  document.querySelectorAll('[data-send1]').forEach(b => {
    b.onclick = async () => {
      const row = b.closest('tr');
      const who = row?.querySelector('td')?.textContent?.trim() ?? '이 건';
      if (!confirm(`${who} 님에게 지금 보냅니다.${S.smtp?.dryRun ? '\n(연습모드라 실제로는 나가지 않습니다.)' : '\n되돌릴 수 없습니다.'}\n계속할까요?`)) return;
      const r = await api('/api/send-one', { id: b.dataset.send1 });
      if (r.error) { toast(r.error, true); return; }
      adopt(r);
      const one = (r.results ?? [])[0] ?? {};
      toast(one.sent ? `발송 완료 — ${one.to}` : `발송 실패 — ${one.note ?? ''}`, !one.sent);
      render();
    };
  });
  document.querySelectorAll('[data-deq]').forEach(b => {
    b.onclick = async () => {
      adopt(await api('/api/dequeue', { id: b.dataset.deq }));
      render();
    };
  });
  document.querySelectorAll('[data-top]').forEach(b => {
    b.onclick = async () => {
      adopt(await api('/api/card-top', { id: b.dataset.top }));
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
      const act = b.dataset.rev;
      // 서버 왕복은 짧아도 그동안 화면이 가만히 있으면 눌린 줄 모르고 또 누른다.
      // 먼저 눈에 보이게 바꾸고, 응답이 오면 진짜 상태로 확정한다.
      box.querySelectorAll('[data-rev]').forEach(x => { x.disabled = true; });
      if (act !== 'save') {
        box.classList.toggle('approved', act === 'approve');
        box.classList.toggle('rejected', act === 'reject');
        const tag = box.querySelector('.rev-state');
        if (tag) {
          tag.textContent = act === 'approve' ? '승인됨' : '반려됨';
          tag.className = `tag ${act === 'approve' ? 'ok' : 'bad'} rev-state`;
        }
        // 상단 카운터도 같이 올려 준다. 숫자가 움직여야 반영된 것이 보인다.
        const cell = [...document.querySelectorAll('.flow .cell')]
          .find(e => e.querySelector('.k')?.textContent === (act === 'approve' ? '승인' : ''));
        const v = cell?.querySelector('.v');
        if (v) { v.textContent = String((Number(v.textContent) || 0) + 1); cell.classList.add('good'); }
      }
      box.style.transition = 'outline-color .5s';
      box.style.outline = `2px solid ${act === 'reject' ? 'var(--bad)' : 'var(--ok)'}`;
      adopt(await api('/api/review', {
        id: box.dataset.id, action: act,
        subject: box.querySelector('.f-subject')?.value,
        body: box.querySelector('.f-body')?.value,
      }));
      toast2(act === 'approve' ? '승인했습니다' : act === 'reject' ? '반려했습니다' : '고친 내용을 저장했습니다');
      STATS = null;                 // 통계로 넘어가면 새로 받도록
      justActed = box.dataset.id;   // 다시 그려도 방금 누른 카드가 어디였는지 보이게
      clearTimeout(justTimer);
      justTimer = setTimeout(() => { justActed = null; render(); }, 1800);
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
/* 좌측 상단 로고 = 홈. 어느 화면에서 헤매도 한 번에 돌아올 자리가 있어야 한다. */
function initBrand() {
  const el = document.querySelector('#brand');
  if (!el || el.dataset.ready) return;
  el.dataset.ready = '1';
  el.onclick = () => { viewStep = 'all'; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
}

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
  initBrand();
  adopt(await api('/api/state'));
  scRestore();
  render();
  initBrand();   // render 가 DOM 을 갈아엎어도 로고 클릭은 살아 있어야 한다
  loadPalette();
})();

/* ═══════════════════════════════════════════════════════════════
   시나리오 테스트 — STEP 1~7 을 순서대로 한 번에 돌린다.

   왜 클라이언트에서 도는가:
     서버가 7단계를 한 요청으로 처리하면 응답까지 수 분이 걸려
     브라우저가 먼저 끊는다(실제로 그렇게 여러 번 실패했다).
     단계마다 따로 호출하면 어디까지 갔는지 화면에 즉시 보이고,
     실패해도 그 단계에서 멈춰 원인을 그대로 보여줄 수 있다.

   안전: 7단계는 항상 dry-run(큐 적재)이다. 이 버튼으로는 실제 메일이 나가지 않는다.
   ═══════════════════════════════════════════════════════════════ */

/* 오래 걸리는 단계는 서버가 작업 번호만 주고 바로 끝난다.
   여기서 진행률을 물어보며 기다린다. 요청 하나를 5분씩 붙잡지 않으므로
   브라우저가 먼저 끊는 일이 없다. */
async function runJob(startPath, startBody, label) {
  const start = await api(startPath, startBody);
  if (start.error) throw new Error(start.error);
  if (!start.jobId) { adopt(start); return start; }   // 예전 방식(동기) 응답도 받아 준다

  runningJob = { id: start.jobId, label };
  const total = start.total ?? 0;
  try {
  for (let i = 0; i < 6000; i++) {                    // 최대 약 3시간
    await new Promise(r => setTimeout(r, 1500));
    const res = await fetch(`/api/job?id=${encodeURIComponent(start.jobId)}`);
    const j = await res.json();
    // 서버가 다시 뜨면 진행 중이던 작업 번호가 사라진다(작업 목록은 메모리에만 있다).
    // 여기서 그냥 멈추면, 이미 DB 에 저장된 결과까지 못 본 채 "실패" 로 끝난다.
    // 상태를 다시 읽어 화면을 맞추고, 성공·실패 판정은 각 단계가 데이터로 하게 둔다.
    if (j.restarted || res.status === 410) {
      LOG.push('warn', '작업', `${label} — 서버가 재시작되어 진행 상황을 잃었습니다. 저장된 결과로 이어갑니다.`);
      adopt(j);
      return j;
    }
    if (j.error) throw new Error(j.error);
    if (j.status === 'failed') throw new Error(j.error || '작업이 실패했습니다.');
    const done = j.done ?? 0;
    render(`${label} — ${done}/${total || '?'}${j.current ? ` · ${j.current}` : ''}`);
    if (j.status === 'done' || j.status === 'cancelled') {
      adopt(j);
      if (j.failed) LOG.push('warn', '작업', `${label} — ${j.failed}건 건너뜀 (기본값으로 대체)`,
                        (j.errors ?? []).slice(0, 3).join(' / '));
      if (j.status === 'cancelled') {
        LOG.push('warn', '작업', `${label} — 중지됨. 남은 건은 업종 표준값으로 채웠습니다.`, j.current ?? '');
      }
      return j;
    }
  }
  throw new Error('작업이 너무 오래 걸립니다.');
  } finally { runningJob = null; }
}

const SC = {
  running: false,
  current: null,
  results: {},          // { [n]: {status:'ok'|'fail'|'skip', msg, ms} }
  startedAt: null,
};

const SC_STEPS = [
  { n: 1, key: 'ingest',   label: '명함 수집',    comp: '붙여넣기 파서 · UPSERT · SQLite' },
  { n: 2, key: 'resolve',  label: '발신·홈페이지', comp: '명의/모드 · 이메일도메인 · AI추정 · 접속검증' },
  { n: 3, key: 'enrich',   label: '홈페이지 분석', comp: '크롤 · AI 사실추출' },
  { n: 4, key: 'segment',  label: '고객군 선택',   comp: '키워드 규칙 · AI 분류 · 대상확정' },
  { n: 5, key: 'generate', label: '문구 생성',    comp: '프롬프트 조립 · AI · 컴플라이언스 삽입' },
  { n: 6, key: 'review',   label: '검토·승인',    comp: '자동검증 6항목 · 사람 승인' },
  { n: 7, key: 'deliver',  label: '발송',        comp: '큐 적재 (dry-run)' },
];

/* 실행 기록을 DB 에 남긴다. 새로고침해도 지난 결과가 그대로 보여야 한다. */
async function scSave(status) {
  try {
    await api('/api/scenario', {
      run: { results: SC.results, startedAt: SC.startedAt,
             finishedAt: status === 'running' ? null : Date.now(), status },
    });
  } catch { /* 저장 실패가 실행을 막지는 않는다 */ }
}

/** 서버에 저장된 지난 실행 결과를 화면 상태로 되살린다. */
function scRestore() {
  const run = S?.scenarioRun;
  if (!run || SC.running) return;
  SC.results = run.results ?? {};
  SC.startedAt = run.startedAt ?? null;
  SC.finishedAt = run.finishedAt ?? null;
  SC.lastStatus = run.status ?? null;
}

function scPaint(msg) {
  render(msg);
  const el = document.querySelector('#flowdiag');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

async function runScenario() {
  if (SC.running) return;
  SC.running = true;
  SC.results = {};
  SC.startedAt = Date.now();

  const mark = (n, status, msg, ms) => { SC.results[n] = { status, msg, ms }; };
  const t = () => Date.now();

  try {
    for (const s of SC_STEPS) {
      SC.current = s.n;
      scPaint(`STEP ${s.n} · ${s.label} 실행 중`);
      const t0 = t();
      try {
        const msg = await SC_RUN[s.key]();
        mark(s.n, 'ok', msg, t() - t0);
        await scSave('running');
      } catch (e) {
        mark(s.n, 'fail', String(e.message ?? e), t() - t0);
        await scSave('failed');
        SC.current = null;
        SC.running = false;
        scPaint();
        toast(`STEP ${s.n} (${s.label}) 에서 멈췄습니다.\n\n${e.message ?? e}`, true);
        return;
      }
    }
    SC.current = null;
    SC.running = false;
    await scSave('done');
    scPaint();
    const total = ((Date.now() - SC.startedAt) / 1000).toFixed(0);
    toast(`1~7단계 전부 통과했습니다. (${total}초)\n실제 메일은 나가지 않았습니다 — 큐 적재까지만 했습니다.`);
  } finally {
    SC.running = false;
    SC.current = null;
  }
}

/** 각 단계가 실제로 하는 일. 실패하면 throw 해서 그 자리에서 멈춘다. */
const SC_RUN = {
  async ingest() {
    const r = await api('/api/ingest', {});
    if (r.error) throw new Error(r.error);
    adopt(r);
    let n = (r.cards ?? []).length;
    if (!n) {
      // 명함이 없으면 시드 샘플로라도 채워 다음 단계로 간다.
      // 여기서 멈추면 나머지 6단계를 아예 확인할 수 없다.
      LOG.push('warn', '작업', 'STEP 1 — 명함이 없어 샘플 시드로 대체합니다');
      const seed = await api('/api/ingest', { mode: 'replace' });
      if (!seed.error) { adopt(seed); n = (seed.cards ?? []).length; }
      if (!n) throw new Error('명함을 하나도 확보하지 못했습니다.');
    }
    const u = r.upsert;
    return `${n}건` + (u ? ` (추가 ${u.inserted} · 갱신 ${u.updated} · 변화없음 ${u.unchanged})` : '');
  },

  async resolve() {
    const r = await api('/api/mode', { mode: S.mode ?? '1:1', personaId: S.personaId ?? 'sales' });
    if (r.error) throw new Error(r.error);
    adopt(r);

    // 이미 홈페이지가 다 확보돼 있으면 다시 찾지 않는다.
    // 탐색은 회사당 수십 초가 걸리고, 결과가 바뀔 일도 없다.
    const before = stats();
    if (before.site >= before.usable.length && before.usable.length > 0) {
      return `${S.personaId} 명의 · ${S.mode} · 홈페이지 ${before.site}/${before.usable.length}건 (이미 확보 — 탐색 생략)`;
    }

    await runJob('/api/resolve-sites', {}, 'STEP 2 · 홈페이지 찾는 중');
    const x = stats();
    return `${S.personaId} 명의 · ${S.mode} · 홈페이지 ${x.site}/${x.usable.length}건`;
  },

  async enrich() {
    // 3단계는 선택이다. 시나리오는 빠른 경로를 기본으로 쓴다.
    // 저장된 분석이 있으면 그것을, 없으면 업종 표준값을 채우고 즉시 넘어간다.
    // 홈페이지를 새로 읽고 싶으면 화면에서 [홈페이지 새로 읽기] 를 누르면 된다.
    const before = stats();
    if (before.facts >= before.usable.length && before.usable.length > 0) {
      return `근거 ${before.facts}건 (저장된 분석 사용 — 생략)`;
    }
    const sk = await api('/api/enrich-skip', {});
    if (!sk.error) {
      adopt(sk);
      const k = sk.skipped ?? {};
      return `저장된 분석 ${k.used ?? 0}건 · 업종 표준값 ${k.fallback ?? 0}건 (선택 단계 — 건너뜀)`;
    }
    const j = await runJob('/api/enrich', {}, 'STEP 3 · 홈페이지 리서치');
    const x = stats();
    const sector = (S.cards ?? []).filter(c => c.signals?.kind === 'sector').length;
    // 근거가 0이어도 멈추지 않는다. 업종 기본값이 대신 들어가고, 검토에서 사람이 판단한다.
    return `근거 ${x.facts}건`
      + (sector ? ` · 업종 기본값 대체 ${sector}건` : '')
      + (j?.failed ? ` · 건너뜀 ${j.failed}건` : '');
  },

  async segment() {
    let r = await api('/api/segment', {});
    if (r.error) throw new Error(r.error);
    adopt(r);
    // 규칙이 놓친 건 AI 로 보강 (키가 없으면 서버가 알아서 대체 백엔드를 쓴다)
    if (stats().usable.some(c => c.segmentId === 'unclassified')) {
      r = await api('/api/segment', { useAi: true });
      if (!r.error) adopt(r);
    }
    // 그래도 미분류가 남으면 기본 고객군으로 대체한다.
    // 여기서 멈추면 5~7단계를 확인할 수 없다. 대체분은 '기본값 대체'로 표시된다.
    if (stats().usable.some(c => c.segmentId === 'unclassified')) {
      const fb = await api('/api/segment', { fallback: true, defaultSegment: 'safety' });
      if (!fb.error) { adopt(fb); LOG.push('warn', '작업', 'STEP 4 — 미분류를 기본 고객군으로 대체'); }
    }
    const ids = stats().usable
      .filter(c => c.segmentId && !['unclassified', 'internal', 'excluded'].includes(c.segmentId))
      .map(c => c.id);
    if (!ids.length) throw new Error('발송 가능한 고객군으로 분류된 명함이 없습니다.');
    r = await api('/api/selection', { ids });
    if (r.error) throw new Error(r.error);
    adopt(r);
    return `분류 ${stats().classified}건 · 대상 ${ids.length}건 확정`;
  },

  async generate() {
    // 이미 문안이 있는 대상은 다시 만들지 않는다. 반복 실행이 기존 결과를 갈아엎으면
    // 시나리오를 한 번 더 돌릴 때마다 사람이 손본 문안이 사라진다.
    await runJob('/api/generate', { channel: 'email' }, 'STEP 5 · 문구 생성');
    const x = stats();
    if (!x.drafted && !x.held) throw new Error('문안이 하나도 만들어지지 않았습니다.');
    const sector = (S.cards ?? []).filter(c => c.message?.kind === 'sector').length;
    return `초안 ${x.drafted}건`
      + (sector ? ` · 업종 기본 문안 ${sector}건` : '')
      + (x.held ? ` · 차단 ${x.held}건` : '');
  },

  async review() {
    const targets = (S.cards ?? []).filter(c => c.message && !c.message.error);
    if (!targets.length) throw new Error('검토할 문안이 없습니다.');
    for (const c of targets) {
      const r = await api('/api/review', { id: c.id, action: 'approve' });
      if (r.error) throw new Error(r.error);
      adopt(r);
    }
    return `${stats().approved}건 승인`;
  },

  async deliver() {
    // 항상 dry-run. 이 버튼으로 실제 메일이 나가면 안 된다.
    const r = await api('/api/deliver', { confirm: false });
    if (r.error) throw new Error(r.error);
    adopt(r);
    return `${stats().sent}건 큐 적재 (실제 전송 안 함)`;
  },
};

/* ── 흐름도 — 1~7 단계와 컴포넌트, 지금 어디를 지나는지 ───────────── */
function flowDiagram() {
  const x = stats();
  const stateOf = n => {
    const r = SC.results[n];
    if (SC.current === n) return 'run';
    if (r?.status === 'fail') return 'fail';
    // 지난 실행 기록보다 '지금 데이터' 를 우선한다.
    // 어제 성공했어도 명함을 새로 넣었으면 지금은 안 된 상태다.
    const now = stepState(n, x);
    if (now === 'done') return 'ok';
    if (now === 'skip') return 'skip';
    return r?.status === 'ok' ? 'stale' : 'idle';
  };

  const node = s => {
    const st = stateOf(s.n);
    const r = SC.results[s.n];
    return `
      <div class="fnode ${st}" data-n="${s.n}" title="${esc(s.comp)}">
        <div class="fn-top">
          <span class="fn-num">${st === 'ok' || st === 'done' ? '✓'
            : st === 'fail' ? '✕' : st === 'skip' ? '⤼' : st === 'stale' ? '↻' : s.n}</span>
          <span class="fn-lb">${esc(s.label)}</span>
        </div>
        <div class="fn-comp">${esc(s.comp)}</div>
        ${st === 'skip' ? '<div class="fn-msg" style="color:var(--warn)">건너뜀 — 수행하지 않았습니다</div>' : ''}
        ${st === 'stale' ? '<div class="fn-msg" style="color:var(--tx3)">지난 실행 기록 · 지금 데이터로는 미완료</div>' : ''}
        ${r ? `<div class="fn-msg">${esc(r.msg)}${r.ms ? ` · ${(r.ms / 1000).toFixed(1)}s` : ''}</div>` : ''}
      </div>`;
  };

  return `
    <div class="panel" id="flowdiag" style="padding:16px 18px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <div class="cap" style="margin:0">처리 흐름 — 1~7단계가 지나가는 순서</div>
        <button class="sm" data-act="scenario" ${SC.running ? 'disabled' : ''}
          title="STEP 1부터 7까지 순서대로 자동 실행합니다. 어디서 막히는지 바로 보입니다. 실제 메일은 나가지 않습니다(큐 적재까지만).">
          ${SC.running ? '실행 중…' : '시나리오 테스트 (1~7 한 번에)'}</button>
        ${Object.keys(SC.results).length && !SC.running
          ? `<button class="ghost sm" data-act="scenario-clear"
               title="화면에 남은 지난 실행 기록만 지웁니다. 명함·문안·발송 이력은 그대로입니다.">결과 지우기</button>` : ''}
        <span class="muted" style="font-size:11.5px">실제 발송은 하지 않습니다 — 7단계는 큐 적재까지만</span>
        ${S.scenarioRun?.finishedAt && !SC.running ? `
          <span class="tag ${S.scenarioRun.status === 'done' ? 'ok' : 'bad'}" style="margin-left:auto"
            title="새로고침해도 지난 실행 결과는 그대로 남아 있습니다 (파일 DB 저장)">
            지난 실행 ${new Date(S.scenarioRun.finishedAt).toLocaleString('ko-KR',
              { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            · ${S.scenarioRun.status === 'done' ? '전 구간 통과' : '중단됨'}</span>` : ''}
      </div>
      <div class="fchain">${SC_STEPS.map((s, i) =>
        node(s) + (i < SC_STEPS.length - 1 ? '<div class="farrow">→</div>' : '')).join('')}</div>
    </div>`;
}
