// 동기화 파일을 기기 사이로 옮기는 길 — 고른 폴더(OneDrive · Syncthing …) 또는 구글 드라이브의 숨김 앱 폴더.
// 둘 다 같은 꼴이라 src/main/sync.js 는 어느 길인지 모른 채 쓴다.
//
//   list()            → [{name, sig}]   sig — 바뀌었는지 가늠하는 값(수정 시각 · 크기)
//   read(name)        → 글 | null
//   write(name, text)
//   watch(onChange)   → 멈추는 함수 | null(지켜볼 수 없으면 sync.js 가 주기적으로 훑는다)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE_RE = /^sync-([a-z0-9-]{3,64})\.json$/;

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
function writeTextAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    renameWithRetry(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 이미 없으면 그만 */ }
    throw err;
  }
}

/** 고른 폴더 — 폴더를 옮기는 일은 바깥 동기화 도구가 한다 */
function createFolderTransport(dir) {
  return {
    kind: 'folder',
    async list() {
      const out = [];
      for (const name of fs.readdirSync(dir)) {
        if (!FILE_RE.test(name)) continue;
        try {
          const st = fs.statSync(path.join(dir, name));
          if (st.isFile()) out.push({ name, sig: `${st.mtimeMs}:${st.size}`, size: st.size });
        } catch { /* 지워지는 중 */ }
      }
      return out;
    },
    async read(name) {
      try {
        return fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        return null;
      }
    },
    async write(name, text) {
      writeTextAtomic(path.join(dir, name), text);
    },
    watch(onChange) {
      try {
        const w = fs.watch(dir, { persistent: false }, (_type, name) => {
          if (!name || FILE_RE.test(String(name))) onChange();
        });
        w.on('error', () => { /* 폴더가 사라지면 훑기가 오류를 알린다 */ });
        return () => { try { w.close(); } catch { /* 무시 */ } };
      } catch {
        return null;
      }
    },
  };
}

/**
 * 구글 드라이브의 숨김 앱 폴더(appDataFolder) — 같은 클라우드 프로젝트의 앱(위젯 · 안드로이드)만 본다.
 * @param {{getToken: () => Promise<string>, fetchImpl?: typeof fetch, base?: string}} o
 */
function createDriveTransport({ getToken, fetchImpl = (...a) => fetch(...a), base = 'https://www.googleapis.com' }) {
  const ids = new Map();   // 파일 이름 → 드라이브 파일 ID

  async function call(url, init = {}) {
    const token = await getToken();
    const res = await fetchImpl(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`구글 드라이브 오류 ${res.status}`);
      err.status = res.status;
      err.detail = body.slice(0, 300);
      throw err;
    }
    return res;
  }

  async function findId(name) {
    if (ids.has(name)) return ids.get(name);
    const q = new URLSearchParams({
      spaces: 'appDataFolder',
      fields: 'files(id,name)',
      q: `name = '${name}' and trashed = false`,
    });
    const j = await (await call(`${base}/drive/v3/files?${q}`)).json();
    const id = j.files?.[0]?.id || null;
    if (id) ids.set(name, id);
    return id;
  }

  return {
    kind: 'google',
    async list() {
      const out = [];
      let pageToken = '';
      do {
        const q = new URLSearchParams({
          spaces: 'appDataFolder',
          fields: 'nextPageToken,files(id,name,modifiedTime,size)',
          pageSize: '1000',
          q: "name contains 'sync-' and trashed = false",
        });
        if (pageToken) q.set('pageToken', pageToken);
        const j = await (await call(`${base}/drive/v3/files?${q}`)).json();
        for (const f of j.files || []) {
          if (!FILE_RE.test(f.name)) continue;
          ids.set(f.name, f.id);
          out.push({ name: f.name, sig: `${f.modifiedTime}:${f.size}`, size: Number(f.size) || 0 });
        }
        pageToken = j.nextPageToken || '';
      } while (pageToken);
      return out;
    },
    async read(name) {
      const id = await findId(name);
      if (!id) return null;
      return (await call(`${base}/drive/v3/files/${id}?alt=media`)).text();
    },
    async write(name, text) {
      const id = await findId(name);
      if (id) {
        await call(`${base}/upload/drive/v3/files/${id}?uploadType=media`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json; charset=UTF-8' },
          body: text,
        });
        return;
      }
      const boundary = `sync${crypto.randomBytes(8).toString('hex')}`;
      const body = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n`
        + `${JSON.stringify({ name, parents: ['appDataFolder'] })}\r\n`
        + `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
      const j = await (await call(`${base}/upload/drive/v3/files?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        body,
      })).json();
      if (j.id) ids.set(name, j.id);
    },
    watch() {
      return null;
    },
  };
}

module.exports = { createFolderTransport, createDriveTransport, writeTextAtomic, FILE_RE };
