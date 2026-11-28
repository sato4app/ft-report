// 現在地表示モジュール
// - 現在地マーカー(青丸)と地図の追従。監視の要否は needLocationWatch、追従の条件は shouldFollowMap。
//   測位精度(accuracy)を半径とする精度円は出さない(大きさが測位状況で変わり、意味が伝わらないため)。
// - 現在地点表示ボタンの単発表示(showCurrentLocationSpot)。
// - 移動経路の記録の開始・停止(startTrackRecording / stopTrackRecording)。記録には現在地の監視が
//   要るため、監視の制御とあわせてここから行う。経路のデータと描画は track.js が持つ。
// - 写真の撮影地点(撮影時の位置の取り直し)。写真そのものは photos.js が持ち、経路とは結び付けない。
// - 現在地を使うほかの機能(場所を検索。photo-explore.js)への、位置と状態の知らせ(addLocationListener)。
//   現在地の監視はここだけが行い、ほかの機能は自分で監視しない(監視は1つで済む)。
import * as L from 'leaflet';
import { getMap, ensureMapSize, msSinceMapInteraction, setOnMapInteractionEnd } from './map.js';
import { isOneFingerZooming, setOneFingerZoomAroundCenter } from './one-finger-zoom.js';
import { buildMarkerIcon } from './marker-icons.js';
import {
  isTrackRecording, beginRecording, seedRecording, recordFix, endRecording,
  requestWakeLock, setLiveLatLngSource
} from '../track/track.js';
import { PHOTO_POSITION_TIMEOUT_MS, FOLLOW_RESUME_IDLE_SEC } from '../common/config.js';
import { t } from '../common/i18n.js';

// 測位の設定。監視(watchPosition)と現在地点表示ボタンは直近 5 秒以内の位置を使ってよい。
// 記録の復帰時・撮影時は、その場の位置を取り直す(maximumAge: 0)
const GEO_OPTIONS = { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 };
const FRESH_GEO_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };

let currentLocationMarker = null;
let geoWatchId = null;
// マップビュー表示中か(ビュー外では現在地を監視しない)
let onMapView = false;
// 現在地点をマーカー表示(メニュートグル・既定 ON)
let showCurrentMarker = true;
// 現在地を地図中央に表示=現在地へ追従(メニュートグル・既定 ON)。
// 実際に地図を動かす条件は shouldFollowMap()(マーカー表示 ON かつマップ画面表示中)。
let followCurrentLocation = true;
// 次に地図を現在地へ寄せるとき、アニメ無しで一気に移動するか。
// 追従を ON にした直後(およびマーカー表示を ON に戻した直後)は現在地が画面外のこともあるため、
// 最初の1回はアニメ無しで寄せる。
// 実際に地図を動かしたときだけ倒すので、地図が動かない条件のあいだに位置を取得しても倒れない。
let recenterWithoutAnimation = true;
// 直近に取得した現在地(トグル切替時の即時反映に使用)
let lastKnownLatLng = null;
// 直近の位置を取得した時刻[ms](鮮度の判定は isLastFixFresh)
let lastKnownAtMs = 0;
// 直近の位置の測位精度[m](coords.accuracy)。記録開始時の1点目に使えるかの判定に使う
let lastKnownAccuracyM = null;
// これまでに受け取った測位のうち最も新しい測位時刻[ms](pos.timestamp。fixTimeOf 参照)。
// これより古い測位が後から届いたら捨てる(watchPosition と getCurrentPosition の
// 応答順は保証されず、良い位置の後に古い粗い位置が届くことがあるため)
let lastFixTimeMs = 0;
// 直近の位置を「現在地」として即時反映してよい上限。これより古い位置は使わず次の取得を待つ。
// 監視は両トグル OFF・マップ画面を離れたときに止まるため、再開直後の直近位置は
// 何分も前の地点でありうる。そこへ地図を寄せると現在地から離れた場所が表示されてしまう
const LAST_FIX_MAX_AGE_MS = 30 * 1000;
// 位置情報エラーの通知コールバックと、監視中に通知済みかのフラグ(連続エラーの抑制)
let locationErrorCb = null;
let locationErrorReported = false;
// 位置情報を使えないか(利用が許可されていない・端末が対応していない。→ isLocationUnavailable)
let locationUnavailable = false;
// 位置の受け手(addLocationListener)
const locationListeners = new Set();

// 記録中の経路の三角は、スタイルを変えたとき直近の現在地へ置き直す(track.js)
setLiveLatLngSource(() => lastKnownLatLng);

// ===== 現在地を使うほかの機能への知らせ =====
// 受け手は何個でも登録できる。登録を外す関数を返す。受け手 fn(event) の event.type は次のどれか:
//   'fix'    … 位置が届いた(event.latlng = [lat, lng])。監視・現在地点表示ボタン・撮影時の取り直しのどれでも届く
//   'status' … 「現在地点をマーカー表示」が切り替わった・位置情報を使えなくなった。
//              今の状態は isCurrentMarkerVisible() / isLocationUnavailable() / getFreshLatLng() で調べる
// 監視の開始・停止はここ(needLocationWatch)が決める。受け手は監視を頼まない
// (「現在地点をマーカー表示」が ON なら、マップ画面では監視している)。
export function addLocationListener(fn) {
  locationListeners.add(fn);
  return () => locationListeners.delete(fn);
}

function emitLocation(event) {
  for (const fn of [...locationListeners]) {
    try {
      fn(event);
    } catch (err) {
      console.error('[geolocation] 位置の受け手の処理で問題が発生しました:', err);
    }
  }
}

// 直近の位置。「現在地」として使えるほど新しい(isLastFixFresh)ときだけ [lat, lng] を返し、それ以外は null
export function getFreshLatLng() {
  return isLastFixFresh() ? lastKnownLatLng.slice() : null;
}

// 「現在地点をマーカー表示」が ON か
export function isCurrentMarkerVisible() {
  return showCurrentMarker;
}

// 位置情報を使えないか(利用が許可されていない・端末が対応していない)。
// 一時的に取れないとき(時間切れ・電波が弱いなど)は含めない(監視は続き、次の位置が届く)。
// 監視を始め直したとき・位置が届いたときに降ろす(許可を後から変えた場合に備える)
export function isLocationUnavailable() {
  return locationUnavailable;
}

function setLocationUnavailable(on) {
  if (locationUnavailable === on) return;
  locationUnavailable = on;
  emitLocation({ type: 'status' });
}

// 位置情報のエラーが「利用が許可されていない」か(GeolocationPositionError.PERMISSION_DENIED = 1)
function isPermissionDenied(err) {
  return err?.code === 1;
}

// ===== 移動経路の記録の開始・停止 =====
// 移動記録を開始する。1回の記録が1本の経路になる。
// append=false: 表示中の経路をすべてクリアしてから記録する
// append=true : 表示中の経路を残し、新しい経路として追加で記録する
export function startTrackRecording({ append = false } = {}) {
  if (!getMap()) return;
  beginRecording({ append });
  // マーカー表示・追従が両方 OFF でも、記録のため現在地監視を確実に開始する。
  refreshLocationWatch();
  // 新しく精度も十分な現在地が取得済なら、最初の点として打つ(待たずに描画開始する)。
  // 青丸は消さない。表示するかは「現在地点をマーカー表示」トグルだけで決まる。
  if (isLastFixFresh()) seedRecording(lastKnownLatLng, lastFixTimeMs, lastKnownAccuracyM);
}

export function stopTrackRecording() {
  endRecording();
  // マーカー表示 ON なら現在地(青丸)を最新位置に合わせておく
  // (記録中も出しているので通常は既にあるが、無ければここで出す)。
  if (showCurrentMarker && lastKnownLatLng) showOrUpdateCurrentMarker(lastKnownLatLng);
  // 記録が監視を要求しなくなった場合に備えて監視状態を見直す。
  refreshLocationWatch();
}

// ===== 写真の撮影地点 =====
// 撮影時に位置を取り直す。取れたら通常の位置更新と同じく反映(現在地・記録)したうえで
// [lat, lng] を返す。取れなければ直近の位置が新しい(LAST_FIX_MAX_AGE_MS 以内)ときだけそれを返し、
// それも無ければ null を返す(位置の分からない写真は保存しない)。
export function capturePhotoPosition() {
  const fallback = () => (isLastFixFresh() ? lastKnownLatLng.slice() : null);
  if (!('geolocation' in navigator)) return Promise.resolve(fallback());
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onGeoSuccess(pos);
        resolve([pos.coords.latitude, pos.coords.longitude]);
      },
      () => resolve(fallback()),
      { ...FRESH_GEO_OPTIONS, timeout: PHOTO_POSITION_TIMEOUT_MS }
    );
  });
}

// ===== 画面の向き・表示領域が変わったときの処理 =====
// 回転などで地図の大きさが変わったら測り直し、追従中なら現在地へ寄せ直す。
//
// iOS は回転直後の resize でまだ回転前の大きさを返すことがあり、Leaflet の
// 自動計測(trackResize)がその値で確定してしまう。以降 resize は来ないため、
// 縦画面なのに横画面の幅で中央を計算し続け、現在地が画面の外に出たままになる。
// そこで確定を待つ意味で「直後・次の描画・0.3秒後」の3回測り直し、
// 実際に大きさが変わっていたときだけ寄せ直す。
// (ページのピンチズームでは visualViewport だけが変わりコンテナの大きさは変わらないため、
//  ensureMapSize が false を返して寄せ直さない=勝手に地図が動かない)
function handleViewportChange() {
  const apply = () => {
    if (!ensureMapSize()) return;
    if (!shouldFollowMap() || !isLastFixFresh()) return;
    // 回転後は現在地が画面外にあることもあるため、アニメ無しで一気に寄せる
    recenterWithoutAnimation = true;
    moveMapToCurrentLocation(lastKnownLatLng);
  };
  apply();
  requestAnimationFrame(apply);
  setTimeout(apply, 300);
}

window.addEventListener('orientationchange', handleViewportChange);
window.addEventListener('resize', handleViewportChange);
window.visualViewport?.addEventListener('resize', handleViewportChange);

// ===== バックグラウンド復帰時の処理 =====
// 他アプリへの切替や画面消灯でページが非表示になると、ブラウザは位置の監視を
// 停止・間引きする(Web の仕様上、完全なバックグラウンド測位はできない)。
// 記録中に復帰したら「スリープ防止の取り直し」「監視の張り直し」「現在地の即時取得」を行い、
// 非表示だった区間の記録の途切れをできるだけ短くする。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!isTrackRecording()) return;
  requestWakeLock();
  restartGeoWatch();
  captureCurrentPositionForTrack();
});

// 監視を張り直す(非表示中に OS/ブラウザ側で止められている場合への対処)。
// stopGeoWatch と違いマーカーは消さない。
function restartGeoWatch() {
  if (geoWatchId != null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
  refreshLocationWatch();
}

// 復帰直後の現在地を1点だけ取得して記録に反映する(watchPosition の初回通知を待たない)。
// 記録条件(20m 以上 or 1分以上)は onGeoSuccess 側の判定をそのまま使う。
function captureCurrentPositionForTrack() {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    onGeoSuccess,
    () => { /* 失敗しても watchPosition 側で通知されるためここでは何もしない */ },
    FRESH_GEO_OPTIONS
  );
}

// ===== 現在地監視の制御 =====
// 監視(watchPosition)が必要か:
// - 移動記録中: 画面(ビュー)に関わらず常に必要。起動時画面へ移動しても記録を続けるため。
// - それ以外: マップビュー表示中で、現在地マーカー表示・現在地追従のいずれかが要求しているとき。
//
// 「現在地点は中央に表示」だけが ON のとき(マーカー表示は OFF)、地図は動かず
// (shouldFollowMap)、マーカーも出ないため画面上は何も起きない。それでも
// 監視を続けるのは意図した選択で、直近の測位を新しく保つため。
// 止めてしまうと、マーカー表示を ON に戻したときに直近位置が古すぎて
// (LAST_FIX_MAX_AGE_MS 超え)使えず、次の測位まで現在地が出ない・地図も寄らない。
// 「何も表示していないのに測位している」のは不具合ではないので、電池優先に振るとき以外は
// この条件を狭めないこと。
function needLocationWatch() {
  if (isTrackRecording()) return true;
  return onMapView && (showCurrentMarker || followCurrentLocation);
}

// 必要に応じて監視を開始/停止する。各トグル・記録状態・ビュー切替の後に呼ぶ。
function refreshLocationWatch() {
  if (needLocationWatch()) startGeoWatch();
  else stopGeoWatch();
}

function startGeoWatch() {
  if (!getMap() || geoWatchId != null) return; // 既に監視中
  if (!('geolocation' in navigator)) {
    reportLocationError(t('geo.notSupported'));
    setLocationUnavailable(true);
    return;
  }
  locationErrorReported = false;
  setLocationUnavailable(false);
  geoWatchId = navigator.geolocation.watchPosition(
    onGeoSuccess,
    (err) => {
      if (isPermissionDenied(err)) setLocationUnavailable(true);
      reportLocationError(t('geo.fetchFailed', { message: err.message }));
    },
    GEO_OPTIONS
  );
}

function stopGeoWatch() {
  if (geoWatchId != null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
  removeCurrentMarker();
}

// 位置情報エラーの通知(1回の監視につき最初の1回のみ。連続エラーを抑制)
function reportLocationError(msg) {
  if (locationErrorReported) return;
  locationErrorReported = true;
  locationErrorCb && locationErrorCb(msg);
}

// 測位の時刻[ms]。基本は pos.timestamp(測位した時刻)を使う。
// 値が無い・明らかにおかしい(未来、または1日以上前)ときは受け取った時刻で代える
const FIX_TIME_MAX_FUTURE_MS = 60 * 1000;
const FIX_TIME_MAX_PAST_MS = 24 * 60 * 60 * 1000;
function fixTimeOf(pos) {
  const nowMs = Date.now();
  const ts = Number(pos.timestamp);
  if (!Number.isFinite(ts) || ts > nowMs + FIX_TIME_MAX_FUTURE_MS || ts < nowMs - FIX_TIME_MAX_PAST_MS) {
    return nowMs;
  }
  return ts;
}

// 受け取った測位を直近の位置として覚え、受け手(addLocationListener)に知らせる。
// 位置が届いたので、位置情報を使えない状態は降ろす(知らせは 'fix' だけにする)
function rememberFix(pos, fixTimeMs) {
  lastKnownLatLng = [pos.coords.latitude, pos.coords.longitude];
  lastKnownAtMs = Date.now();
  lastKnownAccuracyM = pos.coords.accuracy;
  lastFixTimeMs = Math.max(lastFixTimeMs, fixTimeMs);
  locationUnavailable = false;
  emitLocation({ type: 'fix', latlng: lastKnownLatLng.slice() });
}

// 位置取得成功時の更新処理(マーカー表示・記録・地図追従)
function onGeoSuccess(pos) {
  const fixTimeMs = fixTimeOf(pos);
  // 既に処理した測位より古い測位が後から届いたら、表示にも記録にも使わない
  if (fixTimeMs < lastFixTimeMs) return;
  rememberFix(pos, fixTimeMs);
  const latlng = lastKnownLatLng;

  // 現在地マーカー(青丸): 「現在地点をマーカー表示」ON なら表示する。
  // 記録中も出す(ライブ現在地は三角でも示すが、青丸を消す理由にはしない)。
  if (showCurrentMarker) {
    showOrUpdateCurrentMarker(latlng);
  } else {
    removeCurrentMarker();
  }

  // 記録中: 条件を満たせば記録点を追加し、三角をライブ現在地へ追従(進行方向つき)
  recordFix(latlng, fixTimeMs, pos.coords.accuracy);

  // 地図を操作している間と、操作を終えてから FOLLOW_RESUME_IDLE_SEC 秒は寄せない(→ scheduleFollowResume)
  if (shouldFollowMap() && isMapIdleForFollow()) moveMapToCurrentLocation(latlng);
}

// いま地図を現在地へ寄せてよいか。
// 「現在地点は中央に表示」に加えて「現在地点をマーカー表示」も ON であることを要求する。
// マーカーを出していないのに地図だけが動くと、何に追従しているのかが画面から分からず、
// 地図を自分で動かしても引き戻される理由が読めなくなるため。
// 地図を動かすのはマップ画面表示中のみ(記録中は起動時画面でも監視が続く)。
function shouldFollowMap() {
  return followCurrentLocation && showCurrentMarker && onMapView;
}

// 追従中の1本指ズームは、触れた地点ではなく現在地のある画面中央を中心にする(one-finger-zoom.js 参照)
setOneFingerZoomAroundCenter(shouldFollowMap);

// ===== 地図を操作した後の追従の再開 =====
// 「現在地点は中央に表示」でも、利用者が地図を操作している間(触れている間)と、操作を終えてから
// FOLLOW_RESUME_IDLE_SEC 秒のあいだは現在地へ寄せない。位置の更新のたびにすぐ引き戻すと、
// 地図を動かして周りを見ることができないため。何も操作しないままその秒数が経ったら、
// 次の位置の更新を待たずに寄せる(立ち止まっていると位置の更新がなかなか来ないことがあるため)。
// トグルを ON にした直後・現在地点表示ボタン・画面の回転で寄せるのは、この待ちの対象外(すぐ寄せる)。
const FOLLOW_RESUME_IDLE_MS = FOLLOW_RESUME_IDLE_SEC * 1000;
let followResumeTimer = null;

function isMapIdleForFollow() {
  return msSinceMapInteraction() >= FOLLOW_RESUME_IDLE_MS;
}

// 操作を終えたとき(map.js から)に呼ぶ。待つ間にまた操作されたら、終えたところから数え直す
function scheduleFollowResume() {
  clearTimeout(followResumeTimer);
  followResumeTimer = setTimeout(() => {
    followResumeTimer = null;
    if (!isMapIdleForFollow()) {
      scheduleFollowResume();
      return;
    }
    if (shouldFollowMap() && isLastFixFresh()) moveMapToCurrentLocation(lastKnownLatLng);
  }, Math.max(0, FOLLOW_RESUME_IDLE_MS - msSinceMapInteraction()));
}
setOnMapInteractionEnd(scheduleFollowResume);

// 直近の位置が「現在地」として使えるほど新しいか。
// 監視を止めているあいだは位置が更新されないため、再開直後は古い位置が残っている
function isLastFixFresh() {
  return !!lastKnownLatLng && (Date.now() - lastKnownAtMs) <= LAST_FIX_MAX_AGE_MS;
}

// 地図を現在地が中央に来る位置へ動かす。
// 追従を始めてからの1回目は現在地が画面外のこともあるためアニメ無しで一気に寄せ、
// 2回目以降(移動にともなう更新)はアニメ付きで滑らかに追従する
function moveMapToCurrentLocation(latlng) {
  const map = getMap();
  if (!map) return;
  // 1本指ズームの最中は寄せない(途中のズームレベルは整数でないため、寄せると拡大縮小が乱れる)。
  // 指を離してから FOLLOW_RESUME_IDLE_SEC 秒後に寄せ直す(scheduleFollowResume)
  if (isOneFingerZooming()) return;
  // 寄せる前に地図の大きさを測り直す。覚え違いのまま寄せると、Leaflet が中央だと
  // 思う座標が実際の中央からずれ、現在地が画面の外に置かれる(ensureMapSize 参照)。
  // 回転時のイベントを取りこぼしても、次の位置更新でここが直してくれる。
  ensureMapSize();
  if (recenterWithoutAnimation) map.setView(latlng, map.getZoom(), { animate: false });
  else map.panTo(latlng);
  recenterWithoutAnimation = false;
}

// ===== 現在地マーカー(青丸) =====
// 見た目(色・形状・大きさ)はマーカー設定の「現在地点」に従う
// (setCurrentLocationStyle。既定値は config.js の MARKER_TYPES)。
let currentLocationStyle = null;
// 他のマーカー(緊急ポイント・移動記録現在地点の三角など)より下に描くための zIndexOffset。
// Leaflet のマーカーは画面の上下位置で重なり順が決まり、同じ位置では後から作った方が上になる。
// 記録中は三角が同じ位置に来るため、青丸を作り直すと三角を覆ってしまう。それを避けるため、
// 地図の大きさ(数千px)より十分大きく下げて、常に他のマーカーの下に置く
const CURRENT_MARKER_Z_OFFSET = -100000;

function currentMarkerIcon() {
  return buildMarkerIcon(currentLocationStyle, {
    fallbackShape: 'circle',
    fallbackColor: '#1d4ed8',
    fallbackSize: 16
  });
}

// 現在地マーカー(青丸)のスタイル。表示中なら即時反映
export function setCurrentLocationStyle(style) {
  currentLocationStyle = style;
  if (currentLocationMarker) currentLocationMarker.setIcon(currentMarkerIcon());
}

// 現在地マーカー(青丸)の生成・更新
function showOrUpdateCurrentMarker(latlng) {
  if (!currentLocationMarker) {
    currentLocationMarker = L.marker(latlng, {
      icon: currentMarkerIcon(),
      zIndexOffset: CURRENT_MARKER_Z_OFFSET
    }).addTo(getMap());
    currentLocationMarker.bindPopup('現在地');
  } else {
    currentLocationMarker.setLatLng(latlng);
  }
}

function removeCurrentMarker() {
  if (currentLocationMarker) {
    getMap().removeLayer(currentLocationMarker);
    currentLocationMarker = null;
  }
}

// ===== 現在地点表示ボタン(ズームボタンの上)の単発表示(3秒) =====
// 押すと現在地を画面中央へ寄せ、現在地点を中心とする薄い青の円を出して3秒かけて縮めてから消す。
//
// 円の大きさは地図の縮尺ではなく画面の大きさで決める(地図の短辺に対する割合)。
// そのため半径をメートルで指定する L.circle ではなく、ピクセルで指定する
// L.circleMarker を使う。直径は 短辺の70% から 短辺の10% まで一定の速さで縮む。
//
// 青丸(現在地マーカー)はこのボタンでは出し分けない。メニューの
// 「現在地点をマーカー表示」が ON なら現在地へ青丸を出し、OFF なら出さない
// (このボタン専用の青丸を持つと、トグル OFF のときだけ青丸が出る・3秒で消えるといった
//  トグルと食い違う見え方になるため、表示の可否はトグルに一本化する)。
const SPOT_CIRCLE_DURATION_MS = 3000;   // 表示してから消えるまで(縮小にかける時間)
const SPOT_CIRCLE_START_RATIO = 0.70;   // 表示開始時の直径 / 地図の短辺
const SPOT_CIRCLE_END_RATIO = 0.10;     // 縮小後の直径 / 地図の短辺
// 薄い青の円。地図の記載が透けて読めるよう塗りは薄くする
const SPOT_CIRCLE_STYLE = {
  color: '#60a5fa',
  weight: 2,
  opacity: 0.8,
  fillColor: '#93c5fd',
  fillOpacity: 0.2
};

let spotCircle = null;          // 縮小中の円
let spotAnimFrameId = null;     // 縮小アニメーションの requestAnimationFrame ID
let spotEndCb = null;           // 終了(3秒経過・測位失敗)をボタンへ知らせる

// 現在地点表示ボタンが押されたときの処理。
// 直近の測位が新しければ即座に、そうでなければ1回だけ測位してから表示する
// (監視は両トグル OFF のあいだ止まっているため、古い位置を現在地として出さない)。
// onEnd は表示が終わったとき(3秒経過・測位失敗)に呼ぶ。ボタンを灰色へ戻すのに使う。
export function showCurrentLocationSpot({ onEnd } = {}) {
  const map = getMap();
  if (!map) { onEnd?.(); return; }
  // 連打されたら前回の表示を畳んでから出し直す(アニメーションの取り違えを避ける)
  clearCurrentLocationSpot();
  spotEndCb = onEnd;

  if (isLastFixFresh()) {
    renderCurrentLocationSpot(lastKnownLatLng);
    return;
  }
  if (!('geolocation' in navigator)) {
    reportLocationError(t('geo.notSupported'));
    setLocationUnavailable(true);
    endCurrentLocationSpot();
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      rememberFix(pos, fixTimeOf(pos));
      renderCurrentLocationSpot(lastKnownLatLng);
    },
    (err) => {
      if (isPermissionDenied(err)) setLocationUnavailable(true);
      reportLocationError(t('geo.fetchFailed', { message: err.message }));
      endCurrentLocationSpot();
    },
    GEO_OPTIONS
  );
}

// 現在地を画面中央へ寄せてから円を出す。
function renderCurrentLocationSpot(latlng) {
  const map = getMap();
  if (!map) { endCurrentLocationSpot(); return; }
  // 先に地図を動かす。現在地が画面外のこともあるためアニメ無しで一気に寄せる
  // (追従(setFollowCurrentLocation)とは別系統なので recenterWithoutAnimation は触らない)。
  // 寄せる前に大きさを測り直す(中央がずれるのを防ぐ。円の大きさも短辺から決めるため)。
  ensureMapSize();
  map.setView(latlng, map.getZoom(), { animate: false });
  // 青丸は「現在地点をマーカー表示」に従う。OFF のときは出さない(3秒後も触らない)
  if (showCurrentMarker) showOrUpdateCurrentMarker(latlng);
  startSpotCircle(latlng);
}

// 現在地点を中心とする円を地図の短辺の70%の大きさで出し、
// 3秒かけて10%まで一定の速さで縮めてから消す。
function startSpotCircle(latlng) {
  const map = getMap();
  const size = map.getSize();
  const shortSide = Math.min(size.x, size.y);
  // L.circleMarker の radius は半径[px]。指定は直径なので半分にする
  const startRadius = shortSide * SPOT_CIRCLE_START_RATIO / 2;
  const endRadius = shortSide * SPOT_CIRCLE_END_RATIO / 2;
  spotCircle = L.circleMarker(latlng, { ...SPOT_CIRCLE_STYLE, radius: startRadius }).addTo(map);

  const startedAt = performance.now();
  const step = (now) => {
    if (!spotCircle) return;   // 連打・画面切替で片付け済み
    const progress = Math.min(1, (now - startedAt) / SPOT_CIRCLE_DURATION_MS);
    spotCircle.setRadius(startRadius + (endRadius - startRadius) * progress);
    if (progress < 1) {
      spotAnimFrameId = requestAnimationFrame(step);
    } else {
      // 縮みきったら円を消し、ボタンを灰色へ戻す
      spotAnimFrameId = null;
      endCurrentLocationSpot();
    }
  };
  spotAnimFrameId = requestAnimationFrame(step);
}

// 3秒経過・測位失敗の後片付け。ボタンを灰色へ戻すため onEnd を必ず呼ぶ。
function endCurrentLocationSpot() {
  clearCurrentLocationSpot();
  const cb = spotEndCb;
  spotEndCb = null;
  cb?.();
}

// このボタンが出した円だけを消す(現在地マーカーには触れない)
function clearCurrentLocationSpot() {
  if (spotAnimFrameId != null) {
    cancelAnimationFrame(spotAnimFrameId);
    spotAnimFrameId = null;
  }
  if (spotCircle) {
    getMap()?.removeLayer(spotCircle);
    spotCircle = null;
  }
}

// ===== マップ画面・メニューのトグルとの連携 =====
// マップビューの出入りで現在地監視を制御する。
// active=true でマップ表示中とみなして必要なら監視開始、false で監視停止・マーカー除去。
// onError は位置情報取得失敗時の通知に使う(指定時に記憶し、以降の監視でも使用)。
export function setLocationActiveForMapView(active, { onError } = {}) {
  onMapView = active;
  if (onError) locationErrorCb = onError;
  refreshLocationWatch();
}

// 「現在地点をマーカー表示」トグル。OFF で青丸を消す。ON にした直後は、直近の位置が
// 新しければ(isLastFixFresh)即座に再表示する。地図追従の前提でもある(shouldFollowMap)。
// 切り替えたことは受け手に 'status' で知らせる(場所を検索は、OFF の間は方角と距離を出さない)
export function setCurrentMarkerVisible(on) {
  showCurrentMarker = on;
  if (!on) {
    removeCurrentMarker();
  } else {
    if (isLastFixFresh()) {
      showOrUpdateCurrentMarker(lastKnownLatLng);
    }
    // 追従が ON なら、ここで初めて条件がそろう。次の測位を待たずに寄せる
    // (「現在地点は中央に表示」を ON にしたときと同じ振る舞い)
    if (shouldFollowMap()) {
      recenterWithoutAnimation = true;
      if (isLastFixFresh()) moveMapToCurrentLocation(lastKnownLatLng);
    }
  }
  refreshLocationWatch();
  emitLocation({ type: 'status' });
}

// 「現在地点は中央に表示」トグル。ON にした直後は、直近の位置が新しければ(isLastFixFresh)
// 即座に現在地を中央へ寄せる。地図を動かす条件は shouldFollowMap。
export function setFollowCurrentLocation(on) {
  followCurrentLocation = on;
  if (on) {
    recenterWithoutAnimation = true;
    if (shouldFollowMap() && isLastFixFresh()) moveMapToCurrentLocation(lastKnownLatLng);
  }
  refreshLocationWatch();
}
