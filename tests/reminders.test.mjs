// 일정 알림 — 알림 시각(store.remindTime · dueReminders)과 알림 스케줄러(reminders.js).
// 실행: npm test  (node --test tests/)
//
// store.js 는 렌더러 모듈이라 window.api 로 읽고 쓰고 알림을 띄운다 — 흉내 낸 것으로 바꿔 끼운다.
// 지금 시각은 node 의 가짜 시계로 고정한다. 시각은 전부 이 PC 의 벽시계 시각이다(위젯과 같은 계산).

import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

let data = {};
const sent = [];   // 띄운 알림
globalThis.window = {
  api: {
    loadData: async () => data,
    saveData: async () => ({ ok: true }),
    reminder: { notify: async (payload) => { sent.push(payload); return { ok: true }; } },
  },
};
// window 를 둔 뒤에 불러온다
const store = await import('../src/renderer/store.js');
const { startReminders } = await import('../src/renderer/reminders.js');

/** 2026년 벽시계 시각 → epoch ms. 달은 1부터 */
const clock = (mo, d, h = 0, mi = 0, s = 0) => new Date(2026, mo - 1, d, h, mi, s).getTime();

/** 일정 하나를 읽어 들인 것으로 하고, 정리된 그 일정을 돌려준다 */
async function load(task) {
  data = { tasks: [task] };
  await store.init();
  return store.getState().tasks[0];
}

/** 매주 수요일 반복 — 첫 회차 2026-10-07(수) */
const weekly = (patch = {}) => ({
  id: 'w', title: '주간 회의', start: '2026-10-07', end: '2026-10-07',
  repeat: { freq: 'weekly' }, ...patch,
});

/** 지금을 now 로 두고 알림 시각을 묻는다 */
function remindTimeAt(t, now) {
  mock.timers.setTime(now);
  return store.remindTime(t, now);
}

/** 지금을 now 로 두고 스케줄러를 한 번 돌린다 — 그때 띄운 알림들 */
async function ringAt(now) {
  mock.timers.setTime(now);
  sent.length = 0;
  const scheduler = startReminders(store);   // 켜자마자 한 번 확인한다
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.destroy();
  return [...sent];
}

beforeEach(() => mock.timers.enable({ apis: ['Date', 'setInterval'], now: clock(10, 1) }));
afterEach(() => mock.timers.reset());

// ---------------------------------------------------------------- 반복 일정의 알림 시각

test('매주 반복 · 하루 전 오후 6시 — 회차마다 그 전날 18:00 이 알림 시각이다', async () => {
  const t = await load(weekly({ remind: '1@18:00' }));
  assert.equal(remindTimeAt(t, clock(10, 6, 17, 59)), null, '첫 회차(10-07)의 알림 전에는 아직 없다');
  assert.equal(remindTimeAt(t, clock(10, 6, 18, 0, 30)), clock(10, 6, 18), '첫 회차의 하루 전');
  assert.equal(remindTimeAt(t, clock(10, 13, 17, 59)), clock(10, 6, 18), '다음 알림 전에는 지난 알림 그대로');
  assert.equal(remindTimeAt(t, clock(10, 13, 18, 0, 30)), clock(10, 13, 18), '10-14 회차의 하루 전 — 일주일 전 값이 아니다');
  assert.equal(remindTimeAt(t, clock(10, 14, 0, 0, 30)), clock(10, 13, 18), '회차 날 0시가 지나도 그대로');
});

test('3일 전 · 일주일 전 알림도 회차마다 그만큼 앞선다', async () => {
  let t = await load(weekly({ remind: '3@18:00' }));
  assert.equal(remindTimeAt(t, clock(10, 11, 18, 0, 30)), clock(10, 11, 18), '10-14 회차의 3일 전(일요일)');

  t = await load(weekly({ remind: '7@18:00' }));
  assert.equal(remindTimeAt(t, clock(9, 30, 18, 0, 30)), clock(9, 30, 18), '첫 회차의 일주일 전 — 반복이 시작되기 전이어도');
  assert.equal(remindTimeAt(t, clock(10, 7, 18, 0, 30)), clock(10, 7, 18), '10-14 회차의 일주일 전');
});

test('시작 몇 분 전 알림이 자정을 넘어가도 제시각 — 수요일 0:30 일정의 1시간 전은 화요일 23:30', async () => {
  const t = await load(weekly({ startTime: '00:30', remind: '-60m' }));
  assert.equal(remindTimeAt(t, clock(10, 13, 23, 30, 30)), clock(10, 13, 23, 30));
});

test('건너뛴 회차는 알림도 없고, 반복이 끝난 뒤에는 새 알림이 없다', async () => {
  const t = await load(weekly({
    remind: '1@18:00', exceptions: ['2026-10-14'], repeat: { freq: 'weekly', until: '2026-10-21' },
  }));
  assert.equal(remindTimeAt(t, clock(10, 13, 18, 0, 30)), clock(10, 6, 18), '10-14 는 건너뛰었다 — 그 전 알림 그대로');
  assert.equal(remindTimeAt(t, clock(10, 20, 18, 0, 30)), clock(10, 20, 18), '10-21 회차의 하루 전');
  assert.equal(remindTimeAt(t, clock(10, 27, 18, 0, 30)), clock(10, 20, 18), '10-28 은 반복이 끝난 뒤');
});

test('이미 체크한 회차는 알림을 건너뛴다 — 폰 앱과 같은 규칙', async () => {
  // 10-07 회차 알림은 10-06 18:00 에 나갔고, 10-14 회차는 미리 체크해 두었다
  await load(weekly({ remind: '1@18:00', remindedAt: clock(10, 6, 18, 0, 30), doneDates: ['2026-10-14'] }));
  const dueAt = (now) => { mock.timers.setTime(now); return store.dueReminders(now).map((t) => t.id); };
  assert.deepEqual(dueAt(clock(10, 13, 18, 0, 30)), [], '체크한 10-14 회차의 하루 전');
  assert.deepEqual(dueAt(clock(10, 20, 18, 0, 30)), ['w'], '체크 안 한 10-21 회차는 울린다');
});

// 원래 잘 되던 것 — 고치면서 바뀌면 안 된다
test('당일 · 몇 분 전 알림과 한 번짜리 일정은 예전 그대로', async () => {
  let t = await load(weekly({ remind: '0@09:00' }));
  assert.equal(remindTimeAt(t, clock(10, 14, 9, 0, 30)), clock(10, 14, 9), '회차 날 오전 9시');

  t = await load(weekly({ startTime: '10:00', remind: '-30m' }));
  assert.equal(remindTimeAt(t, clock(10, 14, 9, 30, 30)), clock(10, 14, 9, 30), '회차 시작 30분 전');

  t = await load({ id: 'o', title: '치과', start: '2026-10-20', end: '2026-10-20', remind: '1@18:00' });
  assert.equal(remindTimeAt(t, clock(10, 1)), clock(10, 19, 18), '한 번짜리는 아직 멀어도 그 시각');
});

// ---------------------------------------------------------------- 스케줄러

test('스케줄러 — 하루 전 알림이 회차마다 한 번씩 울린다(조용히 지나가지 않는다)', async () => {
  await load(weekly({ remind: '1@18:00' }));
  assert.equal((await ringAt(clock(10, 6, 18, 0, 30))).length, 1, '10-06 18:00 — 첫 회차(10-07)의 하루 전');
  assert.equal((await ringAt(clock(10, 7, 9))).length, 0, '회차 당일에 또 울리지 않는다');
  assert.equal((await ringAt(clock(10, 13, 17, 59))).length, 0, '아직 다음 알림 전');
  assert.equal((await ringAt(clock(10, 13, 18, 0, 30))).length, 1, '10-14 회차의 하루 전');
  assert.equal((await ringAt(clock(10, 14, 0, 0, 30))).length, 0, '0시가 지나도 다시 울리지 않는다');
  assert.equal((await ringAt(clock(10, 20, 18, 0, 30))).length, 1, '10-21 회차의 하루 전');
});

test('알림 본문 — 반복 일정은 첫 회차가 아니라 울리는 그 회차의 날짜를 쓴다', async () => {
  const bodiesAt = async (now) => (await ringAt(now)).map((n) => n.body);

  await load(weekly({ remind: '1@18:00' }));
  assert.deepEqual(await bodiesAt(clock(10, 13, 18, 0, 30)), ['10월 14일 (수)']);

  await load(weekly({ startTime: '10:00', remind: '-30m' }));
  assert.deepEqual(await bodiesAt(clock(10, 21, 9, 30, 30)), ['10월 21일 (수) 오전 10:00']);

  // 한 번짜리 기간 일정은 예전 그대로 — 시작일 ~ 끝날
  await load({ id: 'o', title: '출장', start: '2026-10-20', end: '2026-10-22', remind: '1@18:00' });
  assert.deepEqual(await bodiesAt(clock(10, 19, 18, 0, 30)), ['10월 20일 (화) ~ 10월 22일']);
});
