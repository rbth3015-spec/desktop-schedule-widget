// 한 줄 문법(todo/parse.js) — 숫자 날짜(@8/15 · @2026-08-15 · @15일 · ~8/20)가 날짜로 읽히는지.
// 실행: npm test  (node --test tests/)
//
// makeKey 가 쓰는 toKey 를 import 하지 않아 숫자 날짜를 적으면 ReferenceError 로 추가 창이 멈췄다.
// 기준일(baseKey)을 넘겨 오늘에 기대지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickInput, resolveRange } from '../src/renderer/todo/parse.js';

test('@월/일 — 그날, 지났으면 내년', () => {
  const p = parseQuickInput('치과 @8/15', '2026-07-01');
  assert.equal(p.title, '치과');
  assert.equal(p.start, '2026-08-15');
  assert.equal(parseQuickInput('@8/5', '2026-08-10').start, '2027-08-05');
});

test('@연-월-일 — 그대로', () => {
  assert.equal(parseQuickInput('회의 @2026-08-15', '2026-07-01').start, '2026-08-15');
});

test('@N일 — 이번 달, 지났으면 다음 달', () => {
  assert.equal(parseQuickInput('정산 @15일', '2026-07-01').start, '2026-07-15');
  assert.equal(parseQuickInput('정산 @15일', '2026-07-20').start, '2026-08-15');
});

test('~월/일 — 끝 날짜', () => {
  const p = parseQuickInput('여행 @내일 ~8/20', '2026-07-01');
  assert.deepEqual(resolveRange(p, '2026-07-01'), { start: '2026-07-02', end: '2026-08-20' });
});

test('달력에 없는 날은 날짜로 읽지 않고 못 읽은 낱말로 남긴다', () => {
  const p = parseQuickInput('@2026-02-30 확인', '2026-07-01');
  assert.equal(p.start, null);
  assert.equal(p.title, '확인');
  assert.deepEqual(p.unknown, ['@2026-02-30']);
});
