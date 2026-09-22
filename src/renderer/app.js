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
import { startReminders, timeAgo } from './reminders.js';
import { toBackupJSON, parseBackup, toICS, fileStamp } from './lib/exchange.js';

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
  btnSettings: $('#btn-settings'),
  btnClose: $('#btn-close'),
  year: document.getElementById('titlebar-year'),
  tabMain: document.getElementById('tab-main'),
  tabRoutine: document.getElementById('tab-routine'),
  tabBrief: document.getElementById('tab-brief'),
  tabSettings: document.getElementById('tab-settings'),
};

// 설정은 오른쪽 면의 한 화면이다(시안). 같은 면 안에 두고 오늘 화면과 갈아 끼운다.
els.todo.append(els.settings);

let calendar = null;
let todo = null;
let dashboard = null;
let launcher = null;
let reminders = null;

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

  // 처음 켠 사람에게는 안내를, 그 뒤로는 오늘 브리핑을.
  // 둘이 겹쳐 뜨면 첫인상이 팝업 두 개가 된다.
  if (!maybeShowWelcome()) maybeShowBrief();
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
    window.api.window.setIgnoreMouseEvents(s.clickThroughLocked);
    els.btnLock?.classList.toggle('is-active', !!s.clickThroughLocked);
  }

  // --- 외형 ---
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
 *  마우스를 올리면 CSS 가 즉시 원래 질감으로 복원한다. */
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
  const total = state.tasks.filter((t) => !t.done && t.start === todayKey()).length;
  document.title = total > 0 ? `일정관리 비서 · 오늘 ${total}건` : '일정관리 비서';
  syncBellDot(state);
}

// ---------------------------------------------------------------- 표지 머리

function wireTitlebar() {
  // 시안의 아이콘 — 14px · stroke 1.4, 닫기만 13px
  setIcon(els.btnBrief, 'sunrise', 14, 1.4);
  setIcon(els.btnSearch, 'searchD', 14, 1.4);
  setIcon(els.btnBell, 'bellD', 14, 1.4);
  setIcon(els.btnLock, 'lock', 14, 1.4);
  setIcon(els.btnSettings, 'gear', 14, 1.4);
  setIcon(els.btnClose, 'close', 13, 1.4);
  // 알림 기록 — 아직 안 본 알림이 있으면 점이 찍힌다
  els.btnBell.append(el('span', 'iconbtn__dot'));

  els.btnBell.setAttribute('aria-expanded', 'false');
  els.btnSettings.setAttribute('aria-expanded', 'false');

  els.btnClose.addEventListener('click', () => window.api.window.hide());
  els.btnBrief.addEventListener('click', () => showBrief());
  els.btnSearch.addEventListener('click', () => {
    if (!els.settings.hidden) toggleSettings();
    document.dispatchEvent(new CustomEvent('app:search'));
  });
  els.btnLock.addEventListener('click', () => {
    store.setSetting('clickThroughLocked', true);
    showToast('클릭 통과를 켰습니다 — Alt+Shift+S 로 풉니다');
  });
  els.btnSettings.addEventListener('click', toggleSettings);
  els.btnBell.addEventListener('click', (e) => { e.stopPropagation(); toggleBell(); });

  if (els.year) els.year.textContent = romanYear(new Date().getFullYear());
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
// 안내와 사용법도 같은 틀을 빌린다 — 모양을 새로 만들지 않는다.

let briefSheet = null;   // 브리핑 · 첫 실행 안내가 자리를 나눠 쓴다
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
  ['기본 조작', [
    ['날짜를 클릭', '그날의 시간표가 오른쪽에 펼쳐집니다'],
    ['날짜를 눌러 옆으로 끌기', '그 기간짜리 일정을 바로 만듭니다'],
    ['항목을 달력으로 끌기', '일정 날짜를 옮깁니다'],
    ['항목을 클릭', '항목 상세가 열립니다. 보이는 제목이 그대로 입력칸입니다'],
    ['Esc · ‹ 목록으로', '어느 화면에서든 한 번에 오늘로 돌아갑니다'],
    ['제목을 더블클릭', '상세를 열지 않고 이름만 그 자리에서 고칩니다'],
    ['＋ 일정 추가 (N)', '날짜 머리 오른쪽. 시작 · 종료를 눌러서 지정합니다'],
    ['달력에서 날짜에 커서', '그 칸에 ＋ 가 떠요. 누르면 그 날짜로 만듭니다'],
    ['달력 막대를 잡고 끌기', '일정을 옮깁니다 (기간 길이는 그대로)'],
    ['막대의 양 끝을 끌기', '시작 · 종료를 늘리고 줄입니다'],
    ['일정을 D-Day 칸으로 끌기', 'D-Day 에 고정합니다'],
    ['트랙패드 두 손가락 좌우', '달을 넘깁니다 (주간 보기에서는 주 단위)'],
  ]],
  ['시간표', [
    ['스트립 · 압축', '시간표 머리의 칩이나 설정에서 고릅니다'],
    ['네모를 누르면', '자세한 창이 뜹니다 — 완료 · 내일로 · 고치기'],
    ['종일 띠', '시각 없는 일정 · 루틴 · 진행 중인 장기 계획이 앉는 자리'],
    ['압축의 빈 시간', '누르면 펼쳐지고, 다시 누르면 접힙니다'],
  ]],
  ['날짜와 시각', [
    ['시작 = 종료', '하루짜리 일정입니다'],
    ['종료를 뒤로', '여러 날에 걸친 일정이 됩니다 (+1일 · +1주)'],
    ['시작을 옮기면', '종료도 같은 간격을 유지한 채 따라옵니다'],
    ['시각 칸을 비우면', '종일 일정입니다'],
    ['시각 칸에서 ↑ ↓', '30분씩 옮깁니다'],
  ]],
  ['루틴', [
    ['＋ 루틴 · 루틴 탭', '운동처럼 되풀이하는 일. 달력에 그리지 않습니다'],
    ['평일 · 주말 · 요일', "'월수금 운동' 처럼 요일을 정할 수 있습니다"],
    ['시각을 넣으면', '시간띠에 네모로, 비우면 종일 띠에 놓입니다'],
    ['체크는 그날치만', '오늘 체크해도 내일 것은 그대로 남습니다'],
  ]],
  ['언젠가', [
    ['날짜 없이 적기', "정하기 애매한 일은 '언젠가' 에 일단 적어 둡니다"],
    ['오늘 · 내일 · 주말', '항목 오른쪽 버튼. 한 번 누르면 그날로 잡힙니다'],
    ['3주째 · 2달째', '오래 묵은 항목에 붙습니다. 잡거나 지울 때가 됐다는 뜻'],
  ]],
  ['비서', [
    ['비서의 한 줄', '오늘이 어떤지 한 문장으로. 「지금 할 일」은 하나를 골라 줍니다'],
    ['지난 일', '기한이 지났는데 안 끝난 일이 위에 모입니다'],
    ['오늘로 당기기', '밀린 일을 한 번에 오늘로 (되돌리기 한 번으로 취소)'],
    ['아침 브리핑', '하루에 한 번 · 표지의 해돋이 버튼으로 다시 봅니다'],
    ['트레이 아이콘', '창을 열지 않아도 오늘 일정과 밀린 건수가 보입니다'],
  ]],
  ['목록에서 (키보드)', [
    ['↑ ↓', '항목 사이 이동'],
    ['Space', '완료 / 완료 취소'],
    ['Enter', '항목 상세'],
    ['Delete', '삭제 (반복 일정은 그 회차만)'],
  ]],
  ['단축키', [
    ['N', '새 일정'],
    ['Ctrl + Z', '되돌리기'],
    ['Ctrl + Shift + Z', '다시 실행'],
    ['Ctrl + ,', '설정'],
    ['← →', '하루씩 이동'],
    ['↑ ↓', '일주일씩 이동'],
    ['PageUp / PageDown', '한 달씩 이동'],
    ['T', '오늘로'],
    ['?', '이 사용법'],
    ['Esc', '열린 창 닫기'],
    ['Alt + Shift + S', '위젯 보이기 · 클릭 통과 풀기 (어디서든)'],
  ]],
  ['한 줄로 적기 — 추가 화면의 제목칸', [
    ['! / !!', '중요 / 긴급'],
    ['#태그', '태그 (여러 개 가능)'],
    ['@내일  @금  @8/15', '시작일'],
    ['~3d  ~8/20', '종료일 — 기간 일정이 됩니다'],
    ['15:00  14시  오후3시', '시각'],
    ['15:00~18:00', '시작 · 종료 시각'],
    ['*파랑 *초록 *노랑 *빨강 *보라 *회색', '색'],
    ['띄어쓰기를 치면', '그 토큰이 제목에서 빠지고 아래 칸으로 옮겨 갑니다'],
  ]],
];

function toggleHelp() {
  if (helpSheet) { closeHelp(); return; }

  const { scrim, card } = openModal('help', '사용법', closeHelp);
  const { head } = modalHead('사용법', '조작 · 단축키 · 한 줄 문법', closeHelp);
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

// ---------------------------------------------------------------- 첫 실행 안내
//
// 처음 켜면 빈 면이 한꺼번에 펼쳐진다. 기능이 없어서가 아니라
// '어디부터 손대야 하는지'를 아무도 말해 주지 않아서 막막한 화면이다.
// 한 번만, 세 줄로 알려 주고 바로 첫 일정을 만들 수 있게 한다.

const WELCOME_STEPS = [
  ['왼쪽 달력', '기간 일정이 막대로 그려집니다. 날짜를 눌러 옆으로 끌면 그 기간짜리 일정이 만들어져요.'],
  ['오른쪽 면', '고른 날의 시간표입니다. 시각이 있는 일은 네모로, 없는 일은 종일 띠에 놓입니다.'],
  ['기한이 지나면', "끝내지 못한 일은 '지난 일'로 올라옵니다. 한 번에 오늘로 당길 수 있어요."],
];

function maybeShowWelcome() {
  if (store.getState().settings.seenWelcome) return false;
  store.setSetting('seenWelcome', true);
  showWelcome();
  return true;
}

function showWelcome() {
  if (briefSheet) return;   // 브리핑과 자리를 나눠 쓴다

  const { scrim, card } = openModal('brief', '시작하기', closeBrief);
  const { head } = modalHead('일정관리 비서', '처음 오셨네요', closeBrief);
  card.append(head, el('div', 'modal__lead', '왼쪽에서 흐름을 보고, 오른쪽에서 오늘을 짭니다.'));

  for (const [term, desc] of WELCOME_STEPS) {
    const block = modalBlock(term);
    block.append(el('div', 'modal__desc', desc));
    card.append(block);
  }

  const foot = el('div', 'modal__foot');
  const acts = el('div', 'modal__acts');
  const later = el('button', 'modal__btn', '둘러볼게요');
  later.type = 'button';
  later.addEventListener('click', closeBrief);
  const start = el('button', 'modal__btn modal__btn--gold', '첫 일정 만들기');
  start.type = 'button';
  start.addEventListener('click', () => {
    closeBrief();
    // 투두 패널이 추가 화면을 열도록 오늘 날짜로 요청한다
    const today = todayKey();
    store.requestCompose(today, today);
  });
  acts.append(later, start);
  foot.append(el('span', 'modal__note', '자세한 조작은 설정 › 사용법에 있습니다'), acts);
  card.append(foot);

  briefSheet = scrim;
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

function wireDayWatch() {
  scheduleDayTick();
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
  syncBriefTab();
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
// 오른쪽 면 바깥에 붙어 화면을 갈아 끼운다(시안). 탭은 화면을 새로 만들지 않고
// 이미 있는 입구를 연다. 지금 어느 화면인지는 오른쪽 면이 알려 준다(app:screen).
// 브리핑 탭은 시안대로 **한 번 닫으면 사라진다**. 그 뒤로는 표지의 해돋이 버튼으로만 연다.

let screenNow = 'main';

function paintTabs() {
  const settingsOpen = !els.settings.hidden;
  els.tabMain?.classList.toggle('is-on', !settingsOpen && screenNow === 'main');
  els.tabRoutine?.classList.toggle('is-on', !settingsOpen && screenNow === 'routine');
  els.tabSettings?.classList.toggle('is-on', settingsOpen);
}

function wireTabs() {
  document.addEventListener('app:screen', (e) => {
    screenNow = e.detail;
    paintTabs();
  });

  els.tabMain?.addEventListener('click', () => {
    if (!els.settings.hidden) toggleSettings();
    store.setEditing(null);
    document.dispatchEvent(new CustomEvent('app:close-compose'));
  });
  els.tabRoutine?.addEventListener('click', () => {
    if (!els.settings.hidden) toggleSettings();
    document.dispatchEvent(new CustomEvent('app:new-routine'));
  });
  els.tabBrief?.addEventListener('click', () => showBrief());
  els.tabSettings?.addEventListener('click', () => {
    if (els.settings.hidden) toggleSettings();
  });
  syncBriefTab();
  store.subscribe(syncBriefTab);
  paintTabs();
}

/** 브리핑 탭은 아직 안 본 날에만 보인다 — 한 번 닫으면 표지 아이콘으로만 연다(시안) */
function syncBriefTab() {
  if (!els.tabBrief) return;
  els.tabBrief.hidden = store.getState().settings.lastBriefDate === todayKey();
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
function countKo(n) {
  return n >= 1 && n <= 10 ? `${KO_COUNT[n]} 건` : `${n}건`;
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
  return parts.join(' ');
}

function showBrief() {
  if (briefSheet) return;
  // 한 번 열었으면 오늘 몫은 본 것이다 — 책갈피 탭이 사라진다
  store.setSetting('lastBriefDate', todayKey());

  const data = briefData();
  const { today, todays, overdue, upcoming, weekList } = data;
  const d = fromKey(today);

  const { scrim, card } = openModal('brief', '아침 브리핑', closeBrief);
  const { head } = modalHead('아침 브리핑',
    `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAY_FULL[d.getDay()]} · ${nowHHMM()}`, closeBrief);
  card.append(head, el('div', 'modal__lead', briefLead(data)));

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

  // --- 꼬리
  const foot = el('div', 'modal__foot');
  const acts = el('div', 'modal__acts');
  const done = el('button', 'modal__btn', '닫기');
  done.type = 'button';
  done.addEventListener('click', closeBrief);
  acts.append(done);
  if (overdue.length) {
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
  }
  foot.append(el('span', 'modal__note', '할 말이 없는 날에는 뜨지 않습니다'), acts);
  card.append(foot);

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
    pop.append(el('div', 'bell__empty',
      '아직 받은 알림이 없습니다.\n항목 상세에서 알림 시각을 정해 두면 여기에 쌓입니다.'));
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
  els.btnSettings.classList.toggle('is-active', open);
  els.btnSettings.setAttribute('aria-expanded', String(open));
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

  const screen = el('div', 'scr set-screen');
  const head = el('div', 'scr-head');
  const back = el('button', 'scr-head__back', '‹ 목록으로 · Esc');
  back.type = 'button';
  back.addEventListener('click', toggleSettings);
  head.append(el('span', 'scr-head__title', '설정'), back);

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

  const autoRow = setRow('부팅 시 자동 시작', '로그인할 때 트레이에만 조용히', [
    opt('켬', false, async () => applyAutoLaunch(true)),
    opt('끔', false, async () => applyAutoLaunch(false)),
  ]);
  window.api.app.getAutoLaunch().then((r) => {
    const [onBtn, offBtn] = autoRow.box.children;
    onBtn?.classList.toggle('is-on', !!r?.enabled);
    offBtn?.classList.toggle('is-on', !r?.enabled);
    if (r?.dev) autoRow.row.title = '개발 실행 중에는 적용되지 않습니다 (설치본에서 동작).';
  }).catch(() => {});

  const body = el('div', 'set-body');
  body.append(
    setGroup('보임', [
      setRow('테마', '', [
        opt('밝게', s.theme !== 'dark', set('theme', 'light')),
        opt('어둡게', s.theme === 'dark', set('theme', 'dark')),
      ]),
      // 시간표 머리의 칩과 **같은 값**을 본다. 두 자리에서 고르되 상태는 하나다.
      setRow('오늘 시간표', '스트립은 하루의 모양을, 압축은 순서를 보여줍니다', [
        opt('스트립', s.todayView !== 'compressed', set('todayView', 'strip')),
        opt('압축', s.todayView === 'compressed', set('todayView', 'compressed')),
      ]),
      // 예전 설정(40~100% 슬라이더)은 가장 가까운 칸으로 읽는다
      setRow('배경 투명도', '배경 알파로 조절합니다 — 글자는 또렷하게 남습니다',
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
      onOff('blurEnabled', '끄면 GPU 사용량이 줄어듭니다', '배경 흐림'),
      onOff('dimInactive', '다른 창을 쓰는 동안 한 걸음 물러납니다', '비활성일 때 흐리게'),
      onOff('showHolidays', '대체공휴일까지 달력에 적습니다', '공휴일'),
      onOff('showDashboard', '아래 리본 왼쪽 — 고정한 일정의 남은 날', 'D-Day'),
      onOff('showLauncher', '아래 리본 오른쪽 — 자주 여는 곳', '퀵 런처'),
      setRow('완료 항목', '', [
        opt('보임', s.showCompleted !== false, set('showCompleted', true)),
        opt('숨김', s.showCompleted === false, set('showCompleted', false)),
      ]),
      setRow('정렬', '같은 자리 안에서의 순서', [
        opt('직접', s.sortMode !== 'priority', set('sortMode', 'manual')),
        opt('중요도순', s.sortMode === 'priority', set('sortMode', 'priority')),
      ]),
    ]),
    setGroup('비서 노릇', [
      onOff('showBrief', '하루에 한 번, 앱을 처음 켤 때', '아침 브리핑'),
      onOff('traySummary', '창을 열지 않아도 오늘 몫을 보고합니다', '트레이 요약'),
      autoRow,
      setRow('항상 위에', '다른 창 위에 늘 떠 있습니다', [
        opt('켬', !!s.alwaysOnTop, set('alwaysOnTop', true)),
        opt('끔', !s.alwaysOnTop, set('alwaysOnTop', false)),
      ]),
      setRow('클릭 통과', '위젯이 마우스를 통과시킵니다 — 풀 때는 Alt+Shift+S', [
        opt('켜기', false, () => {
          store.setSetting('clickThroughLocked', true);
          toggleSettings();   // 잠그면 더 이상 클릭이 안 되므로 화면을 닫는다
          showToast('클릭 통과를 켰습니다 — Alt+Shift+S 로 풉니다');
        }),
      ]),
    ]),
    setGroup('보관', [
      setRow('백업 폴더 열기', '최근 14일치를 보관합니다', [
        opt('열기', false, () => window.api.data.openBackups()),
      ]),
      setRow('내보내기', '이 앱으로 되돌릴 수 있는 형식 / 표준 캘린더', [
        opt('.json', false, exportBackup),
        opt('.ics', false, exportICS),
      ]),
      setRow('가져오기', '합치기는 기존 일정을 건드리지 않습니다', [
        opt('합치기', false, () => importBackup('merge')),
        opt('덮어쓰기', false, () => importBackup('replace')),
      ]),
      setRow('새 버전 확인', '릴리스 페이지를 엽니다', [
        opt('확인', false, () => window.api.openExternal(
          'https://github.com/rbth3015-spec/desktop-schedule-widget/releases')),
      ]),
      setRow('의견 보내기', '기본 메일 앱이 열립니다', [
        opt('메일 쓰기', false, sendFeedback),
      ]),
      setRow('사용법', '조작 · 단축키 · 한 줄 문법', [
        opt('보기', false, () => toggleHelp()),
      ]),
    ]),
  );

  // 자동 업데이트는 붙이지 않았다. 배포판에 서명이 없으면 업데이트 과정에서
  // Windows 경고가 반복되고, 릴리스를 실제로 올려야만 동작한다.
  const foot = el('div', 'set-foot', '버전 … · 자동 업데이트는 두지 않습니다. 설정에서 릴리스 페이지를 열어 확인하세요.');
  window.api.app?.getVersion?.().then((info) => {
    const v = info?.version || '';
    foot.textContent = `버전 ${/^\d/.test(v) ? v : (v || '—')} · 자동 업데이트는 두지 않습니다. 설정에서 릴리스 페이지를 열어 확인하세요.`;
  }).catch(() => {});
  body.append(foot);

  screen.append(head, body);
  els.settings.replaceChildren(screen);
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
    // 전역 단축키로 잠금을 풀면 메인 프로세스만 상태가 바뀌므로 설정도 맞춰준다
    if (action === 'unlock') store.setSetting('clickThroughLocked', false);

    if (action === 'brief') showBrief();

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
      // 항목 상세 · 추가 화면에서 빠져나오기 — 오늘 화면으로
      if (store.getState().editingTaskId) { store.setEditing(null); return; }
      if (document.querySelector('.cmp:not([hidden])')) {
        document.dispatchEvent(new CustomEvent('app:close-compose'));
        return;
      }
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
