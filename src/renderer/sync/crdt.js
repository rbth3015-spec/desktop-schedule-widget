// 동기화의 핵심 — 기기마다 따로 고친 일정을 하나로 합치는 규칙. 순수 함수만 둔다.
//
// 모양 (docs/SYNC.md 가 기준)
//   레코드  'task:<id>' · 'todo:<id>' · 'journal:<YYYY-MM-DD>' · 'retro:<w:… | m:…>'
//   필드    레지스터 하나 = { v: 값, t: 스탬프 }. 필드마다 따로 합친다 —
//           폰에서 완료하고 PC 에서 제목을 고쳤으면 둘 다 남는다.
//   집합    일정의 doneDates · exceptions 는 원소마다 'doneDates@2026-10-06': true/false.
//           배열을 통째로 덮으면 서로 다른 날 체크한 회차 하나가 사라진다.
//   삭제    '_del': true (묘비). 지우지 않는다 — 작고, 없애면 꺼져 있던 기기가 되살린다.
//
// 합치기는 '레지스터마다 더 큰 스탬프가 이긴다' 하나뿐이다. 순서·중복과 상관없이
// 모든 기기가 같은 결과에 닿는다.
//
// DOM · window 를 쓰지 않는다 — node --test 로 그대로 시험하고, 안드로이드 앱이 같은 규칙을 옮겨 쓴다.

export const SCHEMA = 'schedule-sync';
export const VERSION = 1;

/** 원소 단위로 합치는 배열 필드 */
export const SET_FIELDS = Object.freeze({ task: Object.freeze(['doneDates', 'exceptions']) });

const DEL = '_del';
const MAX_COUNTER = 9999;
const STAMP_RE = /^(\d{13}):(\d{4}):([a-z0-9-]{1,64})$/;
const DEVICE_RE = /^[a-z0-9-]{3,64}$/;
const KEY_RE = /^(?:(task|todo):([A-Za-z0-9_.:-]{1,128})|(journal):(\d{4}-\d{2}-\d{2})|(retro):((?:w:\d{4}-\d{2}-\d{2})|(?:m:\d{4}-\d{2})))$/;

// ---------------------------------------------------------------- 스탬프 · 시계
//
// '<밀리초 13자리>:<카운터 4자리>:<기기ID>' — 폭이 고정이라 문자열 비교가 곧 시간 비교다.
// 새 스탬프는 지금까지 본 가장 큰 스탬프보다 늘 크다(하이브리드 논리 시계).
// 그래서 남의 변경을 본 뒤에 고친 것은, 두 기기 시계가 어긋나 있어도 그 변경을 이긴다.

export function makeStamp(ms, counter, device) {
  return `${String(ms).padStart(13, '0')}:${String(counter).padStart(4, '0')}:${device}`;
}

export function parseStamp(s) {
  const m = STAMP_RE.exec(String(s ?? ''));
  return m ? { ms: Number(m[1]), counter: Number(m[2]), device: m[3] } : null;
}

export function maxStamp(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
}

/**
 * @param {string} deviceId
 * @param {string|null} [last] 지난번까지 본 가장 큰 스탬프(저장해 둔 것)
 */
export function createClock(deviceId, last = null) {
  let lastStamp = parseStamp(last) ? last : null;
  return {
    next(now = Date.now()) {
      const prev = parseStamp(lastStamp);
      let ms = Math.max(Math.floor(Number(now) || 0), prev ? prev.ms : 0);
      let counter = 0;
      if (prev && ms === prev.ms) {
        counter = prev.counter + 1;
        if (counter > MAX_COUNTER) { ms += 1; counter = 0; }
      }
      lastStamp = makeStamp(ms, counter, deviceId);
      return lastStamp;
    },
    observe(stamp) {
      if (parseStamp(stamp)) lastStamp = maxStamp(lastStamp, stamp);
    },
    last() {
      return lastStamp;
    },
  };
}

// ---------------------------------------------------------------- 키

export function recordKey(kind, id) {
  return `${kind}:${id}`;
}

export function splitKey(key) {
  const at = key.indexOf(':');
  return { kind: key.slice(0, at), id: key.slice(at + 1) };
}

function isValidKey(key) {
  return KEY_RE.test(key);
}

function isRegister(reg) {
  return !!reg && typeof reg === 'object' && !Array.isArray(reg) && 'v' in reg && !!parseStamp(reg.t);
}

export function isAlive(rec) {
  return !(rec && rec[DEL] && rec[DEL].v === true);
}

// ---------------------------------------------------------------- 값 비교 · 복사

/** 키 순서와 무관한 JSON — 객체 값(반복 규칙 등)을 내용으로 비교한다 */
function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
}

function sameValue(a, b) {
  return canon(a) === canon(b);
}

function copy(v) {
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

// ---------------------------------------------------------------- 합치기

/**
 * 상대 레코드들을 내 쪽에 합친다. 입력은 바꾸지 않는다.
 * @returns {{records: object, changed: Set<string>}} changed — 값이 하나라도 바뀐 레코드 키
 */
export function mergeRecords(local, remote) {
  const records = { ...(local || {}) };
  const changed = new Set();
  for (const [key, rrec] of Object.entries(remote || {})) {
    if (!isValidKey(key) || !rrec || typeof rrec !== 'object' || Array.isArray(rrec)) continue;
    const lrec = records[key] || {};
    let next = null;
    for (const [field, reg] of Object.entries(rrec)) {
      if (!isRegister(reg)) continue;
      const cur = lrec[field];
      if (!cur || reg.t > cur.t) {
        if (!next) next = { ...lrec };
        next[field] = { v: copy(reg.v), t: reg.t };
      }
    }
    if (next) {
      records[key] = next;
      changed.add(key);
    }
  }
  return { records, changed };
}

// ---------------------------------------------------------------- 펼치기

/**
 * 레코드 → 화면 값. 지워졌으면 null.
 * 일정 · 할 일은 {id, ...필드}, 한 줄 기록 · 돌아보기는 글(비었으면 null).
 */
export function materialize(key, rec) {
  if (!rec || !isAlive(rec)) return null;
  const { kind, id } = splitKey(key);
  if (kind === 'journal' || kind === 'retro') {
    const text = rec.text?.v;
    return typeof text === 'string' && text ? text : null;
  }
  const out = { id };
  // 원소 레지스터가 하나라도 있는 집합만 싣는다 — 없으면 화면 값을 그대로 두게(빈 배열로 덮지 않게)
  const sets = {};
  const setNames = SET_FIELDS[kind] || [];
  for (const [field, reg] of Object.entries(rec)) {
    if (field === DEL) continue;
    const at = field.indexOf('@');
    if (at > 0) {
      const name = field.slice(0, at);
      if (!setNames.includes(name)) continue;
      if (!sets[name]) sets[name] = [];
      if (reg.v === true) sets[name].push(field.slice(at + 1));
      continue;
    }
    out[field] = copy(reg.v);
  }
  for (const [name, list] of Object.entries(sets)) out[name] = list.sort();
  return out;
}

// ---------------------------------------------------------------- diff (위젯 쪽 변경 감지)

/** 화면 상태(저장되는 모양)에 있는 레코드 키 */
export function liveKeys(live) {
  const keys = [];
  for (const t of live?.tasks || []) if (t?.id) keys.push(recordKey('task', t.id));
  for (const t of live?.todos || []) if (t?.id) keys.push(recordKey('todo', t.id));
  for (const [d, text] of Object.entries(live?.journal || {})) if (text) keys.push(recordKey('journal', d));
  for (const [s, text] of Object.entries(live?.retro || {})) if (text) keys.push(recordKey('retro', s));
  return keys;
}

/**
 * 화면 상태를 레플리카와 필드 단위로 비교해 달라진 필드에만 새 스탬프를 찍는다.
 *
 * known — 지난번 화면 상태에 있던 키. 여기 있었는데 지금 없으면 지운 것이다.
 *         known 에 없던 레코드(위젯 정규화가 받지 않은 것)는 지운 것으로 보지 않는다.
 * 화면 객체에 없는 필드(위젯이 모르는 필드)는 건드리지 않는다.
 *
 * @param {object} records 레플리카
 * @param {{tasks:object[], todos:object[], journal:object, retro:object}} live
 * @param {{next: () => string}} clock
 * @param {string[]} known
 * @returns {{records: object, changed: Set<string>, known: string[]}}
 */
export function diffLive(records, live, clock, known = []) {
  let next = records;
  const changed = new Set();
  const present = new Set();

  const write = (key, field, value) => {
    if (next === records) next = { ...records };
    const rec = next[key] === records[key] ? { ...(records[key] || {}) } : next[key];
    rec[field] = { v: copy(value), t: clock.next() };
    next[key] = rec;
    changed.add(key);
  };

  const diffObject = (kind, obj) => {
    const key = recordKey(kind, obj.id);
    present.add(key);
    const rec = (next[key]) || {};
    if (!isAlive(rec)) write(key, DEL, false);
    const setNames = SET_FIELDS[kind] || [];
    for (const [field, value] of Object.entries(obj)) {
      if (field === 'id' || field === 'occDate' || value === undefined) continue;
      if (setNames.includes(field)) {
        if (!Array.isArray(value)) continue;
        const listed = new Set(value.map(String));
        const cur = next[key] || {};
        for (const el of listed) {
          if (cur[`${field}@${el}`]?.v !== true) write(key, `${field}@${el}`, true);
        }
        for (const [f, reg] of Object.entries(cur)) {
          if (f.startsWith(`${field}@`) && reg.v === true && !listed.has(f.slice(field.length + 1))) {
            write(key, f, false);
          }
        }
        continue;
      }
      const reg = (next[key] || {})[field];
      if (!reg || !sameValue(reg.v, value)) write(key, field, value);
    }
  };

  const diffText = (kind, id, text) => {
    const key = recordKey(kind, id);
    if (text) present.add(key);
    const reg = (next[key] || {}).text;
    const value = text || '';
    if (!reg ? !!value : reg.v !== value) write(key, 'text', value);
  };

  for (const t of live?.tasks || []) if (t?.id) diffObject('task', t);
  for (const t of live?.todos || []) if (t?.id) diffObject('todo', t);
  for (const [d, text] of Object.entries(live?.journal || {})) diffText('journal', d, text);
  for (const [s, text] of Object.entries(live?.retro || {})) diffText('retro', s, text);

  // 지난번엔 있었는데 이제 없는 것 — 일정 · 할 일은 묘비, 글은 빈 글
  for (const key of known) {
    if (present.has(key)) continue;
    const rec = next[key];
    if (!rec) continue;
    const { kind } = splitKey(key);
    if (kind === 'journal' || kind === 'retro') {
      if (rec.text?.v) write(key, 'text', '');
    } else if (isAlive(rec)) {
      write(key, DEL, true);
    }
  }

  return { records: next, changed, known: [...present] };
}

// ---------------------------------------------------------------- 화면 상태에 반영

/**
 * 바뀐 레코드만 화면 상태에 덮는다. 레코드에 없는 필드는 화면 값을 그대로 둔다.
 * @returns {{tasks:object[], todos:object[], journal:object, retro:object}} 새 객체
 */
export function applyToLive(live, records, keys) {
  const tasks = [...(live?.tasks || [])];
  const todos = [...(live?.todos || [])];
  const journal = { ...(live?.journal || {}) };
  const retro = { ...(live?.retro || {}) };
  const lists = { task: tasks, todo: todos };
  const texts = { journal, retro };

  for (const key of keys) {
    const { kind, id } = splitKey(key);
    const value = materialize(key, records[key]);
    if (lists[kind]) {
      const list = lists[kind];
      const i = list.findIndex((x) => x.id === id);
      if (value === null) {
        if (i >= 0) list.splice(i, 1);
      } else if (i >= 0) {
        list[i] = { ...list[i], ...value };
      } else {
        list.push(value);
      }
    } else if (texts[kind]) {
      if (value === null) delete texts[kind][id];
      else texts[kind][id] = value;
    }
  }
  return { tasks, todos, journal, retro };
}

// ---------------------------------------------------------------- 스냅샷 파일

/** 폴더에 쓰는 한 장 — 이 기기가 아는 전체 상태 */
export function toSnapshot(records, device, clockLast, now = Date.now()) {
  return {
    schema: SCHEMA,
    version: VERSION,
    device: { id: String(device.id), name: String(device.name || ''), app: String(device.app || '') },
    savedAt: now,
    clock: clockLast || null,
    records,
  };
}

/**
 * 읽은 JSON 을 검사한다. 버전이 더 높은 기기의 파일은 읽지 않는다 — 모르는 규칙으로 합치면 망가진다.
 * @returns {{ok:true, records, device, clock, savedAt} | {ok:false, error:string}}
 */
export function readSnapshot(obj) {
  if (!obj || typeof obj !== 'object' || obj.schema !== SCHEMA) {
    return { ok: false, error: '동기화 파일이 아닙니다' };
  }
  if (obj.version !== VERSION) {
    return { ok: false, error: `다른 버전(${obj.version})의 동기화 파일입니다 — 앱을 같은 버전으로 맞춰 주세요` };
  }
  const id = obj.device?.id;
  if (!DEVICE_RE.test(String(id))) return { ok: false, error: '기기 정보가 없습니다' };
  if (!obj.records || typeof obj.records !== 'object' || Array.isArray(obj.records)) {
    return { ok: false, error: '레코드가 없습니다' };
  }
  // 이상한 키 · 레지스터는 여기서 걸러 낸다(합치기와 같은 기준)
  const { records } = mergeRecords({}, obj.records);
  return {
    ok: true,
    records,
    device: { id, name: String(obj.device.name || ''), app: String(obj.device.app || '') },
    clock: parseStamp(obj.clock) ? obj.clock : null,
    savedAt: Number(obj.savedAt) || 0,
  };
}
