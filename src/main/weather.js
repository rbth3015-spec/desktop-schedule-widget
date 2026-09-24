// 오늘 날씨 한 조각. 달력 머리의 스티커와 아침 브리핑이 쓴다.
//
// 왜 메인 프로세스인가
//   렌더러는 CSP 가 `default-src 'none'` 이라 네트워크를 쓸 수 없다(그렇게 두는 게 맞다).
//   공휴일과 같은 길이다 — 받아오는 일은 메인이 하고 렌더러에는 결과만 넘긴다.
//
// 어디서 받나
//   Open-Meteo. 키가 없고 가입도 없다. 보내는 것은 **고른 도시의 좌표뿐**이고
//   위치를 추측하지 않는다(IP 위치 조회 같은 걸 쓰지 않는다). 도시는 설정에서 고른다.
//
// 오프라인
//   받은 값은 userData/weather.json 에 남긴다. 30분이 지나면 새로 받아 보되,
//   못 받으면 캐시를 그대로 쓴다(날씨 한 줄 때문에 화면이 비면 안 된다).

const fs = require('fs');
const path = require('path');
const { app, net } = require('electron');

const HOST = 'https://api.open-meteo.com/v1/forecast';

/** 다시 받아 볼 주기 */
const TTL_MS = 30 * 60 * 1000;

/** 고를 수 있는 도시 — 이름과 좌표를 앱에 싣는다(도시 검색까지 네트워크를 쓰지 않으려고). */
const CITIES = {
  서울: [37.5665, 126.9780],
  인천: [37.4563, 126.7052],
  수원: [37.2636, 127.0286],
  춘천: [37.8813, 127.7300],
  강릉: [37.7519, 128.8761],
  대전: [36.3504, 127.3845],
  세종: [36.4800, 127.2890],
  청주: [36.6424, 127.4890],
  전주: [35.8242, 127.1480],
  광주: [35.1595, 126.8526],
  목포: [34.8118, 126.3922],
  대구: [35.8714, 128.6014],
  포항: [36.0190, 129.3435],
  부산: [35.1796, 129.0756],
  울산: [35.5384, 129.3114],
  창원: [35.2280, 128.6811],
  제주: [33.4996, 126.5312],
};

const DEFAULT_CITY = '서울';

/**
 * WMO 날씨 코드 → 아이콘 이름과 우리말.
 * 코드를 그대로 렌더러에 넘기고 해석을 거기서 또 하면 표가 두 벌이 된다.
 */
function readCode(code) {
  const n = Number(code);
  if (n === 0) return { icon: 'wSun', label: '맑음' };
  if (n === 1 || n === 2) return { icon: 'wSunCloud', label: n === 1 ? '대체로 맑음' : '구름 조금' };
  if (n === 3) return { icon: 'wCloud', label: '흐림' };
  if (n === 45 || n === 48) return { icon: 'wFog', label: '안개' };
  if (n >= 51 && n <= 57) return { icon: 'wRain', label: '이슬비' };
  if (n >= 61 && n <= 65) return { icon: 'wRain', label: '비' };
  if (n === 66 || n === 67) return { icon: 'wSnow', label: '진눈깨비' };
  if (n >= 71 && n <= 77) return { icon: 'wSnow', label: '눈' };
  if (n >= 80 && n <= 82) return { icon: 'wRain', label: '소나기' };
  if (n === 85 || n === 86) return { icon: 'wSnow', label: '눈' };
  if (n >= 95) return { icon: 'wStorm', label: '천둥번개' };
  return { icon: 'wCloud', label: '' };
}

function cachePath() {
  return path.join(app.getPath('userData'), 'weather.json');
}

/** 남의 서버 응답을 그대로 믿지 않는다 — 기대한 모양만 통과시킨다 */
function sanitize(raw, city) {
  const cur = raw?.current;
  const day = raw?.daily;
  const temp = Number(cur?.temperature_2m);
  if (!Number.isFinite(temp)) return null;

  const high = Number(day?.temperature_2m_max?.[0]);
  const low = Number(day?.temperature_2m_min?.[0]);
  const { icon, label } = readCode(cur?.weather_code);

  return {
    city,
    temp: Math.round(temp),
    high: Number.isFinite(high) ? Math.round(high) : null,
    low: Number.isFinite(low) ? Math.round(low) : null,
    icon,
    label,
    at: Date.now(),
  };
}

function readCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Number.isFinite(Number(parsed.temp))) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    const tmp = `${cachePath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, cachePath());
  } catch (err) {
    // 캐시를 못 남겨도 이번 화면은 그릴 수 있다
    console.error('[weather] 캐시 저장 실패:', err.message);
  }
}

let inFlight = null;

async function fetchCity(city) {
  const [lat, lon] = CITIES[city];
  const url = `${HOST}?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,weather_code'
    + '&daily=temperature_2m_max,temperature_2m_min'
    + '&timezone=Asia%2FSeoul&forecast_days=1';

  try {
    // Electron 의 net — 시스템 프록시 · 인증서 설정을 그대로 따른다
    const res = await net.fetch(url);
    if (!res.ok) return null;
    const data = sanitize(await res.json(), city);
    if (data) writeCache(data);
    return data;
  } catch {
    return null;   // 오프라인 등 — 캐시로 살아간다
  }
}

/**
 * 지금 날씨. 캐시가 싱싱하면 그대로, 오래됐으면 새로 받아 본다.
 * 못 받으면 있던 값을 그대로 돌려준다(stale). 아무것도 없으면 null.
 *
 * @param {string} city CITIES 의 키. 모르는 이름이면 서울.
 * @returns {Promise<null|{city,temp,high,low,icon,label,at,stale?:boolean}>}
 */
async function get(city) {
  const name = CITIES[city] ? city : DEFAULT_CITY;
  const cached = readCache();

  if (cached && cached.city === name && Date.now() - Number(cached.at || 0) < TTL_MS) {
    return cached;
  }

  // 같은 요청이 겹치면 하나만 보낸다
  if (!inFlight) {
    inFlight = fetchCity(name).finally(() => { inFlight = null; });
  }
  const fresh = await inFlight;
  if (fresh) return fresh;
  return cached ? { ...cached, stale: true } : null;
}

module.exports = { get, cities: () => Object.keys(CITIES) };
