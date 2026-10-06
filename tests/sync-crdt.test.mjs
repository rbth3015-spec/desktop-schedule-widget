// 동기화 핵심(crdt.js) — 시계 · 합치기 · diff · 펼치기 · 스냅샷.
// 실행: npm test  (node --test tests/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA, VERSION, makeStamp, parseStamp, createClock, maxStamp,
  mergeRecords, recordKey, splitKey, isAlive, materialize,
  diffLive, applyToLive, toSnapshot, readSnapshot, liveKeys,
} from '../src/renderer/sync/crdt.js';

const PC = 'pc-aaaaaaaaaa';
const PHONE = 'android-bbbbbbbb';

/** 테스트용 시계 — now 를 손으로 넘긴다 */
function clockAt(device, start = 1_700_000_000_000) {
  const c = createClock(device);
  let now = start;
  return { next: () => c.next(now), tick: (ms = 1) => { now += ms; }, observe: (s) => c.observe(s), last: () => c.last(), raw: c };
}

const emptyLive = () => ({ tasks: [], todos: [], journal: {}, retro: {} });

function task(id, patch = {}) {
  return {
    id, title: '제목', notes: '', start: '2026-10-06', end: '2026-10-06',
    startTime: null, endTime: null, done: false, priority: 0, color: 'blue',
    tags: [], order: 0, createdAt: 1, doneAt: null, doneDates: [], exceptions: [], ...patch,
  };
}

// ---------------------------------------------------------------- 스탬프 · 시계

test('스탬프는 고정 폭이라 문자열 비교가 시간 비교다', () => {
  assert.equal(makeStamp(5, 3, PC), `0000000000005:0003:${PC}`);
  assert.ok(makeStamp(10, 0, PC) > makeStamp(9, 9999, PC));
  assert.deepEqual(parseStamp(makeStamp(42, 7, PHONE)), { ms: 42, counter: 7, device: PHONE });
  assert.equal(parseStamp('garbage'), null);
  assert.equal(parseStamp(`0000000000005:0003:대문자X`), null);
  assert.equal(maxStamp(null, 'b'), 'b');
  assert.equal(maxStamp('a', 'b'), 'b');
});

test('시계는 같은 밀리초 안에서 카운터를 올리고 늘 앞으로만 간다', () => {
  const c = createClock(PC);
  const a = c.next(1000);
  const b = c.next(1000);
  const d = c.next(999);            // 벽시계가 뒤로 가도
  assert.ok(a < b && b < d);
  assert.equal(parseStamp(b).counter, 1);
  assert.equal(parseStamp(d).ms, 1000);
});

test('남의 스탬프를 본 뒤의 스탬프는 그보다 크다 (시계가 어긋나도)', () => {
  const c = createClock(PC);
  const remote = makeStamp(5_000, 4, PHONE);   // 폰 시계가 앞서 있다
  c.observe(remote);
  const mine = c.next(1_000);
  assert.ok(mine > remote, `${mine} > ${remote}`);
});

test('카운터가 넘치면 밀리초를 하나 올린다', () => {
  const c = createClock(PC, makeStamp(1000, 9999, PC));
  const s = parseStamp(c.next(1000));
  assert.deepEqual([s.ms, s.counter], [1001, 0]);
});

// ---------------------------------------------------------------- 합치기

test('합치기: 더 큰 스탬프가 이기고, 다른 필드는 둘 다 남는다', () => {
  const local = { 'task:t1': { title: { v: 'PC 제목', t: makeStamp(10, 0, PC) }, notes: { v: '', t: makeStamp(1, 0, PC) } } };
  const remote = { 'task:t1': { title: { v: '폰 제목', t: makeStamp(5, 0, PHONE) }, notes: { v: '폰 메모', t: makeStamp(6, 0, PHONE) } } };
  const { records, changed } = mergeRecords(local, remote);
  assert.equal(records['task:t1'].title.v, 'PC 제목');
  assert.equal(records['task:t1'].notes.v, '폰 메모');
  assert.deepEqual([...changed], ['task:t1']);
  assert.equal(local['task:t1'].notes.v, '', '입력은 건드리지 않는다');
});

test('합치기는 교환·결합·멱등이다', () => {
  const A = { 'task:t1': { title: { v: 'a', t: makeStamp(3, 0, PC) } }, 'todo:x': { text: { v: 'x', t: makeStamp(1, 0, PC) } } };
  const B = { 'task:t1': { title: { v: 'b', t: makeStamp(4, 0, PHONE) }, _del: { v: false, t: makeStamp(2, 0, PHONE) } } };
  const C = { 'task:t1': { notes: { v: 'c', t: makeStamp(9, 0, 'pc-cccccc') } }, 'journal:2026-10-06': { text: { v: '하루', t: makeStamp(1, 0, PHONE) } } };
  const m = (x, y) => mergeRecords(x, y).records;
  assert.deepEqual(m(A, B), m(B, A));
  assert.deepEqual(m(m(A, B), C), m(A, m(B, C)));
  assert.deepEqual(m(m(A, B), B), m(A, B));
  assert.equal(mergeRecords(m(A, B), B).changed.size, 0);
});

test('합치기는 이상한 키·레지스터를 버린다', () => {
  const { records } = mergeRecords({}, {
    'bogus:1': { title: { v: 1, t: makeStamp(1, 0, PC) } },
    'task:ok': { title: { v: 'x', t: 'not-a-stamp' }, notes: { v: 'y', t: makeStamp(1, 0, PC) }, broken: 3 },
  });
  assert.deepEqual(Object.keys(records), ['task:ok']);
  assert.deepEqual(Object.keys(records['task:ok']), ['notes']);
});

test('삭제(묘비)가 동시 편집을 이긴다', () => {
  const del = { 'task:t1': { _del: { v: true, t: makeStamp(5, 0, PHONE) } } };
  const edit = { 'task:t1': { title: { v: '고침', t: makeStamp(6, 0, PC) } } };
  const { records } = mergeRecords(edit, del);
  assert.equal(isAlive(records['task:t1']), false);
  assert.equal(materialize('task:t1', records['task:t1']), null);
});

// ---------------------------------------------------------------- 키 · 펼치기

test('레코드 키', () => {
  assert.equal(recordKey('task', 't_1'), 'task:t_1');
  assert.deepEqual(splitKey('retro:w:2026-10-04'), { kind: 'retro', id: 'w:2026-10-04' });
});

test('펼치기: 집합 원소는 true 인 것만 정렬해서 배열로', () => {
  const t = makeStamp(1, 0, PC);
  const rec = {
    title: { v: '루틴', t },
    'doneDates@2026-10-07': { v: true, t },
    'doneDates@2026-10-05': { v: true, t },
    'doneDates@2026-10-06': { v: false, t },
    _del: { v: false, t },
  };
  assert.deepEqual(materialize('task:r1', rec), {
    id: 'r1', title: '루틴', doneDates: ['2026-10-05', '2026-10-07'],
  }, '원소 레지스터가 없는 집합(exceptions)은 싣지 않는다');
  assert.equal(materialize('journal:2026-10-06', { text: { v: '', t } }), null);
  assert.equal(materialize('journal:2026-10-06', { text: { v: '좋은 하루', t } }), '좋은 하루');
});

// ---------------------------------------------------------------- diff

test('diff: 새 레코드는 모든 필드에 스탬프, 같은 값이면 다시 찍지 않는다', () => {
  const c = clockAt(PC);
  const live = { ...emptyLive(), tasks: [task('t1')] };
  const first = diffLive({}, live, c, []);
  assert.deepEqual([...first.changed], ['task:t1']);
  assert.equal(first.records['task:t1'].title.v, '제목');
  assert.equal(first.records['task:t1'].id, undefined, 'id 는 키에 있다');
  assert.deepEqual(first.known, ['task:t1']);

  const again = diffLive(first.records, live, c, first.known);
  assert.equal(again.changed.size, 0);
  assert.equal(again.records, first.records, '바뀐 게 없으면 같은 객체');
});

test('diff: 바뀐 필드만 새 스탬프', () => {
  const c = clockAt(PC);
  const base = diffLive({}, { ...emptyLive(), tasks: [task('t1')] }, c, []);
  c.tick(10);
  const next = diffLive(base.records, { ...emptyLive(), tasks: [task('t1', { title: '새 제목' })] }, c, base.known);
  const r0 = base.records['task:t1'];
  const r1 = next.records['task:t1'];
  assert.equal(r1.title.v, '새 제목');
  assert.ok(r1.title.t > r0.title.t);
  assert.equal(r1.notes.t, r0.notes.t);
});

test('diff: 배열·객체 값은 내용으로 비교한다(키 순서 무관)', () => {
  const c = clockAt(PC);
  const t1 = task('t1', { tags: ['a', 'b'], repeat: { freq: 'weekly', interval: 1, until: null, days: [1, 3], routine: false } });
  const base = diffLive({}, { ...emptyLive(), tasks: [t1] }, c, []);
  const same = task('t1', { tags: ['a', 'b'], repeat: { routine: false, days: [1, 3], until: null, interval: 1, freq: 'weekly' } });
  assert.equal(diffLive(base.records, { ...emptyLive(), tasks: [same] }, c, base.known).changed.size, 0);
});

test('diff: 회차 완료는 원소 레지스터로', () => {
  const c = clockAt(PC);
  const base = diffLive({}, { ...emptyLive(), tasks: [task('r', { doneDates: ['2026-10-05'] })] }, c, []);
  c.tick();
  const next = diffLive(base.records, { ...emptyLive(), tasks: [task('r', { doneDates: ['2026-10-06'] })] }, c, base.known);
  const rec = next.records['task:r'];
  assert.equal(rec['doneDates@2026-10-05'].v, false);
  assert.equal(rec['doneDates@2026-10-06'].v, true);
  assert.equal(rec.doneDates, undefined, '배열 통째로는 담지 않는다');
});

test('diff: 화면에서 사라진 레코드는 묘비, 다시 나타나면 되살린다', () => {
  const c = clockAt(PC);
  const base = diffLive({}, { ...emptyLive(), tasks: [task('t1')] }, c, []);
  c.tick();
  const gone = diffLive(base.records, emptyLive(), c, base.known);
  assert.equal(isAlive(gone.records['task:t1']), false);
  assert.deepEqual(gone.known, []);
  c.tick();
  const back = diffLive(gone.records, { ...emptyLive(), tasks: [task('t1')] }, c, gone.known);
  assert.equal(isAlive(back.records['task:t1']), true);
});

test('diff: known 에 없던 레코드(정규화가 거부한 것)는 묘비를 만들지 않는다', () => {
  const c = clockAt(PC);
  const remoteOnly = { 'todo:bad': { text: { v: '날짜 없는 할 일', t: makeStamp(1, 0, PHONE) } } };
  const res = diffLive(remoteOnly, emptyLive(), c, []);
  assert.equal(res.changed.size, 0);
  assert.equal(isAlive(res.records['todo:bad']), true);
});

test('diff: 위젯이 모르는 필드는 보존한다', () => {
  const c = clockAt(PC);
  const records = { 'task:t1': { futureField: { v: 42, t: makeStamp(1, 0, PHONE) } } };
  const res = diffLive(records, { ...emptyLive(), tasks: [task('t1')] }, c, ['task:t1']);
  assert.equal(res.records['task:t1'].futureField.v, 42);
});

test('diff: 한 줄 기록·돌아보기 — 지우면 빈 글', () => {
  const c = clockAt(PC);
  const base = diffLive({}, { ...emptyLive(), journal: { '2026-10-06': '좋음' }, retro: { 'w:2026-10-04': '한 주' } }, c, []);
  assert.deepEqual(base.known.sort(), ['journal:2026-10-06', 'retro:w:2026-10-04']);
  c.tick();
  const cleared = diffLive(base.records, emptyLive(), c, base.known);
  assert.equal(cleared.records['journal:2026-10-06'].text.v, '');
  assert.equal(materialize('journal:2026-10-06', cleared.records['journal:2026-10-06']), null);
});

// ---------------------------------------------------------------- 화면 상태 반영

test('applyToLive: 바뀐 키만 덮고, 지운 것은 빼고, 새 것은 더한다', () => {
  const t = makeStamp(9, 0, PHONE);
  const live = { ...emptyLive(), tasks: [task('keep'), task('edit'), task('gone')], journal: { '2026-10-01': '옛날' } };
  const records = {
    'task:edit': { title: { v: '폰에서 고침', t } },
    'task:gone': { _del: { v: true, t } },
    'task:new': { title: { v: '폰에서 추가', t }, start: { v: null, t } },
    'journal:2026-10-06': { text: { v: '새 기록', t } },
  };
  const next = applyToLive(live, records, new Set(Object.keys(records)));
  assert.deepEqual(next.tasks.map((x) => x.id), ['keep', 'edit', 'new']);
  assert.equal(next.tasks[1].title, '폰에서 고침');
  assert.equal(next.tasks[1].notes, '', '레코드에 없는 필드는 화면 값 유지');
  assert.equal(next.tasks[2].start, null);
  assert.deepEqual(next.journal, { '2026-10-01': '옛날', '2026-10-06': '새 기록' });
  assert.equal(live.tasks.length, 3, '입력은 그대로');
});

test('liveKeys', () => {
  assert.deepEqual(liveKeys({ tasks: [task('a')], todos: [{ id: 'b', text: 'x', day: '2026-10-06' }], journal: { '2026-10-06': 'j', '2026-10-07': '' }, retro: {} }).sort(),
    ['journal:2026-10-06', 'task:a', 'todo:b']);
});

// ---------------------------------------------------------------- 두 기기 수렴

test('PC 와 폰이 따로 고쳐도 서로의 파일을 읽으면 같은 상태가 된다', () => {
  const pc = clockAt(PC, 1000);
  const phone = clockAt(PHONE, 1000);
  // PC 가 일정을 만들고, 폰이 받는다
  let pcRec = diffLive({}, { ...emptyLive(), tasks: [task('t1')] }, pc, []).records;
  let phoneRec = mergeRecords({}, pcRec).records;
  // 동시에 — PC 는 제목, 폰은 완료
  pc.tick(5); phone.tick(3);
  pcRec = diffLive(pcRec, { ...emptyLive(), tasks: [task('t1', { title: 'PC 제목' })] }, pc, ['task:t1']).records;
  phoneRec = diffLive(phoneRec, { ...emptyLive(), tasks: [task('t1', { done: true, doneAt: 5 })] }, phone, ['task:t1']).records;
  const a = mergeRecords(pcRec, phoneRec).records;
  const b = mergeRecords(phoneRec, pcRec).records;
  assert.deepEqual(a, b);
  const t1 = materialize('task:t1', a['task:t1']);
  assert.equal(t1.title, 'PC 제목');
  assert.equal(t1.done, true);
});

// ---------------------------------------------------------------- 스냅샷

test('스냅샷 왕복과 검증', () => {
  const t = makeStamp(1, 0, PC);
  const records = { 'task:t1': { title: { v: 'x', t } } };
  const snap = toSnapshot(records, { id: PC, name: 'PC', app: 'widget/1.7.0' }, t, 1234);
  assert.equal(snap.schema, SCHEMA);
  assert.equal(snap.version, VERSION);
  assert.equal(snap.savedAt, 1234);
  const back = readSnapshot(JSON.parse(JSON.stringify(snap)));
  assert.equal(back.ok, true);
  assert.deepEqual(back.records, records);
  assert.equal(back.device.id, PC);

  assert.equal(readSnapshot({ schema: 'other' }).ok, false);
  assert.equal(readSnapshot(null).ok, false);
  const newer = readSnapshot({ ...snap, version: 2 });
  assert.equal(newer.ok, false);
  assert.match(newer.error, /버전/);
});
