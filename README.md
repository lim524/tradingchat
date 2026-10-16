# TradingChat · AI 전략 워크스페이스

Vercel 웹 + Supabase Auth/Postgres + PC 계좌 조회 실행기입니다. 차트 없이 전략 채팅·운용안 승인·계좌 상태·매매 일지·전략 버전별 실적을 관리합니다.

## 현재 구현 범위

- 기존 브라우저 데모 유지. Supabase 로그인 후에는 별도의 서버 저장 워크스페이스 사용
- 개인 계정 이메일 허용 목록, Supabase 비밀번호 로그인, HttpOnly/SameSite/Secure 세션 쿠키
- OpenAI Responses / Gemini GenerateContent 서버 호출, 구조화된 전략 제안, 호출 한도·사용량 저장
- 전략별 채팅, 변경할 때마다 고정된 새 버전, SHA-256 해시와 사용자 승인·거절·철회·만료
- 서버에서 승인 검증 후 고정 시나리오 모의 실행. 생성된 거래에 승인 전략 버전 연결
- 매매 일지 메모·태그 수정, CSV 다운로드
- 버전별 거래 수·승률·순손익·수수료·펀딩 수입·profit factor 집계
- 데모/테스트넷/실거래 데이터 분리, 사용자별 RLS, 계정 간 참조 차단
- PC의 OS 보안 저장소에 Binance 키 보관 → 서명된 GET 계좌 조회 → 요약만 서버 전송
- 실행기 토큰 해시 저장, 24시간 만료, 재발급/폐기, 스냅샷 중복 UUID 차단

**실제 주문은 활성화되지 않습니다.** 실행기는 계좌 조회 전용입니다. 테스트넷·실거래 주문, 거래소 손절/익절, 체결 스트림·재시작 복구, Flash 분당 자동 판단, 실제 거래 가져오기·왕복 거래 묶기는 후속 구현 및 테스트넷 통합 검증이 필요합니다. 매매 기록 DB에는 현재 서버 모의 실행 결과가 저장됩니다. 기존 브라우저 기록을 실거래 기록으로 승격하거나 자동 이전하지 않습니다.

모의 거래는 진입→고정 ±0.30% 이동→종료의 수동 단계입니다. 실시간 가격·가격 감시·실제 손절을 재현하지 않으며 수익성 자료로 사용하면 안 됩니다.

## 1. Supabase 준비

1. Supabase 프로젝트를 만듭니다. Postgres 15 이상이 필요합니다.
2. SQL Editor에서 [`supabase/migrations/202610160001_trading_workspace.sql`](supabase/migrations/202610160001_trading_workspace.sql)을 **한 번** 실행합니다. 기존 테이블을 삭제하지 않는 초기 마이그레이션입니다.
3. Authentication → Users에서 개인 계정을 만들고 이메일을 인증합니다. 신규 가입 허용은 끕니다. 이 앱은 공개 회원가입 화면을 제공하지 않습니다.
4. 해당 이메일을 Vercel `OWNER_EMAIL`로 지정합니다.
5. 프로젝트 URL 및 서버용 키를 아래 환경변수에 입력합니다. 키를 GitHub에 커밋하거나 채팅에 보내지 않습니다.

### 데이터 구조

| 테이블 | 역할 |
| --- | --- |
| `strategies` | 독립된 전략 이름과 소유자 |
| `strategy_versions` | 변경 불가 운용안, 버전, 모델, 해시, 모드 |
| `messages` | 전략·모드별 사용자/AI 대화와 제안 버전 연결 |
| `approvals` | 승인/거절, 운용안 해시, 유효기간, 철회 |
| `sessions` | 승인한 버전에 연결된 실행 상태 |
| `trades` | 완료 거래·수수료·펀딩 수입·고정 전략 버전 |
| `journal_entries` | 거래별 수정 가능한 복기 메모·태그 |
| `runner_connections` | 해시로 저장한 조회 전용 PC 연결 토큰 |
| `account_snapshots` | PC에서 받은 USDT 계좌·포지션 요약 |
| `ai_calls`, `ai_usage` | 호출 한도 예약 및 모델별 토큰 사용 정보 |
| `strategy_performance` 뷰 | 모든 저장 거래의 버전/모드별 실적 |

일반 사용자 JWT에는 자기 데이터 SELECT만 허용합니다. 수정 RPC는 `anon`/`authenticated`에 공개하지 않습니다. Vercel 서버가 인증 사용자를 확인하고 소유자를 강제해 호출합니다. 복합 외래키로 다른 사용자의 전략·승인·거래 참조를 차단합니다. 전략 버전과 완료 거래는 변경 불가이며, 일지는 실적과 별도로 수정합니다.

실적의 순손익은 `실현 손익 − 수수료 + 펀딩 수입`입니다. 음수 펀딩은 비용입니다. 승률은 순손익 양수인 완료 거래 비율이며, 0은 승리에 포함하지 않습니다. PF는 양수 순손익 합 / 음수 순손익 절대 합입니다. 손실 표본이 없으면 `—`로 표시합니다. 현재 화면·CSV에는 최신 거래 500건을 표시하며 실적 뷰는 전체 DB를 집계합니다.

## 2. Vercel 환경변수

`.env.example`은 이름만 포함합니다. 실제 값은 Vercel → Project → Settings → Environment Variables에 입력하고 **Redeploy**합니다.

| 변수 | 입력값 / 보관 위치 |
| --- | --- |
| `APP_ORIGIN` | 정확한 HTTPS 배포 주소. 경로·끝 `/` 없이 `https://your-app.vercel.app` |
| `SUPABASE_URL` | `https://PROJECT.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase legacy `anon` JWT 키 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase legacy `service_role` JWT 키. 서버 전용, RLS 우회 권한이 있으므로 노출 금지 |
| `OWNER_EMAIL` | 이메일 인증을 마친 개인 Supabase 계정 |
| `OPENAI_API_KEY` | OpenAI API 키. 서버 전용 |
| `OPENAI_CHAT_MODEL` | 계정에서 사용 가능한 정확한 채팅 모델 ID |
| `GEMINI_API_KEY` | Gemini API 키. 서버 전용 |
| `GEMINI_CHAT_MODEL` | Gemini로 전략 대화할 때 사용할 정확한 모델 ID |
| `GEMINI_MONITOR_MODEL` | 향후 Flash 감시용 자리. **현재 호출하지 않음** |
| `AI_DAILY_CALL_LIMIT` | 사용자당 최근 24시간 AI 호출 상한. 기본 100 |
| Binance API 키·secret | **Vercel에 입력하지 않음. PC OS 키 저장소에만 보관** |

모델 ID에는 자동 기본값·묵시적 대체가 없습니다. 계정에서 실제 사용 가능한 모델을 지정해야 합니다. 선택한 제공자 설정이 없으면 요청을 차단합니다. 현재 가격/계좌를 AI에 자동 첨부하지 않으므로 AI는 채팅으로 전략을 설계하고 부족한 정보를 질문합니다.

AI 호출은 입력 최대 4,000자, 최근 대화 최대 12개 + 최근 운용안, 출력 최대 4,000토큰으로 제한합니다. 실패한 요청도 호출 한도를 소비합니다. 이는 달러 금액 한도가 아니므로 공급사 결제 예산도 별도 설정하세요.

로그인 실패 제한은 Supabase Auth의 rate limits를 사용합니다. 개인 배포이므로 Supabase 공개 가입을 끄고, Vercel 환경변수를 신뢰할 수 없는 Preview 배포에 노출하지 마세요. 이 릴리스는 MFA 로그인 UI를 지원하지 않습니다.

## 3. 배포와 사용

Vercel에서 이 GitHub 저장소를 Import:

- Framework Preset: **Other**
- Build Command: 비움
- Output Directory: **dist**
- Node.js: **22 이상**

`vercel.json`은 CSP 등 보안 헤더와 채팅 API 60초 실행 설정을 포함합니다. 브라우저는 같은 출처의 `/api/*`만 호출하며 공급사나 Supabase로 직접 연결하지 않습니다. API 파일은 Vercel이 배포합니다. `dist`만 다른 정적 호스팅에 올리면 서버 기능은 작동하지 않습니다.

1. 연결 설정 → 개인 계정 로그인
2. 전략 관리 → 새 전략 → AI와 대화 → 버전 카드 수치 확인 → 승인
3. 데모 모드 → 모의 실행 → 다음 모의 단계 3회 → 거래 기록 확인
4. 거래 기록 → 일지 작성, 전략별 실적 → 버전별 비교
5. 계좌 조회는 [`runner/README.md`](runner/README.md)대로 PC 실행기를 연결

새 제안은 기존 승인 내용을 바꾸지 않습니다. 실행 중 새 버전을 승인하려면 기존 모의 세션/포지션을 먼저 종료해야 합니다. 모드 전환 시 기존 모의 세션 종료·현재 승인 철회를 서버에서 처리합니다. 서버 승인은 새로고침 후에도 유효기간까지 보관되지만, 실행 요청마다 다시 검사합니다. 유효기간이 끝나도 모의 포지션 종료는 허용합니다. 실거래 버전은 제안 저장까지만 가능하고 승인·실행은 잠깁니다.

## 로컬 개발·검증

```sh
npm ci
npm test
# 별도로 로컬 .env를 작성한 경우:
node --env-file=.env scripts/dev.mjs
# 설정 없이 브라우저 데모만:
npm run dev
```

로컬 `.env`의 `APP_ORIGIN`은 `http://localhost:3000`이어야 합니다. 로컬 서버는 `127.0.0.1`에서만 수신합니다.

자동 검증은 PGlite의 실제 Postgres 엔진에서 마이그레이션·RLS·권한·승인·일일 한도·모의 거래·버전별 집계를 실행하고, API 모킹과 jsdom으로 CSRF·출력 검증·UI 전환을 검사합니다. 실제 Supabase, 모델 API, Binance 계정 연결은 별도 키 설정 후 확인해야 합니다. 실제 브라우저 시각 검증과 테스트넷 주문 통합 검증은 아직 수행하지 않았습니다.

## 다음 실거래 단계

테스트넷 주문 경로, 승인된 정확한 조건만 해석하는 실행기, 거래소 보호 주문 확인·실패 시 정리, 중복/불명 주문 조회 후 복구, 실현·미실현·비용 합산 한도, 부분 체결·분할 청산의 전략 버전별 귀속, 재시작 복구를 구현·검증해야 합니다. API 키를 입력하는 것만으로 이 단계가 완료되지는 않습니다.
