// Claude 연동 시트 — 렌더러 쪽. store 에서 내보낼 재료를 읽고(collectExport),
// 메인이 검사해 넘긴 요청을 store 액션으로 만든다(applyRequests). 메인의 행 변환 · 받은편지함 해석과 맞물리는지도 본다.
// 실행: npm test
//
// store.js 는 렌더러 모듈이라 window.api 로 읽고 쓴다 — 흉내 낸 것으로 바꿔 끼운다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

let data = {};
globalThis.window = {
  api: {
    loadData: async () => data,
    saveData: async () => ({ ok: true }),
  },
};
// window 를 둔 뒤에 불러온다
const store = await import('../src/renderer/store.js');
const { collectExport, applyRequests } = await import('../src/renderer/claude-bridge.js');
const require = createRequire(import.meta.url);
const { parseInbox, exportRows, sanitizeExport, INBOX_HEAD } = require('../src/main/claude-bridge.js');

const TODAY = '2026-10-23';   // 금요일

async function load(d) {
  data = d;
  await store.init();
}

const SAMPLE = {
  tasks: [
    { id: 'a', title: '치과', start: '2026-10-23', end: '2026-10-23', startTime: '15:00', endTime: '16:00', tags: ['건강'] },
    // 매주 월 · 수 — 첫 회차 2026-10-05(월), 10/21 회차는 끝냈다
    { id: 'w', title: '스터디', start: '2026-10-05', end: '2026-10-05', startTime: '19:00',
      repeat: { freq: 'weekly', days: [1, 3] }, doneDates: ['2026-10-21'] },
    { id: 'wd', title: '출근', start: '2026-10-01', end: '2026-10-01', repeat: { freq: 'weekly', days: [1, 2, 3, 4, 5] } },
    { id: 'r', title: '운동', start: '2026-10-01', end: '2026-10-01', repeat: { freq: 'daily', routine: true } },
    { id: 's', title: '학회', start: '2026-10-27', end: '2026-10-29', startTime: '09:00', endTime: '18:00' },
    { id: 'i', title: '언젠가 할 일', start: null, end: null },
    { id: 'old', title: '지난 일', start: '2026-10-01', end: '2026-10-01' },
    { id: 'far', title: '먼 일', start: '2027-03-01', end: '2027-03-01' },
  ],
  todos: [
    { id: 't5', text: '내일 할 것', day: '2026-10-24', done: false, order: 1 },
    { id: 't1', text: '견적서', day: '2026-10-20', done: false, order: 2 },
    { id: 't2', text: '메일', day: '2026-10-21', done: true, doneOn: '2026-10-22', order: 3 },
    { id: 't3', text: '오래전에 끝낸 것', day: '2026-09-01', done: true, doneOn: '2026-09-02', order: 4 },
    { id: 't4', text: '자료 준비', day: '2026-10-23', done: false, taskId: 'a', order: 5 },
  ],
  journal: { '2026-10-22': '좋은 하루', '2026-09-24': '경계 안', '2026-09-23': '경계 밖' },
};

test('내보낼 재료: 지난 14일 ~ 앞으로 90일을 하루씩 — 반복은 회차마다, 여러 날 일정은 날마다, 루틴 · 언젠가는 빼고', async () => {
  await load(structuredClone(SAMPLE));
  const x = collectExport(store, TODAY);
  assert.deepEqual([x.today, x.from, x.to, x.doneSince, x.journalFrom],
    ['2026-10-23', '2026-10-09', '2027-01-21', '2026-10-09', '2026-09-24']);

  const ids = new Set(x.events.map((e) => e.id));
  assert.deepEqual([...ids].sort(), ['a', 's', 'w', 'wd'], '루틴 · 언젠가 · 범위 밖은 없다');

  const study = x.events.filter((e) => e.id === 'w');
  assert.equal(study.length, 30, '10/12 ~ 1/20 의 월 · 수');
  assert.deepEqual(study.find((e) => e.date === '2026-10-21'),
    { id: 'w', date: '2026-10-21', start: '19:00', end: '', title: '스터디', tags: [], done: true, repeat: '매주 월·수' });
  assert.equal(study.find((e) => e.date === '2026-10-26').done, false, '회차마다 따로');
  assert.equal(x.events.find((e) => e.id === 'wd').repeat, '평일');

  assert.deepEqual(x.events.filter((e) => e.id === 's').map((e) => [e.date, e.start, e.end]), [
    ['2026-10-27', '09:00', ''],
    ['2026-10-28', '', ''],
    ['2026-10-29', '', '18:00'],
  ], '여러 날 일정의 시각은 첫날 시작 · 마지막 날 끝');

  assert.deepEqual(x.todos.map((t) => t.id), ['t1', 't2', 't4', 't5'], '날짜순 · 오래전에 끝낸 것은 빼고');
  assert.deepEqual(x.todos.find((t) => t.id === 't4').linked, { date: '2026-10-23', start: '15:00', end: '16:00' });
  assert.deepEqual(x.journal.map((j) => j.date).sort(), ['2026-09-24', '2026-10-22']);
});

test('내보낼 재료가 메인의 행 변환을 그대로 통과한다', async () => {
  await load(structuredClone(SAMPLE));
  const rows = exportRows(sanitizeExport(collectExport(store, TODAY)), { now: new Date(2026, 9, 23, 9, 0).getTime() });
  assert.ok(rows.events.some((r) => r.join('|') === 'a|2026-10-23|15:00|16:00|치과|#건강|아니오|'));
  assert.ok(rows.todos.some((r) => r.join('|') === 't4|자료 준비|2026-10-23|아니오|2026-10-23 15:00–16:00'));
  assert.deepEqual(rows.journal.slice(2), [['2026-09-24', '경계 안'], ['2026-10-22', '좋은 하루']]);
});

test('받은 요청: 일정은 정해 준 id 로 한 번에, 할 일은 날마다 한 번에 — #공부와 그 태그의 색, 같은 요청은 하나만', async () => {
  await load({
    tasks: [{ id: 'g', title: '기출', start: '2026-10-20', end: '2026-10-20', tags: ['공부'], color: 'green' }],
    todos: [],
  });
  // 메인이 시트를 읽어 넘기는 모양 그대로
  const { items } = parseInbox([
    [...INBOX_HEAD],
    ['r1', '할일', '단어 30개', '2026-10-26', '', '', '교재 3장'],
    ['r2', '할일', '듣기 2회', '2026-10-26'],
    ['r3', '할일', '오답 정리', '2026-10-27'],
    ['r4', '일정', '모의고사', '2026-10-31', '09:00', '12:00', '시험장 3층'],
  ], { sheet: 'ss', today: TODAY });
  const requests = items.map((x) => (x.request.kind === 'event' ? { ...x.request, taskId: 't_fixed' } : x.request));

  const made = new Map();
  const r = applyRequests(store, requests, made);
  assert.deepEqual(r.added, { events: 1, todos: 3 });
  assert.equal(r.actions, 3, '일정 한 번 + 할 일 날짜 둘 — 되돌리기도 세 칸');
  assert.ok(r.results.every((x) => x.ok));

  const s = store.getState();
  const ev = s.tasks.find((t) => t.id === 't_fixed');
  assert.deepEqual([ev.title, ev.start, ev.end, ev.startTime, ev.endTime, ev.notes, ev.tags, ev.color],
    ['모의고사', '2026-10-31', '2026-10-31', '09:00', '12:00', '시험장 3층', ['공부'], 'green']);
  assert.deepEqual(s.todos.map((t) => [t.text, t.day]), [
    ['단어 30개 — 교재 3장 #공부', '2026-10-26'],
    ['듣기 2회 #공부', '2026-10-26'],
    ['오답 정리 #공부', '2026-10-27'],
  ]);
  const byKey = new Map(r.results.map((x) => [x.key, x.id]));
  assert.equal(s.todos.find((t) => t.text.startsWith('듣기')).id, byKey.get('ss:r2'), '돌려준 id 가 실제 할 일이다');

  // 답이 늦어 메인이 같은 요청을 또 보냈다
  const again = applyRequests(store, requests, made);
  assert.deepEqual(again.added, { events: 0, todos: 0 });
  assert.equal(again.actions, 0);
  assert.deepEqual(again.results.map((x) => x.id), r.results.map((x) => x.id));
  assert.equal(store.getState().todos.length, 3);
  assert.equal(store.getState().tasks.length, 2);

  // 되돌리기 한 번은 마지막 날짜 묶음만
  store.undo();
  assert.equal(store.getState().todos.length, 2);
});
