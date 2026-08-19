// 디자인 검토용 스크린샷 도구. 실제 앱(main.js)과 완전히 분리되어 있어
// 트레이·전역 단축키·창 상태 저장·사용자 데이터에 일절 손대지 않는다.
//
//   npx electron tools/capture.js --out shot.png [--theme light|dark]
//                                 [--w 1100] [--h 700] [--delay 900]
//                                 [--set '{"opacity":0.9}']
//                                 [--exec script.js]   캡처 전에 페이지에서 실행할 JS 파일
//                                                      (폼 열기·드래그 재현 등 상태 연출용)
//
// 창은 화면 밖(-4000)에 띄워 캡처하므로 사용자 화면에 나타나지 않는다.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT = path.resolve(arg('out', 'capture.png'));
const THEME = arg('theme', 'light');
const W = Number(arg('w', 1100));
const H = Number(arg('h', 700));
const DELAY = Number(arg('delay', 900));

// 렌더러 설정 오버라이드를 preload 로 넘긴다
const settings = { theme: THEME, ...JSON.parse(arg('set', '{}')) };
process.env.CAPTURE_SETTINGS = JSON.stringify(settings);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    x: -4000, y: 0,              // 화면 밖 — 사용자 눈에 띄지 않게
    width: W,
    height: H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: true,
    show: true,                  // 합성이 돌아야 capturePage 가 빈 이미지가 아니다
    webPreferences: {
      preload: path.join(__dirname, 'capture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  // 폰트 로딩과 첫 렌더가 끝날 때까지 기다린다
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)').catch(() => {});
  await new Promise((r) => setTimeout(r, DELAY));

  // 특정 상태(폼이 열린 화면 등)를 찍으려면 페이지에서 스크립트를 돌린다
  const execPath = arg('exec', '');
  if (execPath) {
    const code = fs.readFileSync(path.resolve(execPath), 'utf8');
    try {
      const result = await win.webContents.executeJavaScript(code, true);
      if (result !== undefined) console.error('[exec] ' + JSON.stringify(result));
    } catch (err) {
      console.error('[exec] 실패: ' + (err && err.message));
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const image = await win.webContents.capturePage();
  const png = image.toPNG();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, png);

  // 캡처가 실제로 내용을 담았는지 (전부 같은 색이면 합성 실패)
  const { width, height } = image.getSize();
  const bmp = image.toBitmap();
  const first = bmp.subarray(0, 4).join(',');
  let uniform = true;
  for (let i = 4; i < bmp.length; i += 4004) {
    if (bmp.subarray(i, i + 4).join(',') !== first) { uniform = false; break; }
  }

  console.log(JSON.stringify({
    out: OUT, bytes: png.length, width, height, theme: THEME,
    blank: uniform,
  }));

  app.exit(uniform ? 2 : 0);
});
