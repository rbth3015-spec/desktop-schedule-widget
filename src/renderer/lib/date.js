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
