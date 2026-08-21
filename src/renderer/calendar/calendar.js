// 캘린더 패널.
// 월(月) 6주 42칸 그리드 + 장기 계획 가로 막대(주 행을 가로지름) + 단일 일정 점.
// 상태는 store 액션으로만 바꾼다. root 안에만 그린다.

import * as date from '../lib/date.js';
import { icon } from '../lib/icons.js';
import { showContextMenu } from '../lib/menu.js';

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
    const today = date.todayKey();
    const selected = st.selectedDate;

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

  /** 장기 계획 막대를 통째로 드래그 (기간은 store.moveTask 가 보존) */
  function onDragStart(e) {
    const bar = e.target.closest && e.target.closest('.cal-bar');
    if (!bar || !e.dataTransfer) return;
    e.dataTransfer.setData('application/x-task-id', bar.dataset.taskId);
    e.dataTransfer.setData('text/plain', bar.dataset.taskId);
    e.dataTransfer.effectAllowed = 'move';
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
  // 날짜 칸을 눌러 끌면 그 기간으로 새 일정을 만든다. 손으로 달력에 줄을 긋는 동작과 같다.
  // 단순 클릭(끌지 않음)은 기존 onClick 이 날짜 선택으로 처리한다.
  let rangeAnchor = null;
  let rangeCurrent = null;
  let rangeDragged = false;
  let suppressClick = false;

  function clearRangePreview() {
    for (const c of els.cells) c.classList.remove('cal-day--range');
  }

  function paintRange(a, b) {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    for (const c of els.cells) {
      const k = c.dataset.key;
      c.classList.toggle('cal-day--range', k >= lo && k <= hi);
    }
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    // 막대나 '+N' 위에서 시작한 드래그는 일정 이동이므로 건드리지 않는다
    if (e.target.closest('.cal-bar') || e.target.closest('.cal-more')) return;
    const cell = e.target.closest('.cal-day');
    if (!cell) return;
    rangeAnchor = cell.dataset.key;
    rangeCurrent = rangeAnchor;
    rangeDragged = false;
  }

  function onMouseOver(e) {
    if (!rangeAnchor) return;
    const cell = e.target.closest('.cal-day');
    if (!cell || cell.dataset.key === rangeCurrent) return;
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
  els.grid.addEventListener('mousedown', onMouseDown);
  els.grid.addEventListener('mouseover', onMouseOver);
  window.addEventListener('mouseup', onMouseUp);

  els.root.addEventListener('click', onClick);
  els.root.addEventListener('keydown', onKeyDown);
  els.grid.addEventListener('dragstart', onDragStart);
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
      els.grid.removeEventListener('dragstart', onDragStart);
      els.grid.removeEventListener('contextmenu', onContextMenu);
      els.grid.removeEventListener('mousedown', onMouseDown);
      els.grid.removeEventListener('mouseover', onMouseOver);
      window.removeEventListener('mouseup', onMouseUp);
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
  viewBtn.title = '월간 / 주간 전환';

  const todayBtn = make('button', 'cal-todaybtn');
  todayBtn.textContent = '오늘';
  todayBtn.title = '오늘로 이동 (T)';

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
      const count = span('cal-day__count');
      head.append(num, count);

      const dots = div('cal-day__dots');
      cell.append(head, dots);
      cell.refs = { num, count, dots };

      days.appendChild(cell);
      cells.push(cell);
    }

    const bars = div('cal-bars');
    row.append(days, bars);
    grid.appendChild(row);
    barLayers.push(bars);
    weekRows.push(row);
  }

  root.append(header, weekdays, grid);

  return { root, title, grid, cells, barLayers, weekRows, viewBtn, meterFill: fill, meterLabel };
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
  bar.draggable = true;
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
