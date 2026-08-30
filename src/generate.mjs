/**
 * 5단계 생성.
 *   1:1 모드 — 수신자 회사 홈페이지 근거를 인용한 개별 문안
 *   1:N 모드 — 고객군 공통 문안 1건 + 수신자별 병합필드 치환
 *
 * 공통 규칙: 근거 없는 문장 금지, 실적은 화이트리스트에서만 인용,
 *            첫 접촉은 무상 제공물로 마무리, 컴플라이언스는 코드가 강제.
 *
 * buildPrompt / buildSegmentPrompt 는 대시보드가 프롬프트 원문을 그대로
 * 보여줄 수 있도록 export 한다. 프롬프트가 곧 이 제품의 로직이므로
 * 사용자가 읽고 고칠 수 있어야 한다.
 */
import { complete } from './llm.mjs';
import { COMPANY, SEGMENTS } from './domain.mjs';

const CHANNEL_SPEC = {
  email: { label: '이메일', limit: '제목 1줄 + 본문 250~400자', extra: '제목은 반드시 "(광고)"로 시작' },
  sms:   { label: '문자(LMS)', limit: '250자 이내', extra: '첫 줄에 "(광고) ㈜에이톰엔지니어링", 마지막 줄에 무료수신거부 번호' },
  remember: { label: '리멤버 메시지', limit: '150자 이내', extra: '명함 교환 맥락을 첫 문장에 언급, 말미에 수신거부 안내 한 줄' },
};

/** 발신자 역할 — 누구 명의로 나가는가에 따라 톤과 권한이 달라진다. */
export const PERSONAS = [
  {
    id: 'ceo', label: '대표',
    signer: '대표이사',
    tone: '짧고 단정하게. 실무 설명은 최소화하고, 결정권자 대 결정권자의 제안으로 쓴다. 문장 수를 줄이고 여백을 남긴다.',
    authority: '대표 명의이므로 "직접 검토해 드리겠습니다" 같은 약속을 할 수 있다.',
  },
  {
    id: 'marketer', label: '마케팅 담당자',
    signer: '마케팅팀',
    tone: '실무적이고 친절하게. 무엇을 무상으로 드리는지 구체적으로 적고, 받는 절차를 명확히 안내한다.',
    authority: '자료 제공과 일정 조율까지만 약속한다. 견적·계약 조건을 언급하지 않는다.',
  },
  {
    id: 'sales', label: '영업 담당자',
    signer: '영업총괄',
    tone: '만난 맥락을 먼저 짚고, 도움이 될 만한 한 가지만 제안한다. 영업 냄새를 줄이고 정보 제공에 무게를 둔다.',
    authority: '현장 방문과 사전 검토를 제안할 수 있다.',
  },
  {
    id: 'engineer', label: '기술 담당자',
    signer: '기술본부',
    tone: '기술적 근거를 앞세운다. 어떤 부재·어떤 열화 유형이 문제가 되는지 구체적으로 쓰되 전문용어는 1~2개로 제한한다.',
    authority: '점검 방법과 소요 일정을 설명할 수 있다.',
  },
];

export const persona = id => PERSONAS.find(p => p.id === id) ?? PERSONAS[2];

const personaBlock = p => `# 발신자 역할: ${p.label} (${COMPANY.name} ${p.signer})
톤: ${p.tone}
권한 범위: ${p.authority}`;

/** 1:1 개별 문안 프롬프트 */
export function buildPrompt({ card, segment, signals, channel, personaId, sourceProfile }) {
  const ch = CHANNEL_SPEC[channel] ?? CHANNEL_SPEC.email;
  const p = persona(personaId);
  const src = sourceProfile?.credentials?.length
    ? `자사 홈페이지에서 확인된 공신력 근거: ${sourceProfile.credentials.join(', ')}`
    : `${COMPANY.tagline} / ${COMPANY.grade}`;

  return `너는 B2B 아웃바운드 영업 카피라이터다. 발신 주체는 ${COMPANY.name}(${COMPANY.tagline}, 업력 ${COMPANY.years}년, 누적 진단 ${COMPANY.projects}건)이다.
${src}

${personaBlock(p)}

# 수신자
이름: ${card.name} ${card.title ?? ''}
회사: ${card.company} / ${card.dept ?? ''}
만난 계기: ${card.met_at ?? '명함 교환'}
명함 메모: ${card.note ?? '(없음)'}

# 이 수신자의 고객군
${segment.label}
법정/수요 트리거: ${segment.trigger}
이 고객군의 통증: ${segment.pain}
인용 가능한 실제 실적(이 목록 밖의 실적을 지어내지 말 것):
${segment.refs.map(r => `- ${r}`).join('\n')}
첫 제안(클로징은 반드시 이것으로): ${segment.offer}

# 수신자 홈페이지에서 확인된 사실 (이 중 최소 1개를 반드시 인용)
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

/** 1:N 고객군 공통 문안 프롬프트 */
export function buildSegmentPrompt({ segment, channel, personaId, sourceProfile }) {
  const ch = CHANNEL_SPEC[channel] ?? CHANNEL_SPEC.email;
  const p = persona(personaId);

  return `너는 B2B 아웃바운드 영업 카피라이터다. 발신 주체는 ${COMPANY.name}(${COMPANY.tagline}, 업력 ${COMPANY.years}년, 누적 진단 ${COMPANY.projects}건)이다.
${sourceProfile?.credentials?.length ? `자사 공신력 근거: ${sourceProfile.credentials.join(', ')}` : ''}

${personaBlock(p)}

# 과제
아래 고객군 전체에 보낼 **공통 문안 1건**을 쓴다. 수신자 이름과 회사명은 병합필드로 남긴다.

# 고객군
${segment.label}
법정/수요 트리거: ${segment.trigger}
이 고객군의 통증: ${segment.pain}
인용 가능한 실제 실적(이 목록 밖을 지어내지 말 것):
${segment.refs.map(r => `- ${r}`).join('\n')}
첫 제안(클로징은 반드시 이것으로): ${segment.offer}

# 작성 규칙
1. 수신자 이름은 {{name}}, 직함은 {{title}}, 회사명은 {{company}} 로 표기한다. 그 외 병합필드는 만들지 않는다.
2. 개별 회사의 구체적 사실을 아는 척하지 않는다. 고객군 공통의 통증과 트리거로만 설득한다.
3. 법정 점검 해당 여부를 단정하지 않는다. 확인 제안형으로 쓴다.
4. 실적은 위 목록에서만 인용한다.
5. 첫 문안에서 견적·계약을 요구하지 않는다.
6. 분량: ${ch.limit}. ${ch.extra}

# 출력 형식 (JSON만, 설명 금지)
{
  "subject": "이메일일 때만 제목, 아니면 빈 문자열",
  "body": "본문 전문 (병합필드 포함)",
  "evidence_used": ["인용한 고객군 공통 트리거"],
  "refs_used": ["인용한 실적"],
  "cta": "요구하는 단 하나의 다음 행동"
}`;
}

/**
 * 컴플라이언스 요소는 LLM에 맡기지 않고 시스템이 강제 삽입한다.
 * (광고) 표기와 수신거부 안내는 누락 시 법 위반이므로 생성 품질에 의존시키면 안 된다.
 */
export function applyCompliance(msg, channel, personaId) {
  const out = { ...msg };
  const p = persona(personaId);
  const sig = {
    email: `\n\n${COMPANY.name} ${p.signer} | ${COMPANY.tagline}\n${COMPANY.addr}\n`
      + `Tel ${COMPANY.tel} | ${COMPANY.email}\n\n`
      + `※ 본 메일은 명함 교환을 통해 수집된 연락처로 발송된 광고성 정보입니다.\n`
      + `※ 수신을 원치 않으시면 회신 제목에 [수신거부]를 적어 보내주세요. 즉시 영구 차단됩니다.`,
    sms: `\n\n${COMPANY.tel}\n무료수신거부 080-000-0000`,
    remember: `\n\n— 광고성 안내입니다. 원치 않으시면 회신 주시면 더 보내지 않겠습니다.`,
  }[channel] ?? '';

  if (channel === 'email') {
    if (out.subject && !out.subject.startsWith('(광고)')) out.subject = `(광고) ${out.subject}`;
  } else if (channel === 'sms') {
    if (!String(out.body).startsWith('(광고)')) out.body = `(광고) ${COMPANY.name}\n\n${out.body}`;
  }
  if (!/수신거부|수신 거부/.test(out.body ?? '')) out.body = `${out.body ?? ''}${sig}`;
  return out;
}

const parseJson = raw => {
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
};

export async function generateMessage({ card, segmentId, signals, channel = 'email', personaId, sourceProfile }) {
  const segment = SEGMENTS.find(s => s.id === segmentId);
  if (!segment) return { error: 'unknown-segment' };

  const prompt = buildPrompt({ card, segment, signals, channel, personaId, sourceProfile });
  const raw = await complete(prompt);
  if (String(raw).includes('INSUFFICIENT_EVIDENCE')) return { error: 'insufficient-evidence', prompt };

  const parsed = parseJson(raw);
  if (!parsed) return { error: 'unparsable', raw: String(raw).slice(0, 1200), prompt };

  const msg = applyCompliance(parsed, channel, personaId);
  return { ...msg, channel, mode: '1:1', personaId, prompt, ...validate(msg, channel, '1:1') };
}

export async function generateSegmentTemplate({ segmentId, channel = 'email', personaId, sourceProfile }) {
  // 1:N 은 회사별 근거를 쓰지 않으므로 1:1 의 "근거 없으면 차단" 가드가 걸리지 않는다.
  // 대신 고객군이 확정되지 않았으면 만들지 않는다. 미분류에 보내는 광고가 곧 스팸이다.
  if (!segmentId || segmentId === 'unclassified') return { error: 'unclassified-segment' };
  const segment = SEGMENTS.find(s => s.id === segmentId);
  if (!segment) return { error: 'unknown-segment' };

  const prompt = buildSegmentPrompt({ segment, channel, personaId, sourceProfile });
  const raw = await complete(prompt);
  const parsed = parseJson(raw);
  if (!parsed) return { error: 'unparsable', raw: String(raw).slice(0, 1200), prompt };

  const tpl = applyCompliance(parsed, channel, personaId);
  return { ...tpl, channel, segmentId, mode: '1:N', personaId, prompt };
}

/** 템플릿의 병합필드를 수신자 정보로 치환한다. */
export function renderTemplate(tpl, card, channel) {
  const fill = t => String(t ?? '')
    .replaceAll('{{name}}', card.name ?? '')
    .replaceAll('{{title}}', card.title ?? '')
    .replaceAll('{{company}}', card.company ?? '');
  const msg = { ...tpl, subject: fill(tpl.subject), body: fill(tpl.body) };
  return { ...msg, ...validate(msg, channel, '1:N') };
}

/** 6단계 검토 게이트에 표시할 자동 검증 결과 */
export function validate(msg, channel, mode = '1:1') {
  const text = `${msg.subject ?? ''}\n${msg.body ?? ''}`;
  const checks = [
    { id: 'C1',
      label: mode === '1:N' ? '고객군 공통 트리거 인용' : '홈페이지 사실 인용',
      pass: (msg.evidence_used ?? []).length > 0 },
    { id: 'C2', label: '실적 레퍼런스 인용', pass: (msg.refs_used ?? []).length > 0 },
    { id: 'C3', label: '법정 해당 여부 단정 안 함', pass: !/반드시 대상입니다|의무입니다|해야 합니다/.test(text) },
    { id: 'C4', label: '(광고) 표기', pass: channel === 'remember' ? true : text.includes('(광고)') },
    { id: 'C5', label: '수신거부 안내', pass: /수신거부|수신 거부|080/.test(text) },
    { id: 'C8', label: '첫 접촉에 견적 요구 없음', pass: !/견적서를 보내|계약을 진행|금액을 확정/.test(text) },
    ...(mode === '1:N'
      ? [{ id: 'C9', label: '병합필드 잔여 없음', pass: !/\{\{\w+\}\}/.test(text) }]
      : []),
  ];
  return { checks, blocked: checks.some(c => !c.pass) };
}
