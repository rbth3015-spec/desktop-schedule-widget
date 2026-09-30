// 계획 — 주 · 달 단위로 크게 짜는 화면 (오른쪽 면의 책갈피 '계획').
//
// 하루 시간표는 '오늘 무엇을 언제' 를 맡는다. 그보다 큰 단위 — 이번 주에 끝낼 것,
// 이번 달에 이룰 것 — 은 날짜 없이 적어 두었다가 나중에 요일에 놓는다.
//
//   주간  목표 · 한 주 일곱 날(그날 부하 막대) · 습관표 · 돌아보기
//   월간  목표 · 그 달의 주마다 잡힌 목표 · 한 달 결산 · 돌아보기
// 목표를 요일(또는 달력 칸)로 끌어 놓으면 그날의 일정이 되고, 주를 누르면 그 주로 들어간다.
//
// 어느 주 · 어느 달인지는 왼쪽 달력이 정한다 — 날짜를 누르면 그 주가, 달을 넘기면 그 달이 된다.
// 이 화면에는 따로 넘기는 단추를 두지 않는다(같은 일을 하는 단추를 두 벌 두지 않는다).
// 지금 짜는 주는 달력에 금박 테두리로 보인다.

import { todayKey, fromKey, addDays, weekGrid, WEEKDAY_LABELS, timeMinutes } from '../lib/date.js';
import { showContextMenu } from '../lib/menu.js';
import { icon } from '../lib/icons.js';
import { isPublicHoliday } from '../lib/holidays.js';
import { h, setValueSafe, monthDay, shortDate } from './ui.js';

const ORD = ['첫째', '둘째', '셋째', '넷째', '다섯째', '여섯째'];

/** 몇 월 몇째 주인가 — 수요일이 든 달로 센다(한 주의 대부분이 그 달이다) */
function weekName(keys) {
  const mid = fromKey(keys[3]);
  return `${mid.getMonth() + 1}월 ${ORD[Math.floor((mid.getDate() - 1) / 7)]} 주`;
}

/** 'YYYY-MM' 달의 주들 — 수요일이 그 달에 든 주만 (weekName 과 같은 셈법) */
function weeksOfMonth(ym) {
  const out = [];
  let sun = weekGrid(`${ym}-01`)[0];
  for (let i = 0; i < 7; i++) {
    const keys = weekGrid(sun);
    const wed = keys[3].slice(0, 7);
    if (wed === ym) out.push(keys);
    else if (wed > ym) break;
    sun = addDays(sun, 7);
  }
  return out;
}

/** 'YYYY-MM' 의 앞 달 */
function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** 'YYYY-MM' 의 다음 달 */
function nextMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** 목표 한 줄 문법 — '!' 중요 · '#태그'. 날짜 · 시각은 읽지 않는다('9시 기상' 은 목표 이름이다). */
function parseGoal(raw) {
  const tags = [];
  let priority = 0;
  const words = [];
  for (const tok of String(raw).split(/\s+/).filter(Boolean)) {
    if (/^!{1,2}$/.test(tok)) { priority = Math.max(priority, tok.length); continue; }
    if (tok.length > 1 && tok[0] === '#') { if (!tags.includes(tok.slice(1))) tags.push(tok.slice(1)); continue; }
    words.push(tok);
  }
  return { title: words.join(' '), tags, priority };
}

/** 분 → '3시간 20분' */
function durText(m) {
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  if (!hh) return `${mm}분`;
  return mm ? `${hh}시간 ${mm}분` : `${hh}시간`;
}

/** 하루가 얼마나 찼나 — 시각 있는 일은 실제 길이로, 없는 일은 30분으로 어림한다 */
function dayLoad(items) {
  let sum = 0;
  for (const t of items) {
    const s0 = timeMinutes(t.startTime);
    if (s0 == null) { sum += 30; continue; }
    const e0 = timeMinutes(t.endTime);
    sum += e0 != null && e0 > s0 ? e0 - s0 : 60;
  }
  return sum;
}

/** 부하 막대가 가득 차는 기준 — 하루 열 시간 */
const LOAD_FULL = 600;

const isTaskDrag = (e) =>
  !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('application/x-task-id');

/**
 * @param {{store: object, onOpenDay: (key:string)=>void, onDetail: (id:string)=>void,
 *          notify: (text:string)=>void}} deps
 */
export function createPlan({ store, onOpenDay, onDetail, notify }) {
  const el = h('section', 'pln scr');
  el.hidden = true;
  el.setAttribute('aria-label', '계획');

  // ---------------------------------------------------------------- 머리 — '9월 넷째 주' · 9/20 – 9/26 …… [주간][월간]
  const head = h('header', 'pln-head');
  const headDate = h('div', 'pln-head__date');
  const titleEl = h('span', 'pln-head__title');
  const subEl = h('span', 'pln-head__sub num');
  headDate.append(titleEl, subEl);

  const views = h('div', 'pln-views');
  const viewBtns = new Map();
  for (const [id, label] of [['week', '주간'], ['month', '월간']]) {
    const b = h('button', 'pln-view', label);
    b.type = 'button';
    b.addEventListener('click', () => store.setSetting('planView', id));
    viewBtns.set(id, b);
    views.append(b);
  }
  head.append(headDate, views);

  // ---------------------------------------------------------------- 목표
  const goals = section('목표');
  const list = h('ul', 'pln-list');
  // 지난 주 · 지난 달에 못 한 목표를 이리로 — 그럴 것이 있을 때만 뜬다
  const carry = h('button', 'pln-carry');
  carry.type = 'button';
  carry.hidden = true;
  goals.actions.append(carry);

  const add = h('label', 'pln-add');
  const addIn = h('input', 'pln-add__input');
  addIn.type = 'text';
  addIn.spellcheck = false;
  addIn.placeholder = '목표 적기';
  add.append(h('span', 'pln-add__plus', '＋'), addIn);
  goals.el.append(list, add);

  // ---------------------------------------------------------------- 한 주 · 주마다
  const days = section('한 주');
  const dayList = h('div', 'pln-rows');
  days.el.append(dayList);

  const weeks = section('주마다');
  const weekList = h('div', 'pln-rows');
  weeks.el.append(weekList);

  // 습관표 — 루틴 × 요일. 다이어리의 그 격자다. 칸을 눌러 그 자리에서 체크한다.
  const habits = section('습관');
  const habitBox = h('div', 'pln-habits');
  habits.el.append(habitBox);

  // 한 달 결산 — 월말에 한 장으로 돌아본다
  const report = section('결산');
  const reportBox = h('div', 'pln-report');
  report.el.append(reportBox);

  // 돌아보기 — 지나간 주 · 달을 펼쳐 놓고 한 문단. 맨 아래에 조용히 둔다(주 기능을 밀지 않는다).
  const retro = section('돌아보기');
  const retroText = h('textarea', 'pln-retro__text scr-notes');
  retroText.rows = 3;
  const retroLines = h('div', 'pln-retro__lines');
  retro.el.append(retroText, retroLines);

  el.append(head, goals.el, days.el, habits.el, weeks.el, report.el, retro.el);

  /** 섹션 머리 — 하루 화면의 섹션과 같은 부품(이름 · 건수 · 괘선 · 동작 자리) */
  function section(name) {
    const sec = h('section', 'todo-section pln-sec');
    const top = h('div', 'todo-section__head');
    const title = h('span', 'todo-section__name');
    const count = h('span', 'todo-section__count num');
    title.append(h('span', 'todo-section__title', name), count);
    const actions = h('span', 'todo-section__actions');
    top.append(title, h('span', 'todo-section__rule'), actions);
    sec.append(top);
    return { el: sec, count, actions };
  }

  // ---------------------------------------------------------------- 지금 보는 자리
  let scope = '';          // 'w:YYYY-MM-DD' | 'm:YYYY-MM'
  let view = 'week';
  let carryIds = [];

  let retroTimer = 0;
  let retroPending = null;
  const flushRetro = () => {
    clearTimeout(retroTimer);
    if (!retroPending) return;
    const { scope: key, text } = retroPending;
    retroPending = null;
    store.setRetro(key, text);
  };
  retroText.addEventListener('input', () => {
    retroPending = { scope, text: retroText.value };
    clearTimeout(retroTimer);
    retroTimer = setTimeout(flushRetro, 400);
  });
  retroText.addEventListener('blur', flushRetro);

  addIn.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const g = parseGoal(addIn.value);
    if (!g.title) return;
    store.addGoal(scope, g);
    addIn.value = '';   // 칸은 그대로 — 이어서 적는다
  });

  carry.addEventListener('click', () => {
    if (!carryIds.length) return;
    const n = store.moveGoals(carryIds, scope, `지난 ${view === 'week' ? '주' : '달'} 목표 ${carryIds.length}개 가져오기`);
    if (n) notify(`${n}개를 가져왔습니다`);
  });

  // ---------------------------------------------------------------- 목표 한 줄
  function goalRow(t) {
    const li = h('li', 'pln-goal');
    li.dataset.id = t.id;
    li.draggable = true;
    li.classList.toggle('is-done', !!t.done);
    li.style.setProperty('--item', store.COLORS[t.color] || store.COLORS.blue);

    const check = h('button', 'todo-check');
    check.type = 'button';
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', String(!!t.done));
    check.setAttribute('aria-label', `${t.title || '목표'} 완료`);
    check.classList.toggle('is-on', !!t.done);
    if (t.done) check.append(icon('check', 9, 1.6));
    check.addEventListener('click', (e) => {
      e.stopPropagation();
      store.toggleDone(t.id);
    });

    const title = h('span', 'pln-goal__title', t.title || '(제목 없음)');
    title.title = t.title || '';
    li.append(check, title);
    if (t.priority > 0) li.append(h('span', 'todo-bang num', t.priority >= 2 ? '!!' : '!'));

    // 요일에 놓았으면 그날 — 지나도록 못 했으면 인주색
    if (t.start) {
      const d = fromKey(t.start);
      const when = h('span', 'pln-goal__when num',
        view === 'week' ? `${WEEKDAY_LABELS[d.getDay()]} ${d.getDate()}` : shortDate(t.start));
      when.classList.toggle('is-late', !t.done && (t.end || t.start) < todayKey());
      li.append(when);
    }

    li.addEventListener('click', (e) => {
      if (e.target.closest('.todo-check, .pln-goal__input')) return;
      if (e.detail > 1) return;
      clearTimeout(li._clickTimer);
      li._clickTimer = setTimeout(() => onDetail(t.id), 200);
    });
    li.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.pln-goal__title')) return;
      clearTimeout(li._clickTimer);
      rename(li, title, t);
    });
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      goalMenu(e.clientX, e.clientY, t);
    });
    li.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData('application/x-task-id', t.id);
      e.dataTransfer.setData('text/plain', t.title || '');
      e.dataTransfer.effectAllowed = 'move';
      li.classList.add('is-dragging');
      el.classList.add('is-dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('is-dragging');
      el.classList.remove('is-dragging');
      for (const r of el.querySelectorAll('.is-drop')) r.classList.remove('is-drop');
    });
    return li;
  }

  /** 제목 더블클릭 — 그 자리에서 이름만 고친다(오늘 목록과 같은 손버릇) */
  function rename(li, title, t) {
    const input = h('input', 'pln-goal__input todo-title-input');
    input.type = 'text';
    input.value = t.title || '';
    input.spellcheck = false;
    title.replaceWith(input);
    input.focus();
    input.select();
    let closed = false;
    const close = (save) => {
      if (closed) return;
      closed = true;
      const v = input.value.trim();
      input.replaceWith(title);
      if (save && v && v !== t.title) store.updateTask(t.id, { title: v });
    };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
    });
    input.addEventListener('blur', () => close(true));
  }

  function goalMenu(x, y, t) {
    const st = store.getState();
    const next = view === 'week'
      ? store.weekScope(addDays(weekGrid(st.selectedDate)[0], 7))
      : `m:${nextMonth(scope.slice(2))}`;
    // 이미 오늘 목록에 있으면 두 번 적지 않는다 — 메뉴 이름이 그렇다고 말한다
    const name = String(t.title || '').replace(/\s+/g, ' ').trim();
    const listed = store.todosOn(todayKey()).some((x) => !x.doneHere && x.text === name);
    showContextMenu(x, y, [
      { label: t.done ? '완료 취소' : '완료로 표시', onSelect: () => store.toggleDone(t.id) },
      { label: '자세히', onSelect: () => onDetail(t.id) },
      {
        // 큰 목표를 오늘 손댈 한 조각으로 — 할 일 목록에 그 이름으로 적는다(목표는 그대로 둔다)
        label: listed ? '오늘 할 일에 있음' : '오늘 할 일로',
        disabled: !!t.done || listed,
        onSelect: () => {
          if (store.addTodo(t.title, todayKey())) notify(`'${t.title}' 을(를) 오늘 할 일에 적었습니다`);
        },
      },
      { separator: true },
      {
        label: view === 'week' ? '다음 주로' : '다음 달로',
        disabled: !!t.done,
        onSelect: () => store.moveGoals([t.id], next),
      },
      {
        // 날짜도 주도 없는 '언젠가' 로 — 목표에서 내려놓는다
        label: '「언젠가」로 보내기',
        onSelect: () => store.updateTask(t.id, { plan: null, start: null, end: null }),
      },
      { separator: true },
      { label: '삭제', danger: true, onSelect: () => store.removeTask(t.id) },
    ]);
  }

  // ---------------------------------------------------------------- 끌어다 놓는 자리
  /** 목표를 받는 줄 — 놓으면 onDrop(id). 받을 수 있는 동안 금박 점선으로 보인다. */
  function dropTarget(row, onDrop) {
    row.addEventListener('dragover', (e) => {
      if (!isTaskDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('is-drop');
    });
    row.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && row.contains(e.relatedTarget)) return;
      row.classList.remove('is-drop');
    });
    row.addEventListener('drop', (e) => {
      row.classList.remove('is-drop');
      const id = e.dataTransfer?.getData('application/x-task-id');
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      onDrop(id);
    });
  }

  /** 줄 안의 작은 이름표 — 색 캡 + (시각) + 이름 */
  function chip(t) {
    const c = h('span', 'pln-chip');
    c.classList.toggle('is-done', !!t.done);
    const cap = h('span', 'pln-chip__cap');
    cap.style.background = store.COLORS[t.color] || store.COLORS.blue;
    c.append(cap);
    if (t.startTime) c.append(h('span', 'pln-chip__at num', t.startTime));
    c.append(h('span', 'pln-chip__t', t.title || '(제목 없음)'));
    return c;
  }

  /** 한 줄에 이름표 둘까지 — 나머지는 '+N'. 그날 전부는 줄을 누르면 하루 화면이 보여 준다. */
  const MAX_CHIPS = 2;

  function chipsOf(items) {
    const box = h('span', 'pln-row__items');
    for (const t of items.slice(0, MAX_CHIPS)) box.append(chip(t));
    if (items.length > MAX_CHIPS) box.append(h('span', 'pln-more num', `+${items.length - MAX_CHIPS}`));
    return box;
  }

  // ---------------------------------------------------------------- 주간 — 일곱 날
  function renderDays(keys) {
    const today = todayKey();
    const sel = store.getState().selectedDate;
    const rows = keys.map((key) => {
      const d = fromKey(key);
      // 달력은 '흐름' 을, 이 줄은 '그날 무엇이 잡혔는지' 를 — 여러 날짜리 막대는 달력이 맡는다
      const items = store.tasksOnDate(key)
        .filter((t) => t.repeat || !t.end || t.end === t.start)
        .sort((a, b) => (a.done !== b.done ? (a.done ? 1 : -1) : 0));
      // 부하는 루틴까지 넣어 잰다 — 그날 실제로 쓸 시간이 궁금한 것이지 목록 길이가 아니다
      const load = dayLoad([...store.tasksOnDate(key), ...store.routinesOn(key)]);

      const row = h('div', 'pln-row pln-day');
      row.dataset.key = key;
      row.classList.toggle('is-today', key === today);
      row.classList.toggle('is-sel', key === sel);
      row.classList.toggle('is-sun', d.getDay() === 0 || isPublicHoliday(store.holidayOn(key)));
      row.classList.toggle('is-past', key < today);

      const label = h('span', 'pln-row__label');
      label.append(h('span', 'pln-day__dow', WEEKDAY_LABELS[d.getDay()]),
                   h('span', 'pln-day__num num', String(d.getDate())));
      const bar = h('span', 'pln-load');
      const fill = h('span', 'pln-load__fill');
      fill.style.width = `${Math.min(100, Math.round((load / LOAD_FULL) * 100))}%`;
      bar.classList.toggle('is-busy', load >= 480);
      bar.append(fill);

      row.append(label, chipsOf(items), bar);
      row.title = load ? `${shortDate(key)} · 잡힌 시간 ${durText(load)}` : `${shortDate(key)} 열기`;
      row.addEventListener('click', () => onOpenDay(key));
      dropTarget(row, (id) => store.moveTask(id, key));
      return row;
    });
    dayList.replaceChildren(...rows);
  }

  // ---------------------------------------------------------------- 월간 — 주마다
  function renderWeeks(ym) {
    const thisWeek = store.weekScope(todayKey());
    const rows = weeksOfMonth(ym).map((keys, i) => {
      const ws = store.weekScope(keys[0]);
      const wg = store.planGoals(ws);
      const done = wg.filter((t) => t.done).length;

      const row = h('div', 'pln-row pln-week');
      row.classList.toggle('is-now', ws === thisWeek);
      const label = h('span', 'pln-row__label');
      label.append(h('span', 'pln-week__name', `${ORD[i]} 주`),
                   h('span', 'pln-week__range num', `${monthDay(keys[0])}–${monthDay(keys[6])}`));
      row.append(label, chipsOf(wg), h('span', 'pln-row__count num', wg.length ? `${done}/${wg.length}` : ''));
      row.title = `${ORD[i]} 주 계획 열기`;
      // 그 주로 들어간다. 달력이 다른 달로 넘어가지 않게 이 달 안의 첫날을 고른다.
      row.addEventListener('click', () => {
        const first = keys.find((k) => k.slice(0, 7) === ym) || keys[0];
        store.selectDate(first);
        store.setSetting('planView', 'week');
      });
      dropTarget(row, (id) => store.moveGoals([id], ws));
      return row;
    });
    weekList.replaceChildren(...rows);
  }

  // ---------------------------------------------------------------- 습관표
  //
  // 하기로 한 날만 칸이 된다. 한 날은 먹점, 안 한 날은 빈 동그라미, 하기로 하지 않은 날은 점 하나.
  // 앞날은 미리 체크하지 않는다 — 오늘까지만 누를 수 있다.
  function renderHabits(keys) {
    const routines = store.getState().tasks
      .filter((t) => t.repeat?.routine)
      .sort((a, b) => (a.order - b.order) || (a.createdAt - b.createdAt));

    habits.el.hidden = !routines.length;
    if (!routines.length) return;
    habits.count.textContent = String(routines.length);

    const today = todayKey();
    const rows = [];

    const headRow = h('div', 'pln-habit pln-habit--head');
    headRow.append(h('span', 'pln-habit__name'));
    for (const key of keys) {
      const d = fromKey(key);
      const cell = h('span', 'pln-habit__dow', WEEKDAY_LABELS[d.getDay()]);
      cell.classList.toggle('is-today', key === today);
      headRow.append(cell);
    }
    headRow.append(h('span', 'pln-habit__streak'));
    rows.push(headRow);

    for (const t of routines) {
      const row = h('div', 'pln-habit');
      row.style.setProperty('--item', store.COLORS[t.color] || store.COLORS.blue);
      const name = h('span', 'pln-habit__name', t.title || '(제목 없음)');
      name.title = `${t.title || ''} · ${store.repeatLabel(t.repeat)}`;
      name.addEventListener('click', () => onDetail(t.id));
      row.append(name);

      for (const key of keys) {
        const on = store.occursOn(t, key);
        const done = t.doneDates.includes(key);
        const future = key > today;
        const cell = h('button', 'pln-cell');
        cell.type = 'button';
        cell.disabled = !on || future;
        cell.classList.toggle('is-off', !on);
        cell.classList.toggle('is-done', done);
        cell.classList.toggle('is-future', on && future);
        cell.classList.toggle('is-today', key === today);
        cell.setAttribute('aria-label', `${t.title || '루틴'} ${key} ${done ? '완료 취소' : '완료'}`);
        cell.setAttribute('aria-pressed', String(done));
        cell.append(h('span', 'pln-cell__dot'));
        cell.addEventListener('click', () => store.toggleDone(t.id, key));
        row.append(cell);
      }

      const n = store.routineStreak(t, today);
      row.append(h('span', 'pln-habit__streak num', n >= 2 ? `${n}일째` : ''));
      rows.push(row);
    }
    habitBox.replaceChildren(...rows);
  }

  // ---------------------------------------------------------------- 한 달 결산
  function renderReport(ym) {
    const r = store.monthReport(ym);
    report.el.hidden = !r.total;
    if (!r.total) return;
    report.count.textContent = '';

    const box = [];

    const top = h('div', 'pln-report__top');
    const stat = (label, value, cls = 'num') => {
      const b = h('span', 'pln-stat');
      b.append(h('span', 'pln-stat__k', label), h('span', `pln-stat__v ${cls}`.trim(), value));
      return b;
    };
    top.append(stat('끝낸 일', `${r.done} / ${r.total}`), stat('완료', `${r.rate}%`));
    // 주 이름은 숫자가 아니다 — 숫자 서체로 쓰면 한글이 대체 서체로 튄다
    if (r.busiest) top.append(stat('가장 바쁜 주', `${ORD[r.busiest.index]} 주`, 'pln-stat__v--text'));
    box.push(top);

    // 태그별 — 이 달에 무엇으로 시간을 보냈나
    const max = r.tags[0]?.n || 1;
    for (const { tag, n } of r.tags) {
      const row = h('div', 'pln-tagrow');
      const track = h('span', 'pln-tagbar');
      const fill = h('span', 'pln-tagbar__fill');
      fill.style.width = `${Math.round((n / max) * 100)}%`;
      track.append(fill);
      row.append(h('span', 'pln-tagrow__name', `#${tag}`), track, h('span', 'pln-tagrow__n num', String(n)));
      box.push(row);
    }

    const note = (label, text) => {
      const row = h('div', 'pln-note');
      row.append(h('span', 'pln-note__k', label), h('span', 'pln-note__v', text));
      return row;
    };
    if (r.dragged) box.push(note('가장 오래 끈 일', `${r.dragged.title} · ${r.dragged.n}번 미룸`));
    if (r.streak) box.push(note('루틴 최고 기록', `${r.streak.title} · ${r.streak.n}일째`));

    reportBox.replaceChildren(...box);
  }

  // ---------------------------------------------------------------- 돌아보기
  //
  // 그 기간에 적어 둔 '한 줄' 들을 펼쳐 놓고, 그 위에 한 문단을 덧댄다.
  // 아직 오지 않은 주 · 달에는 돌아볼 것이 없으므로 자리째 걷는다.
  function renderRetro(from, to) {
    const started = from <= todayKey();
    retro.el.hidden = !started;
    if (!started) { flushRetro(); return; }

    retro.count.textContent = '';
    retroText.placeholder = view === 'week' ? '이 주는 어땠나' : '이 달은 어땠나';
    setValueSafe(retroText, store.retroOn(scope));

    const lines = store.journalBetween(from, to);
    retroLines.replaceChildren(...lines.map(({ key, text }) => {
      const row = h('button', 'pln-retro__row');
      row.type = 'button';
      row.append(h('span', 'pln-retro__when num', shortDate(key)),
                 h('span', 'pln-retro__text-line', text));
      row.title = `${shortDate(key)} 열기`;
      row.addEventListener('click', () => onOpenDay(key));
      return row;
    }));
  }

  // ---------------------------------------------------------------- 그리기
  function update() {
    const st = store.getState();
    view = st.settings.planView === 'month' ? 'month' : 'week';
    for (const [id, b] of viewBtns) {
      b.classList.toggle('is-on', id === view);
      b.setAttribute('aria-pressed', String(id === view));
    }

    let prevScope;
    if (view === 'week') {
      const keys = weekGrid(st.selectedDate);
      scope = store.weekScope(keys[0]);
      prevScope = store.weekScope(addDays(keys[0], -7));
      titleEl.textContent = weekName(keys);
      subEl.textContent = `${monthDay(keys[0])} – ${monthDay(keys[6])}`;
      renderDays(keys);
      renderHabits(keys);
      renderRetro(keys[0], keys[6]);
    } else {
      const ym = (st.anchorMonth || st.selectedDate).slice(0, 7);
      scope = `m:${ym}`;
      prevScope = `m:${prevMonth(ym)}`;
      titleEl.textContent = `${Number(ym.slice(5))}월`;
      subEl.textContent = ym.slice(0, 4);
      renderWeeks(ym);
      renderReport(ym);
      renderRetro(`${ym}-01`, `${ym}-31`);
    }
    days.el.hidden = view !== 'week';
    weeks.el.hidden = view !== 'month';
    if (view !== 'week') habits.el.hidden = true;
    if (view !== 'month') report.el.hidden = true;
    addIn.setAttribute('aria-label', view === 'week' ? '이번 주 목표 적기' : '이번 달 목표 적기');

    const gs = store.planGoals(scope);
    const done = gs.filter((t) => t.done).length;
    goals.count.textContent = gs.length ? `${done}/${gs.length}` : '';
    list.replaceChildren(...gs.map(goalRow));

    // 지난 주 · 지난 달에 날짜도 못 잡고 남은 목표
    carryIds = store.planGoals(prevScope).filter((t) => !t.done && !t.start).map((t) => t.id);
    carry.hidden = !carryIds.length;
    carry.textContent = `지난 ${view === 'week' ? '주' : '달'} ${carryIds.length}개 가져오기`;
  }

  return {
    el,
    update,
    flush: flushRetro,
    focusAdd() { addIn.focus(); },
  };
}
