// 투두 패널 — 캘린더에서 고른 날짜(state.selectedDate)와 연동되는 할 일 목록.
// 계약: export function createTodoPanel({ root, store }) -> { destroy() }
// 외부 라이브러리 없음. 순수 ES 모듈 + DOM API. 사용자 입력은 항상 textContent 로만 넣는다.

import { todayKey, toKey, fromKey, addDays, diffDays, WEEKDAY_LABELS } from '../lib/date.js';
import { remindLabel } from '../reminders.js';
import { icon } from '../lib/icons.js';
import { createCompose, whenSummary } from './compose.js';
import { showContextMenu } from '../lib/menu.js';

/**
 * 리마인더 프리셋.
 *   'N@HH:mm'  시작일에서 N일 전의 지정 시각
 *   '-Nm'      시작 시각 N분 전 — 시각이 있는 일정에서만 뜻이 있다
 */
const REMIND_PRESETS = [
  ['',        '알림 없음'],
  ['-10m',    '10분 전',  true],
  ['-30m',    '30분 전',  true],
  ['-60m',    '1시간 전', true],
  ['0@09:00', '당일 오전 9시'],
  ['0@12:00', '당일 정오'],
  ['0@18:00', '당일 오후 6시'],
  ['1@18:00', '하루 전 오후 6시'],
  ['3@18:00', '3일 전 오후 6시'],
  ['7@18:00', '일주일 전 오후 6시'],
];

/** 반복 프리셋 */
const REPEAT_PRESETS = [
  ['',        '반복 안 함'],
  ['daily',   '매일'],
  ['weekly',  '매주'],
  ['monthly', '매월'],
  ['yearly',  '매년'],
];

function repeatSelect(cls) {
  const sel = document.createElement('select');
  sel.className = cls;
  for (const [value, label] of REPEAT_PRESETS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sel.append(opt);
  }
  return sel;
}

function remindSelect(cls) {
  const sel = document.createElement('select');
  sel.className = cls;
  for (const [value, label, needsTime] of REMIND_PRESETS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (needsTime) opt.dataset.needsTime = '1';
    sel.append(opt);
  }
  return sel;
}

/** 시각 없는 일정에서는 '몇 분 전'을 숨긴다 — 기준점이 없어 울리지 않는 선택지다 */
function syncRemindOptions(sel, hasTime) {
  for (const opt of sel.options) {
    if (opt.dataset.needsTime) opt.hidden = !hasTime;
  }
}

// ============================================================ 빠른 입력 파서
//
// 문법 요약
//   !  / !!        우선순위 1(중요) / 2(긴급)
//   #태그          태그 (여러 개 가능)
//   @날짜          시작일   (오늘/내일/모레/글피/요일/8/15/2026-08-15/15일)
//   ~종료          종료일   (3d, 3일 = 시작일 +N일 / 8/20 / 2026-08-20)
//   *색            파랑 초록 노랑 빨강 보라 회색
//
// 예시 입출력 (baseKey = '2026-08-10' 월요일 기준)
//
//   parseQuickInput('장보기 @내일 #집안일 !', '2026-08-10')
//   → { title: '장보기', start: '2026-08-11', end: null,
//       tags: ['집안일'], priority: 1, color: null }
//
//   parseQuickInput('기획서 마감 @8/15 ~3d *빨강 !!', '2026-08-10')
//   → { title: '기획서 마감', start: '2026-08-15', end: null, endDays: 3,
//       tags: [], priority: 2, color: 'rose' }
//     endDays 는 resolveRange() 에서 start + 3일 = '2026-08-18' 로 확정된다.
//
//   parseQuickInput('!!긴급 회의 #업무 #팀 @금', '2026-08-10')
//   → { title: '긴급 회의', start: '2026-08-14', end: null,
//       tags: ['업무', '팀'], priority: 2, color: null }
//
//   parseQuickInput('보고서 @2026-09-01 ~5일 *초록 #회사', '2026-08-10')
//   → { title: '보고서', start: '2026-09-01', endDays: 5, tags: ['회사'], color: 'green' }
//
//   parseQuickInput('운동하기!!', '2026-08-10')
//   → { title: '운동하기', priority: 2 }   // 첫/마지막 토큰에 붙여 쓴 ! 도 인식
//
//   parseQuickInput('치과 @15일', '2026-08-10')
//   → { title: '치과', start: '2026-08-15' }   // 이미 지난 날이면 다음 달
//
//   parseQuickInput('이상한거 @없는날짜 *분홍 ~zzz', '2026-08-10')
//   → { title: '이상한거', unknown: ['@없는날짜', '*분홍', '~zzz'] }
//     해석 실패한 조각은 제목에서 빼되 unknown 에 담아 미리보기에서 경고로 보여 준다.
//
//   parseQuickInput('그냥 할일', '2026-08-10')
//   → { title: '그냥 할일', start: null, end: null, tags: [], priority: 0, color: null }
//     start 가 null(미지정)이면 store.addTask 가 selectedDate 를 넣는다.
//
//   parseQuickInput('   ', '2026-08-10')
//   → { title: '', ... }  (빈 제목이면 추가하지 않는다)

/** 한글/영문 색 이름 → store.COLORS 키 */
const COLOR_ALIASES = {
  파랑: 'blue', 파란: 'blue', 파란색: 'blue', 블루: 'blue', blue: 'blue',
  초록: 'green', 초록색: 'green', 녹색: 'green', 그린: 'green', green: 'green',
  노랑: 'amber', 노란: 'amber', 노란색: 'amber', 앰버: 'amber', amber: 'amber', yellow: 'amber',
  빨강: 'rose', 빨간: 'rose', 빨간색: 'rose', 레드: 'rose', red: 'rose', rose: 'rose',
  보라: 'violet', 보라색: 'violet', 퍼플: 'violet', violet: 'violet', purple: 'violet',
  회색: 'slate', 그레이: 'slate', gray: 'slate', grey: 'slate', slate: 'slate',
};

/** 색 키 → 한글 표시명 (미리보기용) */
const COLOR_NAMES = {
  blue: '파랑', green: '초록', amber: '노랑', rose: '빨강', violet: '보라', slate: '회색',
};

const WEEKDAY_INDEX = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** y-m-d 를 키로 만들되 실제로 존재하는 날짜인지 검증 (2/30 같은 건 null) */
function makeKey(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const key = `${y}-${pad2(m)}-${pad2(d)}`;
  return toKey(fromKey(key)) === key ? key : null;
}

/**
 * '@' / '~' 뒤에 오는 낱말을 날짜 키로 해석한다.
 * @param {string} word  마커를 뗀 문자열
 * @param {string} baseKey 상대 날짜의 기준일
 * @returns {string|null}
 */
function resolveDateWord(word, baseKey) {
  const w = word.trim();
  if (!w) return null;

  // 상대 날짜
  const RELATIVE = { 오늘: 0, today: 0, 내일: 1, tomorrow: 1, 모레: 2, 글피: 3, 어제: -1 };
  if (w in RELATIVE) return addDays(baseKey, RELATIVE[w]);

  // 요일 — 기준일 다음의 해당 요일 (기준일과 같은 요일이면 다음 주)
  const weekday = w.match(/^([일월화수목금토])(요일)?$/);
  if (weekday) {
    const target = WEEKDAY_INDEX[weekday[1]];
    const cur = fromKey(baseKey).getDay();
    let delta = (target - cur + 7) % 7;
    if (delta === 0) delta = 7;
    return addDays(baseKey, delta);
  }

  // 2026-08-15 / 2026.8.15
  const full = w.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (full) return makeKey(Number(full[1]), Number(full[2]), Number(full[3]));

  // 8/15 · 8.15 · 8-15 → 올해 기준, 이미 지났으면 내년
  const md = w.match(/^(\d{1,2})[-./](\d{1,2})$/);
  if (md) {
    const year = fromKey(baseKey).getFullYear();
    const key = makeKey(year, Number(md[1]), Number(md[2]));
    if (!key) return null;
    return key >= baseKey ? key : makeKey(year + 1, Number(md[1]), Number(md[2]));
  }

  // 15일 → 이번 달, 이미 지났으면 다음 달
  const dayOnly = w.match(/^(\d{1,2})일$/);
  if (dayOnly) {
    const base = fromKey(baseKey);
    const key = makeKey(base.getFullYear(), base.getMonth() + 1, Number(dayOnly[1]));
    if (key && key >= baseKey) return key;
    const next = new Date(base.getFullYear(), base.getMonth() + 1, 1);
    return makeKey(next.getFullYear(), next.getMonth() + 1, Number(dayOnly[1]));
  }

  return null;
}

/**
 * 시각처럼 생긴 낱말을 'HH:mm' 으로. 아니면 null.
 *
 *   15:00  9:30        그대로
 *   15시  9시  9시30분  시 단위
 *   오후3시  오전9:30    오전/오후를 붙였을 때만 12시간제로 읽는다
 *
 * **오전/오후를 안 붙이면 적힌 그대로 읽는다.** '3시'를 15:00 으로 넘겨짚지 않는다.
 * 반복 규칙에서 31일을 말일에 붙이지 않은 것과 같은 이유 — 예측 가능성이 먼저다.
 */
function resolveTimeWord(w) {
  const m = /^(오전|오후)?(\d{1,2})(?::(\d{1,2})|시(?:(\d{1,2})분?)?)$/.exec(String(w || ''));
  if (!m) return null;

  let hour = Number(m[2]);
  const min = Number(m[3] ?? m[4] ?? 0);
  if (min > 59) return null;

  if (m[1]) {
    // 오전/오후를 붙였으면 12시간제. '오후 12시'는 정오, '오전 12시'는 자정.
    if (hour < 1 || hour > 12) return null;
    if (m[1] === '오후' && hour !== 12) hour += 12;
    if (m[1] === '오전' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }

  return `${pad2(hour)}:${pad2(min)}`;
}

/** '15:00~16:30' / '15:00-16:30' → 시작·종료 시각. 아니면 null */
function resolveTimeRange(w) {
  const parts = String(w || '').split(/[~-]/);
  if (parts.length !== 2) return null;
  const startTime = resolveTimeWord(parts[0]);
  const endTime = resolveTimeWord(parts[1]);
  if (!startTime || !endTime) return null;
  return { startTime, endTime };
}

/**
 * 빠른 입력 문자열을 태스크 조각으로 파싱한다. 순수 함수.
 * @param {string} text
 * @param {string} [baseKey] 상대 날짜 기준일 (기본: 오늘)
 * @returns {{title:string, start:string|null, end:string|null, endDays:number|null,
 *            startTime:string|null, endTime:string|null,
 *            tags:string[], priority:number, color:string|null, unknown:string[]}}
 */
export function parseQuickInput(text, baseKey = todayKey()) {
  const out = {
    title: '',
    start: null,
    end: null,
    endDays: null,   // ~3d 처럼 '시작일 + N일' 로 들어온 경우 N (미리보기에서 안내)
    startTime: null, // '15:00' 처럼 시각만 적은 토큰
    endTime: null,
    tags: [],
    priority: 0,
    color: null,
    unknown: [],     // 마커는 붙었는데 해석 못 한 조각 (미리보기에서 경고)
  };

  const raw = String(text ?? '');
  const tokens = raw.split(/\s+/).filter(Boolean);
  const words = [];

  tokens.forEach((token, i) => {
    // 단독 '!' / '!!'
    if (/^!{1,2}$/.test(token)) {
      out.priority = Math.max(out.priority, token.length);
      return;
    }

    // #태그
    if (token.length > 1 && token[0] === '#') {
      const tag = token.slice(1).replace(/[,]+$/, '');
      if (tag && !out.tags.includes(tag)) out.tags.push(tag);
      return;
    }

    // *색
    if (token.length > 1 && token[0] === '*') {
      const key = COLOR_ALIASES[token.slice(1).toLowerCase()];
      if (key) out.color = key;
      else out.unknown.push(token);
      return;
    }

    // @시작일
    if (token.length > 1 && token[0] === '@') {
      const key = resolveDateWord(token.slice(1), baseKey);
      if (key) out.start = key;
      else out.unknown.push(token);
      return;
    }

    // ~종료일 / ~3d
    if (token.length > 1 && token[0] === '~') {
      const body = token.slice(1);
      const dur = body.match(/^(\d{1,3})\s*(d|일|day|days)$/i);
      if (dur) {
        out.endDays = Number(dur[1]);
        return;
      }
      const key = resolveDateWord(body, baseKey);
      if (key) out.end = key;
      else out.unknown.push(token);
      return;
    }

    // 시각 — '15:00', '오후3시', '15:00~16:30'.
    // 마커(@ ~ # *)가 없어도 알아본다. 무엇으로 읽혔는지는 미리보기가 바로 보여 준다.
    const range = resolveTimeRange(token);
    if (range) {
      out.startTime = range.startTime;
      out.endTime = range.endTime;
      return;
    }
    const time = resolveTimeWord(token);
    if (time) {
      out.startTime = time;
      return;
    }

    // 붙여 쓴 '!!긴급' (첫 토큰) / '장보기!!' (마지막 토큰)
    let word = token;
    if (i === 0) {
      const lead = word.match(/^(!{1,2})(?=\S)/);
      if (lead) {
        out.priority = Math.max(out.priority, lead[1].length);
        word = word.slice(lead[1].length);
      }
    }
    if (i === tokens.length - 1) {
      const tail = word.match(/(!{1,2})$/);
      if (tail && word.length > tail[1].length) {
        out.priority = Math.max(out.priority, tail[1].length);
        word = word.slice(0, -tail[1].length);
      }
    }
    if (word) words.push(word);
  });

  out.title = words.join(' ').trim();
  return out;
}

/** 파싱 결과 + 기준 시작일로 최종 start/end 를 계산 (미리보기와 추가 시 동일 로직) */
function resolveRange(parsed, fallbackStart) {
  const start = parsed.start || fallbackStart || null;
  let end = parsed.end || null;
  if (parsed.endDays != null && start) end = addDays(start, parsed.endDays);
  if (start && end && end < start) end = start;
  return { start, end };
}

// ============================================================ DOM 헬퍼

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/**
 * 사용자가 입력한 링크를 정규화한다.
 * 'meet.google.com/abc' 처럼 프로토콜 없이 적어도 https 를 붙여 준다.
 * @returns {string|null} 빈 문자열이면 링크 없음, null 이면 잘못된 주소
 */
function normalizeLink(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;   // 'https://abc' 같은 오타 거르기
    return u.href;
  } catch {
    return null;
  }
}

/** 링크를 기본 브라우저로 연다 */
function openLink(url) {
  const href = normalizeLink(url);
  if (!href) return;
  window.api.openExternal(href);
}

/** 표시용 짧은 링크 — 'google.com/abc...' */
function linkLabel(url) {
  try {
    const u = new URL(url);
    const tail = (u.pathname + u.search).replace(/\/$/, '');
    const s = u.hostname.replace(/^www\./, '') + tail;
    return s.length > 34 ? s.slice(0, 33) + '…' : s;
  } catch {
    return url;
  }
}

/** '8월 10일 (월)' */
function formatDateLabel(key) {
  const d = fromKey(key);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY_LABELS[d.getDay()]})`;
}

/** '8/15(금)' — 좁은 곳용 */
function formatShort(key) {
  const d = fromKey(key);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAY_LABELS[d.getDay()]})`;
}

/** 포커스 중인 필드의 값은 덮어쓰지 않는다 (한글 조합 중 입력 날아감 방지) */
function setValueSafe(el, value) {
  if (document.activeElement === el) return;
  if (el.value !== value) el.value = value;
}

/**
 * 짧은 확인 문구를 셸에 부탁한다.
 * 뷰 모듈끼리 직접 부르지 않는다는 계약을 지키려고 이벤트로 넘긴다.
 */
function notify(text) {
  document.dispatchEvent(new CustomEvent('app:toast', { detail: String(text) }));
}

function isSpanTask(t) {
  return !!(t.start && t.end && t.end > t.start);
}

function isFormControl(el) {
  return !!(el && el.closest && el.closest('input, textarea, select'));
}

// ============================================================ 패널 팩토리

export function createTodoPanel({ root, store }) {
  const COLORS = store.COLORS;
  const PRIORITY_LABELS = store.PRIORITY_LABELS;

  // ---------------------------------------------------------- 정적 셸 (한 번만 생성)
  const el = h('div', 'todo-panel');

  // 헤더 -------------------------------------------------------
  const header = h('header', 'todo-header');

  const dateRow = h('div', 'todo-daterow');
  const dateLabel = h('div', 'todo-date');
  const todayBadge = h('span', 'todo-badge todo-badge--today', '오늘');
  const goTodayBtn = h('button', 'todo-gotoday', '오늘로');
  goTodayBtn.type = 'button';
  goTodayBtn.setAttribute('aria-label', '오늘 날짜로 이동');
  const progressText = h('span', 'todo-progress__text', '0/0');
  const addBtn = h('button', 'todo-add');
  addBtn.append(icon('plus'));
  addBtn.type = 'button';
  addBtn.setAttribute('aria-label', '일정 추가');
  dateRow.append(dateLabel, todayBadge, goTodayBtn, progressText, addBtn);

  const progressBar = h('div', 'todo-progress');
  const progressFill = h('div', 'todo-progress__fill');
  progressBar.append(progressFill);

  const filterRow = h('div', 'todo-filters');
  const searchInput = h('input', 'todo-search');
  searchInput.type = 'text';
  searchInput.placeholder = '검색';
  searchInput.spellcheck = false;
  searchInput.setAttribute('aria-label', '전체 일정 검색');
  const completedBtn = h('button', 'todo-toggle', '완료 표시');
  completedBtn.type = 'button';
  completedBtn.setAttribute('aria-pressed', 'false');
  filterRow.append(searchInput, completedBtn);

  const tagBar = h('div', 'todo-tagbar');

  header.append(dateRow, progressBar, filterRow, tagBar);

  // 빠른 입력 --------------------------------------------------
  const quick = h('div', 'todo-quick');
  const quickInput = h('input', 'todo-quick__input');
  quickInput.type = 'text';
  quickInput.placeholder = '할 일을 적고 Enter';
  quickInput.spellcheck = false;
  const preview = h('div', 'todo-preview');
  quick.append(quickInput, preview);

  // 목록 -------------------------------------------------------
  const body = h('div', 'todo-body');

  const sections = {
    search: makeSection('search', '검색 결과'),
    // 기한이 지났는데 안 끝난 일. 고른 날짜와 무관하게 언제나 맨 위에 온다 —
    // 어제 못 끝낸 일이 어제 칸에 남아 시야에서 사라지는 게 이 앱의 가장 큰 구멍이었다.
    overdue: makeSection('overdue', '지난 일'),
    focus: makeSection('focus', '선택한 항목'),
    day: makeSection('day', '오늘 할 일'),
    span: makeSection('span', '진행 중인 장기 계획'),
    inbox: makeSection('inbox', '언젠가'),
  };
  sections.inbox.collapsed = false;
  sections.overdue.el.classList.add('todo-section--overdue');

  // '오늘로 당기기' — 밀린 일을 한 번에 오늘로. 되돌리기 한 번으로 취소된다.
  const rollBtn = h('button', 'todo-rollup', '오늘로 당기기');
  rollBtn.type = 'button';
  rollBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const ids = store.overdueTasks().map((t) => t.id);
    if (!ids.length) return;
    const n = store.moveTasksTo(ids, todayKey(), `밀린 일 ${ids.length}건 오늘로`);
    store.selectDate(todayKey());
    if (n) notify(`${n}건을 오늘로 옮겼습니다`);
  });
  sections.overdue.actions.append(rollBtn);

  body.append(sections.search.el, sections.overdue.el, sections.focus.el,
              sections.day.el, sections.span.el, sections.inbox.el);

  // 일정 추가 폼 -----------------------------------------------
  // 빠른 입력이 문법을 외워야 하는 반면, 이쪽은 클릭만으로 전부 지정할 수 있는 경로다.
  const compose = createCompose({ store });

  el.append(header, quick, compose.el, body);
  root.append(el);

  addBtn.addEventListener('click', () => {
    if (compose.el.hidden) compose.open();
    else compose.close();
  });

  /** 날짜·기간·링크까지 한 번에 지정하는 추가 폼 */

  // ---------------------------------------------------------- 로컬 UI 상태
  const itemCache = new Map();   // taskId -> 아이템 레코드 (DOM 재사용 → 포커스/조합 보존)
  let inlineEditId = null;       // 제목 인라인 편집 중인 태스크 id
  let lastEditingId = null;      // editingTaskId 변화 감지 (스크롤용)
  let rafId = 0;
  let destroyed = false;
  let notesTimer = null;
  let pendingNotes = null;       // { id, value }
  let dragId = null;             // 현재 드래그 중인 태스크 id
  let lastTagSignature = '';

  // ---------------------------------------------------------- 섹션 생성기
  function makeSection(key, title) {
    const secEl = h('section', 'todo-section');
    secEl.dataset.section = key;

    // 접기 버튼과 동작 버튼은 형제여야 한다.
    // 머리글 자체를 button 으로 만들면 '오늘로 당기기'가 버튼 안의 버튼이 되어
    // HTML 이 유효하지 않고 접근성 트리도 무너진다.
    const head = h('div', 'todo-section__head');

    const toggle = h('button', 'todo-section__toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'true');
    const caret = h('span', 'todo-section__caret', '▾');
    const titleEl = h('span', 'todo-section__title', title);
    const count = h('span', 'todo-section__count', '0');
    toggle.append(caret, titleEl, count);

    // 섹션마다 붙는 동작 버튼 자리(예: 지난 일의 '오늘로 당기기'). 기본은 비어 있다.
    const actions = h('span', 'todo-section__actions');
    head.append(toggle, actions);

    const wrap = h('div', 'todo-list-wrap');
    const list = h('ul', 'todo-list');
    const dropline = h('div', 'todo-dropline');
    wrap.append(list, dropline);

    secEl.append(head, wrap);

    const sec = { key, el: secEl, head, toggle, list, wrap, dropline, count, titleEl, actions,
                  ids: [], collapsed: false, emptyEl: null };

    toggle.addEventListener('click', () => {
      sec.collapsed = !sec.collapsed;
      toggle.setAttribute('aria-expanded', String(!sec.collapsed));
      scheduleRender();
    });

    // --- 드롭 대상 ---
    wrap.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('application/x-task-id')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      showDropline(sec, e.clientY);
    });
    wrap.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && wrap.contains(e.relatedTarget)) return;
      sec.dropline.style.display = 'none';
    });
    wrap.addEventListener('drop', (e) => {
      if (!e.dataTransfer) return;
      const id = e.dataTransfer.getData('application/x-task-id');
      sec.dropline.style.display = 'none';
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      handleDrop(sec, id, e.clientY);
    });

    return sec;
  }

  // ---------------------------------------------------------- 드래그 앤 드롭
  /** 드롭 위치 인덱스 (현재 목록 기준) */
  function dropIndexAt(sec, clientY) {
    const items = Array.from(sec.list.children);
    let index = items.length;
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) { index = i; break; }
    }
    return index;
  }

  function showDropline(sec, clientY) {
    const items = Array.from(sec.list.children);
    const index = dropIndexAt(sec, clientY);
    let top;
    if (items.length === 0) {
      top = sec.list.offsetTop + 4;
    } else if (index >= items.length) {
      const last = items[items.length - 1];
      top = last.offsetTop + last.offsetHeight + 1;
    } else {
      top = items[index].offsetTop - 1;
    }
    sec.dropline.style.top = `${top}px`;
    sec.dropline.style.display = 'block';
  }

  function handleDrop(sec, id, clientY) {
    const st = store.getState();
    const inSection = sec.ids.includes(id);

    if (!inSection) {
      // 다른 섹션 → 이 섹션으로 이동 (날짜 부여 / 날짜 해제)
      if (sec.key === 'inbox') store.updateTask(id, { start: null, end: null });
      else if (sec.key === 'day' || sec.key === 'span') store.moveTask(id, st.selectedDate);
      return;
    }

    // 같은 섹션 내 순서 변경
    const index = dropIndexAt(sec, clientY);
    const from = sec.ids.indexOf(id);
    let to = index;
    if (from < to) to -= 1;
    if (from === to) return;
    const rest = sec.ids.filter((x) => x !== id);
    rest.splice(Math.max(0, Math.min(to, rest.length)), 0, id);
    store.reorder(rest);
  }

  // ---------------------------------------------------------- 아이템 생성
  function createItem(taskId) {
    const li = h('li', 'todo-item');
    li.dataset.id = taskId;
    li.draggable = true;
    // 로빙 탭인덱스 — 목록 전체가 아니라 '현재 항목' 하나만 Tab 으로 들어온다.
    // 50개짜리 목록에서 Tab 을 50번 누르게 만들지 않기 위해서다.
    li.tabIndex = -1;

    const row = h('div', 'todo-item__row');

    // 체크는 시각적으로 버튼이지만 하는 일은 체크박스다.
    // role/aria-checked 를 주지 않으면 스크린리더에 '눌림' 상태가 전달되지 않는다.
    const check = h('button', 'todo-check');
    check.type = 'button';
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', 'false');

    const dot = h('span', 'todo-dot');
    // 시각이 있으면 제목 앞에 세워 목록이 그날의 타임라인으로 읽히게 한다
    const time = h('span', 'todo-time');
    time.hidden = true;
    const title = h('span', 'todo-title');
    const meta = h('span', 'todo-meta');           // 우선순위 뱃지 + 태그 + D-day
    const del = h('button', 'todo-del');
    del.append(icon('close'));
    del.type = 'button';

    row.append(check, dot, time, title, meta, del);
    li.append(row);

    const rec = { id: taskId, el: li, row, check, dot, time, title, meta, del,
                  detail: null, task: null };

    // 완료 토글
    check.addEventListener('click', (e) => {
      e.stopPropagation();
      // 반복 일정은 '이 회차'만 완료 처리한다
      store.toggleDone(taskId, rec.task?.occDate);
    });

    // 삭제
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (store.getState().editingTaskId === taskId) store.setEditing(null);
      // 반복 일정은 이 회차만 건너뛴다. 규칙째 지우려면 상세의 '반복 전체 삭제'.
      store.removeTask(taskId, rec.task?.occDate);
    });

    // 우클릭 메뉴 — 자주 쓰는 동작을 손 가까이에 둔다
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const t = rec.task;
      if (!t) return;
      const st = store.getState();
      showContextMenu(e.clientX, e.clientY, [
        {
          label: t.done ? '완료 취소' : '완료로 표시',
          onSelect: () => store.toggleDone(t.id, t.occDate),
        },
        {
          label: st.editingTaskId === t.id ? '자세히 닫기' : '자세히 보기',
          onSelect: () => store.setEditing(st.editingTaskId === t.id ? null : t.id),
        },
        { separator: true },
        {
          label: '내일로 미루기',
          disabled: !t.start,
          onSelect: () => store.moveTask(t.id, addDays(t.occDate || t.start, 1)),
        },
        {
          label: t.pinned ? 'D-Day 고정 해제' : 'D-Day에 고정',
          disabled: !!t.repeat || !t.end,
          onSelect: () => store.togglePinned(t.id),
        },
        {
          label: '복제',
          onSelect: () => {
            const copy = store.duplicateTask(t.id);
            if (copy) store.setEditing(copy.id);
          },
        },
        { separator: true },
        {
          label: t.repeat && t.occDate ? '이 회차 건너뛰기' : '삭제',
          danger: true,
          onSelect: () => {
            if (store.getState().editingTaskId === t.id) store.setEditing(null);
            store.removeTask(t.id, t.occDate);
          },
        },
      ]);
    });

    // 클릭 → 상세 펼치기/접기.
    // 제목 위 클릭은 더블클릭(인라인 편집)일 수 있으므로 잠깐 미뤘다가 실행한다.
    let clickTimer = null;
    const toggleExpand = () => {
      if (destroyed) return;
      const cur = store.getState().editingTaskId;
      store.setEditing(cur === taskId ? null : taskId);
    };
    li.addEventListener('click', (e) => {
      if (e.target.closest('.todo-check, .todo-del, .todo-detail, .todo-title-input, .todo-tag')) return;
      if (e.detail > 1) return;   // 더블클릭의 두 번째 클릭 무시
      if (e.target === title) {
        clearTimeout(clickTimer);
        clickTimer = setTimeout(toggleExpand, 200);
      } else {
        toggleExpand();
      }
    });

    // 제목 더블클릭 → 인라인 편집
    title.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      clearTimeout(clickTimer);
      startInlineEdit(rec);
    });

    // 입력 필드를 잡고 드래그할 때 아이템 드래그가 가로채지 않도록
    li.addEventListener('mousedown', (e) => {
      li.draggable = !isFormControl(e.target);
    });

    li.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData('application/x-task-id', taskId);
      e.dataTransfer.setData('text/plain', rec.task ? rec.task.title : '');
      e.dataTransfer.effectAllowed = 'move';
      dragId = taskId;
      li.classList.add('is-dragging');
    });
    li.addEventListener('dragend', () => {
      dragId = null;
      li.classList.remove('is-dragging');
      li.draggable = true;
      for (const key of Object.keys(sections)) sections[key].dropline.style.display = 'none';
    });

    return rec;
  }

  function getItem(taskId) {
    let rec = itemCache.get(taskId);
    if (!rec) {
      rec = createItem(taskId);
      itemCache.set(taskId, rec);
    }
    return rec;
  }

  // ---------------------------------------------------------- 인라인 제목 편집
  function startInlineEdit(rec) {
    if (inlineEditId === rec.id) return;
    inlineEditId = rec.id;
    const original = rec.task ? rec.task.title : '';

    const input = h('input', 'todo-title-input');
    input.type = 'text';
    input.value = original;
    input.spellcheck = false;
    rec.title.replaceWith(input);
    rec.titleInput = input;
    input.focus();
    input.select();

    let closed = false;
    const close = (save) => {
      if (closed) return;
      closed = true;
      inlineEditId = null;
      rec.titleInput = null;
      const value = input.value.trim();
      input.replaceWith(rec.title);
      if (save && value && value !== original) store.updateTask(rec.id, { title: value });
      else scheduleRender();
    };

    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;   // 한글 조합 중
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
      else if (e.key === 'Escape') { e.preventDefault(); close(false); }
    });
    input.addEventListener('blur', () => close(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  // ---------------------------------------------------------- 상세 영역
  function field(labelText, control) {
    const f = h('label', 'todo-field');
    f.append(h('span', 'todo-field__label', labelText), control);
    return f;
  }

  function buildDetail(rec) {
    const d = h('div', 'todo-detail');

    const notes = h('textarea', 'todo-detail__notes');
    notes.placeholder = '메모';
    notes.rows = 2;
    notes.addEventListener('input', () => {
      pendingNotes = { id: rec.id, value: notes.value };
      clearTimeout(notesTimer);
      notesTimer = setTimeout(flushNotes, 300);
    });
    notes.addEventListener('blur', flushNotes);

    // 시작 / 종료 · 날짜 + 시각.
    // 추가 폼과 같은 배치다 — 만들 때와 고칠 때의 조작이 달라선 안 된다.
    const startIn = h('input', 'todo-detail__date');
    startIn.type = 'date';
    startIn.setAttribute('aria-label', '시작 날짜');
    startIn.addEventListener('change', () => {
      const v = startIn.value;
      if (!v) store.updateTask(rec.id, { start: null, end: null });
      else store.updateTask(rec.id, { start: v });
    });

    const startTimeIn = h('input', 'todo-detail__time');
    startTimeIn.type = 'time';
    startTimeIn.setAttribute('aria-label', '시작 시각 (비우면 종일)');
    startTimeIn.addEventListener('change', () => {
      // 빈 값은 '종일'이다. store 가 종료 시각과 상대 알림까지 함께 정리한다.
      store.updateTask(rec.id, { startTime: startTimeIn.value || null });
    });

    const endIn = h('input', 'todo-detail__date');
    endIn.type = 'date';
    endIn.setAttribute('aria-label', '종료 날짜');
    endIn.addEventListener('change', () => {
      const t = rec.task;
      const v = endIn.value;
      if (!t || !t.start) return;
      // 종료가 시작보다 빠르면 막지 않고 시작에 맞춘다 (추가 폼과 같은 규칙)
      store.updateTask(rec.id, { end: v && v >= t.start ? v : t.start });
    });

    const endTimeIn = h('input', 'todo-detail__time');
    endTimeIn.type = 'time';
    endTimeIn.setAttribute('aria-label', '종료 시각');
    endTimeIn.addEventListener('change', () => {
      store.updateTask(rec.id, { endTime: endTimeIn.value || null });
    });

    const prio = h('select', 'todo-detail__select');
    PRIORITY_LABELS.forEach((label, i) => {
      const opt = h('option', null, label);
      opt.value = String(i);
      prio.append(opt);
    });
    prio.addEventListener('change', () => {
      store.updateTask(rec.id, { priority: Number(prio.value) });
    });

    const swatches = h('div', 'todo-swatches');
    const swatchBtns = {};
    for (const key of Object.keys(COLORS)) {
      const b = h('button', 'todo-swatch');
      b.type = 'button';
      b.title = COLOR_NAMES[key] || key;
      b.style.background = COLORS[key];
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        store.updateTask(rec.id, { color: key });
      });
      swatchBtns[key] = b;
      swatches.append(b);
    }

    const tagsIn = h('input', 'todo-detail__tags');
    tagsIn.type = 'text';
    tagsIn.placeholder = '태그 (공백/쉼표 구분)';
    tagsIn.spellcheck = false;
    const commitTags = () => {
      const tags = tagsIn.value
        .split(/[\s,]+/)
        .map((s) => s.replace(/^#/, '').trim())
        .filter(Boolean);
      const cur = rec.task ? rec.task.tags : [];
      if (tags.join('\u0000') !== cur.join('\u0000')) store.updateTask(rec.id, { tags });
    };
    tagsIn.addEventListener('change', commitTags);
    tagsIn.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); tagsIn.blur(); }
    });

    const whenRow = (labelText, dateEl, timeEl) => {
      const r = h('div', 'todo-detail__whenrow');
      r.append(h('span', 'todo-detail__whenkey', labelText), dateEl, timeEl);
      return r;
    };

    // 무엇으로 저장돼 있는지 한 줄로 되읽어 준다 — 추가 폼과 같은 문구를 쓴다
    const whenSummaryEl = h('div', 'todo-detail__whensummary');
    whenSummaryEl.setAttribute('aria-live', 'polite');

    const rowDates = h('div', 'todo-detail__when');
    rowDates.append(
      whenRow('시작', startIn, startTimeIn),
      whenRow('종료', endIn, endTimeIn),
      whenSummaryEl,
    );

    const rowMeta = h('div', 'todo-detail__row');
    rowMeta.append(field('우선순위', prio), field('색', swatches));

    // 관련 링크 — 저장해 두면 항목에 🔗 가 붙고, 클릭하면 브라우저로 열린다
    const linkIn = h('input', 'todo-detail__link');
    linkIn.type = 'text';
    linkIn.placeholder = '관련 링크 (예: meet.google.com/abc)';
    linkIn.spellcheck = false;

    const linkOpen = h('button', 'todo-detail__linkopen', '열기');
    linkOpen.type = 'button';
    linkOpen.addEventListener('click', (e) => {
      e.stopPropagation();
      if (rec.task?.link) openLink(rec.task.link);
    });

    const commitLink = () => {
      const next = normalizeLink(linkIn.value);
      if (next === null) {
        linkIn.classList.add('is-invalid');
        return;
      }
      linkIn.classList.remove('is-invalid');
      if (next !== (rec.task?.link || '')) store.updateTask(rec.id, { link: next });
    };
    linkIn.addEventListener('change', commitLink);
    linkIn.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); linkIn.blur(); }
    });

    const linkRow = h('div', 'todo-detail__linkrow');
    linkRow.append(linkIn, linkOpen);

    // 리마인더 — 바꾸면 '이미 알림' 표시를 지워 새 시각에 다시 알리게 한다
    const remindIn = remindSelect('todo-detail__select');
    remindIn.addEventListener('change', () => {
      store.updateTask(rec.id, { remind: remindIn.value, remindedAt: null });
    });

    // 반복 — 규칙을 바꾸면 이미 기록해 둔 예외/완료 회차는 store 가 정리한다
    const repeatIn = repeatSelect('todo-detail__select');
    const untilIn = h('input', 'todo-detail__date');
    untilIn.type = 'date';
    untilIn.title = '반복 종료일 (비우면 계속)';

    const applyRepeat = () => {
      if (!repeatIn.value) { store.setRepeat(rec.id, null); return; }
      store.setRepeat(rec.id, {
        freq: repeatIn.value,
        interval: 1,
        until: untilIn.value || null,
      });
    };
    repeatIn.addEventListener('change', applyRepeat);
    untilIn.addEventListener('change', applyRepeat);

    const untilField = field('반복 종료', untilIn);

    // D-Day 대시보드 고정 — 이 버튼이 없어서 대시보드를 채울 방법이 아예 없었다
    const pinBtn = h('button', 'todo-detail__pin');
    pinBtn.type = 'button';
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      store.togglePinned(rec.id);
    });

    const dropSeries = h('button', 'todo-detail__series', '반복 전체 삭제');
    dropSeries.type = 'button';
    dropSeries.addEventListener('click', (e) => {
      e.stopPropagation();
      if (store.getState().editingTaskId === rec.id) store.setEditing(null);
      store.removeSeries(rec.id);
    });

    const rowExtra = h('div', 'todo-detail__row');
    rowExtra.append(field('알림', remindIn), field('반복', repeatIn), untilField);

    const rowSeries = h('div', 'todo-detail__row');
    rowSeries.append(pinBtn, dropSeries);

    d.append(notes, rowDates, rowMeta, field('태그', tagsIn), field('링크', linkRow),
             rowExtra, rowSeries);

    rec.detail = { el: d, notes, startIn, endIn, startTimeIn, endTimeIn, whenSummaryEl,
                   prio, swatchBtns, tagsIn, linkIn, linkOpen,
                   remindIn, repeatIn, untilIn, untilField, rowSeries, pinBtn, dropSeries };
    return rec.detail;
  }

  function flushNotes() {
    clearTimeout(notesTimer);
    if (!pendingNotes) return;
    const { id, value } = pendingNotes;
    pendingNotes = null;
    store.updateTask(id, { notes: value });
  }

  function updateDetail(rec, task) {
    const d = rec.detail;
    if (!d) return;
    setValueSafe(d.notes, task.notes || '');
    setValueSafe(d.startIn, task.start || '');
    setValueSafe(d.endIn, task.end || task.start || '');
    setValueSafe(d.startTimeIn, task.startTime || '');
    setValueSafe(d.endTimeIn, task.endTime || '');
    d.endIn.disabled = !task.start;
    // 날짜 없는 '언젠가' 항목에는 시각을 붙일 자리가 없다.
    // 종료 시각은 시작 시각이 있어야 뜻이 생긴다.
    d.startTimeIn.disabled = !task.start;
    d.endTimeIn.disabled = !task.start || !task.startTime;
    d.whenSummaryEl.textContent = task.start
      ? whenSummary({
          start: task.start,
          end: task.end || task.start,
          startTime: task.startTime,
          endTime: task.endTime,
          freq: task.repeat?.freq || '',
        })
      : '날짜 없음 · 언젠가 할 일';
    setValueSafe(d.prio, String(task.priority || 0));
    setValueSafe(d.tagsIn, task.tags.join(' '));
    setValueSafe(d.linkIn, task.link || '');
    d.linkOpen.disabled = !task.link;
    syncRemindOptions(d.remindIn, !!task.startTime);
    setValueSafe(d.remindIn, task.remind || '');
    setValueSafe(d.repeatIn, task.repeat?.freq || '');
    setValueSafe(d.untilIn, task.repeat?.until || '');
    d.untilField.hidden = !task.repeat;
    d.dropSeries.hidden = !task.repeat;
    // 반복 일정은 '남은 기간' 개념이 없어 D-Day 고정 대상이 아니다
    d.pinBtn.hidden = !!task.repeat || !task.end;
    d.pinBtn.textContent = task.pinned ? 'D-Day 고정 해제' : 'D-Day에 고정';
    d.pinBtn.classList.toggle('is-on', !!task.pinned);
    d.pinBtn.setAttribute('aria-pressed', String(!!task.pinned));
    d.rowSeries.hidden = d.pinBtn.hidden && d.dropSeries.hidden;
    // 반복 일정은 당일만 — 종료일 입력을 잠근다
    d.endIn.disabled = !task.start || !!task.repeat;
    for (const key of Object.keys(d.swatchBtns)) {
      d.swatchBtns[key].classList.toggle('is-on', task.color === key);
    }
  }

  // ---------------------------------------------------------- 아이템 갱신
  function updateItem(rec, task, selectedDate) {
    rec.task = task;
    const li = rec.el;

    li.classList.toggle('is-done', task.done);
    li.classList.toggle('is-dragging', dragId === task.id);
    li.classList.toggle('todo-item--p1', task.priority === 1);
    li.classList.toggle('todo-item--p2', task.priority === 2);

    rec.check.classList.toggle('is-on', task.done);
    rec.check.textContent = '';
    if (task.done) rec.check.append(icon('check'));
    rec.dot.style.background = COLORS[task.color] || COLORS.blue;

    // 화면에는 체크 표시 하나뿐이라 '완료 토글' 여덟 개가 똑같이 읽혔다.
    // 어떤 일정인지 이름에 넣어 준다.
    const readable = task.title || '제목 없음';
    rec.check.setAttribute('aria-checked', String(!!task.done));
    rec.check.setAttribute('aria-label', `${readable} 완료`);
    rec.del.setAttribute('aria-label',
      task.repeat && task.occDate ? `${readable} 이 회차 건너뛰기` : `${readable} 삭제`);

    // 시각 — 있으면 제목 앞
    const hasTime = !!task.startTime;
    rec.time.hidden = !hasTime;
    rec.time.textContent = hasTime ? task.startTime : '';
    if (hasTime) {
      rec.time.title = task.endTime ? `${task.startTime}–${task.endTime}` : task.startTime;
    }

    if (rec.titleInput) {
      // 인라인 편집 중이면 제목 텍스트를 건드리지 않는다
    } else if (rec.title.textContent !== task.title) {
      rec.title.textContent = task.title;
    }
    rec.title.title = task.title;

    // 메타(우선순위·태그·D-day) 재구성 — 버튼 포커스 이슈가 없어 통째로 다시 그린다
    const meta = rec.meta;
    meta.textContent = '';
    if (task.priority > 0) {
      const b = h('span', `todo-badge todo-badge--p${task.priority}`, PRIORITY_LABELS[task.priority]);
      meta.append(b);
    }
    for (const tag of task.tags) {
      const c = h('button', 'todo-tag', `#${tag}`);
      c.type = 'button';
      const tagOn = store.getState().filter.tag === tag;
      c.setAttribute('aria-pressed', String(tagOn));
      c.setAttribute('aria-label', tagOn ? `${tag} 태그 필터 끄기` : `${tag} 태그만 보기`);
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = store.getState().filter.tag;
        store.setFilter({ tag: cur === tag ? null : tag });
      });
      meta.append(c);
    }
    // 반복 일정 표시
    if (task.repeat) {
      const rp = h('span', 'todo-repeat');
      rp.append(icon('repeat'));
      const every = task.repeat.interval > 1 ? `${task.repeat.interval}` : '';
      rp.title = `반복: ${every}${store.REPEAT_LABELS[task.repeat.freq] || ''}` +
                 (task.repeat.until ? ` (${task.repeat.until} 까지)` : '');
      meta.append(rp);
    }

    // 알림이 걸린 일정은 종 모양으로 표시 (이미 알린 건 흐리게)
    if (task.remind) {
      const bell = h('span', 'todo-remind');
      bell.append(icon('bell'));
      bell.title = `알림: ${remindLabel(task.remind)}${task.remindedAt ? ' (알림 완료)' : ''}`;
      bell.classList.toggle('is-done', !!task.remindedAt);
      meta.append(bell);
    }

    // 관련 링크 — 클릭하면 기본 브라우저로 열린다
    if (task.link) {
      const lk = h('button', 'todo-link');
      lk.append(icon('link'));
      lk.type = 'button';
      lk.title = `열기: ${linkLabel(task.link)}`;
      lk.addEventListener('click', (e) => {
        e.stopPropagation();   // 항목 상세가 같이 열리지 않도록
        openLink(task.link);
      });
      meta.append(lk);
    }

    if (isSpanTask(task)) {
      const left = diffDays(selectedDate, task.end);
      let label;
      if (left > 0) label = `D-${left}`;
      else if (left === 0) label = 'D-day';
      else label = '종료';
      const dd = h('span', 'todo-dday', label);
      dd.title = `${formatShort(task.start)} ~ ${formatShort(task.end)}`;
      meta.append(dd);
    } else if (!task.start) {
      meta.append(h('span', 'todo-dday todo-dday--none', '날짜 없음'));
    }

    // 상세 영역
    const expanded = store.getState().editingTaskId === task.id;
    li.classList.toggle('is-expanded', expanded);
    if (expanded) {
      if (!rec.detail) buildDetail(rec);
      if (rec.detail.el.parentNode !== li) li.append(rec.detail.el);
      updateDetail(rec, task);
    } else if (rec.detail && rec.detail.el.parentNode) {
      rec.detail.el.remove();
    }
  }

  // ---------------------------------------------------------- 섹션 갱신
  function renderSection(sec, tasks, selectedDate, emptyFactory) {
    sec.ids = tasks.map((t) => t.id);
    sec.count.textContent = String(tasks.length);
    sec.el.classList.toggle('is-collapsed', sec.collapsed);

    // 캐럿(▾)·제목·개수가 span 이라 이름이 자동으로 잡히지 않는다.
    // 무엇을 몇 건 접고 펴는지 직접 적는다.
    sec.toggle.setAttribute('aria-label',
      `${sec.titleEl.textContent} ${tasks.length}건 ${sec.collapsed ? '펼치기' : '접기'}`);

    const els = [];
    if (!sec.collapsed) {
      for (const task of tasks) {
        const rec = getItem(task.id);
        updateItem(rec, task, selectedDate);
        els.push(rec.el);
      }
    }

    // 순서 맞추기 (기존 노드를 이동시켜 재사용 → 포커스/IME 유지)
    const list = sec.list;
    for (let i = 0; i < els.length; i++) {
      const cur = list.children[i];
      if (cur !== els[i]) list.insertBefore(els[i], cur || null);
    }
    while (list.children.length > els.length) list.removeChild(list.lastChild);

    // 빈 상태
    const showEmpty = !sec.collapsed && tasks.length === 0 && typeof emptyFactory === 'function';
    if (showEmpty) {
      if (!sec.emptyEl) {
        sec.emptyEl = emptyFactory();
        sec.wrap.append(sec.emptyEl);
      }
    } else if (sec.emptyEl) {
      sec.emptyEl.remove();
      sec.emptyEl = null;
    }
  }

  // ---------------------------------------------------------- 빈 상태

  function buildDayEmpty() {
    const box = h('div', 'todo-empty');
    box.append(h('div', 'todo-empty__title', '이 날은 아직 비어 있어요'));
    box.append(h('div', 'todo-empty__desc',
      '오른쪽 위 + 를 눌러 일정을 추가하거나, 달력에서 날짜를 옆으로 끌어 기간을 잡아 보세요.'));

    const cta = h('button', 'todo-empty__cta', '＋ 일정 추가');
    cta.type = 'button';
    cta.addEventListener('click', () => compose.open());
    box.append(cta);
    return box;
  }

  function buildSearchEmpty() {
    const box = h('div', 'todo-empty todo-empty--slim');
    box.append(h('div', 'todo-empty__desc', '찾는 일정이 없습니다. 다른 낱말로 찾아보세요.'));
    return box;
  }

  function buildInboxEmpty() {
    const box = h('div', 'todo-empty todo-empty--slim');
    box.append(h('div', 'todo-empty__desc', '날짜를 정하지 않은 일은 여기 모입니다. 항목을 캘린더로 끌어다 놓으면 날짜가 잡혀요.'));
    return box;
  }

  // ---------------------------------------------------------- 미리보기
  function renderPreview() {
    const text = quickInput.value;
    preview.textContent = '';

    if (!text.trim()) {
      // 예전에는 여기에 문법표(! #태그 @내일 ~3d …)를 늘 띄워 뒀는데,
      // 화면에서 가장 눈에 띄는 자리에 '외워야 할 것'이 놓여 있어 진입장벽이 됐다.
      // 문법은 도움말(?)로 옮기고, 평소에는 비워 둔다.
      preview.classList.add('is-hint');
      return;
    }

    preview.classList.remove('is-hint');
    const st = store.getState();
    const parsed = parseQuickInput(text, todayKey());
    const { start, end } = resolveRange(parsed, st.selectedDate);

    const add = (cls, label, value, colorHex) => {
      const chip = h('span', `todo-chip ${cls}`);
      if (colorHex) {
        const dot = h('span', 'todo-chip__dot');
        dot.style.background = colorHex;
        chip.append(dot);
      }
      if (label) chip.append(h('em', 'todo-chip__label', label));
      chip.append(h('span', 'todo-chip__value', value));
      preview.append(chip);
    };

    if (parsed.title) add('todo-chip--title', '제목', parsed.title);
    else add('todo-chip--warn', '', '제목이 비었습니다');

    if (start) {
      const isDefault = !parsed.start;
      add('todo-chip--date', isDefault ? '시작(선택한 날)' : '시작', formatShort(start));
    }
    if (end && start && end > start) {
      add('todo-chip--date', '종료', `${formatShort(end)} · ${diffDays(start, end) + 1}일간`);
    }
    if (parsed.startTime) {
      add('todo-chip--date', '시각',
        parsed.endTime ? `${parsed.startTime}–${parsed.endTime}` : parsed.startTime);
    }
    if (parsed.priority > 0) add(`todo-chip--p${parsed.priority}`, '', PRIORITY_LABELS[parsed.priority]);
    for (const tag of parsed.tags) add('todo-chip--tag', '', `#${tag}`);
    if (parsed.color) add('todo-chip--color', '', COLOR_NAMES[parsed.color], COLORS[parsed.color]);
    for (const u of parsed.unknown) add('todo-chip--warn', '해석 못 함', u);
  }

  // ---------------------------------------------------------- 헤더 렌더
  function dayStats(st, key) {
    let total = 0;
    let done = 0;
    for (const t of st.tasks) {
      if (!t.start) continue;
      if (key >= t.start && key <= (t.end || t.start)) {
        total += 1;
        if (t.done) done += 1;
      }
    }
    return { total, done };
  }

  function renderHeader(st) {
    const key = st.selectedDate;
    const isToday = key === todayKey();
    dateLabel.textContent = formatDateLabel(key);
    todayBadge.hidden = !isToday;
    goTodayBtn.hidden = isToday;

    const { total, done } = dayStats(st, key);
    progressText.textContent = `${done}/${total}`;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    progressFill.style.width = `${pct}%`;
    progressBar.classList.toggle('is-full', total > 0 && done === total);

    setValueSafe(searchInput, st.filter.text || '');
    searchInput.classList.toggle('is-on', !!st.filter.text);

    const showCompleted = st.settings.showCompleted;
    completedBtn.textContent = showCompleted ? '완료 표시' : '완료 숨김';
    completedBtn.classList.toggle('is-on', !showCompleted);
    // 눌린 상태 = 숨김. 글자만으로는 스크린리더에 상태가 전달되지 않는다.
    completedBtn.setAttribute('aria-pressed', String(!showCompleted));
    completedBtn.setAttribute('aria-label',
      showCompleted ? '완료 항목 숨기기' : '완료 항목 보이기');

    // 태그 칩 — 내용이 바뀔 때만 다시 그린다
    const tags = store.allTags();
    const sig = `${st.filter.tag || ''}|${tags.join(',')}`;
    if (sig !== lastTagSignature) {
      lastTagSignature = sig;
      tagBar.textContent = '';
      tagBar.hidden = tags.length === 0;
      for (const tag of tags) {
        const chip = h('button', 'todo-tagchip', `#${tag}`);
        chip.type = 'button';
        const on = st.filter.tag === tag;
        chip.classList.toggle('is-on', on);
        chip.setAttribute('aria-pressed', String(on));
        chip.setAttribute('aria-label', on ? `${tag} 태그 필터 끄기` : `${tag} 태그만 보기`);
        chip.addEventListener('click', () => {
          const cur = store.getState().filter.tag;
          store.setFilter({ tag: cur === tag ? null : tag });
        });
        tagBar.append(chip);
      }
    }
  }

  // ---------------------------------------------------------- 키보드 조작
  //
  // 캘린더는 화살표로 움직이는데 오른쪽 목록은 마우스 전용이었다.
  // 캘린더의 키 처리는 캘린더 root 에 걸려 있으므로 서로 가로채지 않는다.

  let focusedId = null;

  function visibleItems() {
    return Array.from(el.querySelectorAll('.todo-item'));
  }

  function focusItem(li) {
    if (!li) return;
    focusedId = li.dataset.id;
    for (const other of visibleItems()) other.tabIndex = other === li ? 0 : -1;
    li.focus();
  }

  /** Tab 으로 들어올 항목 하나를 정해 둔다 (없으면 첫 항목) */
  function syncRovingTabindex() {
    const items = visibleItems();
    if (!items.length) return;
    const active = items.find((li) => li.dataset.id === focusedId) || items[0];
    for (const li of items) li.tabIndex = li === active ? 0 : -1;
  }

  el.addEventListener('focusin', (e) => {
    const li = e.target.closest?.('.todo-item');
    if (li) focusedId = li.dataset.id;
  });

  el.addEventListener('keydown', (e) => {
    if (isFormControl(e.target)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    const items = visibleItems();
    if (!items.length) return;

    const cur = e.target.closest?.('.todo-item');
    const index = cur ? items.indexOf(cur) : -1;

    // --- 이동
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      let next;
      if (e.key === 'Home') next = items[0];
      else if (e.key === 'End') next = items[items.length - 1];
      else if (index < 0) next = items[0];
      else if (e.key === 'ArrowDown') next = items[Math.min(items.length - 1, index + 1)];
      else next = items[Math.max(0, index - 1)];
      focusItem(next);
      return;
    }

    if (!cur) return;
    const task = itemCache.get(cur.dataset.id)?.task;
    if (!task) return;

    // --- 동작
    if (e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      store.toggleDone(task.id, task.occDate);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const editing = store.getState().editingTaskId;
      store.setEditing(editing === task.id ? null : task.id);
      return;
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      e.stopPropagation();
      // 지운 뒤 포커스가 허공에 남지 않도록 다음 항목으로 미리 옮겨 둔다
      const fallback = items[index + 1] || items[index - 1];
      focusedId = fallback ? fallback.dataset.id : null;
      if (store.getState().editingTaskId === task.id) store.setEditing(null);
      store.removeTask(task.id, task.occDate);
      notify(task.repeat && task.occDate ? '이 회차를 건너뜁니다' : '일정을 삭제했습니다');
    }
  });

  // ---------------------------------------------------------- 전체 렌더
  function render() {
    // 캘린더에서 날짜를 끌어 놓으면 그 기간으로 추가 폼을 연다.
    // 모듈끼리 직접 부르지 않고 store 의 요청 큐를 거친다.
    const req = store.getState().composeRequest;
    if (req) {
      store.consumeCompose();
      compose.open(req);
    }

    if (destroyed) return;
    const st = store.getState();
    const key = st.selectedDate;

    renderHeader(st);

    // 검색 중에는 고른 날짜를 무시하고 전체에서 찾는다.
    // 예전에는 '그날 목록 안에서만' 걸러서, 다른 달의 일정은 검색해도 안 나왔다.
    const searching = !!st.filter.text.trim();
    const searchResults = searching ? store.searchTasks(st.filter.text) : [];

    const onDate = searching ? [] : store.tasksOnDate(key);
    const spanTasks = onDate.filter(isSpanTask);
    const dayTasks = onDate.filter((t) => !isSpanTask(t));
    const inboxTasks = searching ? [] : store.inboxTasks();

    // 밀린 일은 고른 날짜와 무관하다. 오늘 이전에 끝났어야 하는데 안 끝난 것 전부.
    // 단, 이미 그날 목록에 보이는 항목은 두 번 나오지 않게 뺀다.
    const shown = new Set(onDate.map((t) => t.id));
    const overdue = searching
      ? []
      : store.overdueTasks().filter((t) => !shown.has(t.id));

    sections.search.el.hidden = !searching;
    sections.day.el.hidden = searching;
    sections.inbox.el.hidden = searching;
    sections.overdue.el.hidden = searching || overdue.length === 0;
    sections.overdue.titleEl.textContent =
      overdue.length ? `지난 일 · 아직 안 끝났어요` : '지난 일';
    if (searching) {
      sections.search.titleEl.textContent = `'${st.filter.text.trim()}' 검색 결과`;
    }

    // 캘린더에서 막대를 클릭했는데 위 세 목록에 없는 항목이면 따로 띄워 준다
    const editingId = st.editingTaskId;
    let focusTasks = [];
    if (editingId) {
      const visible = onDate.some((t) => t.id === editingId) || inboxTasks.some((t) => t.id === editingId);
      if (!visible) {
        const t = st.tasks.find((x) => x.id === editingId);
        if (t) focusTasks = [t];
      }
    }

    sections.focus.el.hidden = searching || focusTasks.length === 0;
    sections.day.titleEl.textContent = key === todayKey() ? '오늘 할 일' : `${formatDateLabel(key)} 할 일`;
    sections.span.el.hidden = searching || spanTasks.length === 0;

    renderSection(sections.search, searchResults, key, searching ? buildSearchEmpty : null);
    renderSection(sections.overdue, overdue, key, null);
    renderSection(sections.focus, focusTasks, key, null);
    renderSection(sections.day, dayTasks, key, buildDayEmpty);
    renderSection(sections.span, spanTasks, key, null);
    renderSection(sections.inbox, inboxTasks, key, buildInboxEmpty);

    // 캐시 정리 — DOM 에서 빠진 아이템 레코드 제거
    for (const [id, rec] of itemCache) {
      if (!rec.el.parentNode) itemCache.delete(id);
    }

    // editingTaskId 가 외부(캘린더)에서 바뀌었으면 해당 항목으로 스크롤
    if (editingId && editingId !== lastEditingId) {
      const rec = itemCache.get(editingId);
      if (rec && rec.el.parentNode) {
        rec.el.scrollIntoView({ block: 'nearest' });
      }
    }
    lastEditingId = editingId;

    syncRovingTabindex();
    renderPreview();
  }

  function scheduleRender() {
    if (destroyed || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render();
    });
  }

  // ---------------------------------------------------------- 이벤트 연결
  goTodayBtn.addEventListener('click', () => store.selectDate(todayKey()));

  completedBtn.addEventListener('click', () => {
    store.setSetting('showCompleted', !store.getState().settings.showCompleted);
  });

  searchInput.addEventListener('input', () => {
    store.setFilter({ text: searchInput.value });
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      searchInput.value = '';
      store.setFilter({ text: '' });
    }
  });

  quickInput.addEventListener('input', renderPreview);
  quickInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      quickInput.value = '';
      renderPreview();
      return;
    }
    if (e.key !== 'Enter') return;
    if (e.isComposing || e.keyCode === 229) return;   // 한글 조합 중 Enter 는 확정용
    e.preventDefault();
    submitQuick();
  });

  function submitQuick() {
    const st = store.getState();
    const parsed = parseQuickInput(quickInput.value, todayKey());
    if (!parsed.title) return;

    const { start, end } = resolveRange(parsed, st.selectedDate);
    const patch = {
      title: parsed.title,
      tags: parsed.tags,
      priority: parsed.priority,
    };
    if (parsed.color) patch.color = parsed.color;
    // start 를 넘기지 않으면 store 가 selectedDate 를 넣는다
    if (parsed.start) patch.start = parsed.start;
    if (end && start) patch.end = end;
    if (parsed.startTime) patch.startTime = parsed.startTime;
    if (parsed.endTime) patch.endTime = parsed.endTime;

    store.addTask(patch);
    quickInput.value = '';
    quickInput.focus();
    renderPreview();
  }

  const unsubscribe = store.subscribe(scheduleRender);

  render();

  // ---------------------------------------------------------- 정리
  return {
    destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      clearTimeout(notesTimer);
      pendingNotes = null;
      unsubscribe();
      itemCache.clear();
      root.textContent = '';
    },
  };
}
