// 오늘 시간표.
//
// 목록은 '무엇이 있는지' 는 알려 주지만 '하루가 어떤 모양인지' 는 알려 주지 않는다.
// 3시에 회의가 있다는 걸 읽어도, 그 앞이 비었는지 붙어 있는지는 머리로 계산해야 했다.
//
// 두 시안을 모두 두고 사용자가 고른다(핸드오프의 핵심 결정):
//   - 스트립(기본) : 오전·오후 두 띠에 **글자 없는 네모**. 위치와 길이가 곧 하루의 모양이다.
//                    이름은 아래 체크 목록이 맡는다. 하나에 두 가지를 시키지 않는다.
//   - 압축         : 일정이 있는 시간대만 펼치고 빈 시간은 '3시간 비어 있음' 한 줄로 접는다.
//
// 00:00–23:59 를 통째로 세로로 늘어놓던 초기안은 스크롤이 과해 폐기됐다(핸드오프 기록).
//
// 시각 없는 항목은 두 시안 모두 위쪽 '종일' 띠에 놓는다. 그래야 시각이 있든 없든
// 같은 틀 안에서, 같은 자리에서 체크로 지운다.

import { timeMinutes } from '../lib/date.js';
import { icon } from '../lib/icons.js';

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/** 분 → 'H:MM' */
function fmt(m) {
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** 분 → '1시간 30분' */
function dur(m) {
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  if (!hh) return `${mm}분`;
  return mm ? `${hh}시간 ${mm}분` : `${hh}시간`;
}

/** 지금이 몇 분인가 */
function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

const VIEWS = [
  ['strip', '스트립', '하루의 모양을 네모로',
   '네모의 위치와 길이가 하루의 모양입니다 — 누르면 자세한 창이 뜹니다'],
  ['compressed', '압축', '일정이 있는 시간대만',
   '일정이 있는 시간대만 펼쳐 둡니다 — 빈 시간은 한 줄로 접힙니다'],
];

/**
 * @param {{store: object, onDetail: (id:string, occDate?:string)=>void,
 *          onAdd: ()=>void}} deps
 */
export function createTimetable({ store, onDetail, onAdd }) {
  const el = h('section', 'tt');

  // ---------------------------------------------------------------- 머리
  const head = h('div', 'tt__head');
  const headTitle = h('span', 'tt__title', '시간표');
  const headRule = h('span', 'tt__rule');
  const addBtn = h('button', 'tt__add');
  addBtn.type = 'button';
  addBtn.title = '이 날에 일정 추가';
  addBtn.setAttribute('aria-label', '이 날에 일정 추가');
  addBtn.append(icon('plus'));
  addBtn.addEventListener('click', () => onAdd?.());

  const chips = h('div', 'tt__views');
  const chipBtns = new Map();
  for (const [id, label, hint] of VIEWS) {
    const b = h('button', 'tt__view', label);
    b.type = 'button';
    b.title = hint;
    b.setAttribute('aria-pressed', 'false');
    // 시간표 머리의 칩과 설정의 '오늘 시간표' 행은 **같은 값**을 본다.
    b.addEventListener('click', () => store.setSetting('todayView', id));
    chipBtns.set(id, b);
    chips.append(b);
  }
  head.append(headTitle, headRule, addBtn, chips);

  const note = h('div', 'tt__note');

  // ---------------------------------------------------------------- 종일 띠
  const allDay = h('div', 'tt__allday');
  const allDayKey = h('span', 'tt__key', '종일');
  const allDayBox = h('div', 'tt__chips');
  allDay.append(allDayKey, allDayBox);

  // ---------------------------------------------------------------- 본문
  const body = h('div', 'tt__body');

  // ---------------------------------------------------------------- 자세한 창
  const scrim = h('div', 'tt-peek');
  const peekCard = h('div', 'tt-peek__card');
  scrim.append(peekCard);
  scrim.hidden = true;
  scrim.addEventListener('click', () => closePeek());
  peekCard.addEventListener('click', (e) => e.stopPropagation());

  el.append(head, note, allDay, body, scrim);

  let peekItem = null;

  function closePeek() {
    peekItem = null;
    scrim.hidden = true;
  }

  /** 지금과 견준 한마디 */
  function relText(item, now) {
    if (item.end <= now) return '이미 지났습니다';
    if (item.start <= now) return '지금 진행 중입니다';
    return `${dur(item.start - now)} 뒤입니다`;
  }

  function openPeek(item) {
    peekItem = item;
    const now = nowMinutes();
    peekCard.style.setProperty('--peek-ink', item.color);
    peekCard.replaceChildren();

    const top = h('div', 'tt-peek__top');
    top.append(
      h('span', 'tt-peek__range num', `${fmt(item.start)}–${fmt(item.end)}`),
      h('span', 'tt-peek__len', dur(item.end - item.start)),
    );

    const title = h('div', 'tt-peek__title', item.title || '(제목 없음)');
    if (item.priority >= 1) title.append(h('span', 'tt-peek__bang', item.priority >= 2 ? '!!' : '!'));
    if (item.routine) title.append(h('span', 'tt-peek__routine', '↻'));

    const meta = h('div', 'tt-peek__meta');
    meta.append(
      h('span', 'tt-peek__cap'),
      h('span', null, item.kind),
      h('span', 'tt-peek__hr'),
      h('span', 'tt-peek__rel', relText(item, now)),
    );

    peekCard.append(top, title, meta);

    if (item.notes) peekCard.append(h('div', 'tt-peek__note', item.notes));

    const acts = h('div', 'tt-peek__acts');
    const done = h('button', 'tt-peek__act tt-peek__act--gold', item.done ? '완료 취소' : '완료로 표시');
    done.type = 'button';
    done.addEventListener('click', () => {
      store.toggleDone(item.id, item.occDate);
      closePeek();
    });
    acts.append(done);

    // 반복은 회차 하나만 밀 수 없다 — 눌리는데 아무 일도 안 일어나는 버튼을 두지 않는다
    if (!item.repeat) {
      const later = h('button', 'tt-peek__act', '내일로 미루기');
      later.type = 'button';
      later.addEventListener('click', () => {
        store.moveTask(item.id, item.tomorrow);
        closePeek();
      });
      acts.append(later);
    }

    const more = h('button', 'tt-peek__act', '자세히 · 고치기');
    more.type = 'button';
    more.addEventListener('click', () => {
      closePeek();
      onDetail?.(item.id, item.occDate);
    });

    const close = h('button', 'tt-peek__act tt-peek__act--ghost', '닫기 · Esc');
    close.type = 'button';
    close.addEventListener('click', () => closePeek());

    acts.append(more, close);
    peekCard.append(acts);
    scrim.hidden = false;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !scrim.hidden) {
      e.stopPropagation();
      closePeek();
    }
  }, true);

  // ---------------------------------------------------------------- 그리기

  /** 체크박스 하나. 시간표 어디에서 체크하든 같은 동작이다. */
  function checkbox(item) {
    const b = h('button', 'tt-check');
    b.type = 'button';
    b.setAttribute('role', 'checkbox');
    b.setAttribute('aria-checked', String(!!item.done));
    b.classList.toggle('is-on', !!item.done);
    if (item.done) b.append(icon('check'));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      store.toggleDone(item.id, item.occDate);
    });
    return b;
  }

  /** 종일 칩. 시각 없는 일정이 시간 표현 위 같은 틀에 들어온다. */
  function renderAllDay(items) {
    allDayBox.replaceChildren();
    allDay.hidden = items.length === 0;
    for (const item of items) {
      const chip = h('span', 'tt-allday__chip');
      chip.style.setProperty('--item', item.color);
      chip.classList.toggle('is-done', !!item.done);
      chip.append(checkbox(item), h('span', 'tt-allday__title', item.title || '(제목 없음)'));
      if (item.meta) chip.append(h('span', 'tt-allday__meta num', item.meta));
      chip.addEventListener('click', () => onDetail?.(item.id, item.occDate));
      allDayBox.append(chip);
    }
  }

  /**
   * 스트립 — 오전·오후 두 띠.
   *
   * 핸드오프의 기본 띠는 08:00–14:00 / 14:00–21:30 이지만, 그 밖의 시각에 일정이 있으면
   * 그 일정이 화면에서 통째로 사라진다. 기본 모양은 지키되 **자료가 넘치면 띠를 넓힌다**.
   */
  function renderStrip(items, now) {
    const first = items.length ? Math.min(...items.map((t) => t.start)) : 480;
    const last = items.length ? Math.max(...items.map((t) => t.end)) : 1290;
    const lanes = [
      { name: '오전', s: Math.min(480, first - (first % 60)), e: 840 },
      { name: '오후', s: 840, e: Math.max(1290, last + (60 - (last % 60)) % 60) },
    ];

    const wrap = h('div', 'tt-strip');
    for (const lane of lanes) {
      const span = lane.e - lane.s;
      const pct = (m) => (((m - lane.s) / span) * 100).toFixed(2);

      const row = h('div', 'tt-strip__lane');
      row.append(h('span', 'tt__key', lane.name));

      const canvas = h('span', 'tt-strip__canvas');
      for (let m = lane.s; m <= lane.e - 60; m += 120) {
        const tick = h('span', 'tt-strip__tick');
        tick.style.left = `${pct(m)}%`;
        const label = h('span', 'tt-strip__ticklabel num', fmt(m));
        label.style.left = `${pct(m)}%`;
        canvas.append(tick, label);
      }
      canvas.append(h('span', 'tt-strip__base'));

      for (const item of items) {
        if (item.start >= lane.e || item.end <= lane.s) continue;
        const from = Math.max(item.start, lane.s);
        const to = Math.min(item.end, lane.e);
        const bar = h('span', 'tt-strip__bar');
        bar.style.left = `${pct(from)}%`;
        bar.style.width = `${(((to - from) / span) * 100).toFixed(2)}%`;
        bar.style.setProperty('--item', item.color);
        bar.classList.toggle('is-past', item.end <= now);
        // 글자가 없으므로 툴팁이 이름을 맡는다
        bar.title = `${item.title} · ${fmt(item.start)}–${fmt(item.end)}`;
        bar.addEventListener('click', () => openPeek(item));
        canvas.append(bar);
      }

      if (now >= lane.s && now < lane.e) {
        const mark = h('span', 'tt-strip__now');
        mark.style.left = `${pct(now)}%`;
        mark.append(h('span', 'tt-strip__nowdot'),
                    h('span', 'tt-strip__nowlabel num', `지금 ${fmt(now)}`));
        canvas.append(mark);
      }

      row.append(canvas);
      wrap.append(row);
    }

    // 이름은 이 목록이 맡는다
    const list = h('div', 'tt-strip__list');
    for (const item of items) {
      const line = h('span', 'tt-strip__item');
      line.classList.toggle('is-past', item.end <= now);
      line.append(
        checkbox(item),
        h('span', 'tt-strip__at num', fmt(item.start)),
        capOf(item),
        h('span', 'tt-strip__name', item.title || '(제목 없음)'),
      );
      if (item.routine) {
        const r = h('span', 'tt-strip__routine', '↻');
        r.title = '루틴';
        line.append(r);
      }
      line.addEventListener('click', () => openPeek(item));
      list.append(line);
    }
    if (items.length) wrap.append(list);
    return wrap;
  }

  function capOf(item) {
    const cap = h('span', 'tt-cap');
    cap.style.background = item.color;
    return cap;
  }

  /**
   * 압축 — 일정이 있는 시간대만 펼치고 빈 시간은 한 줄로 접는다.
   * 60분 이상 비면 접힌 줄, 그보다 짧으면 그만큼의 여백만 둔다.
   */
  function renderCompressed(items, now) {
    const wrap = h('div', 'tt-comp');
    let prev = null;

    for (const item of items) {
      const gap = prev == null ? 0 : item.start - prev;

      if (gap >= 60) {
        const nowIn = prev <= now && now < item.start;
        const row = h('div', 'tt-comp__gap');
        row.append(h('span', 'tt-comp__at num', fmt(prev)));
        const line = h('span', 'tt-comp__gapline');
        const label = h('span', 'tt-comp__gaplabel',
          `${dur(gap)} 비어 있음${nowIn ? ` · 지금 ${fmt(now)}` : ''}`);
        label.classList.toggle('is-now', nowIn);
        line.append(h('span', 'tt-comp__dash tt-comp__dash--short'), label,
                    h('span', 'tt-comp__dash'),
                    h('span', 'tt-comp__open', '펼치기'));
        row.append(line);
        wrap.append(row);
      } else if (gap > 0) {
        const spacer = h('div', 'tt-comp__space');
        spacer.style.height = `${Math.round(gap * 0.45)}px`;
        wrap.append(spacer);
      }

      const row = h('div', 'tt-comp__row');
      row.append(h('span', 'tt-comp__at num', fmt(item.start)));

      const card = h('span', 'tt-comp__card');
      card.style.setProperty('--item', item.color);
      card.style.minHeight = `${Math.max(36, Math.round((item.end - item.start) * 0.7))}px`;
      card.classList.toggle('is-past', item.end <= now);

      const line1 = h('span', 'tt-comp__line');
      line1.append(checkbox(item), h('span', 'tt-comp__title', item.title || '(제목 없음)'));
      if (item.priority >= 1) {
        line1.append(h('span', 'tt-comp__bang', item.priority >= 2 ? '!!' : '!'));
      }
      if (item.routine) line1.append(h('span', 'tt-comp__routine', '↻'));
      if (item.link) line1.append(icon('link'));
      line1.append(h('span', 'tt-comp__range num', `${fmt(item.start)}–${fmt(item.end)}`));
      card.append(line1);

      if (item.notes) card.append(h('span', 'tt-comp__note', item.notes));

      card.addEventListener('click', () => openPeek(item));
      row.append(card);
      wrap.append(row);
      prev = item.end;
    }
    return wrap;
  }

  // ---------------------------------------------------------------- 바깥에서 부르는 것

  /**
   * @param {string} key 'YYYY-MM-DD'
   * @param {string} tomorrow 내일 키 (미루기용)
   */
  function update(key, tomorrow) {
    const st = store.getState();
    const view = st.settings.todayView === 'compressed' ? 'compressed' : 'strip';

    for (const [id, b] of chipBtns) {
      b.classList.toggle('is-on', id === view);
      b.setAttribute('aria-pressed', String(id === view));
    }
    note.textContent = (VIEWS.find((v) => v[0] === view) || VIEWS[0])[3];

    // 시각 있는 루틴은 하루의 모양에 속하므로 시간띠에 그린다(↻ 로 표시).
    // 시각 없는 루틴은 넣지 않는다 — 바로 아래 '루틴' 섹션이 전담하고,
    // 거기에 연속 기록과 후보 제안이 붙어 있다. 같은 것을 두 자리에 두지 않는다.
    const raw = [
      ...store.tasksOnDate(key),
      ...store.routinesOn(key).filter((t) => t.startTime),
    ];
    const items = raw.map((t) => {
      const start = t.startTime ? timeMinutes(t.startTime) : null;
      const end = t.endTime ? timeMinutes(t.endTime) : (start == null ? null : start + 60);
      return {
        id: t.id,
        occDate: t.occDate,
        title: t.title,
        notes: t.notes,
        done: !!t.done,
        color: store.COLORS[t.color] || store.COLORS.blue,
        priority: t.priority || 0,
        link: t.link,
        repeat: t.repeat,
        routine: !!t.repeat?.routine,
        kind: t.repeat?.routine ? `루틴 · ${store.repeatLabel(t.repeat)}` : '일정',
        meta: t.repeat ? store.repeatLabel(t.repeat) : '',
        tomorrow,
        start,
        end: end != null && end > start ? end : (start == null ? null : start + 60),
      };
    });

    const timed = items.filter((t) => t.start != null).sort((a, b) => a.start - b.start);
    renderAllDay(items.filter((t) => t.start == null));

    const now = nowMinutes();
    body.replaceChildren(
      timed.length
        ? (view === 'strip' ? renderStrip(timed, now) : renderCompressed(timed, now))
        : h('div', 'tt__empty', '시각을 정해 둔 일정이 없습니다'),
    );

    // 열려 있던 자세한 창은 자료가 바뀌면 닫는다 — 옛 값이 남아 있는 편이 더 나쁘다
    if (peekItem) closePeek();

    return items.length;
  }

  return { el, update, closePeek };
}
