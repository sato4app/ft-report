// 天気・気温の取得(仕様 docs/ft-funcspec-found.md の 4.6)。
// 報告の日時(最初の写真の撮影時刻)の、箕面大滝付近の天気と気温を Open-Meteo(https://open-meteo.com/)から取る。
// - 値は気象モデルの推定値(観測値ではない)。1 時間ごとの値のうち、撮影時刻を含む時間の値を使う。
// - 地点は箕面大滝の決まった座標にする。写真の位置は送らない(送るのは日付だけ)。
// - 利用条件: 非営利の利用は無料。出典(Open-Meteo.com、CC BY 4.0)を表示する。
//   山麓保全委員会は NPO なので非営利の利用に当たる(2026-11-27 利用者の判断)。
import { pad2 } from '../common/utils.js';

// 箕面大滝(アプリの地図の初めの中心と同じ地点)
const MINOH_FALLS = { lat: 34.853667, lng: 135.472041 };
// 直近の日付は予報の API(過去 92 日まで)、それより前は過去の気象の API(数日遅れで更新)から取る
const FORECAST_API = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_API = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST_PAST_DAYS = 60;
const TIMEOUT_MS = 15000;

export const WEATHER_SOURCE = '出典：Open-Meteo.com（気象モデルの推定値。箕面大滝付近）';

// 天気の区分(WMO の天気コード)を、様式の天気(晴・曇・雨・雪)にまとめる。
// 雲が少し(コード 0〜2)は晴、霧は曇、雷雨は雨に入れる
export function weatherCodeToText(code) {
  if ([0, 1, 2].includes(code)) return '晴';
  if ([3, 45, 48].includes(code)) return '曇';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '雪';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return '雨';
  return '';
}

function localDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// timeMs の時刻の天気と気温を取る。返す値: { weather: '晴' など, temperature: 数値(℃。整数に丸める), hour: 'YYYY-MM-DDTHH:00' }。
// 取れなければ例外を投げる(通信できない・その時刻のデータが無いなど)
export async function fetchMinohWeather(timeMs) {
  const at = new Date(timeMs);
  const date = localDate(at);
  const hour = `${date}T${pad2(at.getHours())}:00`;
  const daysAgo = (Date.now() - timeMs) / 86400000;
  const base = daysAgo <= FORECAST_PAST_DAYS ? FORECAST_API : ARCHIVE_API;
  const params = new URLSearchParams({
    latitude: String(MINOH_FALLS.lat),
    longitude: String(MINOH_FALLS.lng),
    hourly: 'temperature_2m,weather_code',
    start_date: date,
    end_date: date,
    timezone: 'Asia/Tokyo'
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let json;
  try {
    const res = await fetch(`${base}?${params}`, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('時間内に応答がありませんでした');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const i = json?.hourly?.time?.indexOf(hour) ?? -1;
  const temp = i >= 0 ? json.hourly.temperature_2m?.[i] : null;
  const code = i >= 0 ? json.hourly.weather_code?.[i] : null;
  if (!Number.isFinite(temp) && !Number.isFinite(code)) throw new Error('その日時のデータがありません');
  return {
    weather: Number.isFinite(code) ? weatherCodeToText(code) : '',
    temperature: Number.isFinite(temp) ? Math.round(temp) || 0 : null,   // 整数に丸める(-0 は 0 に)
    hour
  };
}
