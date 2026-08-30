# proto-rem

㈜에이톰엔지니어링(국토교통부 지정 안전진단전문기관)의 아웃바운드 마케팅 콘솔.

리멤버 명함 데이터를 가져와 → 고객군을 나누고 → **각 회사 홈페이지를 읽어** →
법정 점검 수요에 근거한 **1:1 맞춤 광고 메시지**를 생성하고 → 사람이 승인한 것만 발송한다.

## 7단계 파이프라인

```
1 명함수집 → 2 발신·발송모드★ → 3 홈페이지분석 → 4 고객군선택★ → 5 카피생성 → 6 검토·승인★ → 7 발송·추적
                                                    ★ = Human in the loop
```

사람이 개입하는 지점은 정확히 세 곳이다. 그 외에 사람을 넣으면 처리량이 죽고,
이 세 곳에서 빼면 사고가 난다. 자세한 내용은 [docs/03-pipeline-7steps.md](docs/03-pipeline-7steps.md).

## 빠른 실행

```bash
npm install
npm start          # → http://localhost:5173
```

명함 데이터가 없어도 샘플 시드 12건으로 전 단계가 동작한다.

### 로컬 서비스 포트

| 포트 | 서비스 | 확인 |
|---|---|---|
| 5173 | 대시보드 | http://localhost:5173 |
| 11434 | Ollama (로컬 LLM) | http://localhost:11434/api/tags |
| 9222 | Chrome 디버깅 (리멤버 반출용) | http://localhost:9222/json/version |

```powershell
# 무엇이 떠 있는지 확인
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 5173,11434,9222 }
```

## LLM 백엔드

명함은 개인정보이므로 **로컬 Ollama가 기본값**이다. 데이터가 PC 밖으로 나가지 않는다.

```powershell
winget install --id Ollama.Ollama -e
ollama pull exaone3.5:7.8b
```

`ANTHROPIC_API_KEY`가 있으면 Claude API를, 없고 Ollama도 없으면 설치된 Claude Code CLI를 쓴다.
`LLM_BACKEND=ollama|claude-api|claude-cli` 로 강제 지정 가능. 자세한 내용은
[docs/06-llm-and-delivery.md](docs/06-llm-and-delivery.md).

## 리멤버 명함 반출

구글·네이버는 Playwright가 띄운 브라우저의 로그인을 차단한다(`accounts.google.com/v3/signin/rejected`).
그래서 자동 로그인을 시도하지 않고, **이미 로그인된 Chrome에 CDP로 붙는다.**
비밀번호가 시스템을 통과하지 않으므로 보안상으로도 이쪽이 낫다.

```powershell
# Chrome을 완전히 종료한 뒤 (경로가 따옴표로 시작하므로 & 연산자가 필요하다)
& "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

그다음 대시보드 STEP 1의 **[리멤버에서 가져오기]** 또는 `npm run export`.
결과는 `data/cards.json`에 저장되고 STEP 1이 자동으로 읽는다.

## 배포

> **먼저 알아둘 것**: 이 앱의 두 기능은 **로컬에서만 동작한다.**
> ① 리멤버 반출 — 사용자 PC의 Chrome에 CDP로 붙어야 한다.
> ② 로컬 Ollama — 서버에는 없다.
> 따라서 배포본은 **대시보드 + 홈페이지 리서치 + 카피 생성 + 발송**까지만 담당하고,
> 명함은 `data/cards.json`을 올리거나 로컬에서 반출해 업로드하는 구조가 된다.
> 명함은 개인정보이므로, 공개 URL에 올리기 전에 접근 통제를 먼저 붙여야 한다.

### Render 배포

1. Render 대시보드에서 **New → Web Service**, 이 저장소를 연결한다.
2. 설정값:

   | 항목 | 값 |
   |---|---|
   | Environment | `Node` |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Health Check Path | `/api/state` |

3. **Environment Variables** (Render 대시보드에서 등록, 저장소에 넣지 않는다):

   | 키 | 값 | 비고 |
   |---|---|---|
   | `LLM_BACKEND` | `claude-api` | 서버에는 Ollama가 없다 |
   | `ANTHROPIC_API_KEY` | `sk-ant-...` | |
   | `GMAIL_USER` | 보내는주소@gmail.com | |
   | `GMAIL_APP_PASSWORD` | 앱 비밀번호 16자리 | 계정 비밀번호 아님 |
   | `GMAIL_FROM_NAME` | `에이톰엔지니어링` | |
   | `DRY_RUN` | `1` | 실전 발송 전까지는 켜 둘 것 |

   `PORT`는 Render가 주입하며 서버가 그대로 사용한다.

4. 저장소에 `render.yaml`이 포함되어 있어 **Blueprint** 방식으로도 배포할 수 있다.
   이 경우 위 환경변수만 Render에서 채우면 된다.

### 배포본의 한계

| 기능 | 로컬 | Render |
|---|---|---|
| 대시보드 7단계 | ○ | ○ |
| 홈페이지 리서치 | ○ | ○ |
| 카피 생성 | ○ (Ollama) | ○ (Claude API) |
| Gmail 발송 | ○ | ○ |
| 리멤버 명함 반출 | ○ | ✕ (로컬 Chrome 필요) |
| 상태 저장 | `data/state.json` | 디스크가 재기동 시 초기화됨 — Phase 3에서 PostgreSQL로 이전 |

## 문서

| 문서 | 내용 |
|---|---|
| [00 제품 개요](docs/00-product-overview.md) | 문제 정의, ICP, 성공 지표 |
| [01 아키텍처](docs/01-architecture.md) | 설계 원칙, 컴포넌트, 멀티테넌시 |
| [02 메시지 샘플](docs/02-message-samples.md) | 고객군 5종 실제 발송 문안 |
| [03 7단계 파이프라인](docs/03-pipeline-7steps.md) | 단계별 상세, HITL 게이트 |
| [04 로드맵](docs/04-roadmap.md) | Phase 0~3 |
| [05 개발 프로세스](docs/05-dev-process.md) | 프롬프트 기반 개발 절차 |
| [06 LLM·발송](docs/06-llm-and-delivery.md) | 백엔드, 발신 명의, 1:1/1:N, Gmail |

## 유의사항

- 명함 원본 데이터는 개인정보다. `data/`, `.env`, `.auth/`는 `.gitignore`에 있으며 커밋되지 않는다.
- 광고성 정보 전송은 정보통신망법상 **사전 수신동의**가 원칙이다.
  (광고) 표기·수신거부 안내·야간(21~08시) 발송 차단은 코드가 강제하지만,
  **수신동의 자체는 운영에서 확보해야 한다.**
- 실제 발송은 승인(`APPROVED`)된 건에 대해서만, 별도 버튼과 확인 대화상자를 거쳐 실행된다.
