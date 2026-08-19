// 렌더러 전역 상태 저장소. 단일 소스 오브 트루스.
// 뷰 모듈(calendar / todo)은 store 를 직접 mutate 하지 않고 액션 함수만 호출한다.

import { todayKey } from './lib/date.js';

const listeners = new Set();
let saveTimer = null;

/**
 * @typedef {Object} Task
 * @property {string}  id
 * @property {string}  title
 * @property {string}  notes
 * @property {string|null} start   'YYYY-MM-DD' — 시작일. null 이면 '언젠가(inbox)'
 * @property {string|null} end     'YYYY-MM-DD' — 종료일. 단일 일정이면 start 와 동일
 * @property {boolean} done
 * @property {number}  priority    0=보통 1=중요 2=긴급
 * @property {string}  color       카테고리 색 키 (COLORS 참조)
 * @property {string[]} tags
 * @property {number}  order       같은 날짜 내 정렬 순서
 * @property {number}  createdAt   epoch ms
 * @property {number|null} doneAt
 */

// 안료 계열. 형광빛 원색은 종이/가죽 배경과 따로 놀아서 채도를 낮췄다.
// 전부 어두운 값이라 위에 얹는 글자색(--on-color)은 밝은 아이보리로 고정한다.
export const COLORS = {
  blue:   '#3e5c76',   // 청람
  green:  '#5a7a58',   // 쑥
  amber:  '#b0843f',   // 치자
  rose:   '#a6544c',   // 다홍
  violet: '#6f5b84',   // 자주
  slate:  '#78736a',   // 회묵
};

export const PRIORITY_LABELS = ['보통', '중요', '긴급'];

const DEFAULT_SETTINGS = {
  theme: 'light',         // 'light'(종이) | 'dark'(가죽)
  // 배경 투명도(0.4~1). 창 전체가 아니라 배경 알파만 조절하므로 글자는 또렷하게 남는다.
  // Windows 의 transparent 창에 setOpacity 를 걸면 합성이 불안정해 CSS 로 처리한다.
  opacity: 0.9,
  splitRatio: 0.56,       // 캘린더가 차지하는 가로 비율
  alwaysOnTop: false,
  clickThroughLocked: false,
  showCompleted: true,
  weekStart: 0,           // 0=일요일
  fontScale: 1,           // 0.8 ~ 1.4
  sortMode: 'manual',     // 'manual' = 드래그 순서 우선 | 'priority' = 우선순위 우선

  // --- 외형 ---
  blurEnabled: true,      // 백드롭 블러. 저사양이면 끄는 폴백
  dimInactive: true,      // 창이 비활성일 때 배경으로 물러남 (macOS 위젯 방식)

  // --- 패널 표시 ---
  showDashboard: true,    // Zone C: D-Day 대시보드
  showLauncher: true,     // Zone D: 퀵 런처 도크
};

/**
 * @typedef {Object} LauncherItem
 * @property {string} id
 * @property {string} label
 * @property {string} icon    이모지 1~2자
 * @property {'url'|'script'|'app'|'folder'} kind
 * @property {string} target  URL 또는 로컬 절대경로
 * @property {string[]} args  script/app 실행 인자
 * @property {number} order
 */

const state = {
  tasks: /** @type {Task[]} */ ([]),
  launcher: /** @type {LauncherItem[]} */ ([]),
  reminderLog: /** @type {{id:string,taskId:string,title:string,at:number}[]} */ ([]),
  settings: { ...DEFAULT_SETTINGS },
  // --- UI 상태(영속화 안 함) ---
  selectedDate: todayKey(),
  anchorMonth: todayKey(),   // 캘린더가 보여주는 달
  filter: { text: '', tag: null },
  editingTaskId: null,
  ready: false,
  loadNotice: null,
};

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(state);
}

/** 영속 데이터만 디바운스 저장 */
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.api.saveData({
      tasks: state.tasks,
      launcher: state.launcher,
      reminderLog: state.reminderLog,
      settings: state.settings,
    });
  }, 250);
}

function commit({ save = true } = {}) {
  if (save) persist();
  emit();
}

// ---------------------------------------------------------------- 되돌리기
//
// 액션마다 역연산을 짜는 대신 '바뀌기 직전 상태'를 통째로 찍어 둔다.
// 일정 수가 수천 개가 되어도 스냅샷 하나는 수백 KB 수준이라 실사용에 문제가 없고,
// 새 액션을 추가할 때 되돌리기 로직을 따로 안 짜도 된다는 점이 훨씬 크다.

const UNDO_LIMIT = 50;
const undoStack = [];
const redoStack = [];

function snapshot() {
  return {
    tasks: structuredClone(state.tasks),
    launcher: structuredClone(state.launcher),
  };
}

function restore(snap) {
  state.tasks = snap.tasks;
  state.launcher = snap.launcher;
}

/** 되돌릴 수 있는 변경 직전에 부른다. label 은 사용자에게 보여줄 문구. */
function pushUndo(label) {
  undoStack.push({ label, data: snapshot() });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;   // 새 변경이 생기면 다시 실행 이력은 버린다
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }

/** @returns {string|null} 되돌린 동작의 이름 (없으면 null) */
export function undo() {
  const entry = undoStack.pop();
  if (!entry) return null;
  redoStack.push({ label: entry.label, data: snapshot() });
  restore(entry.data);
  commit();
  return entry.label;
}

export function redo() {
  const entry = redoStack.pop();
  if (!entry) return null;
  undoStack.push({ label: entry.label, data: snapshot() });
  restore(entry.data);
  commit();
  return entry.label;
}

// ---------------------------------------------------------------- 초기화

export async function init() {
  const data = await window.api.loadData();
  state.tasks = Array.isArray(data?.tasks) ? data.tasks.map(normalize) : [];
  state.launcher = Array.isArray(data?.launcher)
    ? data.launcher.map(normalizeLauncher)
    : defaultLauncher();
  state.reminderLog = Array.isArray(data?.reminderLog) ? data.reminderLog.slice(0, LOG_MAX) : [];
  state.settings = { ...DEFAULT_SETTINGS, ...(data?.settings || {}) };
  migrate();
  state.ready = true;
  // 메인 프로세스가 손상된 데이터 파일을 백업으로 격리했을 때만 채워진다
  state.loadNotice = data?.corrupted
    ? `이전 데이터 파일이 손상되어 백업했습니다:\n${data.backupPath || ''}`
    : null;
  commit({ save: false });
}

function normalize(t) {
  const start = t.start ?? null;
  return {
    id: t.id ?? cryptoId(),
    title: t.title ?? '',
    notes: t.notes ?? '',
    start,
    end: t.end ?? start,
    done: !!t.done,
    priority: t.priority ?? 0,
    color: t.color in COLORS ? t.color : 'blue',
    tags: Array.isArray(t.tags) ? t.tags : [],
    order: t.order ?? 0,
    createdAt: t.createdAt ?? Date.now(),
    doneAt: t.doneAt ?? null,
    pinned: !!t.pinned,          // D-Day 대시보드에 고정
    link: typeof t.link === 'string' ? t.link : '',   // 관련 링크 (클릭 시 브라우저로 열림)
    // 리마인더. '<며칠 전>@<HH:mm>' 형식 ('0@09:00' = 시작일 당일 9시). 빈 문자열이면 없음.
    remind: typeof t.remind === 'string' ? t.remind : '',
    remindedAt: t.remindedAt ?? null,   // 이미 알린 시각 (중복 알림 방지, 재시작해도 유지)
  };
}

/** 예전 버전이 남긴 값을 정리한다. 사용자가 직접 고른 값은 건드리지 않는다. */
function migrate() {
  // 'glass'(유리 강도)는 '배경 투명도' 슬라이더로 통합되면서 사라진 설정
  delete state.settings.glass;

  // 최초 실행 때 앱이 심어 둔 예시 런처의 이모지 → 종류별 선 아이콘으로.
  // 사용자가 직접 넣은 아이콘은 그대로 둔다(id 와 이모지가 정확히 일치할 때만).
  const SEEDED = { l_cal: '📅', l_mail: '✉️' };
  for (const item of state.launcher) {
    if (SEEDED[item.id] && item.icon === SEEDED[item.id]) item.icon = '';
  }
}

const LAUNCHER_KINDS = ['url', 'script', 'app', 'folder'];

function normalizeLauncher(it) {
  return {
    id: it.id ?? 'l_' + cryptoId(),
    label: String(it.label ?? '바로가기'),
    icon: String(it.icon ?? '').slice(0, 4),   // 비면 종류별 기본 선 아이콘
    kind: LAUNCHER_KINDS.includes(it.kind) ? it.kind : 'url',
    target: String(it.target ?? ''),
    args: Array.isArray(it.args) ? it.args.map(String) : [],
    order: it.order ?? 0,
  };
}

/** 최초 실행 시 비어 있으면 허전하므로 예시 두 개만 넣어 둔다 */
function defaultLauncher() {
  return [
    normalizeLauncher({ id: 'l_cal', label: '구글 캘린더', icon: '', kind: 'url',
      target: 'https://calendar.google.com', order: 0 }),
    normalizeLauncher({ id: 'l_mail', label: '메일', icon: '', kind: 'url',
      target: 'https://mail.google.com', order: 1 }),
  ];
}

function cryptoId() {
  return 't_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ---------------------------------------------------------------- 셀렉터

/** 해당 날짜에 걸쳐 있는 태스크 (기간 일정 포함) */
export function tasksOnDate(key) {
  return state.tasks
    .filter((t) => t.start && key >= t.start && key <= (t.end || t.start))
    .filter(passesFilter)
    .sort(byOrder);
}

/** 날짜 없는 '언젠가' 목록 */
export function inboxTasks() {
  return state.tasks.filter((t) => !t.start).filter(passesFilter).sort(byOrder);
}

/** 기간이 2일 이상인 장기 계획.
 *  tasksOnDate / inboxTasks 와 동일하게 검색·태그·완료표시 필터를 적용한다
 *  (뷰마다 필터 적용 여부가 달라지면 캘린더와 목록이 어긋난다). */
export function spanningTasks() {
  return state.tasks
    .filter((t) => t.start && t.end && t.end > t.start)
    .filter(passesFilter);
}

/** D-Day 대시보드에 고정된 일정. 임박한 순서(남은 일수 오름차순). */
export function pinnedTasks() {
  const today = todayKey();
  return state.tasks
    .filter((t) => t.pinned && t.end)
    .map((t) => ({ ...t, ...ddayInfo(t, today) }))
    .sort((a, b) => a.remaining - b.remaining);
}

/**
 * D-Day 진행 정보.
 * progress 는 시작일→목표일 구간에서 오늘이 어디쯤인지(0~1).
 * 시작일이 없거나 같은 날이면 임박도(30일 창) 기준으로 대신 계산한다.
 */
export function ddayInfo(t, today = todayKey()) {
  const MS = 86400000;
  const end = fromKeyLocal(t.end);
  const remaining = Math.round((end - fromKeyLocal(today)) / MS);

  let progress;
  if (t.start && t.end > t.start) {
    const total = Math.round((end - fromKeyLocal(t.start)) / MS);
    progress = total > 0 ? 1 - remaining / total : 1;
  } else {
    progress = 1 - Math.min(Math.max(remaining, 0), 30) / 30;
  }
  return {
    remaining,
    progress: Math.min(1, Math.max(0, progress)),
    overdue: remaining < 0,
  };
}

function fromKeyLocal(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function allTags() {
  const s = new Set();
  for (const t of state.tasks) for (const tag of t.tags) s.add(tag);
  return [...s].sort();
}

function passesFilter(t) {
  const { text, tag } = state.filter;
  if (!state.settings.showCompleted && t.done) return false;
  if (tag && !t.tags.includes(tag)) return false;
  if (text) {
    const q = text.toLowerCase();
    if (!t.title.toLowerCase().includes(q) && !t.notes.toLowerCase().includes(q)) return false;
  }
  return true;
}

function byOrder(a, b) {
  // 완료 항목은 언제나 아래로.
  if (a.done !== b.done) return a.done ? 1 : -1;
  // 우선순위 정렬 모드에서만 우선순위가 수동 순서를 이긴다.
  // (기본은 manual — 우선순위가 order 를 덮으면 드래그 정렬이 먹히지 않는 것처럼 보인다)
  if (state.settings.sortMode === 'priority' && a.priority !== b.priority) {
    return b.priority - a.priority;
  }
  if (a.order !== b.order) return a.order - b.order;
  return a.createdAt - b.createdAt;
}

// ---------------------------------------------------------------- 액션

export function addTask(patch = {}) {
  pushUndo('일정 추가');
  const start = patch.start !== undefined ? patch.start : state.selectedDate;
  const task = normalize({ ...patch, start, end: patch.end ?? start, createdAt: Date.now() });
  task.order = state.tasks.length;
  state.tasks.push(task);
  commit();
  return task;
}

export function updateTask(id, patch) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  pushUndo('일정 수정');
  Object.assign(t, patch);
  if (t.start && (!t.end || t.end < t.start)) t.end = t.start;
  commit();
}

export function toggleDone(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  pushUndo(t.done ? '완료 취소' : '완료 처리');
  t.done = !t.done;
  t.doneAt = t.done ? Date.now() : null;
  commit();
}

export function removeTask(id) {
  pushUndo('일정 삭제');
  state.tasks = state.tasks.filter((t) => t.id !== id);
  commit();
}

/** 드래그 정렬: ids 순서대로 order 재부여 */
export function reorder(ids) {
  pushUndo('순서 변경');
  ids.forEach((id, i) => {
    const t = state.tasks.find((x) => x.id === id);
    if (t) t.order = i;
  });
  commit();
}

/** 캘린더로 드롭했을 때 등, 날짜 이동 (기간 길이 유지) */
export function moveTask(id, newStart) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  pushUndo('날짜 이동');
  if (!t.start) {
    t.start = newStart;
    t.end = newStart;
  } else {
    const span = Math.max(0, dayDiff(t.start, t.end || t.start));
    t.start = newStart;
    t.end = shift(newStart, span);
  }
  commit();
}

function dayDiff(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}
function shift(key, n) {
  const d = new Date(key);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export function togglePinned(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  pushUndo(t.pinned ? '고정 해제' : 'D-Day 고정');
  t.pinned = !t.pinned;
  commit();
}

// ---------------------------------------------------------------- 리마인더

const LOG_MAX = 30;

/** 'N@HH:mm' 을 해석한다. 잘못된 값이면 null */
export function parseRemind(remind) {
  const m = /^(\d{1,2})@([01]\d|2[0-3]):([0-5]\d)$/.exec(String(remind || ''));
  if (!m) return null;
  return { offsetDays: Number(m[1]), hour: Number(m[2]), minute: Number(m[3]) };
}

/**
 * 이 태스크의 알림 예정 시각(epoch ms). 알림이 없거나 날짜가 없으면 null.
 * 시작일에서 offsetDays 만큼 앞당긴 날의 지정 시각.
 */
export function remindTime(t) {
  const r = parseRemind(t.remind);
  if (!r || !t.start) return null;
  const [y, mo, d] = t.start.split('-').map(Number);
  const when = new Date(y, mo - 1, d, r.hour, r.minute, 0, 0);
  when.setDate(when.getDate() - r.offsetDays);
  return when.getTime();
}

/** 아직 알리지 않았고 시간이 된 태스크들 */
export function dueReminders(now = Date.now()) {
  return state.tasks.filter((t) => {
    if (t.done || !t.remind || t.remindedAt) return false;
    const at = remindTime(t);
    return at !== null && at <= now;
  });
}

/** 알림을 보냈다고 표시하고 기록에 남긴다 */
export function markReminded(id, at = Date.now(), { log = true } = {}) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  t.remindedAt = at;
  if (log) {
    state.reminderLog.unshift({ id: `r_${id}_${at}`, taskId: id, title: t.title, at });
    state.reminderLog = state.reminderLog.slice(0, LOG_MAX);
  }
  commit();
}

export function clearReminderLog() {
  state.reminderLog = [];
  commit();
}

// ---------------------------------------------------------------- 런처 액션

export function launcherItems() {
  return [...state.launcher].sort((a, b) => a.order - b.order);
}

export function addLauncherItem(patch) {
  pushUndo('바로가기 추가');
  const item = normalizeLauncher({ ...patch, id: 'l_' + cryptoId() });
  item.order = state.launcher.length;
  state.launcher.push(item);
  commit();
  return item;
}

export function updateLauncherItem(id, patch) {
  const it = state.launcher.find((x) => x.id === id);
  if (!it) return;
  Object.assign(it, normalizeLauncher({ ...it, ...patch, id: it.id }));
  commit();
}

export function removeLauncherItem(id) {
  pushUndo('바로가기 삭제');
  state.launcher = state.launcher.filter((x) => x.id !== id);
  commit();
}

export function reorderLauncher(ids) {
  ids.forEach((id, i) => {
    const it = state.launcher.find((x) => x.id === id);
    if (it) it.order = i;
  });
  commit();
}

// ---- UI 상태 액션 (저장 안 함) ----

export function selectDate(key) {
  state.selectedDate = key;
  state.anchorMonth = key;
  commit({ save: false });
}

export function setAnchorMonth(key) {
  state.anchorMonth = key;
  commit({ save: false });
}

export function setFilter(patch) {
  Object.assign(state.filter, patch);
  commit({ save: false });
}

export function setEditing(id) {
  state.editingTaskId = id;
  commit({ save: false });
}

export function setSetting(key, value) {
  state.settings[key] = value;
  commit();
}
