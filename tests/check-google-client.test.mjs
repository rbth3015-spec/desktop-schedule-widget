// 배포판 빌드 전 검사 — 구글 연결 정보가 빠지거나 예시 그대로면 멈춘다(빠진 채 나가면 '구글로 연결' 이 사라진다).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { problem } = require('../tools/check-google-client.js');

/** 임시 폴더의 google-client.json — obj 가 없으면 파일을 만들지 않는다 */
function clientFile(obj) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gclient-')), 'google-client.json');
  if (obj !== undefined) fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

test('연결 정보 파일이 없으면 멈춘다', () => {
  assert.match(problem(clientFile()), /없습니다/);
});

test('예시 파일을 채우지 않고 복사했으면 멈춘다', () => {
  const example = fileURLToPath(new URL('../src/main/google-client.example.json', import.meta.url));
  assert.match(problem(example), /예시/);
});

test('값을 채운 연결 정보는 통과한다', () => {
  assert.equal(problem(clientFile({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'sec' })), null);
});
