// Electron 메인 프로세스. 위젯 창 생성, 트레이 메뉴, 전역 단축키, IPC 라우팅을 담당한다.

const path = require('path');
const fs = require('fs');
const electron = require('electron');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  globalShortcut,
  shell,
  dialog,
  Notification,
} = electron;

// screen 모듈은 app 'ready' 이후에만 접근 가능하므로 호출 시점에 가져온다.
function getScreen() {
  return electron.screen;
}

// 데이터 저장 위치를 고정한다.
// Electron 의 userData 경로는 app.getName() 을 따르는데, 설치본은 productName('일정관리 비서'),
// 개발 실행은 package.json 의 name('schedule-widget') 이 되어 서로 다른 폴더를 쓴다.
// 그러면 설치 직후 기존 일정이 사라진 것처럼 보인다. 이름을 못박아 한 곳만 쓰게 한다.
// app.setPath 는 ready 이전에 호출해야 한다.
app.setPath('userData', path.join(app.getPath('appData'), 'schedule-widget'));

const storage = require('./storage');
const windowState = require('./windowState');
const runner = require('./runner');
const holidays = require('./holidays');

// ---------------------------------------------------------------- 상수

/** 트레이/작업표시줄 아이콘 (외부 파일 없이 인라인 PNG) */
const ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAiklEQVR42mNgGCrgPxKgptpRB+AF9vUP/sMwMkAWx4bR1VJkMTUcAMNkW04tBxB0BLmGkqqWLAdQEw+o5TgdMeqAAXdA9Nz//+mJRx1AlAP+////GhlTQ27UAUPLAaO5AF9QftiiiYLpngaGnwOwOYJWDsDZIhqwBEhPRxDVMh5Qy2nhEIZRgAcAAETsQEVfTxQCAAAAAElFTkSuQmCC';

/** 크기 프리셋 (CONTRACT 의 snapPreset 키) */
const PRESETS = {
  compact: { width: 720, height: 460, label: '컴팩트 (720×460)' },
  normal: { width: 980, height: 620, label: '기본 (980×620)' },
  wide: { width: 1280, height: 680, label: '와이드 (1280×680)' },
  tall: { width: 640, height: 900, label: '세로형 (640×900)' },
};

/** 클릭 통과 모드를 풀 수 있는 탈출용 단축키 후보 (앞에서부터 등록 시도) */
const ESCAPE_ACCELERATORS = ['Alt+Shift+S', 'Control+Alt+S', 'Control+Shift+F12'];

// ---------------------------------------------------------------- 상태

/** @type {BrowserWindow|null} */
let win = null;
/** @type {Tray|null} */
let tray = null;
let trayIcon = null;

let isQuitting = false;          // 트레이 '종료' 를 눌렀을 때만 true
let alwaysOnTop = false;         // 항상 위 상태(메인이 진실의 원천)
let clickThrough = false;        // 클릭 통과(잠금) 상태
let registeredAccelerator = null; // 실제로 등록에 성공한 전역 단축키

// ---------------------------------------------------------------- 창

function createWindow() {
  const bounds = windowState.load();

  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: windowState.MIN_WIDTH,   // 560
    minHeight: windowState.MIN_HEIGHT, // 380

    // --- 바탕화면 위젯 외형 ---
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: true,
    minimizable: true,
    skipTaskbar: false,
    // Windows 에서 WS_THICKFRAME 을 유지해 가장자리 드래그 리사이즈가 살아 있게 한다.
    // (frameless + transparent 조합에서 이 값이 false 면 가장자리 리사이즈가 죽는다)
    thickFrame: true,
    roundedCorners: true,

    title: '일정관리 비서',
    icon: trayIcon,
    show: false,

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,               // preload 는 ipcRenderer 만 쓰므로 샌드박스 가능
      spellcheck: false,
      backgroundThrottling: false, // 숨겨져 있어도 타이머(날짜 갱신)가 멈추지 않게
    },
  });

  win.setMenuBarVisibility(false);
  // 명시적으로 한 번 더 — 일부 환경에서 transparent 창이 고정 크기로 잡히는 것 방지
  win.setResizable(true);
  win.setMinimumSize(windowState.MIN_WIDTH, windowState.MIN_HEIGHT);

  windowState.manage(win);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const startHidden = process.argv.includes('--hidden');

  win.once('ready-to-show', () => {
    windowState.applyMaximized(win);
    // 부팅 자동 시작(--hidden)일 때는 트레이에만 올라온다
    if (!startHidden) win.show();
    refreshTrayMenu();
  });

  // X 버튼(렌더러) 또는 OS 닫기 = 종료가 아니라 트레이로 숨김
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    hideToTray();
  });

  win.on('closed', () => {
    win = null;
  });

  for (const ev of ['show', 'hide', 'minimize', 'restore']) {
    win.on(ev, refreshTrayMenu);
  }

  // 외부 링크는 기본 브라우저로, 새 창 생성은 막는다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 이 창은 index.html 하나만 띄운다. 다른 곳으로 이동할 일이 절대 없다.
  // 파일을 창에 끌어다 놓기만 해도 기본 동작은 그 파일로 navigate 하는 것이라,
  // 막지 않으면 앱이 통째로 사라지고 preload 다리가 붙은 낯선 문서가 남는다.
  win.webContents.on('will-navigate', (e, url) => {
    if (url === win.webContents.getURL()) return;   // 새로고침은 허용
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // webview / 리다이렉트로 우회하는 경로도 함께 닫는다
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.webContents.on('will-redirect', (e) => e.preventDefault());

  // 권한 요청은 전부 거절한다 — 이 앱은 카메라·마이크·위치·클립보드 읽기를 쓰지 않는다
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  return win;
}

/** 창이 죽어 있으면 다시 만든다 */
function ensureWindow() {
  if (!win || win.isDestroyed()) createWindow();
  return win;
}

function showWidget() {
  const w = ensureWindow();
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  refreshTrayMenu();
}

function hideToTray() {
  if (win && !win.isDestroyed()) {
    windowState.saveNow(); // 숨기기 전에 위치 확정 저장
    // 트레이로 내려간 뒤 작업 관리자로 강제 종료되는 경우가 흔하다.
    // 기다리지는 않되, 남은 편집을 지금 쓰도록 밀어 둔다.
    requestFlush(0);
    win.hide();
  }
  refreshTrayMenu();
}

function toggleWidget() {
  if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) hideToTray();
  else showWidget();
}

// ---------------------------------------------------------------- 창 동작

function setAlwaysOnTop(on) {
  alwaysOnTop = !!on;
  if (win && !win.isDestroyed()) {
    // 'normal' 레벨 — 전체화면 앱 위로 튀어나오지 않게
    win.setAlwaysOnTop(alwaysOnTop, 'normal');
  }
  refreshTrayMenu();
}

/**
 * 클릭 통과(잠금) 모드.
 * 켜면 마우스 이벤트가 위젯을 통과해 바탕화면으로 간다.
 * forward:true 라야 렌더러가 mousemove 를 계속 받아 해제 UI 를 그릴 수 있다.
 */
function setClickThrough(on) {
  clickThrough = !!on;
  if (win && !win.isDestroyed()) {
    if (clickThrough) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
  }
  refreshTrayMenu();
}

/** 프로그램적 리사이즈 — 최소 크기 보장 + 화면 밖으로 나가지 않게 보정 */
function resizeTo(width, height) {
  const w = ensureWindow();
  if (!w || w.isDestroyed()) return;

  let ww = Math.round(Number(width));
  let hh = Math.round(Number(height));
  if (!Number.isFinite(ww) || !Number.isFinite(hh)) return;

  ww = Math.max(windowState.MIN_WIDTH, ww);
  hh = Math.max(windowState.MIN_HEIGHT, hh);

  if (w.isMaximized()) w.unmaximize();

  const cur = w.getBounds();
  const wa = getScreen().getDisplayMatching(cur).workArea;

  ww = Math.min(ww, wa.width);
  hh = Math.min(hh, wa.height);

  // 새 크기로 커지면서 화면 밖으로 밀려나지 않도록 좌표 보정
  const x = Math.min(Math.max(cur.x, wa.x), wa.x + wa.width - ww);
  const y = Math.min(Math.max(cur.y, wa.y), wa.y + wa.height - hh);

  w.setBounds({ x: Math.round(x), y: Math.round(y), width: ww, height: hh }, false);
}

function applyPreset(preset) {
  const p = PRESETS[preset];
  if (!p) return;
  resizeTo(p.width, p.height);
  showWidget();
}

// ---------------------------------------------------------------- 저장 플러시
//
// 렌더러의 저장은 250ms 디바운스다. 마지막 편집 직후 창을 숨기거나 앱을 끄면
// 그 편집이 통째로 날아간다. 끄기 전에 '지금 마무리하라'고 요청하고 잠깐 기다린다.

let flushSeq = 0;

/**
 * 렌더러에 저장 마무리를 요청한다.
 * @param {number} waitMs 0 이면 기다리지 않고 보내기만 한다 (창 숨김 등)
 * @returns {Promise<void>} 응답이 없어도 waitMs 후 반드시 resolve 한다
 */
function requestFlush(waitMs = 0) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve();

  const token = ++flushSeq;
  try {
    win.webContents.send('app:flush', token);
  } catch {
    return Promise.resolve();
  }
  if (waitMs <= 0) return Promise.resolve();

  return new Promise((resolve) => {
    // 렌더러가 죽었거나 응답이 없어도 종료를 영원히 막지 않는다
    const timer = setTimeout(finish, waitMs);
    function onAck(_e, ackToken) {
      if (ackToken !== token) return;
      finish();
    }
    function finish() {
      clearTimeout(timer);
      ipcMain.removeListener('app:flushed', onAck);
      resolve();
    }
    ipcMain.on('app:flushed', onAck);
  });
}

/** 렌더러로 메뉴 액션 전달 */
function sendMenuAction(action) {
  const w = ensureWindow();
  if (!w || w.isDestroyed()) return;
  if (!w.isVisible()) showWidget();
  w.webContents.send('menu:action', action);
}

// ---------------------------------------------------------------- 트레이

/**
 * 렌더러가 보고한 오늘 요약. 창을 열지 않아도 트레이가 말할 수 있게 한다.
 * 렌더러만 일정 데이터를 해석하므로(반복 회차 펼치기 등) 메인은 받아 쓰기만 한다.
 */
let traySummary = { today: 0, overdue: 0, items: [] };

/** 트레이 툴팁 — 마우스만 올려도 오늘 몫이 보인다 */
function trayTooltip() {
  const parts = [];
  if (traySummary.today) parts.push(`오늘 ${traySummary.today}건`);
  if (traySummary.overdue) parts.push(`밀린 일 ${traySummary.overdue}건`);
  return parts.length ? `일정관리 비서 — ${parts.join(' · ')}` : '일정관리 비서 — 오늘 일정 없음';
}

/** 트레이 메뉴 맨 위에 오는 오늘 일정 몇 줄 */
function todayMenuItems() {
  const out = [];

  if (traySummary.overdue) {
    out.push({
      label: `밀린 일 ${traySummary.overdue}건 — 오늘로 당기기`,
      click: () => sendMenuAction('roll-overdue'),
    });
  }

  if (!traySummary.items.length) {
    out.push({ label: '오늘 일정 없음', enabled: false });
  } else {
    for (const it of traySummary.items) {
      const time = it.time ? `${it.time}  ` : '';
      out.push({
        // 완료한 건 지운 것처럼 보이면 안 되니 표시만 다르게 한다
        label: `${it.done ? '✓ ' : ''}${time}${it.title}`,
        click: () => sendMenuAction(`open-task:${it.id}`),
      });
    }
    if (traySummary.today > traySummary.items.length) {
      out.push({
        label: `외 ${traySummary.today - traySummary.items.length}건…`,
        click: () => sendMenuAction('today'),
      });
    }
  }

  out.push({ label: '오늘 브리핑 보기', click: () => sendMenuAction('brief') });
  out.push({ type: 'separator' });
  return out;
}

function buildTrayMenu() {
  const visible = !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());

  return Menu.buildFromTemplate([
    ...todayMenuItems(),
    {
      label: visible ? '위젯 숨기기' : '위젯 보이기',
      click: toggleWidget,
    },
    { type: 'separator' },
    {
      label: '항상 위',
      type: 'checkbox',
      checked: alwaysOnTop,
      click: (item) => setAlwaysOnTop(item.checked),
    },
    {
      label: `잠금 (클릭 통과)${registeredAccelerator ? ` — 해제: ${registeredAccelerator}` : ''}`,
      type: 'checkbox',
      checked: clickThrough,
      click: (item) => {
        setClickThrough(item.checked);
        if (item.checked) showWidget();
      },
    },
    { type: 'separator' },
    {
      label: '크기 프리셋',
      submenu: Object.entries(PRESETS).map(([key, p]) => ({
        label: p.label,
        click: () => applyPreset(key),
      })),
    },
    { type: 'separator' },
    { label: '오늘로 이동', click: () => sendMenuAction('today') },
    { label: '완료 항목 표시 전환', click: () => sendMenuAction('toggle-completed') },
    { label: '설정 열기', click: () => sendMenuAction('settings') },
    { type: 'separator' },
    {
      label: '종료',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(trayTooltip());
}

function createTray() {
  tray = new Tray(trayIcon);
  refreshTrayMenu();

  tray.on('double-click', showWidget);
  // 좌클릭 한 번으로도 표시/포커스 (Windows 사용성)
  tray.on('click', showWidget);
}

// ---------------------------------------------------------------- 전역 단축키

/**
 * 클릭 통과 모드에 갇히지 않도록 반드시 탈출용 단축키를 등록한다.
 * 눌렀을 때: 숨김/잠금 상태면 -> 보이기 + 잠금 해제, 아니면 -> 숨기기.
 */
function registerGlobalShortcut() {
  for (const accel of ESCAPE_ACCELERATORS) {
    let ok = false;
    try {
      ok = globalShortcut.register(accel, onEscapeShortcut);
    } catch (err) {
      ok = false;
    }
    if (ok) {
      registeredAccelerator = accel;
      console.log(`[main] 전역 단축키 등록: ${accel}`);
      return;
    }
  }
  console.warn('[main] 전역 단축키 등록 실패 — 잠금 해제는 트레이 메뉴로만 가능합니다.');
}

function onEscapeShortcut() {
  const hidden = !win || win.isDestroyed() || !win.isVisible() || win.isMinimized();

  if (hidden || clickThrough) {
    if (clickThrough) {
      setClickThrough(false);
      // 렌더러의 clickThroughLocked 설정도 되돌릴 수 있게 알린다(모르는 액션이면 무시됨).
      if (win && !win.isDestroyed()) win.webContents.send('menu:action', 'unlock');
    }
    showWidget();
  } else {
    hideToTray();
  }
}

// ---------------------------------------------------------------- IPC

function windowFrom(event) {
  return BrowserWindow.fromWebContents(event.sender) || win;
}

function registerIpc() {
  // --- 데이터 ---
  // 렌더러가 오늘 요약을 보고한다. 바뀐 게 없으면 메뉴를 다시 만들지 않는다
  // (setContextMenu 는 값싼 호출이 아니고, 열려 있는 메뉴를 닫아 버린다).
  ipcMain.on('tray:summary', (_e, summary) => {
    const next = JSON.stringify(summary);
    if (next === JSON.stringify(traySummary)) return;
    traySummary = summary;
    refreshTrayMenu();
  });

  // --- 공휴일 ---
  // 렌더러는 CSP 때문에 네트워크를 쓸 수 없다. 받아오는 일은 메인이 맡고 결과만 넘긴다.
  ipcMain.handle('holidays:get', (_e, years) => holidays.get(years));

  ipcMain.handle('data:load', () => storage.loadData());
  ipcMain.handle('data:save', (_e, data) => storage.saveData(data));

  // --- 창 제어 ---
  ipcMain.on('window:minimize', (e) => {
    const w = windowFrom(e);
    if (w && !w.isDestroyed()) w.minimize();
  });

  ipcMain.on('window:hide', () => hideToTray());

  ipcMain.on('window:setAlwaysOnTop', (_e, on) => setAlwaysOnTop(on));

  // window:setOpacity 는 두지 않는다. Windows 의 transparent 창에서
  // BrowserWindow.setOpacity 는 합성이 불안정해 쓰지 않기로 했고(배경 알파로 대체),
  // 쓰지 않는 IPC 를 열어 두면 공격 표면만 넓어진다.

  ipcMain.on('window:setIgnoreMouseEvents', (_e, on) => setClickThrough(on));

  ipcMain.handle('window:getBounds', (e) => {
    const w = windowFrom(e);
    if (!w || w.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 };
    const b = w.getBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });

  ipcMain.on('window:setSize', (_e, width, height) => resizeTo(width, height));

  ipcMain.on('window:snapPreset', (_e, preset) => {
    const p = PRESETS[preset];
    if (!p) return;
    resizeTo(p.width, p.height);
  });

  // --- 부팅 시 자동 시작 ---
  // 개발 실행(electron .)에서 등록하면 electron.exe 가 시작 프로그램에 박힌다.
  // 설치본에서만 실제로 등록하고, 개발 중에는 상태만 흉내 낸다.
  // 설정 화면에 현재 버전을 보여 준다. 새 버전을 받아야 하는지 사용자가 판단할 근거다.
  ipcMain.handle('app:getVersion', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
  }));

  ipcMain.handle('app:getAutoLaunch', () => {
    if (!app.isPackaged) return { ok: true, enabled: false, dev: true };
    return { ok: true, enabled: app.getLoginItemSettings().openAtLogin };
  });

  ipcMain.handle('app:setAutoLaunch', (_e, on) => {
    if (!app.isPackaged) {
      return { ok: false, dev: true, error: '개발 실행 중에는 설정되지 않습니다(설치본에서 동작).' };
    }
    app.setLoginItemSettings({
      openAtLogin: !!on,
      // 부팅 직후 창이 튀어나오지 않고 트레이에만 올라오게 한다
      args: ['--hidden'],
    });
    return { ok: true, enabled: !!on };
  });

  // --- 데이터 내보내기 / 가져오기 ---
  // 파일 내용은 렌더러가 만들고(모델과 날짜 유틸이 거기 있다), 메인은 대화상자와 쓰기만 맡는다.
  ipcMain.handle('data:saveAs', async (_e, opts) => {
    const w = win && !win.isDestroyed() ? win : undefined;
    const result = await dialog.showSaveDialog(w, {
      title: String(opts?.title || '내보내기'),
      defaultPath: String(opts?.defaultName || 'export.txt'),
      filters: Array.isArray(opts?.filters) ? opts.filters : undefined,
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(result.filePath, String(opts?.content ?? ''), 'utf8');
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('data:openFile', async (_e, opts) => {
    const w = win && !win.isDestroyed() ? win : undefined;
    const result = await dialog.showOpenDialog(w, {
      title: String(opts?.title || '가져오기'),
      properties: ['openFile'],
      filters: Array.isArray(opts?.filters) ? opts.filters : undefined,
    });
    if (result.canceled || !result.filePaths.length) return null;
    try {
      const file = result.filePaths[0];
      // 백업 파일이 수십 MB 가 될 일은 없다. 터무니없이 크면 거부한다.
      const size = fs.statSync(file).size;
      if (size > 64 * 1024 * 1024) return { ok: false, error: '파일이 너무 큽니다.' };
      return { ok: true, path: file, text: fs.readFileSync(file, 'utf8') };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  /** 자동 백업 폴더를 탐색기로 연다 */
  ipcMain.handle('data:openBackups', () => {
    const dir = storage.backupDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 무시 */ }
    shell.openPath(dir);
    return { ok: true, path: dir };
  });

  // --- 리마인더 알림 ---
  // 렌더러의 스케줄러가 시간이 된 일정을 알려 오면 OS 알림으로 띄운다.
  ipcMain.handle('reminder:notify', (_e, payload) => {
    if (!Notification.isSupported()) {
      return { ok: false, error: '이 시스템에서는 알림을 지원하지 않습니다.' };
    }
    const title = String(payload?.title || '일정 알림').slice(0, 120);
    const body = String(payload?.body || '').slice(0, 300);
    const taskId = String(payload?.taskId || '');

    const n = new Notification({ title, body, silent: false });
    // 알림을 클릭하면 위젯을 띄우고 해당 일정을 열어 준다
    n.on('click', () => {
      showWidget();
      if (win && !win.isDestroyed()) win.webContents.send('reminder:click', taskId);
    });
    n.show();
    return { ok: true };
  });

  // --- 외부 링크 ---
  // 일정에 저장된 링크를 기본 브라우저로 연다.
  // 렌더러가 보낸 값을 그대로 믿지 않고 http/https 만 통과시킨다.
  ipcMain.handle('shell:openExternal', (_e, url) => {
    const raw = String(url || '').trim();
    if (!raw) return { ok: false, error: '링크가 비어 있습니다.' };
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return { ok: false, error: '올바른 주소가 아닙니다.' };
    }
    // mailto 는 '의견 보내기' 가 쓴다. 메일 클라이언트를 여는 것뿐이라
    // 파일·명령을 실행하는 다른 프로토콜과 위험도가 다르다.
    const ALLOWED = ['http:', 'https:', 'mailto:'];
    if (!ALLOWED.includes(parsed.protocol)) {
      return { ok: false, error: 'http / https / mailto 주소만 열 수 있습니다.' };
    }
    shell.openExternal(parsed.href);
    return { ok: true };
  });

  // --- 퀵 런처 ---
  ipcMain.handle('launcher:run', (_e, item) =>
    runner.run(item, (status) => {
      if (win && !win.isDestroyed()) win.webContents.send('launcher:status', status);
    })
  );

  ipcMain.handle('launcher:cancel', (_e, jobId) => runner.cancel(String(jobId)));

  // 런처 항목을 추가할 때 쓰는 파일/폴더 선택 창
  ipcMain.handle('launcher:pick', async (_e, mode) => {
    const w = win && !win.isDestroyed() ? win : undefined;
    const isFolder = mode === 'folder';
    const result = await dialog.showOpenDialog(w, {
      title: isFolder ? '폴더 선택' : '실행할 파일 선택',
      properties: [isFolder ? 'openDirectory' : 'openFile'],
      filters: isFolder ? undefined : [
        { name: '실행 가능', extensions: ['py', 'pyw', 'ps1', 'bat', 'cmd', 'js', 'exe', 'lnk'] },
        { name: '모든 파일', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });
}

// ---------------------------------------------------------------- 앱 수명주기

// 두 번 실행하면 기존 창을 띄운다 (트레이 앱이므로 중복 실행 방지 필수)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWidget());

  app.setAppUserModelId('com.dongik.schedule-widget');

  app.whenReady().then(() => {
    trayIcon = nativeImage.createFromDataURL(ICON_DATA_URL);

    registerIpc();
    createWindow();
    createTray();
    registerGlobalShortcut();

    app.on('activate', () => showWidget()); // macOS 도크 클릭 대응
  });

  // 트레이 상주 앱 — 창을 닫아도 종료하지 않는다.
  app.on('window-all-closed', () => {
    if (!isQuitting) return;
    app.quit();
  });

  let flushedOnQuit = false;

  app.on('before-quit', (e) => {
    isQuitting = true;
    windowState.saveNow(); // 종료 시 즉시 저장
    runner.killAll();      // 실행 중인 스크립트를 고아 프로세스로 남기지 않는다

    // 렌더러에 남은 저장을 마무리할 틈을 준다. 한 번만 — 아래 app.quit() 이
    // before-quit 을 다시 부르므로 플래그로 재진입을 막는다.
    if (flushedOnQuit) return;
    if (!win || win.isDestroyed()) return;
    e.preventDefault();
    requestFlush(1500).then(() => {
      flushedOnQuit = true;
      app.quit();
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (tray && !tray.isDestroyed()) {
      tray.destroy();
      tray = null;
    }
  });
}
