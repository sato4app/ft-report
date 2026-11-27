// 報告書の中身の組み立て(発見報告・処理報告で共通)。仕様は docs/ft-funcspec-found.md。
// 入力した値と選んだ写真から、様式(山林部会活動報告)の各欄に出す文字と写真の並びを作る。
// 配置(ft-report-layout.js)とは分けてあり、PDF のほか、後で Excel を出すときにも使い回す。
// あわせて、地図データ(緊急ポイント・ルート)の読み込みと、最寄りの緊急ポイントの検索を受け持つ。
import { MAPDATA_CACHE, MAPDATA_API_URL } from '../common/config.js';
import { pad2, formatLocalDate } from '../common/utils.js';

// 選べる写真の上限(番号は ①〜⑳)
export const FT_REPORT_MAX_PHOTOS = 20;
// 報告書のタイトル(様式の見出し)の初めの状態。項目設定の「タイトル」の初期値で、変えられる(ft-report-items.js)
export const FT_REPORT_TITLE = '山麓保全委員会　山林部会活動報告（ハイキング道倒木整備サポート）';
// ファイル名の頭
const FILE_NAME_PREFIX = '山麓保全委員会 山林部会活動報告書';

const WEEKDAYS = '日月火水木金土';

// 番号を丸数字にする(1〜20 は ①〜⑳。それより大きい数は来ないが、来たら (21) の形)
export function circledNumber(n) {
  return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `(${n})`;
}

// ===== 日付の書き方 =====
// 2026/11/09
function formatDateSlash(d) {
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

// 2026/11/09(日)
function formatDateWithWeekday(d) {
  return `${formatDateSlash(d)}(${WEEKDAYS[d.getDay()]})`;
}

// 10:15
function formatHm(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 日時の欄の初期値: 選んだ写真の撮影日時の範囲(仕様 4.3)。
// 撮影日時が分かる写真の最も早い日時と最も遅い日時から作る(選んだ順には関係しない)。秒は出さない。
//   同じ日: 2026/11/09(日) 10:15～11:40
//   日をまたぐ: 2026/11/09(日) 15:30～2026/11/10(月) 09:05
//   1 枚だけ・全部同じ時刻(分まで): 2026/11/09(日) 10:15
//   撮影日時が分かる写真が無い: 空
export function buildDateRange(photos) {
  const times = photos.map((p) => p.timeMs).filter((t) => Number.isFinite(t));
  if (times.length === 0) return '';
  const first = new Date(Math.min(...times));
  const last = new Date(Math.max(...times));
  const start = `${formatDateWithWeekday(first)} ${formatHm(first)}`;
  const sameDay = formatDateSlash(first) === formatDateSlash(last);
  if (sameDay && formatHm(first) === formatHm(last)) return start;
  if (sameDay) return `${start}～${formatHm(last)}`;
  return `${start}～${formatDateWithWeekday(last)} ${formatHm(last)}`;
}

// 写真の一覧などに出す、撮影日時の短い書き方(11/09 10:15)。不明なら空
export function formatPhotoTime(timeMs) {
  if (!Number.isFinite(timeMs)) return '';
  const d = new Date(timeMs);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${formatHm(d)}`;
}

// 今日の日付(入力欄 type="date" の値の形: 2026-11-26)
export function todayInputDate() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ===== 写真の見出し =====
// アプリが付けた既定の名前(「写真3」。英語の表示で撮った写真は「Photo 3」)かどうか
function isDefaultPhotoName(name) {
  return /^(写真\d+|Photo \d+)$/.test(name);
}

// 見出しの初期値: 写真の名前。既定の名前のままの写真は空(仕様 4.1)
export function defaultCaption(photo) {
  const name = String(photo?.name ?? '').trim();
  return isDefaultPhotoName(name) ? '' : name;
}

// ===== 報告書の中身 =====
// input: 入力の画面の値(どれも未入力でよい)
//   title(報告書のタイトル), date, weather, temperature, writer, subject, place, reportTo, reportMeans,
//   reportDate(type="date" の値 2026-11-10), participants, body,
//   contactReportTo・contactGov('要' / '不要' / '')、notes、captions(写真の id → 見出し)
// photos: 選んだ写真(選んだ順)。photos.js の写真({ id, name, timeMs, lat, lng, blob })
// 返す値の各欄は、そのまま様式に書き込める文字にしてある(空の欄は '')
export function buildReport(input, photos) {
  const text = (v) => String(v ?? '').trim();
  const temperature = text(input.temperature);
  const reportDate = text(input.reportDate);
  return {
    number: '',   // 番号は空欄で出す(採番か入力にするときは仕様を変える)
    title: text(input.title),   // 空なら報告書のタイトルも空欄

    date: text(input.date),
    weather: text(input.weather),
    temperature: temperature ? `${temperature}℃` : '',
    writer: text(input.writer),
    subject: text(input.subject),
    place: text(input.place),
    reportTo: text(input.reportTo),
    reportMeans: text(input.reportMeans),
    reportDate: reportDate ? reportDate.replaceAll('-', '/') : '',
    participants: text(input.participants),
    body: String(input.body ?? '').replace(/\s+$/, ''),
    contactReportTo: text(input.contactReportTo),
    contactGov: text(input.contactGov),
    notes: String(input.notes ?? '').replace(/\s+$/, ''),
    photos: photos.map((p, i) => {
      const label = circledNumber(i + 1);
      const caption = text(input.captions?.get(p.id));
      return {
        id: p.id,
        no: i + 1,
        label,                       // ①
        caption,                     // しらみ地蔵～C20
        heading: `${label}${caption}`, // ①しらみ地蔵～C20(見出しが空なら ① だけ)
        lat: p.lat,
        lng: p.lng,
        timeMs: p.timeMs,
        blob: p.blob
      };
    })
  };
}

// ===== ファイル名 =====
// ファイルの名前に使えない文字(\ / : * ? " < > |)を _ に置き換える
export function sanitizeFileName(name) {
  return String(name ?? '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

// 既定のファイル名(拡張子なし)。対象案件が空なら通報日時(無ければ今日)の YYYYMMDD
export function defaultReportFileName(report) {
  const key = report.subject
    || (report.reportDate ? report.reportDate.replaceAll('/', '') : formatLocalDate(Date.now()));
  return sanitizeFileName(`${FILE_NAME_PREFIX} ${key}`);
}

// ===== 地図データ(緊急ポイント・ルート) =====
// 公開データの地図データを、Cache API から読む(published-data.js が保存したもの)。
// まだ一度も取得していない・読めないときは null。
// 返す値: { points: [{ id, name, lat, lng }], routes: [[[lat, lng], ...], ...] }
export async function loadMapFeatures() {
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open(MAPDATA_CACHE);
    const res = await cache.match(MAPDATA_API_URL);
    if (!res) return null;
    const geojson = await res.json();
    const points = [];
    const routes = [];
    for (const f of geojson?.features || []) {
      const p = f?.properties || {};
      const g = f?.geometry;
      if (p.type === 'ポイントGPS' && g?.type === 'Point') {
        const [lng, lat] = g.coordinates;
        points.push({ id: String(p.id ?? ''), name: String(p.name ?? ''), lat, lng });
      } else if (p.type === 'route' && g?.type === 'LineString' && g.coordinates.length > 0) {
        // 端の緊急ポイントまで線を伸ばす(map-overlays.js の expandRouteFeatures と同じ考え)
        const coords = [
          ...(p.startPointGPS ? [p.startPointGPS] : []),
          ...g.coordinates,
          ...(p.endPointGPS ? [p.endPointGPS] : [])
        ];
        routes.push(coords.map(([lng, lat]) => [lat, lng]));
      }
    }
    return { points, routes };
  } catch (err) {
    console.warn('[ft] 地図データを読めませんでした:', err);
    return null;
  }
}

// 2 点の距離(m)
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// 最も近い緊急ポイントと距離(m)。maxMeters より遠いものしか無ければ null
export function findNearestPoint(points, lat, lng, maxMeters = 1000) {
  let best = null;
  for (const pt of points || []) {
    const m = distanceMeters(lat, lng, pt.lat, pt.lng);
    if (m <= maxMeters && (!best || m < best.meters)) best = { point: pt, meters: m };
  }
  return best;
}
