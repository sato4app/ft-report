// 移動経路(記録・読み込みした経路)モジュール
// - 経路の一覧と地図への描画(線・開始点・終了点の三角・現在地点までの線)
// - 記録中の経路への記録点の追加(記録条件・外れ値の判定)
// - 統計(地点数・移動距離)と GPX 出力用の点列、GPX から読んだ点列の描画
// - 端末への保存と起動時の復元(IndexedDB)
// - 記録中の画面スリープの防止(Screen Wake Lock API)
// 測位(現在地の監視)は geolocation.js が行い、記録の開始・停止もそこから呼ぶ
// (startTrackRecording / stopTrackRecording。記録には現在地の監視が要るため)。
// 経路は複数持てる(1回の記録、または読み込んだGPXの1セグメントが1本)。
import * as L from 'leaflet';
import { getMap, fitMapToLatLngs } from '../map/map.js';
import { buildMarkerIcon } from '../map/marker-icons.js';
import { saveLatestTrack, loadLatestTrack, clearLatestTrack } from '../common/db.js';
import { t } from '../common/i18n.js';
import { bearingDegrees } from '../common/utils.js';

// 「移動した」の判定: 直近の記録点から 20m 以上離れたか、1 分以上経過した場合に記録
const TRACK_MIN_DISTANCE_M = 20;
const TRACK_MIN_INTERVAL_MS = 60 * 1000;
// 記録点にしない測位(外れ値)の判定。表示(青丸・三角・現在地点までの線)は従来どおり更新し、
// 記録点として残すかだけをここで絞る。
// - 測位精度がこれより悪い位置は記録しない。他のアプリから戻った直後など GPS を捕まえ直すまでは
//   Wi-Fi・基地局による概算位置(誤差 100m 以上)が先に届き、そのまま記録すると経路が飛んで戻る。
//   森や谷では GPS でも 30m 台になることがあるため、それより少し緩めにする
const TRACK_MAX_ACCURACY_M = 50;
// - 直近の記録点からの速さがこれを超える位置は記録しない(歩行ではありえない飛び)。
//   時間は測位時刻の差で測るので、長く他のアプリを開いていた後の正しい移動は残る。
//   誤って残った記録点に引きずられても、時間がたてば速さが下がり記録が再開する
const TRACK_MAX_SPEED_MPS = 5;

// 記録中か(記録開始から停止・クリアまで)。起動時画面へ移っても記録は続く
let recording = false;
// 移動経路(経路)の一覧。1本 = 1回の記録、または読み込んだGPXの1セグメント。
// 各要素は次の形: {
//   polyline:    記録点を順に結ぶ線(移動記録経路)
//   startMarker: 開始点マーカー(最初の記録点)
//   endMarker:   終了点マーカー(最終記録点・進行方向つき。記録中はライブ現在地)
//   times:       各記録点の記録時刻(ms)。polyline の頂点と同順で保持し、
//                GPX出力の <time> と、出力ファイル名の日付の決定に使う
//   names:       各記録点の名前(頂点と同順。撮影地点として入れた点だけ写真の名前、他は null)。
//                GPX出力の <trkpt> の <name> に使う
// }
let tracks = [];
// 記録中の経路(常に tracks の末尾)。記録していないときは null。
let recordingTrack = null;
// 最終記録地点と現在地点(ライブ)を結ぶ線。記録条件(20m/60秒)を満たすまでは
// 記録点が増えないため、この線が無いと経路が現在地まで届かず途切れて見える。
// 移動記録経路と同じスタイルで描き、記録停止・クリア時は消す。
let trackLeadLine = null;
let trackStyle = null;           // 線のスタイル(移動記録経路)
let trackStartStyle = null;      // 開始点マーカーのスタイル(移動記録開始点)
let trackCurrentStyle = null;    // 終了点マーカーのスタイル(移動記録現在地点)
// 記録中の経路について、直近に記録した地点と時刻(記録条件の判定に使う)。
// 経路を新しく作るたびにリセットし、新しい経路の1点目は必ず記録する。
let lastTrackLatLng = null;
let lastTrackTimeMs = 0;
// 直近の現在地(ライブ)を返す関数(geolocation.js が登録する)。記録中の経路の三角を
// スタイルの変更で描き直すとき、その位置に置くために使う
let liveLatLngSource = () => null;

export function setLiveLatLngSource(fn) {
  liveLatLngSource = fn;
}

// 実際に移動記録中かどうか(記録開始から停止・クリアまで)
export function isTrackRecording() {
  return recording;
}

// ===== スタイル =====
// 移動記録経路(線)の描画オプション。経路本体と、現在地点までを結ぶ線で共用する。
function trackLineOptions() {
  return {
    color: trackStyle?.color || '#000080',
    weight: trackStyle?.size || 4,
    opacity: 0.85
  };
}

export function setTrackStyle(style) {
  trackStyle = style;
  const { color, weight } = trackLineOptions();
  for (const track of tracks) track.polyline.setStyle({ color, weight });
  if (trackLeadLine) trackLeadLine.setStyle({ color, weight });
}

// 移動記録開始点マーカーのスタイル。全経路の既存マーカーへ即時反映。
export function setTrackStartStyle(style) {
  trackStartStyle = style;
  const icon = buildShapeIcon(trackStartStyle, 'square');
  for (const track of tracks) {
    if (track.startMarker) track.startMarker.setIcon(icon);
  }
}

// 移動記録現在地点(終了点)マーカーのスタイル。全経路の既存マーカーへ即時反映
// (進行方向を再計算。記録中の経路はライブ現在地の位置を保つ)。
export function setTrackCurrentStyle(style) {
  trackCurrentStyle = style;
  for (const track of tracks) {
    if (!track.endMarker) continue;
    updateTrackEndMarker(track, track === recordingTrack ? liveLatLngSource() : null);
  }
}

// 移動記録系マーカー用 divIcon を生成(marker-icons.js の共通関数に既定値を渡す薄いラッパー)
function buildShapeIcon(style, fallbackShape, rotationDeg = 0) {
  return buildMarkerIcon(style, {
    fallbackShape,
    fallbackColor: '#000080',
    fallbackSize: 8,
    rotationDeg
  });
}

// 開始点マーカー(四角)を置く
function addStartMarker(track, latlng) {
  track.startMarker = L.marker(latlng, { icon: buildShapeIcon(trackStartStyle, 'square') }).addTo(getMap());
}

// ===== 終了点(進行方向の三角)と現在地点までの線 =====
// 進行方向: 過去最大3点(記録点)の平均座標から、現在位置へ向かう方位(utils.js の bearingDegrees)。
// 三角マーカーの回転に用いる。
// current は現在位置(記録中はライブ現在地、停止後は最終記録点)。
// 方向が定まらない(平均と現在が同じ等)場合は 0(北・上向き)を返す。
function computeHeading(latlngs, current) {
  const n = latlngs.length;
  if (n === 0) return 0;
  const k = Math.min(3, n);
  const recent = latlngs.slice(n - k);
  let lat = 0;
  let lng = 0;
  for (const p of recent) { lat += p.lat; lng += p.lng; }
  const avg = { lat: lat / k, lng: lng / k };
  if (Math.abs(avg.lat - current.lat) < 1e-9 && Math.abs(avg.lng - current.lng) < 1e-9) return 0;
  return bearingDegrees(avg, current);
}

// 経路の終了点マーカー(三角)を配置し、進行方向に回転させる。
// liveLatLng を与えると現在地(ライブ)へ、無ければ最終記録点へ配置する。
function updateTrackEndMarker(track, liveLatLng) {
  const map = getMap();
  if (!track || !map) return;
  const latlngs = track.polyline.getLatLngs();
  if (latlngs.length === 0) return;
  const pos = liveLatLng ? L.latLng(liveLatLng) : latlngs[latlngs.length - 1];
  const icon = buildShapeIcon(trackCurrentStyle, 'triangle', computeHeading(latlngs, pos));
  if (!track.endMarker) {
    track.endMarker = L.marker(pos, { icon }).addTo(map);
  } else {
    track.endMarker.setLatLng(pos);
    track.endMarker.setIcon(icon);
  }
}

// 記録中の経路をライブ現在地へ追従させる(終了点マーカーと、最終記録点からの線)。
function updateRecordingLive(latlng) {
  if (!recordingTrack) return;
  updateTrackEndMarker(recordingTrack, latlng);
  updateTrackLeadLine(recordingTrack, latlng);
}

// 最終記録地点 → 現在地点(ライブ)を結ぶ線を更新する。
// live が null(記録停止時など)のとき、また現在地が最終記録地点とほぼ同じ位置の
// ときは線を消す(長さ 0 の線が点として残るのを避けるため)。
function updateTrackLeadLine(track, live) {
  const map = getMap();
  const latlngs = track ? track.polyline.getLatLngs() : [];
  if (!map || !live || latlngs.length === 0) {
    removeTrackLeadLine();
    return;
  }
  const last = latlngs[latlngs.length - 1];
  if (last.distanceTo(live) < 0.5) {
    removeTrackLeadLine();
    return;
  }
  if (!trackLeadLine) {
    trackLeadLine = L.polyline([last, live], trackLineOptions()).addTo(map);
  } else {
    trackLeadLine.setLatLngs([last, live]);
  }
}

function removeTrackLeadLine() {
  if (trackLeadLine) {
    getMap()?.removeLayer(trackLeadLine);
    trackLeadLine = null;
  }
}

// ===== 記録の開始・停止(geolocation.js の startTrackRecording / stopTrackRecording から) =====
// 記録を始める。1回の記録が1本の経路になる。
// append=false: 表示中の経路をすべてクリアしてから記録する
// append=true : 表示中の経路を残し、新しい経路として追加で記録する
export function beginRecording({ append = false } = {}) {
  if (!append) clearTrack();
  recording = true;
  // 記録中は画面を消灯させない(消灯するとページが停止し記録が途切れるため)
  requestWakeLock();
  recordingTrack = createTrack();
}

// 記録開始の時点で、新しく精度も十分な現在地が取得済なら、最初の点として打つ(待たずに描画開始する)
export function seedRecording(latlng, timeMs, accuracyM) {
  if (!recordingTrack || !isAccurateForTrack(accuracyM)) return;
  appendTrackPoint(recordingTrack, latlng, timeMs);
  updateRecordingLive(latlng);
}

// 測位のたびに呼ぶ(記録中だけ働く)。条件を満たせば記録点を追加し、三角をライブ現在地へ追従させる
// (進行方向つき)。fixTimeMs は測位時刻、accuracyM は測位精度[m]。
export function recordFix(latlng, fixTimeMs, accuracyM) {
  if (!recording || !recordingTrack) return;
  if (shouldRecordTrackPoint(latlng, fixTimeMs, accuracyM)) {
    appendTrackPoint(recordingTrack, latlng, fixTimeMs);
  }
  updateRecordingLive(latlng);
}

// 記録を終える。記録中の経路を確定する(現在地の監視の見直しは geolocation.js が行う)
export function endRecording() {
  recording = false;
  // 記録が終わったら画面スリープ防止を解除する(電池消費を元に戻す)
  releaseWakeLock();
  if (recordingTrack) {
    if (recordingTrack.polyline.getLatLngs().length === 0) {
      // 位置が一度も取得できずに終わった経路は、地点数0の経路として残さず破棄する
      removeTrackLayers(recordingTrack);
      tracks = tracks.filter((tr) => tr !== recordingTrack);
    } else {
      // 三角(終了点)を最終記録点へスナップして固定する。
      updateTrackEndMarker(recordingTrack);
    }
  }
  removeTrackLeadLine();
  recordingTrack = null;
  // 地点数0の経路を破棄した場合に備え、保存内容を現在の表示に合わせ直す
  saveTrackToStorage();
}

// 空の経路を1本作って一覧の末尾に追加する。
// 記録条件の判定用の直近地点もリセットし、この経路の1点目を必ず記録させる。
function createTrack() {
  const track = {
    polyline: L.polyline([], trackLineOptions()).addTo(getMap()),
    startMarker: null,
    endMarker: null,
    times: [],
    names: []
  };
  tracks.push(track);
  lastTrackLatLng = null;
  lastTrackTimeMs = 0;
  return track;
}

// 経路の表示物(線・開始点・終了点)を地図から取り除く
function removeTrackLayers(track) {
  const map = getMap();
  if (!map || !track) return;
  map.removeLayer(track.polyline);
  if (track.startMarker) map.removeLayer(track.startMarker);
  if (track.endMarker) map.removeLayer(track.endMarker);
}

// 記録点にしてよい測位精度か。精度が得られない(非数)ときは判定できないため通す
function isAccurateForTrack(accuracyM) {
  return !Number.isFinite(accuracyM) || accuracyM <= TRACK_MAX_ACCURACY_M;
}

// 記録判定。外れ値を除いたうえで、直近の記録点から 20m 以上離れた、または 1 分以上経過していれば記録対象。
// fixTimeMs は測位時刻(geolocation.js の fixTimeOf)、accuracyM は測位精度[m]。
function shouldRecordTrackPoint(latlng, fixTimeMs, accuracyM) {
  // 精度の悪い測位(概算位置)は記録しない
  if (!isAccurateForTrack(accuracyM)) return false;
  if (!lastTrackLatLng) return true;
  const elapsedMs = fixTimeMs - lastTrackTimeMs;
  // 直近の記録点より古い(または同時刻の)測位は記録しない
  if (elapsedMs <= 0) return false;
  const distance = L.latLng(latlng).distanceTo(L.latLng(lastTrackLatLng));
  // 歩行ではありえない速さの移動(飛び)は記録しない
  if (distance / (elapsedMs / 1000) > TRACK_MAX_SPEED_MPS) return false;
  if (distance >= TRACK_MIN_DISTANCE_M) return true;
  if (elapsedMs >= TRACK_MIN_INTERVAL_MS) return true;
  return false;
}

// 記録点追加時の通知先(track-ui.js がパネル内の統計表の更新と、未出力の印に使用)。
// 引数の recorded は、記録で増えた(true)か、読み込みで描いた(false)か
let onTrackPointAppended = null;
export function setOnTrackPointAppended(fn) { onTrackPointAppended = fn; }

// 記録点を追加: 経路の線に頂点を足し、最初の点なら開始点マーカーを置く。
// timeMs は記録時刻(測位時刻)。
function appendTrackPoint(track, latlng, timeMs) {
  if (!track) return;
  const wasEmpty = track.polyline.getLatLngs().length === 0;
  track.polyline.addLatLng(latlng);
  const lat = Array.isArray(latlng) ? latlng[0] : latlng.lat;
  const lng = Array.isArray(latlng) ? latlng[1] : latlng.lng;

  // 開始地点マーカー(この経路の最初の記録点のみ)
  if (wasEmpty) addStartMarker(track, [lat, lng]);

  // 終了点マーカー(三角)の位置・向きは呼び出し側(記録中はライブ現在地)で更新する。
  lastTrackLatLng = [lat, lng];
  lastTrackTimeMs = timeMs;
  track.times.push(timeMs);
  track.names.push(null);
  onTrackPointAppended?.({ recorded: true });
  saveTrackToStorage();
}

// ===== 統計・GPX 用の点列・読み込み =====
// 1本の経路の統計(記録地点数・移動距離[m])
function statsOfTrack(track) {
  const latlngs = track.polyline.getLatLngs();
  let distanceM = 0;
  for (let i = 1; i < latlngs.length; i++) {
    distanceM += latlngs[i - 1].distanceTo(latlngs[i]);
  }
  return { pointCount: latlngs.length, distanceM };
}

// 経路ごとの統計を、表示順(記録・読み込みの順)で返す。
// 軌跡が消去(clearTrack)される前に呼ぶこと。
export function getTrackStatsList() {
  return tracks.map(statsOfTrack);
}

// 全経路を合わせた統計(記録地点数・合計移動距離[m])を返す。
// 軌跡が消去(clearTrack)される前に呼ぶこと。
export function getTrackStats() {
  return getTrackStatsList().reduce(
    (acc, s) => ({ pointCount: acc.pointCount + s.pointCount, distanceM: acc.distanceM + s.distanceM }),
    { pointCount: 0, distanceM: 0 }
  );
}

// 記録済みの移動経路を、経路ごとの点列({lat, lng, timeMs, name})の配列で返す(GPX出力に使用)。
// name は読み込んだ GPX の記録点に名前が付いていたときだけ入る(他は null。以前の版は撮影地点の
// 記録点に写真の名前を付けていたため、そうした GPX を読み込み直しても名前を失わないよう保持する)。
// 軌跡が消去(clearTrack)される前に呼ぶこと。
export function getTrackSegments() {
  return tracks.map((track) => track.polyline.getLatLngs().map((ll, i) => ({
    lat: ll.lat,
    lng: ll.lng,
    timeMs: track.times[i] ?? null,
    name: track.names[i] ?? null
  })));
}

// 外部から読み込んだ移動経路を、記録済みの経路として描画する。
// segments は経路ごとの点列({lat, lng, timeMs, name})の配列で、1セグメントが1本の経路になる
// (name は任意。記録点の名前として保持し、再出力で <name> に戻す)。
// append=false: 表示中の経路をすべてクリアして置き換える
// append=true : 表示中の経路を残し、続きの経路として追加する
// (いずれも記録中は呼ばない。呼び出し側で抑止すること)
// 記録時刻はファイルの値をそのまま保持するため、読み込んだ経路をそのまま
// 「出力」で再出力できる。描画できた地点数の合計を返す。
export function loadTrackSegments(segments, { append = false } = {}) {
  const map = getMap();
  if (!map) return 0;
  const validSegments = (segments || [])
    .map((seg) => (seg || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)))
    .filter((seg) => seg.length > 0);
  if (validSegments.length === 0) return 0;

  if (!append) clearTrack();

  let loaded = 0;
  for (const seg of validSegments) {
    const track = createTrack();
    track.polyline.setLatLngs(seg.map((p) => [p.lat, p.lng]));
    track.times = seg.map((p) => (Number.isFinite(p.timeMs) ? p.timeMs : null));
    track.names = seg.map((p) => (typeof p.name === 'string' && p.name ? p.name : null));
    addStartMarker(track, [seg[0].lat, seg[0].lng]);
    // 終了点マーカー(三角)は最終地点へ。ライブ現在地は渡さないので中間線も出ない。
    updateTrackEndMarker(track);
    loaded += seg.length;
  }
  // 読み込み(記録ではない)ことを伝える。track-ui.js は記録で増えたときだけ未出力にする
  onTrackPointAppended?.({ recorded: false });
  saveTrackToStorage();
  return loaded;
}

// 表示中の移動経路(全経路)の全体が収まるよう地図を合わせる(読み込み直後に使う)
export function fitMapToTrack() {
  const bounds = tracks.reduce((acc, track) => acc.extend(track.polyline.getBounds()), L.latLngBounds([]));
  fitMapToLatLngs([], bounds);
}

// 移動記録の表示(全経路の線・開始点・終了点)を全削除する。
// 「移動経路をクリア」ボタンと、記録・読み込みでの置き換え時に呼び出す
// (トグル OFF では消さない)。
export function clearTrack() {
  recording = false;
  releaseWakeLock();
  for (const track of tracks) removeTrackLayers(track);
  tracks = [];
  recordingTrack = null;
  removeTrackLeadLine();
  lastTrackLatLng = null;
  lastTrackTimeMs = 0;
  // 表示が空になったので、端末の保存も消す
  saveTrackToStorage();
}

// ===== 移動経路の保存(端末内・IndexedDB) =====
// 表示中の経路を、変化のたびに端末へ上書き保存する。保存するのは常に最新の
// 内容1件だけで、過去の記録は残さない(→ db.js の tracks ストア)。
// これが無いと、再読み込みやアプリの終了で記録が黙って消える。Web ページは
// 離脱時に破棄され、メモリ上の経路も一緒に失われるためである。
// 保存できなくても記録・表示はそのまま続けられるので、失敗は握りつぶす
// (プライベートウィンドウ等、IndexedDB を使えない環境でも動かすため)。
//
// 保存を呼ぶのは経路が変わる4か所: 記録点の追加・記録の停止・GPXの読み込み・クリア。
// 記録点は「20m 以上移動」または「60秒以上経過」でしか増えないため、
// 書き込みの頻度は数分に1回程度で、まとめ書き(デバウンス)は要らない。

// 復元中は保存しない。復元は loadTrackSegments 経由で clearTrack を通るため、
// そのままだと読み出したばかりの内容をいったん消して書き直すことになる。
let restoringTrack = false;

function saveTrackToStorage() {
  if (restoringTrack) return;
  // 地点0の経路(記録開始直後で1点も取れていない経路)は保存しない
  const segments = getTrackSegments().filter((seg) => seg.length > 0);
  const saving = segments.length > 0 ? saveLatestTrack(segments) : clearLatestTrack();
  saving.catch(() => { /* 保存できなくても記録は続ける */ });
}

// 起動時に1回だけ呼ぶ。端末に保存済みの経路を読み出して地図に描く。
// 記録は再開しない(ページが動いていない間の位置は取得できず、途切れた経路を
// 記録中として続けると実際の移動と食い違うため)。常に停止した状態で戻す。
// 描いた地点数の合計を返す(0 なら保存が無かった、または読めなかった)。
export async function restoreSavedTrack() {
  let segments = [];
  try {
    segments = await loadLatestTrack();
  } catch {
    return 0;
  }
  if (segments.length === 0) return 0;
  restoringTrack = true;
  try {
    return loadTrackSegments(segments);
  } finally {
    restoringTrack = false;
  }
}

// ===== 画面スリープの防止(Screen Wake Lock API) =====
// 移動記録中は画面を消灯させない。消灯するとブラウザがページの実行を止めてしまい、
// 位置の監視(watchPosition)が動かず中間点が記録されないため。
// 非対応の端末・ブラウザ(iOS 16.3 以前など)や、省電力モード等で取得できない場合は
// 記録自体はそのまま続け、その旨を通知する(notifyTrack)。
// 画面の復帰時の取り直しは geolocation.js(visibilitychange)が行う。
let wakeLockSentinel = null;
// スリープ防止を取得できなかったことを一度だけ通知するためのフラグ(記録ごとにリセット)
let wakeLockNotified = false;

export async function requestWakeLock() {
  if (wakeLockSentinel) return;
  if (!('wakeLock' in navigator)) {
    notifyWakeLockUnavailable();
    return;
  }
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    // 非表示になる等で OS 側が解除したときは保持を破棄する
    // (復帰時に visibilitychange で取り直す)
    wakeLockSentinel.addEventListener('release', () => { wakeLockSentinel = null; });
  } catch {
    wakeLockSentinel = null;
    notifyWakeLockUnavailable();
  }
}

function notifyWakeLockUnavailable() {
  if (wakeLockNotified) return;
  wakeLockNotified = true;
  notifyTrack(t('track.wakeLockUnavailable'));
}

function releaseWakeLock() {
  const sentinel = wakeLockSentinel;
  wakeLockSentinel = null;
  wakeLockNotified = false;
  if (sentinel) sentinel.release().catch(() => { /* 既に解除済み */ });
}

// 移動記録に関する通知先(track-ui.js が履歴・トーストへの出力に使用)
let onTrackNotice = null;
export function setOnTrackNotice(fn) { onTrackNotice = fn; }
function notifyTrack(msg) { onTrackNotice && onTrackNotice(msg); }
