/**
 * 3단계 리서치: 대상 회사 홈페이지를 읽어 메시지 근거가 될 사실을 뽑는다.
 * 홈페이지가 없거나 크롤 실패 시 명함 메모를 근거로 폴백한다. (근거 없으면 생성 금지)
 */
import { complete } from './llm.mjs';
import { COMPANY } from './domain.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function fetchSite(url) {
  if (!url) return { ok: false, reason: 'no-url', text: '' };
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; proto-rem/0.1; +research)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, reason: `http-${res.status}`, text: '' };
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { ok: true, reason: 'ok', text: text.slice(0, 12000) };
  } catch (e) {
    return { ok: false, reason: String(e.message ?? e), text: '' };
  }
}

const EXTRACT_PROMPT = (card, siteText) => `너는 건축물 안전진단 영업을 위한 리서치 애널리스트다.
아래 회사 정보와 홈페이지 본문에서, 건축물 안전관리 수요와 직결되는 사실만 뽑아라.

회사: ${card.company}
담당자: ${card.name} ${card.title ?? ''}
명함 메모: ${card.note ?? '(없음)'}

홈페이지 본문:
"""
${siteText || '(홈페이지 정보 없음 — 명함 메모만으로 판단)'}
"""

다음 JSON만 출력하라. 설명 문장 금지.
{
  "facts": ["홈페이지에서 확인된 구체적 사실 2~4개. 추측 금지. 근거 없으면 빈 배열."],
  "building_signals": {"types": ["건물/시설 유형"], "scale": "규모 단서 또는 unknown", "age_hint": "준공/설립 연도 단서 또는 unknown"},
  "confidence": "high | medium | low"
}`;

export async function extractSignals(card, siteText) {
  const raw = await complete(EXTRACT_PROMPT(card, siteText));
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { facts: [], building_signals: {}, confidence: 'low', _raw: raw };
  try { return JSON.parse(m[0]); }
  catch { return { facts: [], building_signals: {}, confidence: 'low', _raw: raw }; }
}


/**
 * source(발신 자사) 홈페이지도 target과 똑같이 읽는다.
 * 하드코딩된 서비스 목록이 홈페이지 개편으로 낡는 것을 막고,
 * 생성 프롬프트가 "실제로 홈페이지에 적힌 역량"만 인용하도록 고정한다.
 */
export async function buildSourceProfile({ force = false } = {}) {
  const cache = path.join(ROOT, 'data', 'source-profile.json');
  if (!force && fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));

  const site = await fetchSite(COMPANY.site);
  const prompt = `아래는 ${COMPANY.name} 홈페이지 본문이다. 영업 메시지에 인용할 수 있는 사실만 뽑아라.

"""
${site.text || '(수집 실패)'}
"""

다음 JSON만 출력하라.
{
  "services": ["홈페이지에 명시된 서비스명"],
  "credentials": ["지정/인증/평가등급 등 공신력 근거"],
  "proof_points": ["업력, 실적 건수 등 숫자 근거"],
  "reference_projects": [{"client":"발주처/건물명","service":"수행 서비스"}]
}`;

  const raw = site.ok ? await complete(prompt) : '';
  const m = raw.match(/\{[\s\S]*\}/);
  const parsed = m ? (() => { try { return JSON.parse(m[0]); } catch { return null; } })() : null;

  const profile = {
    site: COMPANY.site,
    fetchedAt: new Date().toISOString(),
    fetch: { ok: site.ok, reason: site.reason, chars: site.text.length },
    ...(parsed ?? { services: COMPANY.services, credentials: [COMPANY.tagline, COMPANY.grade], proof_points: [], reference_projects: [] }),
  };
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(profile, null, 2), 'utf8');
  return profile;
}
