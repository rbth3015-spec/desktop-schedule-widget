// 휴대폰 동기화 — 메인 쪽은 **파일만** 다룬다. 합치기는 렌더러(src/renderer/sync)가 한다.
//
// 파일을 옮기는 길은 두 가지(src/main/sync-transports.js):
//   폴더   고른 폴더 — 폴더를 기기 사이로 옮기는 일은 OneDrive · Syncthing 같은 도구가 한다.
//   구글   구글 드라이브의 숨김 앱 폴더 — 앱 안 구글 로그인 하나로 끝난다(src/main/google-auth.js).
// 어느 쪽이든 기기마다 자기 파일 sync-<기기ID>.json 한 장만 쓴다 — 쓰는 사람이 하나라 충돌 사본이 없다.
//
// 사용자 데이터 폴더 안
//   sync.json        길(kind) · 고른 폴더 · 기기ID · 기기 이름
//   sync-state.json  내 레플리카(발행한 스냅샷) + 지난번 화면에 있던 키(known)
//
// Electron 을 부르지 않는다 — 대화상자 · 브라우저 열기는 main.js 가 맡고, 여기는 node 로 시험한다.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createFolderTransport, createDriveTransport, writeTextAtomic, FILE_RE } = require('./sync-transports');

const SCHEMA = 'schedule-sync';
const MAX_BYTES = 32 * 1024 * 1024;
/** fs.watch 는 한 번 저장에 여러 번 울린다 — 잠깐 모았다가 읽는다 */
const DEBOUNCE_MS = 400;
/** 폴더: 클라우드 도구가 쓴 파일은 fs.watch 가 놓치기도 한다. 구글: 지켜볼 길이 없다 — 주기적으로 훑는다 */
const SWEEP_MS = { folder: 20 * 1000, google: 45 * 1000 };

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 예전 설정(kind 없이 folder 만 있던 것)은 폴더 길로 읽는다 */
function kindOf(config) {
  if (config.kind === 'google' || config.kind === 'folder') return config.kind;
  return config.folder ? 'folder' : null;
}

/**
 * @param {object} o
 * @param {string} o.userDataDir
 * @param {string} [o.hostname]
 * @param {string} [o.appVersion]
 * @param {number} [o.maxBytes]
 * @param {ReturnType<import('./google-auth').createGoogleAuth>|null} [o.google] 구글 로그인(없으면 구글 길을 못 쓴다)
 * @param {typeof fetch} [o.fetchImpl]  드라이브 호출(시험에서 바꿔 끼운다)
 * @param {string} [o.driveBase]
 */
function createSyncHost({
  userDataDir, hostname = os.hostname(), appVersion = '', maxBytes = MAX_BYTES,
  google = null, fetchImpl, driveBase,
}) {
  const configPath = path.join(userDataDir, 'sync.json');
  const statePath = path.join(userDataDir, 'sync-state.json');

  let config = readJson(configPath) || {};
  let transport = null;
  let deliver = null;
  let stopWatcher = null;
  let sweepTimer = null;
  let debounce = null;
  let watchEnabled = true;
  let sweeping = null;
  let lastError = null;
  let lastPublishAt = 0;
  /** 이미 넘긴 파일 — 파일 이름 → sig */
  const seen = new Map();
  /** 마지막으로 읽은 다른 기기들 — 기기ID → {id, name, app, savedAt} */
  const peers = new Map();

  function saveConfig(next) {
    config = next;
    fs.mkdirSync(userDataDir, { recursive: true });
    writeTextAtomic(configPath, JSON.stringify(config));
  }

  function buildTransport() {
    const kind = kindOf(config);
    if (kind === 'folder' && config.folder) return createFolderTransport(config.folder);
    if (kind === 'google' && google) {
      return createDriveTransport({ getToken: () => google.token(), fetchImpl, base: driveBase });
    }
    return null;
  }

  function ownName() {
    return `sync-${config.deviceId}.json`;
  }

  function ensureIdentity(next) {
    return {
      ...next,
      deviceId: config.deviceId || `pc-${crypto.randomBytes(5).toString('hex')}`,
      deviceName: config.deviceName || hostname,
    };
  }

  function status() {
    const kind = kindOf(config);
    return {
      enabled: !!kind && !!transport,
      kind,
      folder: kind === 'folder' ? config.folder || null : null,
      account: kind === 'google' && google ? google.account() : null,
      googleAvailable: !!google?.available,
      deviceId: config.deviceId || null,
      deviceName: config.deviceName || hostname,
      app: `widget/${appVersion}`,
      peers: [...peers.values()].sort((a, b) => b.savedAt - a.savedAt),
      lastPublishAt,
      lastError,
    };
  }

  function reset() {
    seen.clear();
    peers.clear();
    lastError = null;
  }

  /** @returns {{ok:true, status} | {ok:false, error:string}} */
  function setFolder(folder) {
    const dir = path.resolve(String(folder || ''));
    if (!folder || !isDir(dir)) return { ok: false, error: '폴더를 찾을 수 없습니다.' };
    try {
      saveConfig(ensureIdentity({ ...config, kind: 'folder', folder: dir }));
    } catch (err) {
      return { ok: false, error: `설정을 저장하지 못했습니다 — ${err.message}` };
    }
    transport = buildTransport();
    reset();
    restartWatch();
    return { ok: true, status: status() };
  }

  /** 브라우저로 구글 로그인 → 구글 길로 바꾼다. @returns {Promise<{ok:true, status}|{ok:false, error}>} */
  async function connectGoogle() {
    if (!google?.available) return { ok: false, error: '이 빌드에는 구글 연결 정보가 없습니다.' };
    try {
      await google.login();
      saveConfig(ensureIdentity({ ...config, kind: 'google', folder: null }));
    } catch (err) {
      return { ok: false, error: err.message || '구글에 연결하지 못했습니다.' };
    }
    transport = buildTransport();
    reset();
    restartWatch();
    return { ok: true, status: status() };
  }

  async function disable() {
    const wasGoogle = kindOf(config) === 'google';
    stopWatch();
    transport = null;
    reset();
    try {
      saveConfig({ ...config, kind: null, folder: null });
    } catch (err) {
      lastError = `설정을 저장하지 못했습니다 — ${err.message}`;
    }
    if (wasGoogle && google) await google.logout().catch(() => {});
    return status();
  }

  /** 지난번 레플리카 — {snapshot, known} 또는 null */
  function loadState() {
    const s = readJson(statePath);
    if (!s || typeof s !== 'object' || !s.snapshot || typeof s.snapshot !== 'object') return null;
    return { snapshot: s.snapshot, known: Array.isArray(s.known) ? s.known.map(String) : [] };
  }

  function describeError(err) {
    if (err?.name === 'NeedsLogin') return err.message;
    if (kindOf(config) === 'google') {
      return err?.status ? `${err.message} — 잠시 뒤 다시 시도합니다.` : '구글 드라이브에 닿지 못했습니다 — 인터넷 연결을 확인해 주세요.';
    }
    return isDir(config.folder) ? `동기화 파일을 쓰지 못했습니다 — ${err.message}` : '동기화 폴더를 찾을 수 없습니다 — 설정에서 다시 골라 주세요.';
  }

  /**
   * 내 상태를 쓴다 — 사용자 데이터 폴더(레플리카 원본)와 동기화 길(남들이 읽는 것) 둘 다.
   * 파일 이름은 설정의 기기ID 로 정한다(렌더러가 보낸 값을 믿지 않는다).
   */
  async function publish({ snapshot, known } = {}) {
    if (!transport || !config.deviceId) return { ok: false, error: '동기화가 꺼져 있습니다.' };
    if (!snapshot || typeof snapshot !== 'object' || snapshot.schema !== SCHEMA) {
      return { ok: false, error: '동기화 파일 모양이 아닙니다.' };
    }
    try {
      writeTextAtomic(statePath, JSON.stringify({ snapshot, known: Array.isArray(known) ? known.map(String) : [] }));
    } catch (err) {
      lastError = `레플리카를 저장하지 못했습니다 — ${err.message}`;
      return { ok: false, error: lastError };
    }
    try {
      await transport.write(ownName(), JSON.stringify(snapshot));
      lastPublishAt = Date.now();
      lastError = null;
      return { ok: true };
    } catch (err) {
      lastError = describeError(err);
      return { ok: false, error: lastError };
    }
  }

  /** 바뀐 다른 기기 파일들 — [{deviceId, file, sig, snapshot}] (아직 넘긴 것으로 치지 않는다) */
  async function collect() {
    if (!transport) return [];
    let list;
    try {
      list = await transport.list();
    } catch (err) {
      lastError = describeError(err);
      return [];
    }
    const out = [];
    for (const item of list.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const m = FILE_RE.exec(item.name);
      if (!m || m[1] === config.deviceId || item.size > maxBytes) continue;
      if (seen.get(item.name) === item.sig) continue;
      let snapshot = null;
      try {
        snapshot = JSON.parse((await transport.read(item.name)) || 'null');
      } catch {
        snapshot = null;   // 쓰는 중이라 깨졌을 수 있다 — 다음 훑기에 다시 본다
      }
      if (!snapshot || snapshot.schema !== SCHEMA) continue;
      out.push({ deviceId: m[1], file: item.name, sig: item.sig, snapshot });
    }
    return out;
  }

  /** 한 번 훑어 바뀐 것을 렌더러에 넘긴다. 겹쳐 부르면 진행 중인 것을 기다린다. @returns {Promise<number>} */
  function sweep() {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      const list = await collect();
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
    })().finally(() => { sweeping = null; });
    return sweeping;
  }

  function schedule() {
    clearTimeout(debounce);
    debounce = setTimeout(() => { sweep().catch(() => {}); }, DEBOUNCE_MS);
  }

  function stopWatch() {
    clearTimeout(debounce);
    clearInterval(sweepTimer);
    sweepTimer = null;
    stopWatcher?.();
    stopWatcher = null;
  }

  function restartWatch() {
    stopWatch();
    if (!deliver || !transport || !watchEnabled) return;
    stopWatcher = transport.watch(schedule);
    sweepTimer = setInterval(() => { sweep().catch(() => {}); }, SWEEP_MS[transport.kind] || SWEEP_MS.folder);
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

  transport = buildTransport();

  return { status, setFolder, connectGoogle, disable, loadState, publish, start, stop, sweep, flush };
}

module.exports = { createSyncHost, FILE_RE };
