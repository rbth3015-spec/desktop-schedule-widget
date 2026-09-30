#!/usr/bin/env node
// 일정관리 비서 — MCP 서버.
//
// Claude(데스크톱 · 코드 · 그 밖의 MCP 클라이언트)가 말로 일정을 넣게 해 주는 다리다.
//   "일정비서에 내일 3시 치과 넣어놔"  →  add_task("치과 @내일 15:00")
//
// 어떻게 들어가나
//   앱의 **받은함 폴더**(%USERPROFILE%\.schedule-widget\inbox)에 파일 한 장을 쓰는 것이 전부다
//   (src/main/inbox.js). 앱이 켜져 있으면 1초 안에 들어가고, 꺼져 있으면 다음에 켤 때 들어간다.
//   포트도 토큰도 없고, 이 서버는 앱을 실행하지도 조작하지도 않는다.
//
//   받은함이 AppData 밖에 있는 이유: Microsoft Store 판 Claude 데스크톱이 띄운 이 서버가
//   AppData 에 새 파일을 만들면 Windows 가 Claude 의 개인 보관소로 옮겨 버려 앱이 보지 못한다.
//
// 읽기는 저장 파일(schedule-data.json)을 그대로 읽는다 — 읽기만 하고 쓰지 않는다.
//
// 설치 — docs/MCP.md 에 차근차근 적어 두었다.
//   Claude Code     claude mcp add --scope user schedule -- node "<이 파일 경로>"
//   Claude 데스크톱  claude_desktop_config.json 의 mcpServers 에 "schedule" 한 덩어리
//
// 의존성 없음. stdio 로 줄 단위 JSON-RPC 를 주고받는다(MCP stdio 전송).

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'schedule-widget';
const VERSION = '1.2.0';
const PROTOCOL = '2024-11-05';

// ---------------------------------------------------------------- 자리

function userDataDir() {
  if (process.env.SCHEDULE_WIDGET_DIR) return process.env.SCHEDULE_WIDGET_DIR;
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'schedule-widget');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'schedule-widget');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'schedule-widget');
}

// 받은함 — 앱과 같은 규칙. 데이터 폴더를 옮겼으면 그 안, 아니면 사용자 폴더(AppData 밖)
const inboxDir = () => (process.env.SCHEDULE_WIDGET_DIR
  ? path.join(process.env.SCHEDULE_WIDGET_DIR, 'inbox')
  : path.join(os.homedir(), '.schedule-widget', 'inbox'));
const dataFile = () => path.join(userDataDir(), 'schedule-data.json');

// ---------------------------------------------------------------- 날짜 (앱과 같은 규칙: 로컬 'YYYY-MM-DD')

const pad = (n) => String(n).padStart(2, '0');
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => toKey(new Date());

function fromKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(key, n) {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
}

/** 이번 주(일요일 시작) 7칸 */
function weekGrid(key) {
  const d = fromKey(key);
  const start = new Date(d);
  start.setDate(d.getDate() - d.getDay());
  return Array.from({ length: 7 }, (_, i) => {
    const cur = new Date(start);
    cur.setDate(start.getDate() + i);
    return toKey(cur);
  });
}

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

// ---------------------------------------------------------------- 받은함에 쓰기

function drop(name, text) {
  const dir = inboxDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${Date.now()}.${name === 'mcp-goal' || name === 'mcp-todo' ? 'json' : 'txt'}`);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

// ---------------------------------------------------------------- 저장 파일 읽기 (읽기 전용)

function readData() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    return {
      tasks: Array.isArray(parsed?.tasks) ? parsed.tasks : [],
      journal: parsed?.journal && typeof parsed.journal === 'object' ? parsed.journal : {},
      todos: Array.isArray(parsed?.todos) ? parsed.todos : [],
    };
  } catch {
    return { tasks: [], journal: {}, todos: [] };
  }
}

/**
 * 그날 보이는 할 일 — 앱(store.todosOn)과 같은 규칙.
 * 그날까지 적었고, 아직 안 끝났거나 그날 이후에 끝낸 것. 다 못 한 것은 다음 날로 이어진다.
 */
function todosOn(key) {
  const { todos } = readData();
  return todos
    .filter((t) => t && t.day && t.text && t.day <= key && (!t.done || (t.doneOn || t.day) >= key))
    .sort((a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0))
    .map((t) => {
      const doneHere = !!t.done && t.doneOn === key;
      const age = Math.round((fromKey(key) - fromKey(t.day)) / 86400000) + 1;
      return `${doneHere ? '✓' : '□'}  ${t.text}${!doneHere && age >= 2 ? `  (${age}일째)` : ''}`;
    });
}

/**
 * 그날 이 일정이 있나.
 * 앱(store.occursOn)의 규칙을 줄여 옮긴 것이다 — 매일 · 매주(요일) · 매월 · 매년 + 간격 + 종료일 + 예외.
 * 여기서 틀리면 '오늘 뭐 있지?' 대답이 조용히 어긋나므로, 규칙을 바꿀 때 같이 고친다.
 */
function occursOn(t, key) {
  if (!t.start || key < t.start) return false;
  const r = t.repeat;
  if (!r) return key <= (t.end || t.start);
  if (r.until && key > r.until) return false;
  if (Array.isArray(t.exceptions) && t.exceptions.includes(key)) return false;

  const a = fromKey(t.start);
  const b = fromKey(key);
  const days = Math.round((b - a) / 86400000);
  const interval = Math.max(1, Number(r.interval) || 1);

  if (r.freq === 'daily') return days % interval === 0;
  if (r.freq === 'weekly') {
    if (Array.isArray(r.days) && r.days.length) {
      if (!r.days.includes(b.getDay())) return false;
      const weeks = Math.round((startOfWeek(b) - startOfWeek(a)) / (7 * 86400000));
      return weeks % interval === 0;
    }
    return days % (7 * interval) === 0;
  }
  if (r.freq === 'monthly') {
    if (b.getDate() !== a.getDate()) return false;
    const months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    return months >= 0 && months % interval === 0;
  }
  if (r.freq === 'yearly') {
    if (b.getDate() !== a.getDate() || b.getMonth() !== a.getMonth()) return false;
    return (b.getFullYear() - a.getFullYear()) % interval === 0;
  }
  return false;
}

function startOfWeek(d) {
  const x = new Date(d);
  x.setDate(x.getDate() - x.getDay());
  x.setHours(0, 0, 0, 0);
  return x;
}

/** 그날 걸린 일정 — 시각 있는 것 먼저, 그다음 적은 순서 */
function tasksOn(key, { routines = false } = {}) {
  const { tasks } = readData();
  return tasks
    .filter((t) => {
      if (t.repeat) return !!t.repeat.routine === routines && occursOn(t, key);
      return !routines && occursOn(t, key);
    })
    .map((t) => ({
      title: t.title || '(제목 없음)',
      time: t.startTime || '',
      done: t.repeat || t.dailyCheck
        ? (Array.isArray(t.doneDates) && t.doneDates.includes(key))
        : !!t.done,
      tags: Array.isArray(t.tags) ? t.tags : [],
      span: t.end && t.end > t.start ? `${t.start} → ${t.end}` : '',
    }))
    .sort((a, b) => (a.time ? 0 : 1) - (b.time ? 0 : 1) || (a.time < b.time ? -1 : 1));
}

function lineOf(t) {
  const mark = t.done ? '✓' : '□';
  const when = t.time ? ` ${t.time}` : '';
  const tags = t.tags.length ? `  ${t.tags.map((x) => `#${x}`).join(' ')}` : '';
  const span = t.span ? `  (${t.span})` : '';
  return `${mark}${when}  ${t.title}${tags}${span}`;
}

// ---------------------------------------------------------------- 도구

const TOOLS = [
  {
    name: 'add_task',
    description: [
      '일정관리 비서(일정비서)에 일정을 넣는다. 여러 건이면 줄바꿈으로 나눠 한 번에 보낸다.',
      '한 줄 문법: 제목 @시작일 ~종료일 15:00 또는 15:00~16:30 #태그 ! 또는 !! *색',
      '  @오늘 @내일 @모레 @금 @8/15 @2026-08-15  ~3d(시작일+3일) ~8/20',
      '  ! 중요 · !! 긴급 · *파랑 *초록 *노랑 *빨강 *보라 *회색',
      '  길이: 시작 시각 뒤에 1시간 · 30분 · 1시간반 · 90분 (예: 15:00 1시간 → 15:00–16:00)',
      '날짜를 적지 않으면 오늘로 들어간다. @내일 같은 말은 지금(보낸 날) 기준으로 풀린다.',
      '시각이 정해지지 않은 "해야 할 일" 은 이 도구가 아니라 add_todo 로 넣는다.',
      '예) "치과 @내일 15:00 #건강 !" · "기획서 마감 @8/15 ~3d *빨강 !!"',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '한 줄 문법. 줄바꿈으로 여러 건' },
      },
      required: ['text'],
    },
  },
  {
    name: 'add_goal',
    description: '이번 주 · 이번 달 목표를 계획 화면에 넣는다. 날짜는 나중에 사용자가 요일로 끌어 정한다.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '목표 한 줄' },
        scope: { type: 'string', enum: ['week', 'month'], description: "'week'(이번 주·기본) | 'month'(이번 달)" },
      },
      required: ['title'],
    },
  },
  {
    name: 'add_todo',
    description: [
      '일정관리 비서의 "할 일" 목록(달력과 따로 가는 그날그날의 체크리스트)에 넣는다.',
      '시각 없이 오늘 해치울 일 — "할 일에 넣어줘", "투두에 추가해줘" 같은 말이면 이 도구다.',
      '여러 개면 줄바꿈으로 나눠 한 번에 보낸다. 날짜 · 시각 문법은 읽지 않는다(글 그대로 적힌다).',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '할 일. 줄바꿈으로 여러 개' },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_todos',
    description: '오늘 할 일 목록을 읽는다(✓ 지운 것 · □ 남은 것 · 며칠째 이어진 것). 읽기 전용.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_today',
    description: '오늘 잡힌 일정과 루틴을 읽는다(읽기 전용).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_week',
    description: '이번 주(일~토) 일정을 날짜별로 읽는다(읽기 전용).',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: "기준 날짜 'YYYY-MM-DD' (없으면 오늘이 든 주)" },
      },
    },
  },
];

function callTool(name, args) {
  if (name === 'add_task') {
    const text = String(args?.text ?? '').trim();
    if (!text) return '넣을 내용이 비어 있습니다.';
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return '넣을 내용이 비어 있습니다.';
    drop('mcp', lines.join('\r\n'));
    return `${lines.length}건을 받은함에 넣었습니다 — 앱이 켜져 있으면 곧바로, 꺼져 있으면 다음에 켤 때 들어갑니다.\n`
      + lines.map((l) => `  · ${l}`).join('\n');
  }

  if (name === 'add_goal') {
    const title = String(args?.title ?? '').trim();
    if (!title) return '목표가 비어 있습니다.';
    const scope = String(args?.scope) === 'month' ? 'month' : 'week';
    drop('mcp-goal', JSON.stringify({ goals: [{ scope, title }] }));
    return `${scope === 'month' ? '이번 달' : '이번 주'} 목표로 넣었습니다 — ${title}`;
  }

  if (name === 'add_todo') {
    const items = String(args?.text ?? '').split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)]|\[[ xX]?\])\s*/, '').trim()).filter(Boolean);
    if (!items.length) return '넣을 할 일이 비어 있습니다.';
    drop('mcp-todo', JSON.stringify({ todos: items }));
    return `할 일 ${items.length}개를 받은함에 넣었습니다 — 앱이 켜져 있으면 곧바로 오늘 목록에 들어갑니다.\n`
      + items.map((l) => `  □ ${l}`).join('\n');
  }

  if (name === 'list_todos') {
    const key = todayKey();
    const list = todosOn(key);
    const head = `${key} (${WEEKDAY[fromKey(key).getDay()]}) 할 일`;
    if (!list.length) return `${head} — 적어 둔 것이 없습니다.`;
    const done = list.filter((l) => l.startsWith('✓')).length;
    return [`${head} — ${done}/${list.length}`, '', ...list.map((l) => `  ${l}`)].join('\n');
  }

  if (name === 'list_today') {
    const key = todayKey();
    const items = tasksOn(key);
    const routines = tasksOn(key, { routines: true });
    const head = `${key} (${WEEKDAY[fromKey(key).getDay()]})`;
    if (!items.length && !routines.length) return `${head} — 잡힌 일이 없습니다.`;
    const out = [head];
    if (items.length) out.push('', '일정', ...items.map((t) => `  ${lineOf(t)}`));
    if (routines.length) out.push('', '루틴', ...routines.map((t) => `  ${lineOf(t)}`));
    return out.join('\n');
  }

  if (name === 'list_week') {
    const base = /^\d{4}-\d{2}-\d{2}$/.test(String(args?.from)) ? args.from : todayKey();
    const keys = weekGrid(base);
    const out = [`${keys[0]} – ${keys[6]}`];
    for (const key of keys) {
      const items = tasksOn(key);
      const label = `${key.slice(5)} (${WEEKDAY[fromKey(key).getDay()]})`;
      out.push('', `${label}${key === todayKey() ? '  ← 오늘' : ''}`);
      if (!items.length) out.push('  —');
      else for (const t of items) out.push(`  ${lineOf(t)}`);
    }
    return out.join('\n');
  }

  throw new Error(`모르는 도구: ${name}`);
}

// ---------------------------------------------------------------- JSON-RPC (stdio · 줄 단위)

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
    });
    return;
  }
  if (method === 'ping') { reply(id, {}); return; }
  if (method === 'tools/list') { reply(id, { tools: TOOLS }); return; }
  if (method === 'tools/call') {
    const tool = String(params?.name ?? '');
    try {
      const text = callTool(tool, params?.arguments || {});
      reply(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      reply(id, { content: [{ type: 'text', text: `실패: ${err.message}` }], isError: true });
    }
    return;
  }
  // 알림(id 없음)에는 답하지 않는다
  if (id === undefined || id === null) return;
  fail(id, -32601, `지원하지 않는 메서드: ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;   // 줄이 깨졌으면 버린다 — 여기서 죽으면 클라이언트가 붙어 있을 수 없다
    }
    try {
      handle(msg);
    } catch (err) {
      if (msg && msg.id != null) fail(msg.id, -32603, err.message);
      else console.error('[mcp] 처리 실패:', err.message);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
