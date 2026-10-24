// Claude 연동 시트 — 렌더러 쪽 접착. 시트를 읽고 쓰는 일과 주기는 메인(src/main/claude-bridge.js)이 한다.
//
//   내보내기   메인이 달라고 하면(켜질 때 · 5분마다) 곧바로, 일정 · 할 일이 바뀌면 30초 모아서
//             store 에서 읽은 재료를 넘긴다. 반복 회차를 펼치는 일은 store 만 할 수 있다.
//   받은편지함 메인이 검사해 넘긴 요청을 store 의 액션(addTasks · addTodos)으로 만든다 —
//             받은함과 같은 길이라 화면 · 휴대폰 동기화는 평소대로 돈다.

import { todayKey, addDays } from './lib/date.js';

/** 바뀐 뒤 모으는 시간 — 처음 바뀐 때부터 센다(계속 누르는 동안 한없이 밀리지 않게) */
const GATHER_MS = 30 * 1000;
const PAST_DAYS = 14;
const FUTURE_DAYS = 90;
/** 끝낸 할 일은 최근 이만큼만 싣는다 */
const DONE_DAYS = 14;
const JOURNAL_DAYS = 30;

/** 반복을 사람 말로 — 요일을 고른 매주 반복은 '매주 월·수·금' */
function repeatText(store, r) {
  const label = store.repeatLabel(r);
  const days = r?.freq === 'weekly' && Array.isArray(r.days) && r.days.length;
  return days && label !== '평일' && label !== '주말' ? `매주 ${label}` : label;
}

/**
 * 시트에 내보낼 재료 — 메인이 모양을 다시 추려 행으로 바꾼다.
 * 일정은 지난 14일 ~ 앞으로 90일을 하루씩, 달력이 그날 그리는 그대로다
 * (반복은 회차마다 · 여러 날 일정은 날마다 · 루틴은 빼고 · 검색어 · 태그 필터는 보지 않는다).
 */
export function collectExport(store, today = todayKey()) {
  const from = addDays(today, -PAST_DAYS);
  const to = addDays(today, FUTURE_DAYS);
  const events = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    for (const t of store.tasksOnDate(day, { filtered: false })) {
      events.push({
        id: t.id,
        date: day,
        // 여러 날 일정의 시각은 첫날의 시작 · 마지막 날의 끝이다
        start: t.start === day ? t.startTime || '' : '',
        end: (t.end || t.start) === day ? t.endTime || '' : '',
        title: t.title,
        tags: t.tags,
        done: !!t.done,
        repeat: t.repeat ? repeatText(store, t.repeat) : '',
      });
    }
  }

  const s = store.getState();
  const doneSince = addDays(today, -DONE_DAYS);
  const todos = s.todos
    .filter((t) => !t.done || (t.doneOn && t.doneOn >= doneSince))
    .sort((a, b) => (a.day !== b.day ? (a.day < b.day ? -1 : 1) : a.order - b.order || a.createdAt - b.createdAt))
    .map((t) => {
      const task = t.taskId ? s.tasks.find((x) => x.id === t.taskId) : null;
      return {
        id: t.id,
        text: t.text,
        day: t.day,
        done: !!t.done,
        linked: task?.start ? { date: task.start, start: task.startTime || '', end: task.endTime || '' } : null,
      };
    });

  const journalFrom = addDays(today, -(JOURNAL_DAYS - 1));
  const journal = store.journalBetween(journalFrom, today).map(({ key, text }) => ({ date: key, text }));

  return { today, from, to, doneSince, journalFrom, events, todos, journal };
}

/**
 * 메인이 검사해 넘긴 요청을 일정 · 할 일로 만든다. 일정은 한 번에, 할 일은 날마다 한 번에(되돌리기도 그만큼).
 * 같은 요청이 다시 와도(답이 늦어 메인이 다음 주기에 또 보낸 경우) 하나만 만든다 —
 * 일정은 메인이 요청마다 정한 id 로, 할 일은 made 로 가린다.
 *
 * @param {object} store
 * @param {object[]} requests {key, kind: 'todo'|'event', text | title, date, start?, end?, notes?, tags?, taskId?}
 * @param {Map<string, string>} [made] 이번 실행에서 만든 할 일 — 요청 key → 할 일 id
 * @returns {{results: {key: string, ok: boolean, id?: string, error?: string}[],
 *            added: {events: number, todos: number}, actions: number}}
 *   actions — 쓴 store 액션 수(되돌리기 단계 수)
 */
export function applyRequests(store, requests, made = new Map()) {
  const list = Array.isArray(requests) ? requests.filter((r) => r && typeof r === 'object') : [];
  const results = [];
  const added = { events: 0, todos: 0 };
  let actions = 0;

  // 일정 — 색은 그 태그에 가장 많이 쓴 안료(테마 띠와 같은 셈), 없으면 기본
  const have = new Set(store.getState().tasks.map((t) => t.id));
  const tagColor = new Map(store.tagSummary().map((x) => [x.tag, x.color]));
  const fresh = [];
  for (const r of list.filter((x) => x.kind === 'event')) {
    if (have.has(r.taskId)) {
      results.push({ key: r.key, ok: true, id: r.taskId });
      continue;
    }
    const tags = Array.isArray(r.tags) ? r.tags.map(String) : [];
    fresh.push({
      key: r.key,
      patch: {
        id: r.taskId,
        title: String(r.title || ''),
        start: r.date,
        end: r.date,
        startTime: r.start || null,
        endTime: r.end || null,
        notes: String(r.notes || ''),
        tags,
        color: tagColor.get(tags[0]) || 'blue',
      },
    });
  }
  if (fresh.length) {
    store.addTasks(fresh.map((x) => x.patch), `Claude 연동 일정 ${fresh.length}건`);
    actions += 1;
    const now = new Set(store.getState().tasks.map((t) => t.id));
    for (const { key, patch } of fresh) {
      if (now.has(patch.id)) {
        added.events += 1;
        results.push({ key, ok: true, id: patch.id });
      } else {
        results.push({ key, ok: false, error: '일정을 넣지 못했습니다' });
      }
    }
  }

  // 할 일 — 날짜마다 addTodos 한 번. id 는 액션이 정하므로 새로 생긴 것을 순서대로 짝짓는다
  const byDay = new Map();
  for (const r of list.filter((x) => x.kind === 'todo')) {
    if (made.has(r.key)) {
      results.push({ key: r.key, ok: true, id: made.get(r.key) });
      continue;
    }
    if (!byDay.has(r.date)) byDay.set(r.date, []);
    byDay.get(r.date).push(r);
  }
  for (const [day, rs] of byDay) {
    const before = new Set(store.getState().todos.map((t) => t.id));
    const n = store.addTodos(rs.map((r) => String(r.text || '')), day, `Claude 연동 할 일 ${rs.length}개`);
    if (n) actions += 1;
    const created = store.getState().todos.filter((t) => !before.has(t.id));
    rs.forEach((r, i) => {
      const td = n === rs.length ? created[i] : null;
      if (td) {
        made.set(r.key, td.id);
        added.todos += 1;
        results.push({ key: r.key, ok: true, id: td.id });
      } else {
        results.push({ key: r.key, ok: false, error: '할 일을 넣지 못했습니다' });
      }
    });
  }

  return { results, added, actions };
}

/**
 * @param {{store: object, notify?: (added: {events: number, todos: number}, actions: number) => void}} deps
 *   notify — 받은 것을 알린다(토스트). 오류는 알리지 않는다 — 설정 줄에만 있다
 */
export function wireClaudeBridge({ store, notify }) {
  const api = window.api?.bridge;
  if (!api) return;

  // 메인이 한 번이라도 달라고 했으면(= 켜져 있으면) 바뀔 때마다 보낸다. 꺼졌다고 답하면 다시 달랄 때까지 쉰다
  let on = false;
  let timer = null;
  let last = '';
  const made = new Map();

  function push(force) {
    clearTimeout(timer);
    timer = null;
    if (!store.getState().ready) return;
    const data = collectExport(store);
    const json = JSON.stringify(data);
    if (!force && json === last) return;
    last = json;
    api.push(data).then((r) => { if (r && r.enabled === false) on = false; }).catch(() => {});
  }

  store.subscribe(() => {
    if (on && !timer) timer = setTimeout(() => push(false), GATHER_MS);
  });
  api.onWant(() => {
    on = true;
    push(true);
  });
  api.onInbox(async (requests) => {
    const { results, added, actions } = applyRequests(store, requests, made);
    if (added.events || added.todos) notify?.(added, actions);
    // 디스크에 쓴 뒤에 답한다 — 메인은 이 답을 받고서야 '처리했다' 고 적는다
    await store.flushSave();
    return results;
  });
  api.ready();
}
