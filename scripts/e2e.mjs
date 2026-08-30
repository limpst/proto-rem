/** STEP 1~7 전 구간 스모크 테스트. 실제 발송은 하지 않는다(dry-run). */
const B = process.env.BASE ?? 'http://127.0.0.1:8787';
const post = async (p, b = {}) => (await fetch(B + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
})).json();
const get = async p => (await fetch(B + p)).json();
const t = (n, s) => console.log(`\n[STEP ${n}] ${s}`);

t(1, '명함 수집');
let s = await post('/api/ingest');
console.log(`  ${s.cards.length}건 (${s.source})`);

t(2, '발신 고정 + 발송 모드');
s = await post('/api/mode', { mode: '1:N', personaId: 'ceo' });
console.log(`  발신 에이톰엔지니어링 / 명의 ${s.personaId} / 모드 ${s.mode}`);

t(4, '고객군 자동 분류');
s = await post('/api/segment');
const bySeg = {};
for (const c of s.cards) bySeg[c.segmentId] = (bySeg[c.segmentId] ?? 0) + 1;
console.log('  ' + Object.entries(bySeg).map(([k, v]) => `${k}:${v}`).join(' '));

t(4, '발송 대상 확정 (사람이 하는 자리 — 여기서는 tower + demolition 선택)');
const ids = s.cards.filter(c => ['tower', 'demolition'].includes(c.segmentId)).map(c => c.id);
s = await post('/api/selection', { ids });
console.log(`  ${s.selection.length}건 선택`);

t(3, '프롬프트 조립 확인');
const pv = await post('/api/prompt-preview', { segmentId: 'tower', channel: 'email' });
console.log(`  ${pv.mode} / ${pv.segment} / 프롬프트 ${pv.prompt.length}자`);

t(5, '카피 생성 (배치 반복)');
const t0 = Date.now();
s = await post('/api/generate', { channel: 'email', batch: 1, restart: true });
while (s.remaining > 0) {
  console.log(`  ... 남은 ${s.remaining}건`);
  s = await post('/api/generate', { channel: 'email', batch: 1 });
}
if (!s.cards) { console.error('  생성 실패 응답:', JSON.stringify(s).slice(0, 400)); process.exit(1); }
console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}초 소요`);
for (const c of s.cards.filter(c => c.message)) {
  const m = c.message;
  console.log(`  - ${c.name}/${c.company}: ${m.error ?? `검증 ${m.checks.filter(k => k.pass).length}/${m.checks.length} blocked=${m.blocked}`}`);
}

t(6, '검토·승인 (사람이 하는 자리 — 여기서는 전건 승인)');
for (const c of s.cards.filter(c => c.message && !c.message.error)) {
  s = await post('/api/review', { id: c.id, action: 'approve' });
}
console.log(`  승인 ${s.cards.filter(c => c.message?.reviewStatus === 'APPROVED').length}건`);

t(7, '발송 (dry-run — 실제 전송 안 함)');
const d = await post('/api/deliver', { confirm: false });
console.log(`  ${(d.results ?? []).length}건 큐 적재`);

console.log('\n=== 생성된 문안 1건 ===');
const sample = d.cards.find(c => c.message && !c.message.error);
console.log(`제목: ${sample.message.subject}`);
console.log(sample.message.body.split('\n').slice(0, 6).join('\n'));
console.log('\n전 구간 통과.');
