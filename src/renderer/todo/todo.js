// 투두 패널 — 캘린더에서 고른 날짜(state.selectedDate)와 연동되는 할 일 목록.
// 계약: export function createTodoPanel({ root, store }) -> { destroy() }
// 외부 라이브러리 없음. 순수 ES 모듈 + DOM API. 사용자 입력은 항상 textContent 로만 넣는다.

import { todayKey, toKey, fromKey, addDays, diffDays, WEEKDAY_LABELS } from '../lib/date.js';
import { remindLabel } from '../reminders.js';
import { icon } from '../lib/icons.js';

/** 리마인더 프리셋. 값은 store 의 '<며칠 전>@<HH:mm>' 형식. */
const REMIND_PRESETS = [
  ['',        '알림 없음'],
  ['0@09:00', '당일 오전 9시'],
  ['0@12:00', '당일 정오'],
  ['0@18:00', '당일 오후 6시'],
  ['1@18:00', '하루 전 오후 6시'],
  ['3@18:00', '3일 전 오후 6시'],
  ['7@18:00', '일주일 전 오후 6시'],
];

function remindSelect(cls) {
  const sel = document.createElement('select');
  sel.className = cls;
  for (const [value, label] of REMIND_PRESETS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sel.append(opt);
  }
  return sel;
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
 * 빠른 입력 문자열을 태스크 조각으로 파싱한다. 순수 함수.
 * @param {string} text
 * @param {string} [baseKey] 상대 날짜 기준일 (기본: 오늘)
 * @returns {{title:string, start:string|null, end:string|null, endDays:number|null,
 *            tags:string[], priority:number, color:string|null, unknown:string[]}}
 */
export function parseQuickInput(text, baseKey = todayKey()) {
  const out = {
    title: '',
    start: null,
    end: null,
    endDays: null,   // ~3d 처럼 '시작일 + N일' 로 들어온 경우 N (미리보기에서 안내)
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
  goTodayBtn.title = '오늘 날짜로 이동';
  const progressText = h('span', 'todo-progress__text', '0/0');
  const addBtn = h('button', 'todo-add');
  addBtn.append(icon('plus'));
  addBtn.type = 'button';
  addBtn.title = '일정 추가';
  dateRow.append(dateLabel, todayBadge, goTodayBtn, progressText, addBtn);

  const progressBar = h('div', 'todo-progress');
  const progressFill = h('div', 'todo-progress__fill');
  progressBar.append(progressFill);

  const filterRow = h('div', 'todo-filters');
  const searchInput = h('input', 'todo-search');
  searchInput.type = 'text';
  searchInput.placeholder = '검색';
  searchInput.spellcheck = false;
  const completedBtn = h('button', 'todo-toggle', '완료 표시');
  completedBtn.type = 'button';
  completedBtn.title = '완료 항목 표시/숨김';
  filterRow.append(searchInput, completedBtn);

  const tagBar = h('div', 'todo-tagbar');

  header.append(dateRow, progressBar, filterRow, tagBar);

  // 빠른 입력 --------------------------------------------------
  const quick = h('div', 'todo-quick');
  const quickInput = h('input', 'todo-quick__input');
  quickInput.type = 'text';
  quickInput.placeholder = '할 일 입력 후 Enter  (예: 장보기 @내일 #집안일 !)';
  quickInput.spellcheck = false;
  const preview = h('div', 'todo-preview');
  quick.append(quickInput, preview);

  // 목록 -------------------------------------------------------
  const body = h('div', 'todo-body');

  const sections = {
    focus: makeSection('focus', '선택한 항목'),
    day: makeSection('day', '오늘 할 일'),
    span: makeSection('span', '진행 중인 장기 계획'),
    inbox: makeSection('inbox', '언젠가'),
  };
  sections.inbox.collapsed = false;
  body.append(sections.focus.el, sections.day.el, sections.span.el, sections.inbox.el);

  // 일정 추가 폼 -----------------------------------------------
  // 빠른 입력이 문법을 외워야 하는 반면, 이쪽은 클릭만으로 전부 지정할 수 있는 경로다.
  const compose = buildCompose();

  el.append(header, quick, compose.el, body);
  root.append(el);

  addBtn.addEventListener('click', () => {
    if (compose.el.hidden) compose.open();
    else compose.close();
  });

  /** 날짜·기간·링크까지 한 번에 지정하는 추가 폼 */
  function buildCompose() {
    const form = h('form', 'todo-compose');
    form.hidden = true;

    const titleIn = h('input', 'todo-compose__title');
    titleIn.type = 'text';
    titleIn.placeholder = '일정 이름';
    titleIn.required = true;
    titleIn.spellcheck = false;

    // 날짜 — 타이핑과 달력 선택이 모두 되는 네이티브 date 입력
    const startIn = h('input', 'todo-compose__date');
    startIn.type = 'date';

    const endIn = h('input', 'todo-compose__date');
    endIn.type = 'date';

    // 기간 토글: 껐을 때는 당일 일정, 켜면 종료일이 나타나 캘린더에 막대로 표시된다
    const spanWrap = h('label', 'todo-compose__span');
    const spanChk = h('input', 'todo-compose__chk');
    spanChk.type = 'checkbox';
    spanWrap.append(spanChk, h('span', null, '기간으로 설정'));

    const endField = field('종료', endIn);
    endField.hidden = true;

    spanChk.addEventListener('change', () => {
      endField.hidden = !spanChk.checked;
      if (spanChk.checked) {
        if (!endIn.value || endIn.value < startIn.value) endIn.value = startIn.value;
        endIn.focus();
      }
    });

    // 시작일을 뒤로 밀면 종료일도 같이 따라간다 (기간이 뒤집히는 걸 막는다)
    startIn.addEventListener('change', () => {
      if (spanChk.checked && endIn.value && endIn.value < startIn.value) {
        endIn.value = startIn.value;
      }
    });

    const linkIn = h('input', 'todo-compose__link');
    linkIn.type = 'text';
    linkIn.placeholder = '관련 링크 (예: meet.google.com/abc)';
    linkIn.spellcheck = false;

    const tagsIn = h('input', 'todo-compose__tags');
    tagsIn.type = 'text';
    tagsIn.placeholder = '태그 (공백/쉼표 구분)';
    tagsIn.spellcheck = false;

    const prio = h('select', 'todo-detail__select');
    PRIORITY_LABELS.forEach((label, i) => {
      const opt = h('option', null, label);
      opt.value = String(i);
      prio.append(opt);
    });

    let pickedColor = 'blue';
    const swatches = h('div', 'todo-swatches');
    const swatchBtns = {};
    for (const key of Object.keys(COLORS)) {
      const b = h('button', 'todo-swatch');
      b.type = 'button';
      b.title = COLOR_NAMES[key] || key;
      b.style.background = COLORS[key];
      b.addEventListener('click', () => {
        pickedColor = key;
        for (const k of Object.keys(swatchBtns)) {
          swatchBtns[k].classList.toggle('is-picked', k === key);
        }
      });
      swatchBtns[key] = b;
      swatches.append(b);
    }

    const err = h('div', 'todo-compose__err');
    err.hidden = true;

    const saveBtn = h('button', 'todo-compose__save', '추가');
    saveBtn.type = 'submit';
    const cancelBtn = h('button', 'todo-compose__cancel', '취소');
    cancelBtn.type = 'button';

    const actions = h('div', 'todo-compose__actions');
    actions.append(err, cancelBtn, saveBtn);

    const rowDates = h('div', 'todo-compose__row');
    rowDates.append(field('시작', startIn), endField, spanWrap);

    const remindIn = remindSelect('todo-detail__select');

    const rowMeta = h('div', 'todo-compose__row');
    rowMeta.append(field('우선순위', prio), field('색', swatches), field('알림', remindIn));

    form.append(titleIn, rowDates, linkIn, tagsIn, rowMeta, actions);

    cancelBtn.addEventListener('click', () => close());

    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });

    /** @param {{start:string,end:string}} [preset] 캘린더에서 끌어 만든 기간 */
    function open(preset) {
      const sel = store.getState().selectedDate;
      const start = preset?.start || sel;
      const end = preset?.end || start;
      titleIn.value = '';
      startIn.value = start;
      endIn.value = end;
      linkIn.value = '';
      tagsIn.value = '';
      prio.value = '0';
      remindIn.value = '';
      // 끌어서 만든 기간이면 기간 모드로 열어 종료일을 바로 보여 준다
      spanChk.checked = end > start;
      endField.hidden = !spanChk.checked;
      err.hidden = true;
      pickedColor = 'blue';
      for (const k of Object.keys(swatchBtns)) {
        swatchBtns[k].classList.toggle('is-picked', k === 'blue');
      }
      form.hidden = false;
      addBtn.classList.add('is-open');
      titleIn.focus();
    }

    function close() {
      form.hidden = true;
      addBtn.classList.remove('is-open');
    }

    function fail(message) {
      err.textContent = message;
      err.hidden = false;
    }

    function submit() {
      const title = titleIn.value.trim();
      if (!title) { fail('일정 이름을 입력하세요.'); titleIn.focus(); return; }

      const start = startIn.value || store.getState().selectedDate;
      // 기간을 켜지 않았으면 종료일 = 시작일 → 당일 일정
      const end = spanChk.checked && endIn.value ? endIn.value : start;
      if (end < start) { fail('종료일이 시작일보다 빠릅니다.'); endIn.focus(); return; }

      const link = normalizeLink(linkIn.value);
      if (link === null) { fail('링크 주소를 확인하세요.'); linkIn.focus(); return; }

      store.addTask({
        title,
        start,
        end,
        link,
        color: pickedColor,
        priority: Number(prio.value) || 0,
        remind: remindIn.value,
        tags: tagsIn.value.split(/[\s,]+/).map((s) => s.replace(/^#/, '').trim()).filter(Boolean),
      });

      close();
    }

    return { el: form, open, close };
  }

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

    const head = h('div', 'todo-section__head');
    const caret = h('span', 'todo-section__caret', '▾');
    const titleEl = h('span', 'todo-section__title', title);
    const count = h('span', 'todo-section__count', '0');
    head.append(caret, titleEl, count);

    const wrap = h('div', 'todo-list-wrap');
    const list = h('ul', 'todo-list');
    const dropline = h('div', 'todo-dropline');
    wrap.append(list, dropline);

    secEl.append(head, wrap);

    const sec = { key, el: secEl, head, list, wrap, dropline, count, titleEl, ids: [], collapsed: false, emptyEl: null };

    head.addEventListener('click', () => {
      sec.collapsed = !sec.collapsed;
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

    const row = h('div', 'todo-item__row');

    const check = h('button', 'todo-check');
    check.type = 'button';
    check.title = '완료 토글';

    const dot = h('span', 'todo-dot');
    const title = h('span', 'todo-title');
    const meta = h('span', 'todo-meta');           // 우선순위 뱃지 + 태그 + D-day
    const del = h('button', 'todo-del');
    del.append(icon('close'));
    del.type = 'button';
    del.title = '삭제';

    row.append(check, dot, title, meta, del);
    li.append(row);

    const rec = { id: taskId, el: li, row, check, dot, title, meta, del, detail: null, task: null };

    // 완료 토글
    check.addEventListener('click', (e) => {
      e.stopPropagation();
      store.toggleDone(taskId);
    });

    // 삭제
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (store.getState().editingTaskId === taskId) store.setEditing(null);
      store.removeTask(taskId);
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

    const startIn = h('input', 'todo-detail__date');
    startIn.type = 'date';
    startIn.addEventListener('change', () => {
      const v = startIn.value;
      if (!v) store.updateTask(rec.id, { start: null, end: null });
      else store.updateTask(rec.id, { start: v });
    });

    const endIn = h('input', 'todo-detail__date');
    endIn.type = 'date';
    endIn.addEventListener('change', () => {
      const t = rec.task;
      const v = endIn.value;
      if (!t || !t.start) return;
      store.updateTask(rec.id, { end: v && v >= t.start ? v : t.start });
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

    const rowDates = h('div', 'todo-detail__row');
    rowDates.append(field('시작', startIn), field('종료', endIn));

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

    const rowExtra = h('div', 'todo-detail__row');
    rowExtra.append(field('알림', remindIn));

    d.append(notes, rowDates, rowMeta, field('태그', tagsIn), field('링크', linkRow), rowExtra);

    rec.detail = { el: d, notes, startIn, endIn, prio, swatchBtns, tagsIn, linkIn, linkOpen, remindIn };
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
    d.endIn.disabled = !task.start;
    setValueSafe(d.prio, String(task.priority || 0));
    setValueSafe(d.tagsIn, task.tags.join(' '));
    setValueSafe(d.linkIn, task.link || '');
    d.linkOpen.disabled = !task.link;
    setValueSafe(d.remindIn, task.remind || '');
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
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = store.getState().filter.tag;
        store.setFilter({ tag: cur === tag ? null : tag });
      });
      meta.append(c);
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
  function exampleLine(text, desc) {
    const line = h('button', 'todo-example');
    line.type = 'button';
    line.append(h('code', 'todo-example__code', text), h('span', 'todo-example__desc', desc));
    line.addEventListener('click', () => {
      quickInput.value = text;
      quickInput.focus();
      renderPreview();
    });
    return line;
  }

  function buildDayEmpty() {
    const box = h('div', 'todo-empty');
    box.append(h('div', 'todo-empty__title', '이 날은 아직 비어 있어요'));
    box.append(h('div', 'todo-empty__desc', '위 입력창에 한 줄 적고 Enter. 아래 예시를 눌러 문법을 볼 수 있어요.'));
    box.append(exampleLine('장보기 @내일 #집안일 !', '내일 · 태그 · 중요'));
    box.append(exampleLine('기획서 마감 @8/15 ~3d *빨강', '8월 15일부터 3일간 · 빨강'));
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
      preview.classList.add('is-hint');
      const hint = h('div', 'todo-preview__hint');
      const parts = [
        ['!', '중요'], ['!!', '긴급'], ['#태그', '태그'], ['@내일', '시작일'],
        ['~3d', '기간'], ['*파랑', '색'],
      ];
      for (const [code, desc] of parts) {
        const chip = h('span', 'todo-preview__syntax');
        chip.append(h('code', null, code), h('em', null, desc));
        hint.append(chip);
      }
      preview.append(hint);
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
        chip.classList.toggle('is-on', st.filter.tag === tag);
        chip.addEventListener('click', () => {
          const cur = store.getState().filter.tag;
          store.setFilter({ tag: cur === tag ? null : tag });
        });
        tagBar.append(chip);
      }
    }
  }

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

    const onDate = store.tasksOnDate(key);
    const spanTasks = onDate.filter(isSpanTask);
    const dayTasks = onDate.filter((t) => !isSpanTask(t));
    const inboxTasks = store.inboxTasks();

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

    sections.focus.el.hidden = focusTasks.length === 0;
    sections.day.titleEl.textContent = key === todayKey() ? '오늘 할 일' : `${formatDateLabel(key)} 할 일`;
    sections.span.el.hidden = spanTasks.length === 0;

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
