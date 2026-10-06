// 메인 프로세스 쪽 동기화 — 설정 · 폴더 읽기 · 원자적 쓰기. Electron 없이 돈다.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSyncHost } = require('../src/main/sync.js');

let root;
let userData;
let folder;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-main-'));
  userData = path.join(root, 'userData');
  folder = path.join(root, 'shared');
  fs.mkdirSync(userData);
  fs.mkdirSync(folder);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const host = (opts = {}) => createSyncHost({ userDataDir: userData, hostname: 'MY-PC', appVersion: '1.7.0', ...opts });

function snapshotOf(id, extra = {}) {
  return { schema: 'schedule-sync', version: 1, device: { id, name: id, app: 'test' }, savedAt: 5, clock: null, records: {}, ...extra };
}

function writePeer(name, content) {
  fs.writeFileSync(path.join(folder, name), typeof content === 'string' ? content : JSON.stringify(content));
}

test('처음엔 꺼져 있고, 폴더를 고르면 기기ID 가 생기고 설정이 남는다', () => {
  const h = host();
  assert.equal(h.status().enabled, false);
  const st = h.setFolder(folder);
  assert.equal(st.ok, true);
  assert.equal(st.status.enabled, true);
  assert.equal(st.status.folder, folder);
  assert.match(st.status.deviceId, /^pc-[0-9a-f]{10}$/);
  assert.equal(st.status.deviceName, 'MY-PC');

  const again = host().status();
  assert.equal(again.folder, folder);
  assert.equal(again.deviceId, st.status.deviceId, '다시 켜도 같은 기기');
});

test('없는 폴더는 받지 않는다', () => {
  const r = host().setFolder(path.join(root, 'nope'));
  assert.equal(r.ok, false);
  assert.match(r.error, /폴더/);
});

test('끄면 폴더만 잊고 기기ID 는 그대로', () => {
  const h = host();
  const id = h.setFolder(folder).status.deviceId;
  const st = h.disable();
  assert.equal(st.enabled, false);
  assert.equal(st.folder, null);
  assert.equal(st.deviceId, id);
});

test('발행: 폴더와 사용자 데이터 폴더에 쓰고 임시 파일을 남기지 않는다', () => {
  const h = host();
  const { deviceId } = h.setFolder(folder).status;
  const snap = snapshotOf(deviceId, { records: { 'task:t1': { title: { v: 'x', t: '0000000000001:0000:pc-aaaaaaaaaa' } } } });
  const r = h.publish({ snapshot: snap, known: ['task:t1'] });
  assert.equal(r.ok, true);

  const shared = JSON.parse(fs.readFileSync(path.join(folder, `sync-${deviceId}.json`), 'utf8'));
  assert.deepEqual(shared, snap);
  assert.deepEqual(h.loadState(), { snapshot: snap, known: ['task:t1'] });
  assert.deepEqual(host().loadState(), { snapshot: snap, known: ['task:t1'] }, '재시작 뒤에도');
  assert.deepEqual(fs.readdirSync(folder).filter((f) => f.includes('.tmp')), []);
  assert.ok(h.status().lastPublishAt > 0);
});

test('꺼져 있으면 발행하지 않는다', () => {
  const r = host().publish({ snapshot: snapshotOf('pc-aaaaaaaaaa'), known: [] });
  assert.equal(r.ok, false);
});

test('읽기: 남의 올바른 파일만 넘기고, 자기 파일·이름이 다른 파일·깨진 파일은 건너뛴다', () => {
  const h = host();
  const { deviceId } = h.setFolder(folder).status;
  writePeer(`sync-${deviceId}.json`, snapshotOf(deviceId));
  writePeer('sync-android-abc123.json', snapshotOf('android-abc123'));
  writePeer('sync-BAD.json', snapshotOf('BAD'));
  writePeer('notes.txt', 'hello');
  writePeer('sync-broken-1.json', '{"schema": "schedule-sy');
  writePeer('sync-other-schema.json', { schema: 'something-else' });

  const got = [];
  h.start((list) => { got.push(...list); return true; }, { watch: false });
  const n = h.sweep();
  h.stop();

  assert.equal(n, 1);
  assert.deepEqual(got.map((x) => x.deviceId), ['android-abc123']);
  assert.equal(got[0].snapshot.device.id, 'android-abc123');
  assert.deepEqual(h.status().peers.map((p) => p.id), ['android-abc123']);
});

test('읽기: 바뀐 파일만 다시 넘기고, 넘기지 못했으면 다음에 다시 넘긴다', () => {
  const h = host();
  h.setFolder(folder);
  writePeer('sync-android-abc123.json', snapshotOf('android-abc123'));

  let accept = false;
  const got = [];
  h.start((list) => { if (!accept) return false; got.push(...list); return true; }, { watch: false });

  assert.equal(h.sweep(), 0, '렌더러가 아직 못 받으면 0');
  accept = true;
  assert.equal(h.sweep(), 1, '다음 훑기에 넘긴다');
  assert.equal(h.sweep(), 0, '그대로면 다시 넘기지 않는다');

  writePeer('sync-android-abc123.json', snapshotOf('android-abc123', { savedAt: 999999 }));
  assert.equal(h.sweep(), 1, '내용이 바뀌면 다시');

  h.flush();
  assert.equal(got.length, 3, 'flush 는 전부 다시 넘긴다');
  h.stop();
});

test('너무 큰 파일은 읽지 않는다', () => {
  const h = host({ maxBytes: 100 });
  h.setFolder(folder);
  writePeer('sync-android-abc123.json', snapshotOf('android-abc123', { pad: 'x'.repeat(500) }));
  const got = [];
  h.start((list) => { got.push(...list); return true; }, { watch: false });
  assert.equal(h.sweep(), 0);
  h.stop();
});

test('폴더가 사라지면 상태에 오류를 남기고 죽지 않는다', () => {
  const h = host();
  const { deviceId } = h.setFolder(folder).status;
  fs.rmSync(folder, { recursive: true, force: true });
  h.start(() => true, { watch: false });
  assert.equal(h.sweep(), 0);
  const r = h.publish({ snapshot: snapshotOf(deviceId), known: [] });
  assert.equal(r.ok, false);
  assert.ok(h.status().lastError);
  h.stop();
});
