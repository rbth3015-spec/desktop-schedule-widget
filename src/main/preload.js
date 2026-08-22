// 렌더러에 노출되는 유일한 다리. CONTRACT.md 의 window.api 인터페이스를 그대로 구현한다.
// ipcRenderer 자체는 절대 노출하지 않는다.

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // ------------------------------------------------------------ 데이터
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),

  // ------------------------------------------------------------ 창 제어
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    hide: () => ipcRenderer.send('window:hide'),
    setAlwaysOnTop: (on) => ipcRenderer.send('window:setAlwaysOnTop', !!on),
    setIgnoreMouseEvents: (on) => ipcRenderer.send('window:setIgnoreMouseEvents', !!on),
    getBounds: () => ipcRenderer.invoke('window:getBounds'),
    setSize: (w, h) => ipcRenderer.send('window:setSize', Number(w), Number(h)),
    snapPreset: (preset) => ipcRenderer.send('window:snapPreset', String(preset)),
  },

  // ------------------------------------------------------------ 앱 설정
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getAutoLaunch: () => ipcRenderer.invoke('app:getAutoLaunch'),
    setAutoLaunch: (on) => ipcRenderer.invoke('app:setAutoLaunch', !!on),

    /**
     * 메인이 '지금 저장을 마무리하라'고 요청할 때 불린다 (창 숨김 / 앱 종료 직전).
     * 저장은 250ms 디바운스라, 마지막 편집 직후 종료하면 그대로 날아간다.
     * 콜백이 끝나면 같은 token 으로 ack 를 돌려줘야 메인이 종료를 이어간다.
     */
    onFlushRequest: (cb) => {
      if (typeof cb !== 'function') return;
      ipcRenderer.on('app:flush', (_event, token) => {
        Promise.resolve(cb()).finally(() => ipcRenderer.send('app:flushed', token));
      });
    },
  },

  // ------------------------------------------------------------ 데이터 내보내기/가져오기
  data: {
    /** 저장 위치를 묻고 문자열을 파일로 쓴다 */
    saveAs: (opts) => ipcRenderer.invoke('data:saveAs', {
      title: String(opts?.title ?? ''),
      defaultName: String(opts?.defaultName ?? 'export.txt'),
      content: String(opts?.content ?? ''),
      filters: opts?.filters,
    }),
    /** 파일을 골라 텍스트로 읽는다. 취소하면 null */
    openFile: (opts) => ipcRenderer.invoke('data:openFile', {
      title: String(opts?.title ?? ''),
      filters: opts?.filters,
    }),
    openBackups: () => ipcRenderer.invoke('data:openBackups'),
  },

  // ------------------------------------------------------------ 리마인더 알림
  reminder: {
    /** OS 알림을 띄운다. {title, body, taskId} */
    notify: (payload) => ipcRenderer.invoke('reminder:notify', {
      title: String(payload?.title ?? ''),
      body: String(payload?.body ?? ''),
      taskId: String(payload?.taskId ?? ''),
    }),
    /** 알림을 클릭했을 때 해당 taskId 를 받는다 */
    onClick: (cb) => {
      if (typeof cb !== 'function') return;
      ipcRenderer.on('reminder:click', (_event, taskId) => cb(taskId));
    },
  },

  // ------------------------------------------------------------ 외부 링크
  // 일정에 붙은 링크를 기본 브라우저로 연다. 프로토콜 검증은 메인이 다시 한다.
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', String(url)),

  // ------------------------------------------------------------ 퀵 런처
  launcher: {
    // 실행 대상 검증은 메인 프로세스가 다시 한다 (렌더러를 신뢰하지 않음).
    run: (item) => ipcRenderer.invoke('launcher:run', {
      kind: String(item?.kind ?? ''),
      target: String(item?.target ?? ''),
      args: Array.isArray(item?.args) ? item.args.map(String) : [],
      label: String(item?.label ?? ''),
    }),
    cancel: (jobId) => ipcRenderer.invoke('launcher:cancel', String(jobId)),
    /** 파일/폴더 선택 창. mode: 'file' | 'folder'. 취소하면 null */
    pick: (mode) => ipcRenderer.invoke('launcher:pick', mode === 'folder' ? 'folder' : 'file'),
    /** 실행 상태 스트림: {jobId, state:'running'|'done'|'error', output, error, code} */
    onStatus: (cb) => {
      if (typeof cb !== 'function') return;
      ipcRenderer.on('launcher:status', (_event, status) => cb(status));
    },
  },

  // ------------------------------------------------------------ 트레이 요약
  // 창을 열지 않아도 오늘 몫을 알 수 있도록 렌더러가 주기적으로 보고한다.
  // 문자열/숫자만 넘긴다 — 태스크 객체를 통째로 보내지 않는다.
  tray: {
    setSummary: (summary) => ipcRenderer.send('tray:summary', {
      today: Number(summary?.today) || 0,
      overdue: Number(summary?.overdue) || 0,
      items: Array.isArray(summary?.items)
        ? summary.items.slice(0, 5).map((it) => ({
            id: String(it?.id ?? ''),
            title: String(it?.title ?? '').slice(0, 60),
            time: String(it?.time ?? ''),
            done: !!it?.done,
          }))
        : [],
    }),
  },

  // ------------------------------------------------------------ 트레이 메뉴 -> 렌더러
  // 'today' | 'settings' | 'toggle-completed' | 'brief' | 'roll-overdue'
  // | 'open-task:<id>' (+ 전역 단축키 해제 시 'unlock')
  onMenuAction: (cb) => {
    if (typeof cb !== 'function') return;
    // 이벤트 객체는 넘기지 않는다 — 액션 문자열만 전달.
    ipcRenderer.on('menu:action', (_event, action) => cb(action));
  },
};

contextBridge.exposeInMainWorld('api', api);
