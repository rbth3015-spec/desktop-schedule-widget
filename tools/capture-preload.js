// 미리보기용 표본 — 실제 앱은 메인 프로세스가 월력요항 자료를 받아 온다
const SAMPLE_HOLIDAYS = {
  '2026-01-01': ['1월 1일'],
  '2026-02-16': ['설날 전날'], '2026-02-17': ['설날'], '2026-02-18': ['설날 다음 날'],
  '2026-03-01': ['3ㆍ1절'], '2026-03-02': ['대체공휴일(3ㆍ1절)'],
  '2026-05-01': ['노동절'], '2026-05-05': ['어린이날'],
  '2026-05-24': ['부처님 오신 날'], '2026-05-25': ['대체공휴일(부처님 오신 날)'],
  '2026-06-06': ['현충일'], '2026-07-17': ['제헌절'],
  '2026-08-15': ['광복절'], '2026-08-17': ['대체공휴일(광복절)'],
  '2026-09-24': ['추석 전날'], '2026-09-25': ['추석'], '2026-09-26': ['추석 다음 날'],
  '2026-10-03': ['개천절'], '2026-10-05': ['대체공휴일(개천절)'],
  '2026-10-09': ['한글날'], '2026-12-25': ['기독탄신일'],
};

function sampleHolidays(years) {
  const days = {};
  for (const [k, v] of Object.entries(SAMPLE_HOLIDAYS)) {
    if (years.includes(Number(k.slice(0, 4)))) days[k] = v;
  }
  return { days, missing: [] };
}

// 캡처 전용 preload. 실제 사용자 데이터를 절대 읽거나 쓰지 않고,
// 디자인 검토용 샘플 데이터만 메모리에서 제공한다.

const { contextBridge } = require('electron');

const d0 = new Date();
const day = (n) => {
  const d = new Date(d0);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const t = (o) => ({ notes: '', tags: [], priority: 0, color: 'blue', done: false, createdAt: Date.now(), ...o });

const SAMPLE = {
  version: 1,
  // 첫 실행 안내와 아침 브리핑은 다른 컷을 덮으므로 기본은 꺼 둔다.
  // 그 화면을 찍고 싶으면 --set '{"seenWelcome":false}' / '{"lastBriefDate":""}' 로 되돌린다.
  settings: { seenWelcome: true, lastBriefDate: day(0) },
  launcher: [
    { id: 'l_cal', label: '구글 캘린더', icon: '', kind: 'url', target: 'https://calendar.google.com', order: 0 },
    { id: 'l_mail', label: '메일', icon: '', kind: 'url', target: 'https://mail.google.com', order: 1 },
    { id: 'l_py', label: '주간 백업', icon: '', kind: 'script', target: 'C:\\scripts\\backup.py', order: 2 },
  ],
  reminderLog: [
    { id: 'r1', taskId: 't1', title: '아침 스탠드업 회의', at: Date.now() - 42 * 60000 },
    { id: 'r2', taskId: 's4', title: '월간 보고서 마감', at: Date.now() - 5 * 3600000 },
  ],
  tasks: [
    t({ id: 's1', title: '정보처리기사 실기 대비', notes: '기출 5개년 정리', start: day(-6), end: day(12), color: 'violet', priority: 2, tags: ['자격증'], pinned: true, order: 0 }),
    t({ id: 's2', title: '팀 프로젝트 스프린트', start: day(-2), end: day(5), color: 'green', priority: 1, tags: ['업무'], order: 1 }),
    t({ id: 's3', title: '여름 휴가', notes: '강릉', start: day(16), end: day(20), color: 'amber', tags: ['개인'], order: 2 }),
    t({ id: 's4', title: '월간 보고서 마감', start: day(3), end: day(3), color: 'rose', priority: 2, tags: ['업무'], pinned: true, remind: '1@18:00', order: 3 }),

    // 오늘 — 시각이 있는 것은 목록 위쪽에 시간순으로 선다
    t({ id: 't0', title: '운동 40분', start: day(0), end: day(0), startTime: '07:00', color: 'amber', tags: ['건강'], repeat: { freq: 'weekly', interval: 1, until: null }, order: 4 }),
    t({ id: 't1', title: '아침 스탠드업', notes: '지난주 액션 아이템 확인', start: day(0), end: day(0), startTime: '09:30', endTime: '10:00', color: 'blue', priority: 1, tags: ['업무'], link: 'https://meet.google.com/abc-defg', remind: '-10m', order: 5 }),
    t({ id: 't2', title: '디자인 리뷰', start: day(0), end: day(0), startTime: '14:00', color: 'violet', tags: ['업무'], order: 6 }),
    t({ id: 't3', title: '치과 예약', start: day(0), end: day(0), startTime: '18:30', color: 'rose', priority: 1, remind: '-60m', order: 7 }),
    t({ id: 't4', title: '장보기 — 우유, 계란', start: day(0), end: day(0), color: 'green', tags: ['개인'], order: 8 }),
    t({ id: 't5', title: '이메일 정리', start: day(0), end: day(0), done: true, doneAt: Date.now(), color: 'slate', order: 9 }),

    // 기한이 지났는데 안 끝난 일 — '지난 일' 섹션과 아침 브리핑에 잡힌다
    t({ id: 'o1', title: '세금계산서 발행', start: day(-3), end: day(-3), color: 'rose', priority: 2, tags: ['업무'], order: 10 }),
    t({ id: 'o2', title: '건강검진 예약', start: day(-9), end: day(-9), color: 'green', priority: 1, order: 11 }),

    t({ id: 'i1', title: '책상 정리하기', start: null, end: null, color: 'slate', order: 12 }),
    t({ id: 'i2', title: '포트폴리오 사이트 리뉴얼', start: null, end: null, color: 'violet', priority: 1, tags: ['개인'], order: 13 }),
  ],
};

// --empty 로 '방금 설치한 상태'(일정 0건)를 찍을 수 있다
if (process.env.CAPTURE_EMPTY === '1') {
  SAMPLE.tasks = [];
  SAMPLE.reminderLog = [];
}

const overrides = JSON.parse(process.env.CAPTURE_SETTINGS || '{}');
SAMPLE.settings = { ...SAMPLE.settings, ...overrides };

const noop = () => {};

// contextBridge 로 노출된 객체는 동결되어 페이지에서 가로챌 수 없다.
// 내보내기 내용을 검증할 수 있도록 별도 통로를 둔다.
let lastSaveAs = null;
let nextOpenFile = null;   // 다음 openFile 호출이 돌려줄 내용
let lastTraySummary = null;

contextBridge.exposeInMainWorld('api', {
  loadData: async () => JSON.parse(JSON.stringify(SAMPLE)),
  saveData: async () => ({ ok: true }),          // 저장하지 않는다
  window: {
    minimize: noop, hide: noop, setAlwaysOnTop: noop, setOpacity: noop,
    setIgnoreMouseEvents: noop, setSize: noop, snapPreset: noop,
    getBounds: async () => ({ x: 0, y: 0, width: 1100, height: 700 }),
  },
  reminder: { notify: async () => ({ ok: true }), onClick: noop },
  // 캡처 환경에서는 파일을 쓰지 않는다. 마지막 요청은 captureProbe 로 확인할 수 있다.
  data: {
    saveAs: async (o) => {
      lastSaveAs = { title: o?.title, defaultName: o?.defaultName, content: o?.content };
      return { ok: true, path: o?.defaultName || '' };
    },
    openFile: async () => {
      const t = nextOpenFile;
      nextOpenFile = null;
      return t === null ? null : { ok: true, path: 'test.json', text: t };
    },
    openBackups: async () => ({ ok: true, path: '' }),
  },
  app: {
    getVersion: async () => ({ version: require('../package.json').version, packaged: true }),
    getAutoLaunch: async () => ({ ok: true, enabled: false, dev: true }),
    setAutoLaunch: async () => ({ ok: true, enabled: false }),
    onFlushRequest: noop,
  },
  // 캡처 창에는 트레이가 없다. 렌더러가 보고한 요약은 확인용으로만 담아 둔다.
  tray: { setSummary: (s) => { lastTraySummary = s; } },
  holidays: { get: async (years) => sampleHolidays(years) },
  openExternal: async () => ({ ok: true }),
  launcher: {
    run: async () => ({ ok: true }),
    cancel: async () => ({ ok: true }),
    pick: async () => null,
    onStatus: noop,
  },
  onMenuAction: noop,
});

contextBridge.exposeInMainWorld('captureProbe', {
  lastSaveAs: () => lastSaveAs,
  lastTraySummary: () => lastTraySummary,
  setNextOpenFile: (text) => { nextOpenFile = text; },
});
