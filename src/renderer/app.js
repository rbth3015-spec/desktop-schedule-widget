// 앱 부트스트랩. 셸(표지 머리 · 제본선 · 설정 · 브리핑)을 담당하고
// 캘린더 / 투두 모듈을 각자의 root 에 마운트한다.
//
// 화면 값은 design_handoff_schedule_assistant 의 인라인 style 이 원본이다(PORTING.md).

import * as store from './store.js';
import { createCalendar } from './calendar/calendar.js';
import { createTodoPanel } from './todo/todo.js';
import { createDashboard } from './dashboard/dashboard.js';
import { createLauncher } from './launcher/launcher.js';
import { todayKey, fromKey, addDays, weekGrid, WEEKDAY_LABELS } from './lib/date.js';
import { setIcon, icon } from './lib/icons.js';
import { showContextMenu } from './lib/menu.js';
import { startReminders, timeAgo } from './reminders.js';
import { toBackupJSON, parseBackup, toICS, fileStamp } from './lib/exchange.js';
import { parseQuickInput, resolveRange } from './todo/parse.js';
import { wireSync } from './sync/sync.js';

const $ = (sel) => document.querySelector(sel);

/** 의견을 받을 주소. 배포처를 바꾸면 여기만 고치면 된다. */
const FEEDBACK_TO = 'rbth3015@gmail.com';

const WEEKDAY_FULL = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

const els = {
  root: $('#widget'),
  panes: $('.panes'),
  calendar: $('#calendar-root'),
  todo: $('#todo-root'),
  splitter: $('#splitter'),
  dash: $('#dash-root'),
  launcher: $('#launcher-root'),
  settings: $('#settings-root'),
  btnBrief: $('#btn-brief'),
  btnSearch: $('#btn-search'),
  btnBell: $('#btn-bell'),
  btnLock: $('#btn-lock'),
  btnMin: $('#btn-min'),
  btnMax: $('#btn-max'),
  btnClose: $('#btn-close'),
  year: document.getElementById('titlebar-year'),
  tabMain: document.getElementById('tab-main'),
  tabTodos: document.getElementById('tab-todos'),
  tabPlan: document.getElementById('tab-plan'),
  tabSettings: document.getElementById('tab-settings'),
};

// 설정은 오른쪽 면의 한 화면이다(시안). 같은 면 안에 두고 하루 화면과 갈아 끼운다.
els.todo.append(els.settings);

let calendar = null;
let todo = null;
let dashboard = null;
let launcher = null;
let reminders = null;
let sync = null;   // 휴대폰 동기화 — { refresh }

/** 작은 요소 하나 */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------- 부팅

async function boot() {
  await store.init();

  applyChrome(store.getState().settings);

  calendar = createCalendar({ root: els.calendar, store });
  todo = createTodoPanel({ root: els.todo, store });
  dashboard = createDashboard({ root: els.dash, store });
  launcher = createLauncher({ root: els.launcher, store });

  wireTitlebar();
  wireDropGuard();
  wireSaveGuard();
  wireDayWatch();
  wireDimming();
  wireReminders();
  wireSplitter();
  wireTabs();
  wireWeather();
  wireInbox();
  wirePhoneSync();
  wireMenuActions();
  wireShortcuts();

  // 설정이 바뀌면 셸 외형도 따라간다
  store.subscribe((state) => {
    applyChrome(state.settings);
    updateTitle(state);
    reportToTray();
    renderSaveError(state);
  });

  updateTitle(store.getState());
  reportToTray();

  if (store.getState().loadNotice) showNotice(store.getState().loadNotice, { sticky: true });

  // 처음 켠 사람에게 안내 창을 띄우지 않는다 — 빈 화면의 '＋ 일정 추가' 가 첫 걸음이다
  maybeShowBrief();
}

// ---------------------------------------------------------------- 토스트

/** 짧은 확인 문구 — 되돌리기처럼 결과가 눈에 안 보일 수 있는 동작에 쓴다 */
let toastEl = null;
let toastTimer = null;

/**
 * @param {string} text
 * @param {{undo?: boolean}} [opts]
 *   undo — 토스트에 '되돌리기' 버튼을 붙인다. 되돌리기가 Ctrl+Z 밖에 없으면
 *   단축키를 모르는 사람에게는 삭제·일괄 이동이 되돌릴 수 없는 동작으로 보인다.
 */
function showToast(text, { undo = false } = {}) {
  clearTimeout(toastTimer);
  if (!toastEl) {
    toastEl = el('div', 'toast');
    toastEl.setAttribute('role', 'status');
    els.root.append(toastEl);
  }
  toastEl.replaceChildren(el('span', 'toast__text', text));

  if (undo && store.canUndo()) {
    const btn = el('button', 'toast__undo', '되돌리기');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      const undone = store.undo();
      hideToast();
      if (undone) showToast(`되돌렸습니다 — ${undone}`);
    });
    toastEl.append(btn);
  }

  toastEl.classList.add('is-on');
  // 누를 것이 있으면 읽고 누를 시간을 준다
  toastTimer = setTimeout(hideToast, undo ? 5000 : 1800);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastEl?.classList.remove('is-on');
}

// 뷰 모듈은 셸을 직접 부르지 않는다. 토스트가 필요하면 이벤트로 부탁한다.
document.addEventListener('app:toast', (e) => {
  const detail = e.detail;
  if (typeof detail === 'string') showToast(detail, { undo: true });
  else if (detail) showToast(String(detail.text || ''), { undo: detail.undo !== false });
});
document.addEventListener('app:brief', () => showBrief());
document.addEventListener('app:help', () => toggleHelp());

// ---------------------------------------------------------------- 저장 보호
//
// 저장이 실패해도 아무 표시가 없으면, 사용자는 계속 일정을 적다가 앱을 껐다 켠 뒤에야
// 전부 사라진 걸 알게 된다. 일정 앱에서 가장 나쁜 실패 방식이라 화면에 붙여 둔다.
// 토스트가 아니라 **사라지지 않는 배너**여야 한다.

let saveErrorEl = null;

/**
 * 창 밖에서 끌어다 놓은 것은 전부 무시한다.
 * 브라우저 기본 동작은 그 파일로 navigate 하는 것이라, 파일 하나를 위젯에 떨어뜨리면
 * 앱이 통째로 사라진다. 메인에서도 will-navigate 로 막지만 여기서 먼저 끊는다.
 * (일정 항목 드래그는 'application/x-task-id' 타입을 쓰므로 영향받지 않는다)
 */
function wireDropGuard() {
  const isOurs = (e) =>
    !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('application/x-task-id');

  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (e) => {
      if (isOurs(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    });
  }
}

function wireSaveGuard() {
  // 메인이 종료·숨김 직전에 요청하면 디바운스 대기 중인 저장을 지금 끝낸다
  window.api.app?.onFlushRequest?.(() => store.flushSave());
}

function renderSaveError(state) {
  const message = state.saveError;

  if (!message) {
    saveErrorEl?.remove();
    saveErrorEl = null;
    return;
  }
  if (saveErrorEl) return;   // 이미 떠 있으면 문구를 갈아 끼우지 않는다

  const bar = el('div', 'savebar');
  bar.setAttribute('role', 'alert');

  const text = el('span', 'savebar__text', `저장하지 못했습니다 — ${message}`);

  const retry = el('button', 'savebar__btn', '다시 시도');
  retry.type = 'button';
  retry.addEventListener('click', () => store.flushSave());

  const backup = el('button', 'savebar__btn', '백업으로 내보내기');
  backup.type = 'button';
  backup.addEventListener('click', exportBackup);

  bar.append(text, retry, backup);
  els.root.append(bar);
  saveErrorEl = bar;
}

/** 데이터 손상 백업 등, 사용자가 알아야 할 일회성 안내 */
function showNotice(text, { sticky = false } = {}) {
  const box = el('div', 'notice', text);
  box.setAttribute('role', 'alert');

  const close = el('button', 'notice__close', '확인');
  close.type = 'button';
  close.addEventListener('click', () => box.remove());
  box.append(close);

  els.root.append(box);
  // 데이터를 못 읽었다는 안내는 스스로 사라지면 안 된다.
  // 못 보고 지나친 채로 새 일정을 적으면 기존 파일을 덮어쓰게 된다.
  if (!sticky) setTimeout(() => box.remove(), 12000);
}

// ---------------------------------------------------------------- 외형

// 셸에 마지막으로 반영한 설정. store 는 모든 변경마다 emit 하므로
// 실제로 바뀐 항목만 골라 적용한다 (특히 IPC 는 매번 쏘면 안 된다).
let appliedChrome = {};

/** 시안의 오른쪽 면 폭 — 제본선을 끌지 않은 기본값 */
const RIGHT_W = 452;
const DEFAULT_RATIO = 0.64;

/** 저장된 비율로 오른쪽 면 폭을 건다. 기본값이면 시안의 452px 그대로. */
function applySplit(ratio) {
  if (Math.abs(ratio - DEFAULT_RATIO) < 1e-6) {
    document.documentElement.style.setProperty('--right-w', `${RIGHT_W}px`);
    return;
  }
  const total = els.panes?.clientWidth || 0;
  const right = total ? Math.round((total - 30) * (1 - ratio)) : RIGHT_W;
  document.documentElement.style.setProperty('--right-w', `${Math.max(420, right)}px`);
}

/** settings 를 실제 창/문서에 반영 */
function applyChrome(s) {
  const prev = appliedChrome;

  if (s.theme !== prev.theme) {
    document.documentElement.dataset.theme = s.theme;
  }
  if (s.fontScale !== prev.fontScale) {
    // 글자 크기. 시안의 값은 전부 px 이라 글자만 키우면 칸이 어긋난다 —
    // 화면 전체를 같은 비율로 키운다(브라우저 확대와 같은 방식).
    window.api.window.setZoom?.(s.fontScale || 1);
  }
  if (s.splitRatio !== prev.splitRatio) applySplit(s.splitRatio);
  if (s.alwaysOnTop !== prev.alwaysOnTop) {
    window.api.window.setAlwaysOnTop(s.alwaysOnTop);
  }
  if (s.opacity !== prev.opacity) {
    // 배경 알파만 조절한다. BrowserWindow.setOpacity 는 Windows 의 transparent 창에서
    // 합성이 불안정해(영역별로 반영이 들쭉날쭉) 쓰지 않는다.
    document.documentElement.style.setProperty('--glass-a', String(s.opacity));
  }
  if (s.clickThroughLocked !== prev.clickThroughLocked) {
    const on = !!s.clickThroughLocked;
    window.api.window.setIgnoreMouseEvents(on);
    // 켜져 있는 동안 위젯은 비쳐 보이는 채로 머문다(커서를 올려도 돌아오지 않는다).
    // 자물쇠 하나만 또렷하게 남아 다시 누를 수 있다.
    document.documentElement.classList.toggle('is-through', on);
    els.btnLock?.classList.toggle('is-active', on);
    els.btnLock?.setAttribute('aria-pressed', String(on));
    if (els.btnLock) els.btnLock.title = on ? '클릭 통과 끄기' : '클릭 통과';
  }

  // --- 외형 ---
  if (s.weather !== prev.weather || s.weatherCity !== prev.weatherCity) {
    // 켜고 끄거나 도시를 바꾸면 곧바로 다시 받는다 (prev 가 비어 있는 첫 호출은 wireWeather 가 맡는다)
    if (Object.keys(prev).length) pullWeather(true);
  }
  if (s.blurEnabled !== prev.blurEnabled) {
    // 블러는 dwm.exe GPU 부하가 큰 연산이라 끌 수 있어야 한다
    document.documentElement.dataset.blur = s.blurEnabled ? 'on' : 'off';
  }
  if (s.dimInactive !== prev.dimInactive) {
    document.documentElement.dataset.dim = s.dimInactive ? 'on' : 'off';
  }

  // --- 아래 리본 ---
  if (s.showDashboard !== prev.showDashboard) els.dash.hidden = !s.showDashboard;
  if (s.showLauncher !== prev.showLauncher) els.launcher.hidden = !s.showLauncher;
  if (s.showDashboard !== prev.showDashboard || s.showLauncher !== prev.showLauncher) {
    // 둘 다 끄면 리본째 걷는다 — 빈 띠만 남아 있으면 펼침면이 괜히 눌린다
    els.dash.parentElement.hidden = !s.showDashboard && !s.showLauncher;
  }

  appliedChrome = { ...s };
}

// 창 폭이 바뀌면 사용자가 끌어 둔 비율대로 오른쪽 면 폭을 다시 잰다
window.addEventListener('resize', () => applySplit(store.getState().settings.splitRatio));

/** 창이 비활성이면 위젯을 배경으로 물린다 (macOS 데스크톱 위젯의 틴팅/디밍 방식).
 *  마우스를 올리면 CSS 가 즉시 원래 질감으로 복원한다 — 클릭 통과 중에는 복원하지 않는다. */
function wireDimming() {
  const setInactive = (v) => document.documentElement.classList.toggle('is-inactive', v);
  window.addEventListener('blur', () => setInactive(true));
  window.addEventListener('focus', () => setInactive(false));
  setInactive(!document.hasFocus());

  // 트레이로 내려가 화면에 없을 때는 애니메이션을 멈춘다(CSS 가 이 값을 본다).
  const setHidden = () => {
    document.documentElement.dataset.hidden = document.hidden ? '1' : '0';
  };
  document.addEventListener('visibilitychange', setHidden);
  setHidden();
}

/**
 * 표지 이름은 시안대로 '일정관리 비서' 만 둔다.
 * 오늘 몫은 창 제목이 말한다 — 작업 표시줄 미리보기와 Alt+Tab 에서 보인다.
 */
function updateTitle(state) {
  const today = todayKey();
  const total = state.tasks.filter((t) => !t.done && t.start === today).length;
  const todos = store.todoSummary(today).open;
  const parts = [];
  if (total) parts.push(`오늘 ${total}건`);
  if (todos) parts.push(`할 일 ${todos}개`);
  document.title = parts.length ? `일정관리 비서 · ${parts.join(' · ')}` : '일정관리 비서';
  syncBellDot(state);
}

// ---------------------------------------------------------------- 표지 머리

function wireTitlebar() {
  // 시안의 아이콘 — 14px · stroke 1.4, 닫기만 13px.
  // 설정은 책갈피 '설정' 하나가 연다 — 표지에 톱니를 두 벌로 두지 않는다.
  setIcon(els.btnBrief, 'sunrise', 14, 1.4);
  setIcon(els.btnSearch, 'searchD', 14, 1.4);
  setIcon(els.btnBell, 'bellD', 14, 1.4);
  setIcon(els.btnLock, 'lock', 14, 1.4);
  // 창 단추 — 윈도우의 순서 그대로(최소화 · 최대화 · 닫기). 닫기는 종료가 아니라 트레이로.
  setIcon(els.btnMin, 'minimize', 13, 1.4);
  paintMaximized(false);
  setIcon(els.btnClose, 'close', 13, 1.4);
  // 알림 기록 — 아직 안 본 알림이 있으면 점이 찍힌다
  els.btnBell.append(el('span', 'iconbtn__dot'));

  els.btnBell.setAttribute('aria-expanded', 'false');
  els.btnLock.setAttribute('aria-pressed', 'false');

  els.btnMin.addEventListener('click', () => window.api.window.minimize());
  els.btnMax.addEventListener('click', () => window.api.window.toggleMaximize?.());
  window.api.window.onState?.((s) => paintMaximized(s.maximized));
  window.api.window.isMaximized?.().then(paintMaximized).catch(() => {});
  els.btnClose.addEventListener('click', () => window.api.window.hide());
  els.btnBrief.addEventListener('click', () => showBrief());
  els.btnSearch.addEventListener('click', () => {
    if (!els.settings.hidden) toggleSettings();
    document.dispatchEvent(new CustomEvent('app:search'));
  });
  // 클릭 통과 — 같은 자물쇠가 켜고 끈다.
  // 켜져 있는 동안 창은 마우스를 통과시키지만, 자물쇠 위에 커서가 오면 그 순간만 받는다.
  els.btnLock.addEventListener('click', () => {
    const on = !store.getState().settings.clickThroughLocked;
    store.setSetting('clickThroughLocked', on);
    // 켠 직후 커서는 아직 자물쇠 위에 있다 — 다시 들어오기(mouseenter)를 기다리지 않고 받는 상태로 둔다
    if (on) window.api.window.catchMouse?.(true);
  });
  els.btnLock.addEventListener('mouseenter', () => window.api.window.catchMouse?.(true));
  els.btnLock.addEventListener('mouseleave', () => window.api.window.catchMouse?.(false));
  els.btnBell.addEventListener('click', (e) => { e.stopPropagation(); toggleBell(); });

  if (els.year) els.year.textContent = romanYear(new Date().getFullYear());
}

/** 최대화 단추는 지금 상태를 그린다 — □ 최대화 / ❐ 이전 크기로 */
function paintMaximized(on) {
  const max = !!on;
  setIcon(els.btnMax, max ? 'restore' : 'maximize', 13, 1.4);
  els.btnMax.title = max ? '이전 크기로' : '최대화';
  document.documentElement.classList.toggle('is-max', max);
}

/**
 * 커버의 콜로폰 — 연도를 로마숫자로.
 * 장식이지만 다이어리 겉장에 찍힌 연도라는 뜻이 있어서, 해가 바뀌면 따라가야 한다.
 */
function romanYear(n) {
  const table = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
                 [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

// ---------------------------------------------------------------- 모달 (브리핑 · 안내 · 사용법)
//
// 시안의 아침 브리핑 창이 틀이다: 펼침면 위에 스크림, 520px 종이 카드, 명조 머리.
// 사용법도 같은 틀을 빌린다 — 모양을 새로 만들지 않는다. 닫기는 머리의 ✕ 하나다.

let briefSheet = null;
let helpSheet = null;

function openModal(kind, label, onClose) {
  const scrim = el('div', `modal-scrim modal-scrim--${kind}`);
  const card = el('div', `modal modal--${kind}`);
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', label);
  // 초점은 카드 자체에 둔다 — 닫기 단추에 두면 열자마자 금박 링이 떠서 눌린 것처럼 보인다
  card.tabIndex = -1;
  scrim.append(card);
  // 바깥(스크림)을 누르면 닫힌다. 안에서 누르고 밖에서 떼는 드래그는 무시한다.
  let downOnScrim = false;
  scrim.addEventListener('mousedown', (e) => { downOnScrim = e.target === scrim; });
  scrim.addEventListener('click', (e) => { if (e.target === scrim && downOnScrim) onClose(); });
  (els.panes || els.root).append(scrim);
  requestAnimationFrame(() => card.focus({ preventScroll: true }));
  return { scrim, card };
}

function modalHead(title, sub, onClose) {
  const head = el('div', 'modal__head');
  const titles = el('div', 'modal__titles');
  titles.append(el('span', 'modal__title', title));
  if (sub) titles.append(el('span', 'modal__sub', sub));
  const close = el('button', 'modal__close');
  close.type = 'button';
  close.setAttribute('aria-label', '닫기');
  close.append(icon('close', 13, 1.4));
  close.addEventListener('click', onClose);
  head.append(titles, close);
  return { head, close };
}

/** 브리핑 블록 — 제목 · 건수 · 괘선, 아래로 '시각 | 할 일' 줄 */
function modalBlock(title, count, { seal = false } = {}) {
  const block = el('div', `modal__block${seal ? ' modal__block--seal' : ''}`);
  const head = el('div', 'modal__blockhead');
  head.append(el('span', 'modal__blocktitle', title));
  if (count != null && count !== '') head.append(el('span', 'modal__count', String(count)));
  head.append(el('span', 'modal__rule'));
  block.append(head);
  return block;
}

function modalItem(at, title, onClick) {
  const row = el(onClick ? 'button' : 'div', 'modal__item');
  if (onClick) {
    row.type = 'button';
    row.addEventListener('click', onClick);
  }
  row.append(el('span', 'modal__at', at), el('span', 'modal__what', title));
  return row;
}

// ---------------------------------------------------------------- 사용법
//
// 기능이 늘어날수록 '있는 줄 몰라서 못 쓰는' 기능이 생긴다.
// 조작법과 문법을 한 장에 모아 언제든 열어 볼 수 있게 한다(? 키 · 설정 › 사용법).

const HELP = [
  ['손으로', [
    ['날짜를 눌러 옆으로 끌기', '그 기간으로 새 일정'],
    ['막대를 끌기 · 양 끝 끌기', '옮기기 · 기간 늘이고 줄이기'],
    ['일정을 날짜 칸으로 끌기', '날짜 옮기기'],
    ['목표를 요일 · 날짜 칸으로 끌기', '그날로 잡기'],
    ['일정을 D-Day 칸으로 끌기', 'D-Day 고정'],
    ['제목 더블클릭', '이름만 고치기'],
    ['할 일 줄 누르기 · 끌기', '지우기(줄 긋기) · 순서 바꾸기'],
    ['여러 줄 붙여 넣기(할 일)', '줄마다 하나씩'],
    ['우클릭', '그 자리에서 할 수 있는 일'],
    ['제본선 두 번 누르기', '오른쪽 면 원래 폭'],
    ['두 손가락 좌우', '달 넘기기'],
  ]],
  ['단축키', [
    ['N', '새 일정 · 할 일에서는 적는 줄 · 계획에서는 새 목표'],
    ['Ctrl + Z / Ctrl + Shift + Z', '되돌리기 / 다시 실행'],
    ['Ctrl + ,', '설정'],
    ['← → / ↑ ↓', '하루 / 일주일'],
    ['PageUp / PageDown', '한 달'],
    ['T', '오늘로'],
    ['Space · Enter · Delete', '목록에서 완료 · 상세 · 삭제'],
    ['Esc', '닫기'],
    ['Alt + Shift + S', '위젯 보이기 · 클릭 통과 풀기'],
  ]],
  ['한 줄로 적기', [
    ['! / !!', '중요 / 긴급'],
    ['#태그', '태그'],
    ['@내일  @금  @8/15', '시작일'],
    ['~3d  ~8/20', '종료일'],
    ['15:00  14시  오후3시', '시각'],
    ['15:00~18:00', '시작 · 종료 시각'],
    ['15:00 1시간  오후2시 30분', '시작 시각 + 길이'],
    ['*파랑 *초록 *노랑 *빨강 *보라 *회색', '색'],
  ]],
];

function toggleHelp() {
  if (helpSheet) { closeHelp(); return; }

  const { scrim, card } = openModal('help', '사용법', closeHelp);
  const { head } = modalHead('사용법', '', closeHelp);
  card.append(head);

  for (const [section, rows] of HELP) {
    const block = modalBlock(section);
    for (const [key, desc] of rows) {
      const row = el('div', 'help__row');
      row.append(el('span', 'help__key', key), el('span', 'help__desc', desc));
      block.append(row);
    }
    card.append(block);
  }

  helpSheet = scrim;
}

function closeHelp() {
  helpSheet?.remove();
  helpSheet = null;
}

// ---------------------------------------------------------------- 받은함
//
// 바깥(스크립트 · AI · 다른 앱)에서 온 일정이 들어오는 자리. 메인이 파일을 읽어 모양만 보고
// 넘겨 주면, 해석은 여기서 한다 — 한 줄 문법 하나로 통일해 두면 문법이 두 벌이 되지 않는다.
// 들어온 것은 토스트로 알리고 **한 번에 되돌릴 수 있다**. 조용히 늘어나 있으면 남의 글이 된다.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** '치과 @내일 15:00 #건강 !' → 일정 한 건. base 는 파일을 쓴 날('@내일' 의 기준) */
function taskFromLine(line, base = todayKey()) {
  const today = base;
  const parsed = parseQuickInput(String(line), today);
  const title = parsed.title.trim();
  if (!title) return null;
  // 날짜를 안 적었으면 오늘이다 — 바깥에서 넣는 건 대개 '지금 이 일정을 넣어 둬' 다
  const { start, end } = resolveRange(parsed, today);
  return {
    title: title.slice(0, 200),
    start: start || today,
    end: end || start || today,
    startTime: parsed.startTime || null,
    endTime: parsed.endTime || null,
    tags: parsed.tags,
    priority: parsed.priority,
    color: parsed.color || 'blue',
  };
}

/** JSON 한 건 — 모양만 추린다. 날짜 · 시각 규칙은 store 가 다시 본다. */
function taskFromJSON(raw, base = todayKey()) {
  const title = String(raw?.title ?? '').trim().slice(0, 200);
  if (!title) return null;
  const today = base;
  // start 를 '명시적으로 null' 로 주면 날짜 없는 '언젠가' 다
  const undated = raw.start === null;
  const start = DATE_RE.test(String(raw.start)) ? raw.start : (undated ? null : today);
  const end = DATE_RE.test(String(raw.end)) ? raw.end : start;
  return {
    title,
    start,
    end,
    startTime: TIME_RE.test(String(raw.startTime)) ? raw.startTime : null,
    endTime: TIME_RE.test(String(raw.endTime)) ? raw.endTime : null,
    notes: String(raw.notes ?? '').slice(0, 2000),
    tags: Array.isArray(raw.tags)
      ? raw.tags.map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean).slice(0, 8)
      : [],
    priority: [0, 1, 2].includes(Number(raw.priority)) ? Number(raw.priority) : 0,
    color: typeof raw.color === 'string' && store.COLORS[raw.color] ? raw.color : 'blue',
    link: typeof raw.link === 'string' ? raw.link.slice(0, 500) : '',
  };
}

function takeInbox(payload) {
  if (!payload) return;

  // '@내일' · '이번 주' 는 파일을 쓴 날 기준이다 — 앱이 꺼져 있다가 다음 날 읽어도 밀리지 않게.
  // 시계가 어긋나 앞날로 찍혀 있으면 오늘로 본다.
  const today = todayKey();
  const base = DATE_RE.test(String(payload.written)) && payload.written < today ? payload.written : today;

  const patches = [];
  for (const line of payload.lines || []) {
    const t = taskFromLine(line, base);
    if (t) patches.push(t);
  }
  for (const raw of payload.tasks || []) {
    const t = taskFromJSON(raw, base);
    if (t) patches.push(t);
  }
  const added = store.addTasks(patches, `받은함 ${patches.length}건`);

  // 주 · 달 목표도 받는다 — {"goals":[{"scope":"week","title":"보고서 초안"}]}
  let goals = 0;
  for (const g of payload.goals || []) {
    const title = String(g?.title ?? '').trim().slice(0, 200);
    if (!title) continue;
    const scope = String(g?.scope) === 'month'
      ? store.monthScope(base)
      : store.weekScope(base);
    if (store.addGoal(scope, { title })) goals++;
  }

  // 할 일 — {"todos":["견적서 검토", ...]}. 쓴 날의 목록에 들어간다.
  const todoTexts = (payload.todos || []).map((x) => String(x ?? '').trim()).filter(Boolean);
  const todos = todoTexts.length
    ? store.addTodos(todoTexts, base, `받은함 할 일 ${todoTexts.length}개`)
    : 0;

  const n = added + goals + todos;
  if (n) showToast(`밖에서 ${n}건이 들어왔습니다`, { undo: true });
}

function wireInbox() {
  window.api.inbox?.onItems?.(takeInbox);
  // 이제 받을 준비가 됐다 — 앱이 꺼져 있는 동안 쌓인 것이 여기서 들어온다
  window.api.inbox?.ready?.();
}

// ---------------------------------------------------------------- 휴대폰 동기화
//
// 폰 앱과 같은 폴더(OneDrive 등)를 고르면 그 폴더의 파일로 양방향 동기화한다(docs/SYNC.md).
// 받은 변경은 되돌리기 이력을 비우므로 토스트에 되돌리기 단추를 달지 않는다.

function wirePhoneSync() {
  sync = wireSync({
    store,
    notify: (n) => showToast(`다른 기기에서 ${n}건을 받았습니다`),
  });
  sync.refresh().catch(() => {});
}

/** 설정 줄의 한 줄 상태 — '일정동기화 · 다른 기기 1대 · 3분 전' */
function syncNote(st) {
  if (!st?.enabled) return '폰 앱과 같은 폴더를 고르면 켜집니다';
  if (st.lastError) return st.lastError;
  const folder = String(st.folder || '').split(/[\\/]/).filter(Boolean).pop() || st.folder;
  const n = st.peers?.length || 0;
  const latest = st.peers?.[0]?.savedAt;
  return [folder, n ? `다른 기기 ${n}대` : '아직 다른 기기 없음', latest ? timeAgo(latest) : null]
    .filter(Boolean).join(' · ');
}

async function pickSyncFolder() {
  const r = await window.api.sync?.pickFolder();
  if (!r || r.canceled) return;
  if (!r.ok) {
    showToast(r.error || '폴더를 고르지 못했습니다');
    return;
  }
  await sync?.refresh();
  showToast('동기화를 켰습니다 — 폰 앱에서도 같은 폴더를 고르세요');
}

async function disableSync() {
  await window.api.sync?.disable();
  await sync?.refresh();
  showToast('동기화를 껐습니다');
}

// ---------------------------------------------------------------- 날씨
//
// 달력 머리의 스티커와 아침 브리핑 한 줄이 쓴다. 받아오는 일은 메인이 한다(CSP).
// 30분마다 한 번, 그리고 창을 다시 볼 때. 못 받으면 조용히 있던 값을 쓴다.

const WEATHER_MS = 30 * 60 * 1000;
let weatherTimer = 0;
let weatherAt = 0;

async function pullWeather(force = false) {
  const s = store.getState().settings;
  if (s.weather === false) { store.setWeather(null); return; }
  if (!force && Date.now() - weatherAt < WEATHER_MS) return;
  weatherAt = Date.now();
  try {
    const data = await window.api.weather?.get(s.weatherCity || '서울');
    store.setWeather(data || null);
  } catch { /* 날씨 한 줄 때문에 앱이 시끄러울 이유는 없다 */ }
}

function wireWeather() {
  pullWeather(true);
  clearInterval(weatherTimer);
  weatherTimer = setInterval(() => pullWeather(), WEATHER_MS);
  // 절전에서 깨면 타이머가 늦는다 — 창을 다시 볼 때도 확인한다
  window.addEventListener('focus', () => pullWeather());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pullWeather();
  });
}

// ---------------------------------------------------------------- 날짜 감시
//
// 바탕화면에 며칠씩 떠 있는 위젯이다. 자정이 지나도 아무도 다시 그리지 않으면
// '오늘'이 어제를 계속 보여 주고, 어제 못 끝낸 일은 '지난 일'로도 넘어가지 않는다.
//
// 1초 타이머는 돌리지 않는다. 다음 자정에 한 번 깨어나고,
// 창이 다시 활성화될 때도 확인한다(절전에서 깬 경우 타이머가 늦게 오기 때문).

let watchedDay = todayKey();
let dayTimer = 0;
let briefArmed = false;   // 날짜가 바뀌었으니 다음에 창을 볼 때 브리핑을 띄운다

function msUntilNextMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2, 0);
  return Math.max(1000, next - now);
}

// '지금' 이 들어간 글(시간표의 지금 선 · 다음 일정까지 · 비서의 한 줄)은 분이 바뀌면 낡는다.
// 창이 보이는 동안만 1분에 한 번 다시 그린다(움직이는 그림이 아니라 글자 몇 개를 고치는 일이다).
function scheduleMinuteTick() {
  const now = new Date();
  const wait = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 50;
  setTimeout(() => {
    if (!document.hidden) store.touch();
    scheduleMinuteTick();
  }, wait);
}

function wireDayWatch() {
  scheduleDayTick();
  scheduleMinuteTick();
  // 절전에서 깨면 setTimeout 이 한참 늦게 온다. 창을 다시 볼 때도 확인한다.
  window.addEventListener('focus', checkDayChange);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkDayChange();
  });
}

function scheduleDayTick() {
  clearTimeout(dayTimer);
  dayTimer = setTimeout(() => {
    dayTimer = 0;
    checkDayChange();
    scheduleDayTick();
  }, msUntilNextMidnight());
}

function checkDayChange() {
  const today = todayKey();

  // 날짜가 그대로여도, 창을 다시 봤을 때 밀린 브리핑이 있으면 지금 띄운다
  if (today === watchedDay) {
    if (briefArmed && document.hasFocus()) {
      briefArmed = false;
      maybeShowBrief();
    }
    return;
  }

  const previous = watchedDay;
  watchedDay = today;

  // 어제 날짜를 보고 있었다면 오늘로 따라간다.
  // 다른 날짜를 일부러 골라 둔 상태라면 건드리지 않는다.
  if (store.getState().selectedDate === previous) store.selectDate(today);
  else store.touch();

  reportToTray();
  if (els.year) els.year.textContent = romanYear(new Date().getFullYear());

  // 자정에 모달을 띄우면 방해다. 다음에 창을 볼 때 보여 준다.
  briefArmed = true;
  if (document.hasFocus()) {
    briefArmed = false;
    maybeShowBrief();
  }
}

// ---------------------------------------------------------------- 책갈피 탭
//
// 오른쪽 면 바깥에 붙어 면을 갈아 끼운다(시안) — 하루 · 할 일 · 계획 · 설정.
// 이름은 그 면이 하는 일이다: '하루' 는 고른 날의 시간표(오늘만이 아니다),
// '할 일' 은 달력과 따로 적고 지워 나가는 체크리스트, '계획' 은 주 · 달 단위로 짜고 돌아보는 자리.
// 탭 하나가 면 하나다. 같은 면을 여는 단추를 다른 곳에 또 두지 않는다
// (설정 톱니 · 루틴 탭 · 브리핑 탭은 걷었다. 브리핑은 표지의 해돋이가 연다).
// 상세 · 추가 화면은 그 면 안의 한 장이라 탭은 그 면을 켠 채로 둔다.

let tabNow = 'main';   // 'main' | 'todos' | 'plan' — 오른쪽 면이 알려 준다(app:screen)

function paintTabs() {
  const settingsOpen = !els.settings.hidden;
  els.tabMain?.classList.toggle('is-on', !settingsOpen && tabNow === 'main');
  els.tabTodos?.classList.toggle('is-on', !settingsOpen && tabNow === 'todos');
  els.tabPlan?.classList.toggle('is-on', !settingsOpen && tabNow === 'plan');
  els.tabSettings?.classList.toggle('is-on', settingsOpen);
}

function goTab(name) {
  if (!els.settings.hidden) toggleSettings();
  document.dispatchEvent(new CustomEvent({ plan: 'app:plan', todos: 'app:todos' }[name] || 'app:today'));
}

function wireTabs() {
  document.addEventListener('app:screen', (e) => {
    tabNow = e.detail?.tab || 'main';
    paintTabs();
  });

  els.tabMain?.addEventListener('click', () => goTab('main'));
  els.tabTodos?.addEventListener('click', () => goTab('todos'));
  els.tabPlan?.addEventListener('click', () => goTab('plan'));
  els.tabSettings?.addEventListener('click', () => {
    if (els.settings.hidden) toggleSettings();
  });
  paintTabs();
}

// ---------------------------------------------------------------- 아침 브리핑
//
// 이 앱은 그동안 '물어봐야 답하는 장부'였다. 창을 열고, 날짜를 고르고, 목록을 봐야
// 비로소 뭐가 있는지 알 수 있었다. 비서라면 켜자마자 먼저 말해야 한다.
//
// 하루에 한 번만 뜬다. 매번 뜨면 그냥 닫아 버리는 관문이 되고, 그러면 아무 말도
// 안 하는 것과 같아진다.

/** '9/1 (화)' */
function shortDate(key) {
  const d = fromKey(key);
  return `${d.getMonth() + 1}/${d.getDate()} (${WEEKDAY_LABELS[d.getDay()]})`;
}

/** 지금 'HH:MM' */
function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 시안의 말투 — '두 건', '오후 세 시'. 숫자를 우리말로 읽는다.
const KO_COUNT = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];
const KO_HOUR = ['열두', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열', '열한'];

/** 3 → '세 건', 12 → '12건' */
function countKo(n, unit = '건') {
  return n >= 1 && n <= 10 ? `${KO_COUNT[n]} ${unit}` : `${n}${unit}`;
}

/** '15:00' → '오후 세 시', '09:30' → '오전 아홉 시 반' */
function timeKo(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const min = m === 0 ? '' : (m === 30 ? ' 반' : ` ${m}분`);
  return `${h < 12 ? '오전' : '오후'} ${KO_HOUR[h % 12]} 시${min}`;
}

/** 브리핑에 담을 것들을 모은다 */
function briefData() {
  const today = todayKey();
  const st = store.getState();

  // 필터를 무시한다 — 브리핑은 화면에 걸린 태그와 무관하게 하루 전체를 보고한다
  const todays = store.tasksOnDate(today, { filtered: false }).filter((t) => !t.done);
  const overdue = store.overdueTasks(today, { filtered: false });

  // 임박한 D-Day — 지난 것은 '지난 일'이 이미 말해 주므로 뺀다
  const upcoming = store.pinnedTasks().filter((p) => !p.overdue).slice(0, 3);

  // 이번 주에 남은 몫 (내일부터 이번 주 끝까지).
  // 이미 진행 중인 계획은 시작일이 지난주일 수 있다 — '이번 주에 걸리는 첫날' 로 적는다.
  const week = weekGrid(today).filter((k) => k > today);
  const weekList = st.tasks
    .filter((t) => {
      if (t.done || !t.start || t.repeat) return false;
      const end = t.end || t.start;
      return week.some((k) => k >= t.start && k <= end);
    })
    .map((t) => ({ ...t, weekDay: week.find((k) => k >= t.start && k <= (t.end || t.start)) }))
    .sort((a, b) => (a.weekDay < b.weekDay ? -1 : a.weekDay > b.weekDay ? 1 : 0));

  return { today, todays, overdue, upcoming, weekList };
}

function shouldShowBrief() {
  const s = store.getState().settings;
  if (!s.showBrief) return false;
  if (s.lastBriefDate === todayKey()) return false;
  const { todays, overdue, upcoming } = briefData();
  // 할 말이 없으면 말하지 않는다. 빈 브리핑은 방해일 뿐이다.
  return todays.length > 0 || overdue.length > 0 || upcoming.length > 0;
}

function maybeShowBrief() {
  if (!shouldShowBrief()) return;
  showBrief();
}

/**
 * 첫 문장 — 시안: '밀린 일 두 건이 어제까지였습니다.
 * 오늘은 다섯 건, 그중 하나는 오후 세 시 미팅입니다.'
 */
function briefLead({ today, todays, overdue }) {
  const parts = [];
  if (overdue.length) {
    const latest = overdue.reduce((acc, t) => {
      const due = t.end || t.start;
      return due > acc ? due : acc;
    }, '');
    parts.push(latest === addDays(today, -1)
      ? `밀린 일 ${countKo(overdue.length)}이 어제까지였습니다.`
      : `밀린 일 ${countKo(overdue.length)}이 아직 남아 있습니다.`);
  }

  if (todays.length) {
    // 짚어 줄 하나 — 아직 오지 않은 시각 일정 중 중요한 것, 없으면 가장 이른 것
    const now = nowHHMM();
    const timed = todays.filter((t) => t.startTime && t.startTime >= now)
      .sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
    const pick = timed.find((t) => t.priority >= 1) || timed[0];
    if (todays.length === 1) {
      parts.push(pick
        ? `오늘은 ${timeKo(pick.startTime)} ${pick.title || '일정'} 하나입니다.`
        : '오늘은 한 건입니다.');
    } else {
      parts.push(pick
        ? `오늘은 ${countKo(todays.length)}, 그중 하나는 ${timeKo(pick.startTime)} ${pick.title || '일정'}입니다.`
        : `오늘은 ${countKo(todays.length)}입니다.`);
    }
  } else {
    parts.push('오늘 잡힌 일은 없습니다.');
  }

  // 할 일 — 달력 밖에 적어 둔 오늘 몫도 같은 입으로 말한다
  const left = store.todosOn(today).filter((t) => !t.doneHere);
  if (left.length) {
    const carried = left.filter((t) => t.age >= 2).length;
    const n = countKo(left.length, '개');
    if (!carried) parts.push(`할 일은 ${n}입니다.`);
    else if (carried < left.length) parts.push(`할 일은 ${n}, 그중 ${countKo(carried, '개')}는 전날부터 이어졌습니다.`);
    else if (left.length === 1) parts.push('전날부터 이어진 할 일이 한 개 있습니다.');
    else parts.push(`할 일은 ${n}, 모두 전날부터 이어졌습니다.`);
  }
  return parts.join(' ');
}

function showBrief() {
  if (briefSheet) return;
  // 한 번 열었으면 오늘 몫은 본 것이다 — 오늘은 다시 저절로 뜨지 않는다
  store.setSetting('lastBriefDate', todayKey());

  const data = briefData();
  const { today, todays, overdue, upcoming, weekList } = data;
  const d = fromKey(today);

  const { scrim, card } = openModal('brief', '아침 브리핑', closeBrief);
  const { head } = modalHead('아침 브리핑',
    `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAY_FULL[d.getDay()]} · ${nowHHMM()}`, closeBrief);
  card.append(head);

  // 오늘 날씨 — 하루를 짜기 전에 먼저 보는 것
  const w = store.getState().settings.weather === false ? null : store.getState().weather;
  if (w) {
    const line = el('div', 'modal__weather');
    line.append(icon(w.icon, 15, 1.4), el('span', 'modal__weathert num', `${w.temp}°`));
    const range = w.low != null && w.high != null ? ` · ${w.low}° / ${w.high}°` : '';
    line.append(el('span', null, `${w.label}${range}`), el('span', 'modal__weatherc', w.city));
    card.append(line);
  }

  card.append(el('div', 'modal__lead', briefLead(data)));

  const openTask = (t) => () => {
    if (t.start) store.selectDate(t.occDate || t.start);
    store.setEditing(t.id);
    closeBrief();
  };

  const blocks = el('div', 'modal__blocks');

  // --- 밀린 일 (가장 먼저)
  if (overdue.length) {
    const block = modalBlock('밀린 일', overdue.length, { seal: true });
    for (const t of overdue.slice(0, 3)) {
      block.append(modalItem(shortDate(t.end || t.start), t.title || '(제목 없음)', openTask(t)));
    }
    if (overdue.length > 3) block.append(modalItem('', `외 ${overdue.length - 3}건`));
    blocks.append(block);
  }

  // --- 오늘 — tasksOnDate 가 이미 시각순으로 정렬해 준다
  if (todays.length) {
    const block = modalBlock('오늘', todays.length);
    for (const t of todays.slice(0, 4)) {
      block.append(modalItem(t.startTime || '종일', t.title || '(제목 없음)', openTask(t)));
    }
    if (todays.length > 4) block.append(modalItem('', `외 ${todays.length - 4}건`));
    blocks.append(block);
  }

  // --- 할 일 — 오늘 목록에 남은 것(전날에서 이어진 것엔 '2일째'). 누르면 할 일 면으로.
  const todoLeft = store.todosOn(today).filter((t) => !t.doneHere);
  if (todoLeft.length) {
    const block = modalBlock('할 일', todoLeft.length);
    const openTodos = () => {
      store.selectDate(today);
      closeBrief();
      goTab('todos');
    };
    for (const t of todoLeft.slice(0, 3)) {
      // 시간을 잡아 둔 할 일은 그 시각, 이어진 것은 묵은 날수
      const task = store.todoTask(t);
      const at = task?.startTime || (t.age >= 2 ? `${t.age}일째` : '');
      block.append(modalItem(at, t.text, openTodos));
    }
    if (todoLeft.length > 3) block.append(modalItem('', `외 ${todoLeft.length - 3}개`, openTodos));
    blocks.append(block);
  }

  // --- 다가오는 목표
  if (upcoming.length) {
    const block = modalBlock('다가오는 목표', upcoming.length);
    for (const t of upcoming) {
      block.append(modalItem(t.remaining === 0 ? 'D-DAY' : `D-${t.remaining}`,
        t.title || '(제목 없음)', openTask(t)));
    }
    blocks.append(block);
  }

  // --- 이번 주 남은 몫
  if (weekList.length) {
    const block = modalBlock('이번 주 남은 몫', weekList.length);
    for (const t of weekList.slice(0, 2)) {
      block.append(modalItem(shortDate(t.weekDay), t.title || '(제목 없음)', openTask(t)));
    }
    blocks.append(block);
  }
  card.append(blocks);

  // --- 꼬리 — 밀린 일이 있을 때만. 닫기는 머리의 ✕ 하나다.
  if (overdue.length) {
    const foot = el('div', 'modal__foot');
    const acts = el('div', 'modal__acts');
    const roll = el('button', 'modal__btn modal__btn--seal', '밀린 일 오늘로 당기기');
    roll.type = 'button';
    roll.addEventListener('click', () => {
      const ids = overdue.map((t) => t.id);
      const n = store.moveTasksTo(ids, today, `밀린 일 ${ids.length}건 오늘로`);
      store.selectDate(today);
      closeBrief();
      if (n) showToast(`${n}건을 오늘로 옮겼습니다`, { undo: true });
    });
    acts.append(roll);
    foot.append(acts);
    card.append(foot);
  }

  briefSheet = scrim;
}

function closeBrief() {
  briefSheet?.remove();
  briefSheet = null;
}

// ---------------------------------------------------------------- 리마인더

function wireReminders() {
  reminders = startReminders(store);

  // 알림을 클릭하면 해당 일정으로 이동해 상세를 연다
  window.api.reminder.onClick((taskId) => {
    const task = store.getState().tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (task.start) store.selectDate(task.start);
    store.setEditing(task.id);
  });
}

let bellPopover = null;

/** 아직 안 본 알림이 있으면 종에 점을 찍는다 */
function syncBellDot(state) {
  const seen = state.settings.bellSeenAt || 0;
  const unseen = (state.reminderLog || []).some((e) => (e.at || 0) > seen);
  els.btnBell?.classList.toggle('has-dot', unseen);
}

function toggleBell() {
  if (bellPopover) { closeBell(); return; }

  const log = store.getState().reminderLog;
  store.setSetting('bellSeenAt', Date.now());

  const pop = el('div', 'bell');
  const head = el('div', 'bell__head');
  head.append(el('span', 'bell__label', '알림 기록'));

  if (log.length) {
    const clear = el('button', 'bell__clear', '지우기');
    clear.type = 'button';
    clear.addEventListener('click', () => { store.clearReminderLog(); closeBell(); });
    head.append(clear);
  }
  pop.append(head);

  if (!log.length) {
    pop.append(el('div', 'bell__empty', '받은 알림이 없습니다'));
  } else {
    const list = el('div', 'bell__list');
    for (const entry of log) {
      const row = el('button', 'bell__row');
      row.type = 'button';
      row.append(el('span', 'bell__title', entry.title || '(제목 없음)'),
                 el('span', 'bell__when', timeAgo(entry.at)));
      row.addEventListener('click', () => {
        const task = store.getState().tasks.find((x) => x.id === entry.taskId);
        if (task) {
          if (task.start) store.selectDate(task.start);
          store.setEditing(task.id);
        }
        closeBell();
      });
      list.append(row);
    }
    pop.append(list);
  }

  // 종 바로 아래, 오른쪽 끝을 맞춘다
  const rootRect = els.root.getBoundingClientRect();
  const btnRect = els.btnBell.getBoundingClientRect();
  pop.style.top = `${Math.round(btnRect.bottom - rootRect.top + 6)}px`;
  pop.style.right = `${Math.max(8, Math.round(rootRect.right - btnRect.right))}px`;

  els.root.append(pop);
  bellPopover = pop;
  els.btnBell.classList.add('is-active');
  els.btnBell.setAttribute('aria-expanded', 'true');

  // 바깥을 클릭하면 닫힌다
  setTimeout(() => document.addEventListener('click', onDocClickForBell), 0);
}

function onDocClickForBell(e) {
  if (bellPopover && !bellPopover.contains(e.target)) closeBell();
}

function closeBell() {
  document.removeEventListener('click', onDocClickForBell);
  bellPopover?.remove();
  bellPopover = null;
  els.btnBell.classList.remove('is-active');
  els.btnBell.setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------- 제본선
//
// 시안은 오른쪽 면 452px 고정이다. 제본선을 끌면 사용자가 바꿀 수 있고,
// 두 번 누르면 시안 폭으로 돌아간다.

function wireSplitter() {
  let dragging = false;
  let lastRight = 0;

  els.splitter.title = '끌어서 폭 조절 · 두 번 누르면 원래대로';

  els.splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    els.splitter.classList.add('is-dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = els.panes.getBoundingClientRect();
    // 오른쪽 면 폭 = 펼침면 오른쪽 끝에서 커서까지 − 제본선 절반.
    // 시간표가 무너지지 않는 폭(420)과 달력이 읽히는 폭(320)은 지킨다.
    const right = rect.right - e.clientX - 15;
    lastRight = Math.round(Math.min(Math.max(right, 420), rect.width - 30 - 320));
    document.documentElement.style.setProperty('--right-w', `${lastRight}px`);
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    els.splitter.classList.remove('is-dragging');
    document.body.style.cursor = '';
    if (!lastRight) return;
    // 드래그가 끝날 때만 저장 (매 프레임 저장하면 디스크가 갈린다)
    const total = els.panes.clientWidth - 30;
    store.setSetting('splitRatio', total > 0 ? 1 - lastRight / total : DEFAULT_RATIO);
    lastRight = 0;
  });

  els.splitter.addEventListener('dblclick', () => store.setSetting('splitRatio', DEFAULT_RATIO));
}

// ---------------------------------------------------------------- 설정 (오른쪽 면의 한 화면)

function toggleSettings() {
  const open = els.settings.hidden;
  els.settings.hidden = !open;
  els.todo.classList.toggle('is-settings', open);
  if (open) {
    renderSettings();
    els.settings.scrollTop = 0;
  }
  paintTabs();
}

/** 시안의 선택 칩 — 켜짐: 금박 윤곽 · 금박 글자 · 옅은 금박 바탕 */
function opt(label, on, pick) {
  return { label, on: !!on, pick };
}

function setRow(label, note, opts) {
  const row = el('div', 'set-row');
  const text = el('span', 'set-row__text');
  text.append(el('span', 'set-row__label', label));
  if (note) text.append(el('span', 'set-row__note', note));
  const box = el('span', 'set-row__opts');
  for (const o of opts) {
    const b = el('button', 'set-opt', o.label);
    b.type = 'button';
    b.classList.toggle('is-on', o.on);
    b.setAttribute('aria-pressed', String(o.on));
    b.addEventListener('click', async () => {
      await o.pick?.();
      if (!els.settings.hidden) renderSettings();
    });
    box.append(b);
  }
  row.append(text, box);
  return { row, box };
}

function setGroup(title, rows) {
  const group = el('div', 'set-group');
  const head = el('div', 'set-group__head');
  head.append(el('span', 'set-group__title', title), el('span', 'set-group__rule'));
  group.append(head, ...rows.map((r) => r.row || r));
  return group;
}

function renderSettings() {
  const s = store.getState().settings;
  const set = (key, value) => () => store.setSetting(key, value);
  const onOff = (key, note, label) => setRow(label, note, [
    opt('켬', s[key] !== false, set(key, true)),
    opt('끔', s[key] === false, set(key, false)),
  ]);

  // 설정은 책갈피 면이다 — 돌아가는 단추 대신 옆의 '하루' 탭(또는 Esc)
  const screen = el('div', 'scr set-screen');
  const head = el('div', 'scr-head');
  head.append(el('span', 'scr-head__title', '설정'));

  // 글자 크기 — 확대 비율. 예전 설정(0.8~1.4)은 가까운 칸으로 읽는다.
  const scale = s.fontScale || 1;
  const sizeBucket = scale <= 0.95 ? 'small' : (scale >= 1.05 ? 'large' : 'normal');

  // 창 크기 — 지금 창 폭으로 가까운 쪽을 켠다
  const sizeRow = setRow('창 크기', '', [
    opt('좁게', false, () => window.api.window.snapPreset('narrow')),
    opt('넓게', false, () => window.api.window.snapPreset('wide')),
  ]);
  window.api.window.getBounds?.().then((b) => {
    if (!b?.width) return;
    const wide = b.width >= 1200;
    const [narrowBtn, wideBtn] = sizeRow.box.children;
    narrowBtn?.classList.toggle('is-on', !wide);
    wideBtn?.classList.toggle('is-on', wide);
  }).catch(() => {});

  const autoRow = setRow('부팅 시 자동 시작', '', [
    opt('켬', false, async () => applyAutoLaunch(true)),
    opt('끔', false, async () => applyAutoLaunch(false)),
  ]);
  window.api.app.getAutoLaunch().then((r) => {
    const [onBtn, offBtn] = autoRow.box.children;
    onBtn?.classList.toggle('is-on', !!r?.enabled);
    offBtn?.classList.toggle('is-on', !r?.enabled);
    if (r?.dev) autoRow.row.title = '개발 실행 중에는 적용되지 않습니다 (설치본에서 동작).';
  }).catch(() => {});

  // 도시 — 목록에서 고른다. 좌표는 앱이 들고 있어서 검색에 네트워크를 쓰지 않는다.
  const weatherRow = setRow('도시', '', [
    opt(s.weatherCity || '서울', false, () => pickCity(weatherRow.box)),
  ]);
  weatherRow.row.hidden = s.weather === false;

  // 휴대폰 동기화 — 상태는 메인에게 물어 채운다(폴더 · 다른 기기 · 오류)
  const syncRow = setRow('휴대폰 동기화', '', [opt('폴더 고르기', false, pickSyncFolder)]);
  window.api.sync?.status().then((st) => {
    if (!st?.enabled) {
      syncRow.row.replaceWith(setRow('휴대폰 동기화', syncNote(st), [
        opt('폴더 고르기', false, pickSyncFolder),
      ]).row);
      return;
    }
    syncRow.row.replaceWith(setRow('휴대폰 동기화', syncNote(st), [
      opt('바꾸기', false, pickSyncFolder),
      opt('열기', false, () => window.api.sync.openFolder()),
      opt('끄기', false, disableSync),
    ]).row);
  }).catch(() => {});

  const body = el('div', 'set-body');
  body.append(
    setGroup('보임', [
      setRow('테마', '', [
        opt('밝게', s.theme !== 'dark', set('theme', 'light')),
        opt('어둡게', s.theme === 'dark', set('theme', 'dark')),
      ]),
      // 예전 설정(40~100% 슬라이더)은 가장 가까운 칸으로 읽는다
      setRow('배경 투명도', '',
        [0.7, 0.85, 1].map((v, _i, all) => {
          const cur = s.opacity ?? 0.85;
          const nearest = all.reduce((a, b) => (Math.abs(b - cur) < Math.abs(a - cur) ? b : a));
          return opt(`${Math.round(v * 100)}%`, v === nearest, set('opacity', v));
        })),
      setRow('글자 크기', '', [
        opt('작게', sizeBucket === 'small', set('fontScale', 0.9)),
        opt('보통', sizeBucket === 'normal', set('fontScale', 1)),
        opt('크게', sizeBucket === 'large', set('fontScale', 1.1)),
      ]),
      sizeRow,
      onOff('blurEnabled', '', '배경 흐림'),
      onOff('dimInactive', '', '비활성일 때 흐리게'),
      onOff('showHolidays', '', '공휴일'),
      onOff('showDashboard', '', 'D-Day'),
      onOff('showLauncher', '', '퀵 런처'),
      setRow('완료 항목', '', [
        opt('보임', s.showCompleted !== false, set('showCompleted', true)),
        opt('숨김', s.showCompleted === false, set('showCompleted', false)),
      ]),
      setRow('정렬', '', [
        opt('직접', s.sortMode !== 'priority', set('sortMode', 'manual')),
        opt('중요도순', s.sortMode === 'priority', set('sortMode', 'priority')),
      ]),
    ]),
    setGroup('비서 노릇', [
      onOff('weather', '', '날씨'),
      weatherRow,
      onOff('showBrief', '', '아침 브리핑'),
      onOff('traySummary', '', '트레이 요약'),
      autoRow,
      setRow('항상 위에', '', [
        opt('켬', !!s.alwaysOnTop, set('alwaysOnTop', true)),
        opt('끔', !s.alwaysOnTop, set('alwaysOnTop', false)),
      ]),
    ]),
    setGroup('보관', [
      setRow('백업 폴더', '', [
        opt('열기', false, () => window.api.data.openBackups()),
      ]),
      // 바깥에서 일정을 넣는 문 — 파일 한 장을 떨어뜨리면 들어온다
      setRow('받은함', '', [
        opt('열기', false, () => window.api.inbox?.open()),
      ]),
      syncRow,
      setRow('내보내기', '', [
        opt('.json', false, exportBackup),
        opt('.ics', false, exportICS),
      ]),
      setRow('가져오기', '', [
        opt('합치기', false, () => importBackup('merge')),
        opt('덮어쓰기', false, () => importBackup('replace')),
      ]),
      setRow('새 버전', '', [
        opt('확인', false, () => window.api.openExternal(
          'https://github.com/rbth3015-spec/desktop-schedule-widget/releases')),
      ]),
      setRow('의견 보내기', '', [
        opt('메일 쓰기', false, sendFeedback),
      ]),
      setRow('사용법', '', [
        opt('보기', false, () => toggleHelp()),
      ]),
    ]),
  );

  // 자동 업데이트는 붙이지 않았다. 배포판에 서명이 없으면 업데이트 과정에서
  // Windows 경고가 반복되고, 릴리스를 실제로 올려야만 동작한다. 새 버전은 '새 버전' 줄이 연다.
  const foot = el('div', 'set-foot', '버전');
  window.api.app?.getVersion?.().then((info) => {
    const v = info?.version || '';
    foot.textContent = `버전 ${/^\d/.test(v) ? v : (v || '—')}`;
  }).catch(() => {});
  body.append(foot);

  screen.append(head, body);
  els.settings.replaceChildren(screen);
}

/** 도시 고르기 — 설정 줄 아래로 목록을 펼친다 */
async function pickCity(box) {
  let cities = [];
  try { cities = (await window.api.weather?.cities()) || []; } catch { /* 목록을 못 받으면 아래에서 막는다 */ }
  if (!cities.length) { showToast('도시 목록을 읽지 못했습니다'); return; }
  const cur = store.getState().settings.weatherCity || '서울';
  const r = box.getBoundingClientRect();
  showContextMenu(r.left, r.bottom + 4, cities.map((city) => ({
    label: city,
    checked: city === cur,
    onSelect: () => store.setSetting('weatherCity', city),
  })));
}

async function applyAutoLaunch(on) {
  const r = await window.api.app.setAutoLaunch(on);
  if (r?.ok) showToast(r.enabled ? '부팅 시 자동으로 켜집니다' : '자동 시작을 껐습니다');
  else showToast(r?.error || '설정하지 못했습니다');
}

/**
 * 의견 보내기 — 기본 메일 앱을 연다.
 *
 * 앱 안에 입력창을 두고 어딘가로 보내려면 서버가 필요하고, 그 서버가 죽으면
 * 사용자가 쓴 글이 조용히 사라진다. 메일 앱을 열어 주면 보낸 편지함에 남고
 * 답장도 그대로 오간다.
 *
 * 버전·OS 는 미리 적어 둔다 — '어떤 버전 쓰세요?' 를 한 번 덜 묻기 위해서다.
 */
async function sendFeedback() {
  let version = '';
  try {
    const info = await window.api.app?.getVersion?.();
    version = info?.version || '';
  } catch { /* 못 읽어도 메일은 열어야 한다 */ }

  const subject = '일정관리 비서 — 의견';
  const body = [
    '어떤 점이 불편했나요? 또는 어떤 기능이 있었으면 하나요?',
    '',
    '',
    '---',
    `버전: ${version || '알 수 없음'}`,
    `환경: ${navigator.userAgent.includes('Windows') ? 'Windows' : navigator.platform}`,
  ].join(String.fromCharCode(10));

  const href = `mailto:${FEEDBACK_TO}`
    + `?subject=${encodeURIComponent(subject)}`
    + `&body=${encodeURIComponent(body)}`;

  const res = await window.api.openExternal(href);
  if (res && res.ok === false) {
    showToast('메일 앱을 열지 못했습니다');
  }
}

async function exportBackup() {
  const res = await window.api.data.saveAs({
    title: '백업 내보내기',
    defaultName: `일정관리-백업-${fileStamp()}.json`,
    content: toBackupJSON(store.getState()),
    filters: [{ name: 'JSON 백업', extensions: ['json'] }],
  });
  if (res?.ok) showToast('백업을 저장했습니다');
  else if (res && !res.canceled) showToast(`저장 실패 — ${res.error || '알 수 없는 오류'}`);
}

async function exportICS() {
  const tasks = store.getState().tasks;
  const res = await window.api.data.saveAs({
    title: '캘린더 내보내기',
    defaultName: `일정관리-${fileStamp()}.ics`,
    content: toICS(tasks),
    filters: [{ name: 'iCalendar', extensions: ['ics'] }],
  });
  if (res?.ok) showToast('캘린더 파일을 저장했습니다');
  else if (res && !res.canceled) showToast(`저장 실패 — ${res.error || '알 수 없는 오류'}`);
}

async function importBackup(mode) {
  const picked = await window.api.data.openFile({
    title: '백업 가져오기',
    filters: [{ name: 'JSON 백업', extensions: ['json'] }],
  });
  if (!picked) return;                       // 사용자가 취소
  if (!picked.ok) { showToast(`읽기 실패 — ${picked.error}`); return; }

  const parsed = parseBackup(picked.text);
  if (!parsed.ok) { showToast(`가져오기 실패 — ${parsed.error}`); return; }

  const { added, total } = store.importData(parsed.data, mode);
  // 안내에 단축키를 적는 대신 누를 수 있는 버튼을 준다
  showToast(mode === 'replace'
    ? `${total}건으로 덮어썼습니다`
    : `${added}건을 추가했습니다`, { undo: true });
}

// ---------------------------------------------------------------- 트레이 메뉴 / 단축키

function wireMenuActions() {
  window.api.onMenuAction((action) => {
    if (action === 'today') store.selectDate(todayKey());
    if (action === 'settings') { if (els.settings.hidden) toggleSettings(); }
    if (action === 'toggle-completed') {
      store.setSetting('showCompleted', !store.getState().settings.showCompleted);
    }
    // 전역 단축키 · 트레이로 잠그거나 풀면 메인 프로세스만 상태가 바뀌므로 설정도 맞춰준다
    if (action === 'unlock') store.setSetting('clickThroughLocked', false);
    if (action === 'lock') store.setSetting('clickThroughLocked', true);

    if (action === 'brief') showBrief();
    if (action === 'todos') {
      store.selectDate(todayKey());
      goTab('todos');
    }

    if (action === 'roll-overdue') {
      const ids = store.overdueTasks(todayKey(), { filtered: false }).map((t) => t.id);
      if (!ids.length) { showToast('밀린 일이 없습니다'); return; }
      const n = store.moveTasksTo(ids, todayKey(), `밀린 일 ${ids.length}건 오늘로`);
      store.selectDate(todayKey());
      if (n) showToast(`${n}건을 오늘로 옮겼습니다`, { undo: true });
    }

    // 트레이에서 일정 한 줄을 누르면 그 일정을 연다
    if (action.startsWith('open-task:')) {
      const id = action.slice('open-task:'.length);
      const task = store.getState().tasks.find((t) => t.id === id);
      if (!task) return;
      if (task.start) store.selectDate(task.start);
      store.setEditing(task.id);
    }
  });
}

// ---------------------------------------------------------------- 트레이 보고
//
// 창을 열지 않아도 오늘 몫을 알 수 있어야 한다. 트레이 툴팁과 메뉴가
// 그 통로다. 일정 해석(반복 회차 펼치기 등)은 렌더러만 할 수 있으므로
// 여기서 요약을 만들어 메인에 넘긴다. 설정에서 끄면 이름만 남긴다.

let lastTraySignature = '';

function reportToTray() {
  const today = todayKey();
  let summary;
  if (store.getState().settings.traySummary === false) {
    summary = { off: true, today: 0, overdue: 0, items: [] };
  } else {
    const onToday = store.tasksOnDate(today, { filtered: false });
    const undone = onToday.filter((t) => !t.done);
    summary = {
      today: undone.length,
      overdue: store.overdueTasks(today, { filtered: false }).length,
      // 할 일도 트레이가 말한다 — 창을 열지 않아도 오늘 몫이 한 번에 보이게
      todos: store.todoSummary(today).open,
      // tasksOnDate 가 이미 시각순으로 정렬해 준다 — 앞의 다섯 줄이 곧 하루의 앞부분
      items: onToday.slice(0, 5).map((t) => ({
        id: t.id,
        title: t.title || '(제목 없음)',
        time: t.startTime || '',
        done: !!t.done,
      })),
    };
  }

  // 값이 그대로면 IPC 를 쏘지 않는다. store 는 모든 변경마다 emit 하므로
  // 걸러 내지 않으면 글자 한 자 칠 때마다 트레이 메뉴를 다시 만들게 된다.
  const sig = JSON.stringify(summary);
  if (sig === lastTraySignature) return;
  lastTraySignature = sig;
  window.api.tray?.setSummary(summary);
}

function wireShortcuts() {
  window.addEventListener('keydown', (e) => {
    // 입력 중일 땐 앱 단축키를 가로채지 않는다.
    // 다만 '입력창에 포커스가 있다'는 이유만으로 전부 막으면, 검색창에 커서가 놓인 순간
    // Ctrl+Z 가 먹통이 된다. 내용이 빈 입력창은 네이티브 실행취소가 할 일이 없으므로
    // 앱 단축키에 넘겨준다.
    const active = document.activeElement;
    const tag = active?.tagName;
    const isField = tag === 'INPUT' || tag === 'TEXTAREA' || active?.isContentEditable;
    if (isField) {
      if (e.key === 'Escape') {
        // 입력칸에서 나오는 것으로 끝내지 않는다. 항목을 고치던 중이었다면
        // 한 번으로 상세까지 닫아 준다 — 두 번 눌러야 나가지는 건 갇힌 느낌이다.
        active.blur();
        if (store.getState().editingTaskId) store.setEditing(null);
        return;
      }
      const hasText = active.isContentEditable ? !!active.textContent : !!active.value;
      if (hasText) return;
    }

    if (e.key === 'Escape') {
      if (helpSheet) { closeHelp(); return; }
      if (briefSheet) { closeBrief(); return; }
      if (bellPopover) { closeBell(); return; }
      if (!els.settings.hidden) { toggleSettings(); return; }
      // 항목 상세 · 추가 화면에서 빠져나오기 — 그 면(오늘 · 계획)으로
      if (store.getState().editingTaskId) { store.setEditing(null); return; }
      if (document.querySelector('.cmp:not([hidden])')) {
        document.dispatchEvent(new CustomEvent('app:close-compose'));
        return;
      }
      if (tabNow === 'plan' || tabNow === 'todos') { goTab('main'); return; }
    }
    if (e.ctrlKey && e.key === ',') { toggleSettings(); e.preventDefault(); }
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) { toggleHelp(); e.preventDefault(); return; }

    // 되돌리기 / 다시 실행.
    // 입력 중일 때는 위에서 이미 return 했으므로 여기까지 오지 않는다
    // (텍스트 편집의 Ctrl+Z 를 가로채면 안 된다).
    const z = e.key === 'z' || e.key === 'Z';
    if (e.ctrlKey && z && !e.shiftKey) {
      e.preventDefault();
      const label = store.undo();
      showToast(label ? `되돌렸습니다 — ${label}` : '되돌릴 작업이 없습니다');
      return;
    }
    if ((e.ctrlKey && z && e.shiftKey) || (e.ctrlKey && (e.key === 'y' || e.key === 'Y'))) {
      e.preventDefault();
      const label = store.redo();
      showToast(label ? `다시 실행했습니다 — ${label}` : '다시 실행할 작업이 없습니다');
    }
  });
}

// ---------------------------------------------------------------- 시작

boot().catch((err) => {
  // 부팅 실패 시 빈 화면 대신 원인을 보여준다
  document.body.innerHTML = '';
  const pre = document.createElement('pre');
  pre.style.cssText = 'padding:20px;color:#f2698c;white-space:pre-wrap;font-size:12px';
  pre.textContent = `시작 실패:\n${err?.stack || err}`;
  document.body.append(pre);
  console.error(err);
});
