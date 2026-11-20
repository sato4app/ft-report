// 1本指ズーム(ダブルタップしてそのまま上下に滑らせる)
// Googleマップと同じ操作: 1回タップしてすぐにもう一度触れ、指を離さずに下へ滑らせると拡大、
// 上へ滑らせると縮小。1本指で滑らせる操作は地図の移動に使っているため、直前にタップがあった
// ときだけこの操作とみなす。滑らせずに離したとき(ただのダブルタップ)は何もしない。
// 記録中も使える(記録中だけ止めることはしない)。
// 拡大縮小の中心は、触れた地点。ただし現在地に追従しているあいだ(setOneFingerZoomAroundCenter)は
// 現在地のある画面中央とし、ズームのあとに地図が現在地へ引き戻されて跳ねないようにする。
// 途中の表示と、指を離したときに整数のズームレベルへそろえる処理は、Leaflet のピンチズーム
// (TouchZoom)と同じ内部処理(_move / _animateZoom など)を使う。Leaflet 1.9.4 の内部実装に
// 依存するため、Leaflet の版を変えたときはこの操作を確かめ直すこと。
import * as L from 'leaflet';

// 1回目のタップとみなす上限: 触れていた時間[ms]と、触れてから離すまでの指のずれ[px]
const ONE_FINGER_ZOOM_TAP_MAX_MS = 300;
const ONE_FINGER_ZOOM_TAP_SLOP = 10;
// 1回目を離してから2回目に触れるまでの上限[ms]と、1回目と2回目の位置の離れの上限[px]
const ONE_FINGER_ZOOM_DOUBLE_TAP_MS = 300;
const ONE_FINGER_ZOOM_DOUBLE_TAP_SLOP = 50;
// 2回目に触れてから上下にこれだけ動いたら拡大縮小を始める[px](ダブルタップ時の指のぶれでは動かさない)
const ONE_FINGER_ZOOM_START_SLOP = 8;
// 上下に何px滑らせるとズームレベルが1つ変わるか
const ONE_FINGER_ZOOM_PX_PER_LEVEL = 100;

let oneFingerZooming = false;
let oneFingerZoomAroundCenter = () => false;

// 1本指ズームで拡大縮小している最中か(現在地への追従を止めるために geolocation.js が見る)
export function isOneFingerZooming() {
  return oneFingerZooming;
}

// 画面中央を中心に拡大縮小するかを返す関数を登録する(geolocation.js から。現在地に追従中なら true)
export function setOneFingerZoomAroundCenter(fn) {
  oneFingerZoomAroundCenter = fn;
}

// 地図に1本指ズームを付ける(map.js の initMap から1回呼ぶ)
export function enableOneFingerZoom(map) {
  const container = map.getContainer();
  let tapStart = null;   // 1回目のタップの候補 { point, time }
  let lastTap = null;    // 直前のタップ { point, time(指を離した時刻) }
  let gesture = null;    // 2回目に触れてから離すまでの状態
  let frame = 0;

  const clientPoint = (touch) => L.point(touch.clientX, touch.clientY);
  const findTouch = (list, id) => Array.from(list).find((touch) => touch.identifier === id);
  // ズーム(＋/−)などのボタンやポップアップの上では扱わない(ボタンの連打を拡大縮小にしない)
  const isOnControl = (target) => !!target?.closest?.('.leaflet-control, .leaflet-popup');

  // 指の上下の移動を拡大縮小に変える。中心(anchorLatLng)が画面上の同じ位置に留まるよう地図の中心を決める
  function zoomTo(zoom) {
    const g = gesture;
    g.zoom = Math.min(Math.max(zoom, map.getMinZoom()), map.getMaxZoom());
    g.center = map.unproject(map.project(g.anchorLatLng, g.zoom).subtract(g.anchorOffset), g.zoom);
    cancelAnimationFrame(frame);
    const { center, zoom: z } = g;
    frame = requestAnimationFrame(() => map._move(center, z, { pinch: true, round: false }));
  }

  function startZooming() {
    const g = gesture;
    map._stop();
    const centerPoint = map.getSize().divideBy(2);
    const anchorPoint = oneFingerZoomAroundCenter() ? centerPoint : g.containerPoint;
    g.anchorLatLng = map.containerPointToLatLng(anchorPoint);
    g.anchorOffset = anchorPoint.subtract(centerPoint);
    g.zoom = map.getZoom();
    g.zooming = true;
    oneFingerZooming = true;
    map._moveStart(true, false);
  }

  // 2回目のタッチを終える。拡大縮小していたら整数のズームレベルへそろえて true を返す
  function finish() {
    const g = gesture;
    if (!g) return false;
    gesture = null;
    oneFingerZooming = false;
    if (g.dragWasEnabled) map.dragging.enable();
    L.DomUtil.enableTextSelection();
    L.DomUtil.enableImageDrag();
    if (!g.zooming) return false;
    cancelAnimationFrame(frame);
    const zoom = map._limitZoom(g.zoom);
    const center = map.unproject(map.project(g.anchorLatLng, zoom).subtract(g.anchorOffset), zoom);
    if (map.options.zoomAnimation) map._animateZoom(center, zoom, true, map.options.zoomSnap);
    else map._resetView(center, zoom);
    return true;
  }

  // Leaflet の地図移動(ドラッグ)より先に受け取るため、すべて capture で受ける
  container.addEventListener('touchstart', (e) => {
    // 拡大縮小の途中で2本目の指が触れたら、ここで終えてピンチに任せる
    if (gesture) { finish(); return; }
    if (e.touches.length !== 1 || isOnControl(e.target)) { tapStart = null; lastTap = null; return; }
    const touch = e.touches[0];
    const point = clientPoint(touch);
    const now = Date.now();
    if (lastTap && now - lastTap.time <= ONE_FINGER_ZOOM_DOUBLE_TAP_MS &&
        point.distanceTo(lastTap.point) <= ONE_FINGER_ZOOM_DOUBLE_TAP_SLOP && !map._animatingZoom) {
      // 2回目のタッチ: 離すまで地図の移動を止め、上下の移動を拡大縮小に使う。
      // 指を動かさずに離したときは何もせず、クリック(タップ)はそのまま届く
      tapStart = null;
      lastTap = null;
      gesture = {
        id: touch.identifier,
        startY: point.y,
        lastY: point.y,
        containerPoint: map.mouseEventToContainerPoint(touch),
        dragWasEnabled: map.dragging.enabled(),
        zooming: false
      };
      if (gesture.dragWasEnabled) map.dragging.disable();
      // 地図の移動(Leaflet の Draggable)は触れている間の文字選択・画像のドラッグを止めているが、
      // ここではその移動を止めたため、同じ抑止を自分でかける(指を離すまで)。
      // 2回目に触れたまま止めると長押しとみなされ、文字が選択されてコピー・翻訳のメニューが出るため
      L.DomUtil.disableTextSelection();
      L.DomUtil.disableImageDrag();
      return;
    }
    lastTap = null;
    tapStart = { point, time: now };
  }, { capture: true, passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!gesture) return;
    const touch = findTouch(e.touches, gesture.id);
    if (!touch) return;
    e.preventDefault();
    const y = touch.clientY;
    if (!gesture.zooming) {
      if (Math.abs(y - gesture.startY) < ONE_FINGER_ZOOM_START_SLOP) return;
      startZooming();
    }
    // 下へ滑らせると拡大、上で縮小(Googleマップと同じ向き)
    const zoom = gesture.zoom + (y - gesture.lastY) / ONE_FINGER_ZOOM_PX_PER_LEVEL;
    gesture.lastY = y;
    zoomTo(zoom);
  }, { capture: true, passive: false });

  container.addEventListener('touchend', (e) => {
    if (gesture) {
      if (!findTouch(e.changedTouches, gesture.id)) return;
      // 拡大縮小したときは、指を離したときのクリック(地図のタップ扱い)を出さない
      if (finish() && e.cancelable) e.preventDefault();
      return;
    }
    const start = tapStart;
    tapStart = null;
    if (!start || e.touches.length !== 0 || e.changedTouches.length !== 1) return;
    const point = clientPoint(e.changedTouches[0]);
    const now = Date.now();
    if (now - start.time <= ONE_FINGER_ZOOM_TAP_MAX_MS && point.distanceTo(start.point) <= ONE_FINGER_ZOOM_TAP_SLOP) {
      lastTap = { point, time: now };
    }
  }, { capture: true, passive: false });

  container.addEventListener('touchcancel', () => {
    tapStart = null;
    lastTap = null;
    finish();
  }, { capture: true });

  // 2回目に触れたまま止めたときの長押しメニュー(画像の保存など)も出さない
  container.addEventListener('contextmenu', (e) => {
    if (gesture) e.preventDefault();
  }, { capture: true });
}
