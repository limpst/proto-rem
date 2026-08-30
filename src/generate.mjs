/**
 * 5단계 생성: 세그먼트 + 홈페이지 근거 + 실적 레퍼런스로 1:1 메시지를 만든다.
 * 규칙: 근거 없는 문장 금지, 실적은 주어진 목록에서만 인용, 첫 접촉은 무상 제공물로 마무리.
 */
import { complete } from './llm.mjs';
import { COMPANY, SEGMENTS } from './domain.mjs';

const CHANNEL_SPEC = {
  email: { label: '이메일', limit: '제목 1줄 + 본문 250~400자', extra: '제목은 반드시 "(광고)"로 시작' },
  sms:   { label: '문자(LMS)', limit: '250자 이내', extra: '첫 줄에 "(광고) ㈜에이톰엔지니어링", 마지막 줄에 무료수신거부 번호' },
  remember: { label: '리멤버 메시지', limit: '150자 이내', extra: '명함 교환 맥락을 첫 문장에 언급, 말미에 수신거부 안내 한 줄' },
};

export function buildPrompt({ card, segment, signals, channel }) {
  const ch = CHANNEL_SPEC[channel] ?? CHANNEL_SPEC.email;
  return `너는 B2B 아웃바운드 영업 카피라이터다. 발신 주체는 ${COMPANY.name}(${COMPANY.tagline}, 업력 ${COMPANY.years}년, 누적 진단 ${COMPANY.projects}건, ${COMPANY.grade})이다.

# 수신자
이름: ${card.name} ${card.title ?? ''}
회사: ${card.company} / ${card.dept ?? ''}
만난 계기: ${card.met_at ?? '명함 교환'}
명함 메모: ${card.note ?? '(없음)'}

# 이 수신자의 세그먼트
${segment.label}
법정/수요 트리거: ${segment.trigger}
이 세그먼트의 통증: ${segment.pain}
인용 가능한 실제 실적(이 목록 밖의 실적을 지어내지 말 것):
${segment.refs.map(r => `- ${r}`).join('\n')}
첫 제안(클로징은 반드시 이것으로): ${segment.offer}

# 홈페이지에서 확인된 사실 (이 중 최소 1개를 반드시 인용)
${(signals.facts ?? []).map(f => `- ${f}`).join('\n') || '- (확인된 사실 없음)'}
건물 신호: ${JSON.stringify(signals.building_signals ?? {})}

# 작성 규칙 (위반 시 실패)
1. 홈페이지 사실 최소 1개를 자연스럽게 인용한다. 사실이 하나도 없으면 본문 대신 "INSUFFICIENT_EVIDENCE"만 출력한다.
2. 법정 점검 해당 여부를 단정하지 않는다. "해당하는 경우가 많습니다", "확인해 보시길 권합니다" 같은 확인 제안형으로 쓴다.
3. 실적은 위 목록에서만 인용한다. 숫자나 고객사를 새로 만들지 않는다.
4. 첫 메일에서 견적·계약을 요구하지 않는다. 무상 제공물 수령 여부만 묻는다.
5. 과장 표현("최고", "완벽", "100% 보장") 금지. 담백한 실무 톤.
6. 분량: ${ch.limit}. ${ch.extra}
7. 채널: ${ch.label}

# 출력 형식 (JSON만, 설명 금지)
{
  "subject": "이메일일 때만 제목, 아니면 빈 문자열",
  "body": "본문 전문",
  "evidence_used": ["실제로 인용한 홈페이지 사실"],
  "refs_used": ["실제로 인용한 실적"],
  "cta": "이 메시지가 요구하는 단 하나의 다음 행동"
}`;
}

/**
 * 컴플라이언스 요소는 LLM에 맡기지 않고 시스템이 강제 삽입한다.
 * (광고) 표기와 수신거부 안내는 누락 시 법 위반이므로 생성 품질에 의존시키면 안 된다.
 */
export function applyCompliance(msg, channel) {
  const out = { ...msg };
  const sig = {
    email: `

${COMPANY.name} | ${COMPANY.tagline}
${COMPANY.addr}
Tel ${COMPANY.tel} | ${COMPANY.email}

` +
      `※ 본 메일은 명함 교환을 통해 수집된 연락처로 발송된 광고성 정보입니다.
` +
      `※ 수신을 원치 않으시면 [수신거부]를 눌러주세요. 즉시 영구 차단됩니다.`,
    sms: `

${COMPANY.tel}
무료수신거부 080-000-0000`,
    remember: `

— 광고성 안내입니다. 원치 않으시면 회신 주시면 더 보내지 않겠습니다.`,
  }[channel] ?? '';

  if (channel === 'email') {
    if (out.subject && !out.subject.startsWith('(광고)')) out.subject = `(광고) ${out.subject}`;
  } else if (channel === 'sms') {
    if (!out.body.startsWith('(광고)')) out.body = `(광고) ${COMPANY.name}

${out.body}`;
  }
  if (!/수신거부|수신 거부/.test(out.body)) out.body = `${out.body}${sig}`;
  return out;
}

export async function generateMessage({ card, segmentId, signals, channel = 'email' }) {
  const segment = SEGMENTS.find(s => s.id === segmentId);
  if (!segment) return { error: 'unknown-segment' };
  const raw = await complete(buildPrompt({ card, segment, signals, channel }));
  if (raw.includes('INSUFFICIENT_EVIDENCE')) return { error: 'insufficient-evidence' };
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { error: 'unparsable', raw };
  try {
    const msg = applyCompliance(JSON.parse(m[0]), channel);
    return { ...msg, channel, ...validate(msg, channel) };
  } catch { return { error: 'unparsable', raw }; }
}

/** 6단계 검토 게이트에 표시할 자동 검증 결과 */
export function validate(msg, channel) {
  const text = `${msg.subject ?? ''}\n${msg.body ?? ''}`;
  const checks = [
    { id: 'C1', label: '홈페이지 사실 인용', pass: (msg.evidence_used ?? []).length > 0 },
    { id: 'C2', label: '실적 레퍼런스 인용', pass: (msg.refs_used ?? []).length > 0 },
    { id: 'C3', label: '법정 해당 여부 단정 안 함', pass: !/반드시 대상입니다|의무입니다|해야 합니다/.test(text) },
    { id: 'C4', label: '(광고) 표기', pass: channel === 'remember' ? true : text.includes('(광고)') },
    { id: 'C5', label: '수신거부 안내', pass: /수신거부|수신 거부|080/.test(text) },
    { id: 'C8', label: '첫 접촉에 견적 요구 없음', pass: !/견적서를 보내|계약을 진행|금액을 확정/.test(text) },
  ];
  return { checks, blocked: checks.some(c => !c.pass) };
}
