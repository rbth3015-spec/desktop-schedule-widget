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
  settings: {},
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

    t({ id: 't1', title: '아침 스탠드업 회의', start: day(0), end: day(0), color: 'blue', priority: 1, tags: ['업무'], link: 'https://meet.google.com/abc-defg', remind: '0@09:00', remindedAt: Date.now() - 42 * 60000, order: 4 }),
    t({ id: 't2', title: '장보기 — 우유, 계란, 커피', start: day(0), end: day(0), color: 'green', tags: ['개인'], order: 5 }),
    t({ id: 't3', title: '이메일 정리', start: day(0), end: day(0), done: true, doneAt: Date.now(), color: 'slate', order: 6 }),
    t({ id: 't4', title: '운동 40분', start: day(0), end: day(0), color: 'amber', tags: ['건강'], order: 7 }),
    t({ id: 't5', title: '치과 예약 확인', start: day(1), end: day(1), color: 'rose', priority: 1, order: 8 }),

    t({ id: 'i1', title: '책상 정리하기', start: null, end: null, color: 'slate', order: 9 }),
    t({ id: 'i2', title: '포트폴리오 사이트 리뉴얼', start: null, end: null, color: 'violet', priority: 1, tags: ['개인'], order: 10 }),
  ],
};

const overrides = JSON.parse(process.env.CAPTURE_SETTINGS || '{}');
SAMPLE.settings = { ...SAMPLE.settings, ...overrides };

const noop = () => {};

// contextBridge 로 노출된 객체는 동결되어 페이지에서 가로챌 수 없다.
// 내보내기 내용을 검증할 수 있도록 별도 통로를 둔다.
let lastSaveAs = null;
let nextOpenFile = null;   // 다음 openFile 호출이 돌려줄 내용

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
  setNextOpenFile: (text) => { nextOpenFile = text; },
});
