// 일정 추가 폼.
//
// 빠른 입력(@내일 ~3d #태그)은 익힌 사람에게는 빠르지만, 처음 쓰는 사람에게는
// 외워야 할 문법이다. 이 폼은 문법을 전혀 몰라도 **누르기만 해서** 일정을 만들 수 있는
// 기본 경로다. 모든 선택지가 눈에 보이는 것이 핵심 — 숨은 규칙이 없어야 한다.

import { todayKey, addDays, fromKey, WEEKDAY_LABELS } from '../lib/date.js';
import { icon } from '../lib/icons.js';

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
 * @returns {{el:HTMLElement, get:()=>string, set:(v:string)=>void}}
 */
function chipGroup(options, initial, onChange) {
  const el = h('div', 'cmp-chips');
  let value = initial;
  const buttons = new Map();

  for (const [val, label] of options) {
    const b = h('button', 'cmp-chip', label);
    b.type = 'button';
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

  return { el, get: () => value, set };
}

/** '8월 20일 (목)' */
function pretty(key) {
  if (!key) return '';
  const d = fromKey(key);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY_LABELS[d.getDay()]})`;
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

const REPEAT_OPTIONS = [
  ['', '안 함'], ['daily', '매일'], ['weekly', '매주'],
  ['monthly', '매월'], ['yearly', '매년'],
];

const REMIND_OPTIONS = [
  ['', '없음'],
  ['0@09:00', '당일 아침'],
  ['0@18:00', '당일 저녁'],
  ['1@18:00', '하루 전'],
  ['7@18:00', '일주일 전'],
];

const COLOR_NAMES = {
  blue: '청람', green: '쑥', amber: '치자', rose: '다홍', violet: '자주', slate: '회묵',
};

/**
 * @param {{store: object}} deps
 * @returns {{el:HTMLElement, open:(preset?:{start:string,end:string})=>void, close:()=>void, isOpen:()=>boolean}}
 */
export function createCompose({ store }) {
  const form = h('form', 'cmp');
  form.hidden = true;

  // ---------------------------------------------------------------- 제목
  const titleIn = h('input', 'cmp-title');
  titleIn.type = 'text';
  titleIn.placeholder = '무엇을 할 예정인가요?';
  titleIn.required = true;
  titleIn.spellcheck = false;

  // ---------------------------------------------------------------- 날짜
  const startIn = h('input', 'cmp-date');
  startIn.type = 'date';

  const startLabel = h('span', 'cmp-datelabel');

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
      startIn.value = map[v];
      syncDates();
    }
  );

  const startRow = h('div', 'cmp-row');
  startRow.append(startIn, startLabel);

  // --- 기간 ---
  const spanToggle = h('button', 'cmp-toggle');
  spanToggle.type = 'button';
  spanToggle.append(icon('plus'), h('span', null, '여러 날에 걸쳐'));

  const endIn = h('input', 'cmp-date');
  endIn.type = 'date';
  const endLabel = h('span', 'cmp-datelabel');

  const lenChips = chipGroup(
    [['1', '2일'], ['2', '3일'], ['4', '5일'], ['6', '1주']],
    null,
    (v) => {
      endIn.value = addDays(startIn.value || todayKey(), Number(v));
      syncDates();
    }
  );

  const endRow = h('div', 'cmp-row');
  endRow.append(endIn, endLabel);

  const spanBox = h('div', 'cmp-span');
  spanBox.append(field('마지막 날', endRow), lenChips.el);
  spanBox.hidden = true;

  let spanOn = false;
  spanToggle.addEventListener('click', () => {
    setSpan(!spanOn);
    if (spanOn) {
      if (!endIn.value || endIn.value < startIn.value) endIn.value = addDays(startIn.value, 1);
      syncDates();
    }
  });

  function setSpan(on) {
    spanOn = on;
    spanBox.hidden = !on;
    spanToggle.classList.toggle('is-on', on);
    spanToggle.querySelector('span').textContent = on ? '하루만' : '여러 날에 걸쳐';
  }

  startIn.addEventListener('change', () => {
    dayChips.set(null);
    if (spanOn && endIn.value && endIn.value < startIn.value) endIn.value = startIn.value;
    syncDates();
  });
  endIn.addEventListener('change', () => { lenChips.set(null); syncDates(); });

  function syncDates() {
    startLabel.textContent = pretty(startIn.value);
    endLabel.textContent = pretty(endIn.value);
  }

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
  const repeat = chipGroup(REPEAT_OPTIONS, '', (v) => {
    // 반복은 당일 일정만 지원한다 — 켜면 기간을 접는다
    if (v) setSpan(false);
    spanToggle.disabled = !!v;
    spanToggle.classList.toggle('is-disabled', !!v);
  });

  const remind = chipGroup(REMIND_OPTIONS, '');

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
  moreBox.append(
    field('반복', repeat.el),
    field('알림', remind.el),
    field('태그', tagsIn),
    tagSuggest,
    field('링크', linkIn),
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
  head.append(h('span', 'cmp-head__title', '새 일정'));

  form.append(
    head,
    titleIn,
    field('언제', dayChips.el),
    startRow,
    spanToggle,
    spanBox,
    field('색', swatches),
    field('중요도', prio.el),
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

  function open(preset) {
    const sel = store.getState().selectedDate;
    const start = preset?.start || sel;
    const end = preset?.end || start;

    titleIn.value = '';
    startIn.value = start;
    endIn.value = end;
    linkIn.value = '';
    tagsIn.value = '';
    prio.set('0');
    repeat.set('');
    remind.set('');
    dayChips.set(start === todayKey() ? 'today' : null);
    lenChips.set(null);
    spanToggle.disabled = false;
    spanToggle.classList.remove('is-disabled');
    setSpan(end > start);
    moreBox.hidden = true;
    moreBtn.classList.remove('is-on');
    err.hidden = true;
    pickedColor = 'blue';
    for (const k of Object.keys(swatchBtns)) swatchBtns[k].classList.toggle('is-on', k === 'blue');

    syncDates();
    form.hidden = false;
    titleIn.focus();
  }

  function close() {
    form.hidden = true;
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
    const title = titleIn.value.trim();
    if (!title) { fail('일정 이름을 적어 주세요.', titleIn); return; }

    const start = startIn.value || store.getState().selectedDate;
    const end = spanOn && endIn.value ? endIn.value : start;
    if (end < start) { fail('마지막 날이 시작일보다 빠릅니다.', endIn); return; }

    const link = normalizeLink(linkIn.value);
    if (link === null) { fail('링크 주소를 확인해 주세요.', linkIn); return; }

    const freq = repeat.get();
    store.addTask({
      title,
      start,
      end: freq ? start : end,
      link,
      color: pickedColor,
      priority: Number(prio.get()) || 0,
      remind: remind.get(),
      repeat: freq ? { freq, interval: 1 } : null,
      tags: tagsIn.value.split(/[\s,]+/).map((s) => s.replace(/^#/, '').trim()).filter(Boolean),
    });

    // 다른 날짜로 만들었으면 그 날로 따라간다.
    // 안 그러면 방금 만든 일정이 목록에 없어서 '사라졌다'고 느낀다.
    if (start !== store.getState().selectedDate) store.selectDate(start);

    close();
  }

  return { el: form, open, close, isOpen: () => !form.hidden };
}
