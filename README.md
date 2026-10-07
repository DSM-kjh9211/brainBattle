# BrainBattle

교사가 문제를 출제하고 학생이 실시간으로 답안을 제출하며, **서버가 채점·점수·순위를 관리**하는 교육용 실시간 문제 풀이·경쟁 플랫폼입니다.

- **Digital Question** — 문제 → 답안 → 채점 → 점수
- **Paper Battle** — 종이 문제지 + 디지털 답안 입력 + 실시간 채점 + 실시간 점수판
- **Exam** — 시험 진행 + 답안 관리(수정 이력) + 채점(부분 점수) + 결과 분석

교사는 **AI(Claude)로 문제 출제·문제 검토·문제 세트 생성**을 할 수 있습니다(`ANTHROPIC_API_KEY` 설정 시). AI 결과는 초안이며 교사가 확인한 문항만 저장됩니다.

학생은 설치 없이 웹으로 참가하고, 교사는 웹 또는 데스크톱 앱(Electron, 프로젝터 듀얼 모니터 지원)을 사용합니다.
Dedicated Server 방식이며 세션 상태·시간·채점·순위의 최종 권한은 서버에 있습니다.

> 상세 설계(요구사항 분석, 도메인 모델, 아키텍처, DB 스키마·인덱스, 상태 머신, WebSocket 명세, 시간 동기화·Timestamp Trust 알고리즘, 채점·랭킹, API, 권한, 화면 구조, 요구사항 충돌과 해결): **[docs/DESIGN.md](docs/DESIGN.md)**

---

## 구성 요소

| 경로 | 설명 | 기술 |
|---|---|---|
| `packages/shared` | 서버·클라이언트 공용: WebSocket 프로토콜(zod 스키마), 상태 머신, 프리셋, 시간 동기화 추정기, 수식 단축키 | TypeScript, zod |
| `apps/server` | Battle Server: REST API + WebSocket, 세션 액터, 채점·랭킹 엔진, 세션 소유권(lease)·장애 복구 | Node.js 20+, Fastify 5, ws, PostgreSQL (개발/테스트: PGlite) |
| `apps/web` | Student / Teacher / Scoreboard(Presentation) 웹 클라이언트 | React 19, Vite 7, MathLive, dnd-kit |
| `apps/desktop` | 교사용 데스크톱 앱(웹 클라이언트를 그대로 사용하는 보안 셸 + 발표 창/듀얼 모니터) | Electron |
| `deploy/` | 수평 확장 예시(Battle Server 2대 + nginx) | Docker Compose |

## 아키텍처 개요

```
Student(Web) ─┐                                  ┌─ PostgreSQL (모든 권위 상태 영속)
Teacher(Web/  ├─ REST + WebSocket ─▶ Battle Server ┤
 Desktop)     │   (LB: ?sid= 해시)   ├ Fastify REST  └─ session_leases (세션 소유 노드)
Scoreboard ───┘                      ├ WS Hub (인증·rate limit·권한·스키마 검증)
                                     └ SessionRuntime ×N (세션당 1 액터: 직렬 명령 처리,
                                        상태 머신, 서버 타이머, 채점, 증분 랭킹)
```

- **Server-authoritative**: 세션/문항 상태, 마감, 제출 가능 여부, 채점, 점수, 순위, 응답 시간은 모두 서버가 계산합니다.
- **영속 후 응답**: 모든 전이·제출은 PostgreSQL 트랜잭션 커밋 후에만 ACK/ANSWER_ACCEPTED를 보냅니다. 실시간 조회는 액터 메모리에서 제공(이벤트당 DB 조회 없음).
- **시간**: 클라이언트는 monotonic 시계 + 주기적 TIME_SYNC(30초)만 사용. 서버가 offset을 검증·재계산하여 `|수신 − 추정 제출 시각| < 1000ms`일 때만 클라이언트 시각을 채택(`CLIENT_TRUSTED`), 아니면 `SERVER_FALLBACK`.
- **재접속**: `participantId ≠ connectionId`. resume token으로 identity·답안·점수·현재 문제를 복구, 제출은 로컬 pending queue + idempotency key로 1회만 적용.
- **확장/복구**: 세션별 소유권 lease. 노드 장애 시 lease 만료 후 다른 노드가 DB에서 세션을 재수화하고 절대 시각 마감 타이머를 재구성합니다.

## 개발 환경

- Node.js **20 이상** (22/24 권장), npm 10+
- (선택) Docker — PostgreSQL/배포용. 로컬 개발은 **PGlite**(내장 PostgreSQL)로 DB 설치 없이 동작합니다.
- 데스크톱 앱 개발 시 Electron 바이너리(설치 시 자동 다운로드)

```bash
npm install
```

(Electron 바이너리 다운로드가 생략된 경우: `node node_modules/electron/install.js`)

## 실행 방법

### 1) 개발 모드 (DB 설치 불필요)

```bash
npm run seed
```

데모 교사 `teacher@brainbattle.local / brainbattle123` 과 문제 세트 3개(라이브 퀴즈 · 종이 경시대회 · 디지털 시험)를 만듭니다. (데이터: `apps/server/.data/pglite`)

```bash
npm run dev:server
```

```bash
npm run dev:web
```

- 웹: http://localhost:5173 (Vite 프록시가 `/api`, `/ws`를 서버 :4000으로 전달)
- 교사: http://localhost:5173/teacher/login → 문제 세트 → "세션 시작" → 프리셋 선택 → 대시보드에서 **대기실 열기 / 시작**
- 학생: 다른 브라우저(또는 휴대폰)에서 http://<PC-IP>:5173 → 참가 코드 입력
- 발표 화면: 대시보드의 "🖥 발표 화면 열기" (점수판 전용 읽기 토큰으로 열림)

### 2) 데스크톱 앱 (교사용)

```bash
npm run dev:desktop
```

기본 서버 주소: 개발 `http://localhost:5173`, 배포 빌드 `http://localhost:4000` (메뉴 → 서버 주소 변경, 또는 `BRAINBATTLE_URL`). 설치 파일 생성: `npm run dist -w @brainbattle/desktop`.

### 3) 프로덕션 (단일 서버, 한 origin에서 웹+API 제공)

```bash
npm run build
```

```bash
NODE_ENV=production JWT_SECRET=<32자 이상> DATABASE_URL=postgres://user:pass@host:5432/brainbattle WEB_DIST=apps/web/dist CORS_ORIGINS=https://quiz.example.school node apps/server/dist/main.js
```

## 환경 변수

`.env.example` 참고. 주요 항목:

| 변수 | 기본값 | 설명 |
|---|---|---|
| `DATABASE_URL` | `pglite://./.data/pglite` | `postgres://…`(운영) / `pglite://<dir>`(개발) / `pglite://memory`(테스트) |
| `JWT_SECRET` | (개발: 임시 생성) | **운영 필수**, 32자 이상 |
| `PORT`, `HOST` | `4000`, `0.0.0.0` | |
| `CORS_ORIGINS` | 개발 `*`, 운영 없음 | REST·WebSocket 허용 Origin(쉼표 구분) |
| `ALLOW_TEACHER_SIGNUP` | 개발 `true`, 운영 `false` | 교사 자가 가입 허용 |
| `WEB_DIST` | — | 설정 시 서버가 빌드된 웹 앱을 함께 제공(SPA fallback) |
| `NODE_ID`, `NODE_PUBLIC_URL` | 호스트명-pid / — | 다중 노드: 노드 식별자, 다른 노드가 리다이렉트할 이 노드의 주소 |
| `SESSION_LEASE_TTL_MS` | `15000` | 세션 소유권 lease TTL(장애 시 인수까지 걸리는 시간) |
| `SESSION_IDLE_UNLOAD_MS` | `600000` | 종료·무연결 세션을 메모리에서 내리는 시간 |
| `WS_HEARTBEAT_MS` | `15000` | ping 주기(미응답 시 DISCONNECTED) |
| `LEADERBOARD_SNAPSHOT_MS` | `5000` | 전체 순위 스냅샷 주기 |
| `TIMESTAMP_TRUST_WINDOW_MS` | `1000` | 클라이언트 시각 신뢰 창 |
| `AUTH_RATE_LIMIT_PER_MIN`, `API_RATE_LIMIT_PER_MIN` | `20`, `600` | REST rate limit |
| `ANTHROPIC_API_KEY` | — | AI 출제·검토 기능용 Claude API 키. 비어 있으면 AI 기능 비활성화 |
| `AI_MODEL`, `AI_RATE_LIMIT_PER_MIN` | `claude-opus-5-5`, `10` | AI 모델, AI 요청 rate limit |
| `VITE_API_URL`, `VITE_WS_URL` | 같은 origin | 웹 빌드 시 API/WS가 다른 호스트일 때 |
| `BRAINBATTLE_URL` | — | 데스크톱 앱이 접속할 서버 |

## 테스트 방법

```bash
npm test
```

- `packages/shared/src/shared.test.ts` — 상태 머신, 시간 동기화 추정기, 프리셋/경고, 단축키(브라우저 예약 키 리매핑, IME 대응)
- `apps/server/test/domain.test.ts` — LaTeX 정규화, 채점 엔진, 점수 정책, **Timestamp Trust(500/999/1000ms, 조작, replay)**, TIME_SYNC 검증, 제출 창/일시정지, 랭킹·동점·공개 정책
- `apps/server/test/session.test.ts` — 실제 서버 + WebSocket 클라이언트 + 제어 가능한 서버 시계로 §41의 모든 시나리오(참가, 잘못된 코드/brute force, 중복 참가, 재연결, 제출/중복/연결 끊김/오프라인 replay, deadline 전후, 시각 차이, 시계 조작, 일시정지/재개, 수정/수정 불가, 점수 변경, 동점, 점수판, score hold, 권한, 타 학생 답안 수정 시도, 종료/결과 공개, CRUD)
- `apps/server/test/recovery.test.ts` — 노드 장애 → lease 만료 → 다른 노드가 세션 복구, 마감 타이머 재구성

타입 검사: `npm run typecheck`

## 배포 방법

### Docker Compose (서버 1대 + PostgreSQL)

```bash
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
```

```bash
docker compose up -d --build
```

http://localhost:4000 에서 웹·API·WebSocket을 한 origin으로 제공합니다. 운영 시에는 앞단에 TLS 종료(https/wss) 리버스 프록시를 두고 `CORS_ORIGINS`를 실제 도메인으로 설정하세요. 첫 교사 계정은 `ALLOW_TEACHER_SIGNUP=true`로 가입 후 `false`로 바꾸는 것을 권장합니다.

### 수평 확장 (Battle Server 여러 대)

```bash
docker compose -f deploy/docker-compose.scale.yml up -d --build
```

- nginx가 WebSocket을 `?sid=` 해시로 세션 소유 노드에 라우팅(`deploy/nginx.conf`)
- 잘못 라우팅된 첫 참가는 서버가 `SESSION_OWNED_ELSEWHERE {ownerUrl}`로 리다이렉트(클라이언트 자동 처리)
- 노드 장애 시 `SESSION_LEASE_TTL_MS` 후 다른 노드가 PostgreSQL에서 세션을 복구

## 주요 사용 흐름

| 상황 | 교사 | 학생 |
|---|---|---|
| Live Quiz | 프리셋 Live Quiz → 시작 → "다음 문제 시작"(카운트다운) → 마감/결과 공개 → 점수판 | 문제·선택지 표시, 제출 후 문항 종료 시 정오·점수 공개 |
| Paper Battle | 종이 문제지 배부, 프리셋 Paper Battle → 시작, Matrix로 진행 확인 | "문제 7번 / 답: [ ]" 답안지, 번호 그리드(✓ ● -)에서 자유 이동 |
| Exam | 프리셋 Exam(순위 비공개) → 종료 → 서술형 부분 점수 채점 → "결과 공개" | 답안 수정 가능, 종료 후 결과 확인 |

수식 입력: 툴바 또는 단축키(`Ctrl+/` 분수, `Ctrl+R` 루트, `Ctrl+2` 제곱 — 웹에서는 `Alt+2`, `Ctrl+P` π) 또는 `/frac`, `/sqrt`, `/pi` 같은 슬래시 명령. `Tab`으로 분자→분모 이동. 단축키는 `/settings`에서 기기별로 변경할 수 있습니다.
