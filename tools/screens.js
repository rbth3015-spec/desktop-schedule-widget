// README 스크린샷을 한 번에 다시 뽑는다.
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
// 창 크기는 시안의 표지 폭(1312px + 창 여백)에 맞춘다 — 오른쪽 면이 452px 고정이라
// 좁게 찍으면 달력만 눌려 시안과 다른 비율이 된다.
const SIZE = ['--w', '1332', '--h', '900'];   // 캡처 창은 안쪽 폭이 4px 넓게 잡힌다 → 표지 1312px
const SHOTS = [
  ['01-main', '오늘', [...SIZE]],
  ['02-compose', '일정 추가', [...SIZE, '--exec', 'tools/shots/compose.js']],
  ['03-detail', '항목 상세', [...SIZE, '--exec', 'tools/shots/detail.js']],
  ['04-brief', '아침 브리핑', [...SIZE, '--set', '{"lastBriefDate":""}']],
  ['05-dark', '다크 테마', [...SIZE, '--theme', 'dark']],
  ['06-routine', '루틴', [...SIZE, '--exec', 'tools/shots/routine.js']],
  ['07-settings', '설정', [...SIZE, '--exec', 'tools/shots/settings.js']],
  ['08-plan', '계획 — 주간', [...SIZE, '--exec', 'tools/shots/plan.js']],
  ['09-plan-month', '계획 — 월간', [...SIZE, '--exec', 'tools/shots/plan-month.js']],
  ['10-theme', '테마', [...SIZE, '--exec', 'tools/shots/theme.js']],
  ['11-retro', '돌아보기', [...SIZE, '--exec', 'tools/shots/retro.js']],
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
console.log(`\n스크린샷 ${SHOTS.length}장을 docs/screenshots/ 에 새로 구웠습니다.`);
