// Zone D — 퀵 런처 도크.
// 계약: export function createLauncher({ root, store }) -> { destroy() }
//
// 외부 라이브러리 없음. 순수 ES 모듈 + DOM API.
// 실행 대상 검증(URL 스킴 / 확장자 / 절대경로)은 전부 메인 프로세스(runner.js)가 한다.
// 렌더러는 경로를 조립하거나 셸 문자열을 만들지 않고, 항목 객체를 그대로 넘기고
// 돌아온 에러 문구를 사용자에게 보여주기만 한다.
//
// 스크립트 출력과 항목 이름은 신뢰할 수 없는 문자열이므로 언제나 textContent 로만 넣는다.

import { icon } from '../lib/icons.js';

// ============================================================ 상수

/** runner.js 의 INTERPRETERS 와 같은 목록. 편집 UI 힌트로만 쓴다. */
const SUPPORTED_EXT = '.py .pyw .ps1 .bat .cmd .js .exe';

const KIND_ORDER = ['url', 'script', 'app', 'folder'];
const KIND_LABELS = { url: '웹주소', script: '스크립트', app: '앱', folder: '폴더' };
/** 사용자가 아이콘을 지정하지 않았을 때 쓰는 기본 선 아이콘 */
const KIND_ICONS = { url: 'globe', script: 'terminal', app: 'plus', folder: 'folder' };
/**
 * 도크 전체의 판 색을 정한다.
 *
 * 기본은 이름 해시라 같은 이름이면 늘 같은 색이지만, 안료가 여섯 개뿐이라
 * 서넛만 있어도 옆자리와 색이 겹친다. 겹치면 나란히 놓였을 때 구분이 안 되므로
 * **바로 앞 항목과 같은 색일 때만** 다음 안료로 한 칸 민다.
 * 충돌이 없으면 순서를 바꿔도 색이 그대로다.
 */
function assignPigments(items, palette) {
  const keys = Object.keys(palette);
  const out = new Map();
  let prev = null;

  for (const item of items) {
    const base = keys.indexOf(pigmentKeyFor(item.label || item.target || item.id, keys));
    let idx = base;
    if (keys[idx] === prev) idx = (idx + 1) % keys.length;
    prev = keys[idx];
    out.set(item.id, palette[keys[idx]]);
  }
  return out;
}

/** 이름 → 안료 키 (해시). 같은 이름이면 언제나 같은 값. */
function pigmentKeyFor(text, keys) {
  let h = 0;
  for (const ch of String(text || '')) h = (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0;
  return keys[h % keys.length];
}

/**
 * 이니셜 — 판 위에 새길 글자.
 *
 * 한 글자만 새기면 '주간 백업'도 '주소록'도 똑같이 '주' 라 무엇인지 알 수 없다.
 * 두 글자까지 보여 주면 도크만 훑어도 구분이 된다.
 * 여러 낱말이면 각 낱말의 첫 글자를 딴다('주간 백업' → '주백' 이 아니라 '주간' 이
 * 더 읽히므로, 첫 낱말이 두 글자 이상이면 그 앞 두 글자를 쓴다).
 */
function monogramOf(label) {
  const t = String(label || '').trim();
  if (!t) return '·';

  const words = t.split(/\s+/).filter(Boolean);
  const first = [...words[0]];

  // 라틴/숫자는 대문자 두 글자
  if (/[A-Za-z0-9]/.test(first[0])) {
    if (first.length >= 2) return first.slice(0, 2).join('').toUpperCase();
    return (first[0] + (words[1]?.[0] || '')).toUpperCase();
  }

  // 한글 등 — 첫 낱말이 두 글자 이상이면 그 두 글자, 아니면 다음 낱말의 첫 글자를 붙인다
  if (first.length >= 2) return first.slice(0, 2).join('');
  return first[0] + (words[1] ? [...words[1]][0] : '');
}

const KIND_TARGET_LABELS = {
  url: '주소',
  script: '스크립트 경로',
  app: '실행 파일 경로',
  folder: '폴더 경로',
};
const KIND_TARGET_PLACEHOLDER = {
  url: 'https://example.com',
  script: 'C:\\Users\\me\\scripts\\backup.py',
  app: 'C:\\Program Files\\App\\app.exe',
  folder: 'C:\\Users\\me\\Documents',
};

const DND_TYPE = 'application/x-launcher-id';

const DONE_FADE_MS = 2500;   // 성공 팝오버가 스스로 사라지기까지
const FADE_OUT_MS = 260;     // fade-out 트랜지션 길이 (CSS 와 맞춤)
const OK_FLASH_MS = 1200;    // URL 즉시 성공 피드백
const ARM_RESET_MS = 4000;   // 삭제 재확인이 저절로 풀리는 시간
const OUT_LINES = 14;        // 팝오버에 보여줄 출력 줄 수
const EDGE_PAD = 4;          // 팝오버가 위젯 가장자리에서 띄우는 여백

// ============================================================ onStatus 단일 등록
//
// preload 는 onStatus 를 부를 때마다 ipcRenderer.on 을 그대로 건다.
// 여러 번 등록하면 콜백이 중복 누적되므로, 모듈 생애에 딱 한 번만 등록하고
// 여기서 인스턴스들에게 나눠 준다.

const statusHandlers = new Set();
let statusBound = false;

function bindStatusOnce() {
  if (statusBound) return;
  statusBound = true;
  const api = window.api && window.api.launcher;
  if (!api || typeof api.onStatus !== 'function') return;
  api.onStatus((status) => {
    for (const fn of [...statusHandlers]) {
      try { fn(status); } catch (err) { console.error('[launcher] status handler', err); }
    }
  });
}

// ============================================================ 작은 유틸

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/** 출력의 마지막 n 줄만 남긴다 (팝오버가 길어지지 않도록) */
function tailLines(text, n) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n');
}

/** 인자 문자열 → 배열. 큰따옴표로 공백 포함 인자를 묶을 수 있다. */
function parseArgs(text) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    out.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return out;
}

/** 배열 → 입력창에 되돌릴 문자열 */
function formatArgs(args) {
  return (Array.isArray(args) ? args : [])
    .map((a) => (/\s/.test(a) ? `"${a}"` : a))
    .join(' ');
}

/** 사용자가 스킴 없이 도메인만 적었을 때만 https 를 붙여 준다. 검증은 메인이 다시 한다. */
function normalizeUrl(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return t;
  return `https://${t}`;
}

/** 대상 문자열에서 그럴듯한 기본 이름을 뽑는다 (이름을 비워 뒀을 때) */
function guessLabel(kind, target) {
  const t = String(target || '').trim();
  if (!t) return '바로가기';
  if (kind === 'url') {
    try { return new URL(normalizeUrl(t)).hostname.replace(/^www\./, '') || '바로가기'; }
    catch { return '바로가기'; }
  }
  const parts = t.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '바로가기';
}

function closestItem(target) {
  return target && target.closest ? target.closest('.lnch-item') : null;
}

// ============================================================ 팩토리

export function createLauncher({ root, store }) {
  let destroyed = false;
  let rafId = 0;

  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); if (!destroyed) fn(); }, ms);
    timers.add(id);
    return id;
  };
  const cancelLater = (id) => { if (id) { clearTimeout(id); timers.delete(id); } };

  // ---------------------------------------------------------- 정적 셸
  // .lnch-root 가 팝오버/툴팁의 위치 기준(position: relative)이다.
  // root 는 이미 flex + center 이므로 여기서 가로를 꽉 채워 좌우 보정 계산을 단순화한다.
  const host = h('div', 'lnch-root');

  const dock = h('div', 'lnch-dock');
  dock.setAttribute('role', 'toolbar');
  dock.setAttribute('aria-label', '퀵 런처');

  const scroll = h('div', 'lnch-scroll');

  const emptyHint = h('div', 'lnch-empty', '+ 눌러 자주 쓰는 사이트나 파이썬 스크립트를 등록하세요');

  const addBtn = h('button', 'lnch-add');
  addBtn.append(icon('plus'));
  addBtn.type = 'button';
  addBtn.setAttribute('aria-label', '바로가기 추가');

  dock.append(scroll, addBtn);

  const tip = h('div', 'lnch-tip');
  tip.hidden = true;
  const tipLabel = h('div', 'lnch-tip__label');
  const tipSub = h('div', 'lnch-tip__sub');
  tip.append(tipLabel, tipSub);

  const pop = h('div', 'lnch-pop');
  pop.hidden = true;

  host.append(dock, tip, pop);
  root.append(host);

  // ---------------------------------------------------------- 상태
  /** id -> { el, icon, label } */
  const itemEls = new Map();

  /**
   * 실행 작업 기록.
   * jobId -> { jobId, real, itemId, label, icon, state, output, error, code, terminal }
   * real=false 는 메인이 {ok:false} 로 즉시 거절한 경우의 가짜 기록(취소 버튼 없음).
   */
  const jobs = new Map();
  let localJobSeq = 0;

  let popMode = null;        // null | 'job' | 'edit'
  let activeJobId = null;
  let popAnchorId = null;    // 팝오버가 붙어 있는 항목 id (null 이면 + 버튼)
  let popRefs = null;
  let fadeTimer = 0;
  let leaveTimer = 0;

  let tipAnchor = null;
  let dragId = null;

  // ---------------------------------------------------------- 항목 렌더

  function buildItem() {
    const el = h('button', 'lnch-item');
    el.type = 'button';
    el.draggable = true;
    // 내용을 '판' 위에 올린다. 맨 글자로 두면 도크에 낱글자가 흩어진 것처럼 보인다.
    const plate = h('span', 'lnch-item__plate');
    plate.append(h('span', 'lnch-item__icon'));
    el.append(
      plate,
      h('span', 'lnch-item__ring'),
      h('span', 'lnch-item__badge'),
    );
    return {
      el,
      plate,
      icon: el.querySelector('.lnch-item__icon'),
      badge: el.querySelector('.lnch-item__badge'),
      label: '',
      sub: '',
    };
  }

  function updateItem(rec, item, ink) {
    rec.el.dataset.id = item.id;
    rec.label = item.label || '바로가기';
    rec.sub = item.target || '';
    // 이모지도 사용자 입력이므로 textContent 로만 넣는다
    // 사용자가 이모지를 넣었으면 그대로, 아니면 종류별 선 아이콘
    rec.icon.textContent = '';
    // 판 색은 이름에서 뽑는다 — 같은 이름이면 언제나 같은 색이라 자리를 기억할 수 있다.
    rec.plate.style.setProperty('--lnch-ink', ink);

    if (item.icon) {
      // 사용자가 직접 넣은 이모지는 그대로 존중한다 (사용자 입력이므로 textContent 로만)
      rec.icon.textContent = item.icon;
      rec.icon.className = 'lnch-item__icon is-emoji';
    } else if (item.label) {
      // 같은 종류가 여러 개면 선 아이콘이 전부 똑같아져 구분이 안 된다.
      // 이름 첫 글자를 명조로 새기되, 맨 글자가 아니라 안료 판 위에 얹는다.
      rec.icon.textContent = monogramOf(item.label);
      rec.icon.className = 'lnch-item__icon is-monogram';
    } else {
      rec.icon.append(icon(KIND_ICONS[item.kind] || 'globe'));
      rec.icon.className = 'lnch-item__icon is-glyph';
    }
    rec.badge.textContent = '';
    rec.el.setAttribute('aria-label', `${rec.label} (${KIND_LABELS[item.kind] || item.kind})`);
    rec.el.classList.toggle('is-running', isRunning(item.id));
  }

  function render() {
    const items = store.launcherItems();
    const seen = new Set();
    const frag = document.createDocumentFragment();
    const inks = assignPigments(items, store.COLORS);

    for (const item of items) {
      seen.add(item.id);
      let rec = itemEls.get(item.id);
      if (!rec) { rec = buildItem(); itemEls.set(item.id, rec); }
      updateItem(rec, item, inks.get(item.id));
      frag.append(rec.el);
    }

    for (const [id, rec] of [...itemEls]) {
      if (!seen.has(id)) { rec.el.remove(); itemEls.delete(id); }
    }

    scroll.replaceChildren(frag);
    if (!items.length) scroll.append(emptyHint);

    // 열려 있던 팝오버의 기준 항목이 사라졌으면 닫는다
    if (popMode && popAnchorId && !itemEls.has(popAnchorId)) closePop();
    else if (popMode) placeFloat(pop, anchorEl(popAnchorId), 10);
  }

  function scheduleRender() {
    if (destroyed || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (!destroyed) render();
    });
  }

  function itemById(id) {
    return store.launcherItems().find((x) => x.id === id) || null;
  }

  function anchorEl(id) {
    const rec = id ? itemEls.get(id) : null;
    return (rec && rec.el.isConnected) ? rec.el : addBtn;
  }

  // ---------------------------------------------------------- 위치 보정
  //
  // 팝오버/툴팁은 도크 위쪽에 뜨고, host 기준 absolute 다.
  // 좌우로 위젯 밖에 나가지 않도록 host 폭 안으로 클램프하고,
  // 화살표만 실제 기준 항목 쪽으로 옮긴다.

  function placeFloat(el, anchor, gap) {
    if (!el || el.hidden || !anchor) return;
    const hostRect = host.getBoundingClientRect();
    const aRect = anchor.getBoundingClientRect();
    if (!hostRect.width) return;

    const w = el.offsetWidth;
    const centerX = aRect.left + aRect.width / 2 - hostRect.left;

    const maxLeft = Math.max(EDGE_PAD, hostRect.width - w - EDGE_PAD);
    const left = Math.min(Math.max(centerX - w / 2, EDGE_PAD), maxLeft);

    el.style.left = `${Math.round(left)}px`;
    el.style.bottom = `${Math.round(hostRect.bottom - aRect.top) + gap}px`;

    const arrow = Math.min(Math.max(centerX - left, 14), Math.max(14, w - 14));
    el.style.setProperty('--lnch-arrow', `${Math.round(arrow)}px`);
  }

  function reposition() {
    if (popMode) placeFloat(pop, anchorEl(popAnchorId), 10);
    if (!tip.hidden && tipAnchor) placeFloat(tip, tipAnchor, 8);
  }

  // ---------------------------------------------------------- 툴팁

  function showTip(el) {
    if (popMode) return;              // 팝오버와 겹치지 않게
    if (dragId) return;
    const rec = itemEls.get(el.dataset.id);
    if (!rec) return;
    tipAnchor = el;
    tipLabel.textContent = rec.label;
    tipSub.textContent = rec.sub;
    tipSub.hidden = !rec.sub;
    tip.hidden = false;
    placeFloat(tip, el, 8);
    // 다음 프레임에 클래스를 붙여 transition 이 실제로 돌게 한다
    requestAnimationFrame(() => { if (!destroyed && tipAnchor === el) tip.classList.add('is-on'); });
  }

  function hideTip() {
    if (tip.hidden) return;
    tipAnchor = null;
    tip.classList.remove('is-on');
    tip.hidden = true;
  }

  // ---------------------------------------------------------- 실행

  function isRunning(itemId) {
    for (const job of jobs.values()) {
      if (job.itemId === itemId && job.real && job.state === 'running') return true;
    }
    return false;
  }

  function runningJobOf(itemId) {
    for (const job of jobs.values()) {
      if (job.itemId === itemId && job.real && job.state === 'running') return job;
    }
    return null;
  }

  function refreshRing(itemId) {
    const rec = itemEls.get(itemId);
    if (rec) rec.el.classList.toggle('is-running', isRunning(itemId));
  }

  /** URL/폴더처럼 결과를 지켜볼 수 없는 실행의 짧은 성공 피드백 */
  function flashOk(itemId) {
    const rec = itemEls.get(itemId);
    if (!rec) return;
    rec.badge.textContent = '';
    rec.badge.append(icon('check'));
    rec.el.classList.add('is-ok');
    cancelLater(rec.flashTimer);
    rec.flashTimer = later(() => {
      rec.el.classList.remove('is-ok');
      rec.badge.textContent = '';
    }, OK_FLASH_MS);
  }

  async function runItem(id) {
    const item = itemById(id);
    if (!item) return;

    // 이미 돌고 있으면 새로 실행하지 않고 진행 상황을 다시 보여준다
    const running = runningJobOf(id);
    if (running) { openJobPop(running.jobId); return; }

    hideTip();

    let res;
    try {
      res = await window.api.launcher.run(item);
    } catch (err) {
      res = { ok: false, error: String((err && err.message) || err) };
    }
    if (destroyed) return;

    if (!res || !res.ok) {
      // 메인이 한국어 문구를 주므로 그대로 보여 준다
      showLocalError(item, (res && res.error) || '실행하지 못했습니다.');
      return;
    }

    if (res.jobId) {
      jobs.set(res.jobId, {
        jobId: res.jobId,
        real: true,
        itemId: item.id,
        label: item.label,
        icon: item.icon,
        state: 'running',
        output: '',
        error: '',
        code: null,
        terminal: false,
      });
      refreshRing(item.id);
      openJobPop(res.jobId);
    } else {
      // url / app / folder — jobId 없이 즉시 성공
      flashOk(item.id);
    }
  }

  /** 메인이 즉시 거절한 경우: 가짜 작업 기록을 만들어 같은 팝오버로 보여 준다 */
  function showLocalError(item, message) {
    const jobId = `local_${++localJobSeq}`;
    jobs.set(jobId, {
      jobId,
      real: false,
      itemId: item.id,
      label: item.label,
      icon: item.icon,
      state: 'error',
      output: '',
      error: message,
      code: null,
      terminal: true,
    });
    openJobPop(jobId);
  }

  function handleStatus(status) {
    if (destroyed || !status || !status.jobId) return;
    const job = jobs.get(status.jobId);
    if (!job) return;                 // 우리가 시작하지 않은 작업
    if (job.terminal) return;         // 종료 후 뒤늦게 오는 상태는 무시(문구 덮어쓰기 방지)

    if (typeof status.output === 'string') job.output = status.output;
    if (typeof status.code === 'number') job.code = status.code;
    if (status.error) job.error = String(status.error);

    const next = status.state === 'done' || status.state === 'error' ? status.state : 'running';
    job.state = next;

    if (next !== 'running') {
      job.terminal = true;
      refreshRing(job.itemId);
    }

    if (activeJobId === job.jobId) {
      updateJobPop(job);
      return;
    }

    // 팝오버가 다른 작업을 보고 있을 때
    if (next === 'error') {
      openJobPop(job.jobId);          // 실패는 놓치면 안 되므로 끌어올린다
    } else if (next === 'done') {
      flashOk(job.itemId);
      jobs.delete(job.jobId);
    }
  }

  async function cancelJob(jobId) {
    const job = jobs.get(jobId);
    if (!job || !job.real || job.terminal) return;

    let res;
    try {
      res = await window.api.launcher.cancel(jobId);
    } catch (err) {
      res = { ok: false, error: String((err && err.message) || err) };
    }
    if (destroyed) return;

    job.terminal = true;
    job.state = 'error';
    job.error = res && res.ok ? '사용자가 중단했습니다.' : ((res && res.error) || '중단하지 못했습니다.');
    refreshRing(job.itemId);
    if (activeJobId === jobId) updateJobPop(job);
  }

  // ---------------------------------------------------------- 팝오버 공통

  function closePop() {
    cancelLater(fadeTimer); fadeTimer = 0;
    cancelLater(leaveTimer); leaveTimer = 0;

    if (activeJobId) {
      const job = jobs.get(activeJobId);
      if (job && job.state !== 'running') jobs.delete(activeJobId);
    }

    popMode = null;
    activeJobId = null;
    popAnchorId = null;
    popRefs = null;
    pop.classList.remove('is-leaving');
    pop.hidden = true;
    pop.replaceChildren();
  }

  /** 완료 팝오버가 스스로 사라질 때만 쓰는 부드러운 퇴장 */
  function fadeOutPop() {
    if (!popMode) return;
    pop.classList.add('is-leaving');
    leaveTimer = later(() => closePop(), FADE_OUT_MS);
  }

  function popHead(titleText) {
    const head = h('div', 'lnch-pop__head');
    const badge = h('span', 'lnch-pop__badge');
    const title = h('span', 'lnch-pop__title', titleText);
    const x = h('button', 'lnch-pop__x');
    x.append(icon('close'));
    x.type = 'button';
    x.setAttribute('aria-label', '닫기');
    x.addEventListener('click', () => closePop());
    head.append(badge, title, x);
    return { head, badge, title };
  }

  // ---------------------------------------------------------- 실행 팝오버

  function openJobPop(jobId) {
    const job = jobs.get(jobId);
    if (!job) return;

    closePop();
    hideTip();

    popMode = 'job';
    activeJobId = jobId;
    popAnchorId = job.itemId;

    pop.className = 'lnch-pop lnch-pop--job';

    const { head, badge, title } = popHead(job.label || '바로가기');

    const bar = h('div', 'lnch-pop__bar');
    bar.append(h('div', 'lnch-pop__fill'));

    const out = h('div', 'lnch-pop__out');

    const foot = h('div', 'lnch-pop__foot');
    const stateText = h('span', 'lnch-pop__state');
    const cancelBtn = h('button', 'lnch-pop__cancel', '중단');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => cancelJob(job.jobId));
    foot.append(stateText, cancelBtn);

    pop.replaceChildren(head, bar, out, foot, h('div', 'lnch-pop__arrow'));
    popRefs = { badge, title, bar, out, stateText, cancelBtn };

    pop.hidden = false;
    updateJobPop(job);
    placeFloat(pop, anchorEl(popAnchorId), 10);
  }

  function updateJobPop(job) {
    if (popMode !== 'job' || !popRefs || activeJobId !== job.jobId) return;

    pop.classList.toggle('is-running', job.state === 'running');
    pop.classList.toggle('is-done', job.state === 'done');
    pop.classList.toggle('is-error', job.state === 'error');

    popRefs.badge.textContent =
      job.state === 'done' ? '✓' : job.state === 'error' ? '✕' : (job.icon || '⚙');
    popRefs.title.textContent = job.label || '바로가기';

    popRefs.bar.hidden = job.state !== 'running';

    const text = tailLines(job.output, OUT_LINES);
    popRefs.out.hidden = !text;
    if (text && popRefs.out.textContent !== text) {
      popRefs.out.textContent = text;           // 신뢰할 수 없는 출력 — 항상 textContent
      popRefs.out.scrollTop = popRefs.out.scrollHeight;
    }

    popRefs.stateText.textContent =
      job.state === 'running' ? '실행 중…'
        : job.state === 'done' ? '완료했습니다.'
          : (job.error || '실행에 실패했습니다.');

    popRefs.cancelBtn.hidden = !(job.state === 'running' && job.real);

    cancelLater(fadeTimer); fadeTimer = 0;
    // 성공은 잠깐 보여 주고 스스로 사라지고, 실패는 사용자가 닫을 때까지 남는다
    if (job.state === 'done') fadeTimer = later(fadeOutPop, DONE_FADE_MS);

    placeFloat(pop, anchorEl(popAnchorId), 10);
  }

  // ---------------------------------------------------------- 편집 팝오버

  function openEditPop(item, anchor) {
    closePop();
    hideTip();

    popMode = 'edit';
    popAnchorId = item ? item.id : null;

    pop.className = 'lnch-pop lnch-pop--edit';

    const draft = {
      kind: item ? item.kind : 'url',
      armed: false,
      armTimer: 0,
    };

    const { head } = popHead(item ? '바로가기 편집' : '바로가기 추가');

    const form = h('div', 'lnch-form');

    // 이름 + 아이콘
    const rowTop = h('div', 'lnch-form__row');
    const nameField = field('이름');
    const nameInput = textInput('예: 백업 스크립트');
    nameInput.value = item ? item.label : '';
    nameField.append(nameInput);

    // 아이콘 칸은 이모지 한두 자만 받는 좁은 칸이다.
    // 여기에 '비우면 기본 아이콘' 같은 안내를 placeholder 로 넣으면 '비우면 기' 까지만
    // 보이고 잘린다 — 안내가 아니라 오히려 무슨 소린지 모를 글자가 된다.
    // 안내는 커서를 올렸을 때 뜨는 설명으로 옮기고, 칸에는 예시 하나만 둔다.
    const ICON_HINT = '이모지 한두 자. 비워 두면 이름 앞 글자로 인장을 새깁니다.';
    const iconField = field('아이콘');
    iconField.classList.add('lnch-field--icon');
    iconField.title = ICON_HINT;
    // placeholder 를 비운다. 예시 이모지를 넣어 두면 '왜 뱀이 있지' 가 되고,
    // 설명을 넣으면 좁은 칸에서 잘린다. 안내는 커서를 올렸을 때만 뜨게 한다.
    const iconInput = textInput('');
    iconInput.maxLength = 4;
    iconInput.title = ICON_HINT;
    iconInput.setAttribute('aria-label', `아이콘 — ${ICON_HINT}`);
    iconInput.value = item ? item.icon : '';
    iconField.append(iconInput);

    rowTop.append(nameField, iconField);

    // 유형
    const kindField = field('유형');
    const seg = h('div', 'lnch-seg');
    const segBtns = new Map();
    for (const kind of KIND_ORDER) {
      const b = h('button', 'lnch-seg__btn', KIND_LABELS[kind]);
      b.type = 'button';
      b.addEventListener('click', () => setKind(kind));
      segBtns.set(kind, b);
      seg.append(b);
    }
    kindField.append(seg);

    // 대상 + 찾아보기
    const targetField = field('대상');
    const targetLabel = targetField.querySelector('.lnch-field__label');
    const targetRow = h('div', 'lnch-inputrow');
    const targetInput = textInput('');
    targetInput.value = item ? item.target : '';
    const browseBtn = h('button', 'lnch-browse', '찾아보기');
    browseBtn.type = 'button';
    browseBtn.addEventListener('click', browse);
    targetRow.append(targetInput, browseBtn);
    targetField.append(targetRow);

    // 인자
    const argsField = field('실행 인자');
    const argsInput = textInput('예: --full "C:\\내 문서"');
    argsInput.value = item ? formatArgs(item.args) : '';
    argsField.append(argsInput);

    const hint = h('div', 'lnch-hint');

    form.append(rowTop, kindField, targetField, argsField, hint);

    // 하단 버튼
    const foot = h('div', 'lnch-pop__foot lnch-pop__foot--edit');
    const delBtn = h('button', 'lnch-del', '삭제');
    delBtn.type = 'button';
    delBtn.hidden = !item;
    delBtn.addEventListener('click', onDelete);

    const spacer = h('span', 'lnch-spacer');
    const cancelBtn = h('button', 'lnch-btn', '취소');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => closePop());
    const saveBtn = h('button', 'lnch-btn lnch-btn--primary', '저장');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', save);

    foot.append(delBtn, spacer, cancelBtn, saveBtn);

    pop.replaceChildren(head, form, foot, h('div', 'lnch-pop__arrow'));
    pop.hidden = false;

    setKind(draft.kind);
    placeFloat(pop, anchor || anchorEl(popAnchorId), 10);
    nameInput.focus();
    nameInput.select();

    // --- 편집 팝오버 내부 동작 ---

    function field(labelText) {
      const wrap = h('div', 'lnch-field');
      wrap.append(h('div', 'lnch-field__label', labelText));
      return wrap;
    }

    function textInput(placeholder) {
      const el = h('input', 'lnch-input');
      el.type = 'text';
      el.spellcheck = false;
      el.placeholder = placeholder;
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (e.isComposing || e.keyCode === 229) return;   // 한글 조합 중 Enter 는 확정용
          e.preventDefault();
          save();
        }
      });
      return el;
    }

    function setKind(kind) {
      draft.kind = kind;
      for (const [k, b] of segBtns) b.classList.toggle('is-on', k === kind);

      targetLabel.textContent = KIND_TARGET_LABELS[kind];
      targetInput.placeholder = KIND_TARGET_PLACEHOLDER[kind];
      browseBtn.hidden = kind === 'url';
      argsField.hidden = !(kind === 'script' || kind === 'app');


      hint.classList.remove('is-warn');
      hint.textContent = kind === 'script'
        ? `실행 가능한 확장자: ${SUPPORTED_EXT} · 절대 경로만 됩니다. 경로를 직접 입력해도 됩니다.`
        : kind === 'url'
          ? 'http / https / mailto 주소만 열 수 있습니다.'
          : '경로를 직접 입력하거나 찾아보기로 고르세요.';

      placeFloat(pop, anchor || anchorEl(popAnchorId), 10);
    }

    async function browse() {
      const mode = draft.kind === 'folder' ? 'folder' : 'file';
      let picked = null;
      try {
        picked = await window.api.launcher.pick(mode);
      } catch (err) {
        console.error('[launcher] pick', err);
      }
      if (destroyed || popMode !== 'edit') return;
      if (picked) {                                  // 취소하면 null 이므로 그대로 둔다
        targetInput.value = String(picked);
        if (!nameInput.value.trim()) nameInput.value = guessLabel(draft.kind, picked);
      }
      targetInput.focus();
    }

    function disarm() {
      draft.armed = false;
      cancelLater(draft.armTimer);
      draft.armTimer = 0;
      delBtn.textContent = '삭제';
      delBtn.classList.remove('is-armed');
    }

    function onDelete() {
      if (!item) return;
      if (!draft.armed) {
        // 되돌릴 수 없으므로 한 단계 재확인 (모달 대신 버튼 자체를 바꾼다)
        draft.armed = true;
        delBtn.textContent = '정말 삭제할까요?';
        delBtn.classList.add('is-armed');
        draft.armTimer = later(disarm, ARM_RESET_MS);
        placeFloat(pop, anchor || anchorEl(popAnchorId), 10);
        return;
      }
      disarm();
      const id = item.id;
      closePop();
      store.removeLauncherItem(id);
    }

    function save() {
      const kind = draft.kind;
      const rawTarget = targetInput.value.trim();
      const target = kind === 'url' ? normalizeUrl(rawTarget) : rawTarget;

      if (!target) {
        hint.textContent = '실행 대상을 입력하세요.';
        hint.classList.add('is-warn');
        targetInput.focus();
        return;
      }

      const patch = {
        label: nameInput.value.trim() || guessLabel(kind, target),
        // 비워 두면 종류별 기본 선 아이콘이 쓰인다
        icon: iconInput.value.trim(),
        kind,
        target,
        args: (kind === 'script' || kind === 'app') ? parseArgs(argsInput.value) : [],
      };

      if (item) store.updateLauncherItem(item.id, patch);
      else store.addLauncherItem(patch);

      closePop();
    }
  }

  // ---------------------------------------------------------- 이벤트

  function onScrollClick(e) {
    const el = closestItem(e.target);
    if (!el || !el.dataset.id) return;
    if (dragId) return;
    runItem(el.dataset.id);
  }

  function onContextMenu(e) {
    const el = closestItem(e.target);
    e.preventDefault();
    if (!el || !el.dataset.id) return;
    const item = itemById(el.dataset.id);
    if (item) openEditPop(item, el);
  }

  function onOver(e) {
    const el = closestItem(e.target);
    if (!el) return;
    if (tipAnchor === el) return;
    showTip(el);
  }

  // 키보드로 옮겨 다닐 때도 무엇인지 알려 준다.
  // 아이콘 한두 글자로는 구분이 안 되므로 툴팁이 사실상 유일한 이름표다.
  function onFocusIn(e) {
    const el = closestItem(e.target);
    if (el && tipAnchor !== el) showTip(el);
  }
  function onFocusOut(e) {
    const el = closestItem(e.target);
    if (el && tipAnchor === el) hideTip();
  }

  function onOut(e) {
    const el = closestItem(e.target);
    if (!el) return;
    const to = e.relatedTarget;
    if (to && el.contains(to)) return;
    if (tipAnchor === el) hideTip();
  }

  function onWheel(e) {
    if (scroll.scrollWidth <= scroll.clientWidth) return;
    const delta = e.deltaY || e.deltaX;
    if (!delta) return;
    e.preventDefault();                 // 마우스 휠로 가로 스크롤
    scroll.scrollLeft += delta;
  }

  // --- 드래그 정렬 ---

  function onDragStart(e) {
    const el = closestItem(e.target);
    if (!el || !el.dataset.id) return;
    dragId = el.dataset.id;
    el.classList.add('is-dragging');
    hideTip();
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData(DND_TYPE, dragId); } catch { /* 무시 */ }
    }
  }

  function onDragOver(e) {
    if (!dragId) return;                // 투두 태스크 드롭 등 남의 드래그는 받지 않는다
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    const dragEl = itemEls.get(dragId) && itemEls.get(dragId).el;
    const over = closestItem(e.target);
    if (!dragEl || !over || over === dragEl) return;

    const r = over.getBoundingClientRect();
    const before = e.clientX < r.left + r.width / 2;
    scroll.insertBefore(dragEl, before ? over : over.nextSibling);
  }

  // 실제 순서 커밋은 dragend 에서 한 번만 한다 (drop 과 중복 저장 방지)
  function onDrop(e) {
    if (!dragId) return;
    e.preventDefault();
  }

  function onDragEnd() {
    const rec = dragId ? itemEls.get(dragId) : null;
    if (rec) rec.el.classList.remove('is-dragging');
    if (dragId) commitOrder();
    dragId = null;
  }

  function commitOrder() {
    const ids = [...scroll.querySelectorAll('.lnch-item')]
      .map((el) => el.dataset.id)
      .filter(Boolean);
    if (ids.length) store.reorderLauncher(ids);
  }

  // --- 창 단위 ---

  function onWinKey(e) {
    if (e.key !== 'Escape' || !popMode) return;
    e.stopPropagation();
    closePop();
  }

  function onWinPointerDown(e) {
    if (!popMode) return;
    if (pop.contains(e.target)) return;
    // 편집 폼은 입력 중인 내용이 날아가지 않도록 바깥 클릭으로 닫지 않는다
    if (popMode === 'edit') return;
    closePop();
  }

  // ---------------------------------------------------------- 연결

  scroll.addEventListener('click', onScrollClick);
  scroll.addEventListener('mouseover', onOver);
  scroll.addEventListener('mouseout', onOut);
  scroll.addEventListener('focusin', onFocusIn);
  scroll.addEventListener('focusout', onFocusOut);
  scroll.addEventListener('focusin', onOver);
  scroll.addEventListener('focusout', onOut);
  scroll.addEventListener('dragstart', onDragStart);
  scroll.addEventListener('dragover', onDragOver);
  scroll.addEventListener('drop', onDrop);
  scroll.addEventListener('dragend', onDragEnd);
  scroll.addEventListener('wheel', onWheel, { passive: false });
  scroll.addEventListener('scroll', reposition, { passive: true });

  dock.addEventListener('contextmenu', onContextMenu);

  addBtn.addEventListener('click', () => {
    if (popMode === 'edit' && popAnchorId === null) { closePop(); return; }
    openEditPop(null, addBtn);
  });

  window.addEventListener('resize', reposition);
  window.addEventListener('keydown', onWinKey, true);
  window.addEventListener('pointerdown', onWinPointerDown, true);

  bindStatusOnce();
  statusHandlers.add(handleStatus);

  const unsubscribe = store.subscribe(scheduleRender);

  render();

  // ---------------------------------------------------------- 정리
  return {
    destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;

      for (const id of timers) clearTimeout(id);
      timers.clear();

      statusHandlers.delete(handleStatus);
      unsubscribe();

      window.removeEventListener('resize', reposition);
      window.removeEventListener('keydown', onWinKey, true);
      window.removeEventListener('pointerdown', onWinPointerDown, true);

      itemEls.clear();
      jobs.clear();
      popMode = null;
      activeJobId = null;
      popRefs = null;
      tipAnchor = null;
      dragId = null;

      root.textContent = '';
    },
  };
}
