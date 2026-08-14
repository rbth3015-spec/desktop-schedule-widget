// 캘린더 패널.
// 월(月) 6주 42칸 그리드 + 장기 계획 가로 막대(주 행을 가로지름) + 단일 일정 점.
// 상태는 store 액션으로만 바꾼다. root 안에만 그린다.

import * as date from '../lib/date.js';
import { icon } from '../lib/icons.js';

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
    const keys = date.monthGrid(anchor);
    const today = date.todayKey();
    const selected = st.selectedDate;

    els.title.textContent = date.monthLabel(anchor);

    // --- 날짜 칸 갱신 (뼈대는 재사용, 내용만 교체) ---
    for (let i = 0; i < 42; i++) {
      const key = keys[i];
      const cell = els.cells[i];

      cell.dataset.key = key;
      cell.classList.toggle('cal-day--out', !date.sameMonth(key, anchor));
      cell.classList.toggle('cal-day--today', key === today);
      cell.classList.toggle('cal-day--sel', key === selected);

      cell.refs.num.textContent = String(Number(key.slice(8, 10)));

      // 그날 걸쳐 있는 태스크(기간 포함) — 필터/정렬은 store 셀렉터가 처리
      const onDate = store.tasksOnDate(key);

      // 우상단 미완료 개수 (0이면 표시 안 함)
      const undone = onDate.reduce((n, t) => n + (t.done ? 0 : 1), 0);
      cell.refs.count.textContent = undone > 0 ? String(undone) : '';

      // 하단 점 — 기간 없는 단일 일정만
      renderDots(cell.refs.dots, onDate, store);
    }

    // --- 장기 계획 막대 ---
    renderBars(els, keys, visibleSpanning(store, st), st, store);

    // --- 이번 달 완료율 ---
    renderMeter(els, st, anchor);
  }

  // ---------------------------------------------------------------- 이벤트
  function onClick(e) {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;

    const nav = t.closest('.cal-navbtn');
    if (nav) {
      const st = store.getState();
      store.setAnchorMonth(date.addMonths(st.anchorMonth || date.todayKey(), Number(nav.dataset.nav)));
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

  const todayBtn = make('button', 'cal-todaybtn');
  todayBtn.textContent = '오늘';
  todayBtn.title = '오늘로 이동 (T)';

  header.append(prev, title, next, spacer, meter, todayBtn);

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

  return { root, title, grid, cells, barLayers, weekRows, meterFill: fill, meterLabel };
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

  for (let w = 0; w < 6; w++) {
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

function renderBars(els, keys, tasks, st, store) {
  const m = readMetrics(els.grid);

  // 주 행 높이로 한 칸에 들어가는 레인 수를 계산 (6행은 1fr 로 모두 같은 높이)
  const rowH = els.weekRows[0].clientHeight || Math.floor((els.grid.clientHeight || 0) / 6);
  const usable = rowH > 0 ? rowH - m.top - m.dots : m.barH * 3;
  const maxLanes = Math.max(MIN_LANES, Math.floor((usable + m.gap) / (m.barH + m.gap)));

  const weeks = layoutLanes(keys, tasks, maxLanes);

  for (let w = 0; w < 6; w++) {
    const layer = els.barLayers[w];
    const segs = weeks[w];
    layer.replaceChildren();
    if (!segs.length) continue;

    let used = 0;
    for (const s of segs) used = Math.max(used, s.lane + 1);

    // 넘치면 마지막 한 줄을 '+N' 자리로 양보한다.
    const visibleLanes = used > maxLanes ? Math.max(0, maxLanes - 1) : maxLanes;
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

// ================================================================== 유틸

/** 기간 태스크 중 현재 필터/완료표시 설정을 통과하는 것만 */
function visibleSpanning(store, st) {
  const q = st.filter.text ? st.filter.text.toLowerCase() : '';
  const tag = st.filter.tag;
  return store.spanningTasks().filter((t) => {
    if (!st.settings.showCompleted && t.done) return false;
    if (tag && !t.tags.includes(tag)) return false;
    if (q && !t.title.toLowerCase().includes(q) && !t.notes.toLowerCase().includes(q)) return false;
    return true;
  });
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
