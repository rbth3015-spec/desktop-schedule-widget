// 항목 상세 — 오른쪽 면을 통째로 쓰는 화면 (핸드오프 '항목 상세').
//
// 예전에는 목록 한가운데서 항목을 펼쳐 고쳤다. 좁은 면에서 상세가 절반을 먹으면
// 나머지 목록이 밀려나고, 지금 무엇을 고치는지도 흐려졌다(그래서 '집중 모드' 를 뒀었다).
// 시안은 이걸 아예 한 화면으로 뺐다 — 제목이 곧 입력칸이고, 값은 한 줄에 하나다.
//
// 값 줄은 '보이는 값' 이 전부다. 누르면 그 자리에서 고른다(메뉴 · 칩 · 입력칸).
// 같은 값을 두 번 두지 않는다 — 보이는 그 글자를 바로 고친다.

import { addDays, fromKey, weekGrid, timeMinutes } from '../lib/date.js';
import { remindLabel } from '../reminders.js';
import { showContextMenu } from '../lib/menu.js';
import { icon } from '../lib/icons.js';
import { whenSummary } from './compose.js';
import {
  h, setValueSafe, shortDate, screenHead, fieldLabel, dateField, timeField,
  normalizeLink, openLink, linkLabel,
} from './ui.js';

const ORD = ['첫째', '둘째', '셋째', '넷째', '다섯째', '여섯째'];

/** 날짜 없는 항목이 어디에 적혀 있는지 — '9월 넷째 주 목표' · '9월 목표' · '언젠가' */
function planLabel(plan) {
  if (plan?.startsWith('w:')) {
    const mid = fromKey(weekGrid(plan.slice(2))[3]);
    return `${mid.getMonth() + 1}월 ${ORD[Math.floor((mid.getDate() - 1) / 7)]} 주 목표 · 날짜 없음`;
  }
  if (plan?.startsWith('m:')) return `${Number(plan.slice(7, 9))}월 목표 · 날짜 없음`;
  return '언젠가 · 날짜 없음';
}

// 알림 — '-Nm' 은 시작 시각 N분 전이라 시각이 있어야 뜻이 있다
const REMIND_CHOICES = [
  ['', '없음'],
  ['-10m', '10분 전', true],
  ['-30m', '30분 전', true],
  ['-60m', '1시간 전', true],
  ['0@09:00', '당일 오전 9시'],
  ['0@12:00', '당일 정오'],
  ['0@18:00', '당일 오후 6시'],
  ['1@18:00', '하루 전 오후 6시'],
  ['3@18:00', '3일 전 오후 6시'],
  ['7@18:00', '일주일 전 오후 6시'],
];

// 반복 — 평일·주말·격일은 저장 규칙이 아니라 화면에서 부르는 이름이다(store.repeatFreqDays)
const REPEAT_CHOICES = [
  ['', '없음'], ['daily', '매일'], ['alternate', '격일'],
  ['weekdays', '평일'], ['weekends', '주말'],
  ['weekly', '매주'], ['monthly', '매월'], ['yearly', '매년'],
];

/**
 * @param {{store: object, onPlan: (task:object)=>void, notify: (text:string)=>void}} deps
 * @returns {{el: HTMLElement, update: (task:object)=>void, flush: ()=>void}}
 */
/** 분 → 'HH:MM' (자정을 넘기면 23:59 에서 멈춘다 — 끝이 시작보다 앞서면 안 된다) */
function clock(m) {
  const v = Math.min(Math.max(0, m), 23 * 60 + 59);
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

export function createDetail({ store, onPlan, notify }) {
  const el = h('section', 'dt scr');
  el.hidden = true;
  el.setAttribute('aria-label', '항목 상세');

  /** 지금 보고 있는 항목 (반복 회차면 그날치 사본) */
  let task = null;
  const id = () => task?.id;
  const close = () => store.setEditing(null);

  const head = screenHead('항목 상세', close);
  const body = h('div', 'scr-body');

  // ---------------------------------------------------------------- 제목
  const titleIn = h('input', 'scr-titlein');
  titleIn.type = 'text';
  titleIn.spellcheck = false;
  titleIn.placeholder = '일정 이름';
  titleIn.setAttribute('aria-label', '일정 이름');
  const commitTitle = () => {
    const v = titleIn.value.trim();
    if (!task) return;
    if (!v) { titleIn.value = task.title || ''; return; }
    if (v !== task.title) store.updateTask(id(), { title: v });
  };
  titleIn.addEventListener('change', commitTitle);
  titleIn.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); titleIn.blur(); }
    // Esc 는 고치던 글자를 되돌린다. 화면을 닫는 일은 앱 전역 Esc 가 이어서 한다.
    if (e.key === 'Escape') titleIn.value = task?.title || '';
  });
  // 제목이 곧 입력칸이다. 설명을 달지 않고, 커서를 올리면 밑줄이 금박으로 바뀌어 보여 준다.
  const titleBox = h('div');
  titleBox.append(titleIn);

  // ---------------------------------------------------------------- 시작 · 종료
  const startDate = dateField({
    onPick: (v) => {
      if (!task) return;
      if (!v) store.updateTask(id(), { start: null, end: null });
      else store.updateTask(id(), { start: v });
    },
  });
  startDate.setLabel('시작 날짜');
  // 시작 시각을 옮기면 끝이 같은 길이로 따라온다(추가 화면과 같은 규칙) — 14:00–15:30 → 16:00–17:30
  const startTime = timeField({
    label: '시작 시각 (비우면 종일)',
    onCommit: (v) => {
      if (!task) return;
      const patch = { startTime: v || null };
      const before = timeMinutes(task.startTime);
      const now = timeMinutes(v);
      const end = timeMinutes(task.endTime);
      const oneDay = (task.end || task.start) === task.start;
      if (before != null && now != null && end != null && oneDay && end > before) {
        patch.endTime = clock(now + (end - before));
      }
      store.updateTask(id(), patch);
    },
  });
  const endDate = dateField({
    onPick: (v) => {
      if (!task?.start) return;
      // 종료가 시작보다 빠르면 막지 않고 시작에 맞춘다 (추가 폼과 같은 규칙)
      store.updateTask(id(), { end: v && v >= task.start ? v : task.start });
    },
  });
  endDate.setLabel('종료 날짜');
  const endTime = timeField({
    label: '종료 시각',
    onCommit: (v) => task && store.updateTask(id(), { endTime: v || null }),
  });

  function whenBox(label, d, t) {
    const wrap = h('div');
    const box = h('div', 'scr-dt');
    box.append(d.el, h('span', 'scr-dt__sep'), t.el);
    wrap.append(fieldLabel(label), box);
    return wrap;
  }
  const whenGrid = h('div', 'scr-when');
  whenGrid.append(whenBox('시작', startDate, startTime), whenBox('종료', endDate, endTime));

  // 끝나는 시각을 30분 · 1시간씩 뒤로 — 누를 때마다 더해진다(추가 화면과 같은 단추)
  const steps = h('div', 'dt-steps');
  const stepBtns = [[30, '+30분'], [60, '+1시간']].map(([m, label]) => {
    const b = h('button', 'scr-chip scr-chip--len num', label);
    b.type = 'button';
    b.title = '끝나는 시각을 그만큼 뒤로';
    b.addEventListener('click', () => {
      const st = timeMinutes(task?.startTime);
      if (st == null) return;
      const cur = timeMinutes(task.endTime);
      const oneDay = (task.end || task.start) === task.start;
      const base = cur != null && (!oneDay || cur > st) ? cur : st;
      store.updateTask(id(), { endTime: clock(base + m) });
    });
    steps.append(b);
    return b;
  });

  // 무엇으로 저장돼 있는지 한 줄로 되읽어 준다 — 추가 폼과 같은 문구
  const summary = h('div', 'scr-summary');
  summary.setAttribute('aria-live', 'polite');

  // ---------------------------------------------------------------- 값 줄
  const rows = h('div', 'dt-rows');

  /**
   * 라벨 64px + 값. onClick 이 있으면 줄 전체가 버튼이다.
   * '눌러서 변경' 같은 글을 달지 않는다 — 오른쪽 끝의 작은 ⌄ 와 hover 금박이 누를 수 있다고 말한다.
   */
  function valueRow(label, onClick) {
    const row = h('div', 'dt-row');
    const key = h('span', 'dt-row__key', label);
    const val = h('span', 'dt-row__val');
    const value = h('span', 'dt-row__value');
    const hint = h('span', 'dt-row__hint');
    val.append(value, hint);
    row.append(key, val);
    if (onClick) {
      const more = h('span', 'dt-row__more');
      more.append(icon('chevronDown', 10, 1.4));
      val.append(more);
      row.classList.add('is-action');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.addEventListener('click', (e) => {
        if (e.target.closest('input, .dt-row__open, .dt-swatches')) return;
        onClick(row);
      });
      row.addEventListener('keydown', (e) => {
        if (e.target !== row) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(row); }
      });
    }
    rows.append(row);
    return { row, key, value, hint, val };
  }

  /** 줄 아래에서 메뉴를 연다 */
  function menuAt(row, items) {
    const r = row.getBoundingClientRect();
    const v = row.querySelector('.dt-row__val').getBoundingClientRect();
    showContextMenu(v.left, r.bottom + 2, items);
  }

  // 색 — 누르면 줄 아래에 안료 여섯이 펼쳐진다
  const colorRow = valueRow('색', () => {
    swatches.hidden = !swatches.hidden;
  });
  const swatches = h('div', 'dt-swatches');
  swatches.hidden = true;
  const swatchBtns = {};
  for (const key of Object.keys(store.COLORS)) {
    const b = h('button', 'scr-swatch');
    b.type = 'button';
    b.title = store.COLOR_LABELS[key];
    b.setAttribute('aria-label', store.COLOR_LABELS[key]);
    const chipColor = h('span', 'scr-swatch__ink');
    chipColor.style.background = store.COLORS[key];
    b.append(chipColor);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (task) store.updateTask(id(), { color: key });
      swatches.hidden = true;
    });
    swatchBtns[key] = b;
    swatches.append(b);
  }
  colorRow.val.append(swatches);

  // 중요도
  const prioRow = valueRow('중요도', (row) => {
    menuAt(row, store.PRIORITY_MARKS.map((label, i) => ({
      label,
      checked: (task?.priority || 0) === i,
      onSelect: () => store.updateTask(id(), { priority: i }),
    })));
  });

  // 반복
  const repeatRow = valueRow('반복', (row) => {
    const cur = store.repeatChoice(task?.repeat);
    menuAt(row, REPEAT_CHOICES.map(([value, label]) => ({
      label,
      checked: cur === value,
      onSelect: () => applyRepeat(value),
    })));
  });

  function applyRepeat(choice, until) {
    if (!task) return;
    if (!choice) { store.setRepeat(id(), null); return; }
    // 이 줄에서 고칠 수 없는 것(고른 요일 · 루틴 여부 · 종료일)은 그대로 이어 간다.
    // 여기서 빠뜨리면 반복 종료일만 바꿨는데 루틴이 달력으로 튀어나온다.
    const prev = store.getState().tasks.find((t) => t.id === id())?.repeat;
    const picked = choice === 'weekly' ? prev?.days : null;
    // 주기를 그대로 두고 종료일만 바꾸는 경우엔 '몇 주마다' 도 그대로 둔다
    const same = store.repeatChoice(prev) === choice;
    store.setRepeat(id(), {
      ...store.repeatFreqDays(choice, picked),
      ...(same && prev?.interval ? { interval: prev.interval } : {}),
      until: until !== undefined ? until : (prev?.until || null),
      routine: !!prev?.routine,
    });
  }

  // 반복 종료 — 반복일 때만
  const untilField = dateField({
    format: (k) => `${shortDate(k)}까지`,
    onPick: (v) => applyRepeat(store.repeatChoice(task?.repeat), v || null),
  });
  untilField.setLabel('반복 종료일');
  const untilRow = valueRow('반복 종료', () => untilField.el.click());
  untilRow.value.append(untilField.el);

  // 체크 방식 — 이틀 이상짜리 계획일 때만
  const checkRow = valueRow('체크', (row) => {
    menuAt(row, [
      { label: '끝나면 한 번', checked: !task?.dailyCheck, onSelect: () => store.setDailyCheck(id(), false) },
      { label: '날마다', checked: !!task?.dailyCheck, onSelect: () => store.setDailyCheck(id(), true) },
    ]);
  });

  // 알림
  const remindRow = valueRow('알림', (row) => {
    const timed = !!task?.startTime;
    menuAt(row, REMIND_CHOICES.map(([value, label, rel]) => ({
      label,
      checked: (task?.remind || '') === value,
      disabled: rel && !timed,
      // 바꾸면 '이미 알림' 표시를 지워 새 시각에 다시 알리게 한다
      onSelect: () => store.updateTask(id(), { remind: value, remindedAt: null }),
    })));
  });

  // 태그 — 누르면 그 자리가 입력칸이 된다
  const tagRow = valueRow('태그', () => startInline(tagRow, (task?.tags || []).join(' '),
    '공백으로 구분', (raw) => {
      const tags = raw.split(/[\s,]+/).map((s) => s.replace(/^#/, '').trim()).filter(Boolean);
      const cur = task?.tags || [];
      if (tags.join('\u0000') !== cur.join('\u0000')) store.updateTask(id(), { tags });
    }));

  // 링크 — 값을 누르면 고치고, ↗ 를 누르면 기본 브라우저로 연다
  const linkRow = valueRow('링크', () => startInline(linkRow, task?.link || '',
    'meet.google.com/abc', (raw) => {
      const next = normalizeLink(raw);
      if (next === null) { notify('링크 주소를 확인해 주세요'); return; }
      if (next !== (task?.link || '')) store.updateTask(id(), { link: next });
    }));
  const linkOpen = h('button', 'dt-row__open');
  linkOpen.type = 'button';
  linkOpen.title = '브라우저로 열기';
  linkOpen.setAttribute('aria-label', '브라우저로 열기');
  linkOpen.append(icon('external', 11, 1.4));
  linkOpen.addEventListener('click', (e) => {
    e.stopPropagation();
    if (task?.link) openLink(task.link);
  });
  linkRow.hint.replaceWith(linkOpen);

  /** 값 칸을 잠깐 입력칸으로 바꾼다. Enter · 바깥 누름이면 저장, Esc 면 취소. */
  function startInline(row, initial, placeholder, onSave) {
    if (row.value.querySelector('input')) return;
    const input = h('input', 'dt-row__input');
    input.type = 'text';
    input.spellcheck = false;
    input.value = initial;
    input.placeholder = placeholder;
    row.value.replaceChildren(input);
    row.value.classList.add('is-editing');
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      row.value.classList.remove('is-editing');
      if (save) onSave(input.value);
      if (task) update(task);
    };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  // ---------------------------------------------------------------- 메모
  const notes = h('textarea', 'scr-notes');
  notes.rows = 3;
  notes.setAttribute('aria-label', '메모');
  let notesTimer = 0;
  let pendingNotes = null;
  function flush() {
    clearTimeout(notesTimer);
    if (!pendingNotes) return;
    const { taskId, value } = pendingNotes;
    pendingNotes = null;
    store.updateTask(taskId, { notes: value });
  }
  notes.addEventListener('input', () => {
    if (!task) return;
    pendingNotes = { taskId: id(), value: notes.value };
    clearTimeout(notesTimer);
    notesTimer = setTimeout(flush, 300);
  });
  notes.addEventListener('blur', flush);
  const notesBox = h('div');
  notesBox.append(fieldLabel('메모'), notes);

  // ---------------------------------------------------------------- 동작
  const acts = h('div', 'dt-acts');
  function act(label, cls, fn) {
    const b = h('button', `scr-chip ${cls || ''}`.trim(), label);
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    acts.append(b);
    return b;
  }
  const doneBtn = act('완료로 표시', 'scr-chip--gold', () => {
    if (task) store.toggleDone(id(), task.occDate);
  });
  const deferBtn = act('내일로 미루기', '', () => {
    if (!task?.start || task.repeat) return;
    store.moveTask(id(), addDays(task.start, 1));
    notify(`'${task.title || '일정'}' 을(를) 내일로 미뤘습니다`);
  });
  const pinBtn = act('D-Day 고정', '', () => task && store.togglePinned(id()));
  const planBtn = act('마감까지 계획', '', () => task && onPlan(task));
  planBtn.title = '오늘부터 마감 전날까지, 하루하루 체크할 계획을 만듭니다';
  act('복제', '', () => {
    const copy = task && store.duplicateTask(id());
    if (copy) store.setEditing(copy.id);
  });
  const delBtn = act('삭제', 'scr-chip--seal', () => {
    if (!task) return;
    const t = task;
    close();
    // 반복 일정은 이 회차만 건너뛴다. 규칙째 지우려면 '반복 전체 삭제'.
    store.removeTask(t.id, t.occDate);
  });
  const seriesBtn = act('반복 전체 삭제', 'scr-chip--seal', () => {
    if (!task) return;
    const taskId = id();
    close();
    store.removeSeries(taskId);
  });

  body.append(titleBox, whenGrid, steps, summary, rows, notesBox, acts);
  el.append(head.el, body);

  // ---------------------------------------------------------------- 그리기
  function paintValue(rowRec, text, color) {
    if (rowRec.value.classList.contains('is-editing')) return;
    rowRec.value.textContent = text;
    rowRec.value.style.color = color || '';
  }

  function update(next) {
    task = next;
    if (!task) return;

    setValueSafe(titleIn, task.title || '');

    startDate.set(task.start, '날짜 없음');
    endDate.set(task.end || task.start, '—');
    // 날짜 없는 '언젠가' 항목에는 시각을 붙일 자리가 없다.
    // 종료 시각은 시작 시각이 있어야 뜻이 생기고, 반복 일정은 당일짜리다.
    endDate.setDisabled(!task.start || !!task.repeat);
    startTime.set(task.startTime || '');
    endTime.set(task.endTime || '');
    startTime.setDisabled(!task.start);
    endTime.setDisabled(!task.start || !task.startTime);
    for (const b of stepBtns) b.disabled = !task.start || !task.startTime;

    summary.textContent = task.start
      ? whenSummary({
          start: task.start,
          end: task.end || task.start,
          startTime: task.startTime,
          endTime: task.endTime,
          freq: store.repeatChoice(task.repeat),
          dailyCheck: !!task.dailyCheck,
        })
      : planLabel(task.plan);

    const colorKey = store.COLORS[task.color] ? task.color : 'blue';
    paintValue(colorRow, store.COLOR_LABELS[colorKey], store.COLORS[colorKey]);
    for (const key of Object.keys(swatchBtns)) swatchBtns[key].classList.toggle('is-on', key === colorKey);

    const p = task.priority || 0;
    paintValue(prioRow, store.PRIORITY_MARKS[p], p > 0 ? 'var(--seal)' : 'var(--ink-soft)');

    const rp = task.repeat;
    paintValue(repeatRow, rp
      ? `${store.repeatLabel(rp)}${rp.routine ? ' · 루틴' : ''}`
      : '없음', rp ? 'var(--ink)' : 'var(--ink-soft)');

    untilRow.row.hidden = !rp;
    untilField.set(rp?.until || '', '계속');

    // 체크 방식은 기간이 이틀 이상일 때만 물을 것이 있다
    const isSpan = !rp && task.start && task.end && task.end > task.start;
    checkRow.row.hidden = !isSpan;
    if (isSpan) {
      const prog = store.spanProgress(task);
      paintValue(checkRow, task.dailyCheck
        ? `날마다${prog ? ` · ${prog.done}/${prog.total}일` : ''}`
        : '끝나면 한 번', 'var(--ink)');
    }

    paintValue(remindRow, task.remind ? remindLabel(task.remind) : '없음',
      task.remind ? 'var(--ink)' : 'var(--ink-soft)');

    paintValue(tagRow, task.tags.length ? task.tags.map((t) => `#${t}`).join('  ') : '없음',
      task.tags.length ? 'var(--ink)' : 'var(--ink-soft)');

    paintValue(linkRow, task.link ? linkLabel(task.link) : '없음',
      task.link ? 'var(--gold-deep)' : 'var(--ink-soft)');
    linkOpen.hidden = !task.link;

    setValueSafe(notes, task.notes || '');

    doneBtn.textContent = task.done ? '완료 취소' : '완료로 표시';
    // 날짜가 없으면 밀 곳이 없고, 반복 일정은 규칙째 움직이면 안 된다
    deferBtn.hidden = !task.start || !!task.repeat;
    // 반복 일정은 '남은 기간' 개념이 없어 D-Day 고정 대상이 아니다
    pinBtn.hidden = !!task.repeat || !task.end;
    pinBtn.textContent = task.pinned ? 'D-Day 고정 해제' : 'D-Day 고정';
    planBtn.hidden = !store.canPlanDeadline(task);
    delBtn.textContent = task.repeat && task.occDate ? '이 회차 건너뛰기' : '삭제';
    seriesBtn.hidden = !task.repeat;
  }

  return {
    el,
    update,
    flush,
    setBack: (label) => { head.back.textContent = label; },
    focusTitle() { titleIn.focus(); },
  };
}

