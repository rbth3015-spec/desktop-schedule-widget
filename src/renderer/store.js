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

export const COLORS = {
  blue:   '#5b9dff',
  green:  '#4ec9a0',
  amber:  '#f0b429',
  rose:   '#f2698c',
  violet: '#a78bfa',
  slate:  '#8b98ad',
};

export const PRIORITY_LABELS = ['보통', '중요', '긴급'];

const DEFAULT_SETTINGS = {
  theme: 'dark',          // 'dark' | 'light'
  opacity: 0.92,          // 0.3 ~ 1
  splitRatio: 0.56,       // 캘린더가 차지하는 가로 비율
  alwaysOnTop: false,
  clickThroughLocked: false,
  showCompleted: true,
  weekStart: 0,           // 0=일요일
  fontScale: 1,           // 0.8 ~ 1.4
  sortMode: 'manual',     // 'manual' = 드래그 순서 우선 | 'priority' = 우선순위 우선

  // --- 외형 (글래스모피즘) ---
  glass: 'normal',        // 'clear' | 'normal' | 'solid' — 유리 강도
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
      settings: state.settings,
    });
  }, 250);
}

function commit({ save = true } = {}) {
  if (save) persist();
  emit();
}

// ---------------------------------------------------------------- 초기화

export async function init() {
  const data = await window.api.loadData();
  state.tasks = Array.isArray(data?.tasks) ? data.tasks.map(normalize) : [];
  state.launcher = Array.isArray(data?.launcher)
    ? data.launcher.map(normalizeLauncher)
    : defaultLauncher();
  state.settings = { ...DEFAULT_SETTINGS, ...(data?.settings || {}) };
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
  };
}

const LAUNCHER_KINDS = ['url', 'script', 'app', 'folder'];

function normalizeLauncher(it) {
  return {
    id: it.id ?? 'l_' + cryptoId(),
    label: String(it.label ?? '바로가기'),
    icon: String(it.icon ?? '🔗').slice(0, 4),
    kind: LAUNCHER_KINDS.includes(it.kind) ? it.kind : 'url',
    target: String(it.target ?? ''),
    args: Array.isArray(it.args) ? it.args.map(String) : [],
    order: it.order ?? 0,
  };
}

/** 최초 실행 시 비어 있으면 허전하므로 예시 두 개만 넣어 둔다 */
function defaultLauncher() {
  return [
    normalizeLauncher({ id: 'l_cal', label: '구글 캘린더', icon: '📅', kind: 'url',
      target: 'https://calendar.google.com', order: 0 }),
    normalizeLauncher({ id: 'l_mail', label: '메일', icon: '✉️', kind: 'url',
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
  Object.assign(t, patch);
  if (t.start && (!t.end || t.end < t.start)) t.end = t.start;
  commit();
}

export function toggleDone(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  t.done = !t.done;
  t.doneAt = t.done ? Date.now() : null;
  commit();
}

export function removeTask(id) {
  state.tasks = state.tasks.filter((t) => t.id !== id);
  commit();
}

/** 드래그 정렬: ids 순서대로 order 재부여 */
export function reorder(ids) {
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
  t.pinned = !t.pinned;
  commit();
}

// ---------------------------------------------------------------- 런처 액션

export function launcherItems() {
  return [...state.launcher].sort((a, b) => a.order - b.order);
}

export function addLauncherItem(patch) {
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
