// 앱 부트스트랩. 셸(타이틀바 · 스플리터 · 설정)을 담당하고
// 캘린더 / 투두 모듈을 각자의 root 에 마운트한다.

import * as store from './store.js';
import { createCalendar } from './calendar/calendar.js';
import { createTodoPanel } from './todo/todo.js';
import { createDashboard } from './dashboard/dashboard.js';
import { createLauncher } from './launcher/launcher.js';
import { todayKey } from './lib/date.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  root: $('#widget'),
  calendar: $('#calendar-root'),
  todo: $('#todo-root'),
  splitter: $('#splitter'),
  dash: $('#dash-root'),
  launcher: $('#launcher-root'),
  settings: $('#settings-root'),
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

// ---------------------------------------------------------------- 부팅

async function boot() {
  await store.init();

  applyChrome(store.getState().settings);

  calendar = createCalendar({ root: els.calendar, store });
  todo = createTodoPanel({ root: els.todo, store });
  dashboard = createDashboard({ root: els.dash, store });
  launcher = createLauncher({ root: els.launcher, store });

  wireTitlebar();
  wireDimming();
  wireSplitter();
  wireSettings();
  wireMenuActions();
  wireShortcuts();

  // 설정이 바뀌면 셸 외형도 따라간다
  store.subscribe((state) => {
    applyChrome(state.settings);
    updateTitle(state);
  });

  updateTitle(store.getState());

  if (store.getState().loadNotice) showNotice(store.getState().loadNotice);
}

/** 데이터 손상 백업 등, 사용자가 알아야 할 일회성 안내 */
function showNotice(text) {
  const el = document.createElement('div');
  el.className = 'notice';
  el.textContent = text;
  el.addEventListener('click', () => el.remove());
  els.root.append(el);
  setTimeout(() => el.remove(), 12000);
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
  if (s.splitRatio !== prev.splitRatio) {
    els.calendar.style.flex = `0 0 ${(s.splitRatio * 100).toFixed(2)}%`;
  }
  if (s.alwaysOnTop !== prev.alwaysOnTop) {
    els.btnPin.classList.toggle('is-active', s.alwaysOnTop);
    window.api.window.setAlwaysOnTop(s.alwaysOnTop);
  }
  if (s.opacity !== prev.opacity) {
    window.api.window.setOpacity(s.opacity);
  }
  if (s.clickThroughLocked !== prev.clickThroughLocked) {
    window.api.window.setIgnoreMouseEvents(s.clickThroughLocked);
  }

  // --- 글래스모피즘 외형 ---
  if (s.glass !== prev.glass) {
    document.documentElement.dataset.glass = s.glass;
  }
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

/** 창이 비활성이면 위젯을 배경으로 물린다 (macOS 데스크톱 위젯의 틴팅/디밍 방식).
 *  마우스를 올리면 CSS 가 즉시 원래 질감으로 복원한다. */
function wireDimming() {
  const setInactive = (v) => document.documentElement.classList.toggle('is-inactive', v);
  window.addEventListener('blur', () => setInactive(true));
  window.addEventListener('focus', () => setInactive(false));
  setInactive(!document.hasFocus());
}

function updateTitle(state) {
  const total = state.tasks.filter((t) => !t.done && t.start === todayKey()).length;
  els.title.textContent = total > 0 ? `일정관리 비서 · 오늘 ${total}건` : '일정관리 비서';
}

// ---------------------------------------------------------------- 타이틀바

function wireTitlebar() {
  els.btnMin.addEventListener('click', () => window.api.window.minimize());
  els.btnClose.addEventListener('click', () => window.api.window.hide());
  els.btnPin.addEventListener('click', () => {
    store.setSetting('alwaysOnTop', !store.getState().settings.alwaysOnTop);
  });
  els.btnSettings.addEventListener('click', toggleSettings);
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
    row('테마', segmented([['dark', '다크'], ['light', '라이트']], s.theme, (v) =>
      store.setSetting('theme', v))),

    row('투명도', slider(0.3, 1, 0.02, s.opacity, (v) =>
      store.setSetting('opacity', v), (v) => `${Math.round(v * 100)}%`)),

    row('글자 크기', slider(0.8, 1.4, 0.05, s.fontScale, (v) =>
      store.setSetting('fontScale', v), (v) => `${Math.round(v * 100)}%`)),

    row('유리 강도', segmented([['clear', '맑게'], ['normal', '보통'], ['solid', '진하게']],
      s.glass, (v) => store.setSetting('glass', v)),
      '월페이퍼가 복잡하면 진하게, 단순하면 맑게가 읽기 좋습니다.'),

    row('배경 흐림 효과', toggle(s.blurEnabled, (v) => store.setSetting('blurEnabled', v)),
      '끄면 GPU 사용량이 줄어듭니다. 저사양·배터리 모드에서 권장.'),

    row('비활성일 때 흐리게', toggle(s.dimInactive, (v) => store.setSetting('dimInactive', v)),
      '다른 창을 쓰는 동안 위젯이 배경으로 물러납니다. 마우스를 올리면 복원됩니다.'),

    row('창 크기', presetButtons()),

    row('D-Day 대시보드', toggle(s.showDashboard, (v) => store.setSetting('showDashboard', v))),

    row('퀵 런처', toggle(s.showLauncher, (v) => store.setSetting('showLauncher', v))),

    row('정렬 기준', segmented([['manual', '직접 정렬'], ['priority', '우선순위']],
      s.sortMode, (v) => store.setSetting('sortMode', v))),

    row('항상 위에 표시', toggle(s.alwaysOnTop, (v) => store.setSetting('alwaysOnTop', v))),

    row('완료 항목 표시', toggle(s.showCompleted, (v) => store.setSetting('showCompleted', v))),

    row('클릭 통과(잠금)', toggle(s.clickThroughLocked, (v) => {
      store.setSetting('clickThroughLocked', v);
      if (v) toggleSettings();   // 잠그면 더 이상 클릭이 안 되므로 패널을 닫는다
    }), '켜면 위젯이 마우스를 통과시켜 배경처럼 됩니다. Alt+Shift+S 로 해제하세요.'),
  );

  const close = document.createElement('button');
  close.className = 'settings__close';
  close.dataset.act = 'close';
  close.textContent = '닫기';
  frag.append(close);

  els.settings.append(frag);
}

// --- 설정 위젯 빌더들 ---

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
  });
}

function wireShortcuts() {
  window.addEventListener('keydown', (e) => {
    // 입력 중일 땐 앱 단축키를 가로채지 않는다
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }

    if (e.key === 'Escape' && !els.settings.hidden) { toggleSettings(); return; }
    if (e.ctrlKey && e.key === ',') { toggleSettings(); e.preventDefault(); }
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
