// 앱 부트스트랩. 셸(타이틀바 · 스플리터 · 설정)을 담당하고
// 캘린더 / 투두 모듈을 각자의 root 에 마운트한다.

import * as store from './store.js';
import { createCalendar } from './calendar/calendar.js';
import { createTodoPanel } from './todo/todo.js';
import { createDashboard } from './dashboard/dashboard.js';
import { createLauncher } from './launcher/launcher.js';
import { todayKey, fromKey, weekGrid, WEEKDAY_LABELS } from './lib/date.js';
import { setIcon, icon } from './lib/icons.js';
import { startReminders, timeAgo } from './reminders.js';
import { toBackupJSON, parseBackup, toICS, fileStamp } from './lib/exchange.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  root: $('#widget'),
  calendar: $('#calendar-root'),
  todo: $('#todo-root'),
  splitter: $('#splitter'),
  dash: $('#dash-root'),
  launcher: $('#launcher-root'),
  settings: $('#settings-root'),
  btnHelp: $('#btn-help'),
  btnBell: $('#btn-bell'),
  btnSettings: $('#btn-settings'),
  btnPin: $('#btn-pin'),
  btnMin: $('#btn-min'),
  btnClose: $('#btn-close'),
  title: document.querySelector('.titlebar__title'),
};

let calendar = null;
let todo = null;
let dashboard = null;
let launcher = null;
let reminders = null;

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
  wireSettings();
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
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    els.root.append(toastEl);
  }
  toastEl.replaceChildren();

  const label = document.createElement('span');
  label.className = 'toast__text';
  label.textContent = text;
  toastEl.append(label);

  if (undo && store.canUndo()) {
    // 글자보다 화살표 하나가 짧고 알아보기 쉽다. 이름은 접근성 라벨로 남긴다.
    const btn = document.createElement('button');
    btn.className = 'toast__undo';
    btn.type = 'button';
    btn.append(icon('undo'));
    btn.setAttribute('aria-label', '되돌리기');
    btn.title = '되돌리기';
    btn.addEventListener('click', () => {
      const undone = store.undo();
      hideToast();
      if (undone) showToast(`되돌렸습니다 — ${undone}`);
    });
    toastEl.append(btn);
  }

  toastEl.classList.add('is-on');
  // 누를 것이 있으면 읽고 누를 시간을 준다
  toastTimer = setTimeout(hideToast, undo ? 5000 : 1600);
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

  const bar = document.createElement('div');
  bar.className = 'savebar';
  bar.setAttribute('role', 'alert');

  const text = document.createElement('span');
  text.className = 'savebar__text';
  text.textContent = `저장하지 못했습니다 — ${message}`;

  const retry = document.createElement('button');
  retry.className = 'savebar__btn';
  retry.type = 'button';
  retry.textContent = '다시 시도';
  retry.addEventListener('click', () => store.flushSave());

  const backup = document.createElement('button');
  backup.className = 'savebar__btn';
  backup.type = 'button';
  backup.textContent = '백업으로 내보내기';
  backup.addEventListener('click', exportBackup);

  bar.append(text, retry, backup);
  els.root.append(bar);
  saveErrorEl = bar;
}

/** 데이터 손상 백업 등, 사용자가 알아야 할 일회성 안내 */
function showNotice(text, { sticky = false } = {}) {
  const el = document.createElement('div');
  el.className = 'notice';
  el.setAttribute('role', 'alert');
  el.textContent = text;

  const close = document.createElement('button');
  close.className = 'notice__close';
  close.type = 'button';
  close.textContent = '확인';
  close.addEventListener('click', () => el.remove());
  el.append(close);

  els.root.append(el);
  // 데이터를 못 읽었다는 안내는 스스로 사라지면 안 된다.
  // 못 보고 지나친 채로 새 일정을 적으면 기존 파일을 덮어쓰게 된다.
  if (!sticky) setTimeout(() => el.remove(), 12000);
}

// 셸에 마지막으로 반영한 설정. store 는 모든 변경마다 emit 하므로
// 실제로 바뀐 항목만 골라 적용한다 (특히 IPC 는 매번 쏘면 안 된다).
let appliedChrome = {};

/** settings 를 실제 창/문서에 반영 */
function applyChrome(s) {
  const prev = appliedChrome;

  if (s.theme !== prev.theme) {
    document.documentElement.dataset.theme = s.theme;
  }
  if (s.fontScale !== prev.fontScale) {
    document.documentElement.style.setProperty('--fs', `${(13 * s.fontScale).toFixed(1)}px`);
  }
  // 'default' 면 속성을 아예 지운다 — base.css 의 기본 토큰이 그대로 살아 있게.
  if (s.font !== prev.font) setPick('font', s.font);
  if (s.fontSerif !== prev.fontSerif) setPick('fontSerif', s.fontSerif);
  if (s.splitRatio !== prev.splitRatio) {
    els.calendar.style.flex = `0 0 ${(s.splitRatio * 100).toFixed(2)}%`;
  }
  if (s.alwaysOnTop !== prev.alwaysOnTop) {
    els.btnPin.classList.toggle('is-active', s.alwaysOnTop);
    els.btnPin.setAttribute('aria-pressed', String(!!s.alwaysOnTop));
    window.api.window.setAlwaysOnTop(s.alwaysOnTop);
  }
  if (s.opacity !== prev.opacity) {
    // 배경 알파만 조절한다. BrowserWindow.setOpacity 는 Windows 의 transparent 창에서
    // 합성이 불안정해(영역별로 반영이 들쭉날쭉) 쓰지 않는다.
    document.documentElement.style.setProperty('--glass-a', String(s.opacity));
  }
  if (s.clickThroughLocked !== prev.clickThroughLocked) {
    window.api.window.setIgnoreMouseEvents(s.clickThroughLocked);
  }

  // --- 외형 ---
  if (s.blurEnabled !== prev.blurEnabled) {
    // 블러는 dwm.exe GPU 부하가 큰 연산이라 끌 수 있어야 한다
    document.documentElement.dataset.blur = s.blurEnabled ? 'on' : 'off';
  }
  if (s.dimInactive !== prev.dimInactive) {
    document.documentElement.dataset.dim = s.dimInactive ? 'on' : 'off';
  }

  // --- 패널 표시 ---
  if (s.showDashboard !== prev.showDashboard) els.dash.hidden = !s.showDashboard;
  if (s.showLauncher !== prev.showLauncher) els.launcher.hidden = !s.showLauncher;

  appliedChrome = { ...s };
}

/** data-font / data-font-serif 심기. 'default' 면 속성을 지운다. */
function setPick(key, value) {
  const attr = key === 'fontSerif' ? 'fontSerif' : 'font';
  if (!value || value === 'default') delete document.documentElement.dataset[attr];
  else document.documentElement.dataset[attr] = value;
}

/** 창이 비활성이면 위젯을 배경으로 물린다 (macOS 데스크톱 위젯의 틴팅/디밍 방식).
 *  마우스를 올리면 CSS 가 즉시 원래 질감으로 복원한다. */
function wireDimming() {
  const setInactive = (v) => document.documentElement.classList.toggle('is-inactive', v);
  window.addEventListener('blur', () => setInactive(true));
  window.addEventListener('focus', () => setInactive(false));
  setInactive(!document.hasFocus());

  // 트레이로 내려가 화면에 없을 때는 애니메이션을 멈춘다(CSS 가 이 값을 본다).
  // 아무도 안 보는 화면을 계속 다시 그리는 것은 배터리만 쓰는 일이다.
  const setHidden = () => {
    document.documentElement.dataset.hidden = document.hidden ? '1' : '0';
  };
  document.addEventListener('visibilitychange', setHidden);
  setHidden();
}

function updateTitle(state) {
  const total = state.tasks.filter((t) => !t.done && t.start === todayKey()).length;
  els.title.textContent = total > 0 ? `일정관리 비서 · 오늘 ${total}건` : '일정관리 비서';
}

// ---------------------------------------------------------------- 타이틀바

function wireTitlebar() {
  // 이모지는 OS/폰트마다 모양과 색이 달라 톤이 깨진다 — 선 아이콘으로 교체
  setIcon(els.btnHelp, 'help');
  setIcon(els.btnBell, 'bell');
  setIcon(els.btnSettings, 'settings');
  setIcon(els.btnPin, 'pin');
  setIcon(els.btnMin, 'minimize');
  setIcon(els.btnClose, 'close');

  // 토글로 동작하는 버튼은 눌림 상태를 이름 밖에 따로 실어야 한다
  els.btnPin.setAttribute('aria-pressed', String(!!store.getState().settings.alwaysOnTop));
  els.btnHelp.setAttribute('aria-expanded', 'false');
  els.btnBell.setAttribute('aria-expanded', 'false');
  els.btnSettings.setAttribute('aria-expanded', 'false');

  els.btnMin.addEventListener('click', () => window.api.window.minimize());
  els.btnClose.addEventListener('click', () => window.api.window.hide());
  els.btnPin.addEventListener('click', () => {
    store.setSetting('alwaysOnTop', !store.getState().settings.alwaysOnTop);
  });
  els.btnSettings.addEventListener('click', toggleSettings);
  els.btnBell.addEventListener('click', (e) => { e.stopPropagation(); toggleBell(); });
  els.btnHelp.addEventListener('click', toggleHelp);
}

// ---------------------------------------------------------------- 도움말
//
// 기능이 늘어날수록 '있는 줄 몰라서 못 쓰는' 기능이 생긴다.
// 조작법과 문법을 한 장에 모아 언제든 열어 볼 수 있게 한다.

const HELP = [
  ['기본 조작', [
    ['날짜를 클릭', '그날의 일정을 오른쪽에 펼칩니다'],
    ['날짜를 눌러 옆으로 끌기', '그 기간짜리 일정을 바로 만듭니다'],
    ['목록 항목을 달력으로 끌기', '일정 날짜를 옮깁니다'],
    ['항목을 클릭', '펼쳐서 고칩니다. 제목이 그대로 입력칸이 되고, 나머지 목록은 접힙니다'],
    ['Esc 또는 목록으로', '고치던 칸에 있어도 한 번에 목록으로 돌아갑니다'],
    ['제목을 더블클릭', '펼치지 않고 이름만 그 자리에서 고칩니다'],
    ['오른쪽 + 버튼', '일정을 만드는 유일한 입구입니다 (시작·종료를 눌러서 지정)'],
    ['달력에서 날짜에 커서', '그 칸에 + 가 떠요. 누르면 그 날짜로 만듭니다'],
    ['달력 막대를 잡고 끌기', '일정을 옮깁니다 (기간 길이는 그대로)'],
    ['막대의 양 끝을 끌기', '시작·종료를 늘리고 줄입니다'],
    ['일정을 D-Day 칸으로 끌기', 'D-Day 에 고정합니다'],
    ['트랙패드 두 손가락 좌우', '달을 넘깁니다 (주간 보기에서는 주 단위)'],
    ['반복 일정의 체크', '그 회차만 완료됩니다 (다음 회차는 그대로)'],
    ['반복 일정의 ✕', '그 회차만 건너뜁니다. 규칙째 지우려면 상세의 “반복 전체 삭제”'],
  ]],
  ['날짜와 시각', [
    ['시작 = 종료', '하루짜리 일정입니다'],
    ['종료를 뒤로', '여러 날에 걸친 일정이 됩니다 (+1일 · +1주 버튼)'],
    ['시작을 옮기면', '종료도 같은 간격을 유지한 채 따라옵니다'],
    ['시각 칸을 비우면', '종일 일정입니다'],
    ['시각을 넣으면', '목록에서 시간순으로 서고, “30분 전” 알림을 쓸 수 있습니다'],
  ]],
  ['루틴', [
    ['목록 위 루틴 버튼', '운동처럼 되풀이하는 일. 달력에 그리지 않고 여기서만 체크합니다'],
    ['매주 + 요일 고르기', "'월수금 운동' 처럼 요일을 정할 수 있습니다"],
    ['체크는 그날치만', '오늘 체크해도 내일 것은 그대로 남습니다'],
  ]],
  ['언젠가', [
    ['날짜 없이 적기', "정하기 애매한 일은 '언젠가' 에 일단 적어 둡니다"],
    ['오늘 · 내일 · 주말', '항목에 커서를 올리면 뜹니다. 한 번 누르면 그날로 잡힙니다'],
    ['2주째 · 3달째', '오래 묵은 항목에 붙습니다. 잡거나 지울 때가 됐다는 뜻'],
  ]],
  ['비서', [
    ['지난 일', '기한이 지났는데 안 끝난 일이 목록 맨 위에 모입니다'],
    ['오늘로 당기기', '밀린 일을 한 번에 오늘로 (되돌리기 한 번으로 취소)'],
    ['아침 브리핑', '하루에 한 번, 앱을 처음 켤 때 오늘 몫을 한 장으로'],
    ['트레이 아이콘', '창을 열지 않아도 오늘 일정과 밀린 건수가 보입니다'],
  ]],
  ['목록에서 (키보드)', [
    ['Tab', '할 일 목록으로 들어갑니다'],
    ['↑ ↓', '항목 사이 이동'],
    ['Space', '완료 / 완료 취소'],
    ['Enter', '자세히 열기 · 닫기'],
    ['Delete', '삭제 (반복 일정은 그 회차만)'],
  ]],
  ['단축키', [
    ['Ctrl + Z', '되돌리기'],
    ['Ctrl + Shift + Z', '다시 실행'],
    ['Ctrl + ,', '설정 열기'],
    ['← →', '하루씩 이동'],
    ['↑ ↓', '일주일씩 이동'],
    ['PageUp / PageDown', '한 달씩 이동'],
    ['T', '오늘로'],
    ['Esc', '열린 창 닫기'],
    ['Alt + Shift + S', '위젯 보이기 · 잠금 해제 (어디서든)'],
  ]],
  ['한 줄로 적기 — 추가 폼의 제목칸', [
    ['! / !!', '중요 / 긴급'],
    ['#태그', '태그 (여러 개 가능)'],
    ['@내일  @금  @8/15', '시작일'],
    ['~3d  ~8/20', '종료일 — 기간 일정이 됩니다'],
    ['15:00  14시  오후3시', '시각'],
    ['15:00~18:00', '시작·종료 시각'],
    ['*파랑 *초록 *노랑 *빨강 *보라 *회색', '색'],
    ['띄어쓰기를 치면', '그 토큰이 제목에서 빠지고 아래 칸으로 옮겨 갑니다'],
  ]],
];

let helpSheet = null;

function toggleHelp() {
  if (helpSheet) { closeHelp(); return; }

  const sheet = document.createElement('div');
  sheet.className = 'help';

  const head = document.createElement('div');
  head.className = 'help__head';
  const title = document.createElement('span');
  title.className = 'help__title';
  title.textContent = '사용법';
  const close = document.createElement('button');
  close.className = 'help__close';
  close.append(icon('close'));
  close.addEventListener('click', closeHelp);
  head.append(title, close);
  sheet.append(head);

  const body = document.createElement('div');
  body.className = 'help__body';
  for (const [section, rows] of HELP) {
    const h = document.createElement('div');
    h.className = 'help__section';
    h.textContent = section;
    body.append(h);

    const dl = document.createElement('div');
    dl.className = 'help__list';
    for (const [key, desc] of rows) {
      const k = document.createElement('span');
      k.className = 'help__key';
      k.textContent = key;
      const d = document.createElement('span');
      d.className = 'help__desc';
      d.textContent = desc;
      dl.append(k, d);
    }
    body.append(dl);
  }
  sheet.append(body);

  els.root.append(sheet);
  helpSheet = sheet;
  els.btnHelp.classList.add('is-active');
  els.btnHelp.setAttribute('aria-expanded', 'true');
}

function closeHelp() {
  helpSheet?.remove();
  helpSheet = null;
  els.btnHelp.classList.remove('is-active');
  els.btnHelp.setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------- 첫 실행 안내
//
// 처음 켜면 빈 패널 네 개가 한꺼번에 펼쳐진다. 기능이 없어서가 아니라
// '어디부터 손대야 하는지'를 아무도 말해 주지 않아서 막막한 화면이다.
// 한 번만, 세 줄로 알려 주고 바로 첫 일정을 만들 수 있게 한다.

const WELCOME_STEPS = [
  ['왼쪽 달력', '기간 일정이 막대로 그려집니다. 날짜를 눌러 옆으로 끌면 그 기간짜리 일정이 만들어져요.'],
  ['오른쪽 목록', '고른 날짜의 할 일입니다. 시각을 넣으면 시간순으로 정렬돼 하루의 타임라인이 됩니다.'],
  ['기한이 지나면', "끝내지 못한 일은 '지난 일'로 올라옵니다. 한 번에 오늘로 당길 수 있어요."],
];

function maybeShowWelcome() {
  if (store.getState().settings.seenWelcome) return false;
  store.setSetting('seenWelcome', true);
  showWelcome();
  return true;
}

function showWelcome() {
  if (briefSheet) return;   // 브리핑과 자리를 공유한다

  const sheet = document.createElement('div');
  sheet.className = 'brief brief--welcome';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', '시작하기');

  const head = document.createElement('div');
  head.className = 'brief__head';
  const title = document.createElement('div');
  title.className = 'brief__date';
  title.textContent = '일정관리 비서';
  head.append(title);
  sheet.append(head);

  const lead = document.createElement('div');
  lead.className = 'brief__lead';
  lead.textContent = '왼쪽에서 흐름을 보고, 오른쪽에서 오늘을 짭니다.';
  sheet.append(lead);

  const body = document.createElement('div');
  body.className = 'brief__body';
  for (const [term, desc] of WELCOME_STEPS) {
    const block = document.createElement('div');
    block.className = 'brief__block';

    const h = document.createElement('div');
    h.className = 'brief__blockhead';
    const t = document.createElement('span');
    t.className = 'brief__blocktitle';
    t.textContent = term;
    h.append(t);

    const p = document.createElement('div');
    p.className = 'welcome__desc';
    p.textContent = desc;

    block.append(h, p);
    body.append(block);
  }
  sheet.append(body);

  const foot = document.createElement('div');
  foot.className = 'brief__foot welcome__foot';

  const start = document.createElement('button');
  start.className = 'brief__action';
  start.type = 'button';
  start.textContent = '첫 일정 만들기';
  start.addEventListener('click', () => {
    closeBrief();
    // 투두 패널이 추가 폼을 열도록 오늘 날짜로 요청한다
    const today = todayKey();
    store.requestCompose(today, today);
  });

  const later = document.createElement('button');
  later.className = 'welcome__later';
  later.type = 'button';
  later.textContent = '둘러볼게요';
  later.addEventListener('click', closeBrief);

  const hint = document.createElement('span');
  hint.className = 'welcome__hint';
  hint.textContent = '자세한 조작은 위쪽 ? 버튼에 있습니다';

  foot.append(start, later, hint);
  sheet.append(foot);

  els.root.append(sheet);
  briefSheet = sheet;
  start.focus();
}

// ---------------------------------------------------------------- 날짜 감시
//
// 바탕화면에 며칠씩 떠 있는 위젯이다. 자정이 지나도 아무도 다시 그리지 않으면
// '오늘 할 일'이 어제 목록을 계속 보여 주고, 어제 못 끝낸 일은 '지난 일'로도
// 넘어가지 않는다. 상시 구동 앱에서 가장 티 나는 고장이라 한 곳에서 지킨다.
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

  // 자정에 모달을 띄우면 방해다. 다음에 창을 볼 때 보여 준다.
  briefArmed = true;
  if (document.hasFocus()) {
    briefArmed = false;
    maybeShowBrief();
  }
}

// ---------------------------------------------------------------- 아침 브리핑
//
// 이 앱은 그동안 '물어봐야 답하는 장부'였다. 창을 열고, 날짜를 고르고, 목록을 봐야
// 비로소 뭐가 있는지 알 수 있었다. 비서라면 켜자마자 먼저 말해야 한다.
//
// 하루에 한 번만 뜬다. 매번 뜨면 그냥 닫아 버리는 관문이 되고, 그러면 아무 말도
// 안 하는 것과 같아진다.

/** 브리핑에 담을 것들을 모은다 */
function briefData() {
  const today = todayKey();
  const st = store.getState();

  // 필터를 무시한다 — 브리핑은 화면에 걸린 태그와 무관하게 하루 전체를 보고한다
  const todays = store.tasksOnDate(today, { filtered: false }).filter((t) => !t.done);
  const overdue = store.overdueTasks(today, { filtered: false });

  // 임박한 D-Day — 지난 것은 '지난 일'이 이미 말해 주므로 뺀다
  const upcoming = store.pinnedTasks().filter((p) => !p.overdue).slice(0, 3);

  // 이번 주에 남은 몫 (오늘 포함, 이번 주 남은 날)
  const week = weekGrid(today).filter((k) => k >= today);
  const weekAhead = st.tasks.filter((t) => {
    if (t.done || !t.start) return false;
    if (t.repeat) return false;
    const end = t.end || t.start;
    return week.some((k) => k >= t.start && k <= end);
  }).length;

  return { today, todays, overdue, upcoming, weekAhead };
}

let briefSheet = null;

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
  store.setSetting('lastBriefDate', todayKey());
  showBrief();
}

function showBrief() {
  if (briefSheet) return;
  const { today, todays, overdue, upcoming, weekAhead } = briefData();
  const d = fromKey(today);

  const sheet = document.createElement('div');
  sheet.className = 'brief';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', '오늘의 브리핑');

  // --- 머리글
  const head = document.createElement('div');
  head.className = 'brief__head';

  const date = document.createElement('div');
  date.className = 'brief__date';
  date.textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY_LABELS[d.getDay()]})`;

  const close = document.createElement('button');
  close.className = 'brief__close';
  close.type = 'button';
  close.setAttribute('aria-label', '브리핑 닫기');
  close.append(icon('close'));
  close.addEventListener('click', closeBrief);

  head.append(date, close);
  sheet.append(head);

  // --- 한 줄 요약
  const lead = document.createElement('div');
  lead.className = 'brief__lead';
  lead.textContent = todays.length
    ? `오늘 ${todays.length}건이 남아 있습니다.`
    : '오늘 잡힌 일정은 없습니다.';
  sheet.append(lead);

  const body = document.createElement('div');
  body.className = 'brief__body';

  // --- 밀린 일 (가장 먼저)
  if (overdue.length) {
    const block = briefBlock('지난 일', `${overdue.length}건`);
    block.classList.add('brief__block--overdue');

    for (const t of overdue.slice(0, 3)) {
      block.append(briefRow(t, `${daysAgoLabel(t.end || t.start, today)} 지남`));
    }
    if (overdue.length > 3) block.append(briefMore(overdue.length - 3));

    const roll = document.createElement('button');
    roll.className = 'brief__action';
    roll.type = 'button';
    roll.textContent = `${overdue.length}건 오늘로 당기기`;
    roll.addEventListener('click', () => {
      const ids = overdue.map((t) => t.id);
      const n = store.moveTasksTo(ids, today, `밀린 일 ${ids.length}건 오늘로`);
      store.selectDate(today);
      closeBrief();
      if (n) showToast(`${n}건을 오늘로 옮겼습니다`, { undo: true });
    });
    block.append(roll);
    body.append(block);
  }

  // --- 오늘 할 일
  if (todays.length) {
    const block = briefBlock('오늘', `${todays.length}건`);
    // tasksOnDate 가 이미 시각순으로 정렬해 준다
    for (const t of todays.slice(0, 4)) {
      block.append(briefRow(t, t.startTime || ''));
    }
    if (todays.length > 4) block.append(briefMore(todays.length - 4));
    body.append(block);
  }

  // --- 다가오는 목표
  if (upcoming.length) {
    const block = briefBlock('다가오는 목표', '');
    for (const t of upcoming) {
      block.append(briefRow(t, t.remaining === 0 ? 'D-day' : `D-${t.remaining}`));
    }
    body.append(block);
  }

  sheet.append(body);

  // --- 꼬리말
  const foot = document.createElement('div');
  foot.className = 'brief__foot';
  foot.textContent = weekAhead
    ? `이번 주 남은 일 ${weekAhead}건`
    : '이번 주는 여유롭습니다';
  sheet.append(foot);

  els.root.append(sheet);
  briefSheet = sheet;
  close.focus();
}

function briefBlock(title, badge) {
  const block = document.createElement('div');
  block.className = 'brief__block';

  const h = document.createElement('div');
  h.className = 'brief__blockhead';
  const t = document.createElement('span');
  t.className = 'brief__blocktitle';
  t.textContent = title;
  h.append(t);
  if (badge) {
    const b = document.createElement('span');
    b.className = 'brief__badge';
    b.textContent = badge;
    h.append(b);
  }
  block.append(h);
  return block;
}

/** 브리핑의 일정 한 줄 — 누르면 그 일정으로 간다 */
function briefRow(task, tail) {
  const row = document.createElement('button');
  row.className = 'brief__row';
  row.type = 'button';

  const dot = document.createElement('span');
  dot.className = 'brief__dot';
  dot.style.background = store.COLORS[task.color] || store.COLORS.blue;

  const title = document.createElement('span');
  title.className = 'brief__title';
  title.textContent = task.title || '(제목 없음)';

  const meta = document.createElement('span');
  meta.className = 'brief__tail';
  meta.textContent = tail || '';

  row.append(dot, title, meta);
  row.addEventListener('click', () => {
    if (task.start) store.selectDate(task.start);
    store.setEditing(task.id);
    closeBrief();
  });
  return row;
}

function briefMore(n) {
  const el = document.createElement('div');
  el.className = 'brief__more';
  el.textContent = `외 ${n}건`;
  return el;
}

/** '3일' / '2주' — 며칠이나 지났는지 */
function daysAgoLabel(key, today) {
  const days = Math.max(1, Math.round((fromKey(today) - fromKey(key)) / 86400000));
  if (days < 7) return `${days}일`;
  if (days < 30) return `${Math.floor(days / 7)}주`;
  return `${Math.floor(days / 30)}달`;
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

function toggleBell() {
  if (bellPopover) { closeBell(); return; }

  const log = store.getState().reminderLog;

  const pop = document.createElement('div');
  pop.className = 'bell';

  const head = document.createElement('div');
  head.className = 'bell__head';
  head.append(labelEl('알림 기록'));

  if (log.length) {
    const clear = document.createElement('button');
    clear.className = 'bell__clear';
    clear.textContent = '지우기';
    clear.addEventListener('click', () => { store.clearReminderLog(); closeBell(); });
    head.append(clear);
  }
  pop.append(head);

  if (!log.length) {
    const empty = document.createElement('div');
    empty.className = 'bell__empty';
    empty.textContent =
      '아직 받은 알림이 없습니다.\n일정 상세에서 알림 시각을 정해 두면 여기에 쌓입니다.';
    pop.append(empty);
  } else {
    const list = document.createElement('div');
    list.className = 'bell__list';
    for (const entry of log) {
      const row = document.createElement('button');
      row.className = 'bell__row';
      row.append(icon('bell'));

      const t = document.createElement('span');
      t.className = 'bell__title';
      t.textContent = entry.title || '(제목 없음)';

      const when = document.createElement('span');
      when.className = 'bell__when';
      when.textContent = timeAgo(entry.at);

      row.append(t, when);
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

  els.root.append(pop);
  bellPopover = pop;
  els.btnBell.classList.add('is-active');
  els.btnBell.setAttribute('aria-expanded', 'true');

  // 바깥을 클릭하면 닫힌다
  setTimeout(() => document.addEventListener('click', onDocClickForBell), 0);
}

function labelEl(text) {
  const el = document.createElement('span');
  el.className = 'bell__label';
  el.textContent = text;
  return el;
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

// ---------------------------------------------------------------- 스플리터

function wireSplitter() {
  let dragging = false;

  els.splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    els.splitter.classList.add('is-dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = els.root.getBoundingClientRect();
    // 양쪽 패널이 최소 폭(캘린더 260 / 투두 240)을 유지하도록 클램프
    const min = 260 / rect.width;
    const max = 1 - 240 / rect.width;
    const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, min), max);
    els.calendar.style.flex = `0 0 ${(ratio * 100).toFixed(2)}%`;
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    els.splitter.classList.remove('is-dragging');
    document.body.style.cursor = '';
    // 드래그가 끝날 때만 저장 (매 프레임 저장하면 디스크가 갈린다)
    const ratio = parseFloat(els.calendar.style.flex.match(/([\d.]+)%/)[1]) / 100;
    store.setSetting('splitRatio', ratio);
  });
}

// ---------------------------------------------------------------- 설정 패널

function toggleSettings() {
  const open = els.settings.hidden;
  els.settings.hidden = !open;
  els.btnSettings.classList.toggle('is-active', open);
  els.btnSettings.setAttribute('aria-expanded', String(open));
  if (open) renderSettings();
}

function wireSettings() {
  els.settings.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') toggleSettings();
    if (act === 'preset') {
      window.api.window.snapPreset(e.target.dataset.preset);
    }
  });
}

function renderSettings() {
  const s = store.getState().settings;
  els.settings.replaceChildren();

  const frag = document.createDocumentFragment();
  frag.append(
    group('모양'),

    row('테마', segmented([['light', '라이트'], ['dark', '다크']], s.theme, (v) =>
      store.setSetting('theme', v))),

    row('배경 투명도', slider(0.4, 1, 0.02, s.opacity, (v) =>
      store.setSetting('opacity', v), (v) => `${Math.round(v * 100)}%`),
      '배경만 투명해지고 글자는 또렷하게 남습니다. 월페이퍼가 복잡하면 100%에 가깝게 두세요.'),

    row('글자 크기', slider(0.8, 1.4, 0.05, s.fontScale, (v) =>
      store.setSetting('fontScale', v), (v) => `${Math.round(v * 100)}%`)),

    row('본문 글꼴', fontPicker('font', s.font, [
      ['default',     'Pretendard'],
      ['gowun-dodum', '고운돋움'],
      ['malgun',      '맑은 고딕'],
      ['system',      '시스템'],
    ]), '목록·버튼처럼 작은 글씨에 쓰입니다.'),

    row('표제 글꼴', fontPicker('fontSerif', s.fontSerif, [
      ['default',      '나눔명조'],
      ['gowun-batang', '고운바탕'],
      ['batang',       '바탕'],
      ['gungsuh',      '궁서'],
    ]), '날짜·D-Day 처럼 큰 글씨에 쓰입니다. 고른 글꼴로 바로 미리 보여 줍니다.'),

    row('배경 흐림 효과', toggle(s.blurEnabled, (v) => store.setSetting('blurEnabled', v)),
      '끄면 GPU 사용량이 줄어듭니다. 저사양·배터리 모드에서 권장.'),

    row('비활성일 때 흐리게', toggle(s.dimInactive, (v) => store.setSetting('dimInactive', v)),
      '다른 창을 쓰는 동안 위젯이 배경으로 물러납니다. 마우스를 올리면 복원됩니다.'),

    row('창 크기', presetButtons()),

    group('비서'),

    row('아침 브리핑', toggle(s.showBrief, (v) => store.setSetting('showBrief', v)),
      '하루에 한 번, 앱을 처음 켤 때 오늘 몫과 밀린 일을 한 장으로 알려 줍니다.'),

    row('브리핑 지금 보기', actions([['오늘 브리핑 열기', () => {
      toggleSettings();
      showBrief();
    }]])),

    group('패널'),

    row('공휴일 표시', toggle(s.showHolidays !== false, (v) => store.setSetting('showHolidays', v)),
      '우주항공청 월력요항 자료를 받아 대체공휴일까지 표시합니다. 한 번 받으면 오프라인에서도 보입니다.'),

    row('D-Day 대시보드', toggle(s.showDashboard, (v) => store.setSetting('showDashboard', v))),

    row('퀵 런처', toggle(s.showLauncher, (v) => store.setSetting('showLauncher', v))),

    row('정렬 기준', segmented([['manual', '직접 정렬'], ['priority', '우선순위']],
      s.sortMode, (v) => store.setSetting('sortMode', v))),

    group('데이터'),

    row('내보내기', actions([
      ['백업 (.json)', exportBackup],
      ['캘린더 (.ics)', exportICS],
    ]), '백업은 이 앱으로 되돌릴 수 있고, .ics 는 구글·아웃룩 캘린더로 가져갈 수 있습니다.'),

    row('가져오기', actions([
      ['백업에서 합치기', () => importBackup('merge')],
      ['덮어쓰기', () => importBackup('replace')],
    ]), '합치기는 기존 일정을 건드리지 않고 없는 것만 더합니다. 가져온 뒤 뜨는 되돌리기 버튼으로 취소할 수 있습니다.'),

    row('자동 백업', actions([['백업 폴더 열기', () => window.api.data.openBackups()]]),
      '저장할 때 하루 한 번 백업을 떠 두고 최근 14일치를 보관합니다.'),

    group('동작'),

    row('캘린더 보기', segmented([['month', '월간'], ['week', '주간']],
      s.calendarView, (v) => store.setSetting('calendarView', v))),

    row('부팅 시 자동 시작', autoLaunchToggle(),
      '컴퓨터를 켜면 트레이에 조용히 올라옵니다. 창은 뜨지 않습니다.'),

    row('항상 위에 표시', toggle(s.alwaysOnTop, (v) => store.setSetting('alwaysOnTop', v))),

    row('완료 항목 표시', toggle(s.showCompleted, (v) => store.setSetting('showCompleted', v))),

    row('클릭 통과(잠금)', toggle(s.clickThroughLocked, (v) => {
      store.setSetting('clickThroughLocked', v);
      if (v) toggleSettings();   // 잠그면 더 이상 클릭이 안 되므로 패널을 닫는다
    }), '켜면 위젯이 마우스를 통과시켜 배경처럼 됩니다. Alt+Shift+S 로 해제하세요.'),
  );

  // 자동 업데이트는 붙이지 않았다. 배포판에 서명이 없으면 업데이트 과정에서
  // Windows 경고가 반복되고, 릴리스를 실제로 올려야만 동작한다.
  // 대신 새 버전이 있는지 직접 확인할 수 있는 통로만 둔다.
  frag.append(group('앱 정보'));

  const versionRow = row('버전',
    actions([['릴리스 페이지 열기', () => {
      window.api.openExternal('https://github.com/rbth3015-spec/desktop-schedule-widget/releases');
    }]]),
    '자동 업데이트는 아직 없습니다. 새 버전은 위 페이지에서 받아 설치하세요.');

  // 지금 쓰는 버전을 함께 보여 준다 — 릴리스 페이지와 비교할 기준이 없으면
  // '새 버전 확인'은 눌러 봤자 알 수 없는 버튼이 된다.
  const versionTag = document.createElement('span');
  versionTag.className = 'settings__version';
  versionTag.textContent = '…';
  versionRow.querySelector('.settings__label')?.append(versionTag);
  window.api.app?.getVersion?.().then((info) => {
    const v = info?.version || '';
    // 개발 실행에서는 '개발 실행' 같은 문구가 오므로 숫자일 때만 v 를 붙인다
    versionTag.textContent = /^\d/.test(v) ? `v${v}` : v;
  }).catch(() => { versionTag.textContent = ''; });

  frag.append(versionRow);

  const close = document.createElement('button');
  close.className = 'settings__close';
  close.dataset.act = 'close';
  close.textContent = '닫기';
  frag.append(close);

  els.settings.append(frag);
}

// --- 설정 위젯 빌더들 ---

/** 설정 묶음 제목. 스무 줄이 평평하게 이어지면 찾고 싶은 것을 눈으로 못 짚는다. */
function group(title) {
  const el = document.createElement('div');
  el.className = 'settings__group';
  el.textContent = title;
  return el;
}

function row(label, control, hint) {
  const el = document.createElement('div');
  el.className = 'settings__row';

  const l = document.createElement('div');
  l.className = 'settings__label';
  l.textContent = label;

  el.append(l, control);

  if (hint) {
    const h = document.createElement('div');
    h.className = 'settings__hint';
    h.textContent = hint;
    el.append(h);
  }
  return el;
}

/**
 * 글꼴 고르기. 각 버튼을 그 글꼴로 그려서 고르기 전에 생김새를 보여 준다 —
 * 이름만 늘어놓으면 '고운바탕'이 어떻게 생겼는지 눌러 봐야만 알 수 있다.
 */
function fontPicker(key, value, options) {
  const wrap = document.createElement('div');
  wrap.className = 'settings__fonts';

  // base.css 의 선택자 키 → 실제 font-family. 미리보기에만 쓴다.
  const FAMILY = {
    'default':      key === 'fontSerif' ? '"Nanum Myeongjo", Georgia, serif' : '"Pretendard", sans-serif',
    'gowun-dodum':  '"Gowun Dodum", sans-serif',
    'gowun-batang': '"Gowun Batang", serif',
    'malgun':       '"Malgun Gothic", sans-serif',
    'system':       'system-ui, sans-serif',
    'batang':       '"Batang", serif',
    'gungsuh':      '"Gungsuh", serif',
  };

  for (const [val, label] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'settings__font';
    b.style.fontFamily = FAMILY[val] || 'inherit';
    b.textContent = label;
    b.classList.toggle('is-active', val === value);
    b.setAttribute('aria-pressed', String(val === value));
    b.addEventListener('click', () => { store.setSetting(key, val); renderSettings(); });
    wrap.append(b);
  }
  return wrap;
}

function segmented(options, value, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'settings__seg';
  for (const [val, label] of options) {
    const b = document.createElement('button');
    b.textContent = label;
    b.classList.toggle('is-active', val === value);
    b.addEventListener('click', () => { onChange(val); renderSettings(); });
    wrap.append(b);
  }
  return wrap;
}

function slider(min, max, step, value, onChange, format) {
  const wrap = document.createElement('div');
  wrap.className = 'settings__slider';

  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min, max, step, value });

  const out = document.createElement('span');
  out.className = 'settings__value';
  out.textContent = format(value);

  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = format(v);
    onChange(v);
  });

  wrap.append(input, out);
  return wrap;
}

function toggle(value, onChange) {
  const b = document.createElement('button');
  b.className = 'settings__toggle';
  b.classList.toggle('is-on', value);
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(value));
  b.addEventListener('click', () => { onChange(!value); renderSettings(); });
  return b;
}

/** 설정 행에 놓는 작은 버튼 묶음 */
function actions(items) {
  const wrap = document.createElement('div');
  wrap.className = 'settings__seg';
  for (const [label, fn] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    wrap.append(b);
  }
  return wrap;
}

/** 부팅 자동 시작 — 현재 상태를 메인에 물어보고 그린다 */
function autoLaunchToggle() {
  const b = document.createElement('button');
  b.className = 'settings__toggle';
  b.setAttribute('role', 'switch');

  const paint = (on) => {
    b.classList.toggle('is-on', !!on);
    b.setAttribute('aria-checked', String(!!on));
  };

  window.api.app.getAutoLaunch().then((r) => {
    paint(r?.enabled);
    if (r?.dev) b.title = '개발 실행 중에는 적용되지 않습니다 (설치본에서 동작).';
  });

  b.addEventListener('click', async () => {
    const next = !b.classList.contains('is-on');
    const r = await window.api.app.setAutoLaunch(next);
    if (r?.ok) {
      paint(r.enabled);
      showToast(r.enabled ? '부팅 시 자동으로 켜집니다' : '자동 시작을 껐습니다');
    } else {
      showToast(r?.error || '설정하지 못했습니다');
    }
  });

  return b;
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
  renderSettings();
}

function presetButtons() {
  const wrap = document.createElement('div');
  wrap.className = 'settings__seg';
  const presets = [['compact', '컴팩트'], ['normal', '기본'], ['wide', '와이드'], ['tall', '세로형']];
  for (const [key, label] of presets) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.act = 'preset';
    b.dataset.preset = key;
    wrap.append(b);
  }
  return wrap;
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
// 여기서 요약을 만들어 메인에 넘긴다.

let lastTraySignature = '';

function reportToTray() {
  const today = todayKey();
  const onToday = store.tasksOnDate(today, { filtered: false });
  const undone = onToday.filter((t) => !t.done);

  const summary = {
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
        // 입력칸에서 나오는 것으로 끝내지 않는다. 일정을 고치던 중이었다면
        // 한 번으로 편집까지 닫아 준다 — 두 번 눌러야 나가지는 건 갇힌 느낌이다.
        active.blur();
        if (store.getState().editingTaskId) store.setEditing(null);
        return;
      }
      const hasText = active.isContentEditable ? !!active.textContent : !!active.value;
      if (hasText) return;
    }

    if (e.key === 'Escape' && briefSheet) { closeBrief(); return; }
    // 편집 집중 모드에서 빠져나오기. 목록이 통째로 접혀 있으므로 탈출구가 분명해야 한다.
    if (e.key === 'Escape' && store.getState().editingTaskId) { store.setEditing(null); return; }
    if (e.key === 'Escape' && helpSheet) { closeHelp(); return; }
    if (e.key === 'Escape' && bellPopover) { closeBell(); return; }
    if (e.key === 'Escape' && !els.settings.hidden) { toggleSettings(); return; }
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
      return;
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
