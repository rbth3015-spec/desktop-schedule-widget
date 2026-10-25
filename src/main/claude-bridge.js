// Claude 연동 시트 — claude.ai 의 Claude 가 이 위젯과 주고받는 구글 시트 한 장.
//
// 왜 시트인가
//   휴대폰 동기화는 구글 드라이브의 숨김 앱 폴더(appDataFolder)를 쓴다. 같은 클라우드 프로젝트의 앱만 보는
//   자리라 Claude 는 들어갈 수 없다. Claude 는 구글 시트는 읽고 쓸 수 있으니, 위젯이 사용자 드라이브에
//   시트 한 장을 만들어 그 위로 주고받는다. 폰 앱은 모른다 — 위젯이 받은 것은 평소 동기화로 폰에 간다.
//
// 시트 '일정관리 비서 · Claude 연동' (docs/BRIDGE.md)
//   일정 · 할 일 · 기록   위젯 → 시트. 위젯이 통째로 덮어쓴다(사람 · Claude 는 읽기만).
//   Claude가 넣을 것      시트 → 위젯. Claude 가 줄을 더하면 할 일 · 일정으로 들어가고, 위젯이 그 줄의
//                         상태 · 처리시각 · 결과를 채운다. 추가만 한다 — 있던 일정 · 할 일을 고치거나 지우지 않는다.
//
// 주기 — 켜질 때 + 5분마다(내보내기 · 받은편지함), 그리고 일정 · 할 일이 바뀌면 렌더러가 30초 모아 내보낸다.
// 네트워크가 끊겨도 소리 내지 않고 다음 주기에 다시 한다. 상태는 설정 줄에만 보인다.
//
// 권한은 drive.file — 이 앱이 만든 파일만 다룬다(src/main/google-auth.js). 로그인은 휴대폰 동기화와 같이 쓴다.
//
// 사용자 데이터 폴더 안
//   claude-bridge.json       켬/끔 · 시트 ID · 주소 · 탭 ID · 만든 계정
//   claude-bridge-done.json  처리한 요청ID — 같은 요청ID 는 두 번 만들지 않는다
//
// Electron 을 부르지 않는다 — 렌더러와의 다리는 main.js 가 넘겨주고, 여기는 node 로 시험한다.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeTextAtomic } = require('./sync-transports');
const { FILE_SCOPE } = require('./google-auth');

const TITLE = '일정관리 비서 · Claude 연동';
/** 받은편지함에서 들어온 할 일 · 일정에 붙는 태그 */
const TAG = '공부';
/** 할 일 · 일정 제목의 최대 길이 — store 와 같다 */
const TEXT_MAX = 200;

const INBOX_HEAD = ['요청ID', '종류', '내용/제목', '날짜', '시작', '끝', '메모', '상태', '처리시각', '결과'];
/** 줄이 옮겨졌는지 알아볼 때 보는 칸 — 상태 · 처리시각 · 결과는 위젯이 쓰는 칸이라 뺀다 */
const INBOX_CONTENT = INBOX_HEAD.slice(0, 7);
const INBOX_GUIDE = 'Claude 가 아래 표에 한 줄씩 더하면 위젯이 5분 안에 넣습니다 · 종류: 할일 | 일정 · '
  + '날짜 YYYY-MM-DD(비우면 오늘) · 시작 · 끝 HH:MM(일정만) · 요청ID 는 줄마다 새것으로 · '
  + '상태 · 처리시각 · 결과는 비워 두면 위젯이 채웁니다 · 추가만 합니다(고치기 · 지우기 없음)';

/** 탭 — key 는 코드가, title 은 사람이 본다. widths 는 처음 만들 때의 칸 너비(px) */
const TABS = {
  events: { title: '일정', head: ['id', '날짜', '시작', '끝', '제목', '태그', '완료', '반복 여부'],
    widths: [130, 92, 56, 56, 260, 120, 52, 110] },
  todos: { title: '할 일', head: ['id', '내용', '날짜', '완료', '묶인 일정 시각'],
    widths: [130, 320, 92, 52, 160] },
  journal: { title: '기록', head: ['날짜', '내용'], widths: [92, 560] },
  inbox: { title: 'Claude가 넣을 것', head: INBOX_HEAD,
    widths: [110, 60, 260, 92, 56, 56, 200, 64, 128, 200] },
};
const TAB_KEYS = ['events', 'todos', 'journal', 'inbox'];
const EXPORT_KEYS = ['events', 'todos', 'journal'];

/** 받은편지함 · 내보내기 주기 */
const TICK_MS = 5 * 60 * 1000;
/** 렌더러가 내보내기 재료를 줄 때까지 · 받은편지함을 반영할 때까지 기다리는 시간 */
const WANT_MS = 4000;
const APPLY_MS = 15000;
/** 내보내기 탭의 최소 행 수 — 새 시트의 기본값. 줄이면 'A1:Z1000' 처럼 넉넉히 읽는 쪽이 범위 오류를 낸다 */
const MIN_ROWS = 1000;
/** 한 주기에 처리하는 받은편지함 줄 · 기억하는 요청ID 수 */
const MAX_ITEMS = 200;
const DONE_KEEP = 3000;
/** 맨 위 한 줄(시각 · 안내)의 글자색 */
const GREY = { red: 0.45, green: 0.45, blue: 0.45 };

// ---------------------------------------------------------------- 작은 도구 (순수 함수)

const pad = (n) => String(n).padStart(2, '0');
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 로컬 'YYYY-MM-DD' */
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 로컬 'YYYY-MM-DD HH:MM' — 시트에 적는 시각 */
function stamp(ms) {
  const d = new Date(ms);
  return `${dayKey(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 날짜 칸 → {value: 'YYYY-MM-DD'} · 빈칸 → {} · 날짜가 아니면 {error}.
 * 받은편지함은 글자 서식이라 적은 그대로 오지만, 서식이 풀린 시트는 '2026. 10. 25' 로 돌려주므로 그것도 읽는다.
 */
function readDate(raw) {
  const s = clean(raw);
  if (!s) return {};
  const m = /^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\s*\.?$/.exec(s);
  if (!m) return { error: true };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return { error: true };
  return { value: `${y}-${pad(mo)}-${pad(d)}` };
}

/** 시각 칸 → {value: 'HH:MM'} (9:00 · 09:00:00 · 오후 2:30 · 2:30 PM) · 빈칸 → {} · 아니면 {error} */
function readTime(raw) {
  const s = clean(raw);
  if (!s) return {};
  const m = /^(오전|오후)?\s*(\d{1,2}):([0-5]\d)(?::[0-5]\d)?\s*([AaPp][Mm])?$/.exec(s);
  if (!m) return { error: true };
  let h = Number(m[2]);
  const pm = m[1] === '오후' || /^p/i.test(m[4] || '');
  const am = m[1] === '오전' || /^a/i.test(m[4] || '');
  if (pm || am) {
    if (h < 1 || h > 12) return { error: true };
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (h > 23) return { error: true };
  return { value: `${pad(h)}:${m[3]}` };
}

/** 할 일 글 끝에 '#공부' — 이미 적혀 있으면 그대로. 할 일에는 태그 칸이 없어 글에 붙인다 */
function withTag(text) {
  const mark = `#${TAG}`;
  if (text.split(' ').includes(mark)) return text.slice(0, TEXT_MAX);
  return `${text.slice(0, TEXT_MAX - mark.length - 1).trim()} ${mark}`;
}

/** 0 → A, 25 → Z, 26 → AA */
function colName(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 탭 이름을 붙인 A1 범위 — 이름에 빈칸이 있어 따옴표로 싼다 */
function a1(title, ref) {
  return `'${String(title).replace(/'/g, "''")}'!${ref}`;
}

/** 시트에 쓸 행 — 빈 값은 칸을 비운다(빈 글자를 넣지 않는다) */
function rowData(rows) {
  return rows.map((r) => ({
    values: r.map((v) => {
      const s = String(v ?? '');
      return s ? { userEnteredValue: { stringValue: s } } : {};
    }),
  }));
}

// ---------------------------------------------------------------- 내보내기 (위젯 → 시트)

const str = (v, max = 300) => String(v ?? '').slice(0, max);
const dateOr = (v) => (DATE_RE.test(String(v ?? '')) ? String(v) : '');

/**
 * 렌더러가 보낸 내보내기 재료를 믿지 않고 모양만 추린다(src/renderer/claude-bridge.js 의 collectExport).
 * @returns {null | {today, from, to, doneSince, journalFrom, events: object[], todos: object[], journal: object[]}}
 */
function sanitizeExport(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const list = (v, max) => (Array.isArray(v) ? v.slice(0, max).filter((x) => x && typeof x === 'object') : []);
  return {
    today: dateOr(raw.today),
    from: dateOr(raw.from),
    to: dateOr(raw.to),
    doneSince: dateOr(raw.doneSince),
    journalFrom: dateOr(raw.journalFrom),
    events: list(raw.events, 5000).map((e) => ({
      id: str(e.id, 80),
      date: dateOr(e.date),
      start: str(e.start, 5),
      end: str(e.end, 5),
      title: str(e.title),
      tags: Array.isArray(e.tags) ? e.tags.slice(0, 12).map((t) => str(t, 40)).filter(Boolean) : [],
      done: !!e.done,
      repeat: str(e.repeat, 40),
    })),
    todos: list(raw.todos, 3000).map((t) => ({
      id: str(t.id, 80),
      text: str(t.text),
      day: dateOr(t.day),
      done: !!t.done,
      linked: t.linked && typeof t.linked === 'object'
        ? { date: dateOr(t.linked.date), start: str(t.linked.start, 5), end: str(t.linked.end, 5) }
        : null,
    })),
    journal: list(raw.journal, 400).map((j) => ({ date: dateOr(j.date), text: str(j.text) })),
  };
}

const yes = (v) => (v ? '예' : '아니오');
const tagText = (tags) => (Array.isArray(tags) ? tags : []).map((t) => `#${t}`).join(' ');

/** 할 일에서 시간을 잡아 만든 일정 — '2026-10-24 15:00–16:00' */
function linkedText(l) {
  if (!l || !l.date) return '';
  const time = l.start ? (l.end ? `${l.start}–${l.end}` : l.start) : '';
  return time ? `${l.date} ${time}` : l.date;
}

/**
 * 내보내기 재료 → 탭마다 시트에 쓸 행. 맨 위 한 줄은 내보낸 시각과 담은 범위, 둘째 줄은 머리글.
 * @param {ReturnType<typeof sanitizeExport>} data
 * @returns {{events: string[][], todos: string[][], journal: string[][]}}
 */
function exportRows(data, { now = Date.now(), version = '' } = {}) {
  const at = `마지막 내보낸 시각 ${stamp(now)}${version ? ` · 일정관리 비서 ${version}` : ''}`;
  const span = data.from && data.to ? ` · ${data.from} ~ ${data.to}` : '';
  const since = data.doneSince ? ` · 안 끝낸 할 일 전부와 ${data.doneSince} 이후에 끝낸 것` : '';
  const from = data.journalFrom ? ` · ${data.journalFrom} 부터` : '';
  return {
    events: [
      [`${at}${span} · 반복 일정은 회차마다, 여러 날 일정은 날마다 한 줄(id 가 같다) · 루틴은 싣지 않는다`],
      TABS.events.head,
      ...data.events.map((e) => [e.id, e.date, e.start, e.end, e.title, tagText(e.tags), yes(e.done), e.repeat]),
    ],
    todos: [
      [`${at}${since}`],
      TABS.todos.head,
      ...data.todos.map((t) => [t.id, t.text, t.day, yes(t.done), linkedText(t.linked)]),
    ],
    journal: [
      [`${at}${from} 한 줄 기록`],
      TABS.journal.head,
      ...[...data.journal].sort((a, b) => (a.date < b.date ? -1 : 1)).map((j) => [j.date, j.text]),
    ],
  };
}

// ---------------------------------------------------------------- 받은편지함 (시트 → 위젯)

/**
 * 머리글 줄을 찾는다 — 맨 위 안내 줄이 지워졌거나 칸 순서를 바꿔도 이름으로 칸을 찾는다.
 * @returns {null | {row: number, idx: Record<string, number>} | {row: number, missing: string[]}}
 */
function findHeader(values) {
  for (let i = 0; i < Math.min(values.length, 10); i++) {
    const row = (values[i] || []).map(clean);
    if (!row.includes('요청ID')) continue;
    const idx = Object.fromEntries(INBOX_HEAD.map((name) => [name, row.indexOf(name)]));
    const missing = INBOX_HEAD.filter((name) => idx[name] < 0);
    return missing.length ? { row: i, missing } : { row: i, idx };
  }
  return null;
}

/** 줄의 내용 칸만 이은 것 — 처리하는 동안 줄이 밀렸는지 알아본다 */
function rowSig(row, idx) {
  return INBOX_CONTENT.map((name) => clean(row[idx[name]])).join('␟');
}

const KINDS = { 할일: 'todo', 일정: 'event' };

/** 한 줄 → {request, sig} 또는 {reason}. today — 날짜를 비운 줄이 들어갈 날 */
function readRequest(cell, today) {
  const kindRaw = cell('종류');
  const kind = KINDS[kindRaw.replace(/\s+/g, '')];
  if (!kind) {
    return { reason: kindRaw ? `종류는 '할일' 또는 '일정'입니다 ('${kindRaw}')` : '종류가 비어 있습니다 — 할일 또는 일정' };
  }
  const text = clean(cell('내용/제목'));
  if (!text) return { reason: '내용/제목이 비어 있습니다' };
  const date = readDate(cell('날짜'));
  if (date.error) return { reason: `날짜는 YYYY-MM-DD 로 적습니다 ('${cell('날짜')}')` };
  const memo = clean(cell('메모'));
  // 같은 요청인지 가늠하는 값 — 비운 날짜는 '오늘' 로 풀기 전 값으로 센다(다음 날 다시 읽어도 같게)
  const sigOf = (...parts) => [kind, ...parts].join('␟');

  if (kind === 'todo') {
    // 할 일에는 메모 칸이 없다 — 글 뒤에 잇는다. 시각은 일정에만 쓴다
    const body = withTag(memo ? `${text} — ${memo}` : text);
    return { request: { kind, text: body, date: date.value || today }, sig: sigOf(body, date.value || '') };
  }

  const start = readTime(cell('시작'));
  const end = readTime(cell('끝'));
  if (start.error) return { reason: `시작은 HH:MM 으로 적습니다 ('${cell('시작')}')` };
  if (end.error) return { reason: `끝은 HH:MM 으로 적습니다 ('${cell('끝')}')` };
  if (end.value && !start.value) return { reason: '끝 시각만 있고 시작 시각이 없습니다' };
  if (start.value && end.value && end.value <= start.value) return { reason: '끝 시각이 시작보다 이르거나 같습니다' };
  const title = text.slice(0, TEXT_MAX);
  return {
    request: {
      kind,
      title,
      date: date.value || today,
      start: start.value || null,
      end: end.value || null,
      notes: memo.slice(0, 2000),
      tags: [TAG],
    },
    sig: sigOf(title, date.value || '', start.value || '', end.value || '', memo),
  };
}

/**
 * 받은편지함 → 줄마다 할 일. 상태가 비어 있거나 '대기' 인 줄만 본다.
 *
 * @param {string[][]} values 탭의 값(맨 위 줄부터)
 * @param {object} o
 * @param {Record<string, {at:number, result:string, sig:string}>} o.processed 처리한 요청 — '<시트ID>:<요청ID>' 로 찾는다
 * @param {string} o.sheet 시트 ID — 새 시트를 만들면 요청ID 를 처음부터 다시 쓸 수 있게 요청ID 앞에 붙인다
 * @param {string} o.today 날짜를 비운 줄이 들어갈 날
 * @returns {{error: null | 'empty' | string, items: object[]}}
 *   items — {row, requestId, rowSig, action: 'apply', key, sig, request}
 *         | {row, requestId, rowSig, action: 'error', reason}
 *         | {row, requestId, rowSig, action: 'done', result, at}   (이미 처리했는데 상태만 비어 있다)
 */
function parseInbox(values, { processed = {}, sheet = '', today = dayKey(Date.now()), limit = MAX_ITEMS } = {}) {
  const rows = Array.isArray(values) ? values : [];
  const head = findHeader(rows);
  if (!head) {
    return { error: rows.some((r) => (r || []).some((c) => clean(c))) ? '\'Claude가 넣을 것\' 탭의 머리글 줄이 없습니다' : 'empty', items: [] };
  }
  if (head.missing) return { error: `'Claude가 넣을 것' 탭 머리글에 ${head.missing.join(' · ')} 칸이 없습니다`, items: [] };

  const items = [];
  const seen = new Map();   // 이번에 읽은 요청ID → 행
  for (let i = head.row + 1; i < rows.length && items.length < limit; i++) {
    const row = rows[i] || [];
    const cell = (name) => clean(row[head.idx[name]]);
    if (!row.some((c) => clean(c))) continue;                 // 빈 줄
    const status = cell('상태');
    if (status && status !== '대기') continue;                 // 이미 처리했거나 사람이 멈춰 둔 줄

    const base = { row: i + 1, requestId: cell('요청ID'), rowSig: rowSig(row, head.idx) };
    const error = (reason) => items.push({ ...base, action: 'error', reason });
    if (!base.requestId) { error('요청ID가 비어 있습니다'); continue; }
    if (seen.has(base.requestId)) { error(`같은 요청ID가 ${seen.get(base.requestId)}행에 있습니다`); continue; }
    seen.set(base.requestId, base.row);

    const req = readRequest(cell, today);
    if (req.reason) { error(req.reason); continue; }

    const key = `${sheet}:${base.requestId}`;
    const prev = processed[key];
    if (prev) {
      // 같은 요청을 또 읽었다(상태를 쓰다 끊겼거나 누가 상태를 지웠다) — 다시 만들지 않고 결과만 되적는다
      if (prev.sig === req.sig) items.push({ ...base, action: 'done', result: prev.result, at: prev.at });
      else error('이미 다른 내용으로 처리한 요청ID입니다 — 새 요청ID를 쓰세요');
      continue;
    }
    items.push({ ...base, action: 'apply', key, sig: req.sig, request: { ...req.request, key, requestId: base.requestId } });
  }
  return { error: null, items };
}

/**
 * 상태를 쓸 자리를 다시 찾는다 — 읽고 나서 쓰기 전에 누가 위쪽 줄을 지우거나 끼워 넣었을 수 있다.
 * 원래 행의 내용이 그대로면 그 행, 아니면 같은 내용의 아직 처리 안 된 줄. 못 찾으면 쓰지 않는다.
 */
function relocate(values, head, writes) {
  const taken = new Set();
  const out = [];
  const open = (i) => {
    const s = clean((values[i] || [])[head.idx['상태']]);
    return !s || s === '대기';
  };
  const sigAt = (i) => rowSig(values[i] || [], head.idx);
  for (const w of writes) {
    let row = null;
    const i = w.row - 1;
    if (i > head.row && i < values.length && !taken.has(w.row) && open(i) && sigAt(i) === w.rowSig) row = w.row;
    for (let j = head.row + 1; !row && j < values.length; j++) {
      if (!taken.has(j + 1) && open(j) && sigAt(j) === w.rowSig) row = j + 1;
    }
    if (!row) continue;
    taken.add(row);
    out.push({ ...w, row });
  }
  return out;
}

/** 상태 · 처리시각 · 결과 칸 쓰기 — values:batchUpdate 의 data */
function statusData(title, idx, writes) {
  const data = [];
  for (const w of writes) {
    for (const [name, value] of [['상태', w.status], ['처리시각', w.at], ['결과', w.result]]) {
      data.push({ range: a1(title, `${colName(idx[name])}${w.row}`), values: [[String(value ?? '')]] });
    }
  }
  return data;
}

/** 받은편지함에서 만든 일정의 id — 요청마다 정해져 있어 같은 요청을 두 번 받아도 하나만 생긴다 */
function taskIdFor(key) {
  return `t_${crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 16)}`;
}

// ---------------------------------------------------------------- 시트 다루기 (호스트)

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function timeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';
  } catch {
    return 'Asia/Seoul';
  }
}

const docUrl = (id) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

/** 처음 만들거나 다시 만든 탭에 거는 모양 — 칸 너비 · 맨 위 줄 흐리게 · 머리글 굵게 · 받은편지함은 글자 서식 */
function setupRequests(key, sheetId) {
  const t = TABS[key];
  const reqs = t.widths.map((px, i) => ({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
      properties: { pixelSize: px },
      fields: 'pixelSize',
    },
  }));
  reqs.push(
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { foregroundColorStyle: { rgbColor: GREY } } } },
        fields: 'userEnteredFormat.textFormat.foregroundColorStyle',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    },
  );
  if (key === 'inbox') {
    reqs.push(
      // 글자 그대로 둔다 — 날짜 · 시각 서식이면 2026-10-25 · 14:00 을 '2026. 10. 25' · '오후 2:00:00' 으로 돌려준다
      {
        repeatCell: {
          range: { sheetId },
          cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } },
          fields: 'userEnteredFormat.numberFormat',
        },
      },
      { updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows: rowData([[INBOX_GUIDE], INBOX_HEAD]), fields: 'userEnteredValue' } },
    );
  } else {
    // 사람이 고치려 하면 시트가 한 번 묻는다 — 다음 내보내기에 덮이기 때문이다
    reqs.push({
      addProtectedRange: {
        protectedRange: { range: { sheetId }, description: '위젯이 덮어씁니다 — 고칠 것은 위젯에서', warningOnly: true },
      },
    });
  }
  return reqs;
}

/**
 * @param {object} o
 * @param {string} o.userDataDir
 * @param {ReturnType<import('./google-auth').createGoogleAuth>|null} o.google 구글 로그인(휴대폰 동기화와 같이 쓴다)
 * @param {string} [o.appVersion]
 * @param {() => boolean} [o.syncUsesGoogle] 휴대폰 동기화가 구글 길인가 — 그렇다면 같은 계정이어야 하고, 끌 때 로그인을 남긴다
 * @param {typeof fetch} [o.fetchImpl]
 * @param {string} [o.sheetsBase]
 * @param {string} [o.driveBase]
 * @param {() => number} [o.now]
 * @param {boolean} [o.timers] 시험에서는 5분 주기 없이 tick() 만 부른다
 */
function createClaudeBridge({
  userDataDir,
  google = null,
  appVersion = '',
  syncUsesGoogle = () => false,
  fetchImpl = (...a) => fetch(...a),
  sheetsBase = 'https://sheets.googleapis.com',
  driveBase = 'https://www.googleapis.com',
  now = () => Date.now(),
  timers = true,
}) {
  const configPath = path.join(userDataDir, 'claude-bridge.json');
  const donePath = path.join(userDataDir, 'claude-bridge-done.json');

  let config = readJson(configPath) || {};
  const saved = readJson(donePath)?.done;
  const done = saved && typeof saved === 'object' ? saved : {};

  let send = null;            // (channel, payload) => boolean — 렌더러에 보낸다. 못 보내면 false
  let rendererReady = false;
  let interval = null;
  let queue = Promise.resolve();
  let exportQueued = false;
  let latest = null;          // 렌더러가 마지막으로 보낸 내보내기 재료
  let waiters = [];           // 내보내기 재료를 기다리는 주기
  const replies = new Map();  // 받은편지함을 넘기고 답을 기다리는 것 — token → 끝내는 함수
  let seq = 0;
  let tabs = null;            // 지금 시트의 탭 — key → {sheetId, title}
  let checked = false;        // 이번 실행에서 시트가 아직 있는지 확인했는가
  let lastOkAt = 0;
  let failures = 0;           // 마지막으로 잘 된 뒤로 실패한 횟수
  let lastError = null;
  let problem = null;         // 사용자가 손써야 풀리는 문제(로그인 · API 꺼짐 · 시트 없음) — 주기로는 안 풀린다
  let needsLogin = false;     // 그 문제가 로그인이다 — 켬을 누르면 브라우저가 뜬다

  function saveConfig(next) {
    config = next;
    fs.mkdirSync(userDataDir, { recursive: true });
    writeTextAtomic(configPath, JSON.stringify(config));
  }

  /** 처리한 요청을 적어 둔다 — 시트에 상태를 쓰기 전에(쓰다 끊겨도 다시 만들지 않게) */
  function remember(entries) {
    for (const [key, value] of entries) done[key] = value;
    const keys = Object.keys(done);
    if (keys.length > DONE_KEEP) {
      keys.sort((a, b) => (done[a].at || 0) - (done[b].at || 0));
      for (const k of keys.slice(0, keys.length - DONE_KEEP)) delete done[k];
    }
    fs.mkdirSync(userDataDir, { recursive: true });
    writeTextAtomic(donePath, JSON.stringify({ version: 1, done }));
  }

  async function call(method, url, body) {
    const token = await google.token();
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json; charset=UTF-8' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`구글 시트 오류 ${res.status}`);
      err.status = res.status;
      err.detail = text.slice(0, 600);
      throw err;
    }
    return res.json().catch(() => ({}));
  }

  const sheetUrl = (rest = '') => `${sheetsBase}/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}${rest}`;

  /**
   * 오류 → 설정 줄에 쓸 말. action — 사용자가 손써야 풀린다 · login — 켬을 누르면 로그인부터 · reshape — 탭을 다시 찾는다 ·
   * wait — 위젯 밖의 일이라 기다리면 풀린다(켤 때 이것이면 켠 채로 두고 5분마다 다시 만들어 본다)
   */
  function describe(err) {
    if (err?.name === 'NeedsLogin') {
      return { text: '구글 로그인이 풀렸습니다 — 켬을 다시 누르면 로그인합니다', action: true, login: true };
    }
    if (err?.shape) return { text: err.message, action: true };
    const s = err?.status;
    const d = String(err?.detail || '');
    if (s === 403 && /SERVICE_DISABLED|accessNotConfigured|has not been used|is disabled/i.test(d)) {
      // 켤 수 있는 사람은 클라우드 프로젝트의 주인이다 — 어느 프로젝트인지 구글이 알려 준 번호를 그대로 쓴다
      const project = /projects?[/ ](\d{6,})/i.exec(d)?.[1];
      return {
        text: `구글 시트 API 가 꺼져 있습니다 — 클라우드 프로젝트${project ? ` ${project}` : ''} 주인이 켜면 5분 안에 이어집니다`,
        action: true,
        wait: true,
      };
    }
    if (s === 403 && /insufficient|SCOPE/i.test(d)) {
      return { text: '시트를 다룰 권한이 없습니다 — 켬을 다시 누르면 로그인합니다', action: true, login: true };
    }
    if (s === 404) return { text: '시트를 찾을 수 없습니다 — 끄고 다시 켜면 새로 만듭니다', action: true };
    if (s === 400) return { text: '시트 모양이 바뀌었습니다 — 다음 주기에 다시 맞춥니다', reshape: true };
    if (s === 429) return { text: '구글이 잠시 쉬어 가라고 합니다', wait: true };
    if (s >= 500) return { text: `구글 시트 오류 ${s}`, wait: true };
    if (s) return { text: `구글 시트 오류 ${s}` };
    return { text: '구글에 닿지 못했습니다 — 인터넷 연결을 확인해 주세요', wait: true };
  }

  function succeed() {
    lastOkAt = now();
    failures = 0;
    lastError = null;
    problem = null;
    needsLogin = false;
  }

  function fail(err) {
    const d = describe(err);
    failures += 1;
    lastError = d.text;
    problem = d.action ? d.text : null;
    needsLogin = !!d.login;
    if (d.reshape) tabs = null;
  }

  /** 새 시트 — 내 드라이브 맨 위에 생긴다. 탭 넷과 모양까지 한 번에 */
  async function create() {
    const res = await call('POST', `${sheetsBase}/v4/spreadsheets`, {
      properties: { title: TITLE, locale: 'ko_KR', timeZone: timeZone() },
      sheets: TAB_KEYS.map((key, index) => ({
        properties: {
          title: TABS[key].title,
          index,
          gridProperties: { rowCount: MIN_ROWS, columnCount: 26, frozenRowCount: 2 },
        },
      })),
    });
    const ids = {};
    for (const s of res.sheets || []) {
      const key = TAB_KEYS.find((k) => TABS[k].title === s.properties?.title);
      if (key) ids[key] = s.properties.sheetId;
    }
    saveConfig({
      ...config,
      spreadsheetId: res.spreadsheetId,
      url: res.spreadsheetUrl || docUrl(res.spreadsheetId),
      sheets: ids,
      account: google.account(),
      createdAt: now(),
    });
    tabs = Object.fromEntries(TAB_KEYS.map((k) => [k, { sheetId: ids[k], title: TABS[k].title }]));
    await call('POST', sheetUrl(':batchUpdate'), { requests: TAB_KEYS.flatMap((k) => setupRequests(k, ids[k])) });
  }

  /** 시트가 아직 있는가 — 지웠거나 휴지통에 넣었으면 false */
  async function exists() {
    try {
      const f = await call('GET', `${driveBase}/drive/v3/files/${encodeURIComponent(config.spreadsheetId)}?fields=trashed`);
      return !f.trashed;
    } catch (err) {
      if (err.status === 404) return false;
      throw err;
    }
  }

  /** 탭을 ID 로(이름을 바꿨어도), 없으면 이름으로 찾는다. 지워진 탭은 다시 만든다 */
  async function loadTabs() {
    const meta = await call('GET', sheetUrl(`?fields=${encodeURIComponent('spreadsheetUrl,sheets.properties(sheetId,title)')}`));
    const list = (meta.sheets || []).map((s) => s.properties || {});
    const next = {};
    const missing = [];
    for (const key of TAB_KEYS) {
      const hit = list.find((p) => p.sheetId === config.sheets?.[key]) || list.find((p) => p.title === TABS[key].title);
      if (hit) next[key] = { sheetId: hit.sheetId, title: hit.title };
      else missing.push(key);
    }
    if (missing.length) {
      const r = await call('POST', sheetUrl(':batchUpdate'), {
        requests: missing.map((key) => ({
          addSheet: { properties: { title: TABS[key].title, gridProperties: { rowCount: MIN_ROWS, columnCount: 26, frozenRowCount: 2 } } },
        })),
      });
      (r.replies || []).forEach((rep, i) => {
        const p = rep?.addSheet?.properties;
        if (p) next[missing[i]] = { sheetId: p.sheetId, title: p.title };
      });
      const made = missing.filter((k) => next[k]);
      if (made.length) await call('POST', sheetUrl(':batchUpdate'), { requests: made.flatMap((k) => setupRequests(k, next[k].sheetId)) });
    }
    if (TAB_KEYS.some((k) => !next[k])) throw Object.assign(new Error('탭을 다시 만들지 못했습니다'), { status: 400 });
    tabs = next;
    const ids = Object.fromEntries(TAB_KEYS.map((k) => [k, next[k].sheetId]));
    const url = meta.spreadsheetUrl || config.url;
    if (JSON.stringify(ids) !== JSON.stringify(config.sheets) || url !== config.url) saveConfig({ ...config, sheets: ids, url });
  }

  async function writeExport(data) {
    const rows = exportRows(data, { now: now(), version: appVersion });
    const requests = [];
    for (const key of EXPORT_KEYS) {
      const { sheetId } = tabs[key];
      const values = rows[key];
      requests.push(
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { rowCount: Math.max(MIN_ROWS, values.length + 50) } },
            fields: 'gridProperties.rowCount',
          },
        },
        // 탭 전체를 범위로 주면 쓴 줄 밖은 비워진다 — batchUpdate 한 번이라 읽는 쪽이 반쯤 쓴 표를 보지 않는다
        { updateCells: { range: { sheetId }, rows: rowData(values), fields: 'userEnteredValue' } },
      );
    }
    await call('POST', sheetUrl(':batchUpdate'), { requests });
  }

  /** 렌더러에 내보내기 재료를 달라고 한다. 못 받으면 마지막으로 받은 것 */
  function wantExport() {
    if (!send || !rendererReady) return Promise.resolve(latest);
    return new Promise((resolve) => {
      const finish = (data) => {
        clearTimeout(timer);
        waiters = waiters.filter((f) => f !== finish);
        resolve(data);
      };
      const timer = setTimeout(() => finish(latest), WANT_MS);
      waiters.push(finish);
      if (!send('bridge:want')) finish(latest);
    });
  }

  /** 검사한 요청을 렌더러에 넘겨 store 액션으로 만든다 → [{key, ok, id?, error?}] | null(못 넘겼다) */
  function deliver(requests) {
    if (!send || !rendererReady) return Promise.resolve(null);
    const token = ++seq;
    return new Promise((resolve) => {
      const finish = (results) => {
        clearTimeout(timer);
        replies.delete(token);
        resolve(results);
      };
      const timer = setTimeout(() => finish(null), APPLY_MS);
      replies.set(token, finish);
      if (!send('bridge:inbox', { token, requests })) finish(null);
    });
  }

  async function processInbox() {
    const t = tabs.inbox;
    const read = async () => (await call('GET', sheetUrl(`/values/${encodeURIComponent(a1(t.title, 'A1:Z'))}`))).values || [];
    const values = await read();
    const parsed = parseInbox(values, { processed: done, sheet: config.spreadsheetId, today: dayKey(now()) });
    if (parsed.error === 'empty') {
      // 탭이 통째로 비었다 — 안내 줄과 머리글을 다시 쓴다
      await call('POST', sheetUrl('/values:batchUpdate'), {
        valueInputOption: 'RAW',
        data: [{ range: a1(t.title, 'A1'), values: [[INBOX_GUIDE], INBOX_HEAD] }],
      });
      return;
    }
    if (parsed.error) throw Object.assign(new Error(parsed.error), { shape: true });
    if (!parsed.items.length) return;

    const at = stamp(now());
    const writes = [];
    const apply = parsed.items.filter((x) => x.action === 'apply');
    if (apply.length) {
      const results = await deliver(apply.map((x) => (x.request.kind === 'event'
        ? { ...x.request, taskId: taskIdFor(x.key) }
        : x.request)));
      if (!results) return;   // 렌더러가 못 받았다 — 이 줄들은 그대로 두고 다음 주기에
      const byKey = new Map(results.map((r) => [String(r?.key), r]));
      const made = [];
      for (const it of apply) {
        const r = byKey.get(it.key);
        if (r?.ok && r.id) {
          made.push([it.key, { at: now(), result: String(r.id), sig: it.sig }]);
          writes.push({ ...it, status: '반영됨', at, result: String(r.id) });
        } else {
          writes.push({ ...it, status: '오류', at, result: String(r?.error || '위젯에 넣지 못했습니다') });
        }
      }
      if (made.length) remember(made);
    }
    for (const it of parsed.items) {
      if (it.action === 'error') writes.push({ ...it, status: '오류', at, result: it.reason });
      if (it.action === 'done') writes.push({ ...it, status: '반영됨', at: stamp(it.at), result: it.result });
    }

    const fresh = await read();
    const head = findHeader(fresh);
    if (!head?.idx) return;
    const placed = relocate(fresh, head, writes);
    if (placed.length) {
      await call('POST', sheetUrl('/values:batchUpdate'), { valueInputOption: 'RAW', data: statusData(t.title, head.idx, placed) });
    }
  }

  /** 줄을 세운다 — 시트 만들기 · 내보내기 · 받은편지함이 한 시트를 동시에 건드리지 않게 */
  function enqueue(job) {
    const run = queue.then(job);
    queue = run.catch(() => {});
    return run;
  }

  /** 켜질 때 · 5분마다: 내보내기 + 받은편지함. 켤 때 시트를 못 만들었으면(시트 API 가 꺼져 있었다 등) 그것부터 */
  async function tickJob() {
    if (!config.enabled || !google) return;
    try {
      if (!config.spreadsheetId) {
        await create();
        checked = true;
      } else if (!checked) {
        if (!(await exists())) throw Object.assign(new Error('없는 시트'), { status: 404 });
        checked = true;
      }
      await loadTabs();
      const data = await wantExport();
      if (data) await writeExport(data);
      await processInbox();
      succeed();
    } catch (err) {
      fail(err);
    }
  }

  /** 일정 · 할 일이 바뀐 뒤(렌더러가 30초 모아 보낸다): 내보내기만 */
  async function exportJob() {
    exportQueued = false;
    if (!config.enabled || !config.spreadsheetId || !latest || !google) return;
    try {
      if (!tabs) await loadTabs();
      await writeExport(latest);
      succeed();
    } catch (err) {
      fail(err);
    }
  }

  function stopTimer() {
    clearInterval(interval);
    interval = null;
  }

  function restartTimer() {
    stopTimer();
    if (!timers || !config.enabled || !send) return;
    interval = setInterval(() => { enqueue(tickJob); }, TICK_MS);
  }

  function status() {
    const connected = !!google?.connected();
    return {
      available: !!google?.available,
      enabled: !!config.enabled,
      connected,
      needsScope: !connected || !google.hasScope(FILE_SCOPE),
      needsLogin,
      url: config.url || null,
      title: TITLE,
      account: config.account || null,
      lastOkAt,
      failures,
      lastError,
      problem,
    };
  }

  /**
   * 켠다 — 권한이 모자라면 브라우저로 로그인을 한 번 더 하고, 시트가 없으면 만든 뒤 첫 연동까지 마친다.
   * @returns {Promise<{ok:true, status} | {ok:false, error:string}>}
   */
  async function enable() {
    if (!google?.available) return { ok: false, error: '이 빌드에는 구글 연결 정보가 없습니다.' };
    let pending = null;   // 시트를 아직 못 만든 까닭 — 켠 채로 두고 주기가 다시 해 본다
    try {
      let login = !google.connected() || !google.hasScope(FILE_SCOPE);
      if (!login) {
        try {
          await google.token();
        } catch (err) {
          if (err?.name !== 'NeedsLogin') throw err;
          login = true;
        }
      }
      if (login) {
        const account = google.account();
        try {
          // 휴대폰 동기화가 구글을 쓰면 같은 계정이어야 한다 — 다른 계정이면 동기화가 다른 드라이브를 보게 된다
          await google.login({ scopes: [FILE_SCOPE], loginHint: account, expectEmail: syncUsesGoogle() ? account : null });
        } catch (err) {
          return { ok: false, error: err.message || '구글에 연결하지 못했습니다.' };
        }
        if (!google.hasScope(FILE_SCOPE)) {
          return { ok: false, error: '구글 화면에서 드라이브 파일 권한에 체크해야 시트를 만들 수 있습니다.' };
        }
      }
      // 어느 시트를 쓸지 정하고 없으면 만드는 일도 줄을 선다 — 켠 채로 기다리던 주기가 막 시트를 만들고 있었으면
      // 그 시트를 쓴다(따로 만들면 같은 이름의 시트가 두 장 생긴다)
      await enqueue(async () => {
        // 다른 계정으로 바뀌었으면 예전 시트는 그 계정의 것이다 — 이 계정에 새로 만든다
        if (config.spreadsheetId && config.account && config.account !== google.account()) {
          saveConfig({ ...config, spreadsheetId: null, url: null, sheets: null });
        }
        if (config.spreadsheetId && !(await exists())) saveConfig({ ...config, spreadsheetId: null, url: null, sheets: null });
        if (config.spreadsheetId) return;
        try {
          await create();
        } catch (err) {
          // 시트 API 가 꺼져 있거나 잠깐 닿지 않는다 — 위젯 밖의 일이다. 켠 채로 두고 5분마다 다시 만들어 본다
          // (주인이 API 를 켜면 사람이 다시 누르지 않아도 이어진다)
          if (!describe(err).wait) throw err;
          pending = err;
        }
      });
      checked = !pending;
      saveConfig({ ...config, enabled: true });
    } catch (err) {
      return { ok: false, error: describe(err).text };
    }
    failures = 0;
    lastError = null;
    problem = null;
    needsLogin = false;
    tabs = null;
    restartTimer();
    if (pending) fail(pending);
    else await enqueue(tickJob);
    return { ok: true, status: status() };
  }

  /** 끈다 — 시트는 드라이브에 남긴다(다시 켜면 같은 시트를 이어 쓴다) */
  async function disable() {
    stopTimer();
    failures = 0;
    problem = null;
    needsLogin = false;
    lastError = null;
    try {
      saveConfig({ ...config, enabled: false });
    } catch (err) {
      lastError = `설정을 저장하지 못했습니다 — ${err.message}`;
    }
    for (const f of [...waiters]) f(null);
    // 휴대폰 동기화가 구글을 쓰지 않으면 이 로그인은 시트만 쓰던 것이다 — 이 PC 에서 지운다
    if (google?.connected() && !syncUsesGoogle()) await google.logout().catch(() => {});
    return status();
  }

  /**
   * 렌더러가 내보내기 재료를 보냈다 — 주기가 기다리던 것이면 넘기고, 아니면(바뀐 뒤 30초) 내보낸다.
   * enabled 를 돌려준다 — 꺼져 있으면 렌더러는 다시 달랄 때까지 보내지 않는다.
   */
  function takeExport(raw) {
    const data = sanitizeExport(raw);
    if (!data) return { ok: false, enabled: !!config.enabled };
    latest = data;
    if (waiters.length) {
      for (const f of [...waiters]) f(data);
    } else if (config.enabled && config.spreadsheetId && !exportQueued) {
      exportQueued = true;
      enqueue(exportJob);
    }
    return { ok: true, enabled: !!config.enabled };
  }

  /** 렌더러가 받은편지함을 반영했다 */
  function applied(token, results) {
    const finish = replies.get(token);
    if (!finish) return;
    finish(Array.isArray(results) ? results.slice(0, 1000).filter((r) => r && typeof r === 'object') : null);
  }

  /** @param {(channel: string, payload?: object) => boolean} sendFn 렌더러에 보낸다. 못 보내면 false */
  function start(sendFn) {
    send = sendFn;
    restartTimer();
  }

  function stop() {
    stopTimer();
    send = null;
    rendererReady = false;
    for (const f of [...waiters]) f(null);
    for (const finish of [...replies.values()]) finish(null);
  }

  /** 렌더러가 (다시) 떴다 — 곧바로 한 번 */
  function ready() {
    rendererReady = true;
    if (config.enabled) enqueue(tickJob);
  }

  /** 시험 · 수동 — 한 주기를 지금 돌린다 */
  function tick() {
    return enqueue(tickJob);
  }

  return {
    status, enable, disable, takeExport, applied, start, stop, ready, tick,
    enabled: () => !!config.enabled,
    url: () => config.url || null,
  };
}

module.exports = {
  createClaudeBridge,
  exportRows,
  sanitizeExport,
  parseInbox,
  findHeader,
  relocate,
  statusData,
  readDate,
  readTime,
  taskIdFor,
  TITLE,
  TABS,
  INBOX_HEAD,
  INBOX_GUIDE,
  TAG,
};
