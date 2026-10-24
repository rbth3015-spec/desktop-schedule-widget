// Claude 연동 시트 — 받은편지함 해석 · 내보내기 행(순수 함수), 구글 로그인 권한,
// 그리고 가짜 구글(토큰 · 드라이브 · 시트)로 켜기 → 내보내기 → 받은편지함 한 바퀴.
// 실행: npm test

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createClaudeBridge, parseInbox, exportRows, sanitizeExport, readDate, readTime, relocate, findHeader, statusData,
  taskIdFor, INBOX_HEAD, INBOX_GUIDE, TITLE,
} = require('../src/main/claude-bridge.js');
const { createGoogleAuth, SCOPE, FILE_SCOPE } = require('../src/main/google-auth.js');

// ---------------------------------------------------------------- 받은편지함 해석

/** 받은편지함 한 줄 — 칸 이름으로 적는다 */
const line = (o) => INBOX_HEAD.map((h) => o[h] ?? '');
/** 위젯이 만든 모양 그대로 — 1행 안내, 2행 머리글 */
const sheetOf = (...rows) => [[INBOX_GUIDE], [...INBOX_HEAD], ...rows];
const parse = (values, opts = {}) => parseInbox(values, { sheet: 'ss', today: '2026-10-23', ...opts });

test('받은편지함: 할 일 · 일정을 읽고 빈 줄은 건너뛴다', () => {
  const r = parse(sheetOf(
    line({ 요청ID: 'a1', 종류: '할일', '내용/제목': '영어 단어 30개', 날짜: '2026-10-24' }),
    [],
    line({}),
    line({ 요청ID: 'a2', 종류: '일정', '내용/제목': '모의고사', 날짜: '2026-10-25', 시작: '9:00', 끝: '12:00', 메모: '시험장 3층' }),
  ));
  assert.equal(r.error, null);
  assert.deepEqual(r.items.map((x) => [x.row, x.action]), [[3, 'apply'], [6, 'apply']], '시트의 행 번호(1부터)');
  assert.deepEqual(r.items[0].request,
    { kind: 'todo', text: '영어 단어 30개 #공부', date: '2026-10-24', key: 'ss:a1', requestId: 'a1' });
  assert.deepEqual(r.items[1].request, {
    kind: 'event', title: '모의고사', date: '2026-10-25', start: '09:00', end: '12:00',
    notes: '시험장 3층', tags: ['공부'], key: 'ss:a2', requestId: 'a2',
  });
});

test('받은편지함: 상태가 비었거나 대기인 줄만 — 반영됨 · 오류 · 사람이 적은 다른 말은 그대로 둔다', () => {
  const r = parse(sheetOf(
    line({ 요청ID: 'a', 종류: '할일', '내용/제목': 'x', 상태: '대기' }),
    line({ 요청ID: 'b', 종류: '할일', '내용/제목': 'x', 상태: '반영됨' }),
    line({ 요청ID: 'c', 종류: '할일', '내용/제목': 'x', 상태: '오류' }),
    line({ 요청ID: 'd', 종류: '할일', '내용/제목': 'x', 상태: '보류' }),
    line({ 요청ID: 'e', 종류: '할일', '내용/제목': 'x' }),
  ));
  assert.deepEqual(r.items.map((x) => x.requestId), ['a', 'e']);
});

test('받은편지함: 날짜를 비운 할 일은 오늘, 메모는 글 뒤에, #공부는 한 번만, 길면 태그를 남기고 자른다', () => {
  const r = parse(sheetOf(
    line({ 요청ID: 'a', 종류: '할 일', '내용/제목': '  복습   2회독 ', 메모: '오답 노트' }),
    line({ 요청ID: 'b', 종류: '할일', '내용/제목': '단어 #공부', 시작: '09:00' }),
    line({ 요청ID: 'c', 종류: '할일', '내용/제목': '가'.repeat(300) }),
  ));
  const [a, b, c] = r.items.map((x) => x.request);
  assert.equal(a.text, '복습 2회독 — 오답 노트 #공부');
  assert.equal(a.date, '2026-10-23');
  assert.equal(b.text, '단어 #공부');
  assert.equal(b.start, undefined, '할 일의 시각은 쓰지 않는다');
  assert.equal(c.text.length, 200);
  assert.ok(c.text.endsWith(' #공부'));
});

test('받은편지함: 잘못된 날짜 · 시각은 이유를 단 오류', () => {
  const cases = [
    [{ 날짜: '10/25' }, /날짜는 YYYY-MM-DD/],
    [{ 날짜: '2026-02-30' }, /날짜는 YYYY-MM-DD/],
    [{ 날짜: '내일' }, /날짜는 YYYY-MM-DD/],
    [{ 시작: '25:00' }, /시작은 HH:MM/],
    [{ 시작: '9시' }, /시작은 HH:MM/],
    [{ 시작: '09:00', 끝: '오후 13:00' }, /끝은 HH:MM/],
    [{ 끝: '10:00' }, /끝 시각만/],
    [{ 시작: '10:00', 끝: '09:30' }, /이르거나 같습니다/],
  ];
  for (const [cells, reason] of cases) {
    const r = parse(sheetOf(line({ 요청ID: 'x', 종류: '일정', '내용/제목': '모의고사', ...cells })));
    assert.equal(r.items[0].action, 'error', JSON.stringify(cells));
    assert.match(r.items[0].reason, reason, JSON.stringify(cells));
  }
  // 시트 서식이 풀려 날짜 · 시각 값으로 돌아온 것도 읽는다
  const ok = parse(sheetOf(line({ 요청ID: 'y', 종류: '일정', '내용/제목': 'a', 날짜: '2026. 10. 25', 시작: '오후 2:30:00', 끝: '4:00 PM' })));
  assert.deepEqual([ok.items[0].request.date, ok.items[0].request.start, ok.items[0].request.end], ['2026-10-25', '14:30', '16:00']);
});

test('받은편지함: 종류 오타 · 빈 종류 · 빈 내용은 오류', () => {
  const r = parse(sheetOf(
    line({ 요청ID: 'a', 종류: '할일ㅇ', '내용/제목': 'x' }),
    line({ 요청ID: 'b', 종류: 'todo', '내용/제목': 'x' }),
    line({ 요청ID: 'c', 종류: '', '내용/제목': 'x' }),
    line({ 요청ID: 'd', 종류: '일정', '내용/제목': '  ' }),
  ));
  assert.deepEqual(r.items.map((x) => x.action), ['error', 'error', 'error', 'error']);
  assert.match(r.items[0].reason, /'할일' 또는 '일정'.*할일ㅇ/);
  assert.match(r.items[1].reason, /todo/);
  assert.match(r.items[2].reason, /종류가 비어/);
  assert.match(r.items[3].reason, /내용\/제목이 비어/);
});

test('받은편지함: 요청ID 가 없거나 한 번에 같은 요청ID 가 두 번이면 오류', () => {
  const r = parse(sheetOf(
    line({ 요청ID: '', 종류: '할일', '내용/제목': 'x' }),
    line({ 요청ID: 'a', 종류: '할일', '내용/제목': 'x' }),
    line({ 요청ID: 'a', 종류: '할일', '내용/제목': 'y' }),
  ));
  assert.deepEqual(r.items.map((x) => x.action), ['error', 'apply', 'error']);
  assert.match(r.items[0].reason, /요청ID가 비어/);
  assert.match(r.items[2].reason, /4행/);
});

test('받은편지함: 이미 처리한 요청 — 같은 내용이면 결과만 되적고, 다른 내용이면 오류', () => {
  const first = parse(sheetOf(line({ 요청ID: 'a', 종류: '할일', '내용/제목': '단어' })));
  const processed = { 'ss:a': { at: 1, result: 'td1', sig: first.items[0].sig } };

  const again = parse(sheetOf(line({ 요청ID: 'a', 종류: '할일', '내용/제목': '단어' })), { processed });
  assert.deepEqual(again.items.map((x) => [x.action, x.result]), [['done', 'td1']]);

  const changed = parse(sheetOf(line({ 요청ID: 'a', 종류: '할일', '내용/제목': '다른 일' })), { processed });
  assert.equal(changed.items[0].action, 'error');
  assert.match(changed.items[0].reason, /새 요청ID/);

  // 새로 만든 시트에서는 같은 요청ID 를 다시 쓸 수 있다
  const other = parse(sheetOf(line({ 요청ID: 'a', 종류: '할일', '내용/제목': '다른 일' })), { processed, sheet: 'ss2' });
  assert.equal(other.items[0].action, 'apply');

  // 날짜를 비운 할 일은 다음 날 다시 읽어도 같은 요청이다
  const nextDay = parse(sheetOf(line({ 요청ID: 'a', 종류: '할일', '내용/제목': '단어' })), { processed, today: '2026-10-24' });
  assert.equal(nextDay.items[0].action, 'done');
});

test('받은편지함: 머리글 이름으로 칸을 찾는다 — 안내 줄이 없어도, 칸 순서를 바꿔도', () => {
  const head = ['종류', '요청ID', '날짜', '내용/제목', '시작', '끝', '메모', '결과', '상태', '처리시각', '내 메모'];
  const r = parse([head, ['할일', 'a', '2026-10-30', '단어', '', '', '', '', '', '', '무시되는 칸']]);
  assert.equal(r.error, null);
  assert.deepEqual(r.items[0].request, { kind: 'todo', text: '단어 #공부', date: '2026-10-30', key: 'ss:a', requestId: 'a' });
  assert.equal(r.items[0].row, 2);
});

test('받은편지함: 머리글이 없으면 — 빈 탭은 empty, 내용이 있으면 오류, 칸이 빠졌으면 무엇이 빠졌는지', () => {
  assert.equal(parse([]).error, 'empty');
  assert.equal(parse([[], ['']]).error, 'empty');
  assert.match(parse([['아무 글']]).error, /머리글 줄이 없습니다/);
  assert.match(parse([['요청ID', '종류', '내용/제목']]).error, /날짜 · 시작 · 끝 · 메모 · 상태 · 처리시각 · 결과/);
});

test('readDate · readTime', () => {
  assert.deepEqual(readDate('2026-1-5'), { value: '2026-01-05' });
  assert.deepEqual(readDate('2026/10/25'), { value: '2026-10-25' });
  assert.deepEqual(readDate('2026. 10. 25.'), { value: '2026-10-25' });
  assert.deepEqual(readDate(''), {});
  assert.ok(readDate('2026-13-01').error);
  assert.deepEqual(readTime('7:05'), { value: '07:05' });
  assert.deepEqual(readTime('오전 12:10'), { value: '00:10' });
  assert.deepEqual(readTime('12:30 pm'), { value: '12:30' });
  assert.deepEqual(readTime('23:59:59'), { value: '23:59' });
  assert.ok(readTime('24:00').error);
  assert.ok(readTime('오후 0:30').error);
});

test('relocate: 읽은 뒤 줄이 밀렸으면 같은 내용의 줄을 다시 찾고, 지워졌거나 이미 처리된 줄에는 쓰지 않는다', () => {
  const values = sheetOf(
    line({ 요청ID: 'a', 종류: '할일', '내용/제목': 'x' }),
    line({ 요청ID: 'b', 종류: '할일', '내용/제목': 'y' }),
  );
  const writes = parse(values).items.map((it) => ({ ...it, status: '반영됨', at: 't', result: 'id' }));
  // 누가 머리글 바로 아래에 줄 하나를 끼워 넣었다
  const shifted = [values[0], values[1], line({ 요청ID: 'z', 종류: '할일', '내용/제목': 'new' }), values[2], values[3]];
  assert.deepEqual(relocate(shifted, findHeader(shifted), writes).map((p) => [p.requestId, p.row]), [['a', 4], ['b', 5]]);
  // a 줄이 지워졌다
  const gone = [values[0], values[1], values[3]];
  assert.deepEqual(relocate(gone, findHeader(gone), writes).map((p) => [p.requestId, p.row]), [['b', 3]]);
  // 사람이 그새 상태를 적었다
  const marked = [values[0], values[1], line({ 요청ID: 'a', 종류: '할일', '내용/제목': 'x', 상태: '보류' }), values[3]];
  assert.deepEqual(relocate(marked, findHeader(marked), writes).map((p) => p.requestId), ['b']);
});

test('statusData: 상태 · 처리시각 · 결과를 머리글이 있는 칸에 쓴다', () => {
  const head = findHeader(sheetOf());
  assert.deepEqual(statusData('Claude가 넣을 것', head.idx, [{ row: 7, status: '반영됨', at: '2026-10-23 14:05', result: 't_1' }]), [
    { range: "'Claude가 넣을 것'!H7", values: [['반영됨']] },
    { range: "'Claude가 넣을 것'!I7", values: [['2026-10-23 14:05']] },
    { range: "'Claude가 넣을 것'!J7", values: [['t_1']] },
  ]);
});

test('받은편지함에서 만든 일정의 id 는 요청마다 정해져 있다', () => {
  assert.equal(taskIdFor('ss:a'), taskIdFor('ss:a'));
  assert.notEqual(taskIdFor('ss:a'), taskIdFor('ss:b'));
  assert.match(taskIdFor('ss:a'), /^t_[0-9a-f]{16}$/);
});

// ---------------------------------------------------------------- 내보내기 행

test('내보내기 행: 맨 위 한 줄은 내보낸 시각과 범위, 둘째 줄은 머리글, 그 아래가 값', () => {
  const data = sanitizeExport({
    today: '2026-10-23', from: '2026-10-09', to: '2027-01-21', doneSince: '2026-10-09', journalFrom: '2026-09-24',
    events: [
      { id: 't1', date: '2026-10-23', start: '09:00', end: '10:00', title: '스탠드업', tags: ['업무', '팀'], done: false, repeat: '평일' },
      { id: 't2', date: '2026-10-24', start: null, end: null, title: '이사', tags: [], done: true, repeat: '' },
    ],
    todos: [
      { id: 'd1', text: '견적서', day: '2026-10-22', done: false, linked: { date: '2026-10-23', start: '14:00', end: '15:00' } },
      { id: 'd2', text: '메일', day: '2026-10-23', done: true, linked: null },
      { id: 'd3', text: '보고', day: '2026-10-23', done: false, linked: { date: '2026-10-25', start: '', end: '' } },
    ],
    journal: [{ date: '2026-10-22', text: '좋은 하루' }, { date: '2026-10-20', text: '비' }],
  });
  const rows = exportRows(data, { now: new Date(2026, 9, 23, 14, 5).getTime(), version: '1.9.0' });

  assert.match(rows.events[0][0], /^마지막 내보낸 시각 2026-10-23 14:05 · 일정관리 비서 1\.9\.0 · 2026-10-09 ~ 2027-01-21/);
  assert.deepEqual(rows.events.slice(1), [
    ['id', '날짜', '시작', '끝', '제목', '태그', '완료', '반복 여부'],
    ['t1', '2026-10-23', '09:00', '10:00', '스탠드업', '#업무 #팀', '아니오', '평일'],
    ['t2', '2026-10-24', '', '', '이사', '', '예', ''],
  ]);
  assert.match(rows.todos[0][0], /2026-10-09 이후에 끝낸 것/);
  assert.deepEqual(rows.todos.slice(1), [
    ['id', '내용', '날짜', '완료', '묶인 일정 시각'],
    ['d1', '견적서', '2026-10-22', '아니오', '2026-10-23 14:00–15:00'],
    ['d2', '메일', '2026-10-23', '예', ''],
    ['d3', '보고', '2026-10-23', '아니오', '2026-10-25'],
  ]);
  assert.match(rows.journal[0][0], /2026-09-24 부터/);
  assert.deepEqual(rows.journal.slice(1), [['날짜', '내용'], ['2026-10-20', '비'], ['2026-10-22', '좋은 하루']], '날짜순');
});

test('내보내기 재료는 믿지 않는다 — 모양이 아닌 것은 거르고 길이는 자른다', () => {
  const d = sanitizeExport({ events: [null, 'x', { id: 1, date: '10/24', title: 'a'.repeat(999), tags: 'nope' }], todos: 'x' });
  assert.equal(d.events.length, 1);
  assert.deepEqual([d.events[0].id, d.events[0].date, d.events[0].title.length, d.events[0].tags], ['1', '', 300, []]);
  assert.deepEqual(d.todos, []);
  assert.deepEqual(d.journal, []);
  assert.equal(sanitizeExport(null), null);
});

// ---------------------------------------------------------------- 가짜 구글

let server;
let base;
const g = {
  tokenScope: `${SCOPE} ${FILE_SCOPE}`,   // 동의 화면에서 허락한 권한
  email: 'me@example.com',
  files: new Map(),
  next: 1,
  disabled: false,                         // 클라우드 프로젝트에서 시트 API 를 안 켰다
  network: false,                          // 인터넷이 끊겼다
  authUrls: [],
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function parseA1(range) {
  const m = /^'((?:[^']|'')+)'!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(range);
  assert.ok(m, `A1 범위: ${range}`);
  const r1 = m[3] ? Number(m[3]) - 1 : 0;
  return {
    title: m[1].replace(/''/g, "'"),
    r1,
    c1: colIndex(m[2]),
    r2: m[5] ? Number(m[5]) - 1 : (m[4] || !m[3] ? Infinity : r1),
    c2: m[4] ? colIndex(m[4]) : colIndex(m[2]),
  };
}

/** 시트 API 처럼 — 탭의 행 수를 넘겨 쓰면 거절한다(위젯이 행 수를 먼저 늘리는지 본다) */
function setCell(tab, r, c, v) {
  if (r >= tab.rowCount) throw Object.assign(new Error(`exceeds grid limits: ${r + 1} > ${tab.rowCount}`), { code: 400 });
  while (tab.grid.length <= r) tab.grid.push([]);
  tab.grid[r][c] = v;
}

function readRange(tab, { r1, r2, c1, c2 }) {
  const out = [];
  for (let r = r1; r <= Math.min(r2, tab.grid.length - 1); r++) {
    const row = [];
    for (let c = c1; c <= c2; c++) row.push(tab.grid[r]?.[c] ?? '');
    while (row.length && row[row.length - 1] === '') row.pop();
    out.push(row);
  }
  while (out.length && !out[out.length - 1].length) out.pop();
  return out;
}

function tabOf(file, test) {
  const t = file.tabs.find(test);
  if (!t) throw Object.assign(new Error('No grid'), { code: 400 });
  return t;
}

function applyRequest(file, rq) {
  if (rq.updateSheetProperties) {
    const p = rq.updateSheetProperties.properties;
    const t = tabOf(file, (x) => x.sheetId === p.sheetId);
    if (p.gridProperties?.rowCount) {
      t.rowCount = p.gridProperties.rowCount;
      t.grid.length = Math.min(t.grid.length, t.rowCount);
    }
    return {};
  }
  if (rq.updateCells) {
    const u = rq.updateCells;
    const at = u.range || u.start;
    const t = tabOf(file, (x) => x.sheetId === at.sheetId);
    const sr = u.range ? u.range.startRowIndex || 0 : u.start.rowIndex || 0;
    const sc = u.range ? u.range.startColumnIndex || 0 : u.start.columnIndex || 0;
    if (u.range) {
      // 범위를 다 채우지 않은 칸은 비운다(시트 API 의 updateCells 와 같다)
      const er = Math.min(u.range.endRowIndex ?? t.rowCount, t.grid.length);
      const ec = u.range.endColumnIndex ?? 26;
      for (let r = sr; r < er; r++) for (let c = sc; c < ec; c++) if (t.grid[r]) t.grid[r][c] = '';
    }
    (u.rows || []).forEach((row, i) => (row.values || []).forEach((cell, j) => {
      setCell(t, sr + i, sc + j, cell.userEnteredValue?.stringValue ?? '');
    }));
    return {};
  }
  if (rq.addSheet) {
    const p = rq.addSheet.properties;
    const sheetId = file.nextSheet++;
    file.tabs.push({ sheetId, title: p.title, rowCount: p.gridProperties?.rowCount || 1000, grid: [] });
    return { addSheet: { properties: { sheetId, title: p.title } } };
  }
  return {};   // 칸 너비 · 서식 · 보호 — 값과 상관없다
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);
    if (url.pathname === '/token') {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') {
        return json(res, 200, { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, scope: g.tokenScope });
      }
      return p.get('refresh_token') === 'rt1'
        ? json(res, 200, { access_token: 'at2', expires_in: 3600 })
        : json(res, 400, { error: 'invalid_grant' });
    }
    if (!/^Bearer at[12]$/.test(req.headers.authorization || '')) return json(res, 401, { error: 'unauthorized' });
    if (url.pathname === '/drive/v3/about') return json(res, 200, { user: { emailAddress: g.email } });

    const drive = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (drive) {
      const f = g.files.get(decodeURIComponent(drive[1]));
      return f ? json(res, 200, { trashed: f.trashed }) : json(res, 404, { error: { code: 404 } });
    }

    if (url.pathname.startsWith('/v4/') && g.disabled) {
      return json(res, 403, { error: { code: 403, message: 'Google Sheets API has not been used in project 123 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } });
    }
    try {
      if (url.pathname === '/v4/spreadsheets' && req.method === 'POST') {
        const b = JSON.parse(body);
        const id = `ss${g.next++}`;
        const file = {
          id, title: b.properties.title, locale: b.properties.locale, trashed: false, nextSheet: 100,
          tabs: b.sheets.map((s, i) => ({ sheetId: 10 + i, title: s.properties.title, rowCount: s.properties.gridProperties?.rowCount || 1000, grid: [] })),
        };
        g.files.set(id, file);
        return json(res, 200, {
          spreadsheetId: id,
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`,
          sheets: file.tabs.map((t) => ({ properties: { sheetId: t.sheetId, title: t.title } })),
        });
      }
      const batch = /^\/v4\/spreadsheets\/([^/:]+):batchUpdate$/.exec(url.pathname);
      if (batch) {
        const file = g.files.get(batch[1]);
        if (!file) return json(res, 404, { error: { code: 404 } });
        const replies = JSON.parse(body).requests.map((rq) => applyRequest(file, rq));
        return json(res, 200, { replies });
      }
      const values = /^\/v4\/spreadsheets\/([^/:]+)\/values\/(.+)$/.exec(url.pathname);
      if (values && req.method === 'GET') {
        const file = g.files.get(values[1]);
        const r = parseA1(decodeURIComponent(values[2]));
        return json(res, 200, { values: readRange(tabOf(file, (x) => x.title === r.title), r) });
      }
      const write = /^\/v4\/spreadsheets\/([^/:]+)\/values:batchUpdate$/.exec(url.pathname);
      if (write) {
        const file = g.files.get(write[1]);
        const b = JSON.parse(body);
        assert.equal(b.valueInputOption, 'RAW');
        for (const d of b.data) {
          const r = parseA1(d.range);
          const t = tabOf(file, (x) => x.title === r.title);
          d.values.forEach((row, i) => row.forEach((v, j) => setCell(t, r.r1 + i, r.c1 + j, String(v))));
        }
        return json(res, 200, {});
      }
      const meta = /^\/v4\/spreadsheets\/([^/:]+)$/.exec(url.pathname);
      if (meta && req.method === 'GET') {
        const file = g.files.get(meta[1]);
        if (!file) return json(res, 404, { error: { code: 404 } });
        return json(res, 200, {
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${file.id}/edit`,
          sheets: file.tabs.map((t) => ({ properties: { sheetId: t.sheetId, title: t.title } })),
        });
      }
    } catch (err) {
      return json(res, err.code || 500, { error: { code: err.code || 500, message: err.message } });
    }
    return json(res, 404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

let root;
let userDataDir;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bridge-'));
  userDataDir = path.join(root, 'userData');
  g.files.clear();
  g.next = 1;
  g.disabled = false;
  g.network = false;
  g.tokenScope = `${SCOPE} ${FILE_SCOPE}`;
  g.email = 'me@example.com';
  g.authUrls = [];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** 사용자가 브라우저에서 로그인하고 허용을 누른 것처럼 */
function browser(authUrl) {
  const u = new URL(authUrl);
  g.authUrls.push(u);
  const back = new URL(u.searchParams.get('redirect_uri'));
  back.searchParams.set('code', 'good-code');
  back.searchParams.set('state', u.searchParams.get('state'));
  setTimeout(() => fetch(back).catch(() => {}), 10);
}

const auth = () => createGoogleAuth({
  userDataDir, client: { clientId: 'cid', clientSecret: 'sec' }, openExternal: browser,
  tokenUrl: `${base}/token`, apiBase: base,
});

/** 인터넷이 끊긴 것처럼 — 시트 · 드라이브 호출만 */
const fetchImpl = (url, init) => (g.network ? Promise.reject(new TypeError('fetch failed')) : fetch(url, init));

/** 위젯이 내보내는 재료(렌더러의 collectExport 모양) */
function sample(events = 2) {
  return {
    today: '2026-10-23', from: '2026-10-09', to: '2027-01-21', doneSince: '2026-10-09', journalFrom: '2026-09-24',
    events: Array.from({ length: events }, (_, i) => ({
      id: `t${i}`, date: '2026-10-23', start: '09:00', end: '', title: `일정 ${i}`, tags: [], done: false, repeat: '',
    })),
    todos: [{ id: 'd1', text: '견적서', day: '2026-10-22', done: false, linked: null }],
    journal: [{ date: '2026-10-22', text: '좋은 하루' }],
  };
}

/** 렌더러 흉내 — 달라면 재료를 주고, 받은편지함 요청은 받아 적고 만든 것으로 답한다 */
function bridgeWith({ google = auth(), syncUsesGoogle = () => false, exportData = () => sample() } = {}) {
  const renderer = { inbox: [], wants: 0 };
  const b = createClaudeBridge({
    userDataDir, google, appVersion: '1.9.0', syncUsesGoogle, fetchImpl,
    sheetsBase: base, driveBase: base, timers: false,
  });
  b.start((channel, payload) => {
    if (channel === 'bridge:want') {
      renderer.wants += 1;
      setImmediate(() => b.takeExport(exportData()));
    }
    if (channel === 'bridge:inbox') {
      renderer.inbox.push(...payload.requests);
      setImmediate(() => b.applied(payload.token, payload.requests.map((r) => ({
        key: r.key, ok: true, id: r.kind === 'event' ? r.taskId : `td-${r.requestId}`,
      }))));
    }
    return true;
  });
  b.ready();
  return { b, renderer, google };
}

const only = () => [...g.files.values()][0];
const tab = (title, file = only()) => file.tabs.find((t) => t.title === title);
const grid = (title, file) => readRange(tab(title, file), { r1: 0, r2: Infinity, c1: 0, c2: 25 });

/** Claude 가 받은편지함에 줄을 더한 것처럼 */
function claudeAppends(...rows) {
  const t = tab('Claude가 넣을 것');
  const at = Math.max(2, readRange(t, { r1: 0, r2: Infinity, c1: 0, c2: 25 }).length);
  rows.forEach((row, i) => row.forEach((v, j) => setCell(t, at + i, j, v)));
}

// ---------------------------------------------------------------- 구글 로그인 권한

test('로그인: 시트 권한을 더해 달라고 하고, 앞서 받은 권한도 싣고, 받은 권한을 적어 둔다', async () => {
  const a = auth();
  await a.login({ scopes: [FILE_SCOPE], loginHint: 'me@example.com' });
  const u = g.authUrls[0];
  assert.deepEqual(u.searchParams.get('scope').split(' '), [SCOPE, FILE_SCOPE]);
  assert.equal(u.searchParams.get('include_granted_scopes'), 'true');
  assert.equal(u.searchParams.get('login_hint'), 'me@example.com');
  assert.equal(a.hasScope(FILE_SCOPE), true);
  assert.equal(a.hasScope(SCOPE), true);
});

test('로그인: 구글 화면에서 시트 권한 체크를 풀었으면 그 권한은 없는 것으로 안다', async () => {
  g.tokenScope = SCOPE;
  const a = auth();
  await a.login({ scopes: [FILE_SCOPE] });
  assert.equal(a.hasScope(FILE_SCOPE), false);
  assert.equal(a.hasScope(SCOPE), true);
});

test('로그인: 예전 토큰(권한 기록 없음)은 동기화 권한 하나로 읽는다', () => {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'google-auth.bin'), JSON.stringify({ refreshToken: 'rt1', email: 'me@example.com' }));
  const a = auth();
  assert.equal(a.hasScope(SCOPE), true);
  assert.equal(a.hasScope(FILE_SCOPE), false);
});

test('로그인: 기대한 계정이 아니면 받지 않고 있던 로그인을 그대로 둔다', async () => {
  const a = auth();
  g.tokenScope = SCOPE;
  await a.login();
  g.tokenScope = `${SCOPE} ${FILE_SCOPE}`;
  g.email = 'other@example.com';
  await assert.rejects(a.login({ scopes: [FILE_SCOPE], expectEmail: 'me@example.com' }), /같은 구글 계정\(me@example\.com\)/);
  assert.equal(a.account(), 'me@example.com');
  assert.equal(a.hasScope(FILE_SCOPE), false, '다른 계정의 토큰으로 바뀌지 않았다');
});

// ---------------------------------------------------------------- 한 바퀴

test('켜기: 권한을 더해 로그인하고, 내 드라이브에 탭 넷짜리 시트를 만들고, 첫 연동까지 마친다', async () => {
  const { b, renderer } = bridgeWith();
  assert.equal(b.status().enabled, false);
  assert.equal(b.status().needsScope, true, '켜면 로그인을 한 번 더 한다');

  const r = await b.enable();
  assert.equal(r.ok, true, r.error);
  assert.equal(g.authUrls.length, 1);
  assert.ok(g.authUrls[0].searchParams.get('scope').includes(FILE_SCOPE));

  const file = only();
  assert.equal(file.title, TITLE);
  assert.equal(file.locale, 'ko_KR');
  assert.deepEqual(file.tabs.map((t) => t.title), ['일정', '할 일', '기록', 'Claude가 넣을 것']);
  assert.deepEqual(grid('Claude가 넣을 것'), [[INBOX_GUIDE], [...INBOX_HEAD]]);

  // 첫 연동 — 렌더러에게 재료를 받아 내보냈다
  assert.equal(renderer.wants, 1);
  const events = grid('일정');
  assert.match(events[0][0], /^마지막 내보낸 시각 /);
  assert.deepEqual(events.slice(1), [
    ['id', '날짜', '시작', '끝', '제목', '태그', '완료', '반복 여부'],
    ['t0', '2026-10-23', '09:00', '', '일정 0', '', '아니오'],
    ['t1', '2026-10-23', '09:00', '', '일정 1', '', '아니오'],
  ]);
  assert.deepEqual(grid('할 일').slice(2), [['d1', '견적서', '2026-10-22', '아니오']]);
  assert.deepEqual(grid('기록').slice(2), [['2026-10-22', '좋은 하루']]);

  const st = r.status;
  assert.equal(st.enabled, true);
  assert.equal(st.needsScope, false);
  assert.equal(st.url, `https://docs.google.com/spreadsheets/d/${file.id}/edit`);
  assert.ok(st.lastOkAt > 0);
  assert.equal(st.failures, 0);

  // 다시 켜도(이미 켜져 있어도) 로그인 · 새 시트 없이 다시 맞추기만 한다
  assert.equal((await b.enable()).ok, true);
  assert.equal(g.authUrls.length, 1);
  assert.equal(g.files.size, 1);
  b.stop();
});

test('내보내기: 일정이 줄면 남은 줄을 비우고, 1000줄을 넘으면 탭을 늘린다', async () => {
  let n = 3;
  const { b } = bridgeWith({ exportData: () => sample(n) });
  await b.enable();
  assert.equal(grid('일정').length, 5);
  n = 1;
  await b.tick();
  assert.equal(grid('일정').length, 3, '지난번 줄이 남지 않는다');
  n = 1500;
  await b.tick();
  assert.equal(grid('일정').length, 1502);
  assert.ok(tab('일정').rowCount >= 1502);
  // 바뀐 뒤 렌더러가 스스로 보낸 재료(30초 모은 것)도 내보낸다
  n = 2;
  assert.deepEqual(b.takeExport(sample(2)), { ok: true, enabled: true });
  await b.tick();
  assert.equal(grid('일정').length, 4);
  b.stop();
});

test('받은편지함: Claude 가 더한 줄을 할 일 · 일정으로 넘기고 상태 · 처리시각 · 결과를 채운다', async () => {
  const { b, renderer } = bridgeWith();
  await b.enable();
  claudeAppends(
    line({ 요청ID: 'r1', 종류: '할일', '내용/제목': '영어 단어 30개', 날짜: '2026-10-24', 메모: '교재 3장' }),
    line({ 요청ID: 'r2', 종류: '일정', '내용/제목': '모의고사', 날짜: '2026-10-25', 시작: '9:00', 끝: '12:00', 상태: '대기' }),
    line({ 요청ID: 'r3', 종류: '할일ㅇ', '내용/제목': '오타' }),
    line({ 요청ID: 'r4', 종류: '일정', '내용/제목': '날짜 틀림', 날짜: '10/25' }),
    line({ 요청ID: 'r5', 종류: '할일', '내용/제목': '이미 끝난 줄', 상태: '반영됨', 결과: 'td-old' }),
  );
  await b.tick();

  assert.deepEqual(renderer.inbox.map((r) => [r.requestId, r.kind]), [['r1', 'todo'], ['r2', 'event']]);
  assert.equal(renderer.inbox[0].text, '영어 단어 30개 — 교재 3장 #공부');
  assert.equal(renderer.inbox[1].taskId, taskIdFor(`${only().id}:r2`), '일정 id 는 요청마다 정해져 있다');

  const rows = grid('Claude가 넣을 것').slice(2);
  const st = (row) => [row[0], row[7], row[9]];
  assert.deepEqual(st(rows[0]), ['r1', '반영됨', 'td-r1']);
  assert.deepEqual(st(rows[1]), ['r2', '반영됨', taskIdFor(`${only().id}:r2`)]);
  assert.equal(rows[2][7], '오류');
  assert.match(rows[2][9], /'할일' 또는 '일정'/);
  assert.equal(rows[3][7], '오류');
  assert.match(rows[3][9], /YYYY-MM-DD/);
  assert.deepEqual(st(rows[4]), ['r5', '반영됨', 'td-old'], '이미 처리된 줄은 건드리지 않는다');
  assert.match(rows[0][8], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '처리시각');

  // 다음 주기 — 넘길 것이 없다
  await b.tick();
  assert.equal(renderer.inbox.length, 2);
  b.stop();
});

test('받은편지함: 같은 요청ID 는 다시 만들지 않는다 — 위젯을 다시 켜도, 상태 칸이 지워져도', async () => {
  const first = bridgeWith();
  await first.b.enable();
  claudeAppends(line({ 요청ID: 'r1', 종류: '할일', '내용/제목': '단어' }));
  await first.b.tick();
  assert.equal(first.renderer.inbox.length, 1);
  first.b.stop();
  assert.ok(fs.existsSync(path.join(userDataDir, 'claude-bridge-done.json')));

  // 위젯을 다시 켰다. 그사이 Claude 가 같은 요청ID 로 다른 일을 적었다
  claudeAppends(line({ 요청ID: 'r1', 종류: '할일', '내용/제목': '다른 일' }));
  const again = bridgeWith();
  await again.b.tick();
  assert.equal(again.renderer.inbox.length, 0);
  let rows = grid('Claude가 넣을 것').slice(2);
  assert.equal(rows[1][7], '오류');
  assert.match(rows[1][9], /새 요청ID/);

  // 상태 칸이 지워졌다(쓰다 끊겼거나 누가 지웠다) — 다시 만들지 않고 처음 결과를 되적는다
  const t = tab('Claude가 넣을 것');
  for (const c of [7, 8, 9]) t.grid[2][c] = '';
  await again.b.tick();
  assert.equal(again.renderer.inbox.length, 0, '아무것도 다시 만들지 않는다');
  rows = grid('Claude가 넣을 것').slice(2);
  assert.deepEqual([rows[0][7], rows[0][9]], ['반영됨', 'td-r1']);
  again.b.stop();
});

test('연결이 끊겨도 소리 내지 않고 다음 주기에 — 실패 횟수만 세고, 되면 다시 0', async () => {
  const { b } = bridgeWith();
  await b.enable();
  const okAt = b.status().lastOkAt;
  g.network = true;
  await b.tick();
  await b.tick();
  let st = b.status();
  assert.equal(st.failures, 2);
  assert.match(st.lastError, /닿지 못했습니다/);
  assert.equal(st.problem, null, '손쓸 문제가 아니다 — 다음 주기에 저절로 풀린다');
  assert.equal(st.lastOkAt, okAt);
  g.network = false;
  await b.tick();
  st = b.status();
  assert.equal(st.failures, 0);
  assert.equal(st.lastError, null);
  assert.ok(st.lastOkAt >= okAt);
  b.stop();
});

test('로그인이 풀리면 횟수 대신 할 일을 말하고, 켬을 다시 누르면 로그인부터 한다', async () => {
  const { b, google } = bridgeWith();
  await b.enable();
  await google.logout();   // 이 PC 의 토큰이 사라졌다(구글 쪽에서 권한을 거둔 것과 같다)
  await b.tick();
  let st = b.status();
  assert.equal(st.needsLogin, true);
  assert.match(st.problem, /로그인이 풀렸습니다/);
  assert.equal((await b.enable()).ok, true);
  assert.equal(g.authUrls.length, 2, '다시 로그인했다');
  st = b.status();
  assert.deepEqual([st.needsLogin, st.problem, st.failures], [false, null, 0]);
  assert.equal(g.files.size, 1, '같은 시트를 이어 쓴다');
  b.stop();
});

test('시트 API 가 꺼져 있으면 켤 때 그 이유를 말한다', async () => {
  g.disabled = true;
  const { b } = bridgeWith();
  const r = await b.enable();
  assert.equal(r.ok, false);
  assert.match(r.error, /시트 API 가 꺼져/);
  assert.equal(b.status().enabled, false);
  b.stop();
});

test('휴대폰 동기화가 구글을 쓰면 같은 계정이어야 한다 — 다른 계정이면 있던 로그인을 그대로 둔다', async () => {
  const google = auth();
  g.tokenScope = SCOPE;
  await google.login();   // 동기화가 쓰던 로그인(권한은 숨김 폴더 하나)
  g.tokenScope = `${SCOPE} ${FILE_SCOPE}`;
  g.email = 'other@example.com';
  const { b } = bridgeWith({ google, syncUsesGoogle: () => true });
  const r = await b.enable();
  assert.equal(r.ok, false);
  assert.match(r.error, /같은 구글 계정\(me@example\.com\)/);
  assert.equal(google.account(), 'me@example.com');
  assert.equal(g.files.size, 0);
  assert.equal(g.authUrls.at(-1).searchParams.get('login_hint'), 'me@example.com');
  b.stop();
});

test('끄기: 시트는 남긴다 · 동기화가 구글을 쓰지 않으면 이 PC 의 로그인을 지우고, 쓰면 남긴다', async () => {
  let syncGoogle = true;
  const { b, google } = bridgeWith({ syncUsesGoogle: () => syncGoogle });
  await b.enable();
  let st = await b.disable();
  assert.equal(st.enabled, false);
  assert.equal(google.connected(), true, '동기화가 쓰는 로그인');
  assert.equal(g.files.size, 1, '시트는 드라이브에 남는다');

  // 다시 켜면 같은 시트를 이어 쓴다
  assert.equal((await b.enable()).ok, true);
  assert.equal(g.files.size, 1);

  syncGoogle = false;
  st = await b.disable();
  assert.equal(google.connected(), false, '시트만 쓰던 로그인');
  assert.equal(st.needsScope, true);
  b.stop();
});

test('시트를 휴지통에 넣었으면 알리고, 다시 켜면 새로 만든다 · 지운 탭은 다시 만든다', async () => {
  const first = bridgeWith();
  await first.b.enable();
  first.b.stop();
  only().trashed = true;

  const again = bridgeWith();
  await again.b.tick();
  assert.match(again.b.status().problem, /시트를 찾을 수 없습니다/);
  assert.equal((await again.b.enable()).ok, true);
  assert.equal(g.files.size, 2);
  const fresh = g.files.get('ss2');

  // 사람이 받은편지함 탭을 지웠다
  fresh.tabs = fresh.tabs.filter((t) => t.title !== 'Claude가 넣을 것');
  await again.b.tick();
  assert.deepEqual(grid('Claude가 넣을 것', fresh), [[INBOX_GUIDE], [...INBOX_HEAD]]);
  assert.equal(again.b.status().failures, 0);
  again.b.stop();
});
