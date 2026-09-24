// 받은함 — 앱 바깥에서 일정을 넣는 **유일한 문**.
//
// 왜 폴더인가
//   바깥(스크립트 · AI · 다른 앱)에서 일정을 넣으려면 어딘가 문을 내야 한다. 포트를 여는 쪽은
//   방화벽 · 토큰 · 늘 떠 있는 서버가 따라오고, 구멍이 하나 더 생긴다.
//   파일 한 장을 떨어뜨리는 쪽은 그런 게 없고, 앱이 꺼져 있어도 다음에 켤 때 들어온다.
//
// 무엇이 들어오나
//   .txt / .md  한 줄에 하나. 앱의 한 줄 문법 그대로 — '치과 @내일 15:00 #건강 !'
//   .json       { "tasks": [ {title, start, ...} ] } | { "lines": ["치과 @내일 15:00"] }
//               | { "goals": [ {scope:'week'|'month', title} ] } | 위 셋을 섞어 하나로
//
// 앱은 이 파일을 **해석만** 한다. 실행하지 않고, 경로도 명령도 받지 않는다.
// 읽은 파일은 inbox/done/ 으로 옮겨 최근 50장만 남긴다 — 무엇이 들어왔는지 되짚을 수 있게.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/** 한 파일에서 받아들일 최대 크기 · 개수 — 터무니없는 입력을 막는다 */
const MAX_BYTES = 256 * 1024;
const MAX_ITEMS = 200;
const DONE_KEEP = 50;

/** fs.watch 는 한 번 저장에 여러 번 울린다. 잠깐 모았다가 한 번에 읽는다. */
const DEBOUNCE_MS = 300;
/** Windows 의 fs.watch 는 이벤트를 놓치기도 한다 — 가끔 훑어 본다(읽을 게 없으면 readdir 한 번). */
const SWEEP_MS = 30 * 1000;

const README = [
  '받은함 — 여기에 파일을 두면 일정관리 비서가 집어넣습니다.',
  '',
  '  약속.txt      한 줄에 하나',
  '                  치과 @내일 15:00 #건강 !',
  '                  장보기 @토 *초록',
  '',
  '  일정.json     { "tasks": [ { "title": "치과", "start": "2026-09-24", "startTime": "15:00" } ] }',
  '                { "lines": [ "치과 @내일 15:00" ] }',
  '                { "goals": [ { "scope": "week", "title": "보고서 초안" } ] }',
  '',
  '읽은 파일은 done/ 으로 옮깁니다. 앱이 꺼져 있으면 다음에 켤 때 들어옵니다.',
  '',
].join('\r\n');

let dir = '';
let doneDir = '';
let watcher = null;
let sweepTimer = null;
let timer = null;
let deliver = null;          // (payload) => boolean  — 렌더러에 넘긴다. 못 넘기면 false.
const pending = [];          // 렌더러가 아직 준비되지 않았을 때 쌓아 둔다

function ensureDirs() {
  dir = path.join(app.getPath('userData'), 'inbox');
  doneDir = path.join(dir, 'done');
  fs.mkdirSync(doneDir, { recursive: true });
  const readme = path.join(dir, '읽어보기.txt');
  try {
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, README, 'utf8');
  } catch { /* 안내 파일 하나 못 써도 받은함은 돈다 */ }
}

/** 이 파일을 읽을 것인가 */
function isInput(name) {
  return /\.(txt|md|json)$/i.test(name) && name !== '읽어보기.txt';
}

/** 한 줄짜리 문법 줄 — 빈 줄과 '#' 로 시작하는 메모는 버린다 */
function readLines(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .slice(0, MAX_ITEMS);
}

/**
 * 파일 하나를 읽어 렌더러에 넘길 꼴로 바꾼다.
 * 바깥에서 온 값이라 여기서 모양만 본다 — 실제 검증(날짜 · 시각 규칙)은 store 가 다시 한다.
 */
function parseFile(file) {
  let text;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (!text.trim()) return null;

  const source = path.basename(file);

  if (/\.json$/i.test(file)) {
    let data;
    try { data = JSON.parse(text); } catch { return null; }
    if (Array.isArray(data)) data = { tasks: data };
    if (!data || typeof data !== 'object') return null;

    const tasks = Array.isArray(data.tasks)
      ? data.tasks.filter((t) => t && typeof t === 'object').slice(0, MAX_ITEMS)
      : [];
    const lines = Array.isArray(data.lines)
      ? data.lines.filter((l) => typeof l === 'string').map((l) => l.trim()).filter(Boolean).slice(0, MAX_ITEMS)
      : [];
    const goals = Array.isArray(data.goals)
      ? data.goals.filter((g) => g && typeof g === 'object').slice(0, MAX_ITEMS)
      : [];
    if (!tasks.length && !lines.length && !goals.length) return null;
    return { source, tasks, lines, goals };
  }

  const lines = readLines(text);
  return lines.length ? { source, tasks: [], lines, goals: [] } : null;
}

/** 읽은 파일을 done/ 으로 옮기고 오래된 것은 지운다 */
function retire(file) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dest = path.join(doneDir, `${stamp}-${path.basename(file)}`);
  try {
    fs.renameSync(file, dest);
  } catch {
    try { fs.unlinkSync(file); } catch { /* 지우지 못해도 다음에 다시 시도한다 */ }
  }
  try {
    const olds = fs.readdirSync(doneDir).sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - DONE_KEEP))) {
      try { fs.unlinkSync(path.join(doneDir, f)); } catch { /* 무시 */ }
    }
  } catch { /* 무시 */ }
}

/** 받은함을 한 번 훑는다 */
function sweep() {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(isInput).sort();
  } catch {
    return;
  }

  for (const name of names) {
    const file = path.join(dir, name);
    const payload = parseFile(file);
    // 모양이 아닌 파일은 조용히 done 으로 보낸다 — 계속 다시 읽으며 맴돌지 않게
    if (!payload) { retire(file); continue; }

    if (deliver && deliver(payload)) retire(file);
    else { pending.push(payload); retire(file); }
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(sweep, DEBOUNCE_MS);
}

/**
 * 받은함을 연다.
 * @param {(payload: object) => boolean} send 렌더러에 넘기는 함수. 창이 아직 없으면 false 를 준다.
 */
function start(send) {
  deliver = send;
  ensureDirs();

  try {
    watcher = fs.watch(dir, { persistent: false }, (_type, name) => {
      if (!name || isInput(String(name))) schedule();
    });
  } catch (err) {
    console.error('[inbox] 폴더를 지켜보지 못합니다:', err.message);
  }
  clearInterval(sweepTimer);
  sweepTimer = setInterval(sweep, SWEEP_MS);
  sweep();
}

function stop() {
  clearTimeout(timer);
  clearInterval(sweepTimer);
  try { watcher?.close(); } catch { /* 무시 */ }
  watcher = null;
}

/** 렌더러가 준비됐다고 알려 오면 쌓아 둔 것을 넘긴다 */
function flush() {
  if (!deliver) return;
  while (pending.length) {
    const payload = pending.shift();
    if (!deliver(payload)) { pending.unshift(payload); return; }
  }
  sweep();
}

/** 명령줄 · 다른 곳에서 한 줄을 넣을 때 — 받은함에 파일로 쓴다(들어오는 길은 하나다) */
function drop(text, tag = 'cli') {
  const line = String(text || '').trim();
  if (!line) return false;
  try {
    ensureDirs();
    const name = `${tag}-${Date.now()}.txt`;
    fs.writeFileSync(path.join(dir, name), line.slice(0, MAX_BYTES), 'utf8');
    schedule();
    return true;
  } catch (err) {
    console.error('[inbox] 받은함에 쓰지 못했습니다:', err.message);
    return false;
  }
}

/** 받은함 폴더 경로 (설정에서 열어 준다) */
function dirPath() {
  ensureDirs();
  return dir;
}

module.exports = { start, stop, flush, drop, dirPath };
