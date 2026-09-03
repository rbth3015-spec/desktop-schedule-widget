// 렌더러 전역 상태 저장소. 단일 소스 오브 트루스.
// 뷰 모듈(calendar / todo)은 store 를 직접 mutate 하지 않고 액션 함수만 호출한다.

import { todayKey, addDays, diffDays, isTimeKey, timeMinutes, fromKeyTime } from './lib/date.js';

const listeners = new Set();

// 저장 상태.
// 예전에는 saveData() 를 부르고 결과를 보지 않았다. 디스크가 차거나 파일이 잠기면
// 사용자는 아무것도 모른 채 계속 일정을 적고, 앱을 껐다 켜면 전부 사라져 있었다.
// 일정 앱에서 가장 나쁜 실패 방식이라 결과를 반드시 확인하고 화면에 알린다.
let saveTimer = null;
let savePending = false;   // 디바운스 대기 중인 변경이 있는가

/**
 * @typedef {Object} Task
 * @property {string}  id
 * @property {string}  title
 * @property {string}  notes
 * @property {string|null} start   'YYYY-MM-DD' — 시작일. null 이면 '언젠가(inbox)'
 * @property {string|null} end     'YYYY-MM-DD' — 종료일. 단일 일정이면 start 와 동일
 * @property {string|null} startTime 'HH:mm' — 시작 시각. null 이면 종일
 * @property {string|null} endTime   'HH:mm' — 종료 시각. startTime 이 없으면 항상 null
 * @property {boolean} done
 * @property {number}  priority    0=보통 1=중요 2=긴급
 * @property {string}  color       카테고리 색 키 (COLORS 참조)
 * @property {string[]} tags
 * @property {number}  order       같은 날짜 내 정렬 순서
 * @property {number}  createdAt   epoch ms
 * @property {number|null} doneAt
 */

// 안료 계열. 형광빛 원색은 두 테마의 배경과 따로 놀아서 채도를 낮췄다.
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
  theme: 'light',         // 'light' | 'dark'
  // 배경 투명도(0.4~1). 창 전체가 아니라 배경 알파만 조절하므로 글자는 또렷하게 남는다.
  // Windows 의 transparent 창에 setOpacity 를 걸면 합성이 불안정해 CSS 로 처리한다.
  opacity: 0.9,
  splitRatio: 0.56,       // 캘린더가 차지하는 가로 비율
  alwaysOnTop: false,
  clickThroughLocked: false,
  showCompleted: true,
  weekStart: 0,           // 0=일요일
  calendarView: 'month',  // 'month' | 'week' — 주간 뷰는 좁은 위젯에서 유용하다
  fontScale: 1,           // 0.8 ~ 1.4
  // 글꼴. 값은 base.css 의 [data-font] / [data-font-serif] 선택자 키와 같다.
  // 'default' 면 손대지 않고 기본(Pretendard / 나눔명조)을 쓴다.
  font: 'default',        // 본문 산세리프
  fontSerif: 'default',   // 날짜·표제 명조
  sortMode: 'manual',     // 'manual' = 드래그 순서 우선 | 'priority' = 우선순위 우선

  // --- 외형 ---
  blurEnabled: true,      // 백드롭 블러. 저사양이면 끄는 폴백
  dimInactive: true,      // 창이 비활성일 때 배경으로 물러남 (macOS 위젯 방식)

  // --- 패널 표시 ---
  showDashboard: true,    // Zone C: D-Day 대시보드
  showLauncher: true,     // Zone D: 퀵 런처 도크
  showHolidays: true,     // 달력에 공휴일 표시

  // --- 브리핑 ---
  // 하루에 한 번, 앱을 처음 켠 날 아침에 오늘 몫을 한 장으로 요약해 준다.
  // '물어봐야 답하는 장부'와 '먼저 말하는 비서'를 가르는 지점이라 기본은 켜 둔다.
  showBrief: true,
  lastBriefDate: '',      // 마지막으로 브리핑을 띄운 날 ('YYYY-MM-DD')

  // '이거 루틴으로 만들까요?' 를 거절한 제목들. 한 번 아니라고 한 것을 다시 묻지 않는다.
  hiddenRoutineHints: [],

  // 처음 켰을 때 한 번만 보여 주는 안내. 빈 패널 네 개를 마주하게 두지 않는다.
  seenWelcome: false,
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
  // 공휴일 { 'YYYY-MM-DD': ['명칭', ...] }. 메인이 받아 준 값을 담아 둔다.
  // 영속화하지 않는다 — 캐시 파일은 메인이 관리한다.
  holidays: {},
  holidayYears: /** @type {Set<number>} */ (new Set()),
  saveError: null,      // 마지막 저장 실패 메시지. 성공하면 다시 null.
  // 캘린더에서 기간을 드래그하면 여기 담기고, 투두 패널이 추가 폼을 열면서 비운다.
  composeRequest: /** @type {{start:string,end:string}|null} */ (null),
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

/** 디스크에 남길 것만 추린다. 여기 더한 필드는 storage.js 의 payload 에도 더해야 한다. */
function persistPayload() {
  return {
    tasks: state.tasks,
    launcher: state.launcher,
    reminderLog: state.reminderLog,
    settings: state.settings,
  };
}

async function writeNow() {
  savePending = false;
  let message = null;
  try {
    const res = await window.api.saveData(persistPayload());
    // storage.saveData 는 예외를 던지지 않고 {ok:false, error} 를 돌려준다
    if (res && res.ok === false) message = res.error || '알 수 없는 오류';
  } catch (err) {
    message = String(err?.message || err);
  }

  // 상태가 바뀔 때만 알린다 (매 저장마다 리렌더를 유발하지 않도록)
  if (state.saveError !== message) {
    state.saveError = message;
    emit();
  }
}

/** 영속 데이터만 디바운스 저장 */
function persist() {
  savePending = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 250);
}

/**
 * 대기 중인 저장을 지금 끝낸다.
 * 창을 숨기거나 앱을 종료하기 직전에 부른다 — 디바운스 250ms 안에 종료하면
 * 마지막 편집이 통째로 날아간다.
 */
export function flushSave() {
  clearTimeout(saveTimer);
  // 저장에 실패한 상태면 대기 중인 변경이 없어도 다시 쓴다 — '다시 시도' 버튼의 경로다.
  if (!savePending && !state.saveError) return Promise.resolve();
  return writeNow();
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

const undoStack = [];
const redoStack = [];

/**
 * 되돌리기 깊이를 일정 수에 맞춰 줄인다.
 * 스냅샷 하나가 일정 수에 비례하므로(2000건이면 한 장에 수백 KB, 뜨는 데 20ms),
 * 깊이를 고정 50 으로 두면 큰 데이터에서 메모리와 지연이 같이 커진다.
 * 실제로 50단계를 거슬러 올라가는 사람은 없으니 깊이를 양보한다.
 */
function undoLimit() {
  const n = state.tasks.length;
  if (n <= 300) return 50;
  if (n <= 1000) return 25;
  return 12;
}

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

// 연속 편집 묶기.
// 메모를 한 줄 치면 updateTask 가 300ms 마다 불리고, 그때마다 전체 스냅샷을 떴다.
// 큰 데이터에서는 눈에 띄는 끊김이 되고, Ctrl+Z 를 눌러도 글자 몇 개씩만 되돌아간다.
// 같은 대상의 같은 종류 편집이 이어지면 첫 스냅샷 하나로 묶는다.
const COALESCE_MS = 1200;
let lastUndoKey = null;
let lastUndoAt = 0;

/**
 * 되돌릴 수 있는 변경 직전에 부른다.
 * @param {string} label 사용자에게 보여줄 문구
 * @param {string|null} coalesceKey 같은 키로 연달아 들어오면 하나로 묶는다
 */
function pushUndo(label, coalesceKey = null) {
  const now = Date.now();

  if (coalesceKey && coalesceKey === lastUndoKey && now - lastUndoAt < COALESCE_MS
      && undoStack.length) {
    // 직전 스냅샷이 이미 '이 편집 이전' 상태를 담고 있다. 새로 뜨지 않는다.
    lastUndoAt = now;
    redoStack.length = 0;
    return;
  }

  undoStack.push({ label, data: snapshot() });
  const limit = undoLimit();
  while (undoStack.length > limit) undoStack.shift();
  redoStack.length = 0;   // 새 변경이 생기면 다시 실행 이력은 버린다

  lastUndoKey = coalesceKey;
  lastUndoAt = now;
}

/** 묶기를 끊는다. 다른 경로로 상태가 바뀌었을 때(되돌리기 등) 부른다. */
function breakCoalesce() {
  lastUndoKey = null;
  lastUndoAt = 0;
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }

/** @returns {string|null} 되돌린 동작의 이름 (없으면 null) */
export function undo() {
  breakCoalesce();
  const entry = undoStack.pop();
  if (!entry) return null;
  redoStack.push({ label: entry.label, data: snapshot() });
  restore(entry.data);
  commit();
  return entry.label;
}

export function redo() {
  breakCoalesce();
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

  // 읽기 단계에서 생긴 문제를 사용자에게 알린다.
  //  - corrupted: 파일이 깨져서 격리했다 (기존 데이터는 백업에 남아 있다)
  //  - error   : 권한 등으로 아예 못 읽었다. 이때 빈 화면을 그냥 보여 주면
  //              '일정이 전부 사라졌다'고 오해하고, 그 위에 새로 쓰면 진짜로 덮인다.
  if (data?.corrupted) {
    state.loadNotice = '이전 데이터 파일이 손상되어 백업했습니다:\n'
      + (data.backupPath || '');
  } else if (data?.error) {
    state.loadNotice = '데이터를 읽지 못했습니다 — ' + data.error + '\n'
      + '이대로 일정을 추가하면 기존 파일을 덮어쓸 수 있습니다. 백업 폴더를 먼저 확인하세요.';
  } else {
    state.loadNotice = null;
  }

  commit({ save: false });
}

function normalize(t) {
  const start = t.start ?? null;
  const { startTime, endTime } = normalizeTimes(t, start, t.end ?? start);
  return {
    id: t.id ?? cryptoId(),
    title: t.title ?? '',
    notes: t.notes ?? '',
    start,
    end: t.end ?? start,
    startTime,
    endTime,
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

    // --- 반복 일정 ---
    // 규칙은 하나만 저장하고, 화면에 보이는 각 회차는 셀렉터가 그때그때 펼친다.
    // 회차를 전부 레코드로 만들면 '10년 반복'에 수천 개가 쌓인다.
    repeat: normalizeRepeat(t.repeat),
    exceptions: Array.isArray(t.exceptions) ? t.exceptions.slice() : [],  // 건너뛴 회차 날짜
    doneDates: Array.isArray(t.doneDates) ? t.doneDates.slice() : [],     // 완료한 회차 날짜

    // 시작일을 뒤로 민 횟수. 세 번쯤 밀린 일은 '안 할 일'이거나 '너무 큰 일'이다.
    // 물어봐 주는 쪽이 낫다. 사용자가 적는 값이 아니라 앱이 세는 값이다.
    deferCount: Math.max(0, Number(t.deferCount) || 0),

    // 장기 계획을 하루하루 체크할 것인가.
    // '이사 준비'는 끝나면 한 번 체크하면 되지만, '기출 5개년 정리'는 오늘 했는지가
    // 매일 궁금하다. 둘은 다른 일이라 사용자가 고른다. 체크한 날짜는 위 doneDates 에
    // 함께 쌓는다 — 반복 일정과 뜻이 같으므로 그릇을 하나 더 만들 이유가 없다.
    dailyCheck: !!t.dailyCheck,
  };
}

/**
 * 시각 필드를 정리한다. 시각은 날짜와 같은 원칙으로 'HH:mm' 로컬 벽시계 문자열이고,
 * null 이면 '종일'이다. 기존 데이터에는 이 필드가 없으므로 전부 null 로 읽힌다.
 *
 * 규칙 두 가지만 강제한다:
 *  - 시작 시각이 없으면 종료 시각도 없다 ('언제 끝나는지'만 아는 일정은 뜻이 모호하다)
 *  - 하루짜리인데 종료가 시작보다 빠르면 종료를 비운다 (오타를 에러로 막는 대신 조용히 정리)
 */
function normalizeTimes(t, start, end) {
  if (!start) return { startTime: null, endTime: null };

  const startTime = isTimeKey(t.startTime) ? t.startTime : null;
  if (!startTime) return { startTime: null, endTime: null };

  let endTime = isTimeKey(t.endTime) ? t.endTime : null;
  const sameDay = !end || end === start;
  if (endTime && sameDay && timeMinutes(endTime) <= timeMinutes(startTime)) endTime = null;

  return { startTime, endTime };
}

const REPEAT_FREQS = ['daily', 'weekly', 'monthly', 'yearly'];

export const REPEAT_LABELS = {
  daily: '매일',
  weekly: '매주',
  monthly: '매월',
  yearly: '매년',
};

/**
 * 화면에서 고르는 주기에는 '평일'·'주말' 이 있지만, 저장은 **요일을 고른 매주 반복** 하나로 한다.
 * 규칙 종류를 늘리면 occursOn·달력·알림이 전부 갈라진다. 이름만 화면에서 붙여 준다.
 */
export const DAY_PRESETS = { weekdays: [1, 2, 3, 4, 5], weekends: [0, 6] };

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

/** 저장된 규칙 → 화면에서 고를 값. 평일/주말과 정확히 맞을 때만 그 이름을 쓴다. */
export function repeatChoice(r) {
  if (!r || !r.freq) return '';
  if (r.freq === 'weekly' && Array.isArray(r.days) && r.days.length) {
    const key = [...r.days].sort((a, b) => a - b).join(',');
    for (const [name, days] of Object.entries(DAY_PRESETS)) {
      if (days.join(',') === key) return name;
    }
  }
  return r.freq;
}

/**
 * 화면에서 고른 값 → 저장할 {freq, days}.
 * @param {string} choice '' | 'daily' | 'weekdays' | 'weekends' | 'weekly' | 'monthly' | 'yearly'
 * @param {number[]|null} [days] '매주' 에서 직접 고른 요일
 */
export function repeatFreqDays(choice, days) {
  if (!choice) return null;
  const preset = DAY_PRESETS[choice];
  if (preset) return { freq: 'weekly', days: [...preset] };
  return {
    freq: choice,
    days: choice === 'weekly' && days && days.length ? [...days] : null,
  };
}

/** 반복을 사람 말로 — '매일' · '평일' · '월·수·금' */
export function repeatLabel(r) {
  const choice = repeatChoice(r);
  if (choice === 'weekdays') return '평일';
  if (choice === 'weekends') return '주말';
  if (r && r.freq === 'weekly' && Array.isArray(r.days) && r.days.length) {
    return r.days.map((d) => DAY_NAMES[d]).join('·');
  }
  return REPEAT_LABELS[choice] || '';
}

function normalizeRepeat(r) {
  if (!r || !REPEAT_FREQS.includes(r.freq)) return null;

  // 매주 반복에서 요일을 골랐을 때만 의미가 있다 ('월수금 운동').
  // 고르지 않으면 예전처럼 시작일의 요일을 따른다.
  let days = null;
  if (r.freq === 'weekly' && Array.isArray(r.days)) {
    const picked = [...new Set(r.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort();
    if (picked.length) days = picked;
  }

  return {
    freq: r.freq,
    interval: Math.min(99, Math.max(1, Number(r.interval) || 1)),
    until: typeof r.until === 'string' && r.until ? r.until : null,   // 없으면 무기한
    days,
    // 루틴 — 달력에는 그리지 않고 '루틴' 목록에만 모은다.
    // '운동' 처럼 매일 하는 일을 달력에 매일 막대로 그리면 정작 약속이 안 보인다.
    routine: !!r.routine,
  };
}

/** 이 날짜에 반복 회차가 있는가 */
export function occursOn(t, key) {
  const r = t.repeat;
  if (!r || !t.start) return false;
  if (key < t.start) return false;
  if (r.until && key > r.until) return false;
  if (t.exceptions.includes(key)) return false;

  const a = fromKeyLocal(t.start);
  const b = fromKeyLocal(key);

  if (r.freq === 'daily') {
    return Math.round((b - a) / 86400000) % r.interval === 0;
  }
  if (r.freq === 'weekly') {
    // 요일을 골랐으면 그 요일마다. interval 은 '몇 주마다' 로 해석한다.
    if (r.days) {
      if (!r.days.includes(b.getDay())) return false;
      if (r.interval === 1) return true;
      // 시작일이 속한 주의 일요일을 기준으로 몇 주 지났는지 센다
      const weekStart = (d) => { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); return x; };
      const weeks = Math.round((weekStart(b) - weekStart(a)) / (7 * 86400000));
      return weeks >= 0 && weeks % r.interval === 0;
    }
    return Math.round((b - a) / 86400000) % (7 * r.interval) === 0;
  }
  if (r.freq === 'monthly') {
    // 31일 반복은 31일이 없는 달을 건너뛴다 (임의로 말일에 붙이지 않는다 — 예측 가능성 우선)
    if (a.getDate() !== b.getDate()) return false;
    const months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    return months >= 0 && months % r.interval === 0;
  }
  if (r.freq === 'yearly') {
    if (a.getDate() !== b.getDate() || a.getMonth() !== b.getMonth()) return false;
    const years = b.getFullYear() - a.getFullYear();
    return years >= 0 && years % r.interval === 0;
  }
  return false;
}

/**
 * 하루하루 체크하는 장기 계획인가.
 * 기간이 이틀 이상이어야 뜻이 있고, 반복 일정은 애초에 당일짜리라 해당 없다.
 */
export function isDailyCheck(t) {
  return !!(t && t.dailyCheck && !t.repeat && t.start && t.end && t.end > t.start);
}

/** 매일 체크 장기 계획의 진행 — {done, total}. 아니면 null */
export function spanProgress(t) {
  if (!isDailyCheck(t)) return null;
  const total = diffDays(t.start, t.end) + 1;
  // 기간을 줄이면 범위 밖 기록이 남는다. 세지 않되 지우지도 않는다 —
  // 기간을 도로 늘리면 하던 기록이 그대로 살아난다.
  const done = t.doneDates.filter((k) => k >= t.start && k <= t.end).length;
  return { done, total };
}

/** 기간을 전부 체크했으면 계획이 끝난 것이다. 목록·달력이 보는 done 을 맞춰 준다. */
function syncSpanDone(t) {
  const p = spanProgress(t);
  if (!p) return;
  const all = p.done >= p.total;
  t.done = all;
  t.doneAt = all ? (t.doneAt || Date.now()) : null;
}

/** 특정 날짜의 회차를 '그날짜짜리 일정'처럼 보이게 만든 사본.
 *  id 는 원본 그대로라 기존 편집 경로(updateTask/setEditing)가 그대로 동작하고,
 *  occDate 로 '몇 번째 회차인지'를 구분한다. */
function occurrenceOf(t, key) {
  return {
    ...t,
    start: key,
    end: key,
    occDate: key,
    done: t.doneDates.includes(key),
    doneAt: null,
  };
}

/** 오늘 이전(포함)의 가장 가까운 회차. 반복 일정의 알림 기준일. */
function lastOccurrenceOnOrBefore(t, key) {
  if (!t.repeat || !t.start) return null;
  if (key < t.start) return null;
  // 하루씩 되짚는다. 최대 400일까지만 — 그보다 오래 지난 알림은 어차피 의미가 없다.
  let cur = key;
  for (let i = 0; i < 400; i++) {
    if (occursOn(t, cur)) return cur;
    if (cur <= t.start) return null;
    const d = fromKeyLocal(cur);
    d.setDate(d.getDate() - 1);
    cur = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return null;
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

/**
 * 해당 날짜에 걸쳐 있는 태스크 (기간 일정 포함)
 *
 * @param {{filtered?: boolean}} [opts]
 *   filtered — 검색어·태그·완료표시 필터를 적용할지. 기본 true.
 *   트레이나 브리핑처럼 '화면 밖'에 보고할 때는 false 로 둔다. 태그 필터를 켜 둔
 *   상태에서 트레이가 걸러진 개수를 말하면 사실과 다른 보고가 된다.
 */
export function tasksOnDate(key, { filtered = true, routines = false } = {}) {
  const out = [];
  for (const t of state.tasks) {
    if (t.repeat) {
      // 루틴은 '루틴' 목록에만 모은다 — 그날 할 일과 달력에서는 뺀다.
      if (!!t.repeat.routine !== routines) continue;
      if (occursOn(t, key)) out.push(occurrenceOf(t, key));
    } else if (!routines && t.start && key >= t.start && key <= (t.end || t.start)) {
      // 매일 체크하는 장기 계획은 그날치 체크 상태를 달고 나간다.
      // start/end 는 그대로 둔다 — 기간 막대와 D-N 표시가 이 값을 본다.
      out.push(isDailyCheck(t)
        ? { ...t, occDate: key, done: t.doneDates.includes(key) }
        : t);
    }
  }
  return (filtered ? out.filter(passesFilter) : out).sort(byOrder);
}

/**
 * 그날 체크할 루틴(습관).
 * 달력에 그리지 않는 반복 일정이다 — '운동' 을 매일 막대로 그리면 정작 약속이 묻힌다.
 */
export function routinesOn(key, opts = {}) {
  return tasksOnDate(key, { ...opts, routines: true });
}

/** 루틴이 하나라도 있는가 (섹션을 보일지 결정) */
export function hasRoutines() {
  return state.tasks.some((t) => t.repeat?.routine);
}

/**
 * 이 루틴을 며칠째 이어 오고 있는가.
 *
 * **하기로 한 날만 센다.** 평일 루틴이 주말에 끊겼다고 하면 억울하다.
 * 오늘 아직 안 했으면 어제까지로 센다 — 하루가 끝나지도 않았는데 0 이라고
 * 말하면 어제까지 쌓은 것이 없던 일이 된다.
 */
export function routineStreak(task, key = todayKey()) {
  // 목록이 넘겨 주는 건 그날치 사본이라 start/end 가 그날로 바뀌어 있다.
  // 되짚으려면 원본이 필요하다.
  const t = state.tasks.find((x) => x.id === task?.id) || task;
  if (!t?.repeat?.routine || !t.start) return 0;
  let cur = key;
  if (occursOn(t, cur) && !t.doneDates.includes(cur)) cur = addDays(cur, -1);

  let n = 0;
  // 400 일이면 넉넉하다. 그보다 긴 기록은 세어 봐야 화면에 쓸 데가 없다.
  for (let i = 0; i < 400 && cur >= t.start; i++) {
    if (occursOn(t, cur)) {
      if (!t.doneDates.includes(cur)) break;
      n++;
    }
    cur = addDays(cur, -1);
  }
  return n;
}

/**
 * 손으로 되풀이해 적어 온 일 — 루틴으로 만들 만한 것.
 *
 * 같은 이름을 서로 다른 날에 세 번 넘게 적었다면, 그건 일정이 아니라 습관이다.
 * 매번 새로 적게 두는 대신 앱이 먼저 알아보고 물어본다.
 *
 * 요일은 지어내지 않고 **실제로 적어 온 날**을 그대로 옮긴다 —
 * 늘 수요일이었으면 매주 수요일, 평일에 흩어져 있었으면 평일.
 */
export function routineSuggestions(limit = 1) {
  const hidden = new Set(state.settings.hiddenRoutineHints || []);
  const already = new Set(
    state.tasks.filter((t) => t.repeat?.routine).map((t) => t.title.trim().toLowerCase())
  );
  const cutoff = addDays(todayKey(), -120);   // 아주 옛날 기록으로 조르지 않는다

  const byTitle = new Map();
  for (const t of state.tasks) {
    if (t.repeat || !t.start || t.start < cutoff) continue;
    const key = t.title.trim().toLowerCase();
    if (key.length < 2 || hidden.has(key) || already.has(key)) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(t);
  }

  const out = [];
  for (const [key, list] of byTitle) {
    const dates = [...new Set(list.map((t) => t.start))];
    if (dates.length < 3) continue;   // 같은 날 세 개는 되풀이가 아니다

    const days = [...new Set(dates.map((k) => fromKeyLocal(k).getDay()))].sort();
    let picked;
    if (days.length === 1) picked = days;                                  // 늘 같은 요일
    else if (days.length >= 3 && days.every((d) => d >= 1 && d <= 5)) picked = [1, 2, 3, 4, 5];
    else picked = days;

    out.push({
      key,
      title: list[0].title.trim(),
      count: dates.length,
      color: list[0].color,
      tags: list[0].tags.slice(),
      repeat: { freq: 'weekly', interval: 1, days: picked, routine: true },
    });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, limit);
}

/** '아니요' — 이 제목은 다시 묻지 않는다 */
export function hideRoutineHint(key) {
  const list = state.settings.hiddenRoutineHints || [];
  if (list.includes(key)) return;
  setSetting('hiddenRoutineHints', [...list, key].slice(-60));
}

/**
 * 제안을 받아들여 루틴을 만든다.
 * 예전에 적어 둔 일정은 건드리지 않는다 — 지나간 기록을 지울 이유가 없다.
 */
export function makeRoutineFromHint(hint) {
  if (!hint) return null;
  const task = addTask({
    title: hint.title,
    start: todayKey(),
    end: todayKey(),
    color: hint.color,
    tags: hint.tags,
    repeat: hint.repeat,
  });
  hideRoutineHint(hint.key);
  return task;
}

/**
 * 지금 할 일 하나를 골라 준다.
 *
 * 할 일 목록은 결국 '골라야 하는 짐' 이다. 비서라면 골라 줘야 한다.
 * 소요 시간을 묻지 않기로 했으므로 재료는 시각·마감·우선순위·밀린 정도뿐인데,
 * 그것만으로도 순서는 분명하다:
 *
 *   지금 그 시간인 것 → 곧 시작하는 것 → 밀린 것 → 오늘 몫 → 오늘 체크할 것
 *
 * 이유를 말로 만들지 않고 종류(kind)와 근거(at)만 돌려준다.
 * 문장은 화면이 만든다 — store 가 표시용 날짜 형식을 알 이유가 없다.
 *
 * @returns {{list: {task:Object, kind:string, at:string|null}[], freeMinutes:number|null}}
 */
export function pickNow(key = todayKey()) {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const isToday = key === todayKey();

  const list = [];
  const seen = new Set();
  const add = (task, kind, at = null) => {
    const id = `${task.id}@${task.occDate || ''}`;
    if (!task || task.done || seen.has(id)) return;
    seen.add(id);
    list.push({ task, kind, at });
  };

  const today = tasksOnDate(key).filter((t) => !t.done);
  const timed = today
    .filter((t) => t.startTime)
    .sort((a, b) => timeMinutes(a.startTime) - timeMinutes(b.startTime));

  // 1) 지금 그 시간인 것, 그리고 곧 시작하는 것.
  //    45분은 '이제 슬슬 준비할 때' 의 눈금이다. 더 멀면 지금 붙잡을 일이 아니다.
  let freeMinutes = null;
  if (isToday) {
    for (const t of timed) {
      const s = timeMinutes(t.startTime);
      const e = t.endTime ? timeMinutes(t.endTime) : s + 60;
      if (mins >= s && mins < e) add(t, 'now', t.startTime);
      else if (s > mins && s - mins <= 45) add(t, 'soon', t.startTime);
      if (s > mins && freeMinutes === null) freeMinutes = s - mins;
    }
  }

  // 2) 밀린 일 — 급한 것부터, 그중 오래 밀린 것부터
  for (const t of overdueTasks()
    .slice()
    .sort((a, b) => (b.priority - a.priority) || (a.start < b.start ? -1 : 1))) {
    add(t, 'overdue', t.start);
  }

  // 3) 오늘 몫 — 시각이 지난 것부터, 그다음 급한 것부터
  for (const t of today
    .slice()
    .sort((a, b) => {
      const at = a.startTime ? timeMinutes(a.startTime) : 1e9;
      const bt = b.startTime ? timeMinutes(b.startTime) : 1e9;
      return (b.priority - a.priority) || (at - bt);
    })) {
    add(t, 'today', t.startTime);
  }

  // 4) 오늘 체크할 것 — 루틴은 짧게 끝나서 '지금 5분' 에 딱 맞는다
  for (const t of routinesOn(key).filter((t) => !t.done)) add(t, 'check', null);

  return { list, freeMinutes };
}

/**
 * 이 일정에서 마감 역산 계획을 세울 수 있는가.
 * 마감이 모레 이후라야 '오늘부터 마감 전날까지' 에 하루라도 칸이 생긴다.
 * (이미 매일 체크로 만든 계획은 역산할 것이 없다)
 */
export function canPlanDeadline(t) {
  if (!t || !t.start || t.repeat || t.dailyCheck) return false;
  return (t.end || t.start) >= addDays(todayKey(), 2);
}

/** 날짜 없는 '언젠가' 목록 */
export function inboxTasks() {
  return state.tasks.filter((t) => !t.start && !t.repeat).filter(passesFilter).sort(byOrder);
}

/** 기간이 2일 이상인 장기 계획.
 *  tasksOnDate / inboxTasks 와 동일하게 검색·태그·완료표시 필터를 적용한다
 *  (뷰마다 필터 적용 여부가 달라지면 캘린더와 목록이 어긋난다). */
export function spanningTasks() {
  // 반복 일정은 당일 일정만 지원하므로 기간 막대 대상이 아니다
  return state.tasks
    .filter((t) => !t.repeat && t.start && t.end && t.end > t.start)
    .filter(passesFilter);
}

/**
 * 기한이 지났는데 아직 안 끝난 일정.
 *
 * 이게 없으면 어제 못 끝낸 일은 어제 칸에 그대로 남아 시야에서 사라진다.
 * 사용자 입장에서는 앱이 자기 실패를 숨기는 것처럼 보이므로, 날짜와 무관하게
 * 항상 목록 맨 위로 올려 준다.
 *
 * 반복 일정은 제외한다 — 지나간 회차 하나하나가 '밀린 일'로 쌓이면
 * 매일 반복 하나만 있어도 목록이 수백 줄이 된다.
 */
export function overdueTasks(today = todayKey(), { filtered = true } = {}) {
  return state.tasks
    .filter((t) => !t.done && !t.repeat && t.start && (t.end || t.start) < today)
    .filter((t) => !filtered || passesFilter(t))
    .sort((a, b) => {
      // 오래 밀린 것부터 — 가장 오래 방치된 일이 맨 위
      const ae = a.end || a.start;
      const be = b.end || b.start;
      if (ae !== be) return ae < be ? -1 : 1;
      return b.priority - a.priority;
    });
}

/** D-Day 대시보드에 고정된 일정. 임박한 순서(남은 일수 오름차순). */
export function pinnedTasks() {
  const today = todayKey();
  return state.tasks
    .filter((t) => t.pinned && t.end && !t.repeat)
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

  // '완료 숨김' 은 끝나면 치우는 할 일을 위한 것이다.
  // 매일 체크하는 것(루틴·매일 체크 장기 계획)의 **그날치**는 여기서 빼지 않는다 —
  // 오늘 했는지 보려고 체크하는 건데 체크하는 순간 사라지면 확인할 방법이 없다.
  // occDate 가 붙은 사본만 해당한다. 계획 전체가 끝난 경우(원본의 done)는 평소대로 숨는다.
  if (!state.settings.showCompleted && t.done && !t.occDate) return false;
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
  // 시각이 정해진 일정은 하루의 뼈대다. 위쪽에 시간순으로 세우고,
  // 시각 없는 일정(종일)은 그 아래에서 기존 드래그 순서를 유지한다.
  // '시각 있는 것 먼저'를 order 보다 앞세워야 목록이 그날의 타임라인으로 읽힌다.
  if (!!a.startTime !== !!b.startTime) return a.startTime ? -1 : 1;
  if (a.startTime && b.startTime && a.startTime !== b.startTime) {
    return a.startTime < b.startTime ? -1 : 1;
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
  // 같은 일정의 같은 필드를 연달아 고치면(메모 타이핑 등) 한 번으로 묶는다
  pushUndo('일정 수정', `edit:${id}:${Object.keys(patch).sort().join(',')}`);
  Object.assign(t, patch);
  if (t.start && (!t.end || t.end < t.start)) t.end = t.start;

  // 시각 규칙은 normalize 와 같은 것을 다시 적용한다. patch 는 필드 하나만 담아
  // 오는 일이 많아서(예: startTime 만 비움) 여기서 정리하지 않으면 모순된 조합이 남는다.
  const times = normalizeTimes(t, t.start, t.end);
  t.startTime = times.startTime;
  t.endTime = times.endTime;

  // 시작 시각이 사라지면 '30분 전' 같은 상대 알림은 기준점을 잃는다.
  // 그대로 두면 조용히 안 울리는 알림이 되므로 함께 지운다.
  if (!t.startTime && parseRemind(t.remind)?.kind === 'rel') {
    t.remind = '';
    t.remindedAt = null;
  }

  // 기간이 바뀌면 '전부 체크했는가'의 기준도 바뀐다
  syncSpanDone(t);

  commit();
}

/**
 * 장기 계획을 한 번에 끝낼지, 하루하루 체크할지 고른다.
 *
 * 어느 쪽으로 바꾸든 이미 표시해 둔 것을 잃지 않는다 —
 * '끝냈다'고 해 둔 계획을 매일 체크로 바꾸면 모든 날이 체크된 상태로 옮겨 가고,
 * 도로 한 번에로 바꾸면 '전부 체크했는가'가 그대로 완료 여부가 된다.
 */
export function setDailyCheck(id, on) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t || t.repeat || !t.start || !t.end || t.end <= t.start) return;
  if (!!t.dailyCheck === !!on) return;

  pushUndo(on ? '매일 체크로' : '한 번에 체크로');
  if (on) {
    // '끝냈다'고 표시해 둔 계획이라면 모든 날을 체크된 것으로 옮긴다
    if (t.done) {
      for (let k = t.start; k <= t.end; k = addDays(k, 1)) {
        if (!t.doneDates.includes(k)) t.doneDates.push(k);
      }
    }
    t.dailyCheck = true;
    syncSpanDone(t);
  } else {
    // 끄기 전에 읽어야 한다 — 플래그를 내리면 spanProgress 가 null 을 준다
    const p = spanProgress(t);
    const all = !!p && p.done >= p.total;
    t.dailyCheck = false;
    t.done = all;
    t.doneAt = all ? (t.doneAt || Date.now()) : null;
  }
  commit();
}

export function toggleDone(id, occDate) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;

  // 반복 일정은 회차마다 완료 상태가 따로다 (이번 주는 했고 다음 주는 아직).
  // 매일 체크하는 장기 계획도 하루하루가 따로라 같은 길을 탄다.
  if ((t.repeat || isDailyCheck(t)) && occDate) {
    const i = t.doneDates.indexOf(occDate);
    pushUndo(i === -1 ? '완료 처리' : '완료 취소');
    if (i === -1) t.doneDates.push(occDate);
    else t.doneDates.splice(i, 1);
    syncSpanDone(t);
    commit();
    return;
  }

  pushUndo(t.done ? '완료 취소' : '완료 처리');
  t.done = !t.done;
  t.doneAt = t.done ? Date.now() : null;
  commit();
}

export function removeTask(id, occDate) {
  const t = state.tasks.find((x) => x.id === id);

  // 반복 일정에서 한 회차만 지우면 그날을 '예외'로 기록한다. 규칙은 그대로 남는다.
  if (t && t.repeat && occDate) {
    pushUndo('이 회차 건너뛰기');
    if (!t.exceptions.includes(occDate)) t.exceptions.push(occDate);
    commit();
    return;
  }

  pushUndo('일정 삭제');
  state.tasks = state.tasks.filter((x) => x.id !== id);
  commit();
}

/** 반복 일정을 규칙째 삭제 */
export function removeSeries(id) {
  pushUndo('반복 일정 전체 삭제');
  state.tasks = state.tasks.filter((x) => x.id !== id);
  commit();
}

/** 반복 규칙 설정/해제. patch 가 null 이면 반복을 끈다. */
export function setRepeat(id, patch) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  pushUndo(patch ? '반복 설정' : '반복 해제');
  t.repeat = normalizeRepeat(patch);
  // 반복은 당일짜리라 '매일 체크하는 장기 계획'과 양립하지 않는다.
  // 플래그를 남겨 두면 나중에 반복을 풀고 기간을 늘렸을 때 난데없이 되살아난다.
  if (t.repeat) t.dailyCheck = false;
  if (t.repeat) {
    // 반복은 당일 일정만 지원한다 (기간 반복은 캘린더 막대 배치가 급격히 복잡해진다)
    t.end = t.start;
    t.done = false;
    t.doneAt = null;
  } else {
    t.exceptions = [];
    t.doneDates = [];
  }
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
  moveTasksTo([id], newStart, '날짜 이동');
}

/**
 * 여러 건을 한 날짜로 옮긴다. 기간 길이와 시각은 그대로 유지한다.
 *
 * 한 건씩 moveTask 를 부르면 되돌리기 스택에 20개가 쌓여서, 되돌리려면
 * Ctrl+Z 를 스무 번 눌러야 한다. '밀린 일 오늘로 당기기' 같은 일괄 동작은
 * 반드시 한 번의 되돌리기로 묶여야 한다.
 *
 * @returns {number} 실제로 옮긴 건수
 */
export function moveTasksTo(ids, newStart, label) {
  const targets = ids
    .map((id) => state.tasks.find((x) => x.id === id))
    .filter((t) => t && !t.repeat);
  if (!targets.length) return 0;

  pushUndo(label || (targets.length > 1 ? `${targets.length}건 날짜 이동` : '날짜 이동'));
  const today = todayKey();
  for (const t of targets) {
    // '미뤘다' 로 세는 건 **오늘 할 일이었는데 뒤로 민 것** 뿐이다.
    // 다음 달 약속을 다른 날로 옮기는 건 미룬 게 아니라 그냥 일정 변경이다.
    if (t.start && t.start <= today && newStart > t.start) t.deferCount += 1;
    if (!t.start) {
      t.start = newStart;
      t.end = newStart;
    } else {
      const span = Math.max(0, diffDays(t.start, t.end || t.start));
      t.start = newStart;
      t.end = addDays(newStart, span);
    }
  }
  commit();
  return targets.length;
}

/**
 * D-Day 고정을 켜거나 끈다. 토글이 아니라 값을 지정한다.
 * 드롭처럼 '결과가 정해진' 동작에서 토글을 쓰면, 이미 고정된 일정을 떨어뜨렸을 때
 * 오히려 풀려 버린다.
 * @returns {boolean} 실제로 상태가 바뀌었는지
 */
export function setPinned(id, on) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t || t.pinned === !!on) return false;
  pushUndo(on ? 'D-Day 고정' : '고정 해제');
  t.pinned = !!on;
  commit();
  return true;
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

/**
 * 알림 설정 문자열을 해석한다. 두 가지 형식이 있다.
 *
 *   'N@HH:mm'  절대 — 시작일에서 N일 앞당긴 날의 지정 시각 ('0@09:00' = 당일 오전 9시)
 *   '-Nm'      상대 — 시작 시각 N분 전 ('-30m' = 30분 전)
 *
 * 상대 형식은 일정에 시작 시각(startTime)이 있어야 뜻이 생긴다. 종일 일정에는
 * '몇 분 전'의 기준점이 없기 때문에 remindTime 이 null 을 돌려준다.
 *
 * @returns {{kind:'abs',offsetDays:number,hour:number,minute:number}
 *          |{kind:'rel',minutes:number}|null}
 */
export function parseRemind(remind) {
  const raw = String(remind || '');

  const rel = /^-(\d{1,4})m$/.exec(raw);
  if (rel) return { kind: 'rel', minutes: Number(rel[1]) };

  const abs = /^(\d{1,2})@([01]\d|2[0-3]):([0-5]\d)$/.exec(raw);
  if (abs) {
    return { kind: 'abs', offsetDays: Number(abs[1]), hour: Number(abs[2]), minute: Number(abs[3]) };
  }
  return null;
}

/**
 * 이 태스크의 알림 예정 시각(epoch ms). 알림이 없거나 날짜가 없으면 null.
 * 시작일에서 offsetDays 만큼 앞당긴 날의 지정 시각.
 */
export function remindTime(t) {
  const r = parseRemind(t.remind);
  if (!r || !t.start) return null;
  // 반복 일정은 '오늘 이전의 가장 가까운 회차'를 기준으로 삼는다.
  // 기준일이 회차마다 앞으로 밀리므로 매번 새로 알림이 나간다.
  const base = t.repeat ? lastOccurrenceOnOrBefore(t, todayKey()) : t.start;
  if (!base) return null;

  if (r.kind === 'rel') {
    // '몇 분 전'은 시작 시각이 있어야 기준점이 생긴다. 종일 일정에는 뜻이 없다.
    if (!t.startTime) return null;
    const when = fromKeyTime(base, t.startTime);
    when.setMinutes(when.getMinutes() - r.minutes);
    return when.getTime();
  }

  const [y, mo, d] = base.split('-').map(Number);
  const when = new Date(y, mo - 1, d, r.hour, r.minute, 0, 0);
  when.setDate(when.getDate() - r.offsetDays);
  return when.getTime();
}

/** 아직 알리지 않았고 시간이 된 태스크들 */
export function dueReminders(now = Date.now()) {
  return state.tasks.filter((t) => {
    if (!t.remind) return false;
    if (!t.repeat && t.done) return false;
    const at = remindTime(t);
    if (at === null || at > now) return false;
    // 이미 '이번 회차' 알림을 보냈으면 건너뛴다.
    // 반복 일정은 at 이 회차마다 앞으로 밀리므로 자연히 다시 대상이 된다.
    return !t.remindedAt || t.remindedAt < at;
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

/**
 * 일정 복제 — 같은 날짜에 같은 내용으로 하나 더.
 * 완료 상태·알림 이력·건너뛴 회차는 원본의 사정이므로 물려받지 않는다.
 */
export function duplicateTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return null;
  pushUndo('일정 복제');
  const copy = normalize({
    ...structuredClone(t),
    id: cryptoId(),
    title: t.title,
    done: false,
    doneAt: null,
    remindedAt: null,
    doneDates: [],
    exceptions: [],
    createdAt: Date.now(),
  });
  copy.order = state.tasks.length;
  state.tasks.push(copy);
  commit();
  return copy;
}

/**
 * 날짜와 무관한 전체 검색.
 * 목록의 검색창은 그동안 '고른 날짜 안에서만' 걸러서, 다른 달에 있는 일정은
 * 아무리 검색해도 안 나왔다.
 */
export function searchTasks(text) {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return [];
  return state.tasks
    .filter((t) => {
      if (!state.settings.showCompleted && t.done) return false;
      if (state.filter.tag && !t.tags.includes(state.filter.tag)) return false;
      return t.title.toLowerCase().includes(q)
        || t.notes.toLowerCase().includes(q)
        || t.tags.some((tag) => tag.toLowerCase().includes(q));
    })
    .sort((a, b) => {
      // 날짜 있는 것 먼저, 가까운 날짜 순
      if (!a.start !== !b.start) return a.start ? -1 : 1;
      if (a.start && b.start && a.start !== b.start) return a.start < b.start ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
}

// ---------------------------------------------------------------- 가져오기

/**
 * 백업 데이터를 현재 상태에 반영한다.
 * @param {object} data  parseBackup 을 통과한 객체
 * @param {'merge'|'replace'} mode
 *   merge   — 없는 id 만 추가한다 (기존 일정은 절대 건드리지 않는다)
 *   replace — 일정·바로가기를 통째로 교체한다
 * @returns {{added:number, total:number}}
 */
export function importData(data, mode = 'merge') {
  pushUndo(mode === 'replace' ? '데이터 덮어쓰기' : '데이터 가져오기');

  const incoming = data.tasks.map(normalize);

  if (mode === 'replace') {
    state.tasks = incoming;
    if (Array.isArray(data.launcher)) state.launcher = data.launcher.map(normalizeLauncher);
    commit();
    return { added: incoming.length, total: incoming.length };
  }

  const known = new Set(state.tasks.map((t) => t.id));
  let added = 0;
  for (const t of incoming) {
    if (known.has(t.id)) continue;
    state.tasks.push(t);
    known.add(t.id);
    added++;
  }

  if (Array.isArray(data.launcher)) {
    const knownL = new Set(state.launcher.map((x) => x.id));
    for (const it of data.launcher.map(normalizeLauncher)) {
      if (!knownL.has(it.id)) state.launcher.push(it);
    }
  }

  commit();
  return { added, total: state.tasks.length };
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

/** 캘린더에서 끌어 만든 기간으로 추가 폼을 열도록 요청한다 */
export function requestCompose(start, end) {
  state.composeRequest = { start, end: end < start ? start : end };
  state.selectedDate = start;
  state.anchorMonth = start;
  commit({ save: false });
}

/** 투두 패널이 폼을 연 뒤 호출해 요청을 비운다 */
export function consumeCompose() {
  const req = state.composeRequest;
  state.composeRequest = null;
  return req;
}

export function setEditing(id) {
  state.editingTaskId = id;
  commit({ save: false });
}

/**
 * 데이터는 그대로인데 다시 그려야 할 때 (날짜가 바뀌었을 때 등).
 * '오늘'을 기준으로 계산하는 것들 — 지난 일, D-Day, 오늘 할 일 머리글 — 은
 * 태스크가 하나도 안 바뀌어도 자정이 지나면 값이 달라진다.
 */
/**
 * 필요한 해의 공휴일을 채운다. 이미 받아 둔 해는 건너뛴다.
 * 자료가 없는 해(아직 월력요항이 발표되지 않은 미래)는 다시 묻지 않도록 표시해 둔다.
 */
export async function ensureHolidays(years) {
  const want = [...new Set(years)].filter((y) => !state.holidayYears.has(y));
  if (!want.length) return;

  // 요청을 보내는 즉시 표시해 둔다 — 달을 빠르게 넘길 때 같은 해를 여러 번 묻지 않게.
  for (const y of want) state.holidayYears.add(y);

  try {
    const res = await window.api.holidays?.get(want);
    if (!res) return;
    Object.assign(state.holidays, res.days || {});
    // 자료가 없는 해는 표시를 남겨 둔 채로 둔다(다시 묻지 않는다)
    commit({ save: false });
  } catch {
    // 실패하면 다음에 다시 물을 수 있도록 표시를 지운다
    for (const y of want) state.holidayYears.delete(y);
  }
}

/** 그날의 공휴일 이름들 (없으면 null) */
export function holidayOn(key) {
  return state.holidays[key] || null;
}

export function touch() {
  commit({ save: false });
}

export function setSetting(key, value) {
  state.settings[key] = value;
  commit();
}
