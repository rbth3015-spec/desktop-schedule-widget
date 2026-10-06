// 구글 로그인 · 드라이브 길 — 가짜 구글 서버(토큰 · 드라이브 appDataFolder)로 시험한다.

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createGoogleAuth, NeedsLogin } = require('../src/main/google-auth.js');
const { createDriveTransport } = require('../src/main/sync-transports.js');
const { createSyncHost } = require('../src/main/sync.js');

// ---------------------------------------------------------------- 가짜 구글

let server;
let base;
const google = { files: new Map(), nextId: 1, tokenCalls: 0, refreshOk: true, requests: 0 };

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

before(async () => {
  server = http.createServer(async (req, res) => {
    google.requests += 1;
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);
    if (url.pathname === '/token') {
      google.tokenCalls += 1;
      const p = new URLSearchParams(body);
      if (p.get('client_secret') !== 'sec') return json(res, 401, { error: 'invalid_client' });
      if (p.get('grant_type') === 'authorization_code') {
        return p.get('code') === 'good-code' && p.get('code_verifier')
          ? json(res, 200, { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 })
          : json(res, 400, { error: 'invalid_grant' });
      }
      if (p.get('grant_type') === 'refresh_token') {
        return p.get('refresh_token') === 'rt1' && google.refreshOk
          ? json(res, 200, { access_token: 'at2', expires_in: 3600 })
          : json(res, 400, { error: 'invalid_grant' });
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    // 아래는 드라이브 — 토큰이 있어야 한다
    if (!/^Bearer at[12]$/.test(req.headers.authorization || '')) return json(res, 401, { error: 'unauthorized' });
    if (url.pathname === '/drive/v3/about') return json(res, 200, { user: { emailAddress: 'me@example.com' } });
    if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
      assert.equal(url.searchParams.get('spaces'), 'appDataFolder');
      const q = url.searchParams.get('q') || '';
      const exact = /name = '([^']+)'/.exec(q)?.[1];
      const files = [...google.files.entries()]
        .filter(([, f]) => (exact ? f.name === exact : f.name.includes('sync-')))
        .map(([id, f]) => ({ id, name: f.name, modifiedTime: f.modifiedTime, size: String(Buffer.byteLength(f.content)) }));
      return json(res, 200, { files });
    }
    const media = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (media && url.searchParams.get('alt') === 'media') {
      const f = google.files.get(media[1]);
      if (!f) return json(res, 404, {});
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(f.content);
    }
    if (url.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
      const parts = body.split(/--[^\r\n]+/).map((p) => p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '')).filter(Boolean);
      const meta = JSON.parse(parts[0]);
      assert.deepEqual(meta.parents, ['appDataFolder']);
      const id = `f${google.nextId++}`;
      google.files.set(id, { name: meta.name, content: parts[1], modifiedTime: new Date().toISOString() });
      return json(res, 200, { id });
    }
    const patch = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (patch && req.method === 'PATCH') {
      const f = google.files.get(patch[1]);
      f.content = body;
      f.modifiedTime = new Date(Date.now() + google.nextId++).toISOString();
      return json(res, 200, { id: patch[1] });
    }
    return json(res, 404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-google-'));
  google.files.clear();
  google.refreshOk = true;
  google.requests = 0;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** 사용자가 브라우저에서 로그인하고 허용을 누른 것처럼 — 돌려보낼 주소로 code 를 보낸다 */
const browser = ({ code = 'good-code', badState = false } = {}) => (authUrl) => {
  const u = new URL(authUrl);
  const back = new URL(u.searchParams.get('redirect_uri'));
  back.searchParams.set('code', code);
  back.searchParams.set('state', badState ? 'tampered' : u.searchParams.get('state'));
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.appdata');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  setTimeout(() => fetch(back).catch(() => {}), 10);
};

function auth({ open = browser(), now = () => Date.now(), client = { clientId: 'cid', clientSecret: 'sec' } } = {}) {
  return createGoogleAuth({
    userDataDir: path.join(root, 'userData'), client, openExternal: open, now,
    tokenUrl: `${base}/token`, apiBase: base,
  });
}

// ---------------------------------------------------------------- 로그인

test('로그인: 브라우저에서 허용하면 계정을 알고, 토큰을 쓰다가 만료되면 갱신한다', async () => {
  let t = 1_000_000;
  const a = auth({ now: () => t });
  assert.equal(a.connected(), false);
  assert.deepEqual(await a.login(), { email: 'me@example.com' });
  assert.equal(a.connected(), true);
  assert.equal(a.account(), 'me@example.com');
  assert.equal(await a.token(), 'at1', '방금 받은 토큰을 쓴다');
  t += 3600 * 1000;
  assert.equal(await a.token(), 'at2', '만료되면 갱신 토큰으로 새로 받는다');
  assert.ok(!fs.readFileSync(path.join(root, 'userData', 'google-auth.bin'), 'utf8').includes('at1'), '접근 토큰은 디스크에 두지 않는다');
});

test('로그인: 돌아온 state 가 다르면 받지 않는다', async () => {
  await assert.rejects(auth({ open: browser({ badState: true }) }).login(), /응답이 맞지 않습니다/);
});

test('로그인: 연결 정보가 없는 빌드는 로그인할 수 없다', async () => {
  const a = auth({ client: null });
  assert.equal(a.available, false);
  await assert.rejects(a.login(), /연결 정보가 없습니다/);
});

test('끊기: 이 PC 의 토큰만 지운다 — 구글 쪽 권한은 회수하지 않는다', async () => {
  const a = auth();
  await a.login();
  const before = google.requests;
  await a.logout();
  // 권한은 클라우드 프로젝트 하나에 묶여 폰 앱도 같이 쓴다 — 회수하면 폰 토큰까지 죽는다(2026-10-06 실측)
  assert.equal(google.requests, before, '끊기는 구글에 아무 요청도 보내지 않는다');
  assert.equal(a.connected(), false);
  await assert.rejects(a.token(), NeedsLogin);
});

test('갱신 토큰이 무효가 되면 다시 연결하라고 한다', async () => {
  let t = 1_000_000;
  const a = auth({ now: () => t });
  await a.login();
  google.refreshOk = false;
  t += 3600 * 1000;
  await assert.rejects(a.token(), (err) => err.name === 'NeedsLogin');
});

// ---------------------------------------------------------------- 드라이브 길

test('드라이브: 처음엔 만들고, 그다음엔 같은 파일을 고친다', async () => {
  const d = createDriveTransport({ getToken: async () => 'at1', base });
  await d.write('sync-pc-aaaaaaaaaa.json', '{"v":1}');
  await d.write('sync-pc-aaaaaaaaaa.json', '{"v":2}');
  assert.equal(google.files.size, 1, '같은 이름의 파일이 두 개가 되지 않는다');
  const list = await d.list();
  assert.deepEqual(list.map((x) => x.name), ['sync-pc-aaaaaaaaaa.json']);
  assert.equal(await d.read('sync-pc-aaaaaaaaaa.json'), '{"v":2}');
  assert.equal(await d.read('sync-none-000.json'), null);
});

test('드라이브: 다시 켠 앱(이름 → ID 를 모르는 상태)도 있던 파일을 고친다', async () => {
  await createDriveTransport({ getToken: async () => 'at1', base }).write('sync-pc-aaaaaaaaaa.json', '{"v":1}');
  await createDriveTransport({ getToken: async () => 'at1', base }).write('sync-pc-aaaaaaaaaa.json', '{"v":3}');
  assert.equal(google.files.size, 1);
});

test('드라이브: 토큰이 틀리면 상태 코드를 담은 오류', async () => {
  const d = createDriveTransport({ getToken: async () => 'wrong', base });
  await assert.rejects(d.list(), (err) => err.status === 401);
});

// ---------------------------------------------------------------- 동기화 호스트 + 구글

test('호스트: 구글로 연결하면 내 파일을 드라이브에 쓰고, 다른 기기 파일을 넘겨준다', async () => {
  const userDataDir = path.join(root, 'userData');
  const g = auth();
  const h = createSyncHost({ userDataDir, hostname: 'MY-PC', appVersion: '1.7.0', google: g, driveBase: base });
  assert.equal(h.status().enabled, false);
  assert.equal(h.status().googleAvailable, true);

  const r = await h.connectGoogle();
  assert.equal(r.ok, true);
  assert.equal(r.status.kind, 'google');
  assert.equal(r.status.account, 'me@example.com');
  const { deviceId } = r.status;

  const snap = { schema: 'schedule-sync', version: 1, device: { id: deviceId, name: 'MY-PC', app: 'w' }, savedAt: 1, clock: null, records: {} };
  assert.equal((await h.publish({ snapshot: snap, known: [] })).ok, true);
  assert.ok([...google.files.values()].some((f) => f.name === `sync-${deviceId}.json`));

  // 폰이 올린 파일
  const phone = { ...snap, device: { id: 'android-bbbbbbbb', name: '폰', app: 'a' }, savedAt: 9 };
  google.files.set('phone', { name: 'sync-android-bbbbbbbb.json', content: JSON.stringify(phone), modifiedTime: 't1' });
  const got = [];
  h.start((list) => { got.push(...list); return true; }, { watch: false });
  assert.equal(await h.sweep(), 1);
  assert.deepEqual(got.map((x) => x.deviceId), ['android-bbbbbbbb']);
  assert.deepEqual(h.status().peers.map((p) => p.name), ['폰']);

  // 다시 켜도 구글 길이 남는다
  assert.equal(createSyncHost({ userDataDir, google: auth(), driveBase: base }).status().kind, 'google');

  // 끄면 이 PC 만 끊는다 — 같은 계정의 폰은 계속 동기화한다
  const before = google.requests;
  const off = await h.disable();
  assert.equal(off.enabled, false);
  assert.equal(google.requests, before);
  h.stop();
});

test('호스트: 구글 연결이 끊기면 상태에 다시 연결하라는 문구', async () => {
  const userDataDir = path.join(root, 'userData');
  let t = 1_000_000;
  const g = auth({ now: () => t });
  const h = createSyncHost({ userDataDir, google: g, driveBase: base });
  await h.connectGoogle();
  google.refreshOk = false;
  t += 3600 * 1000;
  h.start(() => true, { watch: false });
  assert.equal(await h.sweep(), 0);
  assert.match(h.status().lastError, /다시 연결/);
  h.stop();
});
