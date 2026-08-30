/** 파일 기반 상태 저장소. 프로토타입 단계에서 DB를 대신한다. (스키마는 docs/04 참조) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'data', 'state.json');

const EMPTY = {
  tenantId: 'atom-eng',
  cards: [], selection: [], step: 1,
  mode: '1:1',        // 1:1 개별 맞춤 / 1:N 고객군 공통
  personaId: 'sales', // 발신자 명의
};

export function load() {
  if (!fs.existsSync(STATE)) {
    const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed-cards.json'), 'utf8'));
    const s = { ...EMPTY, cards: seed.map(c => ({ ...c, status: 'NEW' })) };
    save(s);
    return s;
  }
  // 기존 state.json 에 새 필드가 없을 수 있으므로 기본값을 채워 준다.
  return { ...EMPTY, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) };
}

export function save(state) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

export function update(fn) { const s = load(); fn(s); return save(s); }
