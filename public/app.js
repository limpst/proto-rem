const $ = s => document.querySelector(s);
let S = null, busy = false;
let viewStep = 1;
let promptPreview = null;    // STEP 3에서 조립된 프롬프트 원문
const openPrompts = new Set(); // STEP 5/6에서 펼쳐 본 프롬프트

const api = async (p, body) => {
  const r = await fetch(p, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'GET' });
  return r.json();
};

const run = async (label, fn) => {
  if (busy) return;
  busy = true; render(label);
  try { S = await fn(); } catch (e) { alert(e.message); }
  busy = false; render();
};

const seg = id => S.segments.find(s => s.id === id);
const esc = t => String(t ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ── 사이드바 ────────────────────────────────────────────── */
function renderSide() {
  $('#rail').innerHTML = S.steps.map(s => `
    <div class="step ${viewStep === s.n ? 'active' : ''} ${S.step >= s.n ? 'done' : ''}" data-n="${s.n}">
      <div class="num">${S.step >= s.n ? '✓' : s.n}</div>
      <div>
        <div class="lb">${esc(s.label)}${s.hitl ? '<span class="hitl">HUMAN</span>' : ''}</div>
        <div class="sb">${esc(SHORT[s.id] ?? '')}</div>
      </div>
    </div>`).join('');
  document.querySelectorAll('.step').forEach(el => {
    el.onclick = () => { viewStep = Number(el.dataset.n); render(); };
  });

  const b = S.backend ?? {};
  const pName = (S.personas ?? []).find(p => p.id === S.personaId)?.label ?? '-';
  $('#stat').innerHTML = `
    <dt>명함</dt><dd>${S.cards.length}건 · 선택 ${S.selection.length}</dd>
    <dt>발송모드</dt><dd>${esc(S.mode)}</dd>
    <dt>명의</dt><dd>${esc(pName)}</dd>
    <dt>LLM</dt><dd title="${esc(b.model)}">${esc(b.name)}</dd>
    <dt>메일</dt><dd style="color:${S.smtp?.configured ? 'var(--ok)' : 'var(--warn)'}">
      ${S.smtp?.configured ? (S.smtp.dryRun ? 'dry-run' : '발송가능') : '미설정'}</dd>`;
}

const SHORT = {
  ingest: '리멤버 · CSV · JSON',
  resolve: '에이톰 고정 · 명의 · 1:1/1:N',
  enrich: 'source·target 홈페이지',
  segment: '자동분류 후 사람이 확정',
  generate: '프롬프트로 문안 생성',
  review: '수정 후 승인/반려',
  deliver: '승인 건만 전송',
};

function render(loading) {
  if (!S) return;
  renderSide();
  const step = S.steps.find(s => s.n === viewStep);
  $('#head').innerHTML = `
    <div class="eyebrow">STEP ${step.n}${step.hitl ? ' · HUMAN IN THE LOOP' : ''}</div>
    <h2>${esc(step.label)}</h2>
    <div class="desc">${esc(step.desc)}</div>`;
  $('#view').innerHTML =
    (loading ? `<div class="panel"><div class="spin">${esc(loading)} … 로컬 모델 호출 중입니다.</div></div>` : '')
    + VIEWS[step.id]();
  bind();
}

/* ── 공통 표 ─────────────────────────────────────────────── */
const cardRows = cards => !cards.length ? '<div class="muted">명함이 없습니다.</div>' : `
  <table><thead><tr>
    <th style="width:26px"></th><th>담당자</th><th>회사</th><th>고객군</th><th>리서치 근거</th>
  </tr></thead><tbody>
  ${cards.map(c => `<tr>
    <td>${c.segmentId === 'internal' ? ''
      : `<input type="checkbox" class="pick" value="${c.id}" ${S.selection.includes(c.id) ? 'checked' : ''}>`}</td>
    <td><b>${esc(c.name)}</b><div class="muted" style="font-size:11.5px">${esc(c.title)}</div></td>
    <td>${esc(c.company)}<div class="muted" style="font-size:11.5px">${esc(c.siteUrl || c.site) || '홈페이지 없음'}</div></td>
    <td>${c.segmentId === 'internal'
      ? '<span class="tag" style="border-color:#5a4415;color:var(--warn)">자사 · 발송제외</span>'
      : c.segmentId && c.segmentId !== 'unclassified'
        ? `<span class="tag seg">${esc(seg(c.segmentId)?.label ?? c.segmentId)}</span>`
        : '<span class="tag">미분류</span>'}</td>
    <td>${c.signals?.facts?.length
      ? `<ul class="facts">${c.signals.facts.map(f => `<li>${esc(f)}</li>`).join('')}</ul>`
      : `<span class="muted" style="font-size:11.5px">${c.siteFetch ? `수집 실패 (${esc(c.siteFetch.reason)})` : '미수집'}</span>`}</td>
  </tr>`).join('')}
  </tbody></table>`;

/* ── 단계별 화면 ─────────────────────────────────────────── */
const VIEWS = {
  ingest: () => `
    <div class="panel">
      <div class="cap">방법 ① 전용 브라우저 로그인 — 한 번 로그인해 두면 이후로는 버튼 하나로 전부 가져옵니다</div>
      <div class="muted" style="font-size:12.5px;margin-bottom:12px">
        proto-rem 전용 프로필로 창을 엽니다. 그 창에서 <b>직접 로그인</b>하시면 세션이 저장되고,
        다음부터는 <b>[전부 가져오기]</b> 만 누르면 됩니다. 평소 쓰시는 Chrome 은 건드리지 않습니다.<br>
        <span style="color:var(--warn)">구글 로그인은 자동화 브라우저에서 차단될 수 있습니다. 그때는 네이버·카카오 로그인을 쓰세요.</span>
      </div>
      <div class="row">
        <button data-act="rlogin">브라우저 열어 로그인</button>
        <button class="ghost" data-act="rexport">전부 가져오기</button>
      </div>
    </div>

    <div class="panel">
      <div class="cap">방법 ② 콘솔 스니펫 — 이미 로그인된 Chrome 을 그대로 씁니다. 재시작·확장 불필요</div>
      <ol class="muted" style="font-size:12.5px;margin:0 0 12px;padding-left:18px;line-height:1.9">
        <li>쓰시던 Chrome 에서 <code>card.rememberapp.co.kr</code> 접속 (로그인 상태 그대로)</li>
        <li><b>F12 → Console</b> 탭에 스니펫 붙여넣고 Enter</li>
        <li>명함 목록을 끝까지 스크롤 → 우측 하단 <b>[JSON 저장]</b></li>
        <li>내려받은 <code>cards.json</code> 을 아래에 올리기</li>
      </ol>
      <div class="row">
        <button class="sm" data-act="copysnippet">스니펫 복사</button>
        <a class="muted" style="font-size:12px" href="/collect-snippet.js" target="_blank">스니펫 원문 보기</a>
      </div>
      <div class="drop" id="drop" style="margin-top:12px">
        cards.json 을 여기에 끌어다 놓거나 클릭해서 선택하세요
        <input type="file" id="file" accept=".json" hidden>
      </div>
    </div>

    <div class="panel">
      <div class="cap">방법 ③ CDP 접속 — 완전 자동이지만 Chrome 을 종료했다 디버깅 포트로 다시 켜야 합니다</div>
      <pre style="margin-top:0">Get-Process chrome | Stop-Process -Force
&amp; "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222</pre>
      <div class="row" style="margin-top:10px">
        <button class="ghost sm" data-act="rexportcdp">CDP 로 가져오기</button>
      </div>
    </div>

    <div class="panel">
      <div class="row">
        <button data-act="ingest">명함 불러오기</button>
        <button class="ghost" data-act="reset">초기화</button>
        <span class="muted" style="font-size:12px">현재 출처: ${S.source === 'remember-export' ? '리멤버 반출' : '샘플 시드'}</span>
      </div>
      <div style="margin-top:14px">${cardRows(S.cards)}</div>
    </div>`,

  resolve: () => `
    <div class="panel">
      <div class="cap">발신 (source) — 고정</div>
      <div style="font-size:16px;font-weight:600">${esc(S.company?.name)}</div>
      <div class="muted" style="font-size:12.5px;margin-top:2px">
        ${esc(S.company?.tagline)} · 업력 ${S.company?.years}년 · 누적 진단 ${S.company?.projects}건<br>
        ${esc(S.company?.addr)} · ${esc(S.company?.tel)}</div>
      <div class="row" style="margin-top:12px">
        <button class="ghost sm" data-act="source">자사 홈페이지 다시 읽기</button>
        ${S.sourceProfile ? `<span class="tag ok">서비스 ${(S.sourceProfile.services ?? []).length}종 · 레퍼런스 ${(S.sourceProfile.reference_projects ?? []).length}건</span>` : ''}
      </div>
    </div>

    <div class="panel">
      <div class="cap">발신자 명의 — 누구 이름으로 나가느냐에 따라 톤과 약속 범위가 달라집니다</div>
      <div class="seg-choice">
        ${(S.personas ?? []).map(p => `
          <button class="opt ${S.personaId === p.id ? 'on' : ''}" data-persona="${p.id}">
            <b>${esc(p.label)}</b><span>${esc(p.tone)}</span></button>`).join('')}
      </div>
    </div>

    <div class="panel">
      <div class="cap">발송 모드 — 수신자(target) 대응 방식</div>
      <div class="seg-choice">
        <button class="opt ${S.mode === '1:1' ? 'on' : ''}" data-mode="1:1">
          <b>1 : 1 개별 맞춤</b>
          <span>수신자 회사 홈페이지에서 뽑은 사실을 각각 인용합니다. 응답률이 높지만 건당 모델 호출이 듭니다. 고가치 대상에.</span></button>
        <button class="opt ${S.mode === '1:N' ? 'on' : ''}" data-mode="1:N">
          <b>1 : N 고객군 공통</b>
          <span>고객군마다 문안 1건을 만들고 이름·회사만 치환합니다. 빠르고 저렴하지만 개인화가 얕습니다. 대량 초기 접촉에.</span></button>
      </div>
    </div>
    <div class="panel">${cardRows(S.cards)}</div>`,

  enrich: () => `
    <div class="banner info">source(에이톰)와 target(고객) 홈페이지를 모두 읽습니다.
      근거가 0개인 대상은 STEP 5에서 생성이 자동 차단됩니다.</div>
    <div class="panel">
      <div class="row">
        <button data-act="enrich">전체 리서치 실행</button>
        <button class="ghost" data-act="prompt">이 설정으로 만들어지는 프롬프트 보기</button>
      </div>
      ${promptPreview ? `
        <div class="cap" style="margin-top:14px">조립된 프롬프트 · ${esc(promptPreview.mode ?? '')}
          ${esc(promptPreview.target ?? promptPreview.segment ?? '')}</div>
        ${promptPreview.note ? `<span class="chk f">${esc(promptPreview.note)}</span>` : ''}
        <pre style="max-height:520px">${esc(promptPreview.prompt)}</pre>
        <div class="muted" style="font-size:11.5px;margin-top:8px">이 프롬프트가 곧 제품 로직입니다.
          고칠 곳은 <code>src/domain.mjs</code>(고객군 정의)와 <code>src/generate.mjs</code>(작성 규칙)입니다.</div>` : ''}
    </div>
    <div class="panel">${cardRows(S.cards)}</div>`,

  segment: () => `
    <div class="banner">자동 분류 결과를 보고 <b>실제로 발송할 고객군과 명함을 사람이 확정</b>합니다.</div>
    <div class="panel">
      <div class="row">
        <button data-act="segment">고객군 자동 분류</button>
        ${S.segments.map(s => `<button class="ghost sm" data-pick="${s.id}">${esc(s.label)}</button>`).join('')}
        <button class="ghost sm" data-pick="none">선택 해제</button>
      </div>
      <div class="muted" style="margin-top:10px;font-size:12.5px">
        선택됨 <b style="color:var(--tx)">${S.selection.length}</b>건</div>
      <div style="margin-top:12px">${cardRows(S.cards)}</div>
    </div>`,

  generate: () => `
    <div class="panel">
      <div class="row">
        <span class="muted" style="font-size:12.5px">채널</span>
        <select id="ch" style="background:var(--sunk);color:var(--tx);border:1px solid var(--line);border-radius:7px;padding:8px 10px">
          <option value="email">이메일</option>
          <option value="sms">문자(LMS)</option>
          <option value="remember">리멤버 메시지</option>
        </select>
        <button data-act="generate" ${S.selection.length ? '' : 'disabled'}>
          ${S.mode === '1:N' ? `고객군 공통 문안 생성 (대상 ${S.selection.length}건)` : `선택 ${S.selection.length}건 개별 생성`}
        </button>
      </div>
      <div class="muted" style="font-size:12px;margin-top:10px">
        ${S.mode === '1:N'
          ? '고객군마다 문안 1건을 만들고 수신자별로 이름·회사를 치환합니다.'
          : '수신자별로 홈페이지 근거를 인용한 문안을 각각 만듭니다. 로컬 모델 기준 건당 1분 안팎.'}</div>
    </div>
    ${S.cards.filter(c => c.message).map(msgCard).join('')}`,

  review: () => `
    <div class="banner"><b>사람이 문안을 고치고 승인해야만</b> 발송 큐로 넘어갑니다. 자동 발송은 없습니다.</div>
    ${S.cards.filter(c => c.message).length
      ? S.cards.filter(c => c.message).map(msgCard).join('')
      : '<div class="panel muted">생성된 메시지가 없습니다. STEP 5를 먼저 실행하세요.</div>'}`,

  deliver: () => {
    const ok = S.cards.filter(c => c.message?.reviewStatus === 'APPROVED');
    return `
      <div class="panel">
        <div class="row">
          <button data-act="deliver" ${ok.length ? '' : 'disabled'}>승인 ${ok.length}건 · 큐 적재 (전송 안 함)</button>
          <button class="bad" data-act="send" ${ok.length && S.smtp?.configured ? '' : 'disabled'}>실제 Gmail 발송</button>
        </div>
        <div class="${S.smtp?.configured ? 'banner info' : 'banner'}" style="margin-top:14px">
          ${S.smtp?.configured
            ? `발신 계정 <b>${esc(S.smtp.user)}</b> 연결됨${S.smtp.dryRun ? ' · <b>DRY_RUN=1</b> 이라 실제 전송되지 않습니다' : ''}.
               승인된 건만 전송됩니다.`
            : `실제 발송을 하려면 프로젝트 루트 <code>.env</code> 의 <code>GMAIL_APP_PASSWORD</code> 를 채우세요.
               앱 비밀번호는 Google 계정 &gt; 보안 &gt; 2단계 인증 &gt; 앱 비밀번호 에서 발급합니다(16자리).`}
        </div>
      </div>
      <div class="panel">
        <table><thead><tr><th>담당자</th><th>회사</th><th>수신</th><th>상태</th><th>시각</th></tr></thead><tbody>
        ${S.cards.filter(c => c.message).map(c => `<tr>
          <td>${esc(c.name)}</td><td>${esc(c.company)}</td>
          <td class="muted">${esc(c.email) || '-'}</td>
          <td><span class="tag ${c.status === 'SENT' ? 'ok' : ''}">${esc(c.status)}</span>
            ${c.deliverError ? `<div class="chk f" style="margin-top:4px">${esc(c.deliverError)}</div>` : ''}</td>
          <td class="muted">${esc(c.deliveredAt ?? c.queuedAt) || '-'}</td></tr>`).join('')}
        </tbody></table>
      </div>`;
  },
};

function msgCard(c) {
  const m = c.message;
  if (m.error) {
    const why = m.error === 'insufficient-evidence' ? '홈페이지 근거 부족' : m.error;
    return `<div class="msg"><div class="to"><b>${esc(c.name)}</b> · ${esc(c.company)}</div>
      <span class="chk f">생성 차단: ${esc(why)}</span>
      ${m.prompt ? `<pre style="max-height:340px">${esc(m.prompt)}</pre>` : ''}</div>`;
  }
  return `<div class="msg" data-id="${c.id}">
    <div class="to"><b>${esc(c.name)}</b> ${esc(c.title)} · ${esc(c.company)}
      <span class="tag seg" style="margin-left:6px">${esc(seg(c.segmentId)?.label)}</span>
      <span class="tag" style="margin-left:4px">${esc(m.mode ?? '1:1')}</span>
      <span class="tag ${m.reviewStatus === 'APPROVED' ? 'ok' : ''}" style="margin-left:4px">${esc(m.reviewStatus)}</span></div>
    <div class="checks">${(m.checks ?? []).map(k =>
      `<span class="chk ${k.pass ? 'p' : 'f'}">${k.pass ? '✓' : '✕'} ${esc(k.label)}</span>`).join('')}</div>
    ${m.channel === 'email' ? `<input class="f-subject" value="${esc(m.subject)}">` : ''}
    <textarea class="f-body">${esc(m.body)}</textarea>
    <div class="muted" style="font-size:11.5px;margin-bottom:9px">
      CTA: ${esc(m.cta) || '-'} &nbsp;|&nbsp; 인용 실적: ${esc((m.refs_used ?? []).join(', ')) || '없음'}</div>
    <div class="row">
      <button class="ok sm" data-rev="approve">승인</button>
      <button class="bad sm" data-rev="reject">반려</button>
      <button class="ghost sm" data-rev="save">수정만 저장</button>
      ${m.prompt ? `<button class="ghost sm" data-prompt="${c.id}">
        ${openPrompts.has(c.id) ? '프롬프트 접기' : '이 문안을 만든 프롬프트'}</button>` : ''}
    </div>
    ${m.prompt && openPrompts.has(c.id) ? `<pre style="max-height:420px">${esc(m.prompt)}</pre>` : ''}
  </div>`;
}

/* ── 이벤트 ──────────────────────────────────────────────── */
function bind() {
  const acts = {
    ingest: () => api('/api/ingest', {}),
    reset: () => api('/api/reset', {}),
    enrich: () => api('/api/enrich', {}),
    segment: () => api('/api/segment', {}),
    source: () => api('/api/source-profile', {}),
    deliver: () => api('/api/deliver', { confirm: false }),

    // 로컬 모델은 건당 1분 안팎이라 서버가 batch 건씩 만들고 remaining 을 돌려준다.
    // 0이 될 때까지 반복 호출하며 진행률을 갱신한다.
    generate: async () => {
      const channel = $('#ch').value;
      let r = await api('/api/generate', { channel, batch: 1, restart: true });
      let guard = 0;
      while (r.remaining > 0 && guard++ < 300) {
        S = r; render(`카피 생성 중 — 남은 ${r.remaining}건`);
        r = await api('/api/generate', { channel, batch: 1 });
      }
      return r;
    },

    send: async () => {
      const n = S.cards.filter(c => c.message?.reviewStatus === 'APPROVED').length;
      if (!confirm(`승인된 ${n}건을 실제로 발송합니다.\n되돌릴 수 없습니다. 진행할까요?`)) return api('/api/state');
      const r = await api('/api/deliver', { confirm: true });
      const sent = (r.results ?? []).filter(x => x.sent).length;
      alert(`발송 ${sent}/${(r.results ?? []).length}건 성공`);
      return r;
    },

    prompt: async () => {
      const first = S.cards.find(c => S.selection.includes(c.id)) ?? S.cards[0];
      promptPreview = await api('/api/prompt-preview', {
        id: first?.id, segmentId: first?.segmentId, channel: 'email',
      });
      return api('/api/state');
    },

    rlogin: async () => {
      alert('전용 브라우저 창이 열립니다.\n그 창에서 직접 로그인해 주세요. 명함 목록이 뜨면 자동으로 감지하고 창이 닫힙니다.');
      const r = await api('/api/remember-login', {});
      alert(r.ok
        ? '로그인 저장 완료. 이제 [전부 가져오기]를 누르세요.'
        : `로그인이 확인되지 않았습니다.\n\n${r.log}`);
      return api('/api/state');
    },

    rexport: async () => {
      const r = await api('/api/remember-export', { via: 'profile' });
      alert(r.ok ? '리멤버 반출 완료. [명함 불러오기]를 눌러 적재하세요.' : `반출 실패\n\n${r.log}`);
      return api('/api/state');
    },

    rexportcdp: async () => {
      const r = await api('/api/remember-export', { via: 'cdp' });
      alert(r.ok ? '리멤버 반출 완료. [명함 불러오기]를 눌러 적재하세요.' : `반출 실패\n\n${r.log}`);
      return api('/api/state');
    },

    copysnippet: async () => {
      const code = await (await fetch('/collect-snippet.js')).text();
      await navigator.clipboard.writeText(code);
      alert('스니펫을 복사했습니다.\n\ncard.rememberapp.co.kr 에서 F12 → Console 에 붙여넣으세요.');
      return api('/api/state');
    },
  };

  document.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = () => run(b.textContent.trim(), acts[b.dataset.act]);
  });
  document.querySelectorAll('[data-mode]').forEach(b => {
    b.onclick = async () => { S = await api('/api/mode', { mode: b.dataset.mode }); render(); };
  });
  document.querySelectorAll('[data-persona]').forEach(b => {
    b.onclick = async () => { S = await api('/api/mode', { personaId: b.dataset.persona }); render(); };
  });
  document.querySelectorAll('[data-prompt]').forEach(b => {
    b.onclick = () => {
      const id = b.dataset.prompt;
      openPrompts.has(id) ? openPrompts.delete(id) : openPrompts.add(id);
      render();
    };
  });
  document.querySelectorAll('.pick').forEach(cb => {
    cb.onchange = async () => {
      const ids = [...document.querySelectorAll('.pick:checked')].map(x => x.value);
      S = await api('/api/selection', { ids });
      render();
    };
  });
  document.querySelectorAll('[data-pick]').forEach(b => {
    b.onclick = async () => {
      const t = b.dataset.pick;
      const ids = t === 'none' ? [] : S.cards.filter(c => c.segmentId === t).map(c => c.id);
      S = await api('/api/selection', { ids });
      render();
    };
  });
  document.querySelectorAll('[data-rev]').forEach(b => {
    b.onclick = async () => {
      const box = b.closest('.msg');
      S = await api('/api/review', {
        id: box.dataset.id, action: b.dataset.rev,
        subject: box.querySelector('.f-subject')?.value,
        body: box.querySelector('.f-body')?.value,
      });
      render();
    };
  });

  // cards.json 업로드
  const drop = $('#drop'), file = $('#file');
  if (drop && file) {
    drop.onclick = () => file.click();
    drop.ondragover = e => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; };
    drop.ondragleave = () => { drop.style.borderColor = ''; };
    drop.ondrop = e => { e.preventDefault(); drop.style.borderColor = ''; upload(e.dataTransfer.files[0]); };
    file.onchange = () => upload(file.files[0]);
  }
}

async function upload(f) {
  if (!f) return;
  let cards;
  try { cards = JSON.parse(await f.text()); }
  catch { return alert('JSON 파일이 아닙니다.'); }
  if (!Array.isArray(cards)) return alert('명함 배열이 아닙니다.');
  S = await api('/api/upload-cards', { cards });
  alert(`${cards.length}건 적재했습니다.`);
  render();
}

(async () => { S = await api('/api/state'); render(); })();
