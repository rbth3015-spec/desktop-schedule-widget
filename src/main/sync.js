// 휴대폰 동기화 — 메인 쪽은 **파일만** 다룬다. 합치기는 렌더러(src/renderer/sync)가 한다.
//
// 왜 폴더인가
//   받은함과 같은 이유다. 포트를 열거나 계정을 만들지 않고, 이미 깔려 있는 동기화 도구
//   (OneDrive · Syncthing …)가 폴더를 기기 사이로 옮기게 둔다. PC 가 꺼져 있어도 폰은
//   제 파일을 쓰고, 다음에 만나면 합쳐진다.
//
// 폴더 안
//   sync-<기기ID>.json  기기마다 한 장, 그 기기만 쓴다 — 쓰는 사람이 하나라 클라우드
//                       '충돌 사본'이 생기지 않는다. 내용은 그 기기가 아는 전체 상태.
//
// 사용자 데이터 폴더 안
//   sync.json        고른 폴더 · 기기ID · 기기 이름
//   sync-state.json  내 레플리카(발행한 스냅샷) + 지난번 화면에 있던 키(known)
//
// Electron 을 부르지 않는다 — 대화상자 · 탐색기 열기는 main.js 가 맡고, 여기는 node 로 시험한다.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const FILE_RE = /^sync-([a-z0-9-]{3,64})\.json$/;
const SCHEMA = 'schedule-sync';
const MAX_BYTES = 32 * 1024 * 1024;
/** fs.watch 는 한 번 저장에 여러 번 울린다 — 잠깐 모았다가 읽는다 */
const DEBOUNCE_MS = 400;
/** 클라우드 도구가 쓴 파일은 fs.watch 가 놓치기도 한다 — 가끔 훑는다 */
const SWEEP_MS = 20 * 1000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** rename 재시도 — 백신 · 클라우드 도구가 잠깐 잡고 있을 수 있다(storage.js 와 같은 사정) */
function renameWithRetry(from, to, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const retriable = err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES';
      if (!retriable || i === attempts - 1) throw err;
      const until = Date.now() + 40;
      while (Date.now() < until) { /* busy wait */ }
    }
  }
}

/** 임시 파일에 다 쓰고 바꿔 끼운다 — 읽는 쪽이 반쯤 쓴 파일을 보지 않게 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
    renameWithRetry(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 이미 없으면 그만 */ }
    throw err;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {{userDataDir: string, hostname?: string, appVersion?: string, maxBytes?: number}} opts
 */
function createSyncHost({ userDataDir, hostname = os.hostname(), appVersion = '', maxBytes = MAX_BYTES }) {
  const configPath = path.join(userDataDir, 'sync.json');
  const statePath = path.join(userDataDir, 'sync-state.json');

  let config = readJson(configPath) || {};
  let deliver = null;
  let watcher = null;
  let sweepTimer = null;
  let debounce = null;
  let lastError = null;
  let lastPublishAt = 0;
  /** 이미 넘긴 파일 — 파일 이름 → 'mtime:size' */
  const seen = new Map();
  /** 마지막으로 읽은 다른 기기들 — 기기ID → {id, name, app, savedAt} */
  const peers = new Map();

  function saveConfig(next) {
    config = next;
    fs.mkdirSync(userDataDir, { recursive: true });
    writeJsonAtomic(configPath, config);
  }

  function ownFile() {
    return config.folder && config.deviceId ? path.join(config.folder, `sync-${config.deviceId}.json`) : null;
  }

  function status() {
    return {
      enabled: !!config.folder,
      folder: config.folder || null,
      deviceId: config.deviceId || null,
      deviceName: config.deviceName || hostname,
      app: `widget/${appVersion}`,
      peers: [...peers.values()].sort((a, b) => b.savedAt - a.savedAt),
      lastPublishAt,
      lastError,
    };
  }

  /** @returns {{ok:true, status} | {ok:false, error:string}} */
  function setFolder(folder) {
    const dir = path.resolve(String(folder || ''));
    if (!folder || !isDir(dir)) return { ok: false, error: '폴더를 찾을 수 없습니다.' };
    try {
      saveConfig({
        ...config,
        folder: dir,
        deviceId: config.deviceId || `pc-${crypto.randomBytes(5).toString('hex')}`,
        deviceName: config.deviceName || hostname,
      });
    } catch (err) {
      return { ok: false, error: `설정을 저장하지 못했습니다 — ${err.message}` };
    }
    seen.clear();
    peers.clear();
    lastError = null;
    restartWatch();
    return { ok: true, status: status() };
  }

  function disable() {
    stopWatch();
    seen.clear();
    peers.clear();
    lastError = null;
    try {
      saveConfig({ ...config, folder: null });
    } catch (err) {
      lastError = `설정을 저장하지 못했습니다 — ${err.message}`;
    }
    return status();
  }

  /** 지난번 레플리카 — {snapshot, known} 또는 null */
  function loadState() {
    const s = readJson(statePath);
    if (!s || typeof s !== 'object' || !s.snapshot || typeof s.snapshot !== 'object') return null;
    return { snapshot: s.snapshot, known: Array.isArray(s.known) ? s.known.map(String) : [] };
  }

  /**
   * 내 상태를 쓴다 — 사용자 데이터 폴더(레플리카 원본)와 동기화 폴더(남들이 읽는 것) 둘 다.
   * 파일 이름은 설정의 기기ID 로 정한다(렌더러가 보낸 값을 믿지 않는다).
   */
  function publish({ snapshot, known } = {}) {
    if (!config.folder || !config.deviceId) return { ok: false, error: '동기화가 꺼져 있습니다.' };
    if (!snapshot || typeof snapshot !== 'object' || snapshot.schema !== SCHEMA) {
      return { ok: false, error: '동기화 파일 모양이 아닙니다.' };
    }
    try {
      writeJsonAtomic(statePath, { snapshot, known: Array.isArray(known) ? known.map(String) : [] });
      writeJsonAtomic(ownFile(), snapshot);
      lastPublishAt = Date.now();
      lastError = null;
      return { ok: true };
    } catch (err) {
      lastError = isDir(config.folder)
        ? `동기화 파일을 쓰지 못했습니다 — ${err.message}`
        : '동기화 폴더를 찾을 수 없습니다 — 설정에서 다시 골라 주세요.';
      return { ok: false, error: lastError };
    }
  }

  /** 바뀐 다른 기기 파일들 — [{deviceId, file, sig, snapshot}] (아직 넘긴 것으로 치지 않는다) */
  function collect() {
    if (!config.folder) return [];
    let names;
    try {
      names = fs.readdirSync(config.folder);
    } catch {
      lastError = '동기화 폴더를 찾을 수 없습니다 — 설정에서 다시 골라 주세요.';
      return [];
    }
    const out = [];
    for (const name of names.sort()) {
      const m = FILE_RE.exec(name);
      if (!m || m[1] === config.deviceId) continue;
      const file = path.join(config.folder, name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > maxBytes) continue;
      const sig = `${stat.mtimeMs}:${stat.size}`;
      if (seen.get(name) === sig) continue;
      const snapshot = readJson(file);
      // 쓰는 중이라 깨졌을 수 있다 — 표시하지 않고 다음 훑기에 다시 본다
      if (!snapshot || snapshot.schema !== SCHEMA) continue;
      out.push({ deviceId: m[1], file: name, sig, snapshot });
    }
    return out;
  }

  /** 한 번 훑어 바뀐 것을 렌더러에 넘긴다. @returns {number} 넘긴 파일 수 */
  function sweep() {
    const list = collect();
    if (!list.length || !deliver) return 0;
    if (!deliver(list.map(({ deviceId, file, snapshot }) => ({ deviceId, file, snapshot })))) return 0;
    for (const item of list) {
      seen.set(item.file, item.sig);
      const d = item.snapshot.device || {};
      peers.set(item.deviceId, {
        id: item.deviceId,
        name: String(d.name || item.deviceId),
        app: String(d.app || ''),
        savedAt: Number(item.snapshot.savedAt) || 0,
      });
    }
    return list.length;
  }

  function schedule() {
    clearTimeout(debounce);
    debounce = setTimeout(sweep, DEBOUNCE_MS);
  }

  function stopWatch() {
    clearTimeout(debounce);
    clearInterval(sweepTimer);
    sweepTimer = null;
    try { watcher?.close(); } catch { /* 무시 */ }
    watcher = null;
  }

  let watchEnabled = true;
  function restartWatch() {
    stopWatch();
    if (!deliver || !config.folder) return;
    if (watchEnabled) {
      try {
        watcher = fs.watch(config.folder, { persistent: false }, (_type, name) => {
          if (!name || FILE_RE.test(String(name))) schedule();
        });
        watcher.on('error', () => { /* 폴더가 사라지면 훑기가 오류를 알린다 */ });
      } catch {
        // 감시를 못 걸어도 훑기는 돈다
      }
      sweepTimer = setInterval(sweep, SWEEP_MS);
    }
  }

  /**
   * @param {(list: object[]) => boolean} send 렌더러에 넘긴다. 아직 못 받으면 false.
   * @param {{watch?: boolean}} [opts] 시험에서는 감시 없이 sweep() 만 부른다
   */
  function start(send, { watch = true } = {}) {
    deliver = send;
    watchEnabled = watch;
    restartWatch();
  }

  function stop() {
    stopWatch();
    deliver = null;
  }

  /** 렌더러가 (다시) 준비됐다 — 전부 다시 넘긴다 */
  function flush() {
    seen.clear();
    return sweep();
  }

  return { status, setFolder, disable, loadState, publish, start, stop, sweep, flush };
}

module.exports = { createSyncHost, FILE_RE };
