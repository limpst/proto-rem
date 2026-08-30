/**
 * AI 고객군 분류.
 *
 * 키워드 분류(domain.classify)는 "백화점", "대학" 처럼 회사명에 업종이 드러날 때만 맞는다.
 * "노바엣지테크놀로지", "MEISTER TRADING" 같은 이름은 규칙으로는 아무것도 알 수 없다.
 * 그래서 키워드가 놓친 건에 한해 LLM 에게 물어본다.
 *
 * 원칙:
 *   - 7개 고객군 중에서만 고르게 한다. 새 분류를 만들지 못한다.
 *   - 확신이 없으면 unclassified 를 돌려주게 한다. 억지로 배정하면 엉뚱한 메일이 나간다.
 *   - 결과에는 근거와 확신도를 함께 받아 화면에 표시한다. 사람이 STEP 4 에서 뒤집을 수 있어야 한다.
 */
import { complete } from './llm.mjs';
import { SEGMENTS } from './domain.mjs';

const domainOf = email => (String(email ?? '').match(/@([^@\s]+)$/) ?? [, ''])[1];

function buildPrompt(card) {
  return `너는 B2B 영업 데이터 애널리스트다. 아래 명함 한 장을 보고
㈜에이톰엔지니어링(건축물 안전진단 전문기관)의 고객군 중 어디에 속하는지 판단하라.

# 명함
회사: ${card.company ?? ''}
이름: ${card.name ?? ''}
직함: ${card.title ?? ''}
부서: ${card.dept ?? ''}
이메일 도메인: ${domainOf(card.email) || '(없음)'}
메모: ${card.note ?? '(없음)'}

# 고를 수 있는 고객군 (이 목록 밖을 만들지 말 것)
${SEGMENTS.map(s => `- ${s.id} : ${s.label} — ${s.pain}`).join('\n')}
- unclassified : 위 어디에도 해당하지 않거나, 근거가 부족해 판단할 수 없음

# 판단 규칙
1. 회사가 **건물·시설을 보유하거나 운영하는 쪽**인지가 핵심이다.
   소프트웨어 회사, 금융 트레이딩 회사처럼 시설 수요가 뚜렷하지 않으면 unclassified 로 둔다.
2. 회사명만으로 업종을 모르겠으면 억지로 배정하지 말고 unclassified 를 고른다.
   틀린 분류는 엉뚱한 내용의 메일로 이어진다.
3. 확신도(confidence)를 정직하게 매긴다. high 는 업종이 명확할 때만.

# 출력 (JSON 만, 설명 금지)
{"segmentId":"...","confidence":"high|medium|low","reason":"한 문장 근거"}`;
}

const VALID = new Set([...SEGMENTS.map(s => s.id), 'unclassified']);

/** 명함 한 장을 AI 로 분류한다. 실패하면 unclassified. */
export async function classifyOne(card) {
  try {
    const raw = await complete(buildPrompt(card), { maxTokens: 300 });
    const m = String(raw).match(/\{[\s\S]*?\}/);
    if (!m) return { segmentId: 'unclassified', confidence: 'low', reason: 'AI 응답을 해석하지 못했습니다' };
    const r = JSON.parse(m[0]);
    const id = VALID.has(r.segmentId) ? r.segmentId : 'unclassified';
    return {
      segmentId: id,
      confidence: ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'low',
      reason: String(r.reason ?? '').slice(0, 200),
    };
  } catch (e) {
    return { segmentId: 'unclassified', confidence: 'low', reason: `AI 호출 실패: ${String(e.message ?? e)}` };
  }
}
