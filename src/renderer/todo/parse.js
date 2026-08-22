// 한 줄 입력 파서.
//
// 예전에는 목록 위에 전용 입력칸이 있었지만, 같은 일(일정 추가)을 하는 길이
// 여러 개로 갈리는 게 혼란스러워 입구를 '+' 하나로 모았다.
// 문법 자체는 익힌 사람에게 빠르므로 버리지 않고, 추가 폼의 제목칸이 그대로 이해한다.
//
// 순수 함수만 둔다 — DOM 도 store 도 건드리지 않는다.

import { todayKey, fromKey, addDays } from '../lib/date.js';

/** 한글/영문 색 이름 → store.COLORS 키 */
// ============================================================ 빠른 입력 파서
//
// 문법 요약
//   !  / !!        우선순위 1(중요) / 2(긴급)
//   #태그          태그 (여러 개 가능)
//   @날짜          시작일   (오늘/내일/모레/글피/요일/8/15/2026-08-15/15일)
//   ~종료          종료일   (3d, 3일 = 시작일 +N일 / 8/20 / 2026-08-20)
//   *색            파랑 초록 노랑 빨강 보라 회색
//
// 예시 입출력 (baseKey = '2026-08-10' 월요일 기준)
//
//   parseQuickInput('장보기 @내일 #집안일 !', '2026-08-10')
//   → { title: '장보기', start: '2026-08-11', end: null,
//       tags: ['집안일'], priority: 1, color: null }
//
//   parseQuickInput('기획서 마감 @8/15 ~3d *빨강 !!', '2026-08-10')
//   → { title: '기획서 마감', start: '2026-08-15', end: null, endDays: 3,
//       tags: [], priority: 2, color: 'rose' }
//     endDays 는 resolveRange() 에서 start + 3일 = '2026-08-18' 로 확정된다.
//
//   parseQuickInput('!!긴급 회의 #업무 #팀 @금', '2026-08-10')
//   → { title: '긴급 회의', start: '2026-08-14', end: null,
//       tags: ['업무', '팀'], priority: 2, color: null }
//
//   parseQuickInput('보고서 @2026-09-01 ~5일 *초록 #회사', '2026-08-10')
//   → { title: '보고서', start: '2026-09-01', endDays: 5, tags: ['회사'], color: 'green' }
//
//   parseQuickInput('운동하기!!', '2026-08-10')
//   → { title: '운동하기', priority: 2 }   // 첫/마지막 토큰에 붙여 쓴 ! 도 인식
//
//   parseQuickInput('치과 @15일', '2026-08-10')
//   → { title: '치과', start: '2026-08-15' }   // 이미 지난 날이면 다음 달
//
//   parseQuickInput('이상한거 @없는날짜 *분홍 ~zzz', '2026-08-10')
//   → { title: '이상한거', unknown: ['@없는날짜', '*분홍', '~zzz'] }
//     해석 실패한 조각은 제목에서 빼되 unknown 에 담아 미리보기에서 경고로 보여 준다.
//
//   parseQuickInput('그냥 할일', '2026-08-10')
//   → { title: '그냥 할일', start: null, end: null, tags: [], priority: 0, color: null }
//     start 가 null(미지정)이면 store.addTask 가 selectedDate 를 넣는다.
//
//   parseQuickInput('   ', '2026-08-10')
//   → { title: '', ... }  (빈 제목이면 추가하지 않는다)

const COLOR_ALIASES = {
  파랑: 'blue', 파란: 'blue', 파란색: 'blue', 블루: 'blue', blue: 'blue',
  초록: 'green', 초록색: 'green', 녹색: 'green', 그린: 'green', green: 'green',
  노랑: 'amber', 노란: 'amber', 노란색: 'amber', 앰버: 'amber', amber: 'amber', yellow: 'amber',
  빨강: 'rose', 빨간: 'rose', 빨간색: 'rose', 레드: 'rose', red: 'rose', rose: 'rose',
  보라: 'violet', 보라색: 'violet', 퍼플: 'violet', violet: 'violet', purple: 'violet',
  회색: 'slate', 그레이: 'slate', gray: 'slate', grey: 'slate', slate: 'slate',
};

/** 색 키 → 한글 표시명 (미리보기용) */
export const COLOR_NAMES = {
  blue: '파랑', green: '초록', amber: '노랑', rose: '빨강', violet: '보라', slate: '회색',
};

const WEEKDAY_INDEX = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** y-m-d 를 키로 만들되 실제로 존재하는 날짜인지 검증 (2/30 같은 건 null) */
function makeKey(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const key = `${y}-${pad2(m)}-${pad2(d)}`;
  return toKey(fromKey(key)) === key ? key : null;
}

/**
 * '@' / '~' 뒤에 오는 낱말을 날짜 키로 해석한다.
 * @param {string} word  마커를 뗀 문자열
 * @param {string} baseKey 상대 날짜의 기준일
 * @returns {string|null}
 */
function resolveDateWord(word, baseKey) {
  const w = word.trim();
  if (!w) return null;

  // 상대 날짜
  const RELATIVE = { 오늘: 0, today: 0, 내일: 1, tomorrow: 1, 모레: 2, 글피: 3, 어제: -1 };
  if (w in RELATIVE) return addDays(baseKey, RELATIVE[w]);

  // 요일 — 기준일 다음의 해당 요일 (기준일과 같은 요일이면 다음 주)
  const weekday = w.match(/^([일월화수목금토])(요일)?$/);
  if (weekday) {
    const target = WEEKDAY_INDEX[weekday[1]];
    const cur = fromKey(baseKey).getDay();
    let delta = (target - cur + 7) % 7;
    if (delta === 0) delta = 7;
    return addDays(baseKey, delta);
  }

  // 2026-08-15 / 2026.8.15
  const full = w.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (full) return makeKey(Number(full[1]), Number(full[2]), Number(full[3]));

  // 8/15 · 8.15 · 8-15 → 올해 기준, 이미 지났으면 내년
  const md = w.match(/^(\d{1,2})[-./](\d{1,2})$/);
  if (md) {
    const year = fromKey(baseKey).getFullYear();
    const key = makeKey(year, Number(md[1]), Number(md[2]));
    if (!key) return null;
    return key >= baseKey ? key : makeKey(year + 1, Number(md[1]), Number(md[2]));
  }

  // 15일 → 이번 달, 이미 지났으면 다음 달
  const dayOnly = w.match(/^(\d{1,2})일$/);
  if (dayOnly) {
    const base = fromKey(baseKey);
    const key = makeKey(base.getFullYear(), base.getMonth() + 1, Number(dayOnly[1]));
    if (key && key >= baseKey) return key;
    const next = new Date(base.getFullYear(), base.getMonth() + 1, 1);
    return makeKey(next.getFullYear(), next.getMonth() + 1, Number(dayOnly[1]));
  }

  return null;
}

/**
 * 시각처럼 생긴 낱말을 'HH:mm' 으로. 아니면 null.
 *
 *   15:00  9:30        그대로
 *   15시  9시  9시30분  시 단위
 *   오후3시  오전9:30    오전/오후를 붙였을 때만 12시간제로 읽는다
 *
 * **오전/오후를 안 붙이면 적힌 그대로 읽는다.** '3시'를 15:00 으로 넘겨짚지 않는다.
 * 반복 규칙에서 31일을 말일에 붙이지 않은 것과 같은 이유 — 예측 가능성이 먼저다.
 */
function resolveTimeWord(w) {
  const m = /^(오전|오후)?(\d{1,2})(?::(\d{1,2})|시(?:(\d{1,2})분?)?)$/.exec(String(w || ''));
  if (!m) return null;

  let hour = Number(m[2]);
  const min = Number(m[3] ?? m[4] ?? 0);
  if (min > 59) return null;

  if (m[1]) {
    // 오전/오후를 붙였으면 12시간제. '오후 12시'는 정오, '오전 12시'는 자정.
    if (hour < 1 || hour > 12) return null;
    if (m[1] === '오후' && hour !== 12) hour += 12;
    if (m[1] === '오전' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }

  return `${pad2(hour)}:${pad2(min)}`;
}

/** '15:00~16:30' / '15:00-16:30' → 시작·종료 시각. 아니면 null */
function resolveTimeRange(w) {
  const parts = String(w || '').split(/[~-]/);
  if (parts.length !== 2) return null;
  const startTime = resolveTimeWord(parts[0]);
  const endTime = resolveTimeWord(parts[1]);
  if (!startTime || !endTime) return null;
  return { startTime, endTime };
}

/**
 * 빠른 입력 문자열을 태스크 조각으로 파싱한다. 순수 함수.
 * @param {string} text
 * @param {string} [baseKey] 상대 날짜 기준일 (기본: 오늘)
 * @returns {{title:string, start:string|null, end:string|null, endDays:number|null,
 *            startTime:string|null, endTime:string|null,
 *            tags:string[], priority:number, color:string|null, unknown:string[]}}
 */
export function parseQuickInput(text, baseKey = todayKey()) {
  const out = {
    title: '',
    start: null,
    end: null,
    endDays: null,   // ~3d 처럼 '시작일 + N일' 로 들어온 경우 N (미리보기에서 안내)
    startTime: null, // '15:00' 처럼 시각만 적은 토큰
    endTime: null,
    tags: [],
    priority: 0,
    color: null,
    unknown: [],     // 마커는 붙었는데 해석 못 한 조각 (미리보기에서 경고)
  };

  const raw = String(text ?? '');
  const tokens = raw.split(/\s+/).filter(Boolean);
  const words = [];

  tokens.forEach((token, i) => {
    // 단독 '!' / '!!'
    if (/^!{1,2}$/.test(token)) {
      out.priority = Math.max(out.priority, token.length);
      return;
    }

    // #태그
    if (token.length > 1 && token[0] === '#') {
      const tag = token.slice(1).replace(/[,]+$/, '');
      if (tag && !out.tags.includes(tag)) out.tags.push(tag);
      return;
    }

    // *색
    if (token.length > 1 && token[0] === '*') {
      const key = COLOR_ALIASES[token.slice(1).toLowerCase()];
      if (key) out.color = key;
      else out.unknown.push(token);
      return;
    }

    // @시작일
    if (token.length > 1 && token[0] === '@') {
      const key = resolveDateWord(token.slice(1), baseKey);
      if (key) out.start = key;
      else out.unknown.push(token);
      return;
    }

    // ~종료일 / ~3d
    if (token.length > 1 && token[0] === '~') {
      const body = token.slice(1);
      const dur = body.match(/^(\d{1,3})\s*(d|일|day|days)$/i);
      if (dur) {
        out.endDays = Number(dur[1]);
        return;
      }
      const key = resolveDateWord(body, baseKey);
      if (key) out.end = key;
      else out.unknown.push(token);
      return;
    }

    // 시각 — '15:00', '오후3시', '15:00~16:30'.
    // 마커(@ ~ # *)가 없어도 알아본다. 무엇으로 읽혔는지는 미리보기가 바로 보여 준다.
    const range = resolveTimeRange(token);
    if (range) {
      out.startTime = range.startTime;
      out.endTime = range.endTime;
      return;
    }
    const time = resolveTimeWord(token);
    if (time) {
      out.startTime = time;
      return;
    }

    // 붙여 쓴 '!!긴급' (첫 토큰) / '장보기!!' (마지막 토큰)
    let word = token;
    if (i === 0) {
      const lead = word.match(/^(!{1,2})(?=\S)/);
      if (lead) {
        out.priority = Math.max(out.priority, lead[1].length);
        word = word.slice(lead[1].length);
      }
    }
    if (i === tokens.length - 1) {
      const tail = word.match(/(!{1,2})$/);
      if (tail && word.length > tail[1].length) {
        out.priority = Math.max(out.priority, tail[1].length);
        word = word.slice(0, -tail[1].length);
      }
    }
    if (word) words.push(word);
  });

  out.title = words.join(' ').trim();
  return out;
}

/** 파싱 결과 + 기준 시작일로 최종 start/end 를 계산 (미리보기와 추가 시 동일 로직) */
export function resolveRange(parsed, fallbackStart) {
  const start = parsed.start || fallbackStart || null;
  let end = parsed.end || null;
  if (parsed.endDays != null && start) end = addDays(start, parsed.endDays);
  if (start && end && end < start) end = start;
  return { start, end };
}
