// Leaflet 地図モジュール
// - 地図の初期化と共有インスタンスの提供(getMap)
// - 地図の右下のボタン類(ズームレベル表示・現在地点表示ボタン)
// - 利用者による地図の操作の検知(現在地への追従を一時的に止めるため)
// 地図に重ねる表示は map-overlays.js、マーカーの図形は marker-icons.js、
// 1本指ズームは one-finger-zoom.js が担う。
// leaflet-src.esm.js は名前空間exportのため `* as L` で受ける(default exportではない)
import * as L from 'leaflet';
import { t } from '../common/i18n.js';
import { enableOneFingerZoom } from './one-finger-zoom.js';

const GSI_TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png';
const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';

// 起動時の中心は箕面ビジターセンター、z=15(ホーム/マップビュー共通の単一マップ)
const INITIAL_CENTER = [34.85839, 135.4788];

const INITIAL_ZOOM = 15;
const MIN_ZOOM = 10;
const MAX_ZOOM = 18;

// GPX / KMZ の読み込み直後に地図を合わせるときのズームレベルの範囲と、周囲に残す余白[px]。
// 範囲の外へは行かないため、z=14 に収まらない広いデータは中心付近だけが表示される
const FIT_MIN_ZOOM = 14;
const FIT_MAX_ZOOM = 17;
const FIT_PADDING = 30;

// 線(ハイキングルート等)をタップしたと判定する余裕[px]。
// SVG で描くとブラウザが「線の太さちょうど」で当たり判定するため、既定の太さ3px では
// 中心から±1.5px に当てないと反応せず、指(直径およそ34px)ではまず当たらない。
// Canvas レンダラは weight/2 + tolerance で判定するので、見た目の太さは変えずに
// 判定だけ広げられる。12 で当たり幅はおよそ 28px(実測)。
// 大きくしすぎると、近くを走る別のルートを拾ってしまうため 12 としている。
// ルートを押したときに近くのポイントを優先する判定(map-overlays.js)にも同じ余裕を使う。
export const TAP_TOLERANCE = 12;

let mapInstance = null;

export function initMap(containerId) {
  const map = L.map(containerId, {
    center: INITIAL_CENTER,
    zoom: INITIAL_ZOOM,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    zoomControl: false,
    attributionControl: false,
    // ダブルタップでの拡大は使わない。記録中は画面が消えないため、ポケットの中で布越しに触れて
    // 拡大してしまう(縮小の操作は無いので z=18 まで上がる一方)。iPhone ではもともと動かない
    doubleClickZoom: false,
    // 線をタップしやすくするため、ベクタ図形は Canvas で描く(→ TAP_TOLERANCE)。
    // マーカー(divIcon)はこの指定の対象外で、markerPane の DOM 要素のまま
    renderer: L.canvas({ tolerance: TAP_TOLERANCE })
  });
  // 1本指ズーム(ダブルタップしてそのまま上下に滑らせる)。ダブルタップだけでは拡大しない
  enableOneFingerZoom(map);
  // 利用者が地図を操作した時刻を覚える(操作の直後は現在地へ引き戻さないため。geolocation.js)
  watchUserInteraction(map);

  L.tileLayer(GSI_TILE_URL, {
    attribution: GSI_ATTRIBUTION,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    crossOrigin: true
  }).addTo(map);

  // 右下に下から: 国土地理院クレジット → 縮尺 → ズームレベル → ズーム(＋/−) → 現在地点表示ボタン。
  // bottomright は後から追加したものほど上に積まれるため、下から順に追加する。
  L.control.attribution({ position: 'bottomright' }).addTo(map);
  L.control.scale({ position: 'bottomright', metric: true, imperial: false, maxWidth: 150 }).addTo(map);
  new ZoomDisplayControl({ position: 'bottomright' }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  new CurrentMarkerControl({ position: 'bottomright' }).addTo(map);

  mapInstance = map;
  return map;
}

// 共有の地図インスタンスを返す(未初期化なら null)
export function getMap() {
  return mapInstance;
}

// 指定した地点([lat, lng] または LatLng)と範囲(LatLngBounds)の全体が収まるよう地図を合わせる
// (移動経路・写真の読み込み直後に使う)。地点も範囲も無ければ何もしない。
// 1地点だけ(写真1枚だけを読み込んだ等)のときは、寄りすぎないよう今の縮尺で中央に置く。
// どちらの場合もズームレベルは FIT_MIN_ZOOM〜FIT_MAX_ZOOM に収める
// (fitBounds には下限の指定が無いため、ズームレベルを求めて setView で合わせる)
export function fitMapToLatLngs(latlngs = [], bounds = L.latLngBounds([])) {
  if (!mapInstance) return;
  const all = L.latLngBounds([]).extend(bounds);
  for (const ll of latlngs) all.extend(ll);
  if (!all.isValid()) return;
  const isSinglePoint = all.getNorthEast().equals(all.getSouthWest());
  // getBoundsZoom の padding は左右・上下の合計を渡す
  const zoom = isSinglePoint
    ? mapInstance.getZoom()
    : mapInstance.getBoundsZoom(all, false, [FIT_PADDING * 2, FIT_PADDING * 2]);
  mapInstance.setView(all.getCenter(), Math.min(Math.max(zoom, FIT_MIN_ZOOM), FIT_MAX_ZOOM));
}

// ===== 利用者による地図の操作 =====
// 地図(ズームボタン等の地図上のボタンも含む)に触れた・ホイールを回した時刻を覚える。
// 「現在地点は中央に表示」は、操作を終えてから一定時間(FOLLOW_RESUME_IDLE_SEC)は現在地へ
// 寄せない(geolocation.js)。触れている間はずっと操作中とみなす。
// 指の動きは pointer イベントで見る(Leaflet は touch イベントで動かすが、pointer イベントも並んで届く)。
let lastUserInteractionMs = 0;
const activePointers = new Set();
let onUserInteractionEnd = null;
// 指を離した知らせを取りこぼしたとき(触れたままアプリを切り替えた等)に、操作中のまま
// 追従が止まり続けないよう、この時間[ms]動きが無ければ触れている指は無いものとみなす
const STALE_POINTER_MS = 60 * 1000;

// 最後に地図を操作してからの経過時間[ms]。触れている間は 0
export function msSinceMapInteraction() {
  const elapsed = Date.now() - lastUserInteractionMs;
  if (activePointers.size > 0 && elapsed < STALE_POINTER_MS) return 0;
  return elapsed;
}

// 地図の操作を終えたとき(指をすべて離した・ホイールを回した)に呼ぶ処理を登録する(geolocation.js から)
export function setOnMapInteractionEnd(fn) {
  onUserInteractionEnd = fn;
}

function watchUserInteraction(map) {
  const container = map.getContainer();
  const mark = () => { lastUserInteractionMs = Date.now(); };
  const opts = { capture: true, passive: true };
  container.addEventListener('pointerdown', (e) => {
    activePointers.add(e.pointerId);
    mark();
  }, opts);
  container.addEventListener('pointermove', (e) => {
    if (activePointers.has(e.pointerId)) mark();
  }, opts);
  // 指・マウスを地図の外で離すこともあるため、離したことは window で受ける
  const release = (e) => {
    if (!activePointers.delete(e.pointerId)) return;
    mark();
    if (activePointers.size === 0) onUserInteractionEnd?.();
  };
  window.addEventListener('pointerup', release, opts);
  window.addEventListener('pointercancel', release, opts);
  container.addEventListener('wheel', () => {
    mark();
    onUserInteractionEnd?.();
  }, opts);
  // 画面が隠れたら、触れている指の記録を捨てる(離した知らせが来ないことがあるため)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') activePointers.clear();
  });
}

// ===== 現在のズームレベル表示(ズームボタンの下) =====
let zoomDisplayEl = null;

const ZoomDisplayControl = L.Control.extend({
  onAdd(map) {
    const div = L.DomUtil.create('div', 'zoom-display');
    const update = () => { div.textContent = `z=${map.getZoom()}`; };
    update();
    map.on('zoomend', update);
    zoomDisplayEl = div;
    return div;
  }
});

// ズームレベル表示の ON/OFF(表示設定パネルの「ズームレベルを表示」から呼ぶ)
export function setZoomDisplayVisible(on) {
  if (zoomDisplayEl) zoomDisplayEl.hidden = !on;
}

// ===== 現在地点表示ボタン(ズームボタンの上) =====
// このモジュールはボタンの見た目だけを持ち、表示そのものは geolocation.js の
// showCurrentLocationSpot が行う(押されたら handler を呼び、終わったら
// setCurrentMarkerButtonState(false) で灰色へ戻してもらう)。
let currentMarkerButtonEl = null;
let currentMarkerButtonHandler = null;

// 現在地アイコン(中心の点と十字。Material Design の my_location 相当)
const CURRENT_MARKER_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
  <path fill="currentColor" d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/>
</svg>`;

const CurrentMarkerControl = L.Control.extend({
  onAdd() {
    const div = L.DomUtil.create('div', 'leaflet-bar current-marker-toggle');
    const link = L.DomUtil.create('a', '', div);
    link.href = '#';
    link.setAttribute('role', 'button');
    link.innerHTML = CURRENT_MARKER_ICON;
    // 地図のドラッグ・クリックに拾われないようにする
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.on(link, 'click', (ev) => {
      L.DomEvent.stop(ev);
      currentMarkerButtonHandler?.();
    });
    currentMarkerButtonEl = div;
    return div;
  }
});

// ボタンが押されたときに呼ぶ処理を登録する(app.js から)
export function setCurrentMarkerButtonHandler(fn) {
  currentMarkerButtonHandler = fn;
}

// ボタンの見た目を現在の状態に合わせる。
// ON(表示中の3秒間)は現在地マーカーと同じ青、OFF は灰色。
export function setCurrentMarkerButtonState(on) {
  if (!currentMarkerButtonEl) return;
  currentMarkerButtonEl.classList.toggle('is-on', !!on);
  const link = currentMarkerButtonEl.querySelector('a');
  if (!link) return;
  const label = t('map.showCurrentSpot');
  link.title = label;
  link.setAttribute('aria-label', label);
  link.setAttribute('aria-pressed', on ? 'true' : 'false');
}

// ===== 地図の大きさ =====
// ビュー表示直後に呼んでサイズを再計算する(hidden→visible 切替で必須)
export function resizeMap() {
  if (mapInstance) mapInstance.invalidateSize();
}

// Leaflet が覚えている地図の大きさが、実際のコンテナの大きさとずれていないか確かめ、
// ずれていたら測り直す。ずれたぶんだけ戻り値が true になる。
//
// Leaflet は window の resize でしか大きさを測り直さないが、iOS では回転直後の
// resize の時点でまだ回転前の大きさが返ることがあり、そのとき覚え違いが確定して
// しまう。以降 setView/panTo が「画面の中央」と思う座標は実際の中央からずれ、
// 現在地へ寄せても画面の外に置かれる(縦画面なのに横画面の幅で中央を計算する状態)。
// resize は二度と来ないため、その後の位置更新を何回繰り返しても直らない。
// invalidateSize は中央の緯度経度を保ったまま measure し直すので、呼んでも表示位置は動かない。
export function ensureMapSize() {
  if (!mapInstance) return false;
  const el = mapInstance.getContainer();
  const size = mapInstance.getSize();
  if (size.x === el.clientWidth && size.y === el.clientHeight) return false;
  mapInstance.invalidateSize({ animate: false });
  return true;
}
