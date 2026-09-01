// 캘린더 패널.
// 월(月) 6주 42칸 그리드 + 장기 계획 가로 막대(주 행을 가로지름) + 단일 일정 점.
// 상태는 store 액션으로만 바꾼다. root 안에만 그린다.

import * as date from '../lib/date.js';
import { icon } from '../lib/icons.js';
import { showContextMenu } from '../lib/menu.js';
import { isPublicHoliday, shortName, fullLabel } from '../lib/holidays.js';

/** 레인이 하나도 안 들어갈 때의 최소값 */
const MIN_LANES = 1;
/** 칸 하단 점 표시 최대 개수 */
const MAX_DOTS = 4;

/**
 * 캘린더 팩토리.
 * @param {{ root: HTMLElement, store: object }} opts
 * @returns {{ destroy(): void }}
 */
export function createCalendar({ root, store }) {
  const els = buildSkeleton(root);

  let rafId = 0;
  let destroyed = false;

  // ---------------------------------------------------------------- 렌더 예약
  // subscribe 콜백마다 즉시 그리면 드래그 중 깜빡이므로 rAF 로 병합한다.
  function schedule() {
    if (destroyed || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render();
    });
  }

  // ---------------------------------------------------------------- 렌더
  function render() {
    const st = store.getState();
    const anchor = st.anchorMonth || date.todayKey();
    // 주간 뷰는 7칸만 쓴다. 남는 행·칸은 숨겨서 뼈대를 그대로 재사용한다.
    const weekView = st.settings.calendarView === 'week';
    const keys = weekView ? date.weekGrid(st.selectedDate || anchor) : date.monthGrid(anchor);
    const weekCount = weekView ? 1 : 6;
    els.root.classList.toggle('cal-root--week', weekView);
    els.viewBtn.textContent = weekView ? '월간' : '주간';
    els.viewBtn.setAttribute('aria-label',
      weekView ? '주간 보기 (누르면 월간)' : '월간 보기 (누르면 주간)');
    const today = date.todayKey();
    const selected = st.selectedDate;
    const showHolidays = st.settings.showHolidays !== false;

    // 화면에 걸친 해를 확보한다. 월 그리드는 앞뒤 달을 물고 있어 연말연시에 두 해가 겹친다.
    if (showHolidays && keys.length) {
      const years = new Set([Number(keys[0].slice(0, 4)), Number(keys[keys.length - 1].slice(0, 4))]);
      store.ensureHolidays([...years]);
    }

    els.title.textContent = weekView
      ? weekTitle(keys)
      : date.monthLabel(anchor);

    // --- 날짜 칸 갱신 (뼈대는 재사용, 내용만 교체) ---
    for (let w = 0; w < 6; w++) els.weekRows[w].hidden = w >= weekCount;

    for (let i = 0; i < 42; i++) {
      const cell = els.cells[i];
      if (i >= keys.length) { cell.hidden = true; continue; }
      cell.hidden = false;
      const key = keys[i];

      cell.dataset.key = key;
      cell.classList.toggle('cal-day--out', !date.sameMonth(key, anchor));
      cell.classList.toggle('cal-day--today', key === today);
      cell.classList.toggle('cal-day--sel', key === selected);

      cell.refs.num.textContent = String(Number(key.slice(8, 10)));

      // --- 공휴일 ---
      // 이름은 좁은 칸에서 잘리므로 줄여 쓰고, 원래 이름은 툴팁에 남긴다.
      const names = showHolidays ? store.holidayOn(key) : null;
      const isRed = !!names && isPublicHoliday(names);
      cell.classList.toggle('cal-day--holiday', isRed);
      if (names) {
        cell.refs.holiday.textContent = names.map(shortName).join('·');
        cell.refs.holiday.hidden = false;
        cell.title = fullLabel(names);
      } else {
        cell.refs.holiday.textContent = '';
        cell.refs.holiday.hidden = true;
        cell.removeAttribute('title');
      }

      // 그날 걸쳐 있는 태스크(기간 포함) — 필터/정렬은 store 셀렉터가 처리
      const onDate = store.tasksOnDate(key);

      // 우상단 개수는 막대가 넘칠 때만 의미가 있으므로 renderBars 가 '+N' 으로 처리한다.
      // 날짜 옆에 상시로 붙어 있으면 숫자 두 개가 나란히 놓여 지저분하다.
      cell.refs.count.textContent = '';
      cell.refs.dots.replaceChildren();
    }

    // --- 일정 막대 ---
    // 단일 일정도 하루짜리 막대로 그린다. 점만 찍으면 '무슨 일정인지'가 안 보여
    // 달력이 정보 없이 비어 보인다.
    renderBars(els, keys, visibleDated(store, st, keys), st, store, weekCount);

    // --- 이번 달 완료율 --- (주간 뷰에서는 의미가 약해 숨긴다)
    els.meterFill.parentElement.parentElement.hidden = weekView;
    if (!weekView) renderMeter(els, st, anchor);
  }

  // ---------------------------------------------------------------- 이벤트
  function onClick(e) {
    if (suppressClick) { suppressClick = false; return; }
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;

    const nav = t.closest('.cal-navbtn');
    if (nav) {
      const st = store.getState();
      store.setAnchorMonth(date.addMonths(st.anchorMonth || date.todayKey(), Number(nav.dataset.nav)));
      return;
    }

    if (t.closest('.cal-viewbtn')) {
      const cur = store.getState().settings.calendarView;
      store.setSetting('calendarView', cur === 'week' ? 'month' : 'week');
      return;
    }

    if (t.closest('.cal-todaybtn')) {
      store.selectDate(date.todayKey());
      els.root.focus({ preventScroll: true });
      return;
    }

    const bar = t.closest('.cal-bar');
    if (bar) {
      const task = findTask(store, bar.dataset.taskId);
      if (task) {
        store.setEditing(task.id);
        if (task.start) store.selectDate(task.start);
      }
      els.root.focus({ preventScroll: true });
      return;
    }

    const more = t.closest('.cal-more');
    if (more) {
      store.selectDate(more.dataset.key);
      els.root.focus({ preventScroll: true });
      return;
    }

    const cell = t.closest('.cal-day');
    if (cell) {
      store.selectDate(cell.dataset.key);
      els.root.focus({ preventScroll: true });
    }
  }

  function onKeyDown(e) {
    if (isTypingTarget(document.activeElement) || isTypingTarget(e.target)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    const st = store.getState();
    const cur = st.selectedDate || date.todayKey();
    let next = null;

    switch (e.key) {
      case 'ArrowLeft':  next = date.addDays(cur, -1); break;
      case 'ArrowRight': next = date.addDays(cur, 1); break;
      case 'ArrowUp':    next = date.addDays(cur, -7); break;
      case 'ArrowDown':  next = date.addDays(cur, 7); break;
      case 'PageUp':     next = date.addMonths(cur, -1); break;
      case 'PageDown':   next = date.addMonths(cur, 1); break;
      default:
        // 한글 자판에서도 동작하도록 물리 키(code)로 판정
        if (e.code === 'KeyT' || e.key === 't' || e.key === 'T') next = date.todayKey();
    }

    if (!next) return;
    e.preventDefault();
    store.selectDate(next);
  }

  // 드래그 중에는 막대가 마우스 이벤트를 먹지 않게 해서 아래 날짜 칸이 드롭 타겟이 되게 한다.
  const onDocDragStart = () => els.grid.classList.add('cal-grid--dnd');
  const onDocDragEnd = () => {
    els.grid.classList.remove('cal-grid--dnd');
    for (const c of els.cells) c.classList.remove('is-drop');
  };

  // ---------------------------------------------------------------- 드롭 타겟
  for (const cell of els.cells) {
    cell.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      cell.classList.add('is-drop');
    });
    cell.addEventListener('dragleave', (e) => {
      if (!cell.contains(e.relatedTarget)) cell.classList.remove('is-drop');
    });
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      cell.classList.remove('is-drop');
      const dt = e.dataTransfer;
      if (!dt) return;
      const id = dt.getData('application/x-task-id') || dt.getData('text/plain');
      if (id) store.moveTask(id, cell.dataset.key);
    });
  }

  // ---------------------------------------------------------------- 기간 드래그
  //
  // 날짜 칸을 눌러 끌면 그 기간으로 새 일정을 만든다. 손으로 달력에 줄을 긋는 동작과 같다.
  // 단순 클릭(끌지 않음)은 기존 onClick 이 날짜 선택으로 처리한다.
  //
  // 막대(.cal-bar)는 날짜 칸의 자식이 아니라 형제 레이어(.cal-bars)에 있다.
  // 그래서 일정이 있는 칸을 지나는 순간 e.target.closest('.cal-day') 가 null 이 되어
  // 범위가 첫 칸에서 멈춰 있었다 — 일정이 있는 사람에게는 기능이 아예 없는 것과 같았다.
  // 끄는 동안에는 막대가 마우스를 먹지 않게 막는다(HTML5 드래그의 --dnd 와 같은 처리).

  let rangeAnchor = null;
  let rangeCurrent = null;
  let rangeDragged = false;
  let suppressClick = false;

  /**
   * 미리보기 지우기.
   * @param {boolean} done 끌기가 끝났는가. false 면 아직 끄는 중이라
   *   막대의 pointer-events 를 다시 켜지 않는다(켜면 칸을 못 찾는다).
   */
  function clearRangePreview(done = true) {
    for (const c of els.cells) c.classList.remove('cal-day--range', 'cal-day--range-end');
    if (done) els.grid.classList.remove('cal-grid--ranging');
    els.rangeTag.hidden = true;
  }

  function paintRange(a, b) {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    for (const c of els.cells) {
      const k = c.dataset.key;
      const inside = !c.hidden && k >= lo && k <= hi;
      c.classList.toggle('cal-day--range', inside);
      c.classList.toggle('cal-day--range-end', inside && (k === lo || k === hi));
    }
    showRangeTag(lo, hi);
  }

  /** 며칠부터 며칠까지 몇 일짜리인지 — 끄는 동안 끝 칸 옆에 띄운다 */
  function showRangeTag(lo, hi) {
    const days = date.diffDays(lo, hi) + 1;
    els.rangeTag.textContent = lo === hi
      ? `${shortLabel(lo)} · 하루`
      : `${shortLabel(lo)} → ${shortLabel(hi)} · ${days}일간`;

    const target = els.cells.find((c) => !c.hidden && c.dataset.key === hi);
    if (!target) { els.rangeTag.hidden = true; return; }

    const g = els.grid.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    els.rangeTag.hidden = false;
    // 배지가 그리드 밖으로 나가지 않게 가둔다
    const w = els.rangeTag.offsetWidth || 120;
    const left = Math.min(Math.max(0, r.left - g.left), Math.max(0, g.width - w));
    els.rangeTag.style.left = `${left}px`;
    els.rangeTag.style.top = `${Math.max(0, r.bottom - g.top - 26)}px`;
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    // 막대나 '+N', 추가 버튼 위에서 시작한 드래그는 다른 동작이므로 건드리지 않는다
    if (e.target.closest('.cal-bar') || e.target.closest('.cal-more')
        || e.target.closest('.cal-addbtn')) return;
    const cell = e.target.closest('.cal-day');
    if (!cell) return;
    // 기본 동작(텍스트 선택)이 끌기와 겹치면 칸이 파랗게 반전된다
    e.preventDefault();
    rangeAnchor = cell.dataset.key;
    rangeCurrent = rangeAnchor;
    rangeDragged = false;
    // 끄는 동안 막대가 마우스를 가리지 않게 한다
    els.grid.classList.add('cal-grid--ranging');
    hideAddButton();
  }

  function onMouseMove(e) {
    if (!rangeAnchor) return;
    const cell = e.target.closest?.('.cal-day');
    if (!cell || cell.hidden || cell.dataset.key === rangeCurrent) return;
    rangeCurrent = cell.dataset.key;
    rangeDragged = true;
    paintRange(rangeAnchor, rangeCurrent);
  }

  function onMouseUp() {
    if (!rangeAnchor) return;
    const a = rangeAnchor;
    const b = rangeCurrent;
    const dragged = rangeDragged;
    rangeAnchor = null;
    rangeCurrent = null;
    rangeDragged = false;
    clearRangePreview();
    if (!dragged || a === b) return;   // 단순 클릭 — onClick 이 처리
    suppressClick = true;              // 드래그 끝의 click 이벤트를 삼킨다
    store.requestCompose(a < b ? a : b, a < b ? b : a);
  }

  // ---------------------------------------------------------------- 막대 끌기
  //
  // 캘린더 안에서 일정을 직접 잡아 옮기고, 양 끝을 잡아 기간을 늘리고 줄인다.
  //
  // HTML5 드래그를 쓰지 않는 이유:
  //  - 끄는 동안 '어디로 가는지' 를 칸에 칠해 보여 줄 수 없다(고스트 이미지만 따라다닌다)
  //  - 양 끝을 잡는 기간 조절과 옮기기를 한 방식으로 다룰 수 없다
  //  - 놓을 자리가 캘린더 밖(D-Day)일 때의 처리가 갈린다
  // 마우스로 직접 다루면 셋 다 같은 코드 경로가 된다.

  const EDGE_PX = 7;          // 이 안쪽을 잡으면 기간 조절
  let barDrag = null;         // { id, mode, origStart, origEnd, grabKey, moved }

  function taskById(id) {
    return store.getState().tasks.find((t) => t.id === id) || null;
  }

  /** 좌표 아래의 날짜 칸. 막대는 끄는 동안 pointer-events 를 꺼 두므로 칸이 잡힌다. */
  function cellAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const cell = el && el.closest ? el.closest('.cal-day') : null;
    return cell && !cell.hidden ? cell : null;
  }

  function onBarMouseDown(e) {
    if (e.button !== 0) return;
    const bar = e.target.closest?.('.cal-bar');
    if (!bar) return;

    e.preventDefault();
    e.stopPropagation();      // 기간 드래그(빈 칸 끌기)로 번지지 않게

    const task = taskById(bar.dataset.taskId);
    if (!task) return;

    if (bar.dataset.locked) {
      notifyShell('반복 일정은 캘린더에서 옮길 수 없습니다');
      return;
    }

    const r = bar.getBoundingClientRect();
    // 이어지는 막대(cal-bar--cl/cr)는 그쪽 끝이 이번 주 밖이라 손잡이를 주지 않는다
    const canStart = !bar.classList.contains('cal-bar--cl');
    const canEnd = !bar.classList.contains('cal-bar--cr');
    let mode = 'move';
    if (canStart && e.clientX - r.left <= EDGE_PX) mode = 'start';
    else if (canEnd && r.right - e.clientX <= EDGE_PX) mode = 'end';

    const cell = cellAt(e.clientX, e.clientY);
    barDrag = {
      id: task.id,
      mode,
      origStart: task.start,
      origEnd: task.end || task.start,
      grabKey: cell ? cell.dataset.key : task.start,
      moved: false,
    };
    els.grid.classList.add('cal-grid--ranging');
    els.root.classList.add(`cal-root--drag-${mode}`);
    hideAddButton();
  }

  /**
   * 커서가 놓인 날짜로 계산한 새 기간.
   * 끌기 상태(d)를 인자로 받는다 — mouseup 은 barDrag 를 비운 뒤에 이 값을 쓰기 때문에,
   * 전역을 읽게 두면 그 순간 null 이라 조용히 실패한다(실제로 그렇게 안 먹혔다).
   */
  function dragRange(key, d) {
    if (d.mode === 'move') {
      const shift = date.diffDays(d.grabKey, key);
      return { start: date.addDays(d.origStart, shift), end: date.addDays(d.origEnd, shift) };
    }
    if (d.mode === 'start') {
      // 시작을 끝 너머로 밀지 않는다
      return { start: key > d.origEnd ? d.origEnd : key, end: d.origEnd };
    }
    return { start: d.origStart, end: key < d.origStart ? d.origStart : key };
  }

  function onBarMouseMove(e) {
    if (!barDrag) return;
    barDrag.moved = true;

    // D-Day 판 위로 가면 '여기 놓으면 고정' 이라고 알린다.
    // 표시가 없으면 놓을 수 있는 자리인 줄을 알 수가 없다.
    const dash = document.querySelector('.dash-root');
    const overDash = !!document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.dash-root');
    if (dash) dash.classList.toggle('is-drop', overDash);
    if (overDash) { clearRangePreview(false); return; }

    const cell = cellAt(e.clientX, e.clientY);
    if (!cell) return;
    const { start, end } = dragRange(cell.dataset.key, barDrag);
    paintRange(start, end);
  }

  function onBarMouseUp(e) {
    if (!barDrag) return;
    const d = barDrag;

    // **놓을 자리를 먼저 읽는다.** clearRangePreview 가 cal-grid--ranging 을 벗기면
    // 막대가 다시 마우스를 받게 되고, 막대는 날짜 칸의 자식이 아니라 형제 레이어라
    // elementFromPoint 가 칸을 못 찾는다. 지우고 나서 읽으면 매번 놓치게 된다.
    const dropEl = document.elementFromPoint(e.clientX, e.clientY);
    const overDash = !!(dropEl && dropEl.closest && dropEl.closest('.dash-root'));
    const cell = cellAt(e.clientX, e.clientY);

    barDrag = null;
    clearRangePreview();
    document.querySelector('.dash-root')?.classList.remove('is-drop');
    els.root.classList.remove('cal-root--drag-move', 'cal-root--drag-start', 'cal-root--drag-end');

    if (!d.moved) return;     // 제자리 — 클릭으로 처리된다
    suppressClick = true;

    // 캘린더 밖 D-Day 판 위에서 놓으면 고정한다
    if (overDash) {
      const t = taskById(d.id);
      if (t && !t.repeat && t.end) {
        if (store.setPinned(d.id, true)) notifyShell(`'${t.title || '일정'}' 을(를) 고정했습니다`, true);
      }
      return;
    }

    if (!cell) return;
    const { start, end } = dragRange(cell.dataset.key, d);
    if (start === d.origStart && end === d.origEnd) return;

    if (d.mode === 'move') store.moveTask(d.id, start);
    else store.updateTask(d.id, { start, end });
  }

  /** 셸에 짧은 문구를 부탁한다 (뷰 모듈끼리 직접 부르지 않는다) */
  function notifyShell(text, undo = false) {
    document.dispatchEvent(new CustomEvent('app:toast', { detail: { text, undo } }));
  }

  // ---------------------------------------------------------------- 칸 위 추가 버튼
  //
  // 일정을 만드는 길이 여기저기 흩어져 있으면 '이 앱에서는 어떻게 추가하지'가
  // 매번 물음이 된다. 캘린더 쪽 입구는 이 버튼 하나로 모은다.

  let addKey = null;

  function showAddButton(cell) {
    if (rangeAnchor) return;               // 기간을 끄는 중에는 방해하지 않는다
    addKey = cell.dataset.key;
    const g = els.grid.getBoundingClientRect();
    const r = cell.getBoundingClientRect();
    els.addBtn.hidden = false;
    els.addBtn.style.left = `${r.right - g.left - 20}px`;
    els.addBtn.style.top = `${r.bottom - g.top - 20}px`;
    els.addBtn.setAttribute('aria-label', `${shortLabel(addKey)}에 일정 추가`);
  }

  function hideAddButton() {
    addKey = null;
    els.addBtn.hidden = true;
  }

  els.addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!addKey) return;
    store.requestCompose(addKey, addKey);
  });

  els.grid.addEventListener('mouseover', (e) => {
    const cell = e.target.closest?.('.cal-day');
    // 버튼 자신 위에 올라갔을 때는 그대로 둔다
    if (!cell) {
      if (!e.target.closest?.('.cal-addbtn')) hideAddButton();
      return;
    }
    if (cell.hidden) { hideAddButton(); return; }
    if (cell.dataset.key !== addKey) showAddButton(cell);
  });
  els.grid.addEventListener('mouseleave', hideAddButton);

  // ---------------------------------------------------------------- 가로 스와이프
  //
  // 노트북 트랙패드에서 두 손가락으로 옆으로 밀면 달을 넘긴다.
  // 관성 스크롤은 이벤트가 수십 번 쏟아지므로 누적량이 문턱을 넘을 때만 한 달 움직이고,
  // 손을 뗀 뒤 잠깐은 무시해서 한 번의 스와이프가 석 달씩 넘어가지 않게 한다.

  const SWIPE_THRESHOLD = 90;   // 누적 deltaX
  const SWIPE_COOLDOWN = 320;   // ms
  let swipeAccum = 0;
  let swipeUntil = 0;
  let swipeResetTimer = 0;

  function onWheel(e) {
    // 세로 스크롤이 주된 제스처면 건드리지 않는다 (대각선 오인 방지)
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    if (e.ctrlKey) return;      // 확대/축소 제스처

    e.preventDefault();

    const now = Date.now();
    if (now < swipeUntil) return;      // 방금 넘겼다 — 관성 잔여분 무시

    swipeAccum += e.deltaX;
    clearTimeout(swipeResetTimer);
    swipeResetTimer = setTimeout(() => { swipeAccum = 0; }, 200);

    if (Math.abs(swipeAccum) < SWIPE_THRESHOLD) return;

    const dir = swipeAccum > 0 ? 1 : -1;   // 왼쪽으로 밀면(+) 다음 달
    swipeAccum = 0;
    swipeUntil = now + SWIPE_COOLDOWN;

    const st = store.getState();
    if (st.settings.calendarView === 'week') {
      store.selectDate(date.addDays(st.selectedDate || date.todayKey(), dir * 7));
    } else {
      store.setAnchorMonth(date.addMonths(st.anchorMonth || date.todayKey(), dir));
    }
  }

  // 날짜 칸 우클릭 — 그 자리에서 바로 일정을 만든다
  function onContextMenu(e) {
    const cell = e.target.closest('.cal-day');
    if (!cell) return;
    e.preventDefault();
    const key = cell.dataset.key;
    store.selectDate(key);
    showContextMenu(e.clientX, e.clientY, [
      { label: '이 날짜에 일정 추가', onSelect: () => store.requestCompose(key, key) },
      { label: '이 날부터 3일 일정', onSelect: () => store.requestCompose(key, date.addDays(key, 2)) },
      { label: '이 주(7일) 일정', onSelect: () => store.requestCompose(key, date.addDays(key, 6)) },
      { separator: true },
      { label: '오늘로 이동', onSelect: () => store.selectDate(date.todayKey()) },
    ]);
  }

  els.grid.addEventListener('contextmenu', onContextMenu);
  // 막대가 먼저 잡아야 한다 — 빈 칸 끌기(기간 만들기)보다 앞선다
  els.grid.addEventListener('mousedown', onBarMouseDown, true);
  els.grid.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onBarMouseMove);
  window.addEventListener('mouseup', onBarMouseUp);
  // mouseover 가 아니라 mousemove 를 쓴다. 막대를 가려 둬도 같은 칸 안에서
  // 움직이는 동안 갱신이 필요하고, 칸 경계를 스칠 때 mouseover 를 놓치는 일이 있다.
  els.grid.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  els.root.addEventListener('wheel', onWheel, { passive: false });

  els.root.addEventListener('click', onClick);
  els.root.addEventListener('keydown', onKeyDown);
  document.addEventListener('dragstart', onDocDragStart, true);
  document.addEventListener('dragend', onDocDragEnd, true);
  document.addEventListener('drop', onDocDragEnd, true);

  // 패널 크기가 바뀌면 한 칸에 들어가는 레인 수가 달라지므로 다시 그린다.
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  if (ro) ro.observe(els.grid);

  const unsubscribe = store.subscribe(schedule);
  render();

  return {
    destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      unsubscribe();
      if (ro) ro.disconnect();
      els.root.removeEventListener('click', onClick);
      els.root.removeEventListener('keydown', onKeyDown);
      els.grid.removeEventListener('contextmenu', onContextMenu);
      els.grid.removeEventListener('mousedown', onBarMouseDown, true);
      els.grid.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onBarMouseMove);
      window.removeEventListener('mouseup', onBarMouseUp);
      els.grid.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      els.root.removeEventListener('wheel', onWheel);
      clearTimeout(swipeResetTimer);
      document.removeEventListener('dragstart', onDocDragStart, true);
      document.removeEventListener('dragend', onDocDragEnd, true);
      document.removeEventListener('drop', onDocDragEnd, true);
      els.root.replaceChildren();
      els.root.classList.remove('cal-root');
      els.root.removeAttribute('tabindex');
    },
  };
}

// ================================================================== 뼈대

function buildSkeleton(root) {
  root.replaceChildren();
  root.classList.add('cal-root');
  root.setAttribute('tabindex', '0');

  // --- 헤더 ---
  const header = div('cal-header');
  const prev = make('button', 'cal-navbtn');
  prev.dataset.nav = '-1';
  prev.append(icon('chevronLeft'));
  prev.title = '이전 달';
  const title = div('cal-title');
  const next = make('button', 'cal-navbtn');
  next.dataset.nav = '1';
  next.append(icon('chevronRight'));
  next.title = '다음 달';

  const spacer = div('cal-spacer');

  const meter = div('cal-meter');
  meter.title = '이번 달 완료율';
  const track = div('cal-meter__track');
  const fill = div('cal-meter__fill');
  track.appendChild(fill);
  const meterLabel = div('cal-meter__label');
  meter.append(track, meterLabel);

  const viewBtn = make('button', 'cal-viewbtn');
  viewBtn.type = 'button';
  viewBtn.dataset.view = '1';
  // '월간 / 주간 전환' 만으로는 지금이 어느 쪽인지 알 수 없다.
  // 글자(=누르면 갈 곳)와 별개로, 현재 상태를 이름에 담는다.
  viewBtn.setAttribute('aria-label', '월간 보기 (누르면 주간)');

  const todayBtn = make('button', 'cal-todaybtn');
  todayBtn.textContent = '오늘로';
  todayBtn.setAttribute('aria-label', '오늘 날짜로 이동 (T)');

  header.append(prev, title, next, spacer, meter, viewBtn, todayBtn);

  // --- 요일 머리글 ---
  const weekdays = div('cal-weekdays');
  date.WEEKDAY_LABELS.forEach((label, i) => {
    const w = div('cal-weekday' + (i === 0 ? ' cal-weekday--sun' : i === 6 ? ' cal-weekday--sat' : ''));
    w.textContent = label;
    weekdays.appendChild(w);
  });

  // --- 6주 그리드 ---
  const grid = div('cal-grid');
  const cells = [];
  const barLayers = [];
  const weekRows = [];

  for (let w = 0; w < 6; w++) {
    const row = div('cal-week');
    const days = div('cal-week__days');

    for (let c = 0; c < 7; c++) {
      const cell = div('cal-day' + (c === 0 ? ' cal-day--sun' : c === 6 ? ' cal-day--sat' : ''));
      cell.dataset.col = String(c);

      const head = div('cal-day__head');
      const num = span('cal-day__num');
      const holiday = span('cal-day__holiday');
      holiday.hidden = true;
      const count = span('cal-day__count');
      head.append(num, holiday, count);

      const dots = div('cal-day__dots');
      cell.append(head, dots);
      cell.refs = { num, holiday, count, dots };

      days.appendChild(cell);
      cells.push(cell);
    }

    const bars = div('cal-bars');
    row.append(days, bars);
    grid.appendChild(row);
    barLayers.push(bars);
    weekRows.push(row);
  }

  // 기간 드래그 중 '며칠부터 며칠까지'를 그 자리에서 알려 주는 배지.
  // 칸 색만 칠하면 몇 일짜리인지 세어 봐야 한다.
  const rangeTag = div('cal-rangetag');
  rangeTag.hidden = true;

  // 날짜 칸마다 버튼을 42개 두는 대신, 하나를 만들어 커서가 올라간 칸으로 옮긴다.
  // 막대 레이어가 칸 위에 깔리므로 그리드 최상단에 두어야 가려지지 않는다.
  const addBtn = make('button', 'cal-addbtn');
  addBtn.type = 'button';
  addBtn.append(icon('plus'));
  addBtn.hidden = true;

  grid.append(rangeTag, addBtn);
  root.append(header, weekdays, grid);

  return { root, title, grid, cells, barLayers, weekRows, viewBtn,
           meterFill: fill, meterLabel, rangeTag, addBtn };
}

// ================================================================== 막대

/**
 * 주 단위 레인 배치.
 *
 * 1) 각 주(7칸)마다 그 주에 걸치는 태스크를 세그먼트로 자른다.
 *    (col = 주 시작으로부터의 오프셋, len = 칸 수, contLeft/contRight = 잘림 여부)
 * 2) 세그먼트를 [이어지는 것 우선 → 시작 칸 → 긴 것 → 생성순] 으로 정렬한다.
 *    이어지는 막대를 먼저 배치해야 지난 주 레인을 그대로 물려받기 쉽다.
 * 3) 각 세그먼트에 대해, 직전 주에서 쓰던 레인(lastLane)이 비어 있으면 그대로 쓰고,
 *    아니면 0번부터 올라가며 열 구간이 겹치지 않는 첫 빈 레인에 넣는다.
 *    → 여러 주에 걸친 막대가 같은 높이로 쭉 이어져 보인다.
 * 4) 연속성 유지 때문에 중간 레인이 비어(구멍) 화면 밖으로 밀리는 경우에만,
 *    그 주에 한해 빈 레인을 접어 올린다(compact). 평소엔 건드리지 않는다.
 *
 * @param {string[]} keys      42칸 날짜 키
 * @param {object[]} tasks     기간 태스크
 * @param {number}   maxLanes  한 주 행에 실제로 보이는 최대 레인 수
 * @returns {Array<Array<object>>} 주별 세그먼트 배열 (lane 배정 완료)
 */
function layoutLanes(keys, tasks, maxLanes) {
  const lastLane = new Map();
  const weeks = [];

  for (let w = 0; w < weeksCount(keys); w++) {
    const weekStart = keys[w * 7];
    const weekEnd = keys[w * 7 + 6];
    const segs = [];

    for (const task of tasks) {
      const s = task.start;
      const e = task.end || task.start;
      if (!s || e < weekStart || s > weekEnd) continue;

      const from = s < weekStart ? weekStart : s;
      const to = e > weekEnd ? weekEnd : e;
      segs.push({
        task,
        col: date.diffDays(weekStart, from),
        len: date.diffDays(from, to) + 1,
        contLeft: s < weekStart,
        contRight: e > weekEnd,
        isStart: s >= weekStart,
        lane: 0,
      });
    }

    segs.sort(
      (a, b) =>
        (b.contLeft ? 1 : 0) - (a.contLeft ? 1 : 0) ||
        a.col - b.col ||
        b.len - a.len ||
        a.task.createdAt - b.task.createdAt ||
        (a.task.id < b.task.id ? -1 : 1)
    );

    /** occupied[lane] = [[startCol, endCol], ...] */
    const occupied = [];
    let maxUsed = -1;
    for (const seg of segs) {
      const pref = lastLane.get(seg.task.id);
      let lane;
      if (pref != null && pref < maxLanes && laneFree(occupied, pref, seg)) {
        lane = pref;
      } else {
        lane = 0;
        while (!laneFree(occupied, lane, seg)) lane++;
      }
      seg.lane = lane;
      if (!occupied[lane]) occupied[lane] = [];
      occupied[lane].push([seg.col, seg.col + seg.len - 1]);
      if (lane > maxUsed) maxUsed = lane;
    }

    // 구멍 때문에 넘칠 때만 접어 올린다 (평소엔 연속성 유지가 우선)
    if (maxUsed + 1 > maxLanes) {
      const remap = new Map();
      [...new Set(segs.map((s) => s.lane))]
        .sort((a, b) => a - b)
        .forEach((lane, i) => remap.set(lane, i));
      for (const seg of segs) seg.lane = remap.get(seg.lane);
    }

    for (const seg of segs) lastLane.set(seg.task.id, seg.lane);

    weeks.push(segs);
  }

  return weeks;
}

function laneFree(occupied, lane, seg) {
  const list = occupied[lane];
  if (!list) return true;
  const a = seg.col;
  const b = seg.col + seg.len - 1;
  for (const [c, d] of list) if (a <= d && c <= b) return false;
  return true;
}

function renderBars(els, keys, tasks, st, store, weekCount = 6) {
  const m = readMetrics(els.grid);

  // 6주를 똑같은 높이로 나누면, 아무것도 없는 주가 바쁜 주와 같은 자리를 차지한다.
  // 결과적으로 위쪽 빈 줄은 허전하고 정작 일정이 몰린 날은 '+N' 으로 접힌다.
  // 그래서 주마다 필요한 레인 수를 먼저 세고, 그 비율로 행 높이를 나눠 준다.
  const gridH = els.grid.clientHeight || 0;
  const need = weekLaneDemand(keys, tasks, weekCount);   // 주별로 필요한 레인 수
  const weights = need.map((n) => 1 + Math.min(n, 6) * 0.55);
  const total = weights.reduce((a, b) => a + b, 0);
  els.grid.style.gridTemplateRows = weights.map((v) => `${(v / total * 100).toFixed(3)}%`).join(' ');

  // 레인 수는 주마다 다르므로 각 주의 실제 높이로 계산한다.
  const lanesFor = (w) => {
    const rowH = els.weekRows[w].clientHeight || Math.floor(gridH / 6);
    const usable = rowH > 0 ? rowH - m.top - m.dots : m.barH * 3;
    return Math.max(MIN_LANES, Math.floor((usable + m.gap) / (m.barH + m.gap)));
  };

  // 레인 배치는 주 전체에서 일관돼야 하므로 가장 여유 있는 주 기준으로 잡고,
  // 실제로 보여 줄 개수만 주별로 잘라 낸다.
  const maxLanes = Math.max(...Array.from({ length: weekCount }, (_, w) => lanesFor(w)));

  const weeks = layoutLanes(keys, tasks, maxLanes);

  for (let w = 0; w < weekCount; w++) {
    const layer = els.barLayers[w];
    const segs = weeks[w];
    layer.replaceChildren();
    if (!segs.length) continue;

    const weekLanes = lanesFor(w);

    let used = 0;
    for (const s of segs) used = Math.max(used, s.lane + 1);

    // 넘치면 마지막 한 줄을 '+N' 자리로 양보한다.
    const visibleLanes = used > weekLanes ? Math.max(0, weekLanes - 1) : weekLanes;
    const hidden = new Array(7).fill(0);

    for (const seg of segs) {
      if (seg.lane >= visibleLanes) {
        for (let c = seg.col; c < seg.col + seg.len; c++) hidden[c]++;
        continue;
      }
      layer.appendChild(makeBar(seg, m, st, store));
    }

    for (let c = 0; c < 7; c++) {
      if (!hidden[c]) continue;
      const more = document.createElement('div');
      more.className = 'cal-more';
      more.dataset.key = keys[w * 7 + c];
      more.textContent = `+${hidden[c]}`;
      more.title = `${hidden[c]}개 더 있음`;
      more.style.left = `calc(${pct(c)}% + 2px)`;
      more.style.width = `calc(${pct(1)}% - 4px)`;
      more.style.top = `${m.top + visibleLanes * (m.barH + m.gap)}px`;
      more.style.height = `${m.barH}px`;
      layer.appendChild(more);
    }
  }
}

/** 주별로 몇 개의 레인이 필요한지 (겹치는 최대 개수) */
function weekLaneDemand(keys, tasks, weekCount = 6) {
  const out = new Array(weekCount).fill(0);
  for (let w = 0; w < weekCount; w++) {
    let peak = 0;
    for (let c = 0; c < 7; c++) {
      const key = keys[w * 7 + c];
      let n = 0;
      for (const t of tasks) {
        const end = t.end || t.start;
        if (t.start && key >= t.start && key <= end) n++;
      }
      peak = Math.max(peak, n);
    }
    out[w] = peak;
  }
  return out;
}

function makeBar(seg, m, st, store) {
  const { task } = seg;
  const bar = document.createElement('div');

  let cls = 'cal-bar';
  if (seg.contLeft) cls += ' cal-bar--cl';
  if (seg.contRight) cls += ' cal-bar--cr';
  if (task.done) cls += ' cal-bar--done';
  if (st.editingTaskId === task.id) cls += ' cal-bar--editing';
  bar.className = cls;

  bar.dataset.taskId = task.id;
  // HTML5 드래그를 쓰지 않는다. 마우스로 직접 끌어야 옮기는 중에 어디로 가는지
  // 미리 칠해 보여 줄 수 있고, 양 끝을 잡아 기간을 늘리고 줄이는 것도 같은 방식으로 다룬다.
  bar.draggable = false;
  // 반복 일정은 규칙 하나를 공유하므로 한 회차만 옮길 수 없다
  if (task.repeat) bar.dataset.locked = '1';
  // title 속성은 HTML 파싱되지 않으므로 사용자 입력을 그대로 넣어도 안전
  bar.title = `${task.title} (${task.start} ~ ${task.end})`;
  // 색은 CSS 변수로만 넘기고, 실제 칠하기(농도·획·완료 처리)는 calendar.css 가 맡는다
  bar.style.setProperty('--bar-ink', store.COLORS[task.color] || store.COLORS.blue);

  const li = seg.contLeft ? 0 : 2;
  const ri = seg.contRight ? 0 : 2;
  bar.style.left = `calc(${pct(seg.col)}% + ${li}px)`;
  bar.style.width = `calc(${pct(seg.len)}% - ${li + ri}px)`;
  bar.style.top = `${m.top + seg.lane * (m.barH + m.gap)}px`;
  bar.style.height = `${m.barH}px`;

  // 제목은 시작 세그먼트에만
  if (seg.isStart) {
    const label = document.createElement('span');
    label.className = 'cal-bar__t';
    label.textContent = task.title; // XSS 방지: 항상 textContent
    bar.appendChild(label);
  }

  return bar;
}

// ================================================================== 점 / 미터

function renderDots(container, onDate, store) {
  container.replaceChildren();
  const singles = onDate.filter((t) => !t.end || t.end === t.start);
  if (!singles.length) return;

  const shown = Math.min(MAX_DOTS, singles.length);
  for (let i = 0; i < shown; i++) {
    const t = singles[i];
    const dot = document.createElement('i');
    dot.className = 'cal-dot' + (t.done ? ' cal-dot--done' : '');
    dot.style.background = store.COLORS[t.color] || store.COLORS.blue;
    container.appendChild(dot);
  }
  if (singles.length > shown) {
    const more = document.createElement('span');
    more.className = 'cal-dots__more';
    more.textContent = `+${singles.length - shown}`;
    container.appendChild(more);
  }
}

function renderMeter(els, st, anchor) {
  const prefix = anchor.slice(0, 7);
  let total = 0;
  let done = 0;
  for (const t of st.tasks) {
    if (!t.start || t.start.slice(0, 7) !== prefix) continue;
    total++;
    if (t.done) done++;
  }
  const rate = total ? Math.round((done / total) * 100) : 0;
  els.meterFill.style.width = `${rate}%`;
  els.meterLabel.textContent = total ? `${done}/${total}` : '–';
}

/** keys 길이로 주 수를 구한다 (월 6주 / 주간 1주) */
function weeksCount(keys) {
  return Math.max(1, Math.round(keys.length / 7));
}

/** 주간 뷰 표제 — '8월 16일 – 22일' */
/** '8/22(토)' — 범위 배지·버튼 라벨처럼 좁은 곳에 쓴다 */
function shortLabel(key) {
  const d = date.fromKey(key);
  return `${d.getMonth() + 1}/${d.getDate()}(${date.WEEKDAY_LABELS[d.getDay()]})`;
}

function weekTitle(keys) {
  const a = date.fromKey(keys[0]);
  const b = date.fromKey(keys[keys.length - 1]);
  const left = `${a.getFullYear()}년 ${a.getMonth() + 1}월 ${a.getDate()}일`;
  const right = a.getMonth() === b.getMonth()
    ? `${b.getDate()}일`
    : `${b.getMonth() + 1}월 ${b.getDate()}일`;
  return `${left} – ${right}`;
}

// ================================================================== 유틸

/**
 * 이 달력 화면에 막대로 그릴 일정 전부.
 * - 날짜가 있는 일정은 기간이든 하루짜리든 모두 막대로 그린다.
 * - 반복 일정은 화면에 걸린 회차만 하루짜리로 펼친다.
 * 필터는 store 셀렉터(tasksOnDate)가 이미 적용하므로 여기서 다시 걸지 않는다.
 */
function visibleDated(store, st, keys) {
  const seen = new Set();
  const out = [];

  for (const key of keys) {
    for (const t of store.tasksOnDate(key)) {
      // 루틴은 달력에 그리지 않는다 (tasksOnDate 가 이미 빼 주지만 뜻을 남겨 둔다)
      if (t.repeat?.routine) continue;
      if (t.repeat) {
        // 회차마다 별개의 하루짜리 막대. 같은 날 같은 일정은 한 번만.
        const id = `${t.id}@${key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ ...t, start: key, end: key });
        continue;
      }
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

function findTask(store, id) {
  return store.getState().tasks.find((t) => t.id === id) || null;
}

/** CSS 변수에서 막대 배치 수치를 읽는다 (컨테이너 쿼리로 값이 바뀔 수 있으므로 매번 읽음) */
function readMetrics(gridEl) {
  const cs = getComputedStyle(gridEl);
  const num = (name, fallback) => {
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    top: num('--cal-top-pad', 18),
    barH: num('--cal-bar-h', 14),
    gap: num('--cal-bar-gap', 2),
    dots: num('--cal-dots-h', 11),
  };
}

function pct(cols) {
  return ((cols / 7) * 100).toFixed(4);
}

function isTypingTarget(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true;
}

function make(tag, className) {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}
function div(className) {
  return make('div', className);
}
function span(className) {
  return make('span', className);
}
