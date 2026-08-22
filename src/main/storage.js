// 사용자 데이터(schedule-data.json)의 안전한 읽기/쓰기 담당. 원자적 저장 + 손상 파일 자동 백업.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE_NAME = 'schedule-data.json';

/** 저장 파일 경로 */
function dataFilePath() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

/** 자동 백업 폴더 */
function backupDir() {
  return path.join(app.getPath('userData'), 'backups');
}

const BACKUP_KEEP = 14;   // 최근 14일치만 보관

/**
 * 하루 한 번, 저장 직전의 파일을 백업해 둔다.
 * 데이터가 파일 하나뿐이면 실수로 지운 일정을 며칠 뒤에 알아차렸을 때 손쓸 방법이 없다.
 * 저장 성공 경로에서만 부르며, 실패해도 본 저장을 방해하지 않는다.
 */
function rotateBackup(currentPath) {
  try {
    if (!fs.existsSync(currentPath)) return;
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });

    const today = new Date();
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const dest = path.join(dir, `schedule-data-${stamp}.json`);
    if (fs.existsSync(dest)) return;         // 오늘 백업은 이미 있다

    fs.copyFileSync(currentPath, dest);

    // 오래된 것 정리
    const files = fs.readdirSync(dir)
      .filter((f) => /^schedule-data-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* 무시 */ }
    }
  } catch (err) {
    console.error('[storage] 백업 실패(본 저장에는 영향 없음):', err);
  }
}

/** 빈 데이터 기본형 */
function emptyData() {
  return { version: 1, tasks: [], launcher: [], reminderLog: [], settings: {} };
}

/** userData 디렉터리 보장 */
function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 타임스탬프 문자열 (파일명에 쓸 수 있는 형태) */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 손상된 파일을 schedule-data.corrupt-<타임스탬프>.json 으로 옮긴다.
 * @returns {string|null} 백업된 경로 (실패 시 null)
 */
function quarantine(filePath, reason) {
  const backup = path.join(
    path.dirname(filePath),
    `schedule-data.corrupt-${stamp()}.json`
  );
  try {
    fs.renameSync(filePath, backup);
    console.error(`[storage] 손상된 데이터 파일을 격리했습니다 (${reason}) -> ${backup}`);
    return backup;
  } catch (err) {
    // rename 이 실패하면 복사라도 시도한다. 원본은 건드리지 않는다.
    try {
      fs.copyFileSync(filePath, backup);
      console.error(`[storage] 손상된 파일 복사본 생성 (${reason}) -> ${backup}`);
      return backup;
    } catch (err2) {
      console.error('[storage] 손상 파일 격리 실패:', err2);
      return null;
    }
  }
}

/**
 * 데이터를 읽는다. 파일이 없으면 빈 데이터.
 * JSON 이 깨졌거나 구조가 이상하면 원본을 격리하고 빈 데이터를 돌려주되,
 * 반환값에 corrupted / backupPath 를 실어 렌더러가 알 수 있게 한다.
 */
function loadData() {
  const filePath = dataFilePath();

  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyData(); // 최초 실행
    console.error('[storage] 데이터 파일 읽기 실패:', err);
    return { ...emptyData(), error: String(err.message || err) };
  }

  // 빈 파일도 정상적인 "데이터 없음" 으로 취급한다.
  if (!text.trim()) return emptyData();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const backupPath = quarantine(filePath, 'JSON 파싱 실패');
    return { ...emptyData(), corrupted: true, backupPath, error: String(err.message || err) };
  }

  // 구조 검증 — 객체가 아니거나 tasks 가 배열이 아니면 손상으로 본다.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const backupPath = quarantine(filePath, '최상위가 객체가 아님');
    return { ...emptyData(), corrupted: true, backupPath, error: '데이터 형식이 올바르지 않습니다.' };
  }
  if (parsed.tasks !== undefined && !Array.isArray(parsed.tasks)) {
    const backupPath = quarantine(filePath, 'tasks 가 배열이 아님');
    return { ...emptyData(), corrupted: true, backupPath, error: 'tasks 필드가 배열이 아닙니다.' };
  }

  return {
    version: typeof parsed.version === 'number' ? parsed.version : 1,
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    launcher: Array.isArray(parsed.launcher) ? parsed.launcher : undefined,
    reminderLog: Array.isArray(parsed.reminderLog) ? parsed.reminderLog : [],
    settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
  };
}

/**
 * 원자적 저장: 임시 파일에 쓰고 fsync 한 뒤 rename 으로 교체한다.
 * 도중에 프로세스가 죽어도 기존 파일은 온전히 남는다.
 * @returns {{ok:boolean, error?:string}}
 */
function saveData(data) {
  // --- 최소 검증 ---
  if (!data || typeof data !== 'object') {
    return { ok: false, error: '저장할 데이터가 객체가 아닙니다.' };
  }
  if (!Array.isArray(data.tasks)) {
    return { ok: false, error: 'tasks 는 배열이어야 합니다.' };
  }
  if (data.settings !== undefined && (typeof data.settings !== 'object' || data.settings === null)) {
    return { ok: false, error: 'settings 는 객체여야 합니다.' };
  }

  // 렌더러가 보낸 키를 여기서 화이트리스트로 다시 조립한다.
  // **새 필드를 store 에 추가하면 반드시 여기에도 더해야 한다** — 빠뜨리면
  // 저장은 성공한 것처럼 보이면서 그 필드만 조용히 사라진다(알림 기록이 실제로 그랬다).
  const payload = {
    version: typeof data.version === 'number' ? data.version : 1,
    tasks: data.tasks,
    launcher: Array.isArray(data.launcher) ? data.launcher : [],
    reminderLog: Array.isArray(data.reminderLog) ? data.reminderLog : [],
    settings: data.settings || {},
  };

  let text;
  try {
    text = JSON.stringify(payload, null, 2);
  } catch (err) {
    return { ok: false, error: '직렬화 실패: ' + String(err.message || err) };
  }

  const filePath = dataFilePath();
  const tmpPath = `${filePath}.tmp-${process.pid}`;

  try {
    ensureDir(filePath);

    // 0) 덮어쓰기 전에 하루 한 번 백업을 떠 둔다
    rotateBackup(filePath);

    // 1) 임시 파일에 완전히 기록하고 디스크까지 밀어 넣는다.
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // 2) rename 으로 교체 (Windows 에서도 기존 파일을 덮어쓴다).
    //    바이러스 검사 등으로 일시적 잠금이 걸릴 수 있어 몇 번 재시도한다.
    renameWithRetry(tmpPath, filePath);

    return { ok: true };
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch { /* 임시 파일 정리 실패는 무시 */ }
    console.error('[storage] 저장 실패:', err);
    return { ok: false, error: String(err.message || err) };
  }
}

/** rename 재시도 (EPERM/EBUSY 대비) */
function renameWithRetry(from, to, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const retriable = err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES';
      if (!retriable || i === attempts - 1) throw err;
      // 아주 짧게 동기 대기 후 재시도
      const until = Date.now() + 30;
      while (Date.now() < until) { /* busy wait */ }
    }
  }
}

module.exports = { loadData, saveData, dataFilePath, backupDir };
