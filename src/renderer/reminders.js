// 리마인더 스케줄러.
//
// Windows 의 시스템 알림 내역(토스트 히스토리)은 UWP UserNotificationListener 권한이
// 필요해 일반 Electron 앱에서 읽을 수 없다. 그래서 '남의 알림을 수집'하는 대신
// 이 앱이 자기 일정으로 직접 알림을 띄우고, 그 기록을 자체 보관한다.

import { fromKey, formatTimeKo, WEEKDAY_LABELS } from './lib/date.js';

const TICK_MS = 30_000;          // 30초마다 확인 (상시 구동이라 더 자주 돌 이유가 없다)
const STALE_MS = 6 * 60 * 60_000; // 6시간 넘게 지난 건 조용히 지나간 것으로 처리

/**
 * @param {typeof import('./store.js')} store
 * @returns {{ destroy(): void, checkNow(): void }}
 */
export function startReminders(store) {
  let timer = null;
  let disposed = false;

  async function check() {
    if (disposed) return;
    const now = Date.now();
    const due = store.dueReminders(now);
    if (!due.length) return;

    for (const task of due) {
      const at = store.remindTime(task);

      // 컴퓨터가 꺼져 있던 동안 지나간 알림까지 한꺼번에 띄우면 알림 폭탄이 된다.
      // 오래된 건 기록만 남기고 알림은 생략한다.
      const stale = at !== null && now - at > STALE_MS;

      if (!stale) {
        try {
          await window.api.reminder.notify({
            title: task.title || '일정 알림',
            body: describe(task),
            taskId: task.id,
          });
        } catch {
          // 알림 실패가 앱 동작을 막을 이유는 없다. 기록은 남긴다.
        }
      }
      store.markReminded(task.id, now, { log: !stale });
    }
  }

  timer = setInterval(check, TICK_MS);
  // 켜자마자 한 번 확인 (앱이 꺼져 있는 동안 지나간 일정 처리)
  check();

  return {
    checkNow: check,
    destroy() {
      disposed = true;
      clearInterval(timer);
      timer = null;
    },
  };
}

/** 알림 본문 — 언제 일인지 한 줄로 */
function describe(task) {
  if (!task.start) return '날짜가 지정되지 않은 일정입니다.';
  const d = fromKey(task.start);
  const when = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY_LABELS[d.getDay()]})`;
  const span = task.end && task.end > task.start ? ` ~ ${spanLabel(task.end)}` : '';
  // 시각이 있으면 알림 본문에서 가장 쓸모 있는 정보다 — 날짜 바로 뒤에 붙인다
  const time = task.startTime ? ` ${formatTimeKo(task.startTime)}` : '';
  const note = task.notes ? `\n${task.notes.slice(0, 120)}` : '';
  return `${when}${span}${time}${note}`;
}

function spanLabel(key) {
  const d = fromKey(key);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/** 알림 설정 → 사람이 읽는 문구. '0@09:00' → '당일 오전 9:00', '-30m' → '30분 전' */
export function remindLabel(remind) {
  const raw = String(remind || '');

  // 상대 알림 — 시작 시각이 있는 일정에서만 쓰인다
  const rel = /^-(\d{1,4})m$/.exec(raw);
  if (rel) {
    const mins = Number(rel[1]);
    if (mins < 60) return `${mins}분 전`;
    if (mins % 60 === 0) return `${mins / 60}시간 전`;
    return `${Math.floor(mins / 60)}시간 ${mins % 60}분 전`;
  }

  const m = /^(\d{1,2})@([01]\d|2[0-3]):([0-5]\d)$/.exec(raw);
  if (!m) return '';
  const days = Number(m[1]);
  const hour = Number(m[2]);
  const minute = m[3];
  const dayPart = days === 0 ? '당일' : `${days}일 전`;
  const ampm = hour < 12 ? '오전' : '오후';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${dayPart} ${ampm} ${h12}:${minute}`;
}

/** 알림 기록 표시용 상대 시각 */
export function timeAgo(ts, now = Date.now()) {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
