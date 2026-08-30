/**
 * STEP 2 회사 식별 — 명함에 홈페이지가 없을 때 찾아낸다.
 *
 * 명함에 URL이 적혀 있는 경우는 드물다. 대신 이메일 도메인이 거의 항상 회사 도메인이다.
 *   jh.lee@novaedgetek.com  ->  https://novaedgetek.com
 *
 * 다만 gmail/naver 같은 무료 메일은 회사 도메인이 아니므로 걸러야 한다.
 * 후보를 만든 뒤 실제로 응답하는지 확인해서, 살아 있는 주소만 채택한다.
 */

/** 회사 도메인이 아닌 무료·포털 메일 */
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'naver.com', 'daum.net', 'hanmail.net', 'kakao.com',
  'nate.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'yahoo.co.kr',
  'icloud.com', 'me.com', 'protonmail.com', 'proton.me', 'qq.com', '163.com',
]);

export function domainFromEmail(email) {
  const m = String(email ?? '').match(/@([^@\s]+)$/);
  if (!m) return '';
  const d = m[1].toLowerCase().trim();
  return FREE_MAIL.has(d) ? '' : d;
}

/** 도메인 하나로 만들 수 있는 홈페이지 후보들 */
export function candidates(card) {
  const out = [];
  const push = u => { if (u && !out.includes(u)) out.push(u); };

  if (card.site) push(card.site.startsWith('http') ? card.site : `https://${card.site}`);

  const d = domainFromEmail(card.email);
  if (d) {
    push(`https://${d}`);
    push(`https://www.${d}`);
    // 메일만 별도 도메인을 쓰는 경우 (mail.example.com 등)
    const bare = d.replace(/^(mail|mx|smtp|email)\./, '');
    if (bare !== d) { push(`https://${bare}`); push(`https://www.${bare}`); }
  }
  return out;
}

/** 실제로 응답하는지 확인한다. 리다이렉트된 최종 주소를 돌려준다. */
async function alive(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; proto-rem/0.1; +research)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return res.url || url;
  } catch { return null; }
}

/**
 * 3순위 — 회사명으로 LLM 에게 후보를 물어본다.
 *
 * LLM 은 없는 주소를 만들어낼 수 있으므로 **제안만 받고 채택은 하지 않는다.**
 * 반환된 후보를 전부 실제로 접속해 보고, 살아 있는 것만 위 단계에서 채택한다.
 * 검증이 있기 때문에 환각이 결과를 오염시키지 못한다.
 */
async function guessByName(card) {
  if (!card.company) return [];
  const prompt = `"${card.company}" 라는 한국 회사의 공식 홈페이지 주소를 추정하라.
${card.email ? `참고 - 이 회사 직원 이메일: ${card.email}` : ''}
${card.title ? `참고 - 직함: ${card.title}` : ''}

확실하지 않아도 된다. 가능성이 높은 순서로 최대 4개의 URL 후보만 출력하라.
실제 접속 가능 여부는 별도로 검증하므로, 추측이어도 형식만 맞으면 된다.

JSON 배열만 출력하라. 설명 금지.
["https://example.com", "https://www.example.co.kr"]`;

  try {
    const { complete } = await import('./llm.mjs');
    const raw = await complete(prompt, { maxTokens: 300 });
    const m = String(raw).match(/\[[\s\S]*?\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr)
      ? arr.filter(u => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 4)
      : [];
  } catch { return []; }
}

/**
 * 명함 하나의 홈페이지를 확정한다.
 *
 * 순서: ① 명함에 적힌 URL  ② 이메일 도메인  ③ 회사명으로 LLM 후보
 * 어느 단계든 **실제 응답하는 주소만** 채택한다.
 *
 * @returns {{ siteUrl, via: 'card'|'email-domain'|'llm-guess'|'none', tried: string[] }}
 */
export async function resolveSite(card, { useLlm = true } = {}) {
  const tried = candidates(card);

  for (const [i, url] of tried.entries()) {
    const found = await alive(url);
    if (found) {
      return { siteUrl: found, via: (i === 0 && card.site) ? 'card' : 'email-domain', tried };
    }
  }

  if (useLlm) {
    const guesses = await guessByName(card);
    for (const url of guesses) {
      tried.push(url);
      const found = await alive(url);
      if (found) return { siteUrl: found, via: 'llm-guess', tried };
    }
  }

  return { siteUrl: '', via: 'none', tried };
}
