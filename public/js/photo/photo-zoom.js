// 写真の拡大表示モジュール(写真の表示から開く全画面の表示)
// 写真の表示(#photoViewModal)の画像か、その右下の拡大ボタンを押すと、写真を画面いっぱいに出し、
// 指で拡大・縮小・移動できるようにする。ページ自体の拡大は止めている(page-guard.js の guardPageViewport)
// ため、写真だけをこの画面の中で拡大する(ページを拡大すると閉じたあとも拡大が残り、
// マップ画面の上部ボタンが画面の外へ出て押せなくなる)。
// - 2本指で広げる・狭める: 拡大・縮小(1〜PHOTO_ZOOM_MAX 倍)。指の間の地点を中心にする
// - 拡大中に1本指で動かす: 写真を動かす(写真の端が画面の内側へ入り込まないところまで)
// - ダブルタップ: 等倍なら PHOTO_ZOOM_DOUBLE_TAP 倍に拡大(押した地点を中心に)、拡大中なら等倍に戻す
// - パソコンではマウスのホイールで拡大・縮小、ドラッグで移動、ダブルクリックで拡大/等倍
// - × または Esc で閉じる(写真の表示に戻る)
// 画像は写真の表示と同じ URL を使う。URL の解放は photo-view.js(releasePhotoView)が行う。

// 拡大の上限(画面に収めた大きさに対する倍率)。写真は長辺 1600px(PHOTO_MAX_EDGE_PX)で保存しており、
// スマホの画面幅(350px 前後)に収めた大きさのおよそ4倍で元の画素に届く。それ以上はぼやけるだけ
const PHOTO_ZOOM_MAX = 4;
// ダブルタップで拡大するときの倍率
const PHOTO_ZOOM_DOUBLE_TAP = 2.5;
// タップとみなす上限: 触れていた時間[ms]と指のずれ[px]。ダブルタップとみなす間隔[ms]と2回の位置の離れ[px]
const TAP_MAX_MS = 300;
const TAP_SLOP = 10;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 30;

const el = {
  overlay: document.getElementById('photoZoomOverlay'),
  stage: document.getElementById('photoZoomStage'),
  image: document.getElementById('photoZoomImage'),
  btnClose: document.getElementById('btnPhotoZoomClose')
};

// 表示の状態: 画面に収めたときの画像の大きさ(fitW × fitH)、倍率(scale)、中央からのずらし(tx, ty)
const view = { fitW: 0, fitH: 0, scale: 1, tx: 0, ty: 0 };
// 触れている指(pointerId → 位置)と、いま行っている操作(ピンチ・移動)
const pointers = new Map();
let gesture = null;
// タップの判定: 触れた指(1本のとき)と、直前のタップ
let tapCandidate = null;
let lastTap = null;

function isPhotoZoomOpen() {
  return !!el.overlay && !el.overlay.hidden;
}

// 拡大表示を開く。src は表示する画像の URL、alt は写真の名前
export function openPhotoZoom(src, alt = '') {
  if (!el.overlay || !src) return;
  resetInput();
  view.scale = 1;
  view.tx = 0;
  view.ty = 0;
  el.image.alt = alt;
  el.image.onload = layout;
  el.image.src = src;
  el.overlay.hidden = false;
  // 同じ URL で読み込み済みのときは load が来ないことがあるため、その場で並べる
  if (el.image.complete && el.image.naturalWidth) layout();
}

export function closePhotoZoom() {
  if (!el.overlay) return;
  resetInput();
  el.overlay.hidden = true;
  el.image.onload = null;
  el.image.removeAttribute('src');
}

function resetInput() {
  pointers.clear();
  gesture = null;
  tapCandidate = null;
  lastTap = null;
}

// 画面(表示枠)の中心。指の位置と同じく画面の座標で表す
function stageCenter() {
  const r = el.stage.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
}

// 画像を表示枠に収まる大きさにし(開いたとき・画面の向きが変わったとき)、今の倍率のまま描き直す
function layout() {
  if (!isPhotoZoomOpen()) return;
  const { naturalWidth: w, naturalHeight: h } = el.image;
  if (!w || !h) return;
  const { w: stageW, h: stageH } = stageCenter();
  const fit = Math.min(stageW / w, stageH / h);
  view.fitW = w * fit;
  view.fitH = h * fit;
  el.image.style.width = `${view.fitW}px`;
  el.image.style.height = `${view.fitH}px`;
  render();
}

// ずらしを、画像の端が表示枠の内側へ入り込まない範囲に収める(枠より小さい向きは中央に置く)
function clampOffset() {
  const { w, h } = stageCenter();
  const maxX = Math.max(0, (view.fitW * view.scale - w) / 2);
  const maxY = Math.max(0, (view.fitH * view.scale - h) / 2);
  view.tx = Math.min(maxX, Math.max(-maxX, view.tx));
  view.ty = Math.min(maxY, Math.max(-maxY, view.ty));
}

function render() {
  clampOffset();
  el.image.style.transform =
    `translate(-50%, -50%) translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
}

// 倍率を scale に変え、画面上の地点(point)にある写真の場所がその地点に留まるようにずらす。
// 画像の中心は「枠の中心 + ずらし」にあり、写真の各点は中心から倍率に比例して離れて描かれる
function zoomAround(scale, point) {
  const c = stageCenter();
  const s = Math.min(PHOTO_ZOOM_MAX, Math.max(1, scale));
  const ratio = s / view.scale;
  view.scale = s;
  view.tx = point.x - c.x - ratio * (point.x - c.x - view.tx);
  view.ty = point.y - c.y - ratio * (point.y - c.y - view.ty);
  render();
}

// 指の本数に合わせて操作を始め直す(2本目が触れた・1本離れたときに、跳ねずに続けられるように)
function beginGesture() {
  const pts = [...pointers.values()];
  const from = { scale: view.scale, tx: view.tx, ty: view.ty };
  if (pts.length >= 2) {
    const [a, b] = pts;
    gesture = {
      type: 'pinch',
      from,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1
    };
  } else if (pts.length === 1) {
    gesture = { type: 'pan', from, start: { ...pts[0] } };
  } else {
    gesture = null;
  }
}

function applyGesture() {
  const pts = [...pointers.values()];
  if (!gesture) return;
  if (gesture.type === 'pinch' && pts.length >= 2) {
    const [a, b] = pts;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const scale = gesture.from.scale * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.dist);
    // 始めたときの指の間の地点を、今の指の間の地点へ持ってくる(拡大しながら動かせる)
    const c = stageCenter();
    const s = Math.min(PHOTO_ZOOM_MAX, Math.max(1, scale));
    const ratio = s / gesture.from.scale;
    view.scale = s;
    view.tx = mid.x - c.x - ratio * (gesture.mid.x - c.x - gesture.from.tx);
    view.ty = mid.y - c.y - ratio * (gesture.mid.y - c.y - gesture.from.ty);
    render();
  } else if (gesture.type === 'pan' && pts.length === 1) {
    if (view.scale <= 1) return;
    view.tx = gesture.from.tx + (pts[0].x - gesture.start.x);
    view.ty = gesture.from.ty + (pts[0].y - gesture.start.y);
    render();
  }
}

// ダブルタップ(ダブルクリック): 等倍なら押した地点を中心に拡大、拡大中なら等倍に戻す
function onTap(point) {
  const now = Date.now();
  if (lastTap && now - lastTap.time <= DOUBLE_TAP_MS &&
      Math.hypot(point.x - lastTap.x, point.y - lastTap.y) <= DOUBLE_TAP_SLOP) {
    lastTap = null;
    setAnimated(true);
    if (view.scale > 1.01) zoomAround(1, point);
    else zoomAround(PHOTO_ZOOM_DOUBLE_TAP, point);
    return;
  }
  lastTap = { x: point.x, y: point.y, time: now };
}

// ダブルタップのときだけ、拡大・等倍への切り替えを滑らかに見せる(指の操作中は指に付いてくるよう切る)
function setAnimated(on) {
  el.image.classList.toggle('is-animating', on);
}

function onPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  el.stage.setPointerCapture?.(e.pointerId);
  setAnimated(false);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  tapCandidate = pointers.size === 1
    ? { id: e.pointerId, x: e.clientX, y: e.clientY, time: Date.now() }
    : null;
  if (pointers.size > 1) lastTap = null;
  beginGesture();
}

function onPointerMove(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (tapCandidate && Math.hypot(e.clientX - tapCandidate.x, e.clientY - tapCandidate.y) > TAP_SLOP) {
    tapCandidate = null;
    lastTap = null;
  }
  applyGesture();
}

function onPointerUp(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  const tap = tapCandidate;
  tapCandidate = null;
  if (e.type === 'pointerup' && tap && tap.id === e.pointerId && Date.now() - tap.time <= TAP_MAX_MS) {
    onTap({ x: e.clientX, y: e.clientY });
  }
  beginGesture();
}

// パソコンのホイール: カーソルの地点を中心に拡大・縮小する
function onWheel(e) {
  e.preventDefault();
  setAnimated(false);
  zoomAround(view.scale * Math.exp(-e.deltaY * 0.0015), { x: e.clientX, y: e.clientY });
}

if (el.overlay) {
  el.stage.addEventListener('pointerdown', onPointerDown);
  el.stage.addEventListener('pointermove', onPointerMove);
  el.stage.addEventListener('pointerup', onPointerUp);
  el.stage.addEventListener('pointercancel', onPointerUp);
  el.stage.addEventListener('wheel', onWheel, { passive: false });
  el.btnClose.addEventListener('click', closePhotoZoom);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isPhotoZoomOpen()) closePhotoZoom();
  });
  // 画面の向きが変わったら、収まる大きさを測り直す(倍率はそのまま)
  window.addEventListener('resize', layout);
}
