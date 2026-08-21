// 개발 전용. dev.html 에서만 로드된다 (index.html 은 참조하지 않음).
// Electron 을 띄우지 않고 브라우저에서 렌더러 UI 를 확인·수정하기 위한 window.api 모의 구현.
// 데이터는 localStorage 에만 저장되며 실제 앱 데이터와 무관하다.

(function () {
  const KEY = 'schedule-widget-dev';

  // 오늘 기준 상대 날짜 키 (샘플 데이터가 언제 열어도 의미 있도록)
  const d0 = new Date();
  const day = (n) => {
    const d = new Date(d0);
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const SAMPLE = {
    version: 1,
    settings: {},
    tasks: [
      { id: 's1', title: '정보처리기사 실기 대비', notes: '기출 5개년', start: day(-6), end: day(12),
        color: 'violet', priority: 2, tags: ['자격증'], pinned: true, order: 0, createdAt: Date.now() },
      { id: 's2', title: '팀 프로젝트 스프린트', notes: '', start: day(-2), end: day(5),
        color: 'green', priority: 1, tags: ['업무'], order: 1, createdAt: Date.now() },
      { id: 's3', title: '여름 휴가', notes: '강릉', start: day(16), end: day(20),
        color: 'amber', priority: 0, tags: ['개인'], order: 2, createdAt: Date.now() },
      { id: 's4', title: '월간 보고서 마감', notes: '', start: day(3), end: day(3),
        color: 'rose', priority: 2, tags: ['업무'], pinned: true, order: 3, createdAt: Date.now() },

      { id: 't1', title: '아침 스탠드업 회의', notes: '', start: day(0), end: day(0),
        color: 'blue', priority: 1, tags: ['업무'], order: 4, createdAt: Date.now() },
      { id: 't2', title: '장보기 — 우유, 계란', notes: '', start: day(0), end: day(0),
        color: 'green', priority: 0, tags: ['개인'], order: 5, createdAt: Date.now() },
      { id: 't3', title: '이메일 정리', notes: '', start: day(0), end: day(0), done: true,
        color: 'slate', priority: 0, tags: [], order: 6, createdAt: Date.now(), doneAt: Date.now() },
      { id: 't4', title: '운동 40분', notes: '', start: day(0), end: day(0),
        color: 'amber', priority: 0, tags: ['건강'], order: 7, createdAt: Date.now() },
      { id: 't5', title: '치과 예약 확인', notes: '', start: day(1), end: day(1),
        color: 'rose', priority: 1, tags: [], order: 8, createdAt: Date.now() },
      { id: 't6', title: '전기요금 납부', notes: '', start: day(2), end: day(2),
        color: 'blue', priority: 0, tags: [], order: 9, createdAt: Date.now() },

      { id: 'i1', title: '책상 정리하기', notes: '', start: null, end: null,
        color: 'slate', priority: 0, tags: [], order: 10, createdAt: Date.now() },
      { id: 'i2', title: '포트폴리오 사이트 리뉴얼', notes: '', start: null, end: null,
        color: 'violet', priority: 1, tags: ['개인'], order: 11, createdAt: Date.now() },
    ],
  };

  let win = { x: 100, y: 100, width: 980, height: 620 };

  window.api = {
    loadData: async () => {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(SAMPLE);
      try { return JSON.parse(raw); } catch { return structuredClone(SAMPLE); }
    },
    saveData: async (data) => {
      localStorage.setItem(KEY, JSON.stringify({ version: 1, ...data }));
      return { ok: true };
    },
    window: {
      minimize: () => console.log('[dev] minimize'),
      hide: () => console.log('[dev] hide'),
      setAlwaysOnTop: (on) => console.log('[dev] alwaysOnTop', on),
      // 브라우저에서는 창 투명도를 흉내 낼 수 없으므로 무시한다 (레이아웃 확인이 목적)
      setOpacity: (v) => console.log('[dev] opacity', v),
      setIgnoreMouseEvents: (on) => console.log('[dev] ignoreMouse', on),
      getBounds: async () => ({ ...win }),
      setSize: (w, h) => { win.width = w; win.height = h; console.log('[dev] setSize', w, h); },
      snapPreset: (p) => console.log('[dev] preset', p),
    },
    // 브라우저에서는 파일 대화상자를 띄울 수 없으므로 다운로드/업로드로 흉내 낸다
    data: {
      saveAs: async ({ defaultName, content }) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
        a.download = defaultName || 'export.txt';
        a.click();
        URL.revokeObjectURL(a.href);
        return { ok: true, path: defaultName };
      },
      openFile: async () => new Promise((resolve) => {
        const i = document.createElement('input');
        i.type = 'file';
        i.onchange = () => {
          const f = i.files?.[0];
          if (!f) return resolve(null);
          const r = new FileReader();
          r.onload = () => resolve({ ok: true, path: f.name, text: String(r.result) });
          r.readAsText(f);
        };
        i.click();
      }),
      openBackups: async () => ({ ok: true, path: '(dev)' }),
    },

    // 브라우저에는 OS 알림을 띄울 수 없으므로 콘솔로만 확인한다
    reminder: {
      notify: async (payload) => { console.log('[dev] notify', payload); return { ok: true }; },
      onClick: (cb) => { window.__devReminderClick = cb; },
    },

    app: {
      getAutoLaunch: async () => ({ ok: true, enabled: false, dev: true }),
      setAutoLaunch: async () => ({ ok: false, dev: true, error: '개발 실행 중에는 설정되지 않습니다.' }),
    },

    openExternal: async (url) => {
      console.log('[dev] openExternal', url);
      try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return { ok: false, error: 'http/https 주소만 열 수 있습니다.' };
        }
      } catch {
        return { ok: false, error: '올바른 주소가 아닙니다.' };
      }
      return { ok: true };
    },

    // 브라우저에서는 실제 실행이 불가하므로 진행 상태만 흉내 낸다.
    launcher: {
      run: async (item) => {
        if (item.kind === 'url') { console.log('[dev] open', item.target); return { ok: true }; }
        const jobId = 'devjob_' + Math.random().toString(36).slice(2, 7);
        const cb = window.__devLauncherStatus;
        if (cb) {
          setTimeout(() => cb({ jobId, state: 'running', output: '작업을 시작합니다...\n' }), 60);
          setTimeout(() => cb({ jobId, state: 'running', output: '작업을 시작합니다...\n처리 중 45%\n' }), 900);
          setTimeout(() => cb({ jobId, state: 'done', code: 0, output: '완료되었습니다.\n' }), 2200);
        }
        return { ok: true, jobId };
      },
      cancel: async () => ({ ok: true }),
      pick: async (mode) => (mode === 'folder' ? 'C:\\Users\\dev\\Documents' : 'C:\\Users\\dev\\scripts\\backup.py'),
      onStatus: (cb) => { window.__devLauncherStatus = cb; },
    },

    onMenuAction: (cb) => { window.__devMenuAction = cb; },
  };

  // 콘솔에서 __devReset() 으로 샘플 데이터 복원
  window.__devReset = () => { localStorage.removeItem(KEY); location.reload(); };
})();
