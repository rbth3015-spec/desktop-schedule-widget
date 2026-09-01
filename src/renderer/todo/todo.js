// 투두 패널 — 캘린더에서 고른 날짜(state.selectedDate)와 연동되는 할 일 목록.
// 계약: export function createTodoPanel({ root, store }) -> { destroy() }
// 외부 라이브러리 없음. 순수 ES 모듈 + DOM API. 사용자 입력은 항상 textContent 로만 넣는다.

import { todayKey, toKey, fromKey, addDays, diffDays, WEEKDAY_LABELS } from '../lib/date.js';
import { remindLabel } from '../reminders.js';
import { icon } from '../lib/icons.js';
import { createCompose, whenSummary } from './compose.js';
import { COLOR_NAMES } from './parse.js';
import { showContextMenu } from '../lib/menu.js';

/**
 * 리마인더 프리셋.
 *   'N@HH:mm'  시작일에서 N일 전의 지정 시각
 *   '-Nm'      시작 시각 N분 전 — 시각이 있는 일정에서만 뜻이 있다
 */
const REMIND_PRESETS = [
  ['',        '알림 없음'],
  ['-10m',    '10분 전',  true],
  ['-30m',    '30분 전',  true],
  ['-60m',    '1시간 전', true],
  ['0@09:00', '당일 오전 9시'],
  ['0@12:00', '당일 정오'],
  ['0@18:00', '당일 오후 6시'],
  ['1@18:00', '하루 전 오후 6시'],
  ['3@18:00', '3일 전 오후 6시'],
  ['7@18:00', '일주일 전 오후 6시'],
];

/** 반복 프리셋 */
const REPEAT_PRESETS = [
  ['',        '반복 안 함'],
  ['daily',   '매일'],
  ['weekly',  '매주'],
  ['monthly', '매월'],
  ['yearly',  '매년'],
];

function repeatSelect(cls) {
  const sel = document.createElement('select');
  sel.className = cls;
  for (const [value, label] of REPEAT_PRESETS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sel.append(opt);
  }
  return sel;
}

function remindSelect(cls) {
  const sel = document.createElement('select');
  sel.className = cls;
  for (const [value, label, needsTime] of REMIND_PRESETS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (needsTime) opt.dataset.needsTime = '1';
    sel.append(opt);
  }
  return sel;
}

/** 시각 없는 일정에서는 '몇 분 전'을 숨긴다 — 기준점이 없어 울리지 않는 선택지다 */
function syncRemindOptions(sel, hasTime) {
  for (const opt of sel.options) {
    if (opt.dataset.needsTime) opt.hidden = !hasTime;
  }
}

// ============================================================ DOM 헬퍼

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/**
 * 사용자가 입력한 링크를 정규화한다.
 * 'meet.google.com/abc' 처럼 프로토콜 없이 적어도 https 를 붙여 준다.
 * @returns {string|null} 빈 문자열이면 링크 없음, null 이면 잘못된 주소
 */
function normalizeLink(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;   // 'https://abc' 같은 오타 거르기
    return u.href;
  } catch {
    return null;
  }
}

/** 링크를 기본 브라우저로 연다 */
function openLink(url) {
  const href = normalizeLink(url);
  if (!href) return;
  window.api.openExternal(href);
}

/** 표시용 짧은 링크 — 'google.com/abc...' */
function linkLabel(url) {
  try {
    const u = new URL(url);
    const tail = (u.pathname + u.search).replace(/\/$/, '');
    const s = u.hostname.replace(/^www\./, '') + tail;
    return s.length > 34 ? s.slice(0, 33) + '…' : s;
  } catch {
    return url;
  }
}

/** '8월 10일 (월)' */
function formatDateLabel(key) {
  const d = fromKey(key);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY_LABELS[d.getDay()]})`;
}

/** '8/15(금)' — 좁은 곳용 */
function formatShort(key) {
  const d = fromKey(key);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAY_LABELS[d.getDay()]})`;
}

/** 포커스 중인 필드의 값은 덮어쓰지 않는다 (한글 조합 중 입력 날아감 방지) */
function setValueSafe(el, value) {
  if (document.activeElement === el) return;
  if (el.value !== value) el.value = value;
}

/**
 * 짧은 확인 문구를 셸에 부탁한다.
 * 뷰 모듈끼리 직접 부르지 않는다는 계약을 지키려고 이벤트로 넘긴다.
 */
function notify(text) {
  document.dispatchEvent(new CustomEvent('app:toast', { detail: String(text) }));
}

/** 만든 지 며칠 됐나 */
function daysSince(ts) {
  if (!ts) return 0;
  return Math.max(0, Math.floor((Date.now() - ts) / 86400000));
}

/** '2주째' / '3달째' — 오래 묵은 '언젠가' 를 눈에 띄게 한다 */
function ageLabel(days) {
  if (days < 30) return `${Math.floor(days / 7)}주째`;
  if (days < 365) return `${Math.floor(days / 30)}달째`;
  return `${Math.floor(days / 365)}년째`;
}

/** 다가오는 토요일 (오늘이 토요일이면 오늘) */
function nextWeekendKey() {
  const base = todayKey();
  const day = fromKey(base).getDay();
  return addDays(base, (6 - day + 7) % 7);
}

function isSpanTask(t) {
  return !!(t.start && t.end && t.end > t.start);
}

function isFormControl(el) {
  return !!(el && el.closest && el.closest('input, textarea, select'));
}

// ============================================================ 패널 팩토리

export function createTodoPanel({ root, store }) {
  const COLORS = store.COLORS;
  const PRIORITY_LABELS = store.PRIORITY_LABELS;

  // ---------------------------------------------------------- 정적 셸 (한 번만 생성)
  const el = h('div', 'todo-panel');

  // 헤더 -------------------------------------------------------
  const header = h('header', 'todo-header');

  const completedBtn = h('button', 'todo-toggle', '완료 표시');
  completedBtn.type = 'button';
  completedBtn.setAttribute('aria-pressed', 'false');

  const dateRow = h('div', 'todo-daterow');
  const dateLabel = h('div', 'todo-date');
  const todayBadge = h('span', 'todo-badge todo-badge--today', '오늘');

  const progressText = h('span', 'todo-progress__text', '0/0');

  // 검색은 늘 펼쳐 둘 만큼 자주 쓰지 않아 접어 둔다.
  // 다만 아이콘만 덩그러니 두면 무슨 버튼인지 알아보기 어려워서 이름을 함께 적는다.
  // ('오늘로' 는 캘린더 머리글에 이미 있다 — 같은 일을 하는 버튼을 둘 두지 않는다)
  const searchBtn = h('button', 'todo-searchbtn');
  searchBtn.type = 'button';
  searchBtn.append(icon('search'), h('span', 'todo-searchbtn__text', '검색'));
  searchBtn.setAttribute('aria-label', '검색 열기');
  searchBtn.setAttribute('aria-expanded', 'false');

  dateRow.append(dateLabel, todayBadge, progressText, searchBtn, completedBtn);

  // 일정을 만드는 유일한 입구다. 머리글 구석의 22px 아이콘으로 두면
  // '여기서 추가한다'는 걸 알아채는 데 시간이 걸린다 — 이름을 달고 크게 둔다.
  // 자리는 예전 빠른 입력칸이 있던 곳. 목록 바로 위, 가장 먼저 눈이 가는 줄이다.
  const addBtn = h('button', 'todo-add');
  addBtn.type = 'button';
  addBtn.append(icon('plus'), h('span', 'todo-add__text', '일정 추가'));

  // 매일 하는 일(운동 같은)을 만들려고 '반복 켜고 → 더보기 펼치고 → 체크리스트로만 누르고'
  // 를 매번 거치는 건 너무 멀다. 아예 다른 물건이므로 입구를 따로 낸다.
  const routineBtn = h('button', 'todo-add todo-add--routine');
  routineBtn.type = 'button';
  routineBtn.append(icon('repeat'), h('span', 'todo-add__text', '체크리스트'));
  routineBtn.title = '매일·매주 반복하는 일. 달력에는 표시하지 않습니다.';

  const addBar = h('div', 'todo-addbar');
  addBar.append(addBtn, routineBtn);

  const progressBar = h('div', 'todo-progress');
  const progressFill = h('div', 'todo-progress__fill');
  progressBar.append(progressFill);

  // 검색 줄 — 돋보기를 누를 때만 펼친다
  const filterRow = h('div', 'todo-filters');
  filterRow.hidden = true;
  const searchInput = h('input', 'todo-search');
  searchInput.type = 'text';
  searchInput.placeholder = '전체 일정에서 검색';
  searchInput.spellcheck = false;
  searchInput.setAttribute('aria-label', '전체 일정 검색');
  const searchClose = h('button', 'todo-searchclose');
  searchClose.type = 'button';
  searchClose.append(icon('close'));
  searchClose.setAttribute('aria-label', '검색 닫기');
  filterRow.append(searchInput, searchClose);

  const tagBar = h('div', 'todo-tagbar');

  header.append(dateRow, progressBar, filterRow, tagBar);


  // 목록 -------------------------------------------------------
  const body = h('div', 'todo-body');

  const sections = {
    search: makeSection('search', '검색 결과'),
    // 기한이 지났는데 안 끝난 일. 고른 날짜와 무관하게 언제나 맨 위에 온다 —
    // 어제 못 끝낸 일이 어제 칸에 남아 시야에서 사라지는 게 이 앱의 가장 큰 구멍이었다.
    overdue: makeSection('overdue', '지난 일'),
    // 매일·매주 하는 일(운동 같은). 달력에는 그리지 않고 여기서만 체크한다.
    routine: makeSection('routine', '체크리스트'),
    focus: makeSection('focus', '선택한 항목'),
    day: makeSection('day', '오늘 할 일'),
    span: makeSection('span', '진행 중인 장기 계획'),
    inbox: makeSection('inbox', '언젠가'),
  };
  sections.inbox.collapsed = false;
  sections.overdue.el.classList.add('todo-section--overdue');
  sections.routine.el.classList.add('todo-section--routine');
  sections.focus.el.classList.add('todo-section--focus');

  // '오늘로 당기기' — 밀린 일을 한 번에 오늘로. 되돌리기 한 번으로 취소된다.
  const rollBtn = h('button', 'todo-rollup', '오늘로 당기기');
  rollBtn.type = 'button';
  rollBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const ids = store.overdueTasks().map((t) => t.id);
    if (!ids.length) return;
    const n = store.moveTasksTo(ids, todayKey(), `밀린 일 ${ids.length}건 오늘로`);
    store.selectDate(todayKey());
    if (n) notify(`${n}건을 오늘로 옮겼습니다`);
  });
  sections.overdue.actions.append(rollBtn);

  // 집중 모드에서 목록으로 돌아가는 길. 상세를 닫으면 원래 목록이 그대로 돌아온다.
  const backBtn = h('button', 'todo-back');
  backBtn.type = 'button';
  backBtn.append(icon('chevronLeft'), h('span', null, '목록으로'));
  backBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    store.setEditing(null);
  });
  sections.focus.actions.append(backBtn);

  body.append(sections.search.el, sections.overdue.el, sections.focus.el,
              sections.day.el, sections.routine.el, sections.span.el, sections.inbox.el);

  // 일정 추가 폼 -----------------------------------------------
  // 빠른 입력이 문법을 외워야 하는 반면, 이쪽은 클릭만으로 전부 지정할 수 있는 경로다.
  // 폼이 열리고 닫힐 때마다 추가 버튼 줄을 맞춘다(취소·Esc·제출 모두 포함).
  const compose = createCompose({ store, onToggle: () => syncAddBar() });

  // 일정을 만드는 입구는 헤더의 '+' 하나뿐이다.
  // 전용 입력칸이 따로 있으면 같은 일을 하는 길이 둘로 갈려 매번 어느 쪽인지 고민하게 된다.
  // 한 줄 문법은 버리지 않았다 — 추가 폼의 제목칸이 그대로 이해한다.
  el.append(header, addBar, compose.el, body);
  root.append(el);

  addBtn.addEventListener('click', () => {
    if (compose.el.hidden) compose.open();
    else compose.close();
  });

  routineBtn.addEventListener('click', () => {
    if (compose.el.hidden) compose.open({ routine: true });
    else compose.close();
  });

  /** 폼이 열려 있는 동안에는 버튼을 감춘다.
   *  폼 안에 이미 '취소 / 일정 추가' 가 있어서, 위에 같은 뜻의 버튼이 하나 더 있으면
   *  어느 쪽을 눌러야 하는지 다시 헷갈린다. */
  function syncAddBar() {
    // 집중 모드에서는 감춘다 — 지금 하는 일은 '고치기' 지 '만들기' 가 아니다.
    addBar.hidden = !compose.el.hidden || el.classList.contains('is-focusmode');
  }

  /** 날짜·기간·링크까지 한 번에 지정하는 추가 폼 */

  // ---------------------------------------------------------- 로컬 UI 상태
  const itemCache = new Map();   // taskId -> 아이템 레코드 (DOM 재사용 → 포커스/조합 보존)
  let inlineEditId = null;       // 제목 인라인 편집 중인 태스크 id
  let lastEditingId = null;      // editingTaskId 변화 감지 (스크롤용)
  let rafId = 0;
  let destroyed = false;
  let notesTimer = null;
  let pendingNotes = null;       // { id, value }
  let dragId = null;             // 현재 드래그 중인 태스크 id
  let lastTagSignature = '';

  // ---------------------------------------------------------- 섹션 생성기
  function makeSection(key, title) {
    const secEl = h('section', 'todo-section');
    secEl.dataset.section = key;

    // 접기 버튼과 동작 버튼은 형제여야 한다.
    // 머리글 자체를 button 으로 만들면 '오늘로 당기기'가 버튼 안의 버튼이 되어
    // HTML 이 유효하지 않고 접근성 트리도 무너진다.
    const head = h('div', 'todo-section__head');

    const toggle = h('button', 'todo-section__toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'true');
    const caret = h('span', 'todo-section__caret', '▾');
    const titleEl = h('span', 'todo-section__title', title);
    const count = h('span', 'todo-section__count', '0');
    toggle.append(caret, titleEl, count);

    // 섹션마다 붙는 동작 버튼 자리(예: 지난 일의 '오늘로 당기기'). 기본은 비어 있다.
    const actions = h('span', 'todo-section__actions');
    head.append(toggle, actions);

    const wrap = h('div', 'todo-list-wrap');
    const list = h('ul', 'todo-list');
    const dropline = h('div', 'todo-dropline');
    wrap.append(list, dropline);

    secEl.append(head, wrap);

    const sec = { key, el: secEl, head, toggle, list, wrap, dropline, count, titleEl, actions,
                  ids: [], collapsed: false, emptyEl: null };

    toggle.addEventListener('click', () => {
      sec.collapsed = !sec.collapsed;
      toggle.setAttribute('aria-expanded', String(!sec.collapsed));
      scheduleRender();
    });

    // --- 드롭 대상 ---
    wrap.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('application/x-task-id')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      showDropline(sec, e.clientY);
    });
    wrap.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && wrap.contains(e.relatedTarget)) return;
      sec.dropline.style.display = 'none';
    });
    wrap.addEventListener('drop', (e) => {
      if (!e.dataTransfer) return;
      const id = e.dataTransfer.getData('application/x-task-id');
      sec.dropline.style.display = 'none';
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      handleDrop(sec, id, e.clientY);
    });

    return sec;
  }

  // ---------------------------------------------------------- 드래그 앤 드롭
  /** 드롭 위치 인덱스 (현재 목록 기준) */
  function dropIndexAt(sec, clientY) {
    const items = Array.from(sec.list.children);
    let index = items.length;
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) { index = i; break; }
    }
    return index;
  }

  function showDropline(sec, clientY) {
    const items = Array.from(sec.list.children);
    const index = dropIndexAt(sec, clientY);
    let top;
    if (items.length === 0) {
      top = sec.list.offsetTop + 4;
    } else if (index >= items.length) {
      const last = items[items.length - 1];
      top = last.offsetTop + last.offsetHeight + 1;
    } else {
      top = items[index].offsetTop - 1;
    }
    sec.dropline.style.top = `${top}px`;
    sec.dropline.style.display = 'block';
  }

  function handleDrop(sec, id, clientY) {
    const st = store.getState();
    const inSection = sec.ids.includes(id);

    if (!inSection) {
      // 다른 섹션 → 이 섹션으로 이동 (날짜 부여 / 날짜 해제)
      if (sec.key === 'inbox') store.updateTask(id, { start: null, end: null });
      else if (sec.key === 'day' || sec.key === 'span') store.moveTask(id, st.selectedDate);
      return;
    }

    // 같은 섹션 내 순서 변경
    const index = dropIndexAt(sec, clientY);
    const from = sec.ids.indexOf(id);
    let to = index;
    if (from < to) to -= 1;
    if (from === to) return;
    const rest = sec.ids.filter((x) => x !== id);
    rest.splice(Math.max(0, Math.min(to, rest.length)), 0, id);
    store.reorder(rest);
  }

  // ---------------------------------------------------------- 아이템 생성
  function createItem(taskId) {
    const li = h('li', 'todo-item');
    li.dataset.id = taskId;
    li.draggable = true;
    // 로빙 탭인덱스 — 목록 전체가 아니라 '현재 항목' 하나만 Tab 으로 들어온다.
    // 50개짜리 목록에서 Tab 을 50번 누르게 만들지 않기 위해서다.
    li.tabIndex = -1;

    const row = h('div', 'todo-item__row');

    // 체크는 시각적으로 버튼이지만 하는 일은 체크박스다.
    // role/aria-checked 를 주지 않으면 스크린리더에 '눌림' 상태가 전달되지 않는다.
    const check = h('button', 'todo-check');
    check.type = 'button';
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', 'false');

    const dot = h('span', 'todo-dot');
    // 시각이 있으면 제목 앞에 세워 목록이 그날의 타임라인으로 읽히게 한다
    const time = h('span', 'todo-time');
    time.hidden = true;
    const title = h('span', 'todo-title');
    const meta = h('span', 'todo-meta');           // 우선순위 뱃지 + 태그 + D-day
    // 내일로 미루기.
    // 그동안 우클릭 메뉴 안에만 있어서 '있는 줄 몰라 못 쓰는' 대표 기능이었다.
    // 오늘 못 할 일을 미는 건 매일 하는 동작이라 손 닿는 곳에 둔다.
    const defer = h('button', 'todo-defer');
    defer.append(icon('chevronRight'));
    defer.type = 'button';

    const del = h('button', 'todo-del');
    del.append(icon('close'));
    del.type = 'button';

    row.append(check, dot, time, title, meta, defer, del);
    li.append(row);

    const rec = { id: taskId, el: li, row, check, dot, time, title, meta, defer, del,
                  detail: null, task: null };

    // 완료 토글
    check.addEventListener('click', (e) => {
      e.stopPropagation();
      // 반복 일정은 '이 회차'만 완료 처리한다
      store.toggleDone(taskId, rec.task?.occDate);
    });

    // 내일로 미루기
    defer.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = rec.task;
      if (!t || !t.start || t.repeat) return;
      store.moveTask(t.id, addDays(t.start, 1));
      notify(`'${t.title || '일정'}' 을(를) 내일로 미뤘습니다`);
    });

    // 삭제
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (store.getState().editingTaskId === taskId) store.setEditing(null);
      // 반복 일정은 이 회차만 건너뛴다. 규칙째 지우려면 상세의 '반복 전체 삭제'.
      store.removeTask(taskId, rec.task?.occDate);
    });

    // 우클릭 메뉴 — 자주 쓰는 동작을 손 가까이에 둔다
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const t = rec.task;
      if (!t) return;
      const st = store.getState();
      showContextMenu(e.clientX, e.clientY, [
        {
          label: t.done ? '완료 취소' : '완료로 표시',
          onSelect: () => store.toggleDone(t.id, t.occDate),
        },
        {
          label: st.editingTaskId === t.id ? '자세히 닫기' : '자세히 보기',
          onSelect: () => store.setEditing(st.editingTaskId === t.id ? null : t.id),
        },
        { separator: true },
        {
          // 반복 일정은 규칙 하나를 공유하므로 한 회차만 밀 수 없다.
          // 예전에는 눌리기는 하는데 아무 일도 일어나지 않았다.
          label: '내일로 미루기',
          disabled: !t.start || !!t.repeat,
          onSelect: () => store.moveTask(t.id, addDays(t.start, 1)),
        },
        {
          label: t.pinned ? 'D-Day 고정 해제' : 'D-Day에 고정',
          disabled: !!t.repeat || !t.end,
          onSelect: () => store.togglePinned(t.id),
        },
        {
          label: '복제',
          onSelect: () => {
            const copy = store.duplicateTask(t.id);
            if (copy) store.setEditing(copy.id);
          },
        },
        { separator: true },
        {
          label: t.repeat && t.occDate ? '이 회차 건너뛰기' : '삭제',
          danger: true,
          onSelect: () => {
            if (store.getState().editingTaskId === t.id) store.setEditing(null);
            store.removeTask(t.id, t.occDate);
          },
        },
      ]);
    });

    // 클릭 → 상세 펼치기/접기.
    // 제목 위 클릭은 더블클릭(인라인 편집)일 수 있으므로 잠깐 미뤘다가 실행한다.
    let clickTimer = null;
    const toggleExpand = () => {
      if (destroyed) return;
      const cur = store.getState().editingTaskId;
      const opening = cur !== taskId;
      store.setEditing(opening ? taskId : null);

      // 펼칠 때 달력도 그 날로 옮긴다.
      // 검색 결과나 '지난 일' 은 다른 달의 일정일 수 있어서, 고치는 동안 달력이
      // 엉뚱한 달을 보고 있으면 앞뒤 맥락을 알 수 없다.
      const t = rec.task;
      if (opening && t?.start) {
        const target = t.occDate || t.start;
        if (target !== store.getState().selectedDate) store.selectDate(target);
      }
    };
    li.addEventListener('click', (e) => {
      if (e.target.closest('.todo-check, .todo-del, .todo-defer, .todo-plan, .todo-detail, .todo-tag')) return;
      // 펼친 상태의 제목은 입력칸이다 — 클릭이 접기로 번지면 글자를 못 고친다
      if (e.target.closest('.todo-title--edit, .todo-title-input')) return;
      if (e.detail > 1) return;   // 더블클릭의 두 번째 클릭 무시
      if (e.target.closest('.todo-title')) {
        clearTimeout(clickTimer);
        clickTimer = setTimeout(toggleExpand, 200);
      } else {
        toggleExpand();
      }
    });

    // 접힌 상태에서 제목 더블클릭 → 그 자리에서 이름만 고치기.
    // 제목 엘리먼트는 펼침 여부에 따라 span ↔ input 으로 바뀌므로 행에 위임한다.
    li.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.todo-title')) return;
      if (e.target.closest('.todo-title--edit, .todo-title-input')) return;
      e.stopPropagation();
      clearTimeout(clickTimer);
      startInlineEdit(rec);
    });

    // 입력 필드를 잡고 드래그할 때 아이템 드래그가 가로채지 않도록
    li.addEventListener('mousedown', (e) => {
      li.draggable = !isFormControl(e.target);
    });

    li.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData('application/x-task-id', taskId);
      e.dataTransfer.setData('text/plain', rec.task ? rec.task.title : '');
      e.dataTransfer.effectAllowed = 'move';
      dragId = taskId;
      li.classList.add('is-dragging');
    });
    li.addEventListener('dragend', () => {
      dragId = null;
      li.classList.remove('is-dragging');
      li.draggable = true;
      for (const key of Object.keys(sections)) sections[key].dropline.style.display = 'none';
    });

    return rec;
  }

  function getItem(taskId) {
    let rec = itemCache.get(taskId);
    if (!rec) {
      rec = createItem(taskId);
      itemCache.set(taskId, rec);
    }
    return rec;
  }

  // ---------------------------------------------------------- 인라인 제목 편집
  function startInlineEdit(rec) {
    if (inlineEditId === rec.id) return;
    inlineEditId = rec.id;
    const original = rec.task ? rec.task.title : '';

    const input = h('input', 'todo-title-input');
    input.type = 'text';
    input.value = original;
    input.spellcheck = false;
    rec.title.replaceWith(input);
    rec.titleInput = input;
    input.focus();
    input.select();

    let closed = false;
    const close = (save) => {
      if (closed) return;
      closed = true;
      inlineEditId = null;
      rec.titleInput = null;
      const value = input.value.trim();
      input.replaceWith(rec.title);
      if (save && value && value !== original) store.updateTask(rec.id, { title: value });
      else scheduleRender();
    };

    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;   // 한글 조합 중
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
      else if (e.key === 'Escape') { e.preventDefault(); close(false); }
    });
    input.addEventListener('blur', () => close(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  // ---------------------------------------------------------- 상세 영역
  function field(labelText, control) {
    const f = h('label', 'todo-field');
    f.append(h('span', 'todo-field__label', labelText), control);
    return f;
  }

  function buildDetail(rec) {
    const d = h('div', 'todo-detail');

    const notes = h('textarea', 'todo-detail__notes');
    notes.placeholder = '메모';
    notes.rows = 2;
    notes.addEventListener('input', () => {
      pendingNotes = { id: rec.id, value: notes.value };
      clearTimeout(notesTimer);
      notesTimer = setTimeout(flushNotes, 300);
    });
    notes.addEventListener('blur', flushNotes);

    // 시작 / 종료 · 날짜 + 시각.
    // 추가 폼과 같은 배치다 — 만들 때와 고칠 때의 조작이 달라선 안 된다.
    const startIn = h('input', 'todo-detail__date');
    startIn.type = 'date';
    startIn.setAttribute('aria-label', '시작 날짜');
    startIn.addEventListener('change', () => {
      const v = startIn.value;
      if (!v) store.updateTask(rec.id, { start: null, end: null });
      else store.updateTask(rec.id, { start: v });
    });

    const startTimeIn = h('input', 'todo-detail__time');
    startTimeIn.type = 'time';
    startTimeIn.setAttribute('aria-label', '시작 시각 (비우면 종일)');
    startTimeIn.addEventListener('change', () => {
      // 빈 값은 '종일'이다. store 가 종료 시각과 상대 알림까지 함께 정리한다.
      store.updateTask(rec.id, { startTime: startTimeIn.value || null });
    });

    const endIn = h('input', 'todo-detail__date');
    endIn.type = 'date';
    endIn.setAttribute('aria-label', '종료 날짜');
    endIn.addEventListener('change', () => {
      const t = rec.task;
      const v = endIn.value;
      if (!t || !t.start) return;
      // 종료가 시작보다 빠르면 막지 않고 시작에 맞춘다 (추가 폼과 같은 규칙)
      store.updateTask(rec.id, { end: v && v >= t.start ? v : t.start });
    });

    const endTimeIn = h('input', 'todo-detail__time');
    endTimeIn.type = 'time';
    endTimeIn.setAttribute('aria-label', '종료 시각');
    endTimeIn.addEventListener('change', () => {
      store.updateTask(rec.id, { endTime: endTimeIn.value || null });
    });

    const prio = h('select', 'todo-detail__select');
    PRIORITY_LABELS.forEach((label, i) => {
      const opt = h('option', null, label);
      opt.value = String(i);
      prio.append(opt);
    });
    prio.addEventListener('change', () => {
      store.updateTask(rec.id, { priority: Number(prio.value) });
    });

    const swatches = h('div', 'todo-swatches');
    const swatchBtns = {};
    for (const key of Object.keys(COLORS)) {
      const b = h('button', 'todo-swatch');
      b.type = 'button';
      b.title = COLOR_NAMES[key] || key;
      b.style.background = COLORS[key];
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        store.updateTask(rec.id, { color: key });
      });
      swatchBtns[key] = b;
      swatches.append(b);
    }

    const tagsIn = h('input', 'todo-detail__tags');
    tagsIn.type = 'text';
    tagsIn.placeholder = '태그 (공백/쉼표 구분)';
    tagsIn.spellcheck = false;
    const commitTags = () => {
      const tags = tagsIn.value
        .split(/[\s,]+/)
        .map((s) => s.replace(/^#/, '').trim())
        .filter(Boolean);
      const cur = rec.task ? rec.task.tags : [];
      if (tags.join('\u0000') !== cur.join('\u0000')) store.updateTask(rec.id, { tags });
    };
    tagsIn.addEventListener('change', commitTags);
    tagsIn.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); tagsIn.blur(); }
    });

    const whenRow = (labelText, dateEl, timeEl) => {
      const r = h('div', 'todo-detail__whenrow');
      r.append(h('span', 'todo-detail__whenkey', labelText), dateEl, timeEl);
      return r;
    };

    // 무엇으로 저장돼 있는지 한 줄로 되읽어 준다 — 추가 폼과 같은 문구를 쓴다
    const whenSummaryEl = h('div', 'todo-detail__whensummary');
    whenSummaryEl.setAttribute('aria-live', 'polite');

    const rowDates = h('div', 'todo-detail__when');
    rowDates.append(
      whenRow('시작', startIn, startTimeIn),
      whenRow('종료', endIn, endTimeIn),
      whenSummaryEl,
    );

    const rowMeta = h('div', 'todo-detail__row');
    rowMeta.append(field('우선순위', prio), field('색', swatches));

    // 관련 링크 — 저장해 두면 항목에 🔗 가 붙고, 클릭하면 브라우저로 열린다
    const linkIn = h('input', 'todo-detail__link');
    linkIn.type = 'text';
    linkIn.placeholder = '관련 링크 (예: meet.google.com/abc)';
    linkIn.spellcheck = false;

    const linkOpen = h('button', 'todo-detail__linkopen', '열기');
    linkOpen.type = 'button';
    linkOpen.addEventListener('click', (e) => {
      e.stopPropagation();
      if (rec.task?.link) openLink(rec.task.link);
    });

    const commitLink = () => {
      const next = normalizeLink(linkIn.value);
      if (next === null) {
        linkIn.classList.add('is-invalid');
        return;
      }
      linkIn.classList.remove('is-invalid');
      if (next !== (rec.task?.link || '')) store.updateTask(rec.id, { link: next });
    };
    linkIn.addEventListener('change', commitLink);
    linkIn.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); linkIn.blur(); }
    });

    const linkRow = h('div', 'todo-detail__linkrow');
    linkRow.append(linkIn, linkOpen);

    // 리마인더 — 바꾸면 '이미 알림' 표시를 지워 새 시각에 다시 알리게 한다
    const remindIn = remindSelect('todo-detail__select');
    remindIn.addEventListener('change', () => {
      store.updateTask(rec.id, { remind: remindIn.value, remindedAt: null });
    });

    // 반복 — 규칙을 바꾸면 이미 기록해 둔 예외/완료 회차는 store 가 정리한다
    const repeatIn = repeatSelect('todo-detail__select');
    const untilIn = h('input', 'todo-detail__date');
    untilIn.type = 'date';
    untilIn.title = '반복 종료일 (비우면 계속)';

    const applyRepeat = () => {
      if (!repeatIn.value) { store.setRepeat(rec.id, null); return; }
      store.setRepeat(rec.id, {
        freq: repeatIn.value,
        interval: 1,
        until: untilIn.value || null,
      });
    };
    repeatIn.addEventListener('change', applyRepeat);
    untilIn.addEventListener('change', applyRepeat);

    const untilField = field('반복 종료', untilIn);

    // D-Day 대시보드 고정 — 이 버튼이 없어서 대시보드를 채울 방법이 아예 없었다
    const pinBtn = h('button', 'todo-detail__pin');
    pinBtn.type = 'button';
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      store.togglePinned(rec.id);
    });

    const dropSeries = h('button', 'todo-detail__series', '반복 전체 삭제');
    dropSeries.type = 'button';
    dropSeries.addEventListener('click', (e) => {
      e.stopPropagation();
      if (store.getState().editingTaskId === rec.id) store.setEditing(null);
      store.removeSeries(rec.id);
    });

    const rowExtra = h('div', 'todo-detail__row');
    rowExtra.append(field('알림', remindIn), field('반복', repeatIn), untilField);

    const rowSeries = h('div', 'todo-detail__row');
    rowSeries.append(pinBtn, dropSeries);

    d.append(notes, rowDates, rowMeta, field('태그', tagsIn), field('링크', linkRow),
             rowExtra, rowSeries);

    rec.detail = { el: d, notes, startIn, endIn, startTimeIn, endTimeIn, whenSummaryEl,
                   prio, swatchBtns, tagsIn, linkIn, linkOpen,
                   remindIn, repeatIn, untilIn, untilField, rowSeries, pinBtn, dropSeries };
    return rec.detail;
  }

  function flushNotes() {
    clearTimeout(notesTimer);
    if (!pendingNotes) return;
    const { id, value } = pendingNotes;
    pendingNotes = null;
    store.updateTask(id, { notes: value });
  }

  function updateDetail(rec, task) {
    const d = rec.detail;
    if (!d) return;
    setValueSafe(d.notes, task.notes || '');
    setValueSafe(d.startIn, task.start || '');
    setValueSafe(d.endIn, task.end || task.start || '');
    setValueSafe(d.startTimeIn, task.startTime || '');
    setValueSafe(d.endTimeIn, task.endTime || '');
    d.endIn.disabled = !task.start;
    // 날짜 없는 '언젠가' 항목에는 시각을 붙일 자리가 없다.
    // 종료 시각은 시작 시각이 있어야 뜻이 생긴다.
    d.startTimeIn.disabled = !task.start;
    d.endTimeIn.disabled = !task.start || !task.startTime;
    d.whenSummaryEl.textContent = task.start
      ? whenSummary({
          start: task.start,
          end: task.end || task.start,
          startTime: task.startTime,
          endTime: task.endTime,
          freq: task.repeat?.freq || '',
        })
      : '날짜 없음 · 언젠가 할 일';
    setValueSafe(d.prio, String(task.priority || 0));
    setValueSafe(d.tagsIn, task.tags.join(' '));
    setValueSafe(d.linkIn, task.link || '');
    d.linkOpen.disabled = !task.link;
    syncRemindOptions(d.remindIn, !!task.startTime);
    setValueSafe(d.remindIn, task.remind || '');
    setValueSafe(d.repeatIn, task.repeat?.freq || '');
    setValueSafe(d.untilIn, task.repeat?.until || '');
    d.untilField.hidden = !task.repeat;
    d.dropSeries.hidden = !task.repeat;
    // 반복 일정은 '남은 기간' 개념이 없어 D-Day 고정 대상이 아니다
    d.pinBtn.hidden = !!task.repeat || !task.end;
    d.pinBtn.textContent = task.pinned ? 'D-Day 고정 해제' : 'D-Day에 고정';
    d.pinBtn.classList.toggle('is-on', !!task.pinned);
    d.pinBtn.setAttribute('aria-pressed', String(!!task.pinned));
    d.rowSeries.hidden = d.pinBtn.hidden && d.dropSeries.hidden;
    // 반복 일정은 당일만 — 종료일 입력을 잠근다
    d.endIn.disabled = !task.start || !!task.repeat;
    for (const key of Object.keys(d.swatchBtns)) {
      d.swatchBtns[key].classList.toggle('is-on', task.color === key);
    }
  }

  // ---------------------------------------------------------- 펼침 애니메이션
  //
  // 상세가 툭 튀어나오면 '무엇이 어디서 열렸는지' 를 눈이 따라가지 못한다.
  // 실제 높이를 재서 0 → 제 높이로 자라게 한다(고정 max-height 로 어림잡으면
  // 내용이 짧을 때 뒷부분이 빈 채로 늘어나 어색해진다).
  //
  // 접는 쪽은 애니메이션하지 않는다. 목록이 통째로 다시 그려지는 경로라
  // 사라지는 요소를 붙잡아 두려면 렌더 흐름을 비틀어야 하고, 얻는 것보다 잃는 게 크다.

  const OPEN_MS = 190;

  function playOpen(el) {
    // 사용자가 애니메이션을 원치 않으면(OS 설정) 그대로 둔다
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    if (typeof el.animate !== 'function') return;

    // renderSection 은 항목을 **문서에 넣기 전에** updateItem 을 부른다.
    // 그 시점의 el 은 아직 떨어져 있어 scrollHeight 가 0 이고, 재 보고 시작하면
    // 애니메이션이 조용히 건너뛰어진다. 그래서 일단 0 으로 접어 두고
    // 다음 프레임(=문서에 붙은 뒤)에 실제 높이를 재서 편다.
    el.style.overflow = 'hidden';
    el.style.height = '0px';

    requestAnimationFrame(() => {
      const done = () => { el.style.overflow = ''; el.style.height = ''; };
      if (!el.isConnected) { done(); return; }

      // height:0 이어도 scrollHeight 는 내용의 높이를 돌려준다
      const h = el.scrollHeight;
      if (!h) { done(); return; }

      const anim = el.animate(
        [
          { height: '0px', opacity: 0, transform: 'translateY(-3px)' },
          { height: `${h}px`, opacity: 1, transform: 'none' },
        ],
        { duration: OPEN_MS, easing: 'cubic-bezier(.2,.7,.3,1)' }
      );
      anim.finished.catch(() => {}).finally(done);
    });
  }

  // ---------------------------------------------------------- 제목 편집
  //
  // 상세에 '이름' 칸을 따로 두면 같은 값이 화면에 두 번 나온다(행의 제목 + 폼의 칸).
  // 대신 **펼친 항목의 제목 자체가 입력칸이 된다.** 눈에 보이는 그 글자를 바로 고치는 것이
  // 가장 짧은 길이고, 칸이 하나 늘지도 않는다.
  //
  // 접혀 있을 때는 그냥 글자다 — 그래야 항목을 제목째 잡아 캘린더로 끌 수 있다.

  function setTitleEditable(rec, on, task) {
    const isInput = rec.title.tagName === 'INPUT';
    if (on === isInput) {
      // 이미 원하는 모양이면 값만 맞춘다 (입력 중이면 건드리지 않는다)
      if (isInput) setValueSafe(rec.title, task.title || '');
      else if (rec.title.textContent !== task.title) rec.title.textContent = task.title;
      return;
    }

    if (on) {
      const input = h('input', 'todo-title todo-title--edit');
      input.type = 'text';
      input.value = task.title || '';
      input.spellcheck = false;
      input.placeholder = '일정 이름';
      input.setAttribute('aria-label', '일정 이름');

      const commit = () => {
        const v = input.value.trim();
        const cur = rec.task?.title || '';
        if (!v || v === cur) { input.value = cur; return; }
        store.updateTask(rec.id, { title: v });
      };
      input.addEventListener('change', commit);
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') {
          e.preventDefault();
          input.value = rec.task?.title || '';
          store.setEditing(null);
        }
      });

      rec.title.replaceWith(input);
      rec.title = input;
    } else {
      const span = h('span', 'todo-title');
      span.textContent = task.title || '';
      span.title = task.title || '';
      rec.title.replaceWith(span);
      rec.title = span;
    }
  }

  // ---------------------------------------------------------- 아이템 갱신
  function updateItem(rec, task, selectedDate) {
    rec.task = task;
    const li = rec.el;

    li.classList.toggle('is-done', task.done);
    li.classList.toggle('is-dragging', dragId === task.id);
    li.classList.toggle('todo-item--p1', task.priority === 1);
    li.classList.toggle('todo-item--p2', task.priority === 2);

    rec.check.classList.toggle('is-on', task.done);
    rec.check.textContent = '';
    if (task.done) rec.check.append(icon('check'));
    rec.dot.style.background = COLORS[task.color] || COLORS.blue;

    // 화면에는 체크 표시 하나뿐이라 '완료 토글' 여덟 개가 똑같이 읽혔다.
    // 어떤 일정인지 이름에 넣어 준다.
    const readable = task.title || '제목 없음';
    rec.check.setAttribute('aria-checked', String(!!task.done));
    rec.check.setAttribute('aria-label', `${readable} 완료`);
    rec.del.setAttribute('aria-label',
      task.repeat && task.occDate ? `${readable} 이 회차 건너뛰기` : `${readable} 삭제`);

    // 날짜가 없으면 밀 곳이 없고, 반복 일정은 규칙째 움직이면 안 된다
    const canDefer = !!task.start && !task.repeat;
    rec.defer.hidden = !canDefer;
    if (canDefer) rec.defer.setAttribute('aria-label', `${readable} 내일로 미루기`);

    // 시각 — 있으면 제목 앞
    const hasTime = !!task.startTime;
    rec.time.hidden = !hasTime;
    rec.time.textContent = hasTime ? task.startTime : '';
    if (hasTime) {
      rec.time.title = task.endTime ? `${task.startTime}–${task.endTime}` : task.startTime;
    }

    // 펼친 항목의 제목은 그대로 입력칸이 된다 (아래 상세 영역에서 expanded 를 다시 쓴다)
    if (!rec.titleInput) {
      setTitleEditable(rec, store.getState().editingTaskId === task.id, task);
      if (rec.title.tagName !== 'INPUT') rec.title.title = task.title;
    }

    // 메타(우선순위·태그·D-day) 재구성 — 버튼 포커스 이슈가 없어 통째로 다시 그린다
    const meta = rec.meta;
    meta.textContent = '';
    if (task.priority > 0) {
      const b = h('span', `todo-badge todo-badge--p${task.priority}`, PRIORITY_LABELS[task.priority]);
      meta.append(b);
    }
    for (const tag of task.tags) {
      const c = h('button', 'todo-tag', `#${tag}`);
      c.type = 'button';
      const tagOn = store.getState().filter.tag === tag;
      c.setAttribute('aria-pressed', String(tagOn));
      c.setAttribute('aria-label', tagOn ? `${tag} 태그 필터 끄기` : `${tag} 태그만 보기`);
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = store.getState().filter.tag;
        store.setFilter({ tag: cur === tag ? null : tag });
      });
      meta.append(c);
    }
    // 반복 일정 표시
    if (task.repeat) {
      const rp = h('span', 'todo-repeat');
      rp.append(icon('repeat'));
      const every = task.repeat.interval > 1 ? `${task.repeat.interval}` : '';
      rp.title = `반복: ${every}${store.REPEAT_LABELS[task.repeat.freq] || ''}` +
                 (task.repeat.until ? ` (${task.repeat.until} 까지)` : '');
      meta.append(rp);
    }

    // 알림이 걸린 일정은 종 모양으로 표시 (이미 알린 건 흐리게)
    if (task.remind) {
      const bell = h('span', 'todo-remind');
      bell.append(icon('bell'));
      bell.title = `알림: ${remindLabel(task.remind)}${task.remindedAt ? ' (알림 완료)' : ''}`;
      bell.classList.toggle('is-done', !!task.remindedAt);
      meta.append(bell);
    }

    // 관련 링크 — 클릭하면 기본 브라우저로 열린다
    if (task.link) {
      const lk = h('button', 'todo-link');
      lk.append(icon('link'));
      lk.type = 'button';
      lk.title = `열기: ${linkLabel(task.link)}`;
      lk.addEventListener('click', (e) => {
        e.stopPropagation();   // 항목 상세가 같이 열리지 않도록
        openLink(task.link);
      });
      meta.append(lk);
    }

    // 검색 결과는 여러 달에 흩어져 있다. 제목만 보여 주면 언제 일인지 알 수 없어
    // 눌러 보기 전에는 고를 수가 없다. 날짜를 함께 적는다.
    if (rec.showDate && task.start) {
      const when = h('span', 'todo-when', formatShort(task.start)
        + (task.startTime ? ` ${task.startTime}` : ''));
      when.title = isSpanTask(task)
        ? `${formatShort(task.start)} ~ ${formatShort(task.end)}`
        : formatDateLabel(task.start);
      meta.append(when);
    }

    if (isSpanTask(task)) {
      const left = diffDays(selectedDate, task.end);
      let label;
      if (left > 0) label = `D-${left}`;
      else if (left === 0) label = 'D-day';
      else label = '종료';
      const dd = h('span', 'todo-dday', label);
      dd.title = `${formatShort(task.start)} ~ ${formatShort(task.end)}`;
      meta.append(dd);
    } else if (!task.start) {
      // '언젠가' 항목.
      //
      // 그동안 여기 넣은 일은 잘 나오지 않았다. 날짜를 주려면 캘린더로 끌거나
      // 상세를 펼쳐 날짜칸을 찾아야 했는데, 둘 다 '언젠가' 를 적어 둘 때의
      // 가벼운 마음가짐에 비해 손이 많이 간다. 그래서 넣기만 하고 쌓였다.
      //
      // 꺼내 쓰는 길을 항목 위에 바로 둔다 — 한 번 누르면 그날로 잡힌다.
      const age = daysSince(task.createdAt);
      if (age >= 7) {
        const a = h('span', 'todo-age', ageLabel(age));
        a.title = `${age}일째 날짜가 없습니다`;
        meta.append(a);
      }

      const plan = h('span', 'todo-plan');
      for (const [label, key] of [
        ['오늘', todayKey()],
        ['내일', addDays(todayKey(), 1)],
        ['주말', nextWeekendKey()],
      ]) {
        const b = h('button', 'todo-plan__btn', label);
        b.type = 'button';
        b.setAttribute('aria-label', `'${task.title || '일정'}' 을(를) ${label}로 잡기`);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          store.moveTask(task.id, key);
          store.selectDate(key);
          notify(`'${task.title || '일정'}' 을(를) ${label}로 잡았습니다`);
        });
        plan.append(b);
      }
      meta.append(plan);
    }

    // 상세 영역
    const expanded = store.getState().editingTaskId === task.id;
    li.classList.toggle('is-expanded', expanded);
    if (expanded) {
      if (!rec.detail) buildDetail(rec);
      const justOpened = rec.detail.el.parentNode !== li;
      if (justOpened) li.append(rec.detail.el);
      updateDetail(rec, task);
      // 값을 다 채운 뒤에 펼친다 — 비어 있는 상태로 자랐다가 내용이 튀어나오면 어수선하다
      if (justOpened) playOpen(rec.detail.el);
    } else if (rec.detail && rec.detail.el.parentNode) {
      rec.detail.el.remove();
    }
  }

  // ---------------------------------------------------------- 섹션 갱신
  function renderSection(sec, tasks, selectedDate, emptyFactory) {
    sec.ids = tasks.map((t) => t.id);
    sec.count.textContent = String(tasks.length);
    sec.el.classList.toggle('is-collapsed', sec.collapsed);

    // 캐럿(▾)·제목·개수가 span 이라 이름이 자동으로 잡히지 않는다.
    // 무엇을 몇 건 접고 펴는지 직접 적는다.
    sec.toggle.setAttribute('aria-label',
      `${sec.titleEl.textContent} ${tasks.length}건 ${sec.collapsed ? '펼치기' : '접기'}`);

    const els = [];
    if (!sec.collapsed) {
      for (const task of tasks) {
        const rec = getItem(task.id);
        // 검색·지난 일은 다른 날의 일정이 섞이므로 날짜를 함께 보여 준다
        rec.showDate = sec.key === 'search' || sec.key === 'overdue';
        updateItem(rec, task, selectedDate);
        els.push(rec.el);
      }
    }

    // 순서 맞추기 (기존 노드를 이동시켜 재사용 → 포커스/IME 유지)
    const list = sec.list;
    for (let i = 0; i < els.length; i++) {
      const cur = list.children[i];
      if (cur !== els[i]) list.insertBefore(els[i], cur || null);
    }
    while (list.children.length > els.length) list.removeChild(list.lastChild);

    // 빈 상태
    const showEmpty = !sec.collapsed && tasks.length === 0 && typeof emptyFactory === 'function';
    if (showEmpty) {
      if (!sec.emptyEl) {
        sec.emptyEl = emptyFactory();
        sec.wrap.append(sec.emptyEl);
      }
    } else if (sec.emptyEl) {
      sec.emptyEl.remove();
      sec.emptyEl = null;
    }
  }

  // ---------------------------------------------------------- 빈 상태

  function buildDayEmpty() {
    const box = h('div', 'todo-empty');
    box.append(h('div', 'todo-empty__title', '이 날은 아직 비어 있어요'));
    box.append(h('div', 'todo-empty__desc',
      '약속은 「일정」, 운동처럼 매일 하는 일은 「체크리스트」로 만드세요. '
      + '달력에서 날짜를 옆으로 끌면 기간이 잡힙니다.'));

    const row = h('div', 'todo-empty__ctas');

    const cta = h('button', 'todo-empty__cta', '＋ 일정 추가');
    cta.type = 'button';
    cta.addEventListener('click', () => compose.open());

    const routineCta = h('button', 'todo-empty__cta todo-empty__cta--ghost', '＋ 체크리스트');
    routineCta.type = 'button';
    routineCta.title = '매일·매주 반복하는 일. 달력에는 표시하지 않습니다.';
    routineCta.addEventListener('click', () => compose.open({ routine: true }));

    row.append(cta, routineCta);
    box.append(row);
    return box;
  }

  function buildSearchEmpty() {
    const box = h('div', 'todo-empty todo-empty--slim');
    box.append(h('div', 'todo-empty__desc', '찾는 일정이 없습니다. 다른 낱말로 찾아보세요.'));
    return box;
  }

  function buildInboxEmpty() {
    const box = h('div', 'todo-empty todo-empty--slim');
    box.append(h('div', 'todo-empty__desc',
      '날짜를 정하기 애매한 일을 일단 여기 적어 두세요. '
      + '꺼낼 때는 항목 위의 오늘·내일·주말 버튼을 누르면 그날로 잡힙니다.'));
    return box;
  }

  // ---------------------------------------------------------- 헤더 렌더
  function dayStats(st, key) {
    let total = 0;
    let done = 0;
    for (const t of st.tasks) {
      if (!t.start) continue;
      if (key >= t.start && key <= (t.end || t.start)) {
        total += 1;
        if (t.done) done += 1;
      }
    }
    return { total, done };
  }

  function renderHeader(st) {
    const key = st.selectedDate;
    const isToday = key === todayKey();
    dateLabel.textContent = formatDateLabel(key);
    todayBadge.hidden = !isToday;

    const { total, done } = dayStats(st, key);
    progressText.textContent = `${done}/${total}`;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    progressFill.style.width = `${pct}%`;
    progressBar.classList.toggle('is-full', total > 0 && done === total);

    setValueSafe(searchInput, st.filter.text || '');
    searchInput.classList.toggle('is-on', !!st.filter.text);

    const showCompleted = st.settings.showCompleted;
    completedBtn.textContent = showCompleted ? '완료 표시' : '완료 숨김';
    completedBtn.classList.toggle('is-on', !showCompleted);
    // 눌린 상태 = 숨김. 글자만으로는 스크린리더에 상태가 전달되지 않는다.
    completedBtn.setAttribute('aria-pressed', String(!showCompleted));
    completedBtn.setAttribute('aria-label',
      showCompleted ? '완료 항목 숨기기' : '완료 항목 보이기');

    // 태그 칩 — 내용이 바뀔 때만 다시 그린다
    const tags = store.allTags();
    const sig = `${st.filter.tag || ''}|${tags.join(',')}`;
    if (sig !== lastTagSignature) {
      lastTagSignature = sig;
      tagBar.textContent = '';
      tagBar.hidden = tags.length === 0;
      for (const tag of tags) {
        const chip = h('button', 'todo-tagchip', `#${tag}`);
        chip.type = 'button';
        const on = st.filter.tag === tag;
        chip.classList.toggle('is-on', on);
        chip.setAttribute('aria-pressed', String(on));
        chip.setAttribute('aria-label', on ? `${tag} 태그 필터 끄기` : `${tag} 태그만 보기`);
        chip.addEventListener('click', () => {
          const cur = store.getState().filter.tag;
          store.setFilter({ tag: cur === tag ? null : tag });
        });
        tagBar.append(chip);
      }
    }
  }

  // ---------------------------------------------------------- 키보드 조작
  //
  // 캘린더는 화살표로 움직이는데 오른쪽 목록은 마우스 전용이었다.
  // 캘린더의 키 처리는 캘린더 root 에 걸려 있으므로 서로 가로채지 않는다.

  let focusedId = null;

  function visibleItems() {
    return Array.from(el.querySelectorAll('.todo-item'));
  }

  function focusItem(li) {
    if (!li) return;
    focusedId = li.dataset.id;
    for (const other of visibleItems()) other.tabIndex = other === li ? 0 : -1;
    li.focus();
  }

  /** Tab 으로 들어올 항목 하나를 정해 둔다 (없으면 첫 항목) */
  function syncRovingTabindex() {
    const items = visibleItems();
    if (!items.length) return;
    const active = items.find((li) => li.dataset.id === focusedId) || items[0];
    for (const li of items) li.tabIndex = li === active ? 0 : -1;
  }

  el.addEventListener('focusin', (e) => {
    const li = e.target.closest?.('.todo-item');
    if (li) focusedId = li.dataset.id;
  });

  el.addEventListener('keydown', (e) => {
    if (isFormControl(e.target)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    const items = visibleItems();
    if (!items.length) return;

    const cur = e.target.closest?.('.todo-item');
    const index = cur ? items.indexOf(cur) : -1;

    // --- 이동
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      let next;
      if (e.key === 'Home') next = items[0];
      else if (e.key === 'End') next = items[items.length - 1];
      else if (index < 0) next = items[0];
      else if (e.key === 'ArrowDown') next = items[Math.min(items.length - 1, index + 1)];
      else next = items[Math.max(0, index - 1)];
      focusItem(next);
      return;
    }

    if (!cur) return;
    const task = itemCache.get(cur.dataset.id)?.task;
    if (!task) return;

    // --- 동작
    if (e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      store.toggleDone(task.id, task.occDate);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const editing = store.getState().editingTaskId;
      store.setEditing(editing === task.id ? null : task.id);
      return;
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      e.stopPropagation();
      // 지운 뒤 포커스가 허공에 남지 않도록 다음 항목으로 미리 옮겨 둔다
      const fallback = items[index + 1] || items[index - 1];
      focusedId = fallback ? fallback.dataset.id : null;
      if (store.getState().editingTaskId === task.id) store.setEditing(null);
      store.removeTask(task.id, task.occDate);
      notify(task.repeat && task.occDate ? '이 회차를 건너뜁니다' : '일정을 삭제했습니다');
    }
  });

  // ---------------------------------------------------------- 전체 렌더
  function render() {
    // 캘린더에서 날짜를 끌어 놓으면 그 기간으로 추가 폼을 연다.
    // 모듈끼리 직접 부르지 않고 store 의 요청 큐를 거친다.
    const req = store.getState().composeRequest;
    if (req) {
      store.consumeCompose();
      compose.open(req);
    }

    if (destroyed) return;
    const st = store.getState();
    const key = st.selectedDate;

    renderHeader(st);

    // 검색 중에는 고른 날짜를 무시하고 전체에서 찾는다.
    // 예전에는 '그날 목록 안에서만' 걸러서, 다른 달의 일정은 검색해도 안 나왔다.
    const searching = !!st.filter.text.trim();
    const searchResults = searching ? store.searchTasks(st.filter.text) : [];

    const onDate = searching ? [] : store.tasksOnDate(key);
    const spanTasks = onDate.filter(isSpanTask);
    const dayTasks = onDate.filter((t) => !isSpanTask(t));
    const inboxTasks = searching ? [] : store.inboxTasks();
    const routines = searching ? [] : store.routinesOn(key);

    // 밀린 일은 고른 날짜와 무관하다. 오늘 이전에 끝났어야 하는데 안 끝난 것 전부.
    // 단, 이미 그날 목록에 보이는 항목은 두 번 나오지 않게 뺀다.
    const shown = new Set(onDate.map((t) => t.id));
    const overdue = searching
      ? []
      : store.overdueTasks().filter((t) => !shown.has(t.id));

    sections.search.el.hidden = !searching;
    sections.overdue.titleEl.textContent =
      overdue.length ? `지난 일 · 아직 안 끝났어요` : '지난 일';
    if (searching) {
      sections.search.titleEl.textContent = `'${st.filter.text.trim()}' 검색 결과`;
    }

    // ---- 편집 집중 모드 ----
    //
    // 오른쪽 패널은 좁다. 한 일정을 펼치면 상세가 패널 절반을 먹어서, 나머지 목록은
    // 스크롤 저편으로 밀리고 지금 뭘 고치는 중인지도 흐려진다.
    // 그래서 하나를 펼치면 **나머지는 접는다.** 스크롤로 밀어내지 않고 아예 치운다.
    const editingId = st.editingTaskId;
    const editingTask = editingId ? st.tasks.find((x) => x.id === editingId) : null;
    // 검색 중에는 결과를 계속 보여 줘야 하므로 집중 모드로 들어가지 않는다
    const focusMode = !!editingTask && !searching;

    let focusTasks = [];
    if (focusMode) {
      // 어느 섹션에 있었든, 펼친 하나만 이 자리에서 보여 준다
      const onDateHit = onDate.find((t) => t.id === editingId);
      focusTasks = [onDateHit || editingTask];
    }

    el.classList.toggle('is-focusmode', focusMode);
    sections.focus.el.hidden = !focusMode;
    sections.focus.titleEl.textContent = '고치는 중';

    // 집중 모드에서는 나머지 섹션을 통째로 감춘다
    sections.overdue.el.hidden = focusMode || searching || overdue.length === 0;
    sections.day.el.hidden = focusMode || searching;
    // 비어 있으면 감춘다. 안내 문구만 남은 섹션이 늘 자리를 차지하고 있었다.
    // 없애 버리지는 않는다 — 날짜 없는 일정을 만들면 갈 곳이 있어야 한다.
    sections.inbox.el.hidden = focusMode || searching || inboxTasks.length === 0;
    sections.span.el.hidden = focusMode || searching || spanTasks.length === 0;
    sections.routine.el.hidden = focusMode || searching || routines.length === 0;
    if (routines.length) {
      const done = routines.filter((t) => t.done).length;
      sections.routine.titleEl.textContent =
        done === routines.length ? '체크리스트 · 오늘 다 했어요' : '체크리스트';
    }

    sections.day.titleEl.textContent = key === todayKey() ? '오늘 할 일' : `${formatDateLabel(key)} 할 일`;

    renderSection(sections.search, searchResults, key, searching ? buildSearchEmpty : null);
    renderSection(sections.overdue, focusMode ? [] : overdue, key, null);
    renderSection(sections.focus, focusTasks, key, null);
    renderSection(sections.day, focusMode ? [] : dayTasks, key, buildDayEmpty);
    renderSection(sections.routine, focusMode ? [] : routines, key, null);
    renderSection(sections.span, focusMode ? [] : spanTasks, key, null);
    renderSection(sections.inbox, focusMode ? [] : inboxTasks, key, null);

    // 캐시 정리 — DOM 에서 빠진 아이템 레코드 제거
    for (const [id, rec] of itemCache) {
      if (!rec.el.parentNode) itemCache.delete(id);
    }

    // editingTaskId 가 외부(캘린더)에서 바뀌었으면 해당 항목으로 스크롤
    // 집중 모드에서는 그 항목 하나뿐이라 스크롤할 이유가 없다.
    // 그런데도 scrollIntoView 를 부르면 섹션 머리글('고치는 중 · 목록으로')이
    // 위로 밀려 나가 빠져나갈 길이 화면에서 사라진다.
    if (editingId && editingId !== lastEditingId && !focusMode) {
      const rec = itemCache.get(editingId);
      if (rec && rec.el.parentNode) {
        rec.el.scrollIntoView({ block: 'nearest' });
      }
    }
    lastEditingId = editingId;

    syncRovingTabindex();
    syncAddBar();
  }

  function scheduleRender() {
    if (destroyed || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render();
    });
  }

  // ---------------------------------------------------------- 이벤트 연결
  completedBtn.addEventListener('click', () => {
    store.setSetting('showCompleted', !store.getState().settings.showCompleted);
  });

  /** 검색 줄 열고 닫기. 닫으면 검색어도 비워 목록이 원래대로 돌아온다. */
  function openSearch() {
    filterRow.hidden = false;
    searchBtn.classList.add('is-on');
    searchBtn.setAttribute('aria-expanded', 'true');
    searchInput.focus();
    searchInput.select();
  }
  function closeSearch() {
    filterRow.hidden = true;
    searchBtn.classList.remove('is-on');
    searchBtn.setAttribute('aria-expanded', 'false');
    searchInput.value = '';
    if (store.getState().filter.text) store.setFilter({ text: '' });
  }

  searchBtn.addEventListener('click', () => {
    if (filterRow.hidden) openSearch();
    else closeSearch();
  });
  searchClose.addEventListener('click', closeSearch);

  searchInput.addEventListener('input', () => {
    store.setFilter({ text: searchInput.value });
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  });

  const unsubscribe = store.subscribe(scheduleRender);

  render();

  // ---------------------------------------------------------- 정리
  return {
    destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      clearTimeout(notesTimer);
      pendingNotes = null;
      unsubscribe();
      itemCache.clear();
      root.textContent = '';
    },
  };
}
