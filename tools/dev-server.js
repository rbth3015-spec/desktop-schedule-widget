// 개발 전용 정적 서버. src/renderer 를 캐시 없이 서빙한다.
// ES 모듈은 브라우저가 공격적으로 캐시해서, 고친 코드가 화면에 안 나오는 사고가 잦다.
// 실행: node tools/dev-server.js [port]

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const PORT = Number(process.argv[2]) || 5599;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? '/dev.html' : urlPath;

  // 루트 밖으로 나가는 경로는 거부한다
  const filePath = path.join(ROOT, rel);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('없는 파일: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-server] http://localhost:${PORT}/dev.html (캐시 없음)`);
});
