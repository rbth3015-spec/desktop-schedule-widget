// 일정 추가 폼.
//
// 빠른 입력(@내일 ~3d #태그)은 익힌 사람에게는 빠르지만, 처음 쓰는 사람에게는
// 외워야 할 문법이다. 이 폼은 문법을 전혀 몰라도 **누르기만 해서** 일정을 만들 수 있는
// 기본 경로다. 모든 선택지가 눈에 보이는 것이 핵심 — 숨은 규칙이 없어야 한다.
//
// 날짜는 '여러 날에 걸쳐' 토글로 모드를 나누지 않는다. 시작과 종료를 늘 나란히 두고,
// 둘이 같으면 그게 하루짜리다. 데이터 모델이 원래 그 모양이고(end 는 항상 채워진다),
// 상세 패널도 이미 시작/종료 두 칸이라 폼만 달랐다. 모드를 없애면 '여러 날짜리를
// 만들 수 있다'는 사실이 숨지 않는다는 게 더 크다.
//
// 대신 폼 아래에 '무엇이 만들어지는지' 한 줄로 되읽어 준다. 이 한 줄이 있으면
// 설명 문구를 따로 달 필요가 없다 — 화면이 스스로 설명한다.

import { todayKey, addDays, diffDays, fromKey, WEEKDAY_LABELS } from '../lib/date.js';
import { icon } from '../lib/icons.js';
import { parseQuickInput, resolveRange } from './parse.js';

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/** 라벨 + 컨트롤 한 줄 */
function field(labelText, control) {
  const wrap = h('div', 'cmp-field');
  wrap.append(h('div', 'cmp-field__label', labelText), control);
  return wrap;
}

/**
 * 하나만 고르는 버튼 묶음. select 보다 선택지가 한눈에 보인다.
 * @returns {{el:HTMLElement, get:()=>string, set:(v:string)=>void, button:(v:string)=>HTMLElement|null}}
 */
function chipGroup(options, initial, onChange) {
  const el = h('div', 'cmp-chips');
  let value = initial;
  const buttons = new Map();

  for (const [val, label, hint] of options) {
    const b = h('button', 'cmp-chip', label);
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
    for (const [val, b] of buttons) b.classList.toggle('is-on', val === v);
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

/**
 * 만들어질 일정을 사람 말로 한 줄 되읽어 준다.
 * 이 줄이 폼 아래에 늘 있으면 '시작=종료면 하루' 같은 규칙을 따로 설명할 필요가 없다.
 */
export function whenSummary({ start, end, startTime, endTime, freq }) {
  if (!start) return '';

  const repeatPart = freq ? `${REPEAT_LABEL_MAP[freq] || ''} 반복 · ` : '';

  // 여러 날에 걸친 일정
  if (!freq && end && end > start) {
    const days = diffDays(start, end) + 1;
    const time = startTime ? ` · ${startTime} 시작` : '';
    return `${pretty(start)} → ${pretty(end)} · ${days}일간${time}`;
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

const PRIORITY_OPTIONS = [['0', '보통'], ['1', '중요'], ['2', '긴급']];

// '평일'·'주말' 은 새 반복 규칙이 아니라 요일을 미리 고른 '매주' 다(store.DAY_PRESETS).
// 운동·약 먹기 같은 습관은 대부분 이 둘 아니면 매일이라, 요일을 다섯 번 누르게 두지 않는다.
const REPEAT_OPTIONS = [
  ['', '안 함'], ['daily', '매일'],
  ['weekdays', '평일', '월 · 화 · 수 · 목 · 금'],
  ['weekends', '주말', '토 · 일'],
  ['weekly', '매주'], ['monthly', '매월'], ['yearly', '매년'],
];

const REPEAT_LABEL_MAP = Object.fromEntries(REPEAT_OPTIONS.filter(([v]) => v));

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

const COLOR_NAMES = {
  blue: '청람', green: '쑥', amber: '치자', rose: '다홍', violet: '자주', slate: '회묵',
};

/**
 * @param {{store: object, onToggle?: (open: boolean) => void}} deps
 * @returns {{el:HTMLElement, open:(preset?:{start:string,end:string})=>void, close:()=>void, isOpen:()=>boolean}}
 */
export function createCompose({ store, onToggle }) {
  /** 폼이 열리거나 닫힐 때마다 알린다.
   *  안에서 닫는 길이 여럿(취소·Esc·제출)이라, 바깥이 상태를 따라오려면 통보가 필요하다. */
  const notifyToggle = () => onToggle?.(!form.hidden);
  const form = h('form', 'cmp');
  form.hidden = true;

  // ---------------------------------------------------------------- 제목
  const titleIn = h('input', 'cmp-title');
  titleIn.type = 'text';
  titleIn.placeholder = '무엇을 할 예정인가요?';
  titleIn.required = true;
  titleIn.spellcheck = false;

  // 제목칸이 한 줄 문법을 그대로 알아듣는다.
  //
  // 전용 입력칸을 없애면서 문법까지 버릴 이유는 없다. 다만 '문법이 남아 있다'와
  // '문법을 외워야 한다'는 다르므로, **띄어쓰기로 토큰이 끝나는 순간 그 토큰을
  // 제목에서 걷어내고 해당 컨트롤로 옮긴다.** 무슨 일이 일어났는지 눈으로 보이고,
  // 텍스트에 흔적이 남지 않으니 나중에 날짜를 손으로 고쳐도 다시 덮이지 않는다.
  const consumedTag = h('div', 'cmp-consumed');
  consumedTag.setAttribute('aria-live', 'polite');

  /** 방금 옮긴 항목을 잠깐 보여 준다 */
  let consumedTimer = 0;
  function flashConsumed(parts) {
    if (!parts.length) return;
    consumedTag.replaceChildren();
    for (const [label, value] of parts) {
      const chip = h('span', 'cmp-consumed__chip');
      chip.append(h('em', null, label), h('span', null, value));
      consumedTag.append(chip);
    }
    clearTimeout(consumedTimer);
    consumedTimer = setTimeout(() => consumedTag.replaceChildren(), 2600);
  }

  /**
   * 완결된 토큰만 걷어낸다. 마지막 낱말은 아직 타이핑 중일 수 있으므로 건드리지 않는다
   * (한글 조합 중에 글자를 빼앗기면 입력이 망가진다).
   */
  function consumeTokens() {
    const raw = titleIn.value;
    if (!/\s$/.test(raw)) return;          // 띄어쓰기로 끝날 때만 = 토큰이 확정된 순간
    const parsed = parseQuickInput(raw, todayKey());

    const moved = [];
    if (parsed.start || parsed.end || parsed.endDays != null) {
      const { start, end } = resolveRange(parsed, startIn.value || todayKey());
      if (start) { startIn.value = start; dayChips.set(null); }
      if (end && start) endIn.value = end;
      moved.push(['언제', pretty(startIn.value)]);
    }
    if (parsed.startTime) {
      startTimeIn.value = parsed.startTime;
      if (parsed.endTime) endTimeIn.value = parsed.endTime;
      moved.push(['시각', parsed.endTime ? `${parsed.startTime}–${parsed.endTime}` : parsed.startTime]);
    }
    if (parsed.priority > 0) {
      prio.set(String(parsed.priority));
      moved.push(['중요도', PRIORITY_OPTIONS[parsed.priority][1]]);
    }
    if (parsed.color) {
      pickedColor = parsed.color;
      for (const k of Object.keys(swatchBtns)) swatchBtns[k].classList.toggle('is-on', k === parsed.color);
      moved.push(['색', COLOR_NAMES[parsed.color] || parsed.color]);
    }
    if (parsed.tags.length) {
      const have = new Set(tagsIn.value.split(/[\s,]+/).filter(Boolean));
      for (const t of parsed.tags) have.add(t);
      tagsIn.value = [...have].join(' ');
      moved.push(['태그', parsed.tags.map((t) => `#${t}`).join(' ')]);
    }

    if (!moved.length) return;
    // 해석된 토큰을 걷어낸 나머지만 제목으로 남긴다
    titleIn.value = parsed.title + ' ';
    syncWhen();
    flashConsumed(moved);
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
  // const 로 두면 시간대 오류(TDZ)가 나므로 let 으로 미리 선언해 둔다.
  let repeat = null;

  // ---------------------------------------------------------------- 언제
  //
  // 시작 / 종료가 늘 함께 보인다. 둘이 같으면 하루짜리다.
  // 시각 칸은 비워 두면 '종일' — 빈 --:-- 자체가 그 뜻을 말해 준다.

  const startIn = h('input', 'cmp-date');
  startIn.type = 'date';
  startIn.setAttribute('aria-label', '시작 날짜');

  const startTimeIn = h('input', 'cmp-time');
  startTimeIn.type = 'time';
  startTimeIn.setAttribute('aria-label', '시작 시각 (비우면 종일)');

  const endIn = h('input', 'cmp-date');
  endIn.type = 'date';
  endIn.setAttribute('aria-label', '종료 날짜');

  const endTimeIn = h('input', 'cmp-time');
  endTimeIn.type = 'time';
  endTimeIn.setAttribute('aria-label', '종료 시각');

  const dayChips = chipGroup(
    [['today', '오늘'], ['tomorrow', '내일'], ['weekend', '이번 주말'], ['nextweek', '다음 주']],
    null,
    (v) => {
      const base = todayKey();
      const map = {
        today: base,
        tomorrow: addDays(base, 1),
        weekend: nextWeekend(base),
        nextweek: nextMonday(base),
      };
      setStart(map[v]);
    }
  );

  // 종료를 시작에서 며칠 뒤로 미는 버튼. '기간 일정'이라는 말을 안 써도
  // 눌러 보면 종료 칸이 따라 바뀌는 게 보이므로 설명이 필요 없다.
  const lenChips = chipGroup(
    [['1', '+1일'], ['3', '+3일'], ['6', '+1주']],
    null,
    (v) => {
      endIn.value = addDays(startIn.value || todayKey(), Number(v));
      syncWhen();
    }
  );

  const startRow = h('div', 'cmp-when__row');
  startRow.append(h('span', 'cmp-when__key', '시작'), startIn, startTimeIn);

  const endRow = h('div', 'cmp-when__row');
  endRow.append(h('span', 'cmp-when__key', '종료'), endIn, endTimeIn);

  // 만들어질 일정을 그대로 되읽어 주는 줄. 도움말을 대신한다.
  const summary = h('div', 'cmp-when__summary');
  summary.setAttribute('aria-live', 'polite');

  const whenBox = h('div', 'cmp-when');
  // 길이 칩과 요약을 한 줄에 둔다.
  // 칩을 종료 줄에 붙였더니 좁은 패널에서 접혀 오히려 줄이 늘었다(내용 546px / 칸 374px).
  // 둘 다 '거들어 주는' 정보라 나란히 두는 게 자연스럽다.
  const tailRow = h('div', 'cmp-when__tail');
  tailRow.append(lenChips.el, summary);

  whenBox.append(dayChips.el, startRow, endRow, tailRow);

  // 시작이 바뀌기 직전의 값. change 이벤트가 올 때 input.value 는 이미 새 값이라
  // 여기 없으면 '며칠짜리였는지'를 알 수 없어 기간이 무너진다.
  let prevStartKey = null;

  /** 시작을 옮기면 종료도 같은 간격을 유지한 채 따라온다 (기간 길이 보존) */
  function setStart(key) {
    const base = prevStartKey || startIn.value || key;
    const prevEnd = endIn.value || base;
    const span = Math.max(0, diffDays(base, prevEnd));
    startIn.value = key;
    endIn.value = addDays(key, repeatFreq() ? 0 : span);
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
    if (!startIn.value) startIn.value = todayKey();

    // 종료가 시작보다 빠르면 시작에 맞춘다
    if (!endIn.value || endIn.value < startIn.value) endIn.value = startIn.value;

    // 시작 시각이 없으면 종료 시각도 뜻이 없다
    if (!startTimeIn.value) endTimeIn.value = '';
    endTimeIn.disabled = !startTimeIn.value;

    // 하루짜리인데 종료 시각이 시작보다 빠르면 비운다 (store 와 같은 규칙)
    const sameDay = endIn.value === startIn.value;
    if (startTimeIn.value && endTimeIn.value && sameDay
        && endTimeIn.value <= startTimeIn.value) {
      endTimeIn.value = '';
    }

    // 며칠짜리인지에 맞춰 길이 칩을 켠다
    const span = String(diffDays(startIn.value, endIn.value));
    lenChips.set(['1', '3', '6'].includes(span) ? span : null);

    syncRemindOptions();

    summary.textContent = whenSummary({
      start: startIn.value,
      end: endIn.value,
      startTime: startTimeIn.value,
      endTime: endTimeIn.value,
      freq: repeatFreq(),
    });

    prevStartKey = startIn.value;
  }

  startIn.addEventListener('change', () => {
    dayChips.set(null);
    setStart(startIn.value || todayKey());
  });
  endIn.addEventListener('change', () => syncWhen());
  startTimeIn.addEventListener('change', () => syncWhen());
  endTimeIn.addEventListener('change', () => syncWhen());

  // ---------------------------------------------------------------- 색·우선순위
  let pickedColor = 'blue';
  const swatches = h('div', 'cmp-swatches');
  const swatchBtns = {};
  for (const key of Object.keys(store.COLORS)) {
    const b = h('button', 'cmp-swatch');
    b.type = 'button';
    b.title = COLOR_NAMES[key] || key;
    b.style.setProperty('--sw', store.COLORS[key]);
    b.addEventListener('click', () => {
      pickedColor = key;
      for (const k of Object.keys(swatchBtns)) swatchBtns[k].classList.toggle('is-on', k === key);
    });
    swatchBtns[key] = b;
    swatches.append(b);
  }
  swatchBtns.blue.classList.add('is-on');

  const prio = chipGroup(PRIORITY_OPTIONS, '0');

  // ---------------------------------------------------------------- 반복·알림
  repeat = chipGroup(REPEAT_OPTIONS, '', (v) => {
    // 반복은 당일 일정만 지원한다 — 켜면 종료를 시작에 붙이고 잠근다.
    // 칸을 숨기지 않고 잠그기만 하는 이유: 사라지면 왜 못 고치는지 알 수 없다.
    if (v) endIn.value = startIn.value;
    endIn.disabled = !!v;
    lenChips.el.classList.toggle('is-disabled', !!v);
    for (const b of lenChips.el.children) b.disabled = !!v;
    // 주기 칩과 요일 칸은 늘 같은 것을 가리켜야 한다.
    // '매일' 은 7일 전부고, '평일' 은 월–금이다. 골라 두면 요일 칸에 그대로 켜지므로
    // 거기서 하루만 빼는 식으로 다듬을 수 있다 — 무엇을 뜻하는지 설명할 필요가 없다.
    const preset = v === 'daily' ? ALL_DAYS : store.DAY_PRESETS[v];
    if (preset) setDays(preset);
    // '매주' 는 고른 요일을 그대로 물려받는다 — 평일에서 하루만 빼려고 넘어오는 길이다.
    // '매월'·'매년' 에서는 요일이 뜻이 없으므로 켜 둔 채로 두면 거짓말이 된다.
    else if (v !== 'weekly') setDays([]);
    syncRepeatExtras();
    syncWhen();
  });

  // --- 매주 반복의 요일 고르기 ---
  //
  // '월수금 운동' 처럼 요일이 정해진 습관이 흔하다. 요일을 고르지 않으면
  // 예전처럼 시작일의 요일을 따른다.
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
  const picked = new Set();
  const dayPick = h('div', 'cmp-weekdays');
  const dayBtns = [];
  WEEKDAYS.forEach((label, i) => {
    const b = h('button', 'cmp-weekday', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', `${label}요일`);
    b.addEventListener('click', () => {
      // 요일이 뜻을 갖는 주기에서 전부 꺼 버리면 '아무 날도 아닌 매주' 가 된다.
      // 막았다고 알리지 않고 그냥 켜진 채로 둔다 — 하나는 있어야 한다는 게 눌러 보면 보인다.
      if (picked.has(i)) {
        if (picked.size === 1 && daysMatter()) return;
        picked.delete(i);
      } else picked.add(i);
      paintDays();
      syncFreqChip();
      syncWhen();
    });
    dayBtns.push(b);
    dayPick.append(b);
  });
  const dayField = field('요일', dayPick);
  dayField.hidden = true;

  /** 고른 요일을 버튼에 칠한다 */
  function paintDays() {
    dayBtns.forEach((b, i) => {
      b.classList.toggle('is-on', picked.has(i));
      b.setAttribute('aria-pressed', String(picked.has(i)));
    });
  }

  /** 요일 묶음을 통째로 고른다 (평일·주말 칩) */
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
    if (now === ALL_DAYS.join(',')) { repeat.set('daily'); return; }
    for (const [value, days] of Object.entries(store.DAY_PRESETS)) {
      if (days.join(',') === now) { repeat.set(value); return; }
    }
    repeat.set('weekly');
  }

  /** 지금 주기에서 요일이 뜻을 갖는가 (매주·평일·주말) */
  function daysMatter() {
    const freq = repeat ? repeat.get() : '';
    return freq === 'weekly' || !!store.DAY_PRESETS[freq];
  }

  // --- 루틴 ---
  //
  // 매일 하는 일을 달력에 매일 막대로 그리면 정작 약속이 묻힌다.
  // 달력에서 빼고 오른쪽 '루틴' 에만 모은다.
  const routineBtn = h('button', 'cmp-routine');
  routineBtn.type = 'button';
  routineBtn.setAttribute('aria-pressed', 'false');
  routineBtn.append(
    h('span', 'cmp-routine__mark', ''),
    h('span', null, '루틴 — 달력에 표시하지 않음'),
  );
  let routineOn = false;
  /** '루틴' 입구로 연 폼인가 — 요일 칸을 늘 열어 둘지를 가른다 */
  let routineMode = false;
  routineBtn.addEventListener('click', () => {
    routineOn = !routineOn;
    routineBtn.classList.toggle('is-on', routineOn);
    routineBtn.setAttribute('aria-pressed', String(routineOn));
  });
  const routineField = field('', routineBtn);
  routineField.hidden = true;

  /**
   * 루틴 모드 — 약속용 칸을 걷어낸다.
   *
   * 루틴은 '언제 하루' 가 아니라 '얼마마다' 가 전부다. 시작·종료 날짜와 시각,
   * 기간 칩, 중요도, 링크는 쓸 일이 없는데 자리만 차지하고 눈을 흩뜨린다.
   * (시작일은 오늘로 조용히 잡는다 — 습관을 언제부터 할지 고르게 할 이유가 없다)
   */
  function applyRoutineMode(on) {
    routineMode = on;
    whenBox.hidden = on;
    prioField.hidden = on;
    linkField.hidden = on;
    // 반복은 루틴의 본질이라 '더보기' 뒤에 숨기지 않고 앞으로 꺼낸다.
    repeatField.querySelector('.cmp-field__label').textContent = on ? '주기' : '반복';
    // '루틴으로 만들기' 토글은 이미 루틴 모드이므로 보일 이유가 없다
    routineField.hidden = on || !repeat?.get();
    // '안 함' 은 루틴에서 뜻이 없다.
    // '매년' 도 마찬가지다 — 일 년에 한 번 하는 건 습관이 아니라 기념일이다.
    // (덕분에 주기 칩이 한 줄에 들어가서 루틴 폼은 스크롤 없이 유지된다)
    for (const value of ['', 'yearly']) {
      const btn = repeat?.button(value);
      if (btn) btn.hidden = on;
      if (on && repeat?.get() === value) repeat.set('daily');
    }

    moreBtn.hidden = on;
    form.classList.toggle('cmp--routine', on);
  }

  /** 반복 종류에 따라 요일·루틴 선택지를 보인다 */
  function syncRepeatExtras() {
    const freq = repeat ? repeat.get() : '';
    // 루틴은 '월·수·금 운동' 처럼 요일을 직접 고르는 일이 흔하다 — 늘 열어 둔다.
    // 일정에서는 반복 자체가 곁가지라 '매주' 를 골랐을 때만 꺼낸다.
    dayField.hidden = routineMode ? false : freq !== 'weekly';
    routineField.hidden = !freq || routineOn;
    if (!freq) {
      routineOn = false;
      routineBtn.classList.remove('is-on');
      routineBtn.setAttribute('aria-pressed', 'false');
    }
  }

  // 시각이 있는 일정에만 뜻이 있는 상대 알림('30분 전')은 시각을 넣으면 나타난다.
  const remind = chipGroup(REMIND_OPTIONS, '');

  /** 시작 시각 유무에 따라 알림 선택지를 바꾼다 */
  function syncRemindOptions() {
    const timed = !!startTimeIn.value;
    for (const [value] of REMIND_OPTIONS) {
      const btn = remind.button(value);
      if (!btn) continue;
      const relOnly = value.startsWith('-');
      btn.hidden = relOnly && !timed;
    }
    // 시각을 지웠는데 '30분 전'이 골라져 있으면 기준점이 없다 — 없음으로 되돌린다
    if (!timed && remind.get().startsWith('-')) remind.set('');
  }

  // ---------------------------------------------------------------- 태그·링크
  const tagsIn = h('input', 'cmp-input');
  tagsIn.type = 'text';
  tagsIn.placeholder = '태그 (공백으로 구분)';
  tagsIn.spellcheck = false;

  const tagSuggest = h('div', 'cmp-suggest');

  const linkIn = h('input', 'cmp-input');
  linkIn.type = 'text';
  linkIn.placeholder = '관련 링크 (예: meet.google.com/abc)';
  linkIn.spellcheck = false;

  // ---------------------------------------------------------------- 더보기
  // 처음 보는 사람에게 선택지를 한꺼번에 쏟지 않는다. 기본은 접어 둔다.
  const moreBox = h('div', 'cmp-more');
  const repeatField = field('반복', repeat.el);
  const linkField = field('링크', linkIn);

  moreBox.append(
    repeatField,
    dayField,
    routineField,
    field('알림', remind.el),
    field('태그', tagsIn),
    tagSuggest,
    linkField,
  );
  moreBox.hidden = true;

  const moreBtn = h('button', 'cmp-morebtn');
  moreBtn.type = 'button';
  moreBtn.append(h('span', null, '반복 · 알림 · 태그 · 링크'), icon('chevronRight'));
  moreBtn.addEventListener('click', () => {
    moreBox.hidden = !moreBox.hidden;
    moreBtn.classList.toggle('is-on', !moreBox.hidden);
    if (!moreBox.hidden) renderTagSuggest();
  });

  function renderTagSuggest() {
    tagSuggest.replaceChildren();
    const used = new Set(tagsIn.value.split(/[\s,]+/).filter(Boolean));
    for (const tag of store.allTags().slice(0, 12)) {
      if (used.has(tag)) continue;
      const b = h('button', 'cmp-suggest__tag', `#${tag}`);
      b.type = 'button';
      b.addEventListener('click', () => {
        tagsIn.value = `${tagsIn.value.trim()} ${tag}`.trim();
        renderTagSuggest();
      });
      tagSuggest.append(b);
    }
  }
  tagsIn.addEventListener('input', renderTagSuggest);

  // ---------------------------------------------------------------- 하단
  const err = h('div', 'cmp-err');
  err.hidden = true;

  const cancelBtn = h('button', 'cmp-btn cmp-btn--ghost', '취소');
  cancelBtn.type = 'button';
  const saveBtn = h('button', 'cmp-btn cmp-btn--primary', '일정 추가');
  saveBtn.type = 'submit';

  const foot = h('div', 'cmp-foot');
  foot.append(err, cancelBtn, saveBtn);

  // ---------------------------------------------------------------- 조립
  const head = h('div', 'cmp-head');
  const headTitle = h('span', 'cmp-head__title', '새 일정');
  head.append(headTitle);

  // 색과 중요도는 각각 한 줄을 차지할 만큼 크지 않다. 나란히 두면 줄 하나가 준다.
  const prioField = field('중요도', prio.el);
  const styleRow = h('div', 'cmp-row2');
  styleRow.append(field('색', swatches), prioField);

  form.append(
    head,
    titleIn,
    consumedTag,
    whenBox,
    styleRow,
    moreBtn,
    moreBox,
    foot,
  );

  // ---------------------------------------------------------------- 동작
  cancelBtn.addEventListener('click', () => close());
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

  /**
   * @param {{start?:string, end?:string, routine?:boolean}} [preset]
   *   routine — '루틴' 버튼으로 열었을 때. 반복·달력 숨김을 미리 켜 둔다.
   *   매일 하는 일을 만들려고 '반복 켜고 → 더보기 펼치고 → 루틴 누르고' 를
   *   매번 거치는 건 너무 멀다.
   */
  function open(preset) {
    const sel = store.getState().selectedDate;
    const start = preset?.start || sel;
    const end = preset?.end || start;

    titleIn.value = '';
    consumedTag.replaceChildren();
    clearTimeout(consumedTimer);
    startIn.value = start;
    endIn.value = end;
    startTimeIn.value = '';
    endTimeIn.value = '';
    linkIn.value = '';
    tagsIn.value = '';
    prio.set('0');
    repeat.set('');
    remind.set('');
    picked.clear();
    paintDays();
    routineOn = false;
    routineBtn.classList.remove('is-on');
    routineBtn.setAttribute('aria-pressed', 'false');
    syncRepeatExtras();
    dayChips.set(start === todayKey() ? 'today' : null);
    endIn.disabled = false;
    lenChips.el.classList.remove('is-disabled');
    for (const b of lenChips.el.children) b.disabled = false;
    moreBox.hidden = true;
    moreBtn.classList.remove('is-on');
    applyRoutineMode(false);
    err.hidden = true;
    saveBtn.textContent = preset?.routine ? '루틴 추가' : '일정 추가';
    pickedColor = 'blue';
    for (const k of Object.keys(swatchBtns)) swatchBtns[k].classList.toggle('is-on', k === 'blue');

    // '루틴' 으로 열었으면 매일 반복 + 달력에 표시 안 함을 미리 켠다
    if (preset?.routine) {
      repeat.set('daily');
      setDays(ALL_DAYS);   // '매일' 은 요일 칸에서 7일 전부로 보여야 한다
      routineOn = true;
      routineBtn.classList.add('is-on');
      routineBtn.setAttribute('aria-pressed', 'true');
      endIn.disabled = true;
      lenChips.el.classList.add('is-disabled');
      for (const b of lenChips.el.children) b.disabled = true;
      // 주기·요일은 루틴의 본질이라 접어 두지 않는다
      moreBox.hidden = false;
      moreBtn.classList.add('is-on');
    }
    applyRoutineMode(!!preset?.routine);
    syncRepeatExtras();
    headTitle.textContent = preset?.routine ? '새 루틴' : '새 일정';

    syncWhen();
    form.hidden = false;
    notifyToggle();
    titleIn.focus();
  }

  function close() {
    form.hidden = true;
    notifyToggle();
  }

  function fail(message, focusEl) {
    err.textContent = message;
    err.hidden = false;
    focusEl?.focus();
  }

  function normalizeLink(raw) {
    const v = String(raw || '').trim();
    if (!v) return '';
    const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
    try {
      const u = new URL(withProto);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      if (!u.hostname.includes('.')) return null;
      return u.href;
    } catch {
      return null;
    }
  }

  function submit() {
    // 마지막 낱말이 토큰이면(띄어쓰기 없이 Enter) 여기서 걷어낸다
    if (titleIn.value.trim()) {
      titleIn.value = titleIn.value.trim() + ' ';
      consumeTokens();
    }
    const title = titleIn.value.trim();
    if (!title) { fail('일정 이름을 적어 주세요.', titleIn); return; }

    // syncWhen 이 이미 시작/종료를 정리해 두므로 여기서 되돌릴 조합은 없다.
    // (종료가 앞서면 시작에 맞추고, 시각 조합도 그때 정돈된다)
    syncWhen();
    // 루틴은 '오늘부터' 다. 날짜 칸을 감췄으므로 값도 여기서 확정한다.
    const start = routineOn ? todayKey() : (startIn.value || store.getState().selectedDate);
    const freq = repeat.get();
    const end = freq ? start : (endIn.value || start);

    const link = normalizeLink(linkIn.value);
    if (link === null) { fail('링크 주소를 확인해 주세요.', linkIn); return; }

    store.addTask({
      title,
      start,
      end,
      startTime: startTimeIn.value || null,
      endTime: endTimeIn.value || null,
      link,
      color: pickedColor,
      priority: Number(prio.get()) || 0,
      remind: remind.get(),
      // '평일'·'주말' 은 여기서 요일을 고른 매주 반복으로 풀린다
      repeat: freq
        ? { ...store.repeatFreqDays(freq, [...picked].sort((a, b) => a - b)),
            interval: 1, routine: routineOn }
        : null,
      tags: tagsIn.value.split(/[\s,]+/).map((s) => s.replace(/^#/, '').trim()).filter(Boolean),
    });

    // 다른 날짜로 만들었으면 그 날로 따라간다.
    // 안 그러면 방금 만든 일정이 목록에 없어서 '사라졌다'고 느낀다.
    if (start !== store.getState().selectedDate) store.selectDate(start);

    close();
  }

  return { el: form, open, close, isOpen: () => !form.hidden };
}
