// 휴대폰 동기화 — 렌더러 쪽 접착. 규칙은 crdt.js, 파일 읽기/쓰기는 메인(src/main/sync.js).
//
//   내 변경   store 가 바뀌면(1.5초 모아서) 저장되는 데이터를 레플리카와 비교해
//             달라진 필드에만 스탬프를 찍고 내 파일을 발행한다. store 의 액션은 건드리지 않는다.
//   남의 변경 메인이 다른 기기 파일을 넘겨주면 → 먼저 내 편집에 스탬프를 찍고 → 합치고 →
//             바뀐 레코드만 화면 상태에 덮어 store.replaceSynced 로 넘긴다.
//
// 렌더러는 한 줄기라 '비교 → 합치기 → 반영' 사이에 사용자의 편집이 끼어들지 않는다.

import * as crdt from './crdt.js';

/** 연달아 고칠 때(메모 타이핑 등) 한 번으로 모으는 간격 */
const TICK_MS = 1500;

/**
 * @param {{store: object, notify?: (n: number) => void}} deps
 *   notify — 다른 기기에서 받은 레코드 수를 알린다(토스트)
 * @returns {{refresh: () => Promise<object|null>}} 설정에서 폴더를 바꾸거나 끈 뒤 부른다
 */
export function wireSync({ store, notify }) {
  const api = window.api?.sync;
  if (!api) return { refresh: async () => null };

  let on = false;
  let device = null;
  let clock = null;
  let records = {};
  let known = [];
  let timer = null;
  let subscribed = false;

  const live = () => {
    const s = store.getState();
    return { tasks: s.tasks, todos: s.todos, journal: s.journal, retro: s.retro };
  };

  function publish() {
    if (!on) return;
    const snapshot = crdt.toSnapshot(records, device, clock.last(), Date.now());
    // 실패는 메인이 상태(lastError)에 남기고 설정 화면이 보여 준다. 다음 변경 때 다시 쓴다.
    api.publish({ snapshot, known }).catch(() => {});
  }

  /** 화면 상태 → 레플리카. @returns {boolean} 바뀐 것이 있었는가 */
  function tick() {
    clearTimeout(timer);
    timer = null;
    if (!on || !store.getState().ready) return false;
    const res = crdt.diffLive(records, live(), clock, known);
    records = res.records;
    known = res.known;
    return res.changed.size > 0;
  }

  function scheduleTick() {
    if (!on) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (tick()) publish(); }, TICK_MS);
  }

  function takeRemote(list) {
    if (!on || !Array.isArray(list)) return;
    tick();
    const changed = new Set();
    for (const item of list) {
      const snap = crdt.readSnapshot(item?.snapshot);
      if (!snap.ok || snap.device.id === device.id) continue;
      clock.observe(snap.clock);
      const merged = crdt.mergeRecords(records, snap.records);
      records = merged.records;
      for (const key of merged.changed) {
        changed.add(key);
        for (const reg of Object.values(records[key])) clock.observe(reg.t);
      }
    }
    if (!changed.size) return;

    store.replaceSynced(crdt.applyToLive(live(), records, changed));
    // 위젯 정규화가 받지 않은 레코드는 화면에 없다 — 그것을 '지운 것'으로 보지 않게 지금 화면 기준으로
    known = crdt.liveKeys(live());
    tick();   // 정규화가 고친 값이 있으면 그 값에 스탬프
    publish();
    notify?.(changed.size);
  }

  /** 켜져 있으면 레플리카를 읽어 시작하고, 꺼져 있으면 멈춘다 */
  async function refresh() {
    const st = await api.status();
    if (!st?.enabled || !st.deviceId) {
      on = false;
      clearTimeout(timer);
      return st;
    }
    const saved = await api.loadState();
    const snap = saved ? crdt.readSnapshot(saved.snapshot) : null;
    const resume = !!(snap?.ok && snap.device.id === st.deviceId);

    device = { id: st.deviceId, name: st.deviceName, app: st.app };
    records = resume ? snap.records : {};
    known = resume ? saved.known : [];
    clock = crdt.createClock(st.deviceId, resume ? snap.clock : null);
    on = true;

    // 꺼져 있던 동안 고친 것(또는 처음 켤 때의 전부)에 스탬프. 폴더가 바뀌었을 수 있으니 늘 발행한다.
    tick();
    publish();
    if (!subscribed) {
      store.subscribe(scheduleTick);
      subscribed = true;
    }
    api.ready();   // 메인이 다른 기기 파일을 전부 다시 넘겨준다
    return st;
  }

  api.onRemote(takeRemote);
  return { refresh };
}
