// 場所を検索(写真の撮影地点への案内)。仕様は docs/funcspec-202611.md の 4.12。
// アプリの中の写真の一覧をハイキングマップ画面に出し、選んだ写真の撮影地点まで、
// 現在地からの矢印と方角・距離で案内する。地図画面に次のものを重ねて出す。
// - 写真の一覧(左上)。写真を押すと案内を始め、一覧はたたんでバーにする(バーを押すと広げる)
// - 撮影地点の番号の印(一覧に載っている写真のカメラの印は、photos.js の setHiddenPhotoMarkers で外す)
// - 現在地から撮影地点への矢印と、方角・距離(バーのすぐ下)。約 30m 以内に入ったら「近くに着きました」と知らせる
// 入口は表示設定パネル(≡)の「場所を検索」トグルで、ON のとき上部に出す虫眼鏡のボタン(#btnExplore)。
// openExplore() は、どの画面から呼んでも地図画面に切り替えてから開く(ft-report は起動時画面のボタンから呼ぶ)。
// 更新版の確認は openExplore() の中ではしない(呼ぶ側のボタンが行う)。
// 現在地は geolocation.js の監視を受け取る(ここでは監視しない。addLocationListener)。
// 何も保存しない(案内の相手も覚えない)。写真は変えない・消さない。
import * as L from 'leaflet';
import { getMap } from '../map/map.js';
import {
  addLocationListener, getFreshLatLng, isCurrentMarkerVisible, isLocationUnavailable
} from '../map/geolocation.js';
import { closeLayerPanel } from '../map/layer-panel.js';
import {
  getPhotos, getPhoto, getPhotoThumbUrl, setHiddenPhotoMarkers, addPhotosRemovedListener
} from './photos.js';
import { t } from '../common/i18n.js';
import { showToast } from '../common/messages.js';
import { on } from '../common/ui.js';
import { bearingDegrees, circledNumber } from '../common/utils.js';

// 近くに着いたと知らせる距離(m)。GPS の誤差(数 m〜十数 m)があるため目安
const ARRIVE_METERS = 30;
// 写真が無いときの知らせを出しておく秒数(文が長いため、ふだんのトーストより長く)
const NO_PHOTOS_TOAST_SEC = 5;
// 矢印の線の重なり順(地図の線(overlayPane 400)より上、マーカー(markerPane 600)より下)
const ARROW_PANE = 'explorePane';
const ARROW_PANE_Z = 450;
// 番号の印の重なり順(ほかのマーカーより上。案内している写真の印はさらに上)。
// 現在地の青丸(-100000。geolocation.js)は、これらの下になる
const MARKER_Z = 500;
const TARGET_MARKER_Z = 1000;
// 矢じり(SVG の marker)の大きさと、撮影地点まで見えているときに矢じりの先を置く手前の距離(px。
// 番号の印に隠れないように)。id は撮影地点まで見えているとき・画面の端で切れたときの 2 種類
const ARROW_HEAD_LEN = 20;
const ARROW_HEAD_GAP = 18;
const ARROW_HEAD_ID = 'exploreArrowHead';
const ARROW_HEAD_EDGE_ID = 'exploreArrowHeadEdge';
// 8 方位の i18n キーの末尾(北から時計回り)
const DIRECTION_KEYS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const el = {
  // 表示設定パネルの「場所を検索」と、ON のとき上部に出す虫眼鏡のボタン
  toggle: document.getElementById('toggleExplore'),
  button: document.getElementById('btnExplore'),
  // 写真の一覧(広げた状態)
  panel: document.getElementById('explorePanel'),
  list: document.getElementById('exploreList'),
  empty: document.getElementById('exploreEmpty'),
  btnClose: document.getElementById('btnExploreClose'),
  // たたんだ一覧(バー)と、そのすぐ下の方角と距離
  stack: document.getElementById('exploreStack'),
  bar: document.getElementById('exploreBar'),
  info: document.getElementById('exploreInfo'),
  infoText: document.getElementById('exploreInfoText')
};

let hooks = null;          // app.js から受け取る画面の切替(bindExploreEvents)
let mapViewShown = false;  // ハイキングマップ画面を表示しているか(applyExploreControlsForView)
let ex = null;             // 場所を検索の状態(開いていないときは null)

// ===== イベントの登録(app.js の bindEvents から1回呼ぶ) =====
// showMapView はハイキングマップ画面へ切り替える関数(app.js の showView('map'))。
// app.js を import すると相互参照になるため、関数で受け取る(guide.js と同じ)
export function bindExploreEvents({ showMapView }) {
  hooks = { showMapView };
  // 場所を検索: ON で虫眼鏡のボタンを出す。OFF にしたら、開いていれば閉じる
  on(el.toggle, 'change', (e) => {
    if (!e.target.checked) closeExplore();
    updateExploreButton();
  });
  // 虫眼鏡のボタン: 押すたびに開く・閉じる(閉じるのは × と同じ)
  on(el.button, 'click', () => {
    if (ex) closeExplore();
    else openExplore();
  });
  on(el.btnClose, 'click', closeExplore);
  on(el.bar, 'click', () => setCollapsed(false));
  on(el.list, 'click', (ev) => {
    const row = ev.target.closest('.explore-row');
    if (row) selectTarget(row.dataset.id);
  });
  // 現在地と写真の増減は、開いている間だけ使う(閉じているときは受け手の中で何もしない)
  addLocationListener(onLocationEvent);
  addPhotosRemovedListener(onPhotosRemoved);
}

// 画面に合わせて虫眼鏡のボタンを出し分ける(app.js の showView から)。
// ハイキングマップ表示では「場所を検索」トグルに従い、起動時画面では隠す。
// ハイキングマップ画面を離れたら、場所を検索を終える(× と同じ)
export function applyExploreControlsForView(isMapView) {
  mapViewShown = isMapView;
  if (!isMapView) closeExplore();
  updateExploreButton();
}

// 虫眼鏡のボタン: 「場所を検索」ON のときだけ出す。開いている間は押した状態にする
function updateExploreButton() {
  if (!el.button) return;
  el.button.hidden = !(mapViewShown && el.toggle?.checked);
  el.button.classList.toggle('is-active', !!ex);
  el.button.setAttribute('aria-pressed', String(!!ex));
}

// ===== 開く・閉じる =====
// 場所を検索を開く。起動時画面から呼んでも、ハイキングマップ画面に切り替えてから開く。
// 写真が無いときは、画面を切り替えずに知らせる。開いていれば、閉じてから開き直す(番号を付け直す)。
// 開けたら true を返す。更新版の確認はしない(起動時画面のボタンから呼ぶときは、ボタンの側で行う)
export function openExplore() {
  const photos = getPhotos();
  if (photos.length === 0) {
    showToast(t('explore.noPhotos'), { durationSec: NO_PHOTOS_TOAST_SEC });
    return false;
  }
  const map = getMap();
  if (!map || !hooks || !el.panel) return false;
  if (ex) closeExplore();
  if (!mapViewShown) hooks.showMapView();
  if (!mapViewShown) return false;
  // 一覧が見えるよう、表示設定パネル(≡)は閉じる
  closeLayerPanel();

  ex = {
    map,
    items: [],              // 一覧の写真(番号の順)。{ id, no, name, lat, lng, timed, marker }
    targetId: null,         // 案内している写真
    arrived: false,         // 案内している写真について「近くに着きました」を知らせたか
    collapsed: false,
    fix: currentFix(),      // 現在地 [lat, lng](分からないときは null)
    reorderPending: false,  // 撮影日時の無い写真を、初めて現在地が分かったときに並べ直すか
    arrow: null,            // 矢印 { renderer, casing, line, to }
    arrowDefs: null,        // 矢じりの SVG(defs)
    thumbObserver: null
  };

  buildItems(photos);
  addNumberMarkers();
  setHiddenPhotoMarkers(ex.items.map((it) => it.id));
  startThumbObserver();
  setCollapsed(false);
  renderGuide();
  updateExploreButton();
  return true;
}

// 場所を検索を終える。一覧(バー)・番号の印・矢印・方角と距離を消し、外していたカメラの印を戻す
export function closeExplore() {
  if (!ex) return;
  const { map } = ex;
  ex.thumbObserver?.disconnect();
  for (const item of ex.items) if (item.marker) map.removeLayer(item.marker);
  removeArrow();
  ex.arrowDefs?.remove();
  setHiddenPhotoMarkers(null);
  el.panel.hidden = true;
  el.stack.hidden = true;
  el.list.textContent = '';
  ex = null;
  updateExploreButton();
}

// 場所を検索を開いているか
export function isExploreOpen() {
  return !!ex;
}

// ===== 一覧の写真と番号 =====
// 撮影日時のある写真を撮影順に並べ、その後に撮影日時の無い写真を現在地から近い順に並べる。
// 現在地がまだ分からないときは読み込んだ順にし、初めて分かったときに一度だけ並べ直す
function buildItems(photos) {
  const timed = photos.filter((p) => Number.isFinite(p.timeMs)).sort((a, b) => a.timeMs - b.timeMs);
  const untimed = photos.filter((p) => !Number.isFinite(p.timeMs));
  if (ex.fix) sortByDistance(untimed);
  else ex.reorderPending = untimed.length >= 2;
  ex.items = [...timed, ...untimed].map((p, i) => ({
    id: p.id, no: i + 1, name: p.name || '', lat: p.lat, lng: p.lng,
    timed: Number.isFinite(p.timeMs), marker: null
  }));
}

function metersFromFix(item) {
  return L.latLng(ex.fix).distanceTo([item.lat, item.lng]);
}

function sortByDistance(list) {
  list.sort((a, b) => metersFromFix(a) - metersFromFix(b));
}

// 初めて現在地が分かったとき: 撮影日時の無い写真を近い順に並べ直す(番号は、それらに付いていた番号を付け直す)
function reorderUntimed() {
  ex.reorderPending = false;
  const untimed = ex.items.filter((it) => !it.timed);
  if (untimed.length < 2) return;
  const numbers = untimed.map((it) => it.no).sort((a, b) => a - b);
  sortByDistance(untimed);
  untimed.forEach((it, i) => { it.no = numbers[i]; });
  ex.items = [...ex.items.filter((it) => it.timed), ...untimed];
  for (const it of untimed) updateNumberMarker(it);
  if (ex.collapsed) setCollapsed(true);   // バーの番号を合わせる
  else renderList();
}

function findItem(id) {
  return ex.items.find((it) => it.id === id) || null;
}

// 一覧・バー・印の title に出す「③ 写真3」の形
function itemLabel(item) {
  return `${circledNumber(item.no)} ${item.name}`.trim();
}

// ===== 一覧 =====
// 縮小画像は、一覧で見える位置に来た行から読み込む(写真は最大 200 枚)
function startThumbObserver() {
  if (typeof IntersectionObserver !== 'function') return;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      loadThumb(entry.target);
    }
  }, { root: el.list, rootMargin: '150px' });
  ex.thumbObserver = observer;
}

function loadThumb(img) {
  getPhotoThumbUrl(img.dataset.id).then((url) => { if (url) img.src = url; });
}

// 一覧を作り直す(番号・名前・案内している写真の印)
function renderList() {
  const { list, empty } = el;
  ex.thumbObserver?.disconnect();
  list.textContent = '';
  for (const item of ex.items) {
    const name = getPhoto(item.id)?.name;   // 名前が変えられていたら合わせる
    if (typeof name === 'string') item.name = name;
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'explore-row';
    row.dataset.id = item.id;
    if (item.id === ex.targetId) {
      row.classList.add('is-target');
      row.setAttribute('aria-current', 'true');
    }
    const no = document.createElement('span');
    no.className = 'explore-no';
    no.textContent = circledNumber(item.no);
    const nm = document.createElement('span');
    nm.className = 'explore-name';
    nm.textContent = item.name;
    const img = document.createElement('img');
    img.className = 'explore-thumb';
    img.alt = '';
    img.dataset.id = item.id;
    row.append(no, nm, img);
    li.appendChild(row);
    list.appendChild(li);
    if (ex.thumbObserver) ex.thumbObserver.observe(img);
    else loadThumb(img);
  }
  empty.hidden = ex.items.length > 0;
  list.hidden = ex.items.length === 0;
}

// 一覧をたたむ・広げる。たたんだときは、案内している写真の番号と名前をバーに出し、
// そのすぐ下に方角と距離を出す(一覧を広げている間は、どちらも出さない。矢印は出し続ける)
function setCollapsed(collapsed) {
  const target = findItem(ex.targetId);
  ex.collapsed = collapsed && !!target;
  if (!ex.collapsed) renderList();
  el.panel.hidden = ex.collapsed;
  el.stack.hidden = !ex.collapsed;
  el.bar.setAttribute('aria-expanded', String(!ex.collapsed));
  if (ex.collapsed) {
    const label = itemLabel(target);
    el.bar.textContent = `${label} ▼`;
    el.bar.setAttribute('aria-label', t('explore.barAria', { label }));
  }
}

// ===== 番号の印 =====
// 丸が印の役をするので、数字は丸囲みや括弧を付けずに書く(「3」「21」)
function numberIcon(item) {
  const target = item.id === ex.targetId;
  return L.divIcon({
    className: `explore-marker${target ? ' is-target' : ''}`,
    html: `<span>${item.no}</span>`,
    iconSize: null
  });
}

function addNumberMarkers() {
  for (const item of ex.items) {
    item.marker = L.marker([item.lat, item.lng], {
      icon: numberIcon(item),
      title: itemLabel(item),
      keyboard: false,
      zIndexOffset: MARKER_Z
    }).addTo(ex.map).on('click', () => selectTarget(item.id));
  }
}

function updateNumberMarker(item) {
  if (!item.marker) return;
  item.marker.options.title = itemLabel(item);   // setIcon で作り直す要素の title になる
  item.marker.setIcon(numberIcon(item));
  item.marker.setZIndexOffset(item.id === ex.targetId ? TARGET_MARKER_Z : MARKER_Z);
}

// ===== 写真が消えたとき =====
// 一覧と地図から外す。ほかの写真の番号は変えない(欠番になる)。増えた写真は一覧に足さない
function onPhotosRemoved(ids) {
  if (!ex) return;
  const gone = new Set(ids);
  const removed = ex.items.filter((it) => gone.has(it.id));
  if (removed.length === 0) return;
  for (const item of removed) if (item.marker) ex.map.removeLayer(item.marker);
  ex.items = ex.items.filter((it) => !gone.has(it.id));
  if (ex.targetId && gone.has(ex.targetId)) {
    // 案内している写真が消えた: 案内をやめて一覧を広げる
    ex.targetId = null;
    ex.arrived = false;
    removeArrow();
    setCollapsed(false);
  } else if (!ex.collapsed) {
    renderList();
  }
  renderGuide();
}

// ===== 案内 =====
// 写真を押したとき(一覧の行・番号の印)。その写真の案内を始め、一覧をたたむ。
// 案内中の写真をもう一度押したときも、選び直したことにする(「近くに着きました」をまた知らせる)
function selectTarget(id) {
  if (!ex) return;
  const item = findItem(id);
  if (!item) return;
  const prev = findItem(ex.targetId);
  ex.targetId = id;
  ex.arrived = false;
  if (prev && prev !== item) updateNumberMarker(prev);
  updateNumberMarker(item);
  setCollapsed(true);
  renderGuide();
}

// 方角と距離(バーのすぐ下)と矢印を、今の状態に合わせて出し直す
function renderGuide() {
  if (!ex) return;
  const target = findItem(ex.targetId);
  if (!target) {
    el.info.hidden = true;
    removeArrow();
    return;
  }
  el.info.hidden = false;

  // 現在地が分からないときは、方角と距離の代わりに知らせを出し、矢印は出さない
  let message = '';
  if (!isCurrentMarkerVisible()) message = t('explore.markerOff');
  else if (isLocationUnavailable()) message = t('explore.unknown');
  else if (!ex.fix) message = t('explore.waiting');
  el.info.classList.toggle('is-message', !!message);
  if (message) {
    el.infoText.textContent = message;
    removeArrow();
    return;
  }

  const meters = metersFromFix(target);
  const distance = formatDistance(meters);
  el.infoText.textContent = distance.zero
    ? t('explore.infoNoDirection', { distance: distance.text })
    : t('explore.info', { direction: directionName(target), distance: distance.text });
  drawArrow(ex.fix, [target.lat, target.lng]);

  if (!ex.arrived && meters <= ARRIVE_METERS) {
    ex.arrived = true;
    showToast(t('explore.arrived', { label: itemLabel(target) }));
  }
}

// 現在地から見た撮影地点の向き(8 方位。地図と同じく北を基準にし、端末の向きは使わない)
function directionName(item) {
  const deg = bearingDegrees({ lat: ex.fix[0], lng: ex.fix[1] }, item);
  return t(`explore.dir${DIRECTION_KEYS[Math.round(deg / 45) % 8]}`);
}

// 距離の書き方: 100m 未満は 1m 単位、1km 未満は 10m 単位、1km 以上は 0.1km 単位。
// 約 0m のときは向きが決まらないので zero を立てる(方角を出さない)
function formatDistance(meters) {
  if (meters < 99.5) {
    const m = Math.round(meters);
    return { text: t('explore.meters', { m }), zero: m === 0 };
  }
  if (meters < 995) return { text: t('explore.meters', { m: Math.round(meters / 10) * 10 }), zero: false };
  return { text: t('explore.kilometers', { km: (meters / 1000).toFixed(1) }), zero: false };
}

// ===== 現在地 =====
// 使える現在地。「現在地点をマーカー表示」が OFF のとき・位置情報を使えないときは null
// (OFF の間は、移動経路の記録などで位置が届いていても使わない)。
// 直近の位置は、新しい(30 秒以内。geolocation.js の LAST_FIX_MAX_AGE_MS)ときだけ使う。
// 立ち止まっていると次の位置がなかなか届かないため、ON に戻したときはこれですぐに出す
function currentFix() {
  if (!isCurrentMarkerVisible() || isLocationUnavailable()) return null;
  return getFreshLatLng();
}

// geolocation.js からの知らせ。位置が届いたら使い、状態が変わったら(トグルの切替・位置情報を使えない)
// 現在地を見直す。一時的に位置が取れないときは知らせが来ない(それまでの位置を使い続け、次の位置を待つ)
function onLocationEvent(event) {
  if (!ex) return;
  if (event.type === 'fix') {
    if (!isCurrentMarkerVisible()) return;
    ex.fix = event.latlng;
  } else if (!isCurrentMarkerVisible() || isLocationUnavailable()) {
    ex.fix = null;
  } else if (!ex.fix) {
    ex.fix = getFreshLatLng();
  }
  if (ex.fix && ex.reorderPending) reorderUntimed();
  renderGuide();
}

// ===== 矢印 =====
// 白い縁取りの線の上に色の線を重ね、色の線の終わりに矢じり(SVG の marker-end)を付ける。
// 線は画面の範囲で切り取って描く(専用のレンダラの padding を 0 にする)ので、撮影地点が画面の外に
// あるときは、線の終わり=画面の端に矢じりが出て、その方向を示す(矢じりの先を画面の端に合わせる)。
// 撮影地点まで見えているときは、矢じりの先を線の終わりより ARROW_HEAD_GAP 手前に置く。
// 色は CSS(style.css の --explore-arrow-*)で決める。線は className を付けて CSS の stroke で、
// 矢じりは path の fill で塗る(CSS の指定は、Leaflet が付ける SVG の属性より強い)
function buildArrowHeadDefs() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'explore-arrow-defs');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  const head = (id, refX) => `<marker id="${id}" viewBox="0 0 ${ARROW_HEAD_LEN} 20"
    refX="${refX}" refY="10" markerWidth="${ARROW_HEAD_LEN}" markerHeight="20"
    markerUnits="userSpaceOnUse" orient="auto" overflow="visible">
    <path class="explore-arrow-head" d="M0,1 L${ARROW_HEAD_LEN},10 L0,19 Z"/>
  </marker>`;
  svg.innerHTML = `<defs>${head(ARROW_HEAD_ID, ARROW_HEAD_LEN + ARROW_HEAD_GAP)}${head(ARROW_HEAD_EDGE_ID, ARROW_HEAD_LEN - 1)}</defs>`;
  document.body.appendChild(svg);
  return svg;
}

function drawArrow(from, to) {
  const { map } = ex;
  if (!ex.arrow) {
    if (!map.getPane(ARROW_PANE)) {
      const pane = map.createPane(ARROW_PANE);
      pane.style.zIndex = String(ARROW_PANE_Z);
      pane.style.pointerEvents = 'none';
    }
    if (!ex.arrowDefs) ex.arrowDefs = buildArrowHeadDefs();
    const renderer = L.svg({ padding: 0, pane: ARROW_PANE });
    const common = { renderer, pane: ARROW_PANE, interactive: false, lineCap: 'round' };
    ex.arrow = {
      renderer,
      casing: L.polyline([from, to], { ...common, className: 'explore-arrow-casing', weight: 8, opacity: 0.9 }).addTo(map),
      line: L.polyline([from, to], { ...common, className: 'explore-arrow-line', weight: 4, opacity: 1 }).addTo(map),
      to
    };
    // 地図を動かしたり拡大・縮小したりすると、線を画面の範囲で切り取り直すので、矢じりも付け直す
    // (動かしている間は前のままで、動かし終えると合う)
    renderer.on('update', syncArrowHead);
  } else {
    ex.arrow.casing.setLatLngs([from, to]);
    ex.arrow.line.setLatLngs([from, to]);
    ex.arrow.to = to;
  }
  syncArrowHead();
}

// 画面に見えている線が矢じりより長いときだけ、矢じりを付ける。
// 線が画面に入っていないとき(Leaflet は "M0 0" にする)に矢じりだけが画面の左上に出たり、
// 撮影地点のすぐ近くで矢じりが逆向きに出たりしないようにする
function syncArrowHead() {
  const path = ex?.arrow?.line.getElement();
  if (!path) return;
  const n = (path.getAttribute('d') || '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
  const len = n.length >= 4 ? Math.hypot(n[n.length - 2] - n[0], n[n.length - 1] - n[1]) : 0;
  // 線の終わりが撮影地点でなければ、画面の端で切れている(座標は Leaflet の layer point。path と同じ)
  const end = ex.map.latLngToLayerPoint(ex.arrow.to);
  const clipped = n.length >= 4 && Math.hypot(end.x - n[n.length - 2], end.y - n[n.length - 1]) > 1.5;
  const need = clipped ? ARROW_HEAD_LEN + 4 : ARROW_HEAD_LEN + ARROW_HEAD_GAP + 4;
  if (len > need) path.setAttribute('marker-end', `url(#${clipped ? ARROW_HEAD_EDGE_ID : ARROW_HEAD_ID})`);
  else path.removeAttribute('marker-end');
}

function removeArrow() {
  if (!ex?.arrow) return;
  const { renderer, casing, line } = ex.arrow;
  renderer.off('update', syncArrowHead);
  ex.map.removeLayer(casing);
  ex.map.removeLayer(line);
  ex.map.removeLayer(renderer);
  ex.arrow = null;
}
