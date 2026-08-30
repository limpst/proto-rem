const $ = s => document.querySelector(s);
let S = null, busy = false;
let viewStep = 1;
let promptPreview = null;   // STEP 3에서 조립된 프롬프트 원문
let openPrompts = new Set(); // STEP 5/6에서 펼쳐 본 프롬프트

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

function render(loading) {
  if (!S) return;

  const b = S.backend ?? {};
  $('#src').innerHTML =
    `${S.source ? `· 데이터 ${S.source === 'remember-export' ? '리멤버 반출' : '샘플 시드'}` : ''}
     · 발송모드 <b style="color:var(--tx)">${esc(S.mode ?? '1:1')}</b>
     · 명의 <b style="color:var(--tx)">${esc((S.personas ?? []).find(p => p.id === S.personaId)?.label ?? '영업 담당자')}</b>
     · LLM <b style="color:var(--tx)">${esc(b.name)}${b.model ? ` (${esc(b.model)})` : ''}</b>
     · 메일 ${S.smtp?.configured ? '<b style="color:var(--ok)">연결됨</b>' : '<span style="color:var(--warn)">미설정</span>'}`;

  $('#rail').innerHTML = S.steps.map(s => `
    <div class="st ${viewStep === s.n ? 'active' : ''} ${S.step >= s.n ? 'done' : ''}" data-n="${s.n}">
      ${s.hitl ? '<span class="hitl">HUMAN</span>' : ''}
      <div class="n">STEP ${s.n}</div><div class="l">${s.label}</div>
    </div>`).join('');
  document.querySelectorAll('.st').forEach(el => {
    el.onclick = () => { viewStep = Number(el.dataset.n); render(); };
  });

  const step = S.steps.find(s => s.n === viewStep);
  const spinner = loading
    ? `<div class="spin">${esc(loading)} … 모델 호출 중입니다. 건당 수 초 걸립니다.</div>` : '';
  $('#view').innerHTML = `<div class="panel"><h2>STEP ${step.n}. ${step.label}</h2>
    <div class="desc">${step.desc}</div>${spinner}${VIEWS[step.id]()}</div>`;
  bind();
}

const cardRows = cards => `
  <table><thead><tr>
    <th style="width:26px"></th><th>담당자</th><th>회사</th><th>고객군</th><th>리서치 근거</th>
  </tr></thead><tbody>
  ${cards.map(c => `<tr>
    <td><input type="checkbox" class="pick" value="${c.id}" ${S.selection.includes(c.id) ? 'checked' : ''}></td>
    <td><b>${esc(c.name)}</b><div class="muted" style="font-size:11.5px">${esc(c.title)}</div></td>
    <td>${esc(c.company)}<div class="muted" style="font-size:11.5px">${esc(c.siteUrl || c.site) || '홈페이지 없음'}</div></td>
    <td>${c.segmentId && c.segmentId !== 'unclassified'
      ? `<span class="tag seg">${esc(seg(c.segmentId)?.label ?? c.segmentId)}</span>`
      : '<span class="tag">미분류</span>'}</td>
    <td>${c.signals?.facts?.length
      ? `<ul class="facts">${c.signals.facts.map(f => `<li>${esc(f)}</li>`).join('')}</ul>`
      : `<span class="muted" style="font-size:11.5px">${c.siteFetch ? `수집 실패 (${esc(c.siteFetch.reason)})` : '미수집'}</span>`}</td>
  </tr>`).join('')}
  </tbody></table>`;

const VIEWS = {
  ingest: () => `
    <div class="row">
      <button data-act="rexport">리멤버에서 가져오기</button>
      <button data-act="ingest">명함 불러오기</button>
      <button class="ghost" data-act="reset">초기화</button>
    </div>
    <div class="banner" style="margin-top:12px">
      <b>리멤버에서 가져오기</b>는 이미 로그인된 Chrome에 붙어서 수집합니다.
      Chrome을 완전히 종료한 뒤 <code>chrome.exe --remote-debugging-port=9222</code> 로 한 번 실행해 두세요.
      자동화 브라우저의 구글 로그인은 차단되므로(<code>signin/rejected</code>) 이 방식이 유일하게 안정적입니다.
    </div>
    ${S.cards.length ? cardRows(S.cards) : ''}`,

  resolve: () => `
    <div class="msg">
      <div class="to"><b>발신 (source)</b> — 고정</div>
      <div style="font-size:15px;font-weight:600;margin-bottom:2px">${esc(S.company?.name)}</div>
      <div class="muted" style="font-size:12.5px">${esc(S.company?.tagline)} · 업력 ${S.company?.years}년 ·
        누적 진단 ${S.company?.projects}건<br>${esc(S.company?.addr)} · ${esc(S.company?.tel)}</div>
      <div class="row" style="margin-top:10px">
        <button class="ghost" data-act="source">자사 홈페이지 다시 읽기</button>
      </div>
      ${S.sourceProfile ? `<div class="facts" style="margin-top:8px">
        서비스 ${(S.sourceProfile.services ?? []).length}종 ·
        공신력 ${esc((S.sourceProfile.credentials ?? []).join(' / '))} ·
        레퍼런스 ${(S.sourceProfile.reference_projects ?? []).length}건</div>` : ''}
    </div>

    <div class="msg">
      <div class="to"><b>발신자 명의</b> — 누구 이름으로 나가는가에 따라 톤이 달라집니다</div>
      <div class="row">
        ${(S.personas ?? []).map(p => `
          <button class="${(S.personaId ?? 'sales') === p.id ? '' : 'ghost'}" data-persona="${p.id}">${esc(p.label)}</button>
        `).join('')}
      </div>
      <div class="facts" style="margin-top:8px">
        ${esc((S.personas ?? []).find(p => p.id === (S.personaId ?? 'sales'))?.tone)}</div>
    </div>

    <div class="msg">
      <div class="to"><b>발송 모드</b> — 수신자(target) 대응 방식</div>
      <div class="row">
        <button class="${S.mode === '1:N' ? 'ghost' : ''}" data-mode="1:1">1 : 1 개별 맞춤</button>
        <button class="${S.mode === '1:N' ? '' : 'ghost'}" data-mode="1:N">1 : N 고객군 공통</button>
      </div>
      <div class="facts" style="margin-top:8px">
        ${S.mode === '1:N'
          ? '고객군마다 공통 문안 1건을 만들고 이름·회사만 치환합니다. 빠르고 저렴하지만 개인화 깊이가 얕습니다. 명함 수가 많을 때.'
          : '수신자 회사 홈페이지에서 뽑은 사실을 각각 인용해 1건씩 만듭니다. 응답률이 높지만 건당 모델 호출이 듭니다. 고가치 대상에.'}
      </div>
    </div>
    <div style="margin-top:14px">${cardRows(S.cards)}</div>`,

  enrich: () => `
    <div class="banner">source(자사)와 target(고객) 홈페이지를 모두 읽습니다.
      근거가 0개인 대상은 STEP 5에서 생성이 자동 차단됩니다.</div>
    <div class="row">
      <button data-act="enrich">전체 리서치 실행</button>
      <button class="ghost" data-act="prompt">이 설정으로 만들어지는 프롬프트 보기</button>
    </div>
    ${promptPreview ? `
      <div class="msg" style="margin-top:14px">
        <div class="to"><b>조립된 프롬프트</b> · ${esc(promptPreview.mode ?? '')}
          ${esc(promptPreview.target ?? promptPreview.segment ?? '')}</div>
        ${promptPreview.note ? `<span class="chk f">${esc(promptPreview.note)}</span>` : ''}
        <pre style="white-space:pre-wrap;background:#12151b;border:1px solid var(--line);border-radius:8px;
          padding:14px;font-size:12px;line-height:1.7;max-height:520px;overflow:auto">${esc(promptPreview.prompt)}</pre>
        <div class="facts">이 프롬프트가 곧 제품 로직입니다. 고칠 곳은 <code>src/domain.mjs</code>(고객군 정의)와
          <code>src/generate.mjs</code>(작성 규칙)입니다.</div>
      </div>` : ''}
    <div style="margin-top:14px">${cardRows(S.cards)}</div>`,

  segment: () => `
    <div class="banner">HUMAN IN THE LOOP — 자동 분류 결과를 보고
      <b>실제로 발송할 고객군과 명함을 사람이 확정</b>합니다.</div>
    <div class="row">
      <button data-act="segment">고객군 자동 분류</button>
      ${S.segments.map(s => `<button class="ghost" data-pick="${s.id}">${s.label}</button>`).join('')}
      <button class="ghost" data-pick="none">선택 해제</button>
    </div>
    <div style="margin-top:10px" class="muted">선택됨 <b style="color:var(--tx)">${S.selection.length}</b>건</div>
    <div style="margin-top:10px">${cardRows(S.cards)}</div>`,

  generate: () => `
    <div class="row">
      <span class="muted">채널</span>
      <select id="ch" style="background:#12151b;color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:8px">
        <option value="email">이메일</option>
        <option value="sms">문자(LMS)</option>
        <option value="remember">리멤버 메시지</option>
      </select>
      <button data-act="generate" ${S.selection.length ? '' : 'disabled'}>
        ${S.mode === '1:N' ? `고객군 공통 문안 생성 (대상 ${S.selection.length}건)` : `선택 ${S.selection.length}건 개별 생성`}
      </button>
    </div>
    <p class="muted" style="font-size:12.5px;margin-top:12px">
      ${S.mode === '1:N'
        ? '고객군마다 문안 1건을 만들고 수신자별로 이름·회사를 치환합니다.'
        : '수신자별로 홈페이지 근거를 인용한 문안을 각각 만듭니다.'}</p>
    ${S.cards.filter(c => c.message).map(msgCard).join('')}`,

  review: () => `
    <div class="banner">HUMAN IN THE LOOP — <b>사람이 문안을 고치고 승인해야만</b>
      발송 큐로 넘어갑니다. 자동 발송은 없습니다.</div>
    ${S.cards.filter(c => c.message).length
      ? S.cards.filter(c => c.message).map(msgCard).join('')
      : '<div class="muted">생성된 메시지가 없습니다. STEP 5를 먼저 실행하세요.</div>'}`,

  deliver: () => {
    const ok = S.cards.filter(c => c.message?.reviewStatus === 'APPROVED');
    return `
      <div class="row">
        <button data-act="deliver" ${ok.length ? '' : 'disabled'}>승인 ${ok.length}건 · 발송 큐 적재 (전송 안 함)</button>
        <button class="bad" data-act="send" ${ok.length && S.smtp?.configured ? '' : 'disabled'}>실제 Gmail 발송</button>
      </div>
      <div class="banner" style="margin-top:14px">
        ${S.smtp?.configured
          ? `발신 계정 <b>${esc(S.smtp.user)}</b> 연결됨. 실제 발송은 승인된 건만, 21~08시에는 차단됩니다.`
          : `실제 발송을 하려면 프로젝트 루트 <code>.env</code> 에 아래를 넣으세요. 앱 비밀번호는
             Google 계정 &gt; 보안 &gt; 2단계 인증 &gt; 앱 비밀번호 에서 직접 발급하시면 됩니다.
             <pre style="margin:8px 0 0;font-size:12px">GMAIL_USER=보내는주소@gmail.com
GMAIL_APP_PASSWORD=앱비밀번호16자리
GMAIL_FROM_NAME=에이톰엔지니어링</pre>`}
      </div>
      <table style="margin-top:14px"><thead><tr><th>담당자</th><th>회사</th><th>수신</th><th>상태</th><th>시각</th></tr></thead><tbody>
      ${S.cards.filter(c => c.message).map(c => `<tr>
        <td>${esc(c.name)}</td><td>${esc(c.company)}</td>
        <td class="muted">${esc(c.email) || '-'}</td>
        <td><span class="tag">${esc(c.status)}</span>${c.deliverError ? `<div class="chk f">${esc(c.deliverError)}</div>` : ''}</td>
        <td class="muted">${esc(c.deliveredAt ?? c.queuedAt) || '-'}</td></tr>`).join('')}
      </tbody></table>`;
  },
};

function msgCard(c) {
  const m = c.message;
  if (m.error) {
    const why = m.error === 'insufficient-evidence' ? '홈페이지 근거 부족' : m.error;
    return `<div class="msg"><div class="to"><b>${esc(c.name)}</b> · ${esc(c.company)}</div>
      <span class="chk f">생성 차단: ${esc(why)}</span>
      ${m.prompt ? promptBlock(c.id, m.prompt) : ''}</div>`;
  }
  return `<div class="msg" data-id="${c.id}">
    <div class="to"><b>${esc(c.name)}</b> ${esc(c.title)} · ${esc(c.company)}
      <span class="tag seg" style="margin-left:6px">${esc(seg(c.segmentId)?.label)}</span>
      <span class="tag" style="margin-left:4px">${esc(m.mode ?? '1:1')}</span>
      <span class="tag" style="margin-left:4px">${esc(m.reviewStatus)}</span></div>
    <div class="checks">${(m.checks ?? []).map(k =>
      `<span class="chk ${k.pass ? 'p' : 'f'}">${k.pass ? '✓' : '✕'} ${esc(k.label)}</span>`).join('')}</div>
    ${m.channel === 'email' ? `<input class="f-subject" value="${esc(m.subject)}">` : ''}
    <textarea class="f-body">${esc(m.body)}</textarea>
    <div class="muted" style="font-size:11.5px;margin-bottom:8px">
      CTA: ${esc(m.cta) || '-'} &nbsp;|&nbsp; 인용 실적: ${esc((m.refs_used ?? []).join(', ')) || '없음'}</div>
    <div class="row">
      <button class="ok" data-rev="approve">승인</button>
      <button class="bad" data-rev="reject">반려</button>
      <button class="ghost" data-rev="save">수정만 저장</button>
      ${m.prompt ? `<button class="ghost" data-prompt="${c.id}">
        ${openPrompts.has(c.id) ? '프롬프트 접기' : '이 문안을 만든 프롬프트'}</button>` : ''}
    </div>
    ${m.prompt && openPrompts.has(c.id) ? promptBlock(c.id, m.prompt) : ''}
  </div>`;
}

const promptBlock = (id, prompt) => `
  <pre style="white-space:pre-wrap;background:#12151b;border:1px solid var(--line);border-radius:8px;
    padding:14px;font-size:12px;line-height:1.7;max-height:460px;overflow:auto;margin-top:10px">${esc(prompt)}</pre>`;

function bind() {
  const acts = {
    ingest: () => api('/api/ingest', {}),
    reset: () => api('/api/reset', {}),
    enrich: () => api('/api/enrich', {}),
    segment: () => api('/api/segment', {}),
    source: () => api('/api/source-profile', {}),
    generate: () => api('/api/generate', { channel: $('#ch').value }),
    deliver: () => api('/api/deliver', { confirm: false }),
    send: async () => {
      const n = S.cards.filter(c => c.message?.reviewStatus === 'APPROVED').length;
      if (!confirm(`승인된 ${n}건을 실제로 Gmail 발송합니다.\n\n되돌릴 수 없습니다. 진행할까요?`)) {
        return api('/api/state');
      }
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
    rexport: async () => {
      const r = await api('/api/remember-export', {});
      alert(r.ok ? '리멤버 반출 완료. [명함 불러오기]를 눌러 적재하세요.' : `반출 실패\n\n${r.log}`);
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
        id: box.dataset.id,
        action: b.dataset.rev,
        subject: box.querySelector('.f-subject')?.value,
        body: box.querySelector('.f-body')?.value,
      });
      render();
    };
  });
}

(async () => { S = await api('/api/state'); render(); })();
