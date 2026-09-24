// Zone C — D-Day. 아래 리본의 왼쪽 칸.
// 계약: export function createDashboard({ root, store }) -> { destroy() }
// 외부 라이브러리 없음. 순수 ES 모듈 + DOM API. 사용자 입력은 항상 textContent 로만 넣는다.
//
// 시안(핸드오프 '아래 리본'): 세 칸 그리드. 칸마다
//   제목 11.5px ……… D-6 (--num 15px, 항목 색)
//   2px 막대 (지나온 만큼 항목 색)
//   8/11 → 9/9 (--num 300 10px)
// 예전의 큰 숫자 카드 · 접기 · 긴박도 색 보간은 걷어냈다 — 색은 일정이 가진 색 그대로다.

import { fromKey } from '../lib/date.js';
import { showContextMenu } from '../lib/menu.js';

/** 남은 일수 → 'D-15' / 'D-DAY' / 'D+3' */
function ddayLabel(remaining) {
  if (remaining === 0) return 'D-DAY';
  return remaining > 0 ? `D-${remaining}` : `D+${-remaining}`;
}

/** '9/9' */
function md(key) {
  const d = fromKey(key);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 자정까지 남은 ms. 날짜가 바뀌면 D-Day 가 하루 줄어야 하므로 그때 한 번만 다시 그린다. */
function msUntilNextMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2, 0);
  return Math.max(1000, next - now);
}

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/** 리본에 놓을 칸 수 (시안: repeat(3, 1fr)) */
const SLOTS = 3;

// ============================================================ 팩토리

export function createDashboard({ root, store }) {
  const COLORS = store.COLORS;

  const el = h('div', 'dash-root');
  const grid = h('div', 'dash-grid');
  // 비어 있으면 점선 빈 칸 하나. 일정을 끌어 오면 금박으로 받는다 — 문장으로 설명하지 않는다.
  const empty = h('div', 'dash-empty');
  empty.append(h('span', 'dash-empty__slot', 'D-Day'));
  empty.title = '일정을 여기로 끌어다 놓으면 고정됩니다';
  el.append(grid, empty);
  root.append(el);

  // ---------------------------------------------------------- 끌어다 고정
  //
  // 목록이나 캘린더에서 일정을 여기로 떨어뜨리면 D-Day 에 고정된다.
  // 반복 일정과 날짜 없는 일정은 '남은 기간' 개념이 없어 대상이 아니다.
  const canPin = (task) => !!(task && !task.repeat && task.end);
  const isTaskDrag = (e) =>
    !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('application/x-task-id');

  el.addEventListener('dragover', (e) => {
    if (!isTaskDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('is-drop');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('is-drop');
  });
  el.addEventListener('drop', (e) => {
    el.classList.remove('is-drop');
    const dt = e.dataTransfer;
    if (!dt) return;
    const id = dt.getData('application/x-task-id') || dt.getData('text/plain');
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();

    const task = store.getState().tasks.find((t) => t.id === id);
    if (!canPin(task)) {
      toast(task?.repeat
        ? '반복 일정은 D-Day 에 고정할 수 없습니다'
        : '날짜가 있는 일정만 고정할 수 있습니다');
      return;
    }
    if (store.setPinned(id, true)) toast(`'${task.title || '일정'}' 을(를) 고정했습니다`, true);
    else toast('이미 고정된 일정입니다');
  });

  /** 셸이 토스트를 그린다. 뷰 모듈끼리 직접 부르지 않는다. */
  function toast(text, undo = false) {
    document.dispatchEvent(new CustomEvent('app:toast', { detail: { text, undo } }));
  }

  // ---------------------------------------------------------- 로컬 상태
  const cache = new Map(); // taskId -> 칸 레코드 (DOM 재사용)
  let rafId = 0;
  let midnightTimer = 0;
  let destroyed = false;

  // ---------------------------------------------------------- 칸
  function createCard(id) {
    const card = h('div', 'dash-card');
    card.dataset.id = id;
    card.setAttribute('role', 'button');
    card.tabIndex = 0;

    const top = h('div', 'dash-card__top');
    const title = h('span', 'dash-card__title');
    const num = h('span', 'dash-card__num num');
    top.append(title, num);

    const track = h('div', 'dash-card__track');
    const fill = h('div', 'dash-card__fill');
    track.append(fill);

    const range = h('div', 'dash-card__range num');

    card.append(top, track, range);
    const rec = { el: card, title, num, fill, range, task: null };

    card.addEventListener('click', () => open(rec.task));
    card.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      open(rec.task);
    });
    // 고정 해제 · 마감 역산은 오른쪽 클릭에 둔다 — 시안의 칸에는 단추가 없다.
    // (항목 상세의 'D-Day 고정 해제' · '마감까지 계획' 으로도 같은 일을 한다)
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const t = rec.task;
      if (!t) return;
      showContextMenu(e.clientX, e.clientY, [
        { label: '자세히 · 고치기', onSelect: () => open(t) },
        {
          label: '마감까지 계획 세우기',
          disabled: !store.canPlanDeadline(t),
          // 계획 폼은 투두 패널이 갖고 있다 — 여기서는 부탁만 한다
          onSelect: () => document.dispatchEvent(new CustomEvent('app:plan-deadline', { detail: t.id })),
        },
        { separator: true },
        { label: 'D-Day 고정 해제', onSelect: () => store.togglePinned(t.id) },
      ]);
    });
    return rec;
  }

  /** 칸 클릭 → 해당 날짜로 이동하고 그 항목의 상세를 연다 */
  function open(task) {
    if (!task) return;
    const key = task.start || task.end;
    if (key) store.selectDate(key);
    store.setEditing(task.id);
  }

  function updateCard(rec, t) {
    rec.task = t;
    const label = ddayLabel(t.remaining);
    // 색은 일정이 가진 색 그대로 — 지난 것만 인주색
    const color = t.overdue ? 'var(--seal)' : (COLORS[t.color] || COLORS.blue);
    rec.el.style.setProperty('--item', color);
    rec.el.classList.toggle('is-done', !!t.done);

    if (rec.title.textContent !== t.title) rec.title.textContent = t.title;
    if (rec.num.textContent !== label) rec.num.textContent = label;

    const range = t.start && t.start !== t.end ? `${md(t.start)} → ${md(t.end)}` : md(t.end);
    if (rec.range.textContent !== range) rec.range.textContent = range;

    // 지난 항목은 구간을 다 소진한 것이므로 막대를 가득 채운다
    const pct = t.overdue ? 100 : Math.round(t.progress * 1000) / 10;
    rec.fill.style.width = `${pct}%`;

    rec.el.title = `${t.title} — ${label} (${range})`;
    rec.el.setAttribute('aria-label', `${t.title}, ${label}, ${range}`);
  }

  // ---------------------------------------------------------- 렌더
  function render() {
    const all = store.pinnedTasks();
    // 리본에는 세 칸뿐이다. 가장 임박한 셋을 놓는다.
    const items = all.slice(0, SLOTS);
    grid.hidden = items.length === 0;
    empty.hidden = items.length > 0;
    el.title = all.length > SLOTS ? `고정한 D-Day ${all.length}개 중 임박한 ${SLOTS}개` : '';

    const seen = new Set();
    items.forEach((t, i) => {
      let rec = cache.get(t.id);
      if (!rec) {
        rec = createCard(t.id);
        cache.set(t.id, rec);
      }
      updateCard(rec, t);
      seen.add(t.id);
      if (grid.children[i] !== rec.el) grid.insertBefore(rec.el, grid.children[i] || null);
    });
    for (const [id, rec] of cache) {
      if (seen.has(id)) continue;
      rec.el.remove();
      cache.delete(id);
    }
  }

  function scheduleRender() {
    if (destroyed || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render();
    });
  }

  // 상시 구동 위젯이라 1초 타이머는 돌리지 않는다. 다음 자정에 딱 한 번 깨어나
  // 다시 그리고, 그 자리에서 그 다음 자정을 예약한다(절전/시계 변경도 자동 보정).
  function scheduleMidnight() {
    clearTimeout(midnightTimer);
    midnightTimer = setTimeout(() => {
      midnightTimer = 0;
      if (destroyed) return;
      render();
      scheduleMidnight();
    }, msUntilNextMidnight());
  }

  const unsubscribe = store.subscribe(scheduleRender);

  render();
  scheduleMidnight();

  return {
    destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      clearTimeout(midnightTimer);
      midnightTimer = 0;
      unsubscribe();
      cache.clear();
      root.textContent = '';
    },
  };
}
