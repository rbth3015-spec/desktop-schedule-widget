// 퀵 런처 실행기. 사용자가 위젯에 직접 등록한 URL/스크립트/앱/폴더만 연다.
//
// 보안 원칙 (렌더러는 신뢰하지 않는다는 전제로 메인에서 다시 검증한다):
//  - URL 은 http/https/mailto 만 허용. file:, javascript:, data: 등은 거부한다.
//  - 프로세스는 항상 shell:false + 인자 배열로 spawn 한다 (문자열 조립 금지 → 인젝션 차단).
//  - 확장자에 따라 인터프리터를 고정 매핑한다. 임의의 명령 문자열은 실행하지 않는다.
//  - 동시 실행 수와 실행 시간에 상한을 둔다.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { shell } = require('electron');

const MAX_CONCURRENT = 4;
const TIMEOUT_MS = 10 * 60 * 1000;   // 10분이면 강제 종료
const OUTPUT_TAIL = 4000;            // 팝오버에 보여줄 출력 꼬리 길이

/** jobId -> { child, item, timer } */
const jobs = new Map();
let seq = 0;

/** 확장자 → 실행 방법. 여기 없는 확장자는 실행하지 않는다. */
const INTERPRETERS = {
  '.py':  (file, args) => ({ cmd: pythonCommand(), args: [file, ...args] }),
  '.pyw': (file, args) => ({ cmd: pythonCommand(), args: [file, ...args] }),
  '.ps1': (file, args) => ({
    cmd: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
  }),
  '.bat': (file, args) => ({ cmd: 'cmd.exe', args: ['/c', file, ...args] }),
  '.cmd': (file, args) => ({ cmd: 'cmd.exe', args: ['/c', file, ...args] }),
  '.js':  (file, args) => ({ cmd: process.execPath, args: [file, ...args], elecRun: true }),
  '.exe': (file, args) => ({ cmd: file, args }),
};

let cachedPython = null;

/** python 실행 파일 찾기. PATH 의 python 을 먼저, 없으면 py 런처를 쓴다. */
function pythonCommand() {
  if (cachedPython) return cachedPython;
  cachedPython = process.platform === 'win32' ? 'python' : 'python3';
  return cachedPython;
}

function isSafeUrl(target) {
  try {
    const u = new URL(target);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
}

/**
 * 런처 항목 실행.
 * @param {{kind:string, target:string, args?:string[], label?:string}} item
 * @param {(status:object) => void} onStatus  진행 상태 콜백
 * @returns {{ok:boolean, jobId?:string, error?:string}}
 */
function run(item, onStatus) {
  if (!item || typeof item !== 'object') return { ok: false, error: '항목이 올바르지 않습니다.' };

  const target = String(item.target || '').trim();
  if (!target) return { ok: false, error: '실행 대상이 비어 있습니다.' };

  // ---------------------------------------------------------- URL
  if (item.kind === 'url') {
    if (!isSafeUrl(target)) {
      return { ok: false, error: 'http/https/mailto 주소만 열 수 있습니다.' };
    }
    shell.openExternal(target);
    return { ok: true };
  }

  // ---------------------------------------------------------- 폴더
  if (item.kind === 'folder') {
    if (!fs.existsSync(target)) return { ok: false, error: '경로를 찾을 수 없습니다.' };
    shell.openPath(target);
    return { ok: true };
  }

  // ---------------------------------------------------------- 앱
  // 앱은 결과를 지켜볼 필요가 없으므로 OS 에 넘기고 끝낸다.
  if (item.kind === 'app') {
    if (!fs.existsSync(target)) return { ok: false, error: '파일을 찾을 수 없습니다.' };
    shell.openPath(target);
    return { ok: true };
  }

  // ---------------------------------------------------------- 스크립트
  if (item.kind !== 'script') return { ok: false, error: '알 수 없는 실행 유형입니다.' };

  if (!path.isAbsolute(target)) return { ok: false, error: '절대 경로만 실행할 수 있습니다.' };
  if (!fs.existsSync(target)) return { ok: false, error: '스크립트를 찾을 수 없습니다.' };

  const ext = path.extname(target).toLowerCase();
  const build = INTERPRETERS[ext];
  if (!build) {
    return { ok: false, error: `지원하지 않는 확장자입니다 (${ext || '없음'}).` };
  }

  if (jobs.size >= MAX_CONCURRENT) {
    return { ok: false, error: `동시에 ${MAX_CONCURRENT}개까지만 실행할 수 있습니다.` };
  }

  const args = Array.isArray(item.args) ? item.args.map(String) : [];
  const { cmd, args: fullArgs, elecRun } = build(target, args);

  const jobId = `job_${++seq}`;
  let child;
  try {
    child = spawn(cmd, fullArgs, {
      cwd: path.dirname(target),
      shell: false,                       // 절대 셸을 거치지 않는다
      windowsHide: true,
      env: elecRun
        // Electron 바이너리를 순수 Node 로 쓸 때 필요
        ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        : { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }

  let out = '';
  const push = (chunk) => {
    out += chunk.toString('utf8');
    if (out.length > OUTPUT_TAIL) out = out.slice(-OUTPUT_TAIL);
    onStatus({ jobId, state: 'running', output: out });
  };

  child.stdout?.on('data', push);
  child.stderr?.on('data', push);

  const timer = setTimeout(() => {
    onStatus({ jobId, state: 'error', error: '시간 초과로 중단했습니다.', output: out });
    try { child.kill(); } catch { /* 이미 죽었으면 무시 */ }
  }, TIMEOUT_MS);

  child.on('error', (err) => {
    clearTimeout(timer);
    jobs.delete(jobId);
    const hint = err.code === 'ENOENT'
      ? `실행기를 찾을 수 없습니다 (${cmd}). PATH 를 확인하세요.`
      : String(err.message || err);
    onStatus({ jobId, state: 'error', error: hint, output: out });
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    jobs.delete(jobId);
    onStatus({
      jobId,
      state: code === 0 ? 'done' : 'error',
      code,
      error: code === 0 ? undefined : `종료 코드 ${code}`,
      output: out,
    });
  });

  jobs.set(jobId, { child, item, timer });
  onStatus({ jobId, state: 'running', output: '' });
  return { ok: true, jobId };
}

function cancel(jobId) {
  const job = jobs.get(jobId);
  if (!job) return { ok: false, error: '이미 끝난 작업입니다.' };
  clearTimeout(job.timer);
  try { job.child.kill(); } catch { /* 무시 */ }
  jobs.delete(jobId);
  return { ok: true };
}

/** 앱 종료 시 남은 자식 프로세스 정리 */
function killAll() {
  for (const [, job] of jobs) {
    clearTimeout(job.timer);
    try { job.child.kill(); } catch { /* 무시 */ }
  }
  jobs.clear();
}

module.exports = { run, cancel, killAll };
