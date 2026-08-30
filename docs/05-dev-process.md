# 05. 개발 프로세스 — 프롬프트 기반 단계별 진행

## 원칙

이 프로젝트는 코드보다 **프롬프트가 자산**이다. 세그먼트 정의·생성 규칙·검증 규칙이 곧 제품이고, 코드는 그것을 실행하는 껍데기다. 따라서 개발 순서도 프롬프트를 중심으로 잡는다.

## 작업 단위: 하나의 파이프라인 스텝 = 하나의 PR

각 스텝은 다음 4개가 갖춰져야 완료로 본다.

1. **입력/출력 계약** — 무엇을 받아 무엇을 내놓는가 (JSON 스키마)
2. **프롬프트 또는 룰** — `src/domain.mjs`, `src/generate.mjs`에 위치
3. **실패 경로** — 근거 부족·크롤 실패·파싱 실패 시 어디로 가는가
4. **눈으로 확인** — 대시보드에서 해당 스텝을 눌러 결과가 보이는가

## 프롬프트 개발 절차 (STEP 3·5에 적용)

```
① 목표 정의     이 프롬프트가 만들어야 할 산출물 1문장
② 실패 정의     무엇이 나오면 실패인가 (환각/일반론/과장)
③ 제약 명문화   출력 형식 JSON 고정, 인용 화이트리스트, 금지 표현
④ 소량 실행     3~5건으로 돌려보고 육안 확인
⑤ 검증 코드화   ④에서 발견한 실패를 validate()의 체크 항목으로 추가
⑥ 재실행       같은 입력으로 다시 돌려 체크 통과 확인
```

> ⑤가 핵심이다. **프롬프트로 막으려 하지 말고 코드로 막는다.**
> 실제로 수신거부 문구는 프롬프트로 요구했을 때 누락됐고(C5 실패), `applyCompliance()`로 코드 삽입하도록 바꿔 해결했다.

## 지금까지의 실행 기록 (실제 겪은 문제와 해결)

| 문제 | 원인 | 해결 |
|---|---|---|
| Playwright가 브라우저 제어권 상실 | 시스템 Chrome 실행 중 → "Opening in existing browser session" | 번들 Chromium 사용, `PROTO_REM_CHANNEL`로 선택 가능 |
| 프로필 잠금 (`Device or resource busy`) | 강제 종료된 프로세스의 stale lock | 프로필 경로 분리 (`PROTO_REM_PROFILE`) |
| 로그인 오탐 | 쿠키 존재만으로 판정 → 로그인 페이지에서도 통과 | **명함 API 실제 응답** 수신을 판정 기준으로 변경 |
| 구글 로그인 차단 | `accounts.google.com/v3/signin/rejected` | 자동 로그인 포기 → **CDP로 기존 Chrome 접속** |
| `claude -p` 빈 프롬프트 | Windows에서 shell 경유 시 인자 concat으로 줄바꿈 깨짐 | 프롬프트를 **stdin**으로 전달 |
| `spawn EINVAL` | Node 25가 `.cmd` 래퍼의 shell 없는 spawn 차단 | 인자는 단순 플래그만 두고 `shell:true` 허용 |
| 수신거부 문구 누락 | LLM 출력에 의존 | `applyCompliance()`로 코드 강제 삽입 |

## 실행 명령

```bash
npm start          # 대시보드 (http://localhost:5173)
npm run export     # 리멤버 명함 반출 (Chrome --remote-debugging-port=9222 필요)
npm run login      # (참고) Playwright 자체 로그인 — 구글 차단으로 비권장
npm run probe      # 리멤버 내부 API 관찰
```
