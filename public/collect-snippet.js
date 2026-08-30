/* ============================================================
   리멤버 명함 수집 스니펫  (proto-rem)

   쓰는 법
     1. 이미 로그인된 Chrome 에서 https://card.rememberapp.co.kr/ 를 연다
     2. F12 → Console 탭
     3. 이 파일 내용을 통째로 붙여넣고 Enter
     4. 화면 오른쪽 아래 패널이 뜨면, 명함 목록을 끝까지 스크롤한다
     5. [JSON 저장] 을 누르면 cards.json 이 다운로드된다
     6. 대시보드 STEP 1 의 [JSON 올리기] 에 그 파일을 넣는다

   Chrome 을 끄거나 다시 켜지 않아도 되고, 확장도 설치하지 않는다.
   비밀번호를 다루지 않으며, 수집한 데이터는 이 브라우저 안에만 있다가
   사용자가 저장을 누를 때 로컬 파일로만 내려간다.
   ============================================================ */
(() => {
  if (window.__protoRemCollector) { console.log('[proto-rem] 이미 실행 중입니다.'); return; }
  window.__protoRemCollector = true;

  const raw = [];
  const CARD_KEYS = ['name', 'company', 'companyName', 'mobile', 'email', 'department', 'position'];

  /** 응답 JSON 어디에 명함이 있는지 모르므로, 명함처럼 생긴 객체를 재귀로 찾는다. */
  const harvest = (node, out, depth = 0) => {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) { node.forEach(v => harvest(v, out, depth + 1)); return; }
    if (typeof node !== 'object') return;
    const keys = Object.keys(node);
    if (CARD_KEYS.filter(k => keys.includes(k)).length >= 3) out.push(node);
    Object.values(node).forEach(v => harvest(v, out, depth + 1));
  };

  const capture = (url, text) => {
    if (!/api\.rememberapp\.co\.kr/.test(url)) return;
    if (/client_config/.test(url)) return;
    try { raw.push({ url: String(url).split('?')[0], body: JSON.parse(text) }); } catch { /* JSON 아님 */ }
    update();
  };

  // fetch 가로채기
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try { capture(res.url, await res.clone().text()); } catch { /* 본문 없음 */ }
    return res;
  };

  // XHR 가로채기 (리멤버가 XHR 을 쓰는 경우 대비)
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__url = u; return origOpen.call(this, m, u, ...rest); };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', () => { try { capture(this.__url, this.responseText); } catch {} });
    return origSend.apply(this, a);
  };

  const normalize = () => {
    const found = [];
    raw.forEach(r => harvest(r.body, found));
    const seen = new Set();
    const cards = [];
    found.forEach((c, i) => {
      const key = `${c.name ?? ''}|${c.company ?? c.companyName ?? ''}|${c.mobile ?? c.phone ?? ''}`;
      if (key === '||' || seen.has(key)) return;
      seen.add(key);
      cards.push({
        id: `r${String(i).padStart(4, '0')}`,
        name: c.name ?? '',
        title: c.position ?? c.title ?? '',
        company: c.company ?? c.companyName ?? '',
        dept: c.department ?? '',
        email: c.email ?? '',
        phone: c.mobile ?? c.phone ?? '',
        site: c.homepage ?? c.website ?? '',
        met_at: '명함 교환',
        note: c.memo ?? '',
      });
    });
    return cards;
  };

  const download = (obj, filename) => {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  // --- 화면 오른쪽 아래 패널 ---
  const box = document.createElement('div');
  box.style.cssText = `position:fixed;right:18px;bottom:18px;z-index:2147483647;background:#171a21;
    color:#e6e9ef;border:1px solid #2a2f3a;border-radius:12px;padding:14px 16px;width:280px;
    font:13px/1.6 system-ui,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.5)`;
  box.innerHTML = `
    <div style="font-weight:700;margin-bottom:6px">proto-rem 명함 수집</div>
    <div id="pr-stat" style="color:#9aa4b6;font-size:12px;margin-bottom:10px">API 0건 · 명함 0건</div>
    <div style="color:#9aa4b6;font-size:11.5px;margin-bottom:10px">
      명함 목록을 아래로 끝까지 스크롤하세요. 불러온 만큼 아래 숫자가 올라갑니다.</div>
    <button id="pr-save" style="width:100%;background:#4f8cff;color:#fff;border:0;border-radius:8px;
      padding:9px;font-weight:600;cursor:pointer;font-family:inherit">JSON 저장</button>
    <button id="pr-raw" style="width:100%;margin-top:6px;background:transparent;color:#9aa4b6;
      border:1px solid #2a2f3a;border-radius:8px;padding:7px;cursor:pointer;font-family:inherit;font-size:12px">
      원본 응답도 저장 (명함 0건일 때)</button>`;
  document.body.appendChild(box);

  function update() {
    const el = box.querySelector('#pr-stat');
    if (el) el.textContent = `API ${raw.length}건 · 명함 ${normalize().length}건`;
  }

  box.querySelector('#pr-save').onclick = () => {
    const cards = normalize();
    if (!cards.length) { alert('아직 수집된 명함이 없습니다. 명함 목록 페이지에서 스크롤해 주세요.'); return; }
    download(cards, 'cards.json');
  };
  box.querySelector('#pr-raw').onclick = () => download(raw, 'remember-api-raw.json');

  console.log('[proto-rem] 수집기 실행됨. 명함 목록을 스크롤한 뒤 [JSON 저장]을 누르세요.');
})();
