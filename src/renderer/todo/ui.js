// 오른쪽 면 화면들이 함께 쓰는 작은 부품.
//
// 시안(design_handoff_schedule_assistant)은 입력칸도 버튼도 전부 1px 윤곽선이다.
// 네이티브 date/time 입력은 한국어 로캘에서 '2026. 09. 04.' · '오후 03:00' 으로 그려져
// 시안의 '9/4 (금)' · '15:00' 과 다르다. 글자는 여기서 쓰고, 고르는 일만 네이티브에 맡긴다.

import { fromKey, WEEKDAY_LABELS } from '../lib/date.js';
import { parseQuickInput } from './parse.js';

export function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/** 입력 중인 칸은 건드리지 않는다 (IME 조합·커서 위치 보존) */
export function setValueSafe(el, value) {
  if (document.activeElement === el) return;
  if (el.value !== value) el.value = value;
}

/** '9/4 (금)' */
export function shortDate(key) {
  if (!key) return '';
  const d = fromKey(key);
  return `${d.getMonth() + 1}/${d.getDate()} (${WEEKDAY_LABELS[d.getDay()]})`;
}

/** '9/4' */
export function monthDay(key) {
  if (!key) return '';
  const d = fromKey(key);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 화면 머리 — 제목 + 돌아갈 면('‹ 하루' · '‹ 계획'). Esc 도 같은 곳으로 돌아간다. */
export function screenHead(title, onBack) {
  const el = h('div', 'scr-head');
  const titleEl = h('span', 'scr-head__title', title);
  const back = h('button', 'scr-head__back', '‹ 하루');
  back.type = 'button';
  back.addEventListener('click', () => onBack?.());
  el.append(titleEl, back);
  return { el, titleEl, back };
}

/** 칸 이름 — 9.5px 흐린 글자 */
export function fieldLabel(text) {
  return h('div', 'scr-label', text);
}

/**
 * 날짜 칸. 보이는 글자는 시안 형식이고, 누르면 네이티브 달력이 뜬다.
 * @param {{format?: (key:string)=>string, onPick?: (key:string)=>void, cls?: string}} [opts]
 */
export function dateField({ format = shortDate, onPick, cls = '' } = {}) {
  const el = h('span', `scr-date ${cls}`.trim());
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  const text = h('span', 'scr-date__text num');
  const input = h('input', 'scr-date__input');
  input.type = 'date';
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  el.append(text, input);

  let value = '';
  let disabled = false;

  function open() {
    if (disabled) return;
    input.value = value;
    try { input.showPicker(); } catch { input.focus(); }
  }
  el.addEventListener('click', (e) => { e.stopPropagation(); open(); });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || (e.altKey && e.key === 'ArrowDown')) {
      e.preventDefault();
      open();
    }
  });
  input.addEventListener('change', () => onPick?.(input.value));

  return {
    el,
    get: () => value,
    set(key, placeholder = '—') {
      value = key || '';
      text.textContent = value ? format(value) : placeholder;
      el.classList.toggle('is-empty', !value);
    },
    setDisabled(on) {
      disabled = !!on;
      el.classList.toggle('is-disabled', disabled);
      el.tabIndex = disabled ? -1 : 0;
      el.setAttribute('aria-disabled', String(disabled));
    },
    setLabel(label) { el.setAttribute('aria-label', label); },
  };
}

/**
 * 'HH:MM' 로 바로잡는다. 비우면 '', 못 알아들으면 null.
 * '930' · '9' · '21:5'(×) · '오후 3시' · '3pm' 을 받는다.
 */
export function parseTime(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(v);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2] || 0);
    if (hh < 24 && mm < 60) return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    return null;
  }
  // '오후 3시' 같은 말은 한 줄 문법 해석기가 이미 안다
  const parsed = parseQuickInput(`x ${v.replace(/\s+/g, '')}`);
  return parsed.startTime || null;
}

/**
 * 시각 칸 — 시안처럼 '15:00' 으로 보인다. ↑↓ 로 30분씩 옮긴다.
 * @param {{onCommit?: (v:string)=>void, cls?: string, label?: string}} [opts]
 */
export function timeField({ onCommit, cls = '', label = '' } = {}) {
  const input = h('input', `scr-time num ${cls}`.trim());
  input.type = 'text';
  input.placeholder = '--:--';
  input.maxLength = 8;
  input.spellcheck = false;
  input.autocomplete = 'off';
  if (label) input.setAttribute('aria-label', label);

  let value = '';

  function commit() {
    const v = parseTime(input.value);
    if (v === null) {
      input.value = value;
      input.classList.add('is-invalid');
      setTimeout(() => input.classList.remove('is-invalid'), 900);
      return;
    }
    input.value = v;
    if (v !== value) {
      value = v;
      onCommit?.(v);
    }
  }

  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur(); return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const cur = parseTime(input.value) || value || '09:00';
      const [hh, mm] = cur.split(':').map(Number);
      const step = e.key === 'ArrowUp' ? 30 : -30;
      const total = (((hh * 60 + mm + step) % 1440) + 1440) % 1440;
      input.value = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }
  });
  input.addEventListener('blur', () => {
    if (input.value !== value) commit();
  });

  return {
    el: input,
    get: () => (document.activeElement === input ? parseTime(input.value) ?? value : value),
    set(v) {
      value = v || '';
      if (document.activeElement !== input) input.value = value;
    },
    setDisabled(on) {
      input.disabled = !!on;
    },
  };
}

/** 링크 정리. 비우면 '', 잘못된 주소면 null */
export function normalizeLink(raw) {
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

/** 링크를 기본 브라우저로 연다 */
export function openLink(url) {
  const href = normalizeLink(url);
  if (!href) return;
  window.api.openExternal(href);
}

/** 표시용 짧은 링크 — 'google.com/abc...' */
export function linkLabel(url) {
  try {
    const u = new URL(url);
    const tail = (u.pathname + u.search).replace(/\/$/, '');
    const s = u.hostname.replace(/^www\./, '') + tail;
    return s.length > 34 ? s.slice(0, 33) + '…' : s;
  } catch {
    return url;
  }
}
