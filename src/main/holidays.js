// 대한민국 공휴일. 우주항공청 월력요항을 정리해 두는 공개 데이터를 받아 쓴다.
//
// 왜 계산하지 않는가
//   설날·추석·부처님오신날은 음력이라 양력으로 옮기려면 천문 계산이나 변환표가 필요하고,
//   대체공휴일·임시공휴일은 그때그때 국무회의로 정해져서 규칙만으로는 절대 맞출 수 없다.
//   (실제로 2025년에는 1/27 임시공휴일, 6/3 대선 임시공휴일이 있었다)
//   직접 계산하면 조용히 틀린 날짜를 보여 주게 되므로, 발표된 자료를 받아 쓴다.
//
// 왜 메인 프로세스인가
//   렌더러는 CSP 가 `default-src 'none'` 이라 네트워크를 쓸 수 없다(그렇게 두는 게 맞다).
//   받아오는 일은 메인이 하고, 렌더러에는 결과만 넘긴다.
//
// 오프라인
//   받은 자료는 userData/holidays/<연도>.json 에 남긴다. 다음부터는 캐시로 즉시 그리고,
//   오래된 것만 조용히 다시 받는다. 네트워크가 없으면 캐시로 계속 동작한다.

const fs = require('fs');
const path = require('path');
const { app, net } = require('electron');

const HOST = 'https://holidays.hyunbin.page';

/** 자료를 다시 받아 볼 주기. 공휴일은 자주 바뀌지 않지만 임시공휴일이 추가될 수 있다. */
const TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** 한 번에 받아 둘 수 있는 연도 범위 — 터무니없는 값을 막는다 */
const YEAR_MIN = 2000;
const YEAR_MAX = 2100;

/** 같은 연도를 동시에 여러 번 받지 않도록 진행 중인 요청을 공유한다 */
const inFlight = new Map();

function cacheDir() {
  return path.join(app.getPath('userData'), 'holidays');
}

function cachePath(year) {
  return path.join(cacheDir(), `${year}.json`);
}

/**
 * 받은 자료가 기대한 모양인지 확인한다.
 * 남의 서버 응답을 그대로 믿고 캐시에 남기면, 한 번 이상해진 뒤로 계속 이상하다.
 * @returns {Record<string,string[]>|null}
 */
function sanitize(raw, year) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const out = {};
  const dateRe = new RegExp(`^${year}-\\d{2}-\\d{2}$`);

  for (const [key, value] of Object.entries(raw)) {
    if (!dateRe.test(key)) continue;
    if (!Array.isArray(value)) continue;
    const names = value
      .filter((n) => typeof n === 'string')
      .map((n) => n.trim().slice(0, 40))
      .filter(Boolean);
    if (names.length) out[key] = names;
  }

  // 한 해에 공휴일이 하나도 없을 리는 없다. 비어 있으면 받아 온 게 잘못된 것이다.
  return Object.keys(out).length ? out : null;
}

function readCache(year) {
  try {
    const text = fs.readFileSync(cachePath(year), 'utf8');
    const parsed = JSON.parse(text);
    const data = sanitize(parsed?.data, year);
    if (!data) return null;
    return { fetchedAt: Number(parsed.fetchedAt) || 0, data };
  } catch {
    return null;
  }
}

function writeCache(year, data) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const tmp = `${cachePath(year)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: Date.now(), data }), 'utf8');
    fs.renameSync(tmp, cachePath(year));
  } catch (err) {
    // 캐시를 못 남겨도 이번 화면은 그릴 수 있다. 다음에 다시 받으면 그만이다.
    console.error('[holidays] 캐시 저장 실패:', err.message);
  }
}

/** 한 해치를 실제로 받아 온다. 실패하면 null. */
async function fetchYear(year) {
  if (inFlight.has(year)) return inFlight.get(year);

  const job = (async () => {
    try {
      // Electron 의 net 을 쓴다 — 시스템 프록시·인증서 설정을 그대로 따른다.
      const res = await net.fetch(`${HOST}/${year}.json`);
      // 아직 발표되지 않은 연도는 404 다. 오류가 아니라 '자료 없음'.
      if (!res.ok) return null;
      const data = sanitize(await res.json(), year);
      if (data) writeCache(year, data);
      return data;
    } catch {
      return null;   // 오프라인 등 — 캐시로 살아간다
    } finally {
      inFlight.delete(year);
    }
  })();

  inFlight.set(year, job);
  return job;
}

/**
 * 여러 해치 공휴일을 돌려준다.
 *
 * 캐시가 있으면 **기다리지 않고 그것부터** 준다. 화면이 먼저 그려지는 편이
 * 네트워크를 기다리다 늦게 그려지는 것보다 낫고, 새로 받은 값은 다음 호출에 반영된다.
 *
 * @param {number[]} years
 * @returns {Promise<{days: Record<string,string[]>, missing: number[]}>}
 */
async function get(years) {
  const list = [...new Set(
    (Array.isArray(years) ? years : [])
      .map((y) => Math.trunc(Number(y)))
      .filter((y) => Number.isFinite(y) && y >= YEAR_MIN && y <= YEAR_MAX)
  )];

  const days = {};
  const missing = [];
  const refresh = [];

  for (const year of list) {
    const cached = readCache(year);
    if (cached) {
      Object.assign(days, cached.data);
      if (Date.now() - cached.fetchedAt > TTL_MS) refresh.push(year);
    } else {
      missing.push(year);
    }
  }

  // 캐시가 아예 없는 해만 기다린다. 오래된 것은 뒤에서 갱신한다.
  if (missing.length) {
    const fetched = await Promise.all(missing.map(fetchYear));
    fetched.forEach((data, i) => {
      if (data) {
        Object.assign(days, data);
        missing[i] = null;
      }
    });
  }
  for (const year of refresh) fetchYear(year);

  return { days, missing: missing.filter((y) => y !== null) };
}

module.exports = { get };
