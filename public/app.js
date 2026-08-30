const $ = s => document.querySelector(s);
let S = null, busy = false;
let viewStep = 1;

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
const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function render(loading) {
  if (!S) return;
  $('#src').textContent = S.source
    ? `· 데이터 출처: ${S.source === 'remember-export' ? '리멤버 반출' : '샘플 시드'}`
    : '';

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
    ? `<div class="spin">${esc(loading)} … Claude 호출 중입니다. 건당 수 초 걸립니다.</div>` : '';
  $('#view').innerHTML = `<div class="panel"><h2>STEP ${step.n}. ${step.label}</h2>
    <div class="desc">${step.desc}</div>${spinner}${VIEWS[step.id]()}</div>`;
  bind();
}

const cardRows = cards => `
  <table><thead><tr>
    <th style="width:26px"></th><th>담당자</th><th>회사</th><th>세그먼트</th><th>리서치 근거</th>
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
      <button class="ghost" data-act="source">자사 홈페이지 프로파일</button>
      <button class="ghost" data-act="reset">초기화</button>
    </div>
    <div class="banner" style="margin-top:12px">
      <b>리멤버에서 가져오기</b>는 이미 로그인된 Chrome에 붙어서 수집합니다.
      Chrome을 완전히 종료한 뒤 <code>chrome.exe --remote-debugging-port=9222</code> 로 한 번 실행해 두세요.
      (자동화 브라우저의 구글 로그인은 차단되므로 이 방식이 유일하게 안정적입니다.)
    </div>
    ${S.sourceProfile ? `<div class="msg"><div class="to"><b>자사 프로파일</b> · ${S.sourceProfile.site}</div>
      <div class="facts">서비스 ${(S.sourceProfile.services ?? []).length}종 ·
      공신력 근거 ${(S.sourceProfile.credentials ?? []).join(' / ')} ·
      레퍼런스 ${(S.sourceProfile.reference_projects ?? []).length}건</div></div>` : ''}
    <p class="muted" style="font-size:12.5px;margin-top:12px">
      <code>data/cards.json</code>(리멤버 반출본)이 있으면 그것을, 없으면 샘플 시드를 사용합니다.
      리멤버 반출은 <code>npm run login</code> → <code>npm run probe</code> 로 연결합니다.</p>
    ${S.cards.length ? cardRows(S.cards) : ''}`,

  resolve: () => `
    <div class="row"><button data-act="resolve">회사·홈페이지 식별</button></div>
    <div style="margin-top:14px">${cardRows(S.cards)}</div>`,

  enrich: () => `
    <div class="banner">홈페이지를 실제로 읽어 근거 사실을 추출합니다.
      근거가 0개인 대상은 이후 단계에서 메시지 생성이 자동 차단됩니다.</div>
    <div class="row"><button data-act="enrich">전체 리서치 실행</button></div>
    <div style="margin-top:14px">${cardRows(S.cards)}</div>`,

  segment: () => `
    <div class="banner">HUMAN IN THE LOOP ① — 자동 분류 결과를 보고
      <b>실제로 발송할 고객군과 명함을 사람이 확정</b>합니다.</div>
    <div class="row">
      <button data-act="segment">세그먼트 자동 분류</button>
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
      <button data-act="generate" ${S.selection.length ? '' : 'disabled'}>선택 ${S.selection.length}건 카피 생성</button>
    </div>
    <p class="muted" style="font-size:12.5px;margin-top:12px">
      세그먼트별 트리거·통증·실적 레퍼런스에 홈페이지 근거를 결합해 1:1 문안을 생성합니다.</p>
    ${S.cards.filter(c => c.message).map(msgCard).join('')}`,

  review: () => `
    <div class="banner">HUMAN IN THE LOOP ② — <b>사람이 문안을 고치고 승인해야만</b>
      발송 큐로 넘어갑니다. 자동 발송은 없습니다.</div>
    ${S.cards.filter(c => c.message).length
      ? S.cards.filter(c => c.message).map(msgCard).join('')
      : '<div class="muted">생성된 메시지가 없습니다. STEP 5를 먼저 실행하세요.</div>'}`,

  deliver: () => {
    const ok = S.cards.filter(c => c.message?.reviewStatus === 'APPROVED');
    return `
      <div class="row"><button data-act="deliver" ${ok.length ? '' : 'disabled'}>승인된 ${ok.length}건 발송 큐 적재</button></div>
      <div class="banner" style="margin-top:14px">프로토타입 단계에서는 실제 전송을 하지 않고 큐에만 적재합니다.
        실제 발송 연동 시 수신동의 확인 · 야간(21~08시) 발송 차단 · 30일 내 중복 발송 차단이 함께 적용됩니다.</div>
      <table><thead><tr><th>담당자</th><th>회사</th><th>상태</th><th>시각</th></tr></thead><tbody>
      ${S.cards.filter(c => c.message).map(c => `<tr>
        <td>${esc(c.name)}</td><td>${esc(c.company)}</td>
        <td><span class="tag">${esc(c.status)}</span></td>
        <td class="muted">${esc(c.deliveredAt) || '-'}</td></tr>`).join('')}
      </tbody></table>`;
  },
};

function msgCard(c) {
  const m = c.message;
  if (m.error) {
    const why = m.error === 'insufficient-evidence' ? '홈페이지 근거 부족' : m.error;
    return `<div class="msg"><div class="to"><b>${esc(c.name)}</b> · ${esc(c.company)}</div>
      <span class="chk f">생성 차단: ${esc(why)}</span></div>`;
  }
  return `<div class="msg" data-id="${c.id}">
    <div class="to"><b>${esc(c.name)}</b> ${esc(c.title)} · ${esc(c.company)}
      <span class="tag seg" style="margin-left:6px">${esc(seg(c.segmentId)?.label)}</span>
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
    </div></div>`;
}

function bind() {
  const acts = {
    ingest: () => api('/api/ingest', {}),
    reset: () => api('/api/reset', {}),
    resolve: () => api('/api/resolve', {}),
    enrich: () => api('/api/enrich', {}),
    segment: () => api('/api/segment', {}),
    deliver: () => api('/api/deliver', {}),
    generate: () => api('/api/generate', { channel: $('#ch').value }),
    source: () => api('/api/source-profile', {}),
    rexport: async () => {
      const r = await api('/api/remember-export', {});
      alert(r.ok ? '리멤버 반출 완료. [명함 불러오기]를 눌러 적재하세요.' : `반출 실패

${r.log}`);
      return api('/api/state');
    },
  };
  document.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = () => run(b.textContent, acts[b.dataset.act]);
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
