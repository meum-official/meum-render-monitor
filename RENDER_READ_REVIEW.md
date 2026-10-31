# 공개 렌더링 GET 검토

2026-10-31 로컬 제품 소스의 라우터, 호출 서비스, 모델 hook, 공통 미들웨어를 읽기 전용으로 검토했다. 제품·DB는 변경하거나 배포하지 않았다. 이 기록은 운영 배포 revision의 일치를 증명하지 않는다. 제품 source/deployed revision은 계속 `unknown`이다.

허용은 새 브라우저 컨텍스트의 비인증 화면에 한정한다. 정확한 backend origin, GET, fetch/xhr, 대상 페이지, 쿼리 키·값을 확인하며 Authorization·Cookie가 있는 신규 요청은 허용하지 않는다. 다른 workspace API, 다른 소유자, 추가 쿼리, POST, WebSocket 허용으로 확대하지 않는다. 기존 HTTP 접근 로그와 S3 조회 로그는 발생할 수 있다.

| 요청 | 확인한 제품 소스 | 부작용 검토 결과 |
| --- | --- | --- |
| `/api/archive/owners?activeOnly=0&limit=50&offset=…` | `.api/archive/archive.js` → `archiveService.findArchiveOwners` | `api_room.findAll/count`, 프로필 JOIN. 조회수·상태·작업공간 생성 호출 없음. offset은 실제 목록 페이지 번호와 일치해야 한다. |
| `/api/archive/owners/:ownerId` | 같은 라우터 → `archiveService.findPublicArchiveOwner` | 공개 아카이브와 프로필 SELECT, 최대 2행. 대상 페이지의 `i` 값과 같은 ID만 허용. |
| `/api/archive/rooms?ownerId=…&limit=50&offset=0` | 같은 라우터 → `archiveService.findArchiveRoomsByOwner` | SELECT/COUNT 후 `enrichArchiveRoomMedia`. 썸네일·포스터는 `roomService` → `s3.getImageFilesByPrefix` → `ListObjectsV2Command`만 사용. 업로드·삭제·DB 저장 없음. |
| `/api/workspaces/creator/ws_…` | `routes/workspaces.js`의 `router.use(jwt.auth)` 이전 공개 라우트 → `creatorMetaService.getCreatorPageMetadata`, `roomService.findAllWorkspaceRooms` | 공개 workspace·조직·전시 SELECT와 S3 목록 조회. `userId=null` 경로이며 개인 작업공간 보완 생성·초대·권한 변경 없음. 대상 창작자 public ID와 같은 경로만 허용. |

공통 `middleware/exhibitionReadAccess.js`는 위 목록·소유자·창작자 경로에 전시 접근/비밀번호 guard를 적용하지 않는다. `models/index.js`와 관련 모델의 조회 후 hook은 없으며 `legacyModelUrls` hook은 저장 시에만 실행한다. `getRawQueryDistinguishMeumIsExpired`는 SELECT의 CASE 표현식이며 상태 갱신을 하지 않는다. 각 공개 호출 경로에 analytics ingest·카운터 갱신·토큰 발급 호출이 없다.

새로 확인된 필수 데이터 의존성에는 essential 역할을 부여한다. 실제 HTTP 4xx/5xx·네트워크 실패·독립적인 JS 오류는 계속 실패로 판정한다. 모니터가 차단한 요청만 미확인으로 판정하며 성공으로 바꾸지 않는다.

## 계속 차단하는 요청

- `TeacherGuide.vue`는 `https://www.youtube.com/embed/…` 문서를 자동 로드한다. 제3자 플레이어의 추적·추가 요청이 없다는 근거를 확인할 수 없어 문서 탐색을 계속 차단한다. 외부 출처 wildcard나 YouTube 전체를 허용하지 않는다. 자동 외부 로드 없이 화면을 검증하려면 8301에서 정적 포스터/명시적 클릭 로드 같은 제품 변경이 필요하다. 이는 이번 작업에 포함하지 않는다.
- `/api/rooms/:id/password/status` 등 기존 변경 가능 GET과 `/api/rooms/roomById` POST는 그대로 차단한다. 제품 쪽 순수 조회 경로 분리와 배포가 필요하다. 새 GET 경로를 만들면 이를 사용하는 8301/8303 클라이언트 반영도 필요하다.
- 로그인·인증 업무 11개는 집계 대상이 아니다. 이번 허용은 인증 정보나 새로운 권한을 요구하지 않는다.
