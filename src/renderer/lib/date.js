// 날짜 유틸. 모든 날짜는 'YYYY-MM-DD' 로컬 기준 문자열로 다룬다.
// Date 객체를 직접 주고받지 않는다 (타임존/직렬화 사고 방지).

export function toKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayKey() {
  return toKey(new Date());
}

export function addDays(key, n) {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
}

export function addMonths(key, n) {
  const d = fromKey(key);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  // 1/31 + 1개월 => 2/28 로 클램프
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toKey(d);
}

/** 두 날짜 키의 차이(일). b - a */
export function diffDays(a, b) {
  const MS = 86400000;
  return Math.round((fromKey(b) - fromKey(a)) / MS);
}

export function isBetween(key, start, end) {
  return key >= start && key <= end;
}

/** 해당 월 그리드(일요일 시작, 6주 42칸)의 날짜 키 배열 */
export function monthGrid(anchorKey) {
  const d = fromKey(anchorKey);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const out = [];
  for (let i = 0; i < 42; i++) {
    const cur = new Date(start);
    cur.setDate(start.getDate() + i);
    out.push(toKey(cur));
  }
  return out;
}

/** 해당 날짜가 속한 주(일요일 시작) 7칸 */
export function weekGrid(anchorKey) {
  const d = fromKey(anchorKey);
  const start = new Date(d);
  start.setDate(d.getDate() - d.getDay());
  const out = [];
  for (let i = 0; i < 7; i++) {
    const cur = new Date(start);
    cur.setDate(start.getDate() + i);
    out.push(toKey(cur));
  }
  return out;
}

export function sameMonth(a, b) {
  return a.slice(0, 7) === b.slice(0, 7);
}

export function monthLabel(key) {
  const [y, m] = key.split('-');
  return `${y}년 ${Number(m)}월`;
}

export const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

// ---------------------------------------------------------------- 시각
//
// 시각도 날짜와 같은 원칙으로 다룬다: 'HH:mm' 로컬 벽시계 문자열.
// Date 로 바꾸지 않으므로 타임존이 개입할 여지가 없다.
// null(빈 문자열)이면 '종일' — 시각이 정해지지 않은 일정이다.

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'HH:mm' 형식인가 */
export function isTimeKey(v) {
  return TIME_RE.test(String(v ?? ''));
}

/** 'HH:mm' → 자정부터의 분. 형식이 아니면 null */
export function timeMinutes(v) {
  const m = TIME_RE.exec(String(v ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** '15:00' → '오후 3:00'. 알림 본문처럼 문장 안에 들어갈 때 쓴다. */
export function formatTimeKo(v) {
  const m = TIME_RE.exec(String(v ?? ''));
  if (!m) return '';
  const hour = Number(m[1]);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour < 12 ? '오전' : '오후'} ${h12}:${m[2]}`;
}

/**
 * 날짜+시각을 로컬 Date 로. 시각이 없으면 그 날 자정.
 * 알림 시각 계산처럼 '언제인지 재야 하는' 곳에서만 쓴다.
 */
export function fromKeyTime(key, time) {
  const d = fromKey(key);
  const mins = timeMinutes(time);
  if (mins !== null) d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d;
}
