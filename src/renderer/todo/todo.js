// 투두 패널 — 오른쪽 면. 캘린더에서 고른 날짜(state.selectedDate)와 연동된다.
// 계약: export function createTodoPanel({ root, store }) -> { destroy() }
// 외부 라이브러리 없음. 순수 ES 모듈 + DOM API. 사용자 입력은 항상 textContent 로만 넣는다.
//
// 오른쪽 면은 시안(핸드오프)의 화면을 갈아 끼운다 — 한 번에 하나만 보인다.
//   오늘      날짜 머리 · 비서의 한 줄 · 지난 일 · 시간표(종일 띠 + 스트립/압축) · 언젠가
//   일정 추가  compose.js
//   루틴      compose.js 의 루틴 모드
//   항목 상세  detail.js
//   설정      app.js (같은 면을 쓴다)
//
// 예전에는 목록 한가운데서 항목을 펼쳐 고쳤다. 좁은 면에서 상세가 절반을 먹으면
// 무엇을 고치는지 흐려져서 '집중 모드' 까지 뒀었다. 시안은 그걸 아예 화면으로 뺐다.

import { todayKey, fromKey, addDays, diffDays, WEEKDAY_LABELS, timeMinutes } from '../lib/date.js';
import { remindLabel } from '../reminders.js';
import { icon } from '../lib/icons.js';
import { createCompose } from './compose.js';
import { createTimetable } from './timetable.js';
import { createDetail } from './detail.js';
import { showContextMenu } from '../lib/menu.js';
import { h, shortDate, openLink, linkLabel } from './ui.js';

const WEEKDAY_FULL = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

/** '9월 3일' */
function monthDayKo(key) {
  const d = fromKey(key);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/** 분 → 'HH:MM' */
function hhmm(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 분을 사람 말로 — '1시간 20분' */
function spanText(m) {
  if (m >= 60) {
    const rest = m % 60;
    return rest ? `${Math.floor(m / 60)}시간 ${rest}분` : `${Math.floor(m / 60)}시간`;
  }
  return `${m}분`;
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

/** '3주째' / '2달째' — 오래 묵은 '언젠가' 를 눈에 띄게 한다 */
function ageLabel(days) {
  if (days < 7) return `${days}일째`;
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

function isFormControl(el) {
  return !!(el && el.closest && el.closest('input, textarea, select'));
}

/** 지금이 몇 분인가 */
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// ============================================================ 패널 팩토리

export function createTodoPanel({ root, store }) {
  const COLORS = store.COLORS;

  const el = h('div', 'todo-panel');

  // ============================================================ 오늘 화면
  const main = h('div', 'todo-main scr');

  // ---------------------------------------------------------------- 날짜 머리
  // 시안: '9월 3일' 명조 20px · '목요일' · [오늘]  ……  [＋ 루틴] [＋ 일정 추가]
  // 일정을 만드는 입구가 여기 있다. 날짜 바로 옆이라 '이 날에 추가한다' 가 읽힌다.
  const head = h('header', 'todo-head');
  const headDate = h('div', 'todo-head__date');
  const dateLabel = h('span', 'todo-head__day');
  const weekLabel = h('span', 'todo-head__week');
  const todayBadge = h('span', 'todo-head__today', '오늘');
  headDate.append(dateLabel, weekLabel, todayBadge);

  const headActs = h('div', 'todo-head__acts');
  const routineBtn = h('button', 'todo-head__btn');
  routineBtn.type = 'button';
  routineBtn.title = '루틴 추가';
  routineBtn.append(icon('plus', 11, 1.6), document.createTextNode('루틴'));
  const addBtn = h('button', 'todo-head__btn todo-head__btn--gold');
  addBtn.type = 'button';
  addBtn.title = '새 일정 (N)';
  addBtn.append(icon('plus', 11, 1.6), document.createTextNode('일정 추가'));
  headActs.append(routineBtn, addBtn);
  head.append(headDate, headActs);

  // ---------------------------------------------------------------- 검색
  // 표지의 돋보기가 연다. 늘 펼쳐 둘 만큼 자주 쓰지 않는다.
  const searchRow = h('div', 'todo-search');
  searchRow.hidden = true;
  const searchInput = h('input', 'todo-search__input');
  searchInput.type = 'text';
  searchInput.placeholder = '전체 일정에서 검색';
  searchInput.spellcheck = false;
  searchInput.setAttribute('aria-label', '전체 일정 검색');
  const searchClose = h('button', 'todo-search__close', '닫기');
  searchClose.type = 'button';
  searchRow.append(icon('searchD', 12, 1.4), searchInput, searchClose);

  // 태그로 걸러 보기 — 검색을 열었거나 태그 필터가 걸려 있을 때만 보인다.
  // 걸러 놓고 그 사실을 감추면 '일정이 사라졌다' 가 된다.
  const tagBar = h('div', 'todo-tagbar');
  tagBar.hidden = true;

  // ---------------------------------------------------------------- 비서의 한 줄
  // 목록은 '무엇이 있는지' 만 말한다. 비서라면 '그래서 오늘이 어떤지' 를 먼저 말해야 한다.
  const aide = h('div', 'todo-aide');
  const aideText = h('span', 'todo-aide__text');
  const aideActs = h('span', 'todo-aide__acts');
  const pickBtn = h('button', 'todo-aide__btn', '지금 할 일');
  pickBtn.type = 'button';
  pickBtn.title = '지금 붙잡을 일 하나를 골라 드립니다';
  pickBtn.setAttribute('aria-pressed', 'false');
  const briefBtn = h('button', 'todo-aide__btn', '브리핑');
  briefBtn.type = 'button';
  briefBtn.addEventListener('click', () => document.dispatchEvent(new CustomEvent('app:brief')));
  aideActs.append(pickBtn, briefBtn);
  aide.append(aideText, aideActs);

  // ---- 「지금 할 일」 ----
  //
  // 할 일 목록은 결국 '골라야 하는 짐' 이다. 열 줄을 훑고 나서야 하나를 고른다.
  // 비서라면 골라 줘야 한다 — 한 번 누르면 하나만 내놓고, 왜 그것인지도 말한다.
  // 고른 것이 마음에 안 들 수 있으니 '다른 거' 로 넘길 수 있게 둔다.
  let pickList = [];
  let pickIdx = 0;
  let pickOpen = false;

  const pick = h('div', 'todo-pick');
  const pickLead = h('div', 'todo-pick__lead num');
  const pickTitle = h('div', 'todo-pick__title');
  const pickWhy = h('div', 'todo-pick__why');
  const pickActs = h('div', 'todo-pick__acts');
  const pickNext = h('button', 'scr-chip', '다른 거');
  const pickGo = h('button', 'scr-chip scr-chip--gold', '이걸 할게요');
  pickNext.type = 'button';
  pickGo.type = 'button';
  pickActs.append(pickNext, pickGo);
  pick.append(pickLead, pickTitle, pickWhy, pickActs);
  pick.hidden = true;

  // ---- 루틴 후보 제안 ----
  //
  // 같은 일을 매번 손으로 새로 적고 있으면 앱이 먼저 알아본다.
  // 물어보고, 아니라고 하면 다시 묻지 않는다.
  let hintNow = null;
  const hint = h('div', 'todo-hint');
  const hintText = h('span', 'todo-hint__text');
  const hintActs = h('span', 'todo-hint__acts');
  const hintNo = h('button', 'scr-chip', '아니요');
  const hintYes = h('button', 'scr-chip scr-chip--gold', '루틴으로');
  hintNo.type = 'button';
  hintYes.type = 'button';
  hintActs.append(hintNo, hintYes);
  hint.append(hintText, hintActs);
  hint.hidden = true;

  hintYes.addEventListener('click', () => {
    if (!hintNow) return;
    const title = hintNow.title;
    store.makeRoutineFromHint(hintNow);
    notify(`'${title}' 을(를) 루틴으로 만들었습니다`);
  });
  hintNo.addEventListener('click', () => {
    if (hintNow) store.hideRoutineHint(hintNow.key);
  });

  // ---------------------------------------------------------------- 목록 섹션
  const body = h('div', 'todo-body');

  const sections = {
    search: makeSection('search', '검색 결과'),
    // 기한이 지났는데 안 끝난 일. 고른 날짜와 무관하게 언제나 위에 온다 —
    // 어제 못 끝낸 일이 어제 칸에 남아 시야에서 사라지는 게 이 앱의 가장 큰 구멍이었다.
    overdue: makeSection('overdue', '지난 일'),
    inbox: makeSection('inbox', '언젠가'),
  };

  // '오늘로 당기기' — 밀린 일을 한 번에 오늘로. 되돌리기 한 번으로 취소된다.
  const rollBtn = h('button', 'todo-section__roll', '오늘로 당기기');
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

  // 언젠가 — 머리의 ＋ 와 목록 끝 점선 줄. 둘 다 날짜 없이 적는 입구다.
  const inboxPlus = h('button', 'todo-section__plus', '＋');
  inboxPlus.type = 'button';
  inboxPlus.title = '날짜 없이 적어 두기';
  inboxPlus.setAttribute('aria-label', '날짜 없이 적어 두기');
  inboxPlus.addEventListener('click', () => compose.open({ someday: true }));
  sections.inbox.actions.append(inboxPlus);

  const inboxAdd = h('button', 'todo-addline');
  inboxAdd.type = 'button';
  inboxAdd.append(h('span', 'todo-addline__plus', '＋'),
    h('span', 'todo-addline__text', '날짜 없이 적어 두기 — 나중에 오늘·내일로 끌어옵니다'));
  inboxAdd.addEventListener('click', () => compose.open({ someday: true }));
  sections.inbox.el.append(inboxAdd);

  // ---- 마감 역산 ----
  //
  // 시험이 12일 뒤라는 걸 알아도, 오늘 뭘 해야 하는지는 여전히 사람이 계산해야 했다.
  // 마감에서 거꾸로 짚어 '오늘부터 마감 전날까지' 하루하루 체크할 칸을 만들어 준다.
  // 새 폼을 따로 만들지 않고 추가 화면을 미리 채워 연다 — 되읽어 주는 그 줄이
  // 역산 결과를 그대로 말한다('9월 3일 → 9월 13일 · 11일간 · 매일 체크 (11칸)').
  function planFor(t) {
    if (!store.canPlanDeadline(t)) return;
    const today = todayKey();
    // 마감 당일은 그 일을 하는 날이다. 준비는 전날까지.
    const end = addDays(t.end || t.start, -1);
    store.setEditing(null);
    compose.open({
      start: today,
      end,
      title: `${t.title} 준비`,
      dailyCheck: true,
      color: t.color,
      tags: t.tags,
    });
  }

  // D-Day 카드에서도 같은 계획을 세울 수 있다 — 마감이 사는 자리가 거기라서.
  document.addEventListener('app:plan-deadline', (e) => {
    planFor(store.getState().tasks.find((t) => t.id === e.detail));
  });

  // ---------------------------------------------------------------- 화면 조립
  const compose = createCompose({ store, onToggle: () => scheduleRender() });
  const detail = createDetail({ store, onPlan: planFor, notify });

  // 오늘 시간표 — 하루의 '모양' 을 맡는다.
  // 목록은 무엇이 있는지는 알려 줘도, 그 앞이 비었는지 붙어 있는지는 말해 주지 않았다.
  const timetable = createTimetable({
    store,
    onDetail: (id) => store.setEditing(id),
    onAdd: () => {
      // '시각 있는 일정 추가' — 오늘이면 다음 정각, 다른 날이면 아침 9시로 채워 연다
      const key = store.getState().selectedDate;
      const startTime = key === todayKey()
        ? hhmm(Math.min(23 * 60, (Math.floor(nowMinutes() / 60) + 1) * 60))
        : '09:00';
      compose.open({ start: key, end: key, startTime });
    },
    onAddAllDay: () => {
      const key = store.getState().selectedDate;
      compose.open({ start: key, end: key });
    },
  });

  // 목록의 항목을 시간표로 끌어다 놓으면 고른 날짜로 옮긴다
  timetable.el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('application/x-task-id')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    timetable.el.classList.add('is-drop');
  });
  timetable.el.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && timetable.el.contains(e.relatedTarget)) return;
    timetable.el.classList.remove('is-drop');
  });
  timetable.el.addEventListener('drop', (e) => {
    timetable.el.classList.remove('is-drop');
    const id = e.dataTransfer?.getData('application/x-task-id');
    if (!id) return;
    e.preventDefault();
    store.moveTask(id, store.getState().selectedDate);
  });

  body.append(sections.search.el, sections.overdue.el, timetable.el, sections.inbox.el);
  main.append(head, searchRow, tagBar, aide, pick, hint, body);
  el.append(main, compose.el, detail.el);
  root.append(el);

  addBtn.addEventListener('click', () => {
    store.setEditing(null);
    compose.open();
  });
  routineBtn.addEventListener('click', () => {
    store.setEditing(null);
    compose.open({ routine: true });
  });

  // 책갈피 탭 · 표지 버튼이 부르는 것들. 탭은 화면을 새로 만들지 않고 이미 있는 입구를 연다.
  document.addEventListener('app:close-compose', () => compose.close());
  document.addEventListener('app:new-routine', () => {
    store.setEditing(null);
    compose.open({ routine: true });
  });
  document.addEventListener('app:search', () => {
    compose.close();
    store.setEditing(null);
    if (searchRow.hidden) openSearch();
    else closeSearch();
  });

  // N — 새 일정. 입력 중이거나 다른 화면이 떠 있으면 가로채지 않는다.
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyN' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (isFormControl(document.activeElement) || e.isComposing) return;
    if (main.hidden || root.classList.contains('is-settings')) return;
    if (document.querySelector('.brief-scrim, .help, .tt-peek:not([hidden])')) return;
    e.preventDefault();
    compose.open();
  });

  // ---------------------------------------------------------------- 로컬 UI 상태
  const itemCache = new Map();   // taskId -> 아이템 레코드 (DOM 재사용 → 포커스/조합 보존)
  let inlineEditId = null;       // 제목 인라인 편집 중인 태스크 id
  let rafId = 0;
  let destroyed = false;
  let dragId = null;             // 현재 드래그 중인 태스크 id
  let lastTagSignature = '';
  let lastScreen = '';

  // ---------------------------------------------------------- 섹션 생성기
  function makeSection(key, title) {
    const secEl = h('section', `todo-section todo-section--${key}`);
    secEl.dataset.section = key;

    const head = h('div', 'todo-section__head');
    const titleWrap = h('span', 'todo-section__name');
    const titleEl = h('span', 'todo-section__title', title);
    const count = h('span', 'todo-section__count num', '0');
    titleWrap.append(titleEl, count);
    const rule = h('span', 'todo-section__rule');
    // 섹션마다 붙는 동작 버튼 자리(예: 지난 일의 '오늘로 당기기'). 기본은 비어 있다.
    const actions = h('span', 'todo-section__actions');
    head.append(titleWrap, rule, actions);

    const wrap = h('div', 'todo-list-wrap');
    const list = h('ul', 'todo-list');
    const dropline = h('div', 'todo-dropline');
    wrap.append(list, dropline);

    secEl.append(head, wrap);

    const sec = { key, el: secEl, head, list, wrap, dropline, count, titleEl, actions,
                  ids: [], emptyEl: null };

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
    const inSection = sec.ids.includes(id);

    if (!inSection) {
      // 다른 자리 → 언젠가로 옮기면 날짜를 걷어낸다
      if (sec.key === 'inbox') store.updateTask(id, { start: null, end: null });
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
  //
  // 지난 일 · 언젠가 · 검색 결과의 한 줄. 시안:
  //   지난 일  [□] 9/1 (화)  세금계산서 발행      #경리
  //   언젠가   포트폴리오 사이트 손보기 [3주째]    [오늘][내일][주말]
  // 내일로 미루기 · 삭제는 줄에 커서를 올렸을 때만 오른쪽 끝에 뜬다.
  function createItem(taskId) {
    const li = h('li', 'todo-item');
    li.dataset.id = taskId;
    li.draggable = true;
    // 로빙 탭인덱스 — 목록 전체가 아니라 '현재 항목' 하나만 Tab 으로 들어온다.
    li.tabIndex = -1;

    const row = h('div', 'todo-item__row');

    // 체크는 시각적으로 버튼이지만 하는 일은 체크박스다.
    const check = h('button', 'todo-check');
    check.type = 'button';
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', 'false');

    const when = h('span', 'todo-when num');
    const title = h('span', 'todo-title');
    const meta = h('span', 'todo-meta');

    const acts = h('span', 'todo-acts');
    // 내일로 미루기 — 오늘 못 할 일을 미는 건 매일 하는 동작이라 손 닿는 곳에 둔다.
    const defer = h('button', 'todo-act', '내일로');
    defer.type = 'button';
    const del = h('button', 'todo-act todo-act--seal', '삭제');
    del.type = 'button';
    acts.append(defer, del);

    row.append(check, when, title, meta, acts);
    li.append(row);

    const rec = { id: taskId, el: li, row, check, when, title, meta, defer, del, task: null };

    check.addEventListener('click', (e) => {
      e.stopPropagation();
      // 반복 일정은 '이 회차'만 완료 처리한다
      store.toggleDone(taskId, rec.task?.occDate);
    });

    defer.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = rec.task;
      if (!t || !t.start || t.repeat) return;
      // 지난 일을 '내일로' 밀면 어제의 내일(=오늘)이 아니라 진짜 내일로 간다
      const base = t.start < todayKey() ? todayKey() : t.start;
      store.moveTask(t.id, addDays(base, 1));
      notify(`'${t.title || '일정'}' 을(를) 내일로 미뤘습니다`);
    });

    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (store.getState().editingTaskId === taskId) store.setEditing(null);
      store.removeTask(taskId, rec.task?.occDate);
    });

    // 우클릭 메뉴 — 자주 쓰는 동작을 손 가까이에 둔다
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const t = rec.task;
      if (!t) return;
      showContextMenu(e.clientX, e.clientY, [
        {
          label: t.done ? '완료 취소' : '완료로 표시',
          onSelect: () => store.toggleDone(t.id, t.occDate),
        },
        { label: '자세히 · 고치기', onSelect: () => store.setEditing(t.id) },
        { separator: true },
        {
          // 반복 일정은 규칙 하나를 공유하므로 한 회차만 밀 수 없다.
          label: '내일로 미루기',
          disabled: !t.start || !!t.repeat,
          onSelect: () => store.moveTask(t.id, addDays(t.start < todayKey() ? todayKey() : t.start, 1)),
        },
        {
          label: '마감까지 계획 세우기',
          disabled: !store.canPlanDeadline(t),
          onSelect: () => planFor(t),
        },
        {
          // 미룬 일을 계속 내일로 미는 대신 꺼내 놓을 자리를 준다
          label: '「언젠가」로 보내기',
          disabled: !t.start || !!t.repeat,
          onSelect: () => store.updateTask(t.id, { start: null, end: null }),
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

    // 클릭 → 항목 상세.
    // 제목 위 클릭은 더블클릭(인라인 편집)일 수 있으므로 잠깐 미뤘다가 실행한다.
    let clickTimer = null;
    const openDetail = () => {
      if (destroyed) return;
      const t = rec.task;
      store.setEditing(taskId);
      // 상세를 열 때 달력도 그 날로 옮긴다 — 지난 일은 다른 달의 일정일 수 있다
      if (t?.start) {
        const target = t.occDate || t.start;
        if (target !== store.getState().selectedDate) store.selectDate(target);
      }
    };
    li.addEventListener('click', (e) => {
      if (e.target.closest('.todo-check, .todo-act, .todo-plan, .todo-tag, .todo-link')) return;
      if (e.target.closest('.todo-title-input')) return;
      if (e.detail > 1) return;   // 더블클릭의 두 번째 클릭 무시
      if (e.target.closest('.todo-title')) {
        clearTimeout(clickTimer);
        clickTimer = setTimeout(openDetail, 200);
      } else {
        openDetail();
      }
    });

    // 제목 더블클릭 → 그 자리에서 이름만 고치기
    li.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.todo-title')) return;
      if (e.target.closest('.todo-title-input')) return;
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
      timetable.el.classList.remove('is-drop');
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
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
    });
    input.addEventListener('blur', () => close(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  // ---------------------------------------------------------- 아이템 갱신
  function updateItem(rec, task, sectionKey) {
    rec.task = task;
    const li = rec.el;

    li.classList.toggle('is-done', !!task.done);
    li.classList.toggle('is-dragging', dragId === task.id);
    li.classList.toggle('is-important', task.priority >= 1);
    rec.check.classList.toggle('is-on', !!task.done);
    rec.check.textContent = '';
    if (task.done) rec.check.append(icon('check', 9, 1.6));
    li.style.setProperty('--item', COLORS[task.color] || COLORS.blue);

    const readable = task.title || '제목 없음';
    rec.check.setAttribute('aria-checked', String(!!task.done));
    rec.check.setAttribute('aria-label', `${readable} 완료`);
    rec.del.setAttribute('aria-label',
      task.repeat && task.occDate ? `${readable} 이 회차 건너뛰기` : `${readable} 삭제`);
    rec.del.textContent = task.repeat && task.occDate ? '건너뛰기' : '삭제';

    // 날짜가 없으면 밀 곳이 없고, 반복 일정은 규칙째 움직이면 안 된다
    const canDefer = !!task.start && !task.repeat;
    rec.defer.hidden = !canDefer;
    if (canDefer) rec.defer.setAttribute('aria-label', `${readable} 내일로 미루기`);

    // 날짜 칸 — 지난 일 · 검색 결과는 다른 날의 일정이라 언제인지 먼저 보여야 고를 수 있다
    const showWhen = sectionKey !== 'inbox' && !!task.start;
    rec.when.hidden = !showWhen;
    if (showWhen) {
      const key = sectionKey === 'overdue' ? (task.end || task.start) : task.start;
      rec.when.textContent = shortDate(key)
        + (sectionKey === 'search' && task.startTime ? ` ${task.startTime}` : '');
    }

    if (!rec.titleInput) {
      if (rec.title.textContent !== task.title) rec.title.textContent = task.title;
      rec.title.title = task.title;
    }

    // 메타 — 시안은 오른쪽에 조용한 태그 글자 하나. 나머지는 필요할 때만 붙는다.
    const meta = rec.meta;
    meta.textContent = '';
    if (task.priority > 0) {
      meta.append(h('span', 'todo-bang num', task.priority >= 2 ? '!!' : '!'));
    }
    for (const tag of task.tags) {
      const c = h('button', 'todo-tag', `#${tag}`);
      c.type = 'button';
      const tagOn = store.getState().filter.tag === tag;
      c.classList.toggle('is-on', tagOn);
      c.setAttribute('aria-pressed', String(tagOn));
      c.setAttribute('aria-label', tagOn ? `${tag} 태그 필터 끄기` : `${tag} 태그만 보기`);
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = store.getState().filter.tag;
        store.setFilter({ tag: cur === tag ? null : tag });
      });
      meta.append(c);
    }

    // 세 번 넘게 민 일 — '안 할 일' 이거나 '너무 큰 일' 이다. 조용히 알려만 준다.
    if (!task.repeat && task.deferCount >= 3) {
      const dc = h('span', 'todo-defers', `${task.deferCount}번 미룸`);
      dc.title = '오늘 할 일에서 뒤로 민 횟수입니다. 쪼개거나 「언젠가」로 옮겨 보세요.';
      meta.append(dc);
    }

    if (task.remind && sectionKey !== 'inbox') {
      const bell = h('span', 'todo-remind');
      bell.append(icon('bellD', 11, 1.4));
      bell.title = `알림: ${remindLabel(task.remind)}${task.remindedAt ? ' (알림 완료)' : ''}`;
      meta.append(bell);
    }

    if (task.link) {
      const lk = h('button', 'todo-link');
      lk.append(icon('link', 11, 1.6));
      lk.type = 'button';
      lk.title = `열기: ${linkLabel(task.link)}`;
      lk.addEventListener('click', (e) => {
        e.stopPropagation();   // 상세가 같이 열리지 않도록
        openLink(task.link);
      });
      meta.append(lk);
    }

    if (sectionKey === 'inbox') {
      // '언젠가' 항목.
      //
      // 그동안 여기 넣은 일은 잘 나오지 않았다. 날짜를 주려면 캘린더로 끌거나
      // 상세를 펼쳐 날짜칸을 찾아야 했는데, 둘 다 '언젠가' 를 적어 둘 때의
      // 가벼운 마음가짐에 비해 손이 많이 간다. 꺼내 쓰는 길을 줄 위에 바로 둔다.
      const age = daysSince(task.createdAt);
      if (age >= 1) {
        const a = h('span', 'todo-age num', ageLabel(age));
        a.title = `${age}일째 날짜가 없습니다`;
        rec.title.after(a);
        rec.age?.remove();
        rec.age = a;
      } else {
        rec.age?.remove();
        rec.age = null;
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
    } else {
      rec.age?.remove();
      rec.age = null;
    }
  }

  // ---------------------------------------------------------- 섹션 갱신
  function renderSection(sec, tasks, emptyFactory) {
    sec.ids = tasks.map((t) => t.id);
    sec.count.textContent = String(tasks.length);

    const els = [];
    for (const task of tasks) {
      const rec = getItem(task.id);
      updateItem(rec, task, sec.key);
      els.push(rec.el);
    }

    // 순서 맞추기 (기존 노드를 이동시켜 재사용 → 포커스/IME 유지)
    const list = sec.list;
    for (let i = 0; i < els.length; i++) {
      const cur = list.children[i];
      if (cur !== els[i]) list.insertBefore(els[i], cur || null);
    }
    while (list.children.length > els.length) list.removeChild(list.lastChild);

    const showEmpty = tasks.length === 0 && typeof emptyFactory === 'function';
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

  function buildSearchEmpty() {
    return h('div', 'todo-empty', '찾는 일정이 없습니다. 다른 낱말로 찾아보세요.');
  }

  // ---------------------------------------------------------- 머리 · 비서의 한 줄
  function renderHead(st) {
    const key = st.selectedDate;
    const d = fromKey(key);
    dateLabel.textContent = monthDayKo(key);
    weekLabel.textContent = WEEKDAY_FULL[d.getDay()];
    todayBadge.hidden = key !== todayKey();
  }

  /** 문장 안의 강조 조각 */
  const seal = (text) => h('span', 'todo-aide__seal', text);
  const num = (text) => h('span', 'num', text);

  /**
   * 비서의 한 줄. 시안: '밀린 일 2건부터 치우시면 오늘 5건은 넉넉합니다.
   * 다음 일정은 15:00 클라이언트 미팅.'
   *
   * 넉넉한지는 어림으로 잰다 — 지금부터 밤 10시까지 비어 있는 시간이
   * 시각 없는 일 하나에 30분씩 잡아 모자라지 않으면 넉넉하다.
   */
  function renderAide(st, overdue) {
    const key = st.selectedDate;
    const today = todayKey();
    const onDate = [...store.tasksOnDate(key), ...store.routinesOn(key)];
    const undone = onDate.filter((t) => !t.done);
    const parts = [];

    if (key === today) {
      const now = nowMinutes();
      const A = overdue.length;
      const M = undone.length;

      // 남은 시각 일정이 차지하는 시간과, 시각 없는 일에 들 시간
      const timed = undone
        .filter((t) => t.startTime)
        .map((t) => {
          const s = timeMinutes(t.startTime);
          const e = t.endTime ? timeMinutes(t.endTime) : s + 60;
          return { t, s, e: e > s ? e : s + 60 };
        })
        .sort((a, b) => a.s - b.s);
      const busy = timed.reduce((sum, x) => sum + Math.max(0, x.e - Math.max(x.s, now)), 0);
      const free = Math.max(0, 22 * 60 - now) - busy;
      const need = (undone.filter((t) => !t.startTime).length + A) * 30;
      const roomy = free >= need;

      if (A > 0 && M > 0) {
        if (roomy) parts.push('밀린 일 ', seal(`${A}건`), `부터 치우시면 오늘 ${M}건은 넉넉합니다.`);
        else parts.push('밀린 일 ', seal(`${A}건`), `이 남아 있어 오늘 ${M}건은 빠듯합니다.`);
      } else if (A > 0) {
        parts.push('오늘 몫은 없고, 밀린 일 ', seal(`${A}건`), '이 남아 있습니다.');
      } else if (M > 0) {
        parts.push(`오늘 ${M}건이 남았습니다.`);
      } else if (onDate.length) {
        parts.push('오늘 몫은 다 하셨습니다.');
      } else {
        parts.push('오늘은 잡힌 일이 없습니다.');
      }

      const running = timed.find((x) => x.s <= now && now < x.e);
      const next = timed.find((x) => x.s > now);
      if (running) {
        parts.push(' 지금은 ', running.t.title || '일정', ' 시간입니다.');
      } else if (next) {
        parts.push(' 다음 일정은 ', num(hhmm(next.s)), ` ${next.t.title || '일정'}.`);
      }
    } else if (key > today) {
      const timed = onDate.filter((t) => t.startTime)
        .sort((a, b) => timeMinutes(a.startTime) - timeMinutes(b.startTime));
      if (onDate.length) {
        parts.push(`${monthDayKo(key)}에는 ${onDate.length}건이 잡혀 있습니다.`);
        if (timed.length) {
          parts.push(' 첫 일정은 ', num(timed[0].startTime), ` ${timed[0].title || '일정'}.`);
        }
      } else {
        parts.push(`${monthDayKo(key)}은 비어 있습니다.`);
      }
    } else if (onDate.length) {
      const done = onDate.length - undone.length;
      parts.push(`${monthDayKo(key)}에는 ${onDate.length}건 중 ${done}건을 끝냈습니다.`);
    } else {
      parts.push(`${monthDayKo(key)}에는 잡힌 일이 없었습니다.`);
    }

    aideText.replaceChildren(...parts);
  }

  /** '왜 이것인가' 를 한 줄로. store 는 종류만 주고 문장은 여기서 만든다. */
  function pickWhyText({ kind, at, task }) {
    if (kind === 'now') return `지금 ${at} 시간입니다`;
    if (kind === 'soon') return `${at} 시작 — 곧입니다`;
    if (kind === 'overdue') {
      const days = Math.max(1, diffDays(task.start, todayKey()));
      return `${shortDate(task.start)}부터 ${days}일째 밀려 있습니다`;
    }
    if (kind === 'check') return '오늘 아직 체크하지 않으셨습니다';
    if (task.priority >= 2) return '오늘 몫 중 가장 급합니다';
    if (task.deferCount >= 3) return `${task.deferCount}번 미루신 일입니다`;
    return '오늘 몫입니다';
  }

  function renderPick() {
    const cur = pickList[pickIdx];
    if (!cur) {
      pickTitle.textContent = '지금 붙잡을 일이 없습니다';
      pickWhy.textContent = '오늘 몫은 다 하셨습니다.';
      pickActs.hidden = true;
      return;
    }
    pickActs.hidden = false;
    pickNext.hidden = pickList.length < 2;
    pickTitle.textContent = cur.task.title || '(제목 없음)';
    pickWhy.textContent = pickWhyText(cur);
  }

  pickBtn.addEventListener('click', () => {
    pickOpen = !pickOpen;
    pickIdx = 0;
    render();
  });
  pickNext.addEventListener('click', () => {
    if (pickList.length) pickIdx = (pickIdx + 1) % pickList.length;
    renderPick();
  });
  pickGo.addEventListener('click', () => {
    const cur = pickList[pickIdx];
    if (!cur) return;
    pickOpen = false;
    store.setEditing(cur.task.id);
  });

  function renderTagBar(st) {
    const tags = store.allTags();
    const show = (!searchRow.hidden || !!st.filter.tag) && tags.length > 0;
    tagBar.hidden = !show;
    const sig = `${show}|${st.filter.tag || ''}|${tags.join(',')}`;
    if (sig === lastTagSignature) return;
    lastTagSignature = sig;
    tagBar.textContent = '';
    for (const tag of tags) {
      const chip = h('button', 'scr-chip scr-chip--tag', `#${tag}`);
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

  // ---------------------------------------------------------- 키보드 조작
  //
  // 캘린더는 화살표로 움직이는데 오른쪽 목록은 마우스 전용이었다.
  let focusedId = null;

  function visibleItems() {
    return Array.from(main.querySelectorAll('.todo-item'));
  }

  function focusItem(li) {
    if (!li) return;
    focusedId = li.dataset.id;
    for (const other of visibleItems()) other.tabIndex = other === li ? 0 : -1;
    li.focus();
  }

  function syncRovingTabindex() {
    const items = visibleItems();
    if (!items.length) return;
    const active = items.find((li) => li.dataset.id === focusedId) || items[0];
    for (const li of items) li.tabIndex = li === active ? 0 : -1;
  }

  main.addEventListener('focusin', (e) => {
    const li = e.target.closest?.('.todo-item');
    if (li) focusedId = li.dataset.id;
  });

  main.addEventListener('keydown', (e) => {
    if (isFormControl(e.target)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    const items = visibleItems();
    if (!items.length) return;

    const cur = e.target.closest?.('.todo-item');
    const index = cur ? items.indexOf(cur) : -1;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      if (!cur) return;   // 목록 밖(버튼 등)에서는 캘린더 화살표를 빼앗지 않는다
      e.preventDefault();
      e.stopPropagation();
      let next;
      if (e.key === 'Home') next = items[0];
      else if (e.key === 'End') next = items[items.length - 1];
      else if (e.key === 'ArrowDown') next = items[Math.min(items.length - 1, index + 1)];
      else next = items[Math.max(0, index - 1)];
      focusItem(next);
      return;
    }

    if (!cur) return;
    const task = itemCache.get(cur.dataset.id)?.task;
    if (!task) return;

    if (e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      store.toggleDone(task.id, task.occDate);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      store.setEditing(task.id);
      return;
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      e.stopPropagation();
      const fallback = items[index + 1] || items[index - 1];
      focusedId = fallback ? fallback.dataset.id : null;
      store.removeTask(task.id, task.occDate);
      notify(task.repeat && task.occDate ? '이 회차를 건너뜁니다' : '일정을 삭제했습니다');
    }
  });

  // ---------------------------------------------------------- 화면 고르기
  /**
   * 지금 어느 화면인가. 추가 화면이 열려 있으면 그쪽이, 고치는 항목이 있으면 상세가 앞에 온다.
   * 책갈피 탭이 따라가도록 바뀔 때마다 알린다.
   */
  function syncScreen(editingTask) {
    let screen = 'main';
    if (compose.isOpen()) screen = compose.mode();
    else if (editingTask) screen = 'detail';

    main.hidden = screen !== 'main';
    detail.el.hidden = screen !== 'detail';
    if (screen !== lastScreen) {
      // 화면이 바뀌면 맨 위부터 보인다 — 긴 목록 중간에서 상세가 열리면 머리가 안 보인다
      el.scrollTop = 0;
      if (lastScreen === 'detail') detail.flush();
      lastScreen = screen;
      document.dispatchEvent(new CustomEvent('app:screen', { detail: screen }));
    }
  }

  // ---------------------------------------------------------- 전체 렌더
  function render() {
    // 캘린더에서 날짜를 끌어 놓으면 그 기간으로 추가 화면을 연다.
    // 모듈끼리 직접 부르지 않고 store 의 요청 큐를 거친다.
    const req = store.getState().composeRequest;
    if (req) {
      store.consumeCompose();
      store.setEditing(null);
      compose.open(req);
    }

    if (destroyed) return;
    const st = store.getState();
    const key = st.selectedDate;

    // 고치는 항목 — 반복 회차면 그날치 사본을 쓴다(완료 · 건너뛰기가 그 회차에 걸리도록)
    const editingId = st.editingTaskId;
    const raw = editingId ? st.tasks.find((x) => x.id === editingId) : null;
    let editingTask = null;
    if (raw) {
      const onDay = [...store.tasksOnDate(key, { filtered: false }),
                     ...store.routinesOn(key, { filtered: false })];
      editingTask = onDay.find((t) => t.id === editingId) || raw;
    }
    // 상세를 열면 추가 화면은 닫는다 — 한 번에 한 화면
    if (editingTask && compose.isOpen()) compose.close();

    syncScreen(editingTask);
    if (editingTask) detail.update(editingTask);

    renderHead(st);
    renderTagBar(st);

    // 검색 중에는 고른 날짜를 무시하고 전체에서 찾는다.
    const searching = !!st.filter.text.trim();
    const searchResults = searching ? store.searchTasks(st.filter.text) : [];

    const overdue = store.overdueTasks();
    const inboxTasks = store.inboxTasks();

    sections.search.el.hidden = !searching;
    if (searching) sections.search.titleEl.textContent = `'${st.filter.text.trim()}' 검색 결과`;
    sections.overdue.el.hidden = searching || overdue.length === 0;
    timetable.el.hidden = searching;
    sections.inbox.el.hidden = searching;
    aide.hidden = searching;
    if (!searching) {
      timetable.update(key, addDays(key, 1));
      renderAide(st, overdue);
    }

    // 「지금 할 일」 — 오늘이 아닌 날에는 '지금' 이 뜻을 잃으므로 버튼째 감춘다
    const canPick = key === todayKey() && !searching;
    if (!canPick) pickOpen = false;
    pickBtn.hidden = !canPick;
    pickBtn.classList.toggle('is-on', pickOpen);
    pickBtn.setAttribute('aria-pressed', String(pickOpen));
    pick.hidden = !pickOpen;
    if (pickOpen) {
      const res = store.pickNow(key);
      pickList = res.list;
      if (pickIdx >= pickList.length) pickIdx = 0;
      const free = res.freeMinutes;
      pickLead.textContent = free == null
        ? `지금 ${hhmm(nowMinutes())} · 남은 시각 일정 없음`
        : `지금 ${hhmm(nowMinutes())} · 다음 일정까지 ${spanText(free)}`;
      renderPick();
    } else {
      pickList = [];
    }

    // 되풀이해 적어 온 일이 있으면 루틴으로 만들자고 한 줄 권한다.
    // 검색 중에는 말을 걸지 않는다 — 지금 하려던 일을 방해한다.
    hintNow = searching ? null : (store.routineSuggestions(1)[0] || null);
    hint.hidden = !hintNow;
    if (hintNow) {
      hintText.replaceChildren(
        `「${hintNow.title}」 · 최근 ${hintNow.count}번 적으셨습니다 — `,
        h('span', 'todo-hint__em', `${store.repeatLabel(hintNow.repeat)} 루틴`),
        '으로 만들까요?',
      );
    }

    renderSection(sections.search, searchResults, searching ? buildSearchEmpty : null);
    renderSection(sections.overdue, searching ? [] : overdue, null);
    renderSection(sections.inbox, searching ? [] : inboxTasks, null);

    // 캐시 정리 — DOM 에서 빠진 아이템 레코드 제거
    for (const [id, rec] of itemCache) {
      if (!rec.el.parentNode) itemCache.delete(id);
    }

    syncRovingTabindex();
  }

  function scheduleRender() {
    if (destroyed || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render();
    });
  }

  // ---------------------------------------------------------- 검색
  /** 검색 줄 열고 닫기. 닫으면 검색어도 비워 목록이 원래대로 돌아온다. */
  function openSearch() {
    searchRow.hidden = false;
    searchInput.focus();
    searchInput.select();
    document.getElementById('btn-search')?.classList.add('is-active');
    scheduleRender();
  }
  function closeSearch() {
    searchRow.hidden = true;
    searchInput.value = '';
    document.getElementById('btn-search')?.classList.remove('is-active');
    if (store.getState().filter.text) store.setFilter({ text: '' });
    else scheduleRender();
  }

  searchClose.addEventListener('click', closeSearch);
  searchInput.addEventListener('input', () => {
    store.setFilter({ text: searchInput.value });
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); }
  });

  const unsubscribe = store.subscribe(scheduleRender);

  render();

  // ---------------------------------------------------------- 정리
  return {
    destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      detail.flush();
      unsubscribe();
      itemCache.clear();
      root.textContent = '';
    },
  };
}
