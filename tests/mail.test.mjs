// 의견 보내기 — Gmail 쓰기 창 주소(lib/mail.js).
// 실행: npm test  (node --test tests/)
//
// mailto: 는 윈도우에서 Gmail 이 메일 처리기로 등록돼 있지 않으면 빈 크롬만 띄운다(#28).
// 그래서 '메일 쓰기'는 Gmail 쓰기 화면을 https 로 연다 — 받는 사람 · 제목 · 본문이 그대로 건너가야 한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gmailComposeUrl } from '../src/renderer/lib/mail.js';

const NL = String.fromCharCode(10);

test('Gmail 쓰기 화면 — https://mail.google.com/mail/?view=cm&fs=1 에 받는 사람 · 제목 · 본문', () => {
  const url = gmailComposeUrl({ to: 'rbth3015@gmail.com', subject: '일정관리 비서 — 의견', body: `첫 줄${NL}버전: 1.8.2` });
  assert.ok(url.startsWith('https://mail.google.com/mail/?view=cm&fs=1&to='), url);
  const u = new URL(url);
  assert.equal(u.protocol, 'https:');
  assert.equal(u.host, 'mail.google.com');
  assert.equal(u.pathname, '/mail/');
  assert.deepEqual([...u.searchParams.keys()], ['view', 'fs', 'to', 'su', 'body']);
  assert.equal(u.searchParams.get('view'), 'cm');
  assert.equal(u.searchParams.get('fs'), '1');
  assert.equal(u.searchParams.get('to'), 'rbth3015@gmail.com');
  assert.equal(u.searchParams.get('su'), '일정관리 비서 — 의견');
  assert.equal(u.searchParams.get('body'), `첫 줄${NL}버전: 1.8.2`);
});

test('주소를 깨는 글자(& ? # = + 줄바꿈 · 공백)도 그대로 건너간다', () => {
  const subject = 'A&B ? C#D = E+F';
  const body = `1 + 1 = 2${NL}${NL}a&su=가짜#끝`;
  const u = new URL(gmailComposeUrl({ to: 'me@example.com', subject, body }));
  assert.equal(u.searchParams.get('su'), subject);
  assert.equal(u.searchParams.get('body'), body);
  assert.equal(u.searchParams.getAll('su').length, 1, '본문이 제목을 덮어쓰지 않는다');
  assert.equal(u.hash, '', '# 이 주소를 자르지 않는다');
});

test('메인의 외부 링크 검사(new URL → href)를 거쳐도 주소가 바뀌지 않는다', () => {
  const url = gmailComposeUrl({
    to: 'rbth3015@gmail.com',
    subject: '일정관리 비서 — 의견',
    body: ['어떤 점이 불편했나요? 또는 어떤 기능이 있었으면 하나요?', '', '', '---', '버전: 1.8.2', '환경: Windows'].join(NL),
  });
  assert.equal(new URL(url).href, url);
  assert.ok(!/[\s]/.test(url), '공백 · 줄바꿈이 날것으로 남지 않는다');
});

test('제목 · 본문을 비우면 빈 칸으로 둔다', () => {
  const u = new URL(gmailComposeUrl({ to: 'me@example.com' }));
  assert.equal(u.searchParams.get('to'), 'me@example.com');
  assert.equal(u.searchParams.get('su'), '');
  assert.equal(u.searchParams.get('body'), '');
});
