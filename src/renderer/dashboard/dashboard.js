// Zone C — D-Day 대시보드.
// 계약: export function createDashboard({ root, store }) -> { destroy() }
// 외부 라이브러리 없음. 순수 ES 모듈 + DOM API. 사용자 입력은 항상 textContent 로만 넣는다.
//
// 하는 일
//   store.pinnedTasks() 로 고정된 일정을 받아 '남은 시간'을 카드 한 줄로 시각화한다.
//   각 카드의 프로그레스 바 색은 남은 일수에 따라 쿨톤 → 웜톤으로 연속 보간된다.
//   패널 높이는 콘텐츠 높이가 그대로 되므로(셸이 flex: 0 0 auto) 한 줄 기준으로 설계했다.

import { fromKey, todayKey, WEEKDAY_LABELS } from '../lib/date.js';
import { icon } from '../lib/icons.js';

// ============================================================ 색온도 보간
//
// 남은 일수(0~30일)를 hue 로 매핑한다. 구간 사이는 선형 보간이라 하루가 지날 때마다
// 색이 '툭' 튀지 않고 조금씩 따뜻해진다.
//
// 신호등(청록-초록-노랑-빨강) 램프는 종이/잉크 팔레트 위에서 혼자 튄다.
// 그래서 hue 는 '잉크병' 범위(황토~버건디) 안에서만 움직이고,
// 시급함은 주로 '채도'로 표현한다 — 멀면 옅은 세피아, 임박하면 진한 버건디.
//
//   30일 이상 → 38 (옅은 황토)  14일 → 32 (세피아)  7일 → 22 (적갈)
//    3일      →  8 (적동)       0일 → 352 (버건디)  지난 항목 → var(--danger)
const HUE_STOPS = [
  [0, 352],
  [3, 8],
  [7, 22],
  [14, 32],
  [30, 38],
];

// 남은 날이 많을수록 채도를 떨어뜨려 '아직 멀었다'를 색의 옅음으로 표현한다.
// 0일 = 1.0(진한 잉크), 30일 = 0.34(물 탄 잉크)
function satScale(remaining) {
  const d = Math.min(30, Math.max(0, remaining));
  return 1 - 0.66 * (d / 30);
}

function hueFor(remaining) {
  const d = Math.min(30, Math.max(0, remaining));
  for (let i = 1; i < HUE_STOPS.length; i++) {
    const [d0, h0] = HUE_STOPS[i - 1];
    const [d1, h1] = HUE_STOPS[i];
    if (d <= d1) return h0 + ((h1 - h0) * (d - d0)) / (d1 - d0);
  }
  return HUE_STOPS[HUE_STOPS.length - 1][1];
}

/**
 * 라임(연두, 100도 부근) 구간만 채도를 낮춘다.
 * 앰버→초록 사이를 지나갈 때 형광 연두가 되면 무채색 유리 위에서 혼자 튄다.
 */
function satDip(hue) {
  return 14 * Math.exp(-((hue - 100) ** 2) / (2 * 28 ** 2));
}

// --- 인지 밝기 맞추기 ------------------------------------------------------
//
// hue 만 돌리고 명도를 고정하면 노랑·연두는 하얗게 뜨고 파랑·빨강은 가라앉는다.
// 특히 라이트 테마에서 연두색 바는 흰 배경에 그대로 묻힌다.
// 그래서 명도를 상수로 두지 않고, '목표 상대휘도'가 나오는 명도를 이분 탐색으로 찾는다.
// 결과적으로 어떤 hue 든 배경과의 대비가 거의 일정해진다.

const TARGET_Y_DARK = 0.30;   // 어두운 유리 위 — 밝게 떠 보이도록
const TARGET_Y_LIGHT = 0.20;  // 밝은 유리 위 — 충분히 가라앉도록

// 다크에서는 어떤 색이든 어차피 잘 보이므로, 휘도를 완전히 맞추면 앰버가 탁한 올리브가 된다.
// 절반만 보정해서 색의 성격(노랑은 노랗게, 빨강은 붉게)을 살린다.
// 라이트에서는 묻히면 끝이므로 보정을 그대로 적용한다.
const DARK_BLEND = 0.5;
const DARK_BASE_L = 58;

function hslToRgb(h, s, l) {
  const S = s / 100;
  const L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = L - c / 2;
  const seg = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][Math.floor(hp) % 6];
  return seg.map((v) => v + m);
}

/** WCAG 상대휘도 (0~1 정규화된 sRGB 입력) */
function relLuminance([r, g, b]) {
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 주어진 hue/채도에서 목표 휘도를 내는 명도(%)를 이분 탐색 */
function lightnessFor(hue, sat, targetY) {
  let lo = 4;
  let hi = 96;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (relLuminance(hslToRgb(hue, sat, mid)) < targetY) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// 남은 일수는 정수라 경우의 수가 적다. 렌더마다 다시 풀지 않도록 캐시한다.
const colorCache = new Map();

/**
 * 다크/라이트용 색을 각각 만든다.
 * CSS 는 테마를 알지만 hue 계산은 JS 쪽이므로, 두 벌을 커스텀 프로퍼티로 넘기고
 * 어느 쪽을 쓸지는 dashboard.css 의 :root[data-theme="light"] 규칙이 고른다.
 */
function ddayColors(remaining) {
  const key = Math.min(31, Math.max(-1, Math.round(remaining)));
  const hit = colorCache.get(key);
  if (hit) return hit;

  const hue = hueFor(key);
  const dip = satDip(hue);
  const scale = satScale(key);
  // 잉크 농도 — 임박할수록 진하게. 상한도 낮춰 형광빛이 되지 않게 한다.
  const satDark = (58 - dip) * scale;
  const satLight = (62 - dip * 0.6) * scale;
  const h = hue.toFixed(0);

  const lDark =
    lightnessFor(hue, satDark, TARGET_Y_DARK) * DARK_BLEND + DARK_BASE_L * (1 - DARK_BLEND);
  const lLight = lightnessFor(hue, satLight, TARGET_Y_LIGHT);

  const out = {
    dark: `hsl(${h}, ${satDark.toFixed(0)}%, ${lDark.toFixed(1)}%)`,
    light: `hsl(${h}, ${satLight.toFixed(0)}%, ${lLight.toFixed(1)}%)`,
  };
  colorCache.set(key, out);
  return out;
}

// ============================================================ 표시 문자열

/** 남은 일수 → 'D-15' / 'D-DAY' / 'D+3' */
function ddayLabel(remaining) {
  if (remaining === 0) return 'D-DAY';
  return remaining > 0 ? `D-${remaining}` : `D+${-remaining}`;
}

/** 목표일 → '8월 25일 (화)'. 해가 다르면 연도를 붙인다. */
function targetLabel(key) {
  const d = fromKey(key);
  const md = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY_LABELS[d.getDay()]})`;
  return d.getFullYear() !== fromKey(todayKey()).getFullYear()
    ? `${d.getFullYear()}년 ${md}`
    : md;
}

/** 자정까지 남은 ms. 날짜가 바뀌면 D-Day 가 하루 줄어야 하므로 그때 한 번만 다시 그린다. */
function msUntilNextMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2, 0);
  return Math.max(1000, next - now);
}

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

// ============================================================ 팩토리

export function createDashboard({ root, store }) {
  const COLORS = store.COLORS;

  // ---------------------------------------------------------- 정적 뼈대 (한 번만 생성)
  const el = h('div', 'dash-root');

  const head = h('div', 'dash-head');
  const labelEl = h('span', 'dash-label', 'D-DAY');
  const countEl = h('span', 'dash-count', '0개');

  // 접었을 때 헤더만 남으므로, 가장 임박한 항목 한 줄을 헤더에 요약해 둔다.
  const peek = h('span', 'dash-peek');
  const peekTitle = h('span', 'dash-peek__title');
  const peekNum = h('span', 'dash-peek__num');
  peek.append(peekTitle, peekNum);

  const spacer = h('span', 'dash-spacer');

  const foldBtn = h('button', 'dash-fold');
  foldBtn.type = 'button';
  const foldCaret = h('span', 'dash-fold__caret', '▾');
  const foldText = h('span', 'dash-fold__text', '접기');
  foldBtn.append(foldCaret, foldText);

  head.append(labelEl, countEl, peek, spacer, foldBtn);

  const body = h('div', 'dash-body');
  const grid = h('div', 'dash-grid');

  const empty = h('div', 'dash-empty');
  empty.append(
    h('span', 'dash-empty__title', '고정된 일정이 없습니다'),
    h(
      'span',
      'dash-empty__desc',
      '캘린더나 목록에서 중요한 일정을 고정하면 여기에 남은 기간이 표시됩니다.',
    ),
    h('span', 'dash-empty__how', "목록에서 일정을 눌러 펼친 뒤 'D-Day에 고정' 을 누르세요."),
  );

  body.append(grid, empty);
  el.append(head, body);
  root.append(el);

  // ---------------------------------------------------------- 끌어다 고정
  //
  // 목록이나 캘린더에서 일정을 여기로 떨어뜨리면 D-Day 에 고정된다.
  // 그전에는 항목을 펼쳐 'D-Day에 고정' 버튼을 찾아 누르는 길밖에 없었다.
  // 반복 일정과 날짜 없는 일정은 '남은 기간' 개념이 없어 대상이 아니다.

  const canPin = (task) => !!(task && !task.repeat && task.end);

  const isTaskDrag = (e) =>
    !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('application/x-task-id');

  el.addEventListener('dragover', (e) => {
    if (!isTaskDrag(e)) return;
    // 드래그 중에는 어떤 일정인지 읽을 수 없다(보안상 dragover 에서는 값이 비어 있다).
    // 받을 수 있는 자리라는 것만 알리고, 걸러 내기는 drop 에서 한다.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('is-drop');
  });

  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('is-drop');
  });

  el.addEventListener('drop', (e) => {
    el.classList.remove('is-drop');
    const dt = e.dataTransfer;
    if (!dt) return;
    const id = dt.getData('application/x-task-id') || dt.getData('text/plain');
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();

    const task = store.getState().tasks.find((t) => t.id === id);
    if (!canPin(task)) {
      toast(task?.repeat
        ? '반복 일정은 D-Day 에 고정할 수 없습니다'
        : '날짜가 있는 일정만 고정할 수 있습니다');
      return;
    }
    if (store.setPinned(id, true)) toast(`'${task.title || '일정'}' 을(를) 고정했습니다`, true);
    else toast('이미 고정된 일정입니다');
  });

  /** 셸이 토스트를 그린다. 뷰 모듈끼리 직접 부르지 않는다. */
  function toast(text, undo = false) {
    document.dispatchEvent(new CustomEvent('app:toast', { detail: { text, undo } }));
  }

  // ---------------------------------------------------------- 로컬 상태
  const cache = new Map(); // taskId -> 카드 레코드 (DOM 재사용)
  let collapsed = false; // 접힘은 DOM 로컬 상태 (store 에 새 키를 만들지 않는다)
  let rafId = 0;
  let midnightTimer = 0;
  let destroyed = false;

  // ---------------------------------------------------------- 카드 생성 / 갱신

  function createCard(id) {
    const card = h('article', 'dash-card');
    card.dataset.id = id;
    card.setAttribute('role', 'button');
    card.tabIndex = 0;

    const cardHead = h('div', 'dash-card__head');
    const dot = h('span', 'dash-card__dot');
    const title = h('span', 'dash-card__title');
    cardHead.append(dot, title);

    const num = h('div', 'dash-card__num');
    const date = h('div', 'dash-card__date');

    const track = h('div', 'dash-card__track');
    const fill = h('div', 'dash-card__fill');
    track.append(fill);

    const unpin = h('button', 'dash-unpin');
    unpin.append(icon('close'));
    unpin.type = 'button';
    unpin.title = '고정 해제';
    unpin.setAttribute('aria-label', '고정 해제');

    card.append(unpin, cardHead, num, date, track);

    const rec = { el: card, dot, title, num, date, fill, unpin, task: null };

    card.addEventListener('click', () => open(rec.task));
    card.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      open(rec.task);
    });
    unpin.addEventListener('click', (e) => {
      e.stopPropagation();
      if (rec.task) store.togglePinned(rec.task.id);
    });

    return rec;
  }

  /** 카드 클릭 → 해당 날짜로 이동하고 투두 패널에서 그 항목을 연다 */
  function open(task) {
    if (!task) return;
    const key = task.start || task.end;
    if (key) store.selectDate(key);
    store.setEditing(task.id);
  }

  function updateCard(rec, t) {
    rec.task = t;

    const label = ddayLabel(t.remaining);
    const target = targetLabel(t.end);
    const c = ddayColors(t.remaining);

    rec.el.style.setProperty('--dash-c', c.dark);
    rec.el.style.setProperty('--dash-c-lt', c.light);

    rec.el.classList.toggle('dash-card--over', t.overdue);
    rec.el.classList.toggle('dash-card--urgent', t.remaining <= 3);
    rec.el.classList.toggle('is-done', !!t.done);

    rec.dot.style.background = COLORS[t.color] || COLORS.blue;

    if (rec.title.textContent !== t.title) rec.title.textContent = t.title;
    if (rec.num.textContent !== label) rec.num.textContent = label;

    const dateText = t.overdue ? `${target} · 지남` : target;
    if (rec.date.textContent !== dateText) rec.date.textContent = dateText;

    // 지난 항목은 구간을 다 소진한 것이므로 바를 가득 채운다
    const pct = t.overdue ? 100 : Math.round(t.progress * 1000) / 10;
    const width = `${pct}%`;
    if (rec.fill.style.width !== width) rec.fill.style.width = width;

    rec.el.title = `${t.title} — ${label} (${target})`;
    rec.el.setAttribute('aria-label', `${t.title}, ${label}, 목표일 ${target}`);
  }

  // ---------------------------------------------------------- 렌더

  function render() {
    const items = store.pinnedTasks();
    const has = items.length > 0;

    countEl.textContent = `${items.length}개`;
    countEl.hidden = !has;
    grid.hidden = !has;
    empty.hidden = has;

    // 접힘 요약 — 가장 임박한 항목 하나
    if (has) {
      const first = items[0];
      const c = ddayColors(first.remaining);
      peek.style.setProperty('--dash-c', c.dark);
      peek.style.setProperty('--dash-c-lt', c.light);
      peek.classList.toggle('dash-peek--over', first.overdue);
      peekTitle.textContent = first.title;
      peekNum.textContent = ddayLabel(first.remaining);
      peek.hidden = false;
    } else {
      peek.hidden = true;
    }

    // 카드 재조정 — 뼈대는 재사용하고 순서만 맞춘다
    const seen = new Set();
    items.forEach((t, i) => {
      let rec = cache.get(t.id);
      if (!rec) {
        rec = createCard(t.id);
        cache.set(t.id, rec);
      }
      updateCard(rec, t);
      seen.add(t.id);
      if (grid.children[i] !== rec.el) grid.insertBefore(rec.el, grid.children[i] || null);
    });
    for (const [id, rec] of cache) {
      if (seen.has(id)) continue;
      rec.el.remove();
      cache.delete(id);
    }

    // 접힘 상태 반영
    el.classList.toggle('is-collapsed', collapsed);
    foldText.textContent = collapsed ? '펴기' : '접기';
    foldBtn.title = collapsed ? 'D-Day 패널 펴기' : 'D-Day 패널 접기';
    foldBtn.setAttribute('aria-expanded', String(!collapsed));
  }

  function scheduleRender() {
    if (destroyed || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render();
    });
  }

  // 상시 구동 위젯이라 1초 타이머는 돌리지 않는다. 다음 자정에 딱 한 번 깨어나
  // 다시 그리고, 그 자리에서 그 다음 자정을 예약한다(절전/시계 변경도 자동 보정).
  function scheduleMidnight() {
    clearTimeout(midnightTimer);
    midnightTimer = setTimeout(() => {
      midnightTimer = 0;
      if (destroyed) return;
      render();
      scheduleMidnight();
    }, msUntilNextMidnight());
  }

  // ---------------------------------------------------------- 이벤트
  foldBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    render();
  });

  const unsubscribe = store.subscribe(scheduleRender);

  render();
  scheduleMidnight();

  // ---------------------------------------------------------- 정리
  return {
    destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      clearTimeout(midnightTimer);
      midnightTimer = 0;
      unsubscribe();
      cache.clear();
      root.textContent = '';
    },
  };
}
