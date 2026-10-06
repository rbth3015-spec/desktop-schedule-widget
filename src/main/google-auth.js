// 구글 로그인 — 휴대폰 동기화를 구글 드라이브의 숨김 앱 폴더로 할 때만 쓴다(설정에서 켤 때).
//
// 데스크톱 앱 OAuth(PKCE + 루프백): 기본 브라우저로 구글 로그인 화면을 열고, 로그인이 끝나면
// 구글이 http://127.0.0.1:<임시 포트> 로 돌려보낸다. 그 포트는 **로그인하는 동안만** 이 컴퓨터 안에서
// 열렸다 닫힌다(밖에서 들어올 수 없는 주소).
//
// 권한은 drive.appdata 하나 — 이 앱이 만든 숨김 폴더만 보고, 사용자의 다른 드라이브 파일은 못 본다.
// 갱신 토큰은 운영체제 암호화(Electron safeStorage, Windows 는 DPAPI)로 싸서 사용자 데이터 폴더에 둔다.
//
// Electron 을 부르지 않는다 — 브라우저 열기 · 암호화는 main.js 가 넘겨준다(node 로 시험한다).

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

class NeedsLogin extends Error {
  constructor(message = '구글 연결이 끊겼습니다 — 설정에서 다시 연결해 주세요.') {
    super(message);
    this.name = 'NeedsLogin';
  }
}

const PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px/1.6 'Malgun Gothic',sans-serif;background:#f6f1e7;color:#2b2a27;display:grid;place-items:center;height:90vh">
<div style="text-align:center"><h2 style="font-weight:600">${title}</h2><p>${body}</p></div></body>`;

/**
 * @param {object} o
 * @param {string} o.userDataDir
 * @param {{clientId:string, clientSecret:string}|null} o.client  이 빌드에 넣은 데스크톱 OAuth 클라이언트(없으면 구글 연결 불가)
 * @param {(url:string) => any} o.openExternal  기본 브라우저로 열기
 * @param {(s:string) => Buffer} [o.protect]     암호화(기본: 그대로)
 * @param {(b:Buffer) => string} [o.unprotect]
 * @param {typeof fetch} [o.fetchImpl]
 */
function createGoogleAuth({
  userDataDir,
  client,
  openExternal,
  protect = (s) => Buffer.from(s, 'utf8'),
  unprotect = (b) => Buffer.from(b).toString('utf8'),
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
  authUrl = 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl = 'https://oauth2.googleapis.com/token',
  revokeUrl = 'https://oauth2.googleapis.com/revoke',
  apiBase = 'https://www.googleapis.com',
}) {
  const file = path.join(userDataDir, 'google-auth.bin');
  let access = null; // { token, expiresAt }

  function stored() {
    try {
      return JSON.parse(unprotect(fs.readFileSync(file)));
    } catch {
      return null;
    }
  }

  function store(obj) {
    fs.mkdirSync(userDataDir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, protect(JSON.stringify(obj)));
    fs.renameSync(tmp, file);
  }

  async function postForm(url, params) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, json };
  }

  async function email(token) {
    const res = await fetchImpl(`${apiBase}/drive/v3/about?fields=user(emailAddress)`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json())?.user?.emailAddress || null;
  }

  /** 브라우저로 로그인 → {email}. 취소하거나 5분이 지나면 오류 */
  async function login({ timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
    if (!client) throw new Error('이 빌드에는 구글 연결 정보가 없습니다.');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');

    const server = http.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const redirect = `http://127.0.0.1:${server.address().port}`;

    try {
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('로그인 시간이 지났습니다. 다시 시도해 주세요.')), timeoutMs);
        server.on('request', (req, res) => {
          const q = new URL(req.url, redirect).searchParams;
          if (!q.get('code') && !q.get('error')) { res.writeHead(404); res.end(); return; }
          const okState = q.get('state') === state;
          const success = okState && !!q.get('code');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(success
            ? PAGE('연결했습니다', '이 창을 닫고 일정관리 비서로 돌아가세요.')
            : PAGE('연결하지 못했습니다', '창을 닫고 설정에서 다시 시도해 주세요.'));
          clearTimeout(timer);
          if (success) resolve(q.get('code'));
          else reject(new Error(okState ? '구글 로그인을 취소했습니다.' : '로그인 응답이 맞지 않습니다.'));
        });
        openExternal(`${authUrl}?${new URLSearchParams({
          client_id: client.clientId,
          redirect_uri: redirect,
          response_type: 'code',
          scope: SCOPE,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          access_type: 'offline',
          prompt: 'consent',
        })}`);
      });

      const { ok, json } = await postForm(tokenUrl, {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
        grant_type: 'authorization_code',
      });
      if (!ok || !json.access_token || !json.refresh_token) {
        throw new Error(`구글 로그인을 마치지 못했습니다 (${json.error || '토큰 없음'}).`);
      }
      access = { token: json.access_token, expiresAt: now() + (Number(json.expires_in) || 3600) * 1000 };
      const account = await email(json.access_token);
      store({ refreshToken: json.refresh_token, email: account });
      return { email: account };
    } finally {
      server.close();
    }
  }

  /** 쓸 수 있는 접근 토큰 — 만료 1분 전이면 갱신한다. 갱신 토큰이 무효면 NeedsLogin */
  async function token() {
    if (access && access.expiresAt - 60_000 > now()) return access.token;
    const s = stored();
    if (!s?.refreshToken || !client) throw new NeedsLogin();
    const { ok, json } = await postForm(tokenUrl, {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: s.refreshToken,
      grant_type: 'refresh_token',
    });
    if (!ok || !json.access_token) {
      if (json.error === 'invalid_grant') throw new NeedsLogin();
      throw new Error(`구글 토큰을 갱신하지 못했습니다 (${json.error || '네트워크'}).`);
    }
    access = { token: json.access_token, expiresAt: now() + (Number(json.expires_in) || 3600) * 1000 };
    return access.token;
  }

  /** 연결을 끊는다 — 구글 쪽 권한도 회수하고(실패해도) 저장한 토큰을 지운다 */
  async function logout() {
    const s = stored();
    access = null;
    try { fs.unlinkSync(file); } catch { /* 이미 없으면 그만 */ }
    if (s?.refreshToken) {
      await postForm(revokeUrl, { token: s.refreshToken }).catch(() => {});
    }
  }

  return {
    available: !!client,
    login,
    token,
    logout,
    account: () => stored()?.email || null,
    connected: () => !!stored()?.refreshToken,
  };
}

/** 빌드에 넣은 클라이언트 정보 — src/main/google-client.json (저장소에는 올리지 않는다, .example 참고) */
function loadClient(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    return c && c.clientId && c.clientSecret ? { clientId: String(c.clientId), clientSecret: String(c.clientSecret) } : null;
  } catch {
    return null;
  }
}

module.exports = { createGoogleAuth, loadClient, NeedsLogin, SCOPE };
