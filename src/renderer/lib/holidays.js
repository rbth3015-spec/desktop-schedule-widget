// 공휴일 표시 규칙. 자료 자체는 메인 프로세스가 받아 온다(src/main/holidays.js).
//
// 월력요항에는 '쉬는 날'만 있는 게 아니라 기념일도 함께 실린다.
// 달력을 빨갛게 칠하는 기준은 **관공서가 쉬는 날**이어야 하므로 몇 가지를 걸러 낸다.

/**
 * 자료에는 들어 있지만 관공서 공휴일이 아닌 날.
 *  - 노동절(5/1)  : 근로자의 날. 근로기준법상 유급휴일이지만 관공서는 정상 근무한다.
 *  - 제헌절(7/17) : 2008년부터 공휴일에서 빠졌다(국경일이기는 하다).
 * 이런 날도 이름은 보여 주되 '빨간 날' 로는 치지 않는다.
 */
const NOT_PUBLIC = new Set(['노동절', '근로자의 날', '제헌절']);

/**
 * 이 날이 관공서 공휴일인가.
 * 하루에 이름이 여럿일 수 있다(2025-05-05 = 어린이날 + 부처님 오신 날).
 * 하나라도 공휴일이면 쉬는 날이다.
 * @param {string[]} names
 */
export function isPublicHoliday(names) {
  if (!Array.isArray(names) || !names.length) return false;
  return names.some((n) => !NOT_PUBLIC.has(n));
}

/**
 * 화면에 쓸 짧은 이름.
 * '대체공휴일(3ㆍ1절)' 처럼 긴 이름은 좁은 날짜 칸에서 잘리므로 '대체' 로 줄인다.
 * 전체 이름은 툴팁으로 따로 보여 준다.
 */
export function shortName(name) {
  const sub = /^대체공휴일\s*\((.+)\)$/.exec(name);
  if (sub) return '대체';
  const tmp = /^임시공휴일\s*\((.+)\)$/.exec(name);
  if (tmp) return '임시';
  return name
    .replace(/^기독탄신일$/, '성탄절')
    .replace(/\s*오신 날$/, '오신날');
}

/** 한 날의 이름들을 한 줄로 (툴팁용) */
export function fullLabel(names) {
  return Array.isArray(names) ? names.join(' · ') : '';
}
