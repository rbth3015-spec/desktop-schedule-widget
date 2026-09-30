// 할 일 — 달력과 따로 가는 그날그날의 체크리스트 (오른쪽 면의 책갈피 '할 일').
//
// 일정은 '언제' 가 먼저지만 할 일은 '무엇' 이 먼저다. 쭉 적어 두고 하나씩 끝내 나간다.
//   · 목록 끝 한 줄에 적고 Enter — 칸은 그대로 남아 이어서 적는다(여러 줄을 붙여 넣으면 줄마다 하나).
//   · 줄을 누르면 완료(줄이 그어진다), 다시 누르면 완료 취소. 이름을 두 번 누르면 고친다. ↑↓ 로 줄을 옮겨 다닌다.
//   · 다 못 한 것은 다음 날 목록으로 그대로 이어진다 — 묵은 날수('3일째')가 붙는다.
//   · 오른쪽 클릭은 일정과 같은 말을 쓴다 — 완료 · 이름 고치기 · 시간 잡기 · 내일로 미루기 · 삭제.
//     (앱 안에서 같은 일을 두 가지 말로 부르면 두 기능이 따로 노는 것처럼 보인다)
//   · 머리 아래 한 줄은 비서가 말한다 — 다음 일정까지 남은 시간. 하루 화면의 그 목소리다.
//
// 어느 날인지는 왼쪽 달력이 정한다(계획과 같은 약속). 이 화면에 날짜를 넘기는 단추를 따로 두지 않는다.

import { todayKey, fromKey, addDays, timeMinutes } from '../lib/date.js';
import { showContextMenu } from '../lib/menu.js';
import { icon } from '../lib/icons.js';
import { h, monthDay } from './ui.js';

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const DRAG_TYPE = 'application/x-todo-id';

/** '오늘 할 일' · '9월 30일 할 일' */
function titleOf(key) {
  if (key === todayKey()) return '오늘 할 일';
  const d = fromKey(key);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 할 일`;
}

/** '9/29 (화)' */
function subOf(key) {
  return `${monthDay(key)} (${WEEK[fromKey(key).getDay()]})`;
}

/** 분 → 'HH:MM' */
function clock(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 분 → '1시간 20분' */
function spanText(m) {
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  if (!hh) return `${mm}분`;
  return mm ? `${hh}시간 ${mm}분` : `${hh}시간`;
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * @param {{store: object, notify: (text:string)=>void, onDetail: (taskId:string)=>void,
 *          onSchedule: (todo:object, key:string)=>void, onOpenDay: (key:string)=>void}} deps
 */
export function createTodos({ store, notify, onDetail, onSchedule, onOpenDay }) {
  const el = h('section', 'tds scr');
  el.hidden = true;
  el.setAttribute('aria-label', '할 일');

  // ---------------------------------------------------------------- 머리 — '오늘 할 일' 9/29 (화) …… 3 / 7
  const head = h('header', 'tds-head');
  const headDate = h('div', 'tds-head__date');
  const titleEl = h('span', 'tds-head__title');
  const subEl = h('span', 'tds-head__sub num');
  headDate.append(titleEl, subEl);
  const countEl = h('span', 'tds-head__count num');
  // 머리 밑 먹선이 지운 만큼 금박으로 바뀐다 — 숫자를 읽지 않아도 얼마나 왔는지 보인다
  const meter = h('span', 'tds-head__meter');
  head.append(headDate, countEl, meter);

  // 비서의 한 줄 — 할 일을 하는 동안 다음 일정까지 얼마나 남았는지(하루 화면과 같은 목소리).
  // 누르면 그날의 하루 화면으로. 오늘이 아니거나 남은 시각 일정이 없으면 걷는다.
  const aide = h('button', 'tds-aide');
  aide.type = 'button';
  aide.title = '하루 화면에서 보기';
  aide.hidden = true;
  aide.addEventListener('click', () => onOpenDay?.(key));

  // ---------------------------------------------------------------- 목록 · 적는 줄
  const list = h('ul', 'tds-list');
  const add = h('label', 'tds-add');
  const addIn = h('input', 'tds-add__input');
  addIn.type = 'text';
  addIn.spellcheck = false;
  addIn.maxLength = 200;
  addIn.placeholder = '할 일 적기';
  addIn.setAttribute('aria-label', '할 일 적기');
  add.append(h('span', 'tds-add__plus', '＋'), addIn);

  // 어제 한 일 — 그 전날(주말을 건너뛰었으면 금요일) 지운 것들. 아침 회의에서 그대로 읽는다.
  const past = h('section', 'tds-past');
  const pastHead = h('div', 'todo-section__head');
  const pastName = h('span', 'todo-section__name');
  const pastTitle = h('span', 'todo-section__title');
  const pastCount = h('span', 'todo-section__count num');
  pastName.append(pastTitle, pastCount);
  pastHead.append(pastName, h('span', 'todo-section__rule'));
  const pastList = h('ul', 'tds-past__list');
  past.append(pastHead, pastList);
  past.hidden = true;

  el.append(head, aide, list, add, past);

  let key = todayKey();

  // ---------------------------------------------------------------- 적기
  addIn.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    // 비어 있을 때 ↑ — 목록 끝 줄로 올라간다
    if (e.key === 'ArrowUp' && !addIn.value) {
      const last = list.lastElementChild;
      if (last) { e.preventDefault(); last.focus(); }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (store.addTodo(addIn.value, key)) addIn.value = '';   // 칸은 그대로 — 이어서 적는다
      return;
    }
    if (e.key === 'Escape' && addIn.value) {
      e.preventDefault();
      e.stopPropagation();
      addIn.value = '';
    }
  });
  // 여러 줄을 붙여 넣으면 줄마다 하나 — 메모장에 적어 둔 목록을 그대로 옮긴다
  addIn.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') || '';
    const lines = text.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)]|\[[ xX]?\])\s*/, '').trim()).filter(Boolean);
    if (lines.length < 2) return;
    e.preventDefault();
    const n = store.addTodos(lines, key, `할 일 ${lines.length}개 붙여 넣기`);
    if (n) notify(`${n}개를 적었습니다`);
  });

  // ---------------------------------------------------------------- 한 줄
  function row(t) {
    const li = h('li', 'tds-item');
    li.dataset.id = t.id;
    li.tabIndex = 0;
    li.draggable = true;
    li.classList.toggle('is-done', t.doneHere);

    const check = h('span', 'todo-check tds-check');
    check.setAttribute('aria-hidden', 'true');
    check.classList.toggle('is-on', t.doneHere);
    if (t.doneHere) check.append(icon('check', 9, 1.6));

    const text = h('span', 'tds-item__text', t.text);
    text.title = t.text;
    li.append(check, text);
    li.setAttribute('role', 'checkbox');
    li.setAttribute('aria-checked', String(t.doneHere));

    // 시간을 잡아 둔 할 일 — 그 일정의 시각. 누르면 일정이 열린다.
    const task = store.todoTask(t);
    if (task) {
      const at = task.startTime || '종일';
      const when = h('button', 'tds-item__when num',
        task.start && task.start !== key ? `${monthDay(task.start)} ${at}` : at);
      when.type = 'button';
      when.title = '일정 열기';
      when.addEventListener('click', (e) => {
        e.stopPropagation();
        onDetail(task.id);
      });
      li.append(when);
    } else if (!t.doneHere && t.age >= 2) {
      // 전날부터 이어진 것 — 오래 묵을수록 인주색
      const age = h('span', 'tds-item__age num', `${t.age}일째`);
      age.classList.toggle('is-stale', t.age >= 4);
      age.title = `${monthDay(t.day)}에 적음`;
      li.append(age);
    }

    // 누르면 완료(다시 누르면 취소). 두 번 누르면 이름을 고친다 — 한 번 누름은 잠깐 기다렸다 처리한다.
    li.addEventListener('click', (e) => {
      if (e.target.closest('.tds-item__input, .tds-item__when')) return;
      if (e.detail > 1) return;
      clearTimeout(li._clickTimer);
      li._clickTimer = setTimeout(() => toggle(t), 180);
    });
    li.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.tds-item__text')) return;
      clearTimeout(li._clickTimer);
      rename(li, text, t);
    });
    li.addEventListener('keydown', (e) => {
      if (e.target !== li) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(t); }
      else if (e.key === 'F2') { e.preventDefault(); rename(li, text, t); }
      else if (e.key === 'Delete') { e.preventDefault(); remove(t); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); (li.nextElementSibling || addIn).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); li.previousElementSibling?.focus(); }
    });
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      menu(e.clientX, e.clientY, li, text, t);
    });

    // 끌어서 순서 바꾸기 — 줄의 위 절반에 놓으면 그 앞, 아래 절반이면 그 뒤
    li.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData(DRAG_TYPE, t.id);
      e.dataTransfer.setData('text/plain', t.text);
      e.dataTransfer.effectAllowed = 'move';
      li.classList.add('is-dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('is-dragging');
      clearDrop();
    });
    li.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = li.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      clearDrop();
      li.classList.add(after ? 'is-drop-after' : 'is-drop-before');
    });
    li.addEventListener('drop', (e) => {
      const id = e.dataTransfer?.getData(DRAG_TYPE);
      if (!id) return;
      e.preventDefault();
      const after = li.classList.contains('is-drop-after');
      clearDrop();
      const next = after ? li.nextElementSibling?.dataset.id || null : t.id;
      store.moveTodo(id, next);
    });
    return li;
  }

  function clearDrop() {
    for (const n of list.querySelectorAll('.is-drop-before, .is-drop-after')) {
      n.classList.remove('is-drop-before', 'is-drop-after');
    }
  }

  /** 그 자리에서 이름만 고친다(비우고 Enter 면 뺀다) */
  function rename(li, text, t) {
    if (li.querySelector('.tds-item__input')) return;
    const input = h('input', 'tds-item__input');
    input.type = 'text';
    input.value = t.text;
    input.spellcheck = false;
    input.maxLength = 200;
    text.replaceWith(input);
    li.draggable = false;
    input.focus();
    input.select();
    let closed = false;
    const close = (save) => {
      if (closed) return;
      closed = true;
      const v = input.value.trim();
      input.replaceWith(text);
      li.draggable = true;
      if (!save) return;
      if (!v) remove(t);
      else store.updateTodo(t.id, v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
    });
    input.addEventListener('blur', () => close(true));
  }

  function remove(t) {
    store.removeTodo(t.id);
    notify(`'${t.text}' 을(를) 삭제했습니다`);
  }

  /**
   * 완료 ↔ 완료 취소. 오늘 목록을 다 끝낸 순간에는 비서가 한마디 한다
   * (되돌릴 거리가 아니라 인사라서 되돌리기 단추를 달지 않는다 — Ctrl+Z 는 그대로 된다).
   */
  function toggle(t) {
    const before = store.todoSummary(key);
    store.toggleTodo(t.id, key);
    const after = store.todoSummary(key);
    if (key === todayKey() && before.open > 0 && after.open === 0 && after.total > 0) {
      document.dispatchEvent(new CustomEvent('app:toast', {
        detail: { text: `오늘 할 일 ${after.total}개를 다 끝냈습니다`, undo: false },
      }));
    }
  }

  // 우클릭 — 일정 목록의 메뉴와 같은 말을 쓴다(완료 · 내일로 미루기 · 삭제)
  function menu(x, y, li, text, t) {
    const task = store.todoTask(t);
    showContextMenu(x, y, [
      { label: t.doneHere ? '완료 취소' : '완료로 표시', onSelect: () => toggle(t) },
      { label: '이름 고치기', onSelect: () => rename(li, text, t) },
      { separator: true },
      task
        ? { label: '일정 열기', onSelect: () => onDetail(task.id) }
        : { label: '시간 잡기', onSelect: () => onSchedule(t, key), disabled: t.doneHere },
      { label: '내일로 미루기', onSelect: () => store.deferTodo(t.id, key), disabled: t.doneHere },
      { separator: true },
      { label: '삭제', danger: true, onSelect: () => remove(t) },
    ]);
  }

  /** 다음 일정까지 — 지금 진행 중이면 그 일정이 언제 끝나는지 */
  function renderAide() {
    if (key !== todayKey()) { aide.hidden = true; return; }
    const now = nowMinutes();
    const timed = [...store.tasksOnDate(key, { filtered: false }), ...store.routinesOn(key, { filtered: false })]
      .filter((t) => !t.done && t.startTime)
      .map((t) => {
        const s = timeMinutes(t.startTime);
        const e = timeMinutes(t.endTime);
        return { t, s, e: e != null && e > s ? e : s + 60 };
      })
      .sort((a, b) => a.s - b.s);
    const running = timed.find((x) => x.s <= now && now < x.e);
    const next = timed.find((x) => x.s > now);
    const num = (v) => h('span', 'tds-aide__num num', v);
    const parts = [];
    if (running) {
      parts.push('지금은 ', h('span', 'tds-aide__what', running.t.title || '일정'),
        ' 시간 · ', num(clock(running.e)), '까지');
    } else if (next) {
      parts.push('다음 일정까지 ', num(spanText(next.s - now)), ' · ', num(clock(next.s)), ' ',
        h('span', 'tds-aide__what', next.t.title || '일정'));
    }
    aide.hidden = !parts.length;
    aide.replaceChildren(...parts);
  }

  // ---------------------------------------------------------------- 그리기
  function update() {
    key = store.getState().selectedDate;
    titleEl.textContent = titleOf(key);
    subEl.textContent = subOf(key);

    const items = store.todosOn(key);
    const done = items.filter((t) => t.doneHere).length;
    countEl.textContent = items.length ? `${done} / ${items.length}` : '';
    countEl.classList.toggle('is-all', !!items.length && done === items.length);
    meter.style.width = items.length ? `${((done / items.length) * 100).toFixed(1)}%` : '0%';

    renderPast();
    renderAide();

    // 고치던 줄이 있으면 그 줄은 그대로 둔다 — 다시 그리면 적던 글자가 날아간다
    const editing = list.querySelector('.tds-item__input');
    if (editing) return;
    const focusedId = document.activeElement?.closest?.('.tds-item')?.dataset.id;
    list.replaceChildren(...items.map(row));
    if (focusedId) list.querySelector(`[data-id="${CSS.escape(focusedId)}"]`)?.focus();
  }

  function renderPast() {
    const prev = store.lastDoneDay(key);
    past.hidden = !prev;
    if (!prev) return;
    const d = fromKey(prev.day);
    pastTitle.textContent = prev.day === addDays(key, -1)
      ? '어제 한 일'
      : `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]}) 한 일`;
    pastCount.textContent = String(prev.items.length);
    pastList.replaceChildren(...prev.items.map((t) => {
      const li = h('li', 'tds-past__item');
      li.append(h('span', 'tds-past__mark', '✓'), h('span', 'tds-past__text', t.text));
      li.title = `${monthDay(prev.day)} 목록 보기`;
      li.addEventListener('click', () => store.selectDate(prev.day));
      return li;
    }));
  }

  return {
    el,
    update,
    focusAdd() { addIn.focus(); },
    /** 그 줄로 — 「지금 할 일」 이 고른 할 일을 짚어 준다(금박이 잠깐 머문다) */
    focusTodo(id) {
      const li = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (!li) return;
      li.focus();
      li.classList.add('is-flash');
      setTimeout(() => li.classList.remove('is-flash'), 1400);
    },
    /** 목록이 비었으면 적는 줄로 — 책갈피를 눌러 들어왔을 때 */
    focusIfEmpty() {
      if (!store.todosOn(store.getState().selectedDate).length) addIn.focus();
    },
  };
}
