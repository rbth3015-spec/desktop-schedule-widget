// README 스크린샷 다섯 장을 한 번에 다시 뽑는다.
//
//   npm run screens
//
// 실제 앱의 renderer 를 그대로 띄워 capturePage 로 굽는다(tools/capture.js).
// 화면이 바뀌면 이 명령만 다시 돌리면 되고, 손으로 찍은 것과 달리 결과가 재현된다.

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const ELECTRON = require('electron');

// [파일명, 설명, 추가 인자]
const SHOTS = [
  ['01-main', '기본 화면', ['--w', '1040', '--h', '720']],
  ['02-compose', '일정 추가 폼', ['--w', '1040', '--h', '720', '--exec', 'tools/shots/compose.js']],
  ['03-detail', '항목 상세', ['--w', '1040', '--h', '720', '--exec', 'tools/shots/detail.js']],
  // 브리핑은 내용이 짧아 큰 창에서는 아래가 휑하다. 흔히 쓰는 크기로 줄여 찍는다.
  ['04-brief', '아침 브리핑', ['--w', '1040', '--h', '560', '--set', '{"lastBriefDate":""}']],
  ['05-dark', '가죽(다크) 테마', ['--w', '1040', '--h', '720', '--theme', 'dark']],
];

let failed = 0;

for (const [name, label, extra] of SHOTS) {
  const out = path.join(OUT, `${name}.png`);
  const res = spawnSync(ELECTRON, [
    path.join('tools', 'capture.js'), '--out', out, '--delay', '1200', ...extra,
  ], { cwd: ROOT, encoding: 'utf8' });

  const line = (res.stdout || '').trim().split('\n').pop() || '';
  let info = null;
  try { info = JSON.parse(line); } catch { /* 파싱 실패는 아래에서 처리 */ }

  if (res.status !== 0 || !info || info.blank) {
    failed++;
    console.error(`✗ ${name}  ${label} — ${info && info.blank ? '빈 이미지(합성 실패)' : '캡처 실패'}`);
    if (res.stderr) console.error(res.stderr.trim().split('\n').slice(-3).join('\n'));
  } else {
    console.log(`✓ ${name}.png  ${info.width}x${info.height}  ${label}`);
  }
}

if (failed) {
  console.error(`\n${failed}장 실패`);
  process.exit(1);
}
console.log('\n스크린샷 5장을 docs/screenshots/ 에 새로 구웠습니다.');
