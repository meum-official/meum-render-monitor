// Business success needs an approved isolated dataset; rendering a page proves none of these writes.
const admin = '8302_adminMeum-master';
const web = '8301_front-end';
const backend = '8080_meum-backend-api-develop/meum-backend-api-develop';
const make = (id, name, role, action, expectedPersistence, destination, sources, extra = {}) => ({
  id, name, role, action, expectedPersistence, destination,
  language: ['ko', 'en'], mutates: true,
  preconditions: ['운영 데이터와 분리된 승인된 서버·기존 테스트 계정·기존 테스트 전시', '원본 소스 해시와 서버 격리 marker 일치', '운영 출처·결제사·메시지·계정 생성 요청 차단'],
  sources, ...extra,
});

export const BUSINESS_CONTRACTS = [
  make('viewer-settings-owner', '소유자 관람 설정 저장·재조회', 'owner', '채팅 ON/OFF 변경 후 UI 저장, 독립 GET 및 새 화면 재진입', 'solution_json에 명시적 OFF 보존; 다른 전시와 권한·콘텐츠 불변', '/exhibition/experience', [`${admin}/src/components/exhibition/experience/ExhibitionExperience.vue`, `${admin}/src/store/userInfo.js`]),
  make('viewer-settings-invited-admin', '초대 관리자 관람 설정 저장·재조회', 'invited-admin', '기존 초대 관리자 세션으로 동일 설정 저장·재조회', '초대 권한이 허용한 전시만 변경되고 소유자와 동일한 저장값 재조회', '/exhibition/experience', [`${admin}/src/components/exhibition/experience/ExhibitionExperience.vue`, `${backend}/services/organizationRoomService.js`]),
  make('viewer-settings-readonly', '읽기 전용 멤버 저장 차단', 'read-only', 'UI 저장 비활성 및 서버 쓰기 거부 확인', '저장 0건; 원래 solution_json 유지', '/exhibition/experience', [`${admin}/src/components/exhibition/experience/ExhibitionExperience.vue`, `${backend}/services/organizationRoomService.js`]),
  make('auto-install', '작품 자동 설치·재실행 불변식', 'owner', '테스트 전시에 UI 자동 설치 후 독립 상세 GET; 같은 선택으로 다시 실행', '선택 작품 ID·개수·유한 좌표·시작점 검증; 원본 작품·설명 보존; 재실행 중복 없음', '/artwork', [`${admin}/src/components/artwork/modal/AutoSettingBox.vue`, `${backend}/services/roomService.js`]),
  make('survey-target-included', '설문 대상 제작자 노출', 'eligible-creator', '기존 유료 제작자 계정의 설문 조회·UI 노출 확인', '서버 eligibility.eligible=true; 지정된 동일 설문·문항 노출', '/exhibition-dashboard', [`${admin}/src/composables/useCreatorFeedback.js`, `${backend}/services/creatorVocEligibility.js`]),
  make('survey-target-excluded', '설문 제외 대상 비노출', 'excluded-creator', '제외 계정·스태프·대리접속에서 설문 조회', 'eligibility.eligible=false; 자동 팝업·응답 저장 0건', '/exhibition-dashboard', [`${backend}/routes/survey.js`, `${backend}/services/creatorVocEligibility.js`]),
  make('survey-submit-admin-read', '설문 제출·관리자 재조회', 'eligible-creator', 'UI 답변 제출 후 별도 관리자 세션 GET; 동일 request_key 재전송', '동일 사용자·설문에 응답 정확히 1건; 관리자 결과에 답변 일치; 중복 없음', '/exhibition-dashboard', [`${admin}/src/api/creatorFeedback.js`, '8304_testMeum-master/src/components/help/Survey.vue', `${backend}/routes/survey.js`]),
  make('payment-success-immediate', '모의 결제 성공·즉시 이용권', 'payer', '명시적 체험 종료 동의 후 모의 성공; 독립 이용권 재조회', '체험 expired·유료 active; 주문·금액·플랜·대상 일치; 지급 1회', '/plan', [`${web}/src/views/planSelect2.vue`, `${web}/src/composables/useTrialUpgrade.mjs`, `${backend}/services/paymentIntentService.js`], { requiresMockPayment: true }),
  make('payment-success-scheduled', '모의 예약 결제·체험 유지', 'payer', '체험 후 시작 선택 후 모의 성공; 독립 이용권 재조회', '체험 active 유지·유료 pending; 시작일은 기존 체험 종료일; 지급 1회', '/plan', [`${web}/src/views/planSelect2.vue`, `${backend}/services/billingService.js`], { requiresMockPayment: true }),
  make('payment-failure-cancel', '모의 실패·취소 시 이용권 보존', 'payer', '모의 실패와 취소를 각각 실행 후 독립 재조회', '체험 active 유지; 유료 이용권 없음; 지급·체험 전환 0회', '/plan', [`${web}/scripts/test-trial-upgrade-fixtures.mjs`, `${backend}/services/paymentIntentService.js`], { requiresMockPayment: true }),
  make('payment-duplicate-callback', '모의 중복 콜백·지급 멱등성', 'payer', '같은 모의 주문 완료 콜백 반복 후 독립 재조회', '주문·유료 이용권 ID 불변; 지급·체험 종료 각 1회', '/plan', [`${web}/scripts/test-trial-upgrade-fixtures.mjs`, `${backend}/routes/paymentWebhookV2.js`], { requiresMockPayment: true }),
];

// These are reviewed test sources, never arbitrary configuration paths or credential files.
export const BUSINESS_SOURCE_FILES = {
  'admin-experience-ui': `${admin}/src/components/exhibition/experience/ExhibitionExperience.vue`,
  'admin-experience-fixture': `${admin}/tests/invitationExperiencePolish.browser.mjs`,
  'admin-room-read': `${admin}/src/store/userInfo.js`,
  'auto-install-ui': `${admin}/src/components/artwork/modal/AutoSettingBox.vue`,
  'auto-install-ui-policy': `${admin}/src/policies/exhibitionPolicy.js`,
  'auto-install-confirm-ui': `${admin}/src/components/common/modal/ConfirmSmallModal.vue`,
  'auto-install-method': `${backend}/services/roomService.js`,
  'auto-install-memory-fixture': 'tools/meum-render-monitor/fixtures/business/auto-install.mjs',
  'auto-install-template': `${backend}/services/auto-install/land_10.json`,
  'auto-install-startpoints': `${backend}/services/auto-install/start-points.json`,
  'auto-install-autoplay': `${backend}/services/auto-play/land_10.json`,
  'auto-install-gallery-helper': `${backend}/utils/galleryDecoration.js`,
  'room-update-routes': `${backend}/.api/rooms/rooms.js`,
  'room-permissions': `${backend}/services/organizationRoomService.js`,
  'room-workspace-service': `${backend}/services/workspaceService.js`,
  'room-master-policy': `${backend}/utils/roomMaster.js`,
  'survey-api': `${admin}/src/api/creatorFeedback.js`,
  'survey-modal': `${admin}/src/components/feedback/CreatorFeedbackModal.vue`,
  'survey-admin': '8304_testMeum-master/src/components/help/Survey.vue',
  'survey-routes': `${backend}/routes/survey.js`,
  'survey-service': `${backend}/services/creatorVocService.js`,
  'survey-eligibility': `${backend}/services/creatorVocEligibility.js`,
  'survey-target-ui': `${admin}/src/composables/useCreatorFeedback.js`,
  'survey-state': `${admin}/src/utils/creatorFeedbackState.mjs`,
  'survey-loading': `${admin}/src/composables/useLoading.js`,
  'survey-policy': `${backend}/config/creatorVoc.js`,
  'survey-results-service': `${backend}/services/surveyService.js`,
  'survey-backend-fixture-test': `${backend}/test/unit/creatorVoc.test.js`,
  'survey-validator': `${backend}/middleware/validator.js`,
  'payment-component-server': `${web}/scripts/test-trial-upgrade-ui.mjs`,
  'payment-component-fixtures': `${web}/scripts/test-trial-upgrade-fixtures.mjs`,
  'payment-component': `${web}/src/views/planSelect2.vue`,
  'business-payment-server': 'tools/meum-render-monitor/fixtures/business/payment-server.mjs',
  'business-readonly-server': 'tools/meum-render-monitor/fixtures/business/readonly-server.mjs',
  'business-auto-install-server': 'tools/meum-render-monitor/fixtures/business/auto-install-server.mjs',
  'business-survey-server': 'tools/meum-render-monitor/fixtures/business/survey-server.mjs',
};

export const businessContract = id => BUSINESS_CONTRACTS.find(contract => contract.id === id);
