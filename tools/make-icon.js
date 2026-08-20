// 앱 아이콘 생성기. tools/icon.html 을 구워 build/icon.png 과 build/icon.ico 를 만든다.
//
//   npx electron tools/make-icon.js
//
// .ico 를 직접 만드는 이유: electron-builder 의 PNG->ICO 변환기(WebAssembly)가
// 이 환경에서 'could not allocate memory' 로 죽는다. ICO 는 PNG 를 담는 컨테이너라
// 규격대로 헤더만 붙이면 외부 라이브러리 없이 만들 수 있다.

const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'build', 'icon.png');
const ICO = path.join(__dirname, '..', 'build', 'icon.ico');
const SIZE = 512;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    x: -4000, y: 0,
    width: SIZE, height: SIZE,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: true,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });

  await win.loadFile(path.join(__dirname, 'icon.html'));
  await new Promise((r) => setTimeout(r, 600));

  // DPI 배율 때문에 캡처 크기가 창 크기와 다를 수 있어 마지막에 정확히 맞춘다
  let image = await win.webContents.capturePage();
  for (let i = 0; i < 6 && image.getSize().width === 0; i++) {
    await new Promise((r) => setTimeout(r, 300));
    image = await win.webContents.capturePage();
  }
  const resized = image.resize({ width: SIZE, height: SIZE, quality: 'best' });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, resized.toPNG());

  // --- .ico ---
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map((s) => ({
    size: s,
    buf: image.resize({ width: s, height: s, quality: 'best' }).toPNG(),
  }));
  fs.writeFileSync(ICO, buildIco(pngs));

  console.log(JSON.stringify({
    png: OUT, pngSize: resized.getSize(),
    ico: ICO, icoBytes: fs.statSync(ICO).size, icoSizes: sizes,
  }));
  app.exit(resized.getSize().width === SIZE ? 0 : 2);
});

/**
 * PNG 여러 장을 ICO 컨테이너로 묶는다.
 * 구조: ICONDIR(6) + ICONDIRENTRY(16) x N + 이미지 데이터
 * 256px 는 폭/높이 바이트에 0 으로 적는 것이 규격이다.
 */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;

  entries.forEach((e, i) => {
    const at = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, at + 0);   // width
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, at + 1);   // height
    dir.writeUInt8(0, at + 2);             // 팔레트 색 수 (트루컬러면 0)
    dir.writeUInt8(0, at + 3);             // reserved
    dir.writeUInt16LE(1, at + 4);          // color planes
    dir.writeUInt16LE(32, at + 6);         // bits per pixel
    dir.writeUInt32LE(e.buf.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += e.buf.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.buf)]);
}
