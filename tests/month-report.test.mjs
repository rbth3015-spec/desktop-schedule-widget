// 한 달 결산(store.monthReport) — '가장 바쁜 주'는 그 달의 주에서만 고른다.
// 실행: npm test  (node --test tests/)
//
// 주 이름은 계획 화면과 같은 셈법이다: 수요일이 든 달의 주, 그 수요일 날짜로 몇째 주인지 센다.
// 수요일이 다른 달인 경계 주는 그 달의 주가 아니다 — 세면 '다섯째 주'처럼 없는 이름이 나온다.
//
// store.js 는 렌더러 모듈이라 window.api 로 읽고 쓴다 — 흉내 낸 것으로 바꿔 끼운다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

let data = {};
globalThis.window = {
  api: {
    loadData: async () => data,
    saveData: async () => ({ ok: true }),
  },
};
// window 를 둔 뒤에 불러온다
const store = await import('../src/renderer/store.js');

/** 그날 하루짜리 일정 */
const day = (id, start, extra = {}) => ({ id, title: id, start, end: start, done: false, tags: [], ...extra });

async function report(tasks, ym) {
  data = { tasks };
  await store.init();
  return store.monthReport(ym);
}

test('경계 주(수요일이 지난달)에 몰려도 그 달에 없는 다섯째 주가 되지 않는다', async () => {
  // 2026-10-01 은 목요일 — 9/27–10/3 주의 수요일은 9/30 이라 9월의 주다
  const r = await report([
    day('a', '2026-10-01'), day('b', '2026-10-02'), day('c', '2026-10-03'),
    day('d', '2026-10-15'), day('e', '2026-10-16'),
  ], '2026-10');
  assert.equal(r.total, 5);                       // 결산의 건수에는 그대로 든다
  assert.deepEqual(r.busiest, { index: 1, n: 2 }); // 10/11–10/17 = 10월 둘째 주
});

test('경계 주(수요일이 다음달)는 다음 달 첫째 주로 세지 않는다', async () => {
  // 11/29–12/5 주의 수요일은 12/2 — 12월의 첫째 주다
  const r = await report([
    day('a', '2026-11-29'), day('b', '2026-11-30'),
    day('c', '2026-11-03'),
  ], '2026-11');
  assert.equal(r.total, 3);
  assert.deepEqual(r.busiest, { index: 0, n: 1 }); // 11/1–11/7 = 11월 첫째 주, 한 건
});

test('그 달의 주에 일정이 없으면 가장 바쁜 주는 없다', async () => {
  const r = await report([day('a', '2026-10-01'), day('b', '2026-10-02')], '2026-10');
  assert.equal(r.total, 2);
  assert.equal(r.busiest, null);
});

test('같은 수면 앞 주', async () => {
  const r = await report([
    day('a', '2026-10-05'), day('b', '2026-10-06'),
    day('c', '2026-10-20'), day('d', '2026-10-21'),
  ], '2026-10');
  assert.deepEqual(r.busiest, { index: 0, n: 2 }); // 10/4–10/10 = 첫째 주
});

test('반복 일정은 세지 않는다', async () => {
  const r = await report([
    day('a', '2026-10-14', { repeat: { freq: 'weekly', interval: 1, until: null, days: null } }),
    day('b', '2026-10-27'),
  ], '2026-10');
  assert.equal(r.total, 1);
  assert.deepEqual(r.busiest, { index: 3, n: 1 }); // 10/25–10/31 = 넷째 주
});
