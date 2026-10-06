// 배포판에 구글 연결 정보가 들어가는지 빌드 전에 확인한다.
//
//   npm run dist 가 먼저 부른다(package.json 의 predist)
//
// 연결 정보(src/main/google-client.json)는 저장소에 없다 — 따로 받은 파일을 그 자리에 두고 빌드한다.
// 빠진 채 빌드하면 오류 없이 '구글로 연결' 단추만 사라진 배포판이 나가므로, 여기서 멈춘다.
// 구글 연결 없이 만들려면 SCHEDULE_NO_GOOGLE=1 을 켜고 빌드한다.

const path = require('path');
const { loadClient } = require('../src/main/google-auth.js');

const FILE = path.join(__dirname, '..', 'src', 'main', 'google-client.json');

/** @returns {string|null} 빌드를 멈출 까닭, 괜찮으면 null */
function problem(file = FILE) {
  const client = loadClient(file);
  if (!client) return '구글 연결 정보가 없습니다 — 받은 google-client.json 을 src/main/ 에 두고 다시 빌드하세요.';
  if (/[<>]/.test(client.clientId + client.clientSecret)) {
    return '구글 연결 정보가 예시 그대로입니다 — google-client.json 을 받은 값으로 채우세요.';
  }
  return null;
}

if (require.main === module && !process.env.SCHEDULE_NO_GOOGLE) {
  const why = problem();
  if (why) {
    console.error(`\n✖ ${why}`);
    console.error('  구글 연결 없이 만들려면(PowerShell): $env:SCHEDULE_NO_GOOGLE=1; npm run dist\n');
    process.exit(1);
  }
}

module.exports = { problem };
