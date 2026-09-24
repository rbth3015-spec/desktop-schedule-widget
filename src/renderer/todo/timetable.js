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

import { timeMinutes, fromKey } from '../lib/date.js';
import { icon } from '../lib/icons.js';

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/** 분 → 'HH:MM' (시안의 fmt 그대로 — 시도 두 자리) */
function fmt(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
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

/** 'YYYY-MM-DD' — 오늘 */
function todayKeyLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** '9/4' */
function md(key) {
  const d = fromKey(key);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const VIEWS = [
  ['strip', '스트립', '하루의 모양'],
  ['compressed', '압축', '시간 순서'],
];

/**
 * 종일 칩의 오른쪽 작은 글자 — 무엇이 이 날에 걸려 있는지.
 *   루틴     '루틴 · 매일 · 5일째'
 *   장기 계획 '9/1 → 9/9 · 진행 중 · 3/11'
 *   미룬 일   '3번 미룸'
 */
function metaOfFactory(store) {
  return function metaOf(t, key, routine) {
    if (routine) {
      const streak = store.routineStreak(t, key);
      return `루틴 · ${store.repeatLabel(t.repeat)}${streak >= 2 ? ` · ${streak}일째` : ''}`;
    }
    if (t.repeat) return store.repeatLabel(t.repeat);
    const parts = [];
    if (t.start && t.end && t.end > t.start) {
      const state = key === t.end ? '오늘 마감' : (key === t.start ? '시작' : '진행 중');
      parts.push(`${md(t.start)} → ${md(t.end)} · ${state}`);
      const prog = store.spanProgress(t);
      if (prog) parts.push(`${prog.done}/${prog.total}`);
    }
    if (t.deferCount >= 3) parts.push(`${t.deferCount}번 미룸`);
    return parts.join(' · ');
  };
}

/** 칩에 커서를 올렸을 때 */
function tipOf(t) {
  return t.title || '(제목 없음)';
}

/**
 * 시간표에는 추가 단추를 두지 않는다 — 일정을 만드는 입구는 날짜 머리의 '＋ 일정 추가' 하나다.
 * @param {{store: object, onDetail: (id:string, occDate?:string)=>void}} deps
 */
export function createTimetable({ store, onDetail }) {
  const el = h('section', 'tt');
  const metaOf = metaOfFactory(store);

  // ---------------------------------------------------------------- 머리
  const head = h('div', 'tt__head');
  const headTitle = h('span', 'tt__title', '시간표');
  const headRule = h('span', 'tt__rule');

  const chips = h('div', 'tt__views');
  const chipBtns = new Map();
  for (const [id, label, hint] of VIEWS) {
    const b = h('button', 'tt__view', label);
    b.type = 'button';
    b.title = hint;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => store.setSetting('todayView', id));
    chipBtns.set(id, b);
    chips.append(b);
  }
  head.append(headTitle, headRule, chips);


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

  el.append(head, allDay, body);
  // 자세한 창의 스크림은 펼침면 위에 깐다(시안) — 오른쪽 면 안에 두면 면만 어두워진다
  (document.querySelector('.panes') || el).append(scrim);

  let peekItem = null;
  // 압축 시안에서 펼쳐 둔 빈 시간(시작 분). 날짜가 바뀌면 다시 접는다.
  const unfolded = new Set();
  let lastKey = null;
  let lastArgs = null;
  const rerender = () => { if (lastArgs) update(...lastArgs); };

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

    const more = h('button', 'tt-peek__act tt-peek__act--more', '자세히');
    more.type = 'button';
    more.addEventListener('click', () => {
      closePeek();
      onDetail?.(item.id, item.occDate);
    });

    const close = h('button', 'tt-peek__act tt-peek__act--ghost', '닫기');
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

  /**
   * 달력으로 끌어 날짜를 옮길 수 있게 한다(목록 줄과 같은 끌기 형식).
   * 반복 일정은 규칙 하나를 공유하므로 한 회차만 옮길 수 없다 — 끌리지 않게 둔다.
   */
  function dragSource(node, item) {
    if (item.repeat) return;
    node.draggable = true;
    node.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData('application/x-task-id', item.id);
      e.dataTransfer.setData('text/plain', item.title || '');
      e.dataTransfer.effectAllowed = 'move';
    });
  }

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
    for (const item of items) {
      const chip = h('span', 'tt-allday__chip');
      chip.style.setProperty('--item', item.color);
      chip.classList.toggle('is-done', !!item.done);
      chip.append(checkbox(item), h('span', 'tt-allday__title', item.title || '(제목 없음)'));
      if (item.meta) chip.append(h('span', 'tt-allday__meta num', item.meta));
      chip.title = item.tip || item.title;
      chip.addEventListener('click', () => onDetail?.(item.id, item.occDate));
      dragSource(chip, item);
      allDayBox.append(chip);
    }
    // 시각 없는 일이 없는 날은 띠째 걷는다 — 빈 띠는 할 말이 없다
    allDay.hidden = !items.length;
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
        // 띠 끝 가까이에서는 라벨을 선의 왼쪽으로 — 오른쪽으로 두면 면 밖으로 잘린다
        mark.classList.toggle('is-end', (now - lane.s) / span > 0.8);
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
      dragSource(line, item);
      list.append(line);
    }
    // 비어 있으면 목록 자리째 걷는다 — 빈 띠가 이미 '비어 있다' 를 보여 준다
    if (items.length) wrap.append(list);
    return wrap;
  }

  /** 압축 시안에서 시각 일정이 하나도 없을 때 — 접힌 빈 시간 한 줄과 같은 모양 */
  function emptyDay() {
    const wrap = h('div', 'tt-comp');
    const row = h('div', 'tt-comp__gap is-empty');
    const line = h('span', 'tt-comp__gapline');
    line.append(h('span', 'tt-comp__dash tt-comp__dash--short'),
                h('span', 'tt-comp__gaplabel', '비어 있음'),
                h('span', 'tt-comp__dash'));
    row.append(h('span', 'tt-comp__at num'), line);
    wrap.append(row);
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

      if (gap >= 60 && unfolded.has(prev)) {
        // 펼친 빈 시간 — 짧은 틈과 같은 비율로 비워 두고, 누르면 다시 접는다
        const from = prev;
        const row = h('div', 'tt-comp__unfold');
        row.style.height = `${Math.round(gap * 0.45)}px`;
        row.title = '접기';
        row.append(h('span', 'tt-comp__at num'), h('span', 'tt-comp__gapline'));
        row.addEventListener('click', () => { unfolded.delete(from); rerender(); });
        wrap.append(row);
      } else if (gap >= 60) {
        const nowIn = prev <= now && now < item.start;
        const from = prev;
        const row = h('div', 'tt-comp__gap');
        row.addEventListener('click', () => { unfolded.add(from); rerender(); });
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
      dragSource(card, item);
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
    lastArgs = [key, tomorrow];
    if (key !== lastKey) { unfolded.clear(); lastKey = key; }
    const st = store.getState();
    const view = st.settings.todayView === 'compressed' ? 'compressed' : 'strip';

    for (const [id, b] of chipBtns) {
      b.classList.toggle('is-on', id === view);
      b.setAttribute('aria-pressed', String(id === view));
    }

    // 루틴도 같은 틀에 앉는다(시안). 시각 있는 루틴은 시간띠 네모 + ↻,
    // 시각 없는 루틴은 종일 띠의 점선 칩이다. 어느 쪽이든 같은 자리에서 체크로 지운다.
    const raw = [
      ...store.tasksOnDate(key),
      ...store.routinesOn(key),
    ];
    const items = raw.map((t) => {
      const start = t.startTime ? timeMinutes(t.startTime) : null;
      const end = t.endTime ? timeMinutes(t.endTime) : (start == null ? null : start + 60);
      const routine = !!t.repeat?.routine;
      const kind = routine ? `루틴 · ${store.repeatLabel(t.repeat)}` : (t.repeat ? `반복 · ${store.repeatLabel(t.repeat)}` : '일정');
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
        routine,
        kind,
        meta: metaOf(t, key, routine),
        tip: tipOf(t),
        tomorrow,
        start,
        end: end != null && end > start ? end : (start == null ? null : start + 60),
      };
    });

    const timed = items.filter((t) => t.start != null).sort((a, b) => a.start - b.start);
    renderAllDay(items.filter((t) => t.start == null));

    // '지금' 은 오늘에만 뜻이 있다. 지난날은 전부 지난 것으로, 앞날은 전부 남은 것으로 그린다.
    const today = todayKeyLocal();
    const now = key === today ? nowMinutes() : (key < today ? 1440 : -1);
    body.replaceChildren(
      view === 'strip'
        ? renderStrip(timed, now)
        : (timed.length ? renderCompressed(timed, now) : emptyDay()),
    );

    // 열려 있던 자세한 창은 자료가 바뀌면 닫는다 — 옛 값이 남아 있는 편이 더 나쁘다
    if (peekItem) closePeek();

    return items.length;
  }

  return { el, update, closePeek };
}
