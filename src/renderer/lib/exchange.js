// 데이터 내보내기 / 가져오기.
//
// 파일 내용은 여기서 만들고(모델과 날짜 규칙이 렌더러에 있다),
// 실제 파일 쓰기·대화상자는 메인 프로세스가 맡는다.

import { addDays } from './date.js';

// ============================================================ 백업(JSON)

/** 앱이 그대로 되읽을 수 있는 전체 백업 */
export function toBackupJSON(state) {
  return JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    app: 'schedule-widget',
    tasks: state.tasks,
    launcher: state.launcher,
    settings: state.settings,
  }, null, 2);
}

/**
 * 백업 파일을 검사해 쓸 수 있는 형태로 돌려준다.
 * 남의 JSON 을 그대로 밀어 넣으면 앱이 깨지므로 최소 구조를 확인한다.
 * @returns {{ok:true, data:object} | {ok:false, error:string}}
 */
export function parseBackup(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'JSON 형식이 아닙니다.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '백업 파일 구조가 아닙니다.' };
  }
  if (!Array.isArray(parsed.tasks)) {
    return { ok: false, error: 'tasks 목록이 없습니다. 이 앱의 백업 파일이 맞는지 확인하세요.' };
  }
  // 항목 하나라도 최소한 제목/날짜 꼴이어야 한다
  const bad = parsed.tasks.find((t) => !t || typeof t !== 'object');
  if (bad !== undefined) return { ok: false, error: '일정 항목이 손상되어 있습니다.' };

  return { ok: true, data: parsed };
}

// ============================================================ 캘린더(.ics)

/** RFC 5545 텍스트 이스케이프 */
function esc(v) {
  return String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** 'YYYY-MM-DD' → 'YYYYMMDD' */
function ymd(key) {
  return String(key).replace(/-/g, '');
}

/** 'YYYY-MM-DD' + 'HH:mm' → 'YYYYMMDDTHHMMSS' (floating local time) */
function ymdhms(key, time) {
  return `${ymd(key)}T${String(time).replace(':', '')}00`;
}

/**
 * 75옥텟 줄바꿈(folding). 한글은 UTF-8 에서 3바이트라 글자 수로 자르면 규격을 넘긴다.
 * 이어지는 줄은 공백 한 칸으로 시작해야 한다.
 */
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;

  const out = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    // 이어지는 줄은 선행 공백 1바이트를 쓰므로 한도를 74로 잡는다
    const limit = out.length === 0 ? 75 : 74;
    if (curBytes + n > limit) {
      out.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += n;
  }
  if (cur) out.push(cur);
  return out[0] + out.slice(1).map((s) => '\r\n ' + s).join('');
}

const FREQ_MAP = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };

/**
 * 일정을 iCalendar 로 내보낸다. 구글/아웃룩 캘린더로 가져갈 수 있다.
 *
 * 시각이 없는 일정은 종일(all-day) 이벤트로, 시각이 있으면 시간 이벤트로 쓴다.
 *
 * 시간 이벤트는 **floating local time** 으로 쓴다 — TZID 도 Z 도 붙이지 않는다.
 * 이 앱은 날짜도 시각도 로컬 벽시계 문자열로만 다루므로(타임존 개념이 없다)
 * '보는 사람의 현지 시각'이라는 floating 의 뜻이 데이터와 정확히 일치한다.
 * TZID 를 붙이려면 VTIMEZONE 블록을 규격대로 실어야 하는데, 있지도 않은
 * 타임존 정보를 지어내는 셈이라 더 나쁘다.
 */
export function toICS(tasks, { name = '일정관리 비서' } = {}) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//schedule-widget//KO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
  ];

  for (const t of tasks) {
    if (!t.start) continue;   // '언젠가' 는 날짜가 없어 캘린더로 옮길 수 없다

    // 종일 이벤트의 DTEND 는 '끝난 다음 날'(exclusive)이다.
    // 반복 일정은 당일만 지원하므로 하루짜리로 쓴다.
    const startKey = t.start;
    const endKey = t.repeat ? t.start : (t.end || t.start);

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${esc(t.id)}@schedule-widget`);
    lines.push(`DTSTAMP:${stamp}`);

    if (t.startTime) {
      lines.push(`DTSTART:${ymdhms(startKey, t.startTime)}`);
      // 종료 시각이 없으면 DTEND 를 쓰지 않는다. RFC 5545 는 그 경우
      // DTSTART 와 같은 시점에 끝나는 것으로 정의한다 — 길이를 지어내지 않는다.
      if (t.endTime) lines.push(`DTEND:${ymdhms(endKey, t.endTime)}`);
      else if (endKey > startKey) lines.push(`DTEND:${ymdhms(endKey, t.startTime)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${ymd(startKey)}`);
      lines.push(`DTEND;VALUE=DATE:${ymd(addDays(endKey, 1))}`);
    }

    lines.push(fold(`SUMMARY:${esc(t.title)}`));

    if (t.notes) lines.push(fold(`DESCRIPTION:${esc(t.notes)}`));
    if (t.link) lines.push(fold(`URL:${esc(t.link)}`));
    if (t.tags?.length) lines.push(fold(`CATEGORIES:${t.tags.map(esc).join(',')}`));
    if (t.priority === 2) lines.push('PRIORITY:1');
    else if (t.priority === 1) lines.push('PRIORITY:5');
    if (!t.repeat && t.done) lines.push('STATUS:CONFIRMED');

    if (t.repeat && FREQ_MAP[t.repeat.freq]) {
      let rule = `RRULE:FREQ=${FREQ_MAP[t.repeat.freq]}`;
      if (t.repeat.interval > 1) rule += `;INTERVAL=${t.repeat.interval}`;
      // UNTIL 도 DTSTART 와 값 타입을 맞춘다
      if (t.repeat.until) {
        rule += `;UNTIL=${t.startTime ? ymdhms(t.repeat.until, t.startTime) : ymd(t.repeat.until)}`;
      }
      lines.push(rule);

      if (t.exceptions?.length) {
        // EXDATE 의 값 타입은 DTSTART 와 같아야 한다. 시간 이벤트인데
        // VALUE=DATE 로 쓰면 파서가 예외를 통째로 무시한다.
        lines.push(t.startTime
          ? fold(`EXDATE:${t.exceptions.map((k) => ymdhms(k, t.startTime)).join(',')}`)
          : fold(`EXDATE;VALUE=DATE:${t.exceptions.map(ymd).join(',')}`));
      }
    }

    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/** 파일 이름에 쓸 오늘 날짜 */
export function fileStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
