// 창 위치/크기 영속화. 저장된 좌표가 지금 연결된 모니터 밖이면 기본 위치로 되돌린다.

const fs = require('fs');
const path = require('path');
const electron = require('electron');
const { app } = electron;

// screen 모듈은 app 'ready' 이후에만 접근해야 하므로 항상 호출 시점에 가져온다.
function getScreen() {
  return electron.screen;
}

const FILE_NAME = 'window-state.json';
const SAVE_DEBOUNCE_MS = 400;

const DEFAULT_WIDTH = 980;
const DEFAULT_HEIGHT = 620;
const MIN_WIDTH = 560;
const MIN_HEIGHT = 380;

// 창이 "보인다"고 인정할 최소 교집합 크기 (이보다 작으면 화면 밖으로 본다)
const MIN_VISIBLE_W = 140;
const MIN_VISIBLE_H = 80;

let managedWin = null;
let saveTimer = null;
let current = null; // 마지막으로 알고 있는 상태

function statePath() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

/** 기본 위치: 주 디스플레이 작업영역 중앙 */
function defaultBounds() {
  const wa = getScreen().getPrimaryDisplay().workArea;
  const width = Math.max(MIN_WIDTH, Math.min(DEFAULT_WIDTH, wa.width - 40));
  const height = Math.max(MIN_HEIGHT, Math.min(DEFAULT_HEIGHT, wa.height - 40));
  return {
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    width,
    height,
    maximized: false,
  };
}

/** 두 사각형의 교집합 크기 */
function intersection(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { w: Math.max(0, w), h: Math.max(0, h) };
}

/** 현재 연결된 디스플레이 중 하나에 충분히 걸쳐 있는지 검사 */
function isOnSomeDisplay(bounds) {
  return getScreen().getAllDisplays().some((d) => {
    const hit = intersection(bounds, d.workArea);
    return hit.w >= MIN_VISIBLE_W && hit.h >= MIN_VISIBLE_H;
  });
}

function isFiniteInt(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * 저장된 상태를 읽어 BrowserWindow 생성 옵션으로 쓸 bounds 를 돌려준다.
 * 파일이 없거나 깨졌거나 화면 밖이면 기본값으로 폴백한다.
 */
function load() {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[windowState] 상태 파일 읽기 실패, 기본값 사용:', err.message);
  }

  if (!saved || typeof saved !== 'object') {
    current = defaultBounds();
    return { ...current };
  }

  const bounds = {
    x: saved.x,
    y: saved.y,
    width: isFiniteInt(saved.width) ? Math.max(MIN_WIDTH, Math.round(saved.width)) : DEFAULT_WIDTH,
    height: isFiniteInt(saved.height) ? Math.max(MIN_HEIGHT, Math.round(saved.height)) : DEFAULT_HEIGHT,
    maximized: !!saved.maximized,
  };

  // 좌표가 없거나(최초) 지금 붙어 있는 모니터 밖이면 기본 위치로.
  if (!isFiniteInt(bounds.x) || !isFiniteInt(bounds.y)) {
    const def = defaultBounds();
    bounds.x = def.x;
    bounds.y = def.y;
  } else {
    bounds.x = Math.round(bounds.x);
    bounds.y = Math.round(bounds.y);
    if (!isOnSomeDisplay(bounds)) {
      console.warn('[windowState] 저장된 좌표가 연결된 디스플레이 밖입니다. 기본 위치로 복귀합니다.');
      const def = defaultBounds();
      bounds.x = def.x;
      bounds.y = def.y;
      // 화면보다 큰 창이면 크기도 줄여 준다.
      const wa = getScreen().getPrimaryDisplay().workArea;
      bounds.width = Math.min(bounds.width, wa.width - 40);
      bounds.height = Math.min(bounds.height, wa.height - 40);
      bounds.x = Math.round(wa.x + (wa.width - bounds.width) / 2);
      bounds.y = Math.round(wa.y + (wa.height - bounds.height) / 2);
    }
  }

  current = bounds;
  return { ...bounds };
}

/** 창의 현재 상태를 읽어 온다 (최대화 중이면 이전 일반 크기를 기억) */
function snapshot(win) {
  if (!win || win.isDestroyed()) return current;
  const maximized = win.isMaximized();
  // getNormalBounds() 는 최대화/최소화 상태에서도 "원래" 크기를 준다.
  const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(MIN_WIDTH, Math.round(b.width)),
    height: Math.max(MIN_HEIGHT, Math.round(b.height)),
    maximized,
  };
}

/** 즉시 디스크에 기록 */
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;

  const data = snapshot(managedWin);
  if (!data) return;
  current = data;

  try {
    const dir = path.dirname(statePath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // 원자적 교체 — 저장 도중 종료돼도 기존 파일이 남는다.
    const tmp = `${statePath()}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, statePath());
  } catch (err) {
    console.error('[windowState] 상태 저장 실패:', err.message);
  }
}

/** 400ms 디바운스 저장 */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
}

/** 창에 이동/리사이즈 리스너를 붙인다 */
function manage(win) {
  managedWin = win;
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'restore']) {
    win.on(ev, scheduleSave);
  }
  win.on('close', saveNow); // 종료(또는 숨김 직전)에는 즉시 저장
  win.on('closed', () => {
    managedWin = null;
  });
}

/** 최대화 상태였다면 복원 */
function applyMaximized(win) {
  if (current && current.maximized) win.maximize();
}

module.exports = {
  load,
  manage,
  saveNow,
  applyMaximized,
  statePath,
  MIN_WIDTH,
  MIN_HEIGHT,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
};
