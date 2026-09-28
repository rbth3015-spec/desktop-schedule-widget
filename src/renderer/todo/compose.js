// 일정 추가 · 루틴 추가 화면 (핸드오프 '일정 추가' · '루틴').
//
// 빠른 입력(@내일 ~3d #태그)은 익힌 사람에게는 빠르지만, 처음 쓰는 사람에게는
// 외워야 할 문법이다. 이 화면은 문법을 전혀 몰라도 **누르기만 해서** 일정을 만들 수 있는
// 기본 경로다. 모든 선택지가 눈에 보이는 것이 핵심 — 숨은 규칙이 없어야 한다.
//
// 날짜는 '여러 날에 걸쳐' 토글로 모드를 나누지 않는다. 시작과 종료를 늘 나란히 두고,
// 둘이 같으면 그게 하루짜리다. 대신 '무엇이 만들어지는지' 한 줄로 되읽어 준다.
// 이 한 줄이 있으면 설명 문구를 따로 달 필요가 없다 — 화면이 스스로 설명한다.
//
// 루틴은 같은 화면의 다른 모드다. 약속용 칸(날짜 · 기간 · 중요도 · 링크)을 걷어내고
// 주기 · 요일 · 시각만 남긴다. 루틴은 '언제 하루' 가 아니라 '얼마마다' 가 전부다.
// 어느 쪽으로 여는지는 날짜 머리의 두 단추(＋ 루틴 · ＋ 일정 추가)가 정한다 —
// 이 화면 안에서 모드를 바꾸지 않는다. 날짜 없이 적을 일만 '언제' 줄의 '언젠가' 로 고른다.

import { todayKey, addDays, diffDays, fromKey, WEEKDAY_LABELS, timeMinutes } from '../lib/date.js';
import { icon } from '../lib/icons.js';
import { remindLabel } from '../reminders.js';
import { showContextMenu } from '../lib/menu.js';
import { parseQuickInput, resolveRange } from './parse.js';
import {
  h, monthDay, screenHead, fieldLabel, dateField, timeField, normalizeLink,
} from './ui.js';

/**
 * 하나만 고르는 칩 묶음. select 보다 선택지가 한눈에 보인다.
 * @param {Array<[string,string,string?]>} options [값, 글자, 툴팁]
 * @param {string} cls 칩 크기 — 시안은 자리마다 칩 여백이 다르다
 */
function chipGroup(options, initial, onChange, cls = '') {
  const el = h('div', 'scr-chips');
  let value = initial;
  const buttons = new Map();

  for (const [val, label, hint] of options) {
    const b = h('button', `scr-chip ${cls}`.trim(), label);
    b.type = 'button';
    if (hint) b.title = hint;
    b.addEventListener('click', () => {
      set(val);
      onChange?.(val);
    });
    buttons.set(val, b);
    el.append(b);
  }

  function set(v) {
    value = v;
    for (const [val, b] of buttons) {
      b.classList.toggle('is-on', val === v);
      b.setAttribute('aria-pressed', String(val === v));
    }
  }
  set(initial);

  return { el, get: () => value, set, button: (v) => buttons.get(v) || null };
}

/** '8월 20일 (목)' */
function pretty(key) {
  if (!key) return '';
  const d = fromKey(key);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY_LABELS[d.getDay()]})`;
}

const REPEAT_LABEL_MAP = {
  daily: '매일', alternate: '격일', weekdays: '평일', weekends: '주말',
  weekly: '매주', monthly: '매월', yearly: '매년',
};

/**
 * 만들어질 일정을 사람 말로 한 줄 되읽어 준다.
 * 이 줄이 폼 아래에 늘 있으면 '시작=종료면 하루' 같은 규칙을 따로 설명할 필요가 없다.
 */
export function whenSummary({ start, end, startTime, endTime, freq, dailyCheck }) {
  if (!start) return '';

  const repeatPart = freq ? `${REPEAT_LABEL_MAP[freq] || ''} 반복 · ` : '';

  // 여러 날에 걸친 일정
  if (!freq && end && end > start) {
    const days = diffDays(start, end) + 1;
    const time = startTime ? ` · ${startTime} 시작` : '';
    const check = dailyCheck ? ' · 날마다 체크' : '';
    return `${pretty(start)} → ${pretty(end)} · ${days}일간${time}${check}`;
  }

  // 하루짜리
  if (!startTime) return `${repeatPart}${pretty(start)} · 하루 종일`;
  if (endTime) return `${repeatPart}${pretty(start)} · ${startTime}–${endTime}`;
  return `${repeatPart}${pretty(start)} · ${startTime}`;
}

/** 다가오는 토요일 (오늘이 토요일이면 오늘) */
function nextWeekend(base) {
  const day = fromKey(base).getDay();
  return addDays(base, (6 - day + 7) % 7);
}

/** 다음 주 월요일 */
function nextMonday(base) {
  const day = fromKey(base).getDay();
  return addDays(base, ((1 - day + 7) % 7) || 7);
}

/** 분 → 'HH:MM' (자정을 넘기면 23:59 에서 멈춘다 — 종료가 시작보다 앞서면 안 된다) */
function hhmm(m) {
  const t = Math.min(Math.max(0, m), 1439);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** 분 → '1시간 30분' */
function durLabel(m) {
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  if (!hh) return `${mm}분`;
  return mm ? `${hh}시간 ${mm}분` : `${hh}시간`;
}

// '평일'·'주말'·'격일' 은 새 반복 규칙이 아니라 이름이다(store.repeatFreqDays).
// 운동·약 먹기 같은 습관은 대부분 매일 · 평일 · 주말이라 요일을 다섯 번 누르게 두지 않는다.
const REPEAT_OPTIONS = [
  ['', '안 함'], ['daily', '매일'],
  ['weekdays', '평일', '월 · 화 · 수 · 목 · 금'],
  ['weekends', '주말', '토 · 일'],
  ['weekly', '매주'], ['alternate', '격일', '이틀마다'],
  ['monthly', '매월'], ['yearly', '매년'],
];

// '-Nm' 은 시작 시각 N분 전. 시각을 넣은 일정에서만 보인다.
const REMIND_OPTIONS = [
  ['', '없음'],
  ['-10m', '10분 전'],
  ['-30m', '30분 전'],
  ['-60m', '1시간 전'],
  ['0@09:00', '당일 아침'],
  ['0@18:00', '당일 저녁'],
  ['1@18:00', '하루 전'],
  ['7@18:00', '일주일 전'],
];

// 루틴의 요일 칸은 시안대로 월요일부터 적는다. 값은 Date.getDay() 기준(0=일).
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

// 루틴 길이 — 시각을 넣었을 때 시간띠에 그릴 네모의 길이
const ROUTINE_LENGTHS = [30, 60, 90, 120];

/**
 * @param {{store: object, onToggle?: (open: boolean) => void}} deps
 * @returns {{el:HTMLElement, open:(preset?:object)=>void, close:()=>void, isOpen:()=>boolean}}
 */
export function createCompose({ store, onToggle }) {
  /** 폼이 열리거나 닫힐 때마다 알린다.
   *  안에서 닫는 길이 여럿(취소·Esc·제출)이라, 바깥이 상태를 따라오려면 통보가 필요하다. */
  const notifyToggle = () => onToggle?.(!form.hidden);
  const form = h('form', 'cmp scr');
  form.hidden = true;
  form.noValidate = true;

  let routineMode = false;
  let somedayMode = false;

  const head = screenHead('일정 추가', () => close());

  // ---------------------------------------------------------------- 제목
  const titleIn = h('input', 'scr-titlein');
  titleIn.type = 'text';
  titleIn.spellcheck = false;
  titleIn.setAttribute('aria-label', '이름');

  // 제목칸이 한 줄 문법을 그대로 알아듣는다.
  //
  // 전용 입력칸을 없애면서 문법까지 버릴 이유는 없다. 다만 '문법이 남아 있다'와
  // '문법을 외워야 한다'는 다르므로, **띄어쓰기로 토큰이 끝나는 순간 그 토큰을
  // 제목에서 걷어내고 해당 칸으로 옮긴다.** 옮긴 것은 제목 아래 칩으로 남는다 —
  // '@내일 → 9/4' 처럼 무엇을 어떻게 알아들었는지 그대로 보인다.
  const tokens = h('div', 'cmp-tokens');
  const tokenList = h('span', 'cmp-tokens__list');
  tokenList.setAttribute('aria-live', 'polite');
  // 문법은 설명하지 않는다 — 자리표시자의 예시가 보여 주고, 치면 칩으로 옮겨 가는 것이 가르친다.
  tokens.append(tokenList);

  const titleBox = h('div');
  titleBox.append(titleIn, tokens);

  /**
   * 완결된 토큰만 걷어낸다. 마지막 낱말은 아직 타이핑 중일 수 있으므로 건드리지 않는다
   * (한글 조합 중에 글자를 빼앗기면 입력이 망가진다).
   */
  function consumeTokens() {
    const raw = titleIn.value;
    if (!/\s$/.test(raw)) return;          // 띄어쓰기로 끝날 때만 = 토큰이 확정된 순간
    const parsed = parseQuickInput(raw, todayKey());

    // 제목에 남은 낱말을 빼면 걷어낸 토큰이 남는다 — 칩에 원문 그대로 적는다
    const left = parsed.title.split(/\s+/).filter(Boolean);
    const consumed = [];
    for (const word of raw.trim().split(/\s+/)) {
      const i = left.indexOf(word);
      if (i >= 0) left.splice(i, 1);
      else consumed.push(word);
    }

    let moved = false;
    if (!routineMode && (parsed.start || parsed.end || parsed.endDays != null)) {
      setSomeday(false);
      const { start, end } = resolveRange(parsed, startField.get() || todayKey());
      if (start) { setStart(start); dayChips.set(null); }
      if (end && start) { endField.set(end); }
      moved = true;
    }
    if (parsed.startTime) {
      if (!routineMode) setSomeday(false);
      if (routineMode) {
        routineTime.set(parsed.startTime);
        paintRoutineTime();
      } else {
        startTime.set(parsed.startTime);
        if (parsed.endTime) endTime.set(parsed.endTime);
      }
      moved = true;
    }
    if (parsed.priority > 0 && !routineMode) { prio.set(String(parsed.priority)); moved = true; }
    if (parsed.color) { pickColor(parsed.color); moved = true; }
    if (parsed.tags.length) { tagEditor.add(parsed.tags); moved = true; }
    if (!moved) return;

    for (const word of consumed) {
      let text = word;
      const isDate = /^[@~]/.test(word);
      if (isDate) {
        const key = word[0] === '@' ? startField.get() : endField.get();
        if (key) text = `${word} → ${monthDay(key)}`;
      }
      // 날짜 · 시각은 숫자 서체, 태그 같은 말은 본문 서체 (시안: '@내일 → 9/4' · '#업무')
      tokenList.append(h('span', `cmp-token${isDate || /^\d/.test(word) ? ' num' : ''}`, text));
    }
    // 해석된 토큰을 걷어낸 나머지만 제목으로 남긴다
    titleIn.value = parsed.title + ' ';
    syncWhen();
  }

  titleIn.addEventListener('input', () => {
    if (titleIn.dataset.composing === '1') return;   // 한글 조합 중에는 손대지 않는다
    consumeTokens();
  });
  titleIn.addEventListener('compositionstart', () => { titleIn.dataset.composing = '1'; });
  titleIn.addEventListener('compositionend', () => {
    titleIn.dataset.composing = '0';
    consumeTokens();
  });

  // 반복 칩은 아래에서 만들지만 '언제' 블록이 먼저 참조한다(반복이면 종료를 잠근다).
  let repeat = null;

  // ---------------------------------------------------------------- 언제
  const dayChips = chipGroup(
    [['today', '오늘'], ['tomorrow', '내일'], ['weekend', '주말'], ['nextweek', '다음 주'],
     ['someday', '언젠가']],
    null,
    (v) => {
      // '언젠가' — 날짜 없이 적어 둔다. 시작 · 종료 칸이 걷히고 되읽는 줄이 그렇게 말한다.
      if (v === 'someday') { setSomeday(true); return; }
      setSomeday(false);
      const base = todayKey();
      const map = {
        today: base,
        tomorrow: addDays(base, 1),
        weekend: nextWeekend(base),
        nextweek: nextMonday(base),
      };
      setStart(map[v]);
    },
    'scr-chip--when',
  );

  // 언제 줄 오른쪽 — 시작 날짜를 달력으로 고르는 칸 ('2026-09-04')
  const pickField = dateField({
    cls: 'cmp-datepick',
    format: (k) => k,
    onPick: (v) => {
      if (!v) return;
      setSomeday(false);
      dayChips.set(null);
      setStart(v);
    },
  });
  pickField.setLabel('시작 날짜 고르기');
  pickField.el.prepend(icon('calendarD', 12, 1.4));

  const whenRow = h('div', 'cmp-whenrow');
  whenRow.append(dayChips.el, pickField.el);
  const whenBlock = h('div');
  whenBlock.append(fieldLabel('언제'), whenRow);

  // 시작 / 종료 — 날짜 | 시각. 시각 칸을 비워 두면 '종일'.
  const startField = dateField({
    onPick: (v) => {
      if (!v) return;
      dayChips.set(null);
      setStart(v);
    },
  });
  startField.setLabel('시작 날짜');
  const startTime = timeField({ label: '시작 시각 (비우면 종일)', onCommit: () => syncWhen() });
  const endField = dateField({
    onPick: (v) => {
      if (!v) return;
      endField.set(v);
      syncWhen();
    },
  });
  endField.setLabel('종료 날짜');
  const endTime = timeField({ label: '종료 시각', onCommit: () => syncWhen() });

  function whenBox(label, d, t) {
    const wrap = h('div');
    const box = h('div', 'scr-dt');
    box.append(d.el, h('span', 'scr-dt__sep'), t.el);
    wrap.append(fieldLabel(label), box);
    return wrap;
  }
  const whenGrid = h('div', 'scr-when');
  whenGrid.append(whenBox('시작', startField, startTime), whenBox('종료', endField, endTime));

  // 종료를 시작에서 며칠 뒤로 미는 버튼. '기간 일정'이라는 말을 안 써도
  // 눌러 보면 종료 칸이 따라 바뀌는 게 보이므로 설명이 필요 없다.
  const lenChips = chipGroup(
    [['1', '+1일'], ['3', '+3일'], ['6', '+1주']],
    null,
    (v) => {
      endField.set(addDays(startField.get() || todayKey(), Number(v)));
      syncWhen();
    },
    'scr-chip--len num',
  );
  // 만들어질 일정을 그대로 되읽어 주는 줄. 도움말을 대신한다.
  const summary = h('span', 'cmp-len__summary');
  summary.setAttribute('aria-live', 'polite');
  const lenRow = h('div', 'cmp-len');
  lenRow.append(lenChips.el, h('span', 'cmp-len__rule'), summary);

  // 장기 계획을 언제 체크하나 — 다 끝났을 때 한 번, 아니면 날마다.
  // '이사 준비'는 끝나면 한 번 체크하면 되지만 '기출 5개년 정리'는 오늘 했는지가
  // 매일 궁금하다. 하루짜리 일정에는 물을 것이 없으므로 그때는 줄째 감춘다.
  // '체크 ▸ 끝나면 한 번 / 날마다' 로 읽히게 짓는다 — '한 번에' 는 무엇을 한 번에인지 읽히지 않았다.
  const checkChips = chipGroup(
    [['once', '끝나면 한 번', '다 끝났을 때 한 번만 체크한다'],
     ['daily', '날마다', '기간 동안 하루하루 따로 체크한다']],
    'once',
    () => syncWhen(),
    'scr-chip--when',
  );
  const checkBlock = h('div');
  checkBlock.append(fieldLabel('체크'), checkChips.el);
  checkBlock.hidden = true;

  // 날짜 없이 적는 '언젠가' — 언제 칸 대신 무엇이 만들어지는지만 되읽는다
  const somedayNote = h('div', 'scr-summary', '언젠가 · 날짜 없음');

  /** 언제 줄의 '언젠가' 를 켜고 끈다. 끄면 날짜 칸이 그대로 돌아온다. */
  function setSomeday(on) {
    if (somedayMode === on) return;
    somedayMode = on;
    applyMode();
    syncRepeatExtras();
    syncWhen();
  }

  // 시작이 바뀌기 직전의 값. 여기 없으면 '며칠짜리였는지'를 알 수 없어 기간이 무너진다.
  let prevStartKey = null;

  /** 시작을 옮기면 종료도 같은 간격을 유지한 채 따라온다 (기간 길이 보존) */
  function setStart(key) {
    const base = prevStartKey || startField.get() || key;
    const prevEnd = endField.get() || base;
    const span = Math.max(0, diffDays(base, prevEnd));
    startField.set(key);
    endField.set(addDays(key, repeatFreq() ? 0 : span));
    syncWhen();
  }

  function repeatFreq() {
    return repeat ? repeat.get() : '';
  }

  /**
   * 입력값을 규칙에 맞게 정리하고 요약을 다시 쓴다.
   * 잘못된 조합은 에러로 막지 않고 조용히 바로잡는다 — 사용자가 틀린 게 아니라
   * 아직 순서대로 고르는 중일 뿐이다.
   */
  function syncWhen() {
    if (!startField.get()) startField.set(todayKey());
    const start = startField.get();

    // 반복은 당일 일정만 — 종료를 시작에 붙인다
    if (repeatFreq()) endField.set(start);
    // 종료가 시작보다 빠르면 시작에 맞춘다
    if (!endField.get() || endField.get() < start) endField.set(start);
    const end = endField.get();
    pickField.set(somedayMode ? '' : start);
    // 언제 칩은 지금 시작 날짜를 그대로 가리킨다 — 어떤 길로 골랐든(칩 · 달력 · '@내일')
    const base = todayKey();
    const chipFor = {
      [base]: 'today', [addDays(base, 1)]: 'tomorrow',
      [nextWeekend(base)]: 'weekend', [nextMonday(base)]: 'nextweek',
    };
    dayChips.set(somedayMode ? 'someday' : (chipFor[start] || null));

    // 시작 시각이 없으면 종료 시각도 뜻이 없다
    const st = startTime.get();
    if (!st) endTime.set('');
    endTime.setDisabled(!st);

    // 하루짜리인데 종료 시각이 시작보다 빠르면 비운다 (store 와 같은 규칙)
    if (st && endTime.get() && end === start && endTime.get() <= st) endTime.set('');

    // 며칠짜리인지에 맞춰 길이 칩을 켠다
    const span = String(diffDays(start, end));
    lenChips.set(['1', '3', '6'].includes(span) ? span : null);

    syncRemindOptions();

    // 기간이 이틀 이상일 때만 체크 방식을 묻는다
    const isSpan = !repeatFreq() && end > start;
    checkBlock.hidden = !isSpan || routineMode || somedayMode;
    if (!isSpan) checkChips.set('once');

    summary.textContent = whenSummary({
      start,
      end,
      startTime: st,
      endTime: endTime.get(),
      freq: repeatFreq(),
      dailyCheck: isSpan && checkChips.get() === 'daily',
    });

    prevStartKey = start;
  }

  // ---------------------------------------------------------------- 색 · 중요도
  let pickedColor = 'blue';
  const swatches = h('div', 'scr-swatches');
  const swatchBtns = {};
  for (const key of Object.keys(store.COLORS)) {
    const b = h('button', 'scr-swatch');
    b.type = 'button';
    b.title = store.COLOR_LABELS[key];
    b.setAttribute('aria-label', store.COLOR_LABELS[key]);
    const ink = h('span', 'scr-swatch__ink');
    ink.style.background = store.COLORS[key];
    b.append(ink);
    b.addEventListener('click', () => pickColor(key));
    swatchBtns[key] = b;
    swatches.append(b);
  }
  function pickColor(key) {
    if (!swatchBtns[key]) return;
    pickedColor = key;
    for (const k of Object.keys(swatchBtns)) {
      swatchBtns[k].classList.toggle('is-on', k === key);
      swatchBtns[k].setAttribute('aria-pressed', String(k === key));
    }
  }
  pickColor('blue');

  const prio = chipGroup(store.PRIORITY_MARKS.map((label, i) => [String(i), label]), '0',
    null, 'scr-chip--prio');

  const colorBlock = h('div');
  colorBlock.append(fieldLabel('색'), swatches);
  const prioBlock = h('div');
  prioBlock.append(fieldLabel('중요도'), prio.el);
  const styleRow = h('div', 'cmp-style');
  styleRow.append(colorBlock, prioBlock);

  // ---------------------------------------------------------------- 반복 · 요일
  repeat = chipGroup(REPEAT_OPTIONS, '', (v) => {
    // 반복은 당일 일정만 지원한다 — 켜면 종료를 시작에 붙이고 잠근다.
    // 칸을 숨기지 않고 잠그기만 하는 이유: 사라지면 왜 못 고치는지 알 수 없다.
    endField.setDisabled(!!v);
    lenChips.el.classList.toggle('is-disabled', !!v);
    for (const b of lenChips.el.children) b.disabled = !!v;
    applyCycleDays(v);
    syncRepeatExtras();
    syncWhen();
  }, 'scr-chip--prio');

  /**
   * 주기 칩과 요일 칸은 늘 같은 것을 가리켜야 한다.
   * '매일' 은 7일 전부고, '평일' 은 월–금이다. 골라 두면 요일 칸에 그대로 켜지므로
   * 거기서 하루만 빼는 식으로 다듬을 수 있다 — 무엇을 뜻하는지 설명할 필요가 없다.
   */
  function applyCycleDays(v) {
    const preset = v === 'daily' ? ALL_DAYS : store.DAY_PRESETS[v];
    if (preset) setDays(preset);
    // '매주' 는 고른 요일을 그대로 물려받는다 — 평일에서 하루만 빼려고 넘어오는 길이다.
    else if (v === 'weekly') { if (!picked.size) setDays([fromKey(todayKey()).getDay()]); }
    // '격일'·'매월'·'매년' 에서는 요일이 뜻이 없으므로 켜 둔 채로 두면 거짓말이 된다.
    else setDays([]);
  }

  // 요일 고르기 — '월수금 운동' 처럼 요일이 정해진 습관이 흔하다.
  // 고르지 않으면 예전처럼 시작일의 요일을 따른다.
  const picked = new Set();
  const dayPick = h('div', 'cmp-dows');
  const dayBtns = new Map();
  for (const d of DOW_ORDER) {
    const label = WEEKDAY_LABELS[d];
    const b = h('button', 'cmp-dow', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', `${label}요일`);
    b.addEventListener('click', () => {
      // 요일이 뜻을 갖는 주기에서 전부 꺼 버리면 '아무 날도 아닌 매주' 가 된다.
      // 막았다고 알리지 않고 그냥 켜진 채로 둔다 — 하나는 있어야 한다는 게 눌러 보면 보인다.
      if (picked.has(d)) {
        if (picked.size === 1 && daysMatter()) return;
        picked.delete(d);
      } else picked.add(d);
      paintDays();
      syncFreqChip();
      syncWhen();
    });
    dayBtns.set(d, b);
    dayPick.append(b);
  }
  const dayBlock = h('div');
  dayBlock.append(fieldLabel('요일'), dayPick);
  dayBlock.hidden = true;

  function paintDays() {
    for (const [d, b] of dayBtns) {
      b.classList.toggle('is-on', picked.has(d));
      b.setAttribute('aria-pressed', String(picked.has(d)));
    }
  }

  function setDays(list) {
    picked.clear();
    for (const d of list) picked.add(d);
    paintDays();
  }

  /**
   * 요일을 손대면 주기 칩을 되맞춘다.
   * 평일에서 금요일을 빼면 그건 더 이상 '평일' 이 아니라 '매주' 다 —
   * 칩이 그대로 켜져 있으면 화면이 거짓말을 하게 된다.
   */
  function syncFreqChip() {
    const now = [...picked].sort((a, b) => a - b).join(',');
    let next = picked.size ? 'weekly' : repeat.get();
    if (now === ALL_DAYS.join(',')) next = 'daily';
    for (const [value, days] of Object.entries(store.DAY_PRESETS)) {
      if (days.join(',') === now) next = value;
    }
    repeat.set(next);
    if (routineMode) cycles.set(next);
  }

  /** 지금 주기에서 요일이 뜻을 갖는가 (매주·평일·주말) */
  function daysMatter() {
    const freq = repeat ? repeat.get() : '';
    return freq === 'weekly' || !!store.DAY_PRESETS[freq];
  }

  /** 반복 종류에 따라 요일 칸을 보인다 */
  function syncRepeatExtras() {
    // 루틴은 '월·수·금 운동' 처럼 요일을 직접 고르는 일이 흔하다 — 늘 열어 둔다.
    // 일정에서는 반복 자체가 곁가지라 요일이 뜻을 가질 때만 꺼낸다.
    dayBlock.hidden = routineMode ? false : !daysMatter();
  }

  const repeatBlock = h('div');
  const repeatRow = h('div', 'cmp-repeatrow');
  repeatRow.append(repeat.el);
  repeatBlock.append(fieldLabel('반복'), repeatRow);

  // ---------------------------------------------------------------- 알림
  // 시각이 있는 일정에만 뜻이 있는 상대 알림('30분 전')은 시각을 넣으면 나타난다.
  const remind = chipGroup(REMIND_OPTIONS, '', null, 'scr-chip--prio');
  const remindBlock = h('div');
  remindBlock.append(fieldLabel('알림'), remind.el);

  /** 시작 시각 유무에 따라 알림 선택지를 바꾼다 */
  function syncRemindOptions() {
    const timed = !!startTime.get();
    for (const [value] of REMIND_OPTIONS) {
      const btn = remind.button(value);
      if (btn) btn.hidden = value.startsWith('-') && !timed;
    }
    // 시각을 지웠는데 '30분 전'이 골라져 있으면 기준점이 없다 — 없음으로 되돌린다
    if (!timed && remind.get().startsWith('-')) remind.set('');
  }

  // ---------------------------------------------------------------- 태그 · 링크
  const tagEditor = createTagEditor(store);
  const tagBlock = h('div');
  tagBlock.append(fieldLabel('태그'), tagEditor.el);

  const linkIn = h('input', 'scr-input');
  linkIn.type = 'text';
  linkIn.placeholder = 'meet.google.com/abc';
  linkIn.spellcheck = false;
  const linkBlock = h('div');
  linkBlock.append(fieldLabel('링크'), linkIn);

  // ---------------------------------------------------------------- 더보기
  // 처음 보는 사람에게 선택지를 한꺼번에 쏟지 않는다. 기본은 접어 둔다.
  const moreBtn = h('button', 'cmp-more');
  moreBtn.type = 'button';
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.append(h('span', null, '더보기 · 반복 · 알림 · 태그 · 링크'), icon('chevronDown', 12, 1.4));
  const moreBox = h('div', 'cmp-morebox');
  moreBox.hidden = true;
  moreBtn.addEventListener('click', () => setMore(moreBox.hidden));

  function setMore(open) {
    moreBox.hidden = !open;
    moreBtn.classList.toggle('is-on', open);
    moreBtn.setAttribute('aria-expanded', String(open));
  }

  // ---------------------------------------------------------------- 루틴 전용 줄
  // 주기 — 시안의 '매일 · 매주 · 격일' 에 평일 · 주말 · 매월을 더했다
  const cycles = chipGroup(
    [['daily', '매일'], ['weekdays', '평일'], ['weekends', '주말'],
     ['weekly', '매주'], ['alternate', '격일'], ['monthly', '매월']],
    'daily',
    (v) => {
      repeat.set(v);
      applyCycleDays(v);
      syncWhen();
    },
    'scr-chip--cycle',
  );
  const cycleBlock = h('div');
  cycleBlock.append(fieldLabel('주기'), cycles.el);

  // 시각 — 넣으면 시간띠에 그려지고, 비우면 종일 띠에 놓인다
  let routineLen = 60;
  const noTimeChip = h('button', 'scr-chip scr-chip--cycle', '시각 없음');
  noTimeChip.type = 'button';
  const routineTime = timeField({
    cls: 'scr-chip scr-chip--cycle cmp-rtime',
    label: '루틴 시각',
    onCommit: () => paintRoutineTime(),
  });
  const lenChip = h('button', 'scr-chip scr-chip--cycle cmp-rlen num');
  lenChip.type = 'button';
  lenChip.title = '눌러서 길이 바꾸기';
  noTimeChip.addEventListener('click', () => {
    routineTime.set('');
    paintRoutineTime();
  });
  lenChip.addEventListener('click', () => {
    const i = ROUTINE_LENGTHS.indexOf(routineLen);
    routineLen = ROUTINE_LENGTHS[(i + 1) % ROUTINE_LENGTHS.length];
    paintRoutineTime();
  });
  const rtimeRow = h('div', 'cmp-rtimerow');
  rtimeRow.append(noTimeChip, routineTime.el, lenChip);
  const rtimeBlock = h('div');
  rtimeBlock.append(fieldLabel('시각'), rtimeRow);

  function paintRoutineTime() {
    const t = routineTime.get();
    noTimeChip.classList.toggle('is-on', !t);
    routineTime.el.classList.toggle('is-on', !!t);
    lenChip.textContent = durLabel(routineLen);
    lenChip.disabled = !t;
    paintRoutineRemind();
  }

  // 알림 · 태그 — 시안은 상세 화면과 같은 '라벨 64px + 값' 줄이다
  const rRemindRow = h('div', 'dt-row dt-row--first is-action');
  rRemindRow.tabIndex = 0;
  rRemindRow.setAttribute('role', 'button');
  const rRemindValue = h('span', 'dt-row__value');
  const rRemindVal = h('span', 'dt-row__val');
  const rRemindMore = h('span', 'dt-row__more');
  rRemindMore.append(icon('chevronDown', 10, 1.4));
  rRemindVal.append(rRemindValue, rRemindMore);
  rRemindRow.append(h('span', 'dt-row__key', '알림'), rRemindVal);
  let routineRemind = '';

  function paintRoutineRemind() {
    if (rRemindValue.classList.contains('is-editing')) return;
    // 시각이 없는 루틴에서 '30분 전' 은 기준점이 없다
    if (!routineTime.get() && routineRemind.startsWith('-')) routineRemind = '';
    rRemindValue.textContent = routineRemind ? remindLabel(routineRemind) : '없음';
    rRemindValue.style.color = routineRemind ? 'var(--ink)' : 'var(--ink-soft)';
  }

  function openRoutineRemind() {
    const timed = !!routineTime.get();
    const r = rRemindVal.getBoundingClientRect();
    const setR = (v) => () => { routineRemind = v; paintRoutineRemind(); };
    showContextMenu(r.left, r.bottom + 2, [
      { label: '없음', checked: !routineRemind, onSelect: setR('') },
      ...(timed
        ? [['-10m', '10분 전'], ['-30m', '30분 전']].map(([v, label]) => ({
            label, checked: routineRemind === v, onSelect: setR(v),
          }))
        : []),
      { label: '당일 오전 9시', checked: routineRemind === '0@09:00', onSelect: setR('0@09:00') },
      { separator: true },
      { label: '시각 지정…', onSelect: () => editRoutineRemindTime() },
    ]);
  }

  function editRoutineRemindTime() {
    const tf = timeField({
      cls: 'dt-row__input',
      label: '알림 시각',
      onCommit: (v) => { routineRemind = v ? `0@${v}` : ''; },
    });
    const cur = /^0@(\d\d:\d\d)$/.exec(routineRemind);
    tf.set(cur ? cur[1] : '');
    rRemindValue.replaceChildren(tf.el);
    rRemindValue.classList.add('is-editing');
    tf.el.focus();
    tf.el.select();
    tf.el.addEventListener('blur', () => {
      rRemindValue.classList.remove('is-editing');
      paintRoutineRemind();
    });
    tf.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); tf.el.blur(); }
    });
  }

  rRemindRow.addEventListener('click', (e) => {
    if (e.target.closest('input')) return;
    openRoutineRemind();
  });
  rRemindRow.addEventListener('keydown', (e) => {
    if (e.target !== rRemindRow) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRoutineRemind(); }
  });

  const rTagRow = h('div', 'dt-row dt-row--last');
  const rTagVal = h('span', 'dt-row__val');
  rTagRow.append(h('span', 'dt-row__key', '태그'), rTagVal);


  // ---------------------------------------------------------------- 하단
  const err = h('div', 'cmp-err');
  err.hidden = true;

  const cancelBtn = h('button', 'scr-btn', '취소');
  cancelBtn.type = 'button';
  const saveBtn = h('button', 'scr-btn scr-btn--gold', '추가');
  saveBtn.type = 'submit';

  const foot = h('div', 'cmp-foot');
  foot.append(cancelBtn, saveBtn);

  // ---------------------------------------------------------------- 조립
  const body = h('div', 'scr-body');
  moreBox.append(repeatBlock, dayBlock, remindBlock, tagBlock, linkBlock);
  body.append(
    titleBox,
    whenBlock, whenGrid, lenRow, checkBlock, somedayNote,
    cycleBlock, rtimeBlock,
    styleRow,
    rRemindRow, rTagRow,
    moreBtn, moreBox,
    err, foot,
  );
  form.append(head.el, body);

  // ---------------------------------------------------------------- 동작
  cancelBtn.addEventListener('click', () => close());
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

  /**
   * 화면 모드 — 일정 / 루틴 / 언젠가.
   * 루틴은 '언제 하루' 가 아니라 '얼마마다' 가 전부다. 시작·종료 날짜, 기간 칩,
   * 중요도, 링크는 쓸 일이 없는데 자리만 차지하고 눈을 흩뜨린다.
   * (시작일은 오늘로 조용히 잡는다 — 습관을 언제부터 할지 고르게 할 이유가 없다)
   */
  function applyMode() {
    const event = !routineMode && !somedayMode;
    head.titleEl.textContent = routineMode ? '루틴' : '일정 추가';
    titleIn.placeholder = routineMode ? '예) 운동' : '예) 치과 @내일 15:00';
    tokens.hidden = routineMode;

    // 언제 줄은 '언젠가' 를 골라도 남는다 — 거기서 다시 날짜를 고를 수 있어야 한다
    whenBlock.hidden = routineMode;
    whenGrid.hidden = !event;
    lenRow.hidden = !event;
    somedayNote.hidden = !somedayMode;
    if (!event) checkBlock.hidden = true;

    cycleBlock.hidden = !routineMode;
    rtimeBlock.hidden = !routineMode;
    rRemindRow.hidden = !routineMode;
    rTagRow.hidden = !routineMode;

    prioBlock.hidden = routineMode;
    styleRow.classList.toggle('is-single', routineMode);

    moreBtn.hidden = routineMode;
    // '언젠가' 는 날짜가 없어 반복도 알림도 기준점이 없다
    repeatBlock.hidden = somedayMode;
    remindBlock.hidden = somedayMode;

    // 요일 칸과 태그 편집기는 한 벌이다 — 모드에 따라 앉는 자리만 바꾼다
    if (routineMode) {
      cycleBlock.after(dayBlock);
      rTagVal.append(tagEditor.el);
    } else {
      repeatBlock.after(dayBlock);
      tagBlock.append(tagEditor.el);
    }

    saveBtn.textContent = routineMode ? '루틴 추가' : '추가';
    form.classList.toggle('cmp--routine', routineMode);
  }

  /**
   * @param {{start?:string, end?:string, startTime?:string, routine?:boolean, someday?:boolean,
   *           title?:string, dailyCheck?:boolean, color?:string, tags?:string[]}} [preset]
   *   routine — 루틴 모드로 연다. 매일 반복 + 달력에 표시 안 함을 미리 켜 둔다.
   *   someday — 언제를 '언젠가' 로 골라 둔 채 연다.
   */
  function open(preset) {
    const sel = store.getState().selectedDate;
    const start = preset?.start || sel;
    const end = preset?.end || start;

    routineMode = !!preset?.routine;
    somedayMode = !!preset?.someday && !routineMode;

    titleIn.value = preset?.title || '';
    tokenList.replaceChildren();
    prevStartKey = null;
    startField.set(start);
    endField.set(end);
    const presetMin = timeMinutes(preset?.startTime);
    startTime.set(presetMin != null ? preset.startTime : '');
    endTime.set(presetMin != null ? hhmm(presetMin + 60) : '');
    linkIn.value = '';
    tagEditor.set(preset?.tags || []);
    prio.set('0');
    repeat.set('');
    remind.set('');
    picked.clear();
    paintDays();
    checkChips.set(preset?.dailyCheck ? 'daily' : 'once');
    dayChips.set(start === todayKey() ? 'today' : null);
    endField.setDisabled(false);
    lenChips.el.classList.remove('is-disabled');
    for (const b of lenChips.el.children) b.disabled = false;
    setMore(false);
    err.hidden = true;
    pickColor(preset?.color && swatchBtns[preset.color] ? preset.color : 'blue');

    routineRemind = '';
    routineLen = 60;
    routineTime.set('');

    if (routineMode) {
      // '루틴' 으로 열었으면 매일 반복 + 달력에 표시 안 함을 미리 켠다
      repeat.set('daily');
      cycles.set('daily');
      setDays(ALL_DAYS);   // '매일' 은 요일 칸에서 7일 전부로 보여야 한다
      endField.setDisabled(true);
    }
    applyMode();
    syncRepeatExtras();
    paintRoutineTime();

    syncWhen();
    form.hidden = false;
    notifyToggle();
    titleIn.focus();
    // 이름을 미리 채워 열었으면 통째로 골라 둔다 — 그대로 쓰든 갈아 쓰든 한 동작으로 끝난다
    if (preset?.title) titleIn.select();
  }

  function close() {
    if (form.hidden) return;
    form.hidden = true;
    notifyToggle();
  }

  function fail(message, focusEl) {
    err.textContent = message;
    err.hidden = false;
    focusEl?.focus();
  }

  function submit() {
    // 마지막 낱말이 토큰이면(띄어쓰기 없이 Enter) 여기서 걷어낸다
    if (titleIn.value.trim()) {
      titleIn.value = titleIn.value.trim() + ' ';
      consumeTokens();
    }
    const title = titleIn.value.trim();
    if (!title) { fail('이름을 적어 주세요.', titleIn); return; }

    const link = normalizeLink(linkIn.value);
    if (link === null) { fail('링크 주소를 확인해 주세요.', linkIn); return; }

    const tags = tagEditor.get();

    if (somedayMode) {
      store.addTask({
        title, start: null, end: null, link, color: pickedColor,
        priority: Number(prio.get()) || 0, tags,
      });
      close();
      return;
    }

    if (routineMode) {
      const freq = repeat.get() || 'daily';
      const t = routineTime.get();
      const tMin = timeMinutes(t);
      store.addTask({
        title,
        // 루틴은 '오늘부터' 다. 날짜 칸을 감췄으므로 값도 여기서 확정한다.
        start: todayKey(),
        end: todayKey(),
        startTime: t || null,
        endTime: tMin != null ? hhmm(tMin + routineLen) : null,
        color: pickedColor,
        remind: routineRemind,
        repeat: {
          ...store.repeatFreqDays(freq, [...picked].sort((a, b) => a - b)),
          routine: true,
        },
        tags,
      });
      close();
      return;
    }

    // syncWhen 이 이미 시작/종료를 정리해 두므로 여기서 되돌릴 조합은 없다
    syncWhen();
    const start = startField.get() || store.getState().selectedDate;
    const freq = repeat.get();
    const end = freq ? start : (endField.get() || start);

    store.addTask({
      title,
      start,
      end,
      startTime: startTime.get() || null,
      endTime: endTime.get() || null,
      link,
      color: pickedColor,
      // 반복 일정은 당일짜리라 '매일 체크'가 성립하지 않는다
      dailyCheck: !freq && end > start && checkChips.get() === 'daily',
      priority: Number(prio.get()) || 0,
      remind: remind.get(),
      // '평일'·'주말'·'격일' 은 여기서 저장 규칙으로 풀린다
      repeat: freq
        ? { ...store.repeatFreqDays(freq, [...picked].sort((a, b) => a - b)), routine: false }
        : null,
      tags,
    });

    // 다른 날짜로 만들었으면 그 날로 따라간다.
    // 안 그러면 방금 만든 일정이 목록에 없어서 '사라졌다'고 느낀다.
    if (start !== store.getState().selectedDate) store.selectDate(start);

    close();
  }

  return {
    el: form, open, close,
    setBack: (label) => { head.back.textContent = label; },
    isOpen: () => !form.hidden,
    /** 지금 어떤 화면인가 — 책갈피 탭이 따라간다 */
    mode: () => (routineMode ? 'routine' : 'compose'),
  };
}

/**
 * 태그 칩 편집기 — 시안의 '#건강' 칩 + 점선 ＋.
 * 칩을 누르면 빠지고, ＋ 를 누르면 그 자리에 입력칸이 열린다.
 * 이미 쓰는 태그는 흐린 칩으로 곁에 두어 한 번에 고른다.
 */
function createTagEditor(store) {
  const el = h('span', 'cmp-tags');
  let tags = [];
  const addBtn = h('button', 'cmp-tag cmp-tag--add', '＋');
  addBtn.type = 'button';
  addBtn.title = '태그 더하기';
  const input = h('input', 'cmp-tag__input');
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = '태그';
  input.hidden = true;
  // 칩 자리와 제안 자리만 다시 그린다 — 입력칸을 옮기면 포커스가 빠져 칸이 닫힌다
  const chipBox = h('span', 'cmp-tags__list');
  const ghostBox = h('span', 'cmp-tags__list');
  el.append(chipBox, input, addBtn, ghostBox);

  function render() {
    const chips = tags.map((tag) => {
      const c = h('button', 'cmp-tag', `#${tag}`);
      c.type = 'button';
      c.title = '빼기';
      c.addEventListener('click', () => { tags = tags.filter((x) => x !== tag); render(); });
      return c;
    });
    const used = new Set(tags);
    const ghosts = input.hidden ? [] : store.allTags().filter((t) => !used.has(t)).slice(0, 6)
      .map((tag) => {
        const g = h('button', 'cmp-tag cmp-tag--ghost', `#${tag}`);
        g.type = 'button';
        g.addEventListener('mousedown', (e) => e.preventDefault());   // 입력칸이 닫히지 않게
        g.addEventListener('click', () => { add([tag]); input.focus(); });
        return g;
      });
    chipBox.replaceChildren(...chips);
    ghostBox.replaceChildren(...ghosts);
  }

  function add(list) {
    for (const raw of list) {
      const tag = String(raw).replace(/^#/, '').trim();
      if (tag && !tags.includes(tag)) tags.push(tag);
    }
    render();
  }

  function commitInput() {
    if (input.value.trim()) add(input.value.split(/[\s,]+/));
    input.value = '';
  }

  addBtn.addEventListener('click', () => {
    input.hidden = false;
    addBtn.hidden = true;
    render();
    input.focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); commitInput(); input.focus(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.blur(); }
  });
  input.addEventListener('blur', () => {
    commitInput();
    input.hidden = true;
    addBtn.hidden = false;
    render();
  });

  render();
  return {
    el,
    get: () => {
      if (!input.hidden) commitInput();
      return [...tags];
    },
    set(list) {
      tags = [];
      input.value = '';
      input.hidden = true;
      addBtn.hidden = false;
      add(list || []);
    },
    add,
  };
}
