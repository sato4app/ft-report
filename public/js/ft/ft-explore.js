// 探索・案内。仕様は docs/ft-funcspec-explore.md。
// 起動時画面の「探索・案内」から openExplore() で開く。ハイキングマップ画面に、次のものを重ねて出す。
// - 写真の一覧(左上)。写真を押すと案内を始め、一覧はたたんでバーにする(バーを押すと広げる)
// - 写真の撮影地点の番号の印(一覧に載っている写真のカメラの印は隠す)
// - 現在地から撮影地点への矢印と、方角・距離(左下)。約 30m 以内に入ったら「近くに着きました」と知らせる
// minoh-hiking 由来のファイル(geolocation.js・photos.js・index.html など)は変えない。
// - 地図画面へは、起動時画面の「ハイキングマップ表示」のボタンを押す形で切り替える(app.js の showView は外から呼べないため)
// - 現在地は、「現在地点をマーカー表示」(#toggleCurrentMarker)がオンのときだけ、ここで監視する
// - 写真が消えたことは、カメラの印が地図から外されるのを見て知る
// - 地図画面を離れたら(#viewMap が隠れたら)、探索・案内を終える
// 何も保存しない。写真は変えない・消さない。
import * as L from 'leaflet';
import { getMap } from '../map/map.js';
import { getPhotos, getPhoto, getPhotoThumbUrl } from '../photo/photos.js';
import { showToast } from '../common/messages.js';
import { checkAppShellUpdate } from '../data/update.js';
import { checkPublishedDataUpdate } from '../data/published-data.js';
import { circledNumber, distanceMeters, bearingDegrees, directionName8 } from './ft-report-data.js';

// 近くに着いたと知らせる距離(m)
const ARRIVE_METERS = 30;
// 現在地の監視の設定。直近 30 秒以内の位置なら、監視を始めてすぐに使う
// (geolocation.js が「現在地」として使ってよいとする上限 LAST_FIX_MAX_AGE_MS と同じ)。
// 短くすると、「現在地点をマーカー表示」をオンに戻したとき、立ち止まっていると次の位置がなかなか届かず、
// 「現在地を調べています…」のままになる。その後の位置は、届くたびに使う
const GEO_OPTIONS = { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 };
// 矢印の線と番号の印の重なり順(地図の線(400)より上、マーカー(600)より下)
const ARROW_PANE = 'ftExplorePane';
const ARROW_PANE_Z = 450;
// 番号の印の重なり順(ほかのマーカーより上。案内している写真の印はさらに上)
const MARKER_Z = 500;
const TARGET_MARKER_Z = 1000;
// カメラの印を隠す class(ft-style.css)
const HIDDEN_CLASS = 'ft-explore-hidden';
// 矢じりの SVG の id(撮影地点まで見えているとき・画面の端で切れたとき)
const ARROW_HEAD_ID = 'ftExploreArrowHead';
const ARROW_HEAD_EDGE_ID = 'ftExploreArrowHeadEdge';

const MSG_NO_PHOTOS = '写真がありません。地図画面の「写真を撮影」で写真を撮るか、KMZ を読み込んでください。';
const MSG_MARKER_OFF = '「現在地点をマーカー表示」がオフのため、現在地を続けて取得できません。≡ のメニューでオンにすると、方角と距離を表示します。';
const MSG_WAITING = '現在地を調べています…';
const MSG_UNKNOWN = '現在地が分かりません。';

let ex = null;   // 探索・案内の状態(開いていないときは null)

// ===== 開く・閉じる =====
export function openExplore() {
  const photos = getPhotos();
  if (photos.length === 0) {
    // 画面は開かない。ほかのボタンと同じく、更新版の確認だけはする
    checkAppShellUpdate();
    checkPublishedDataUpdate();
    showToast(MSG_NO_PHOTOS, { durationSec: 5 });
    return;
  }
  const map = getMap();
  const mapBtn = document.querySelector('#viewHome .home-menu [data-view="map"]');
  const viewMap = document.getElementById('viewMap');
  if (!map || !mapBtn || !viewMap) return;
  if (ex) closeExplore();

  // 「ハイキングマップ表示」と同じに地図画面へ切り替える(あわせて更新版も確認される)
  mapBtn.click();
  if (viewMap.hidden) return;

  ex = {
    map,
    viewMap,
    toggle: document.getElementById('toggleCurrentMarker'),
    items: [],              // 一覧の写真(番号の順)。{ id, no, name, lat, lng, timed, marker, row }
    targetId: null,         // 案内している写真
    arrived: false,         // 案内している写真について「近くに着きました」を知らせたか
    collapsed: false,
    fix: null,              // 現在地 { lat, lng }
    geo: 'off',             // 現在地の状態: off(監視していない)・waiting・ok・error
    watchId: null,
    reorderPending: false,  // 撮影日時の無い写真を、初めて現在地が分かったときに並べ直すか
    cameraMarkers: new Map(),   // カメラの印(photos.js の L.marker) → 写真の id
    arrowCasing: null,
    arrowLine: null,
    renderer: null,
    el: {},
    cleanups: []
  };

  buildItems(photos);
  buildDom();
  addNumberMarkers();
  hideCameraMarkers();
  watchMapChanges();
  syncLocationWatch();
  renderList();
  renderGuide();
}

function closeExplore() {
  if (!ex) return;
  const { map } = ex;
  stopLocationWatch();
  for (const fn of ex.cleanups) fn();
  for (const item of ex.items) item.marker && map.removeLayer(item.marker);
  removeArrow();
  showCameraMarkers();
  ex.el.root?.remove();
  ex.el.defs?.remove();
  ex = null;
}

// ===== 一覧の写真と番号 =====
// 撮影日時のある写真を撮影順に並べ、その後に撮影日時の無い写真を現在地から近い順に並べる(仕様 4.1)。
// 現在地がまだ分からないときは読み込んだ順にし、初めて分かったときに一度だけ並べ直す
function buildItems(photos) {
  const timed = photos.filter((p) => Number.isFinite(p.timeMs)).sort((a, b) => a.timeMs - b.timeMs);
  const untimed = photos.filter((p) => !Number.isFinite(p.timeMs));
  if (ex.fix) sortByDistance(untimed);
  else ex.reorderPending = untimed.length >= 2;
  ex.items = [...timed, ...untimed].map((p, i) => ({
    id: p.id, no: i + 1, name: p.name || '', lat: p.lat, lng: p.lng,
    timed: Number.isFinite(p.timeMs), marker: null, row: null
  }));
  for (const p of photos) if (p.marker) ex.cameraMarkers.set(p.marker, p.id);
}

function sortByDistance(list) {
  const { lat, lng } = ex.fix;
  list.sort((a, b) => distanceMeters(lat, lng, a.lat, a.lng) - distanceMeters(lat, lng, b.lat, b.lng));
}

// 初めて現在地が分かったとき: 撮影日時の無い写真を近い順に並べ直す(番号は、それらに付いていた番号を付け直す)
function reorderUntimed() {
  ex.reorderPending = false;
  const untimed = ex.items.filter((it) => !it.timed);
  if (untimed.length < 2) return;
  const numbers = untimed.map((it) => it.no);
  sortByDistance(untimed);
  untimed.forEach((it, i) => { it.no = numbers[i]; });
  ex.items = [...ex.items.filter((it) => it.timed), ...untimed];
  for (const it of untimed) updateNumberMarker(it);
  renderList();
  renderGuide();
}

function findItem(id) {
  return ex.items.find((it) => it.id === id) || null;
}

function itemLabel(item) {
  return `${circledNumber(item.no)} ${item.name}`.trim();
}

// ===== 画面 =====
function buildDom() {
  const root = document.createElement('div');
  root.className = 'ft-explore';
  root.innerHTML = `
    <section class="ft-explore-panel" aria-label="探索・案内">
      <header class="ft-explore-head">
        <h2>探索・案内</h2>
        <button type="button" class="ft-explore-close" aria-label="探索・案内を閉じる" title="閉じる">×</button>
      </header>
      <ol class="ft-explore-list"></ol>
      <p class="ft-explore-empty" hidden>写真がありません</p>
    </section>
    <button type="button" class="ft-explore-bar" aria-expanded="false" hidden></button>
    <div class="ft-explore-info" role="status" aria-live="polite" hidden>
      <div class="ft-explore-info-name"></div>
      <div class="ft-explore-info-text"></div>
    </div>`;
  ex.viewMap.appendChild(root);
  ex.el = {
    root,
    panel: root.querySelector('.ft-explore-panel'),
    list: root.querySelector('.ft-explore-list'),
    empty: root.querySelector('.ft-explore-empty'),
    bar: root.querySelector('.ft-explore-bar'),
    info: root.querySelector('.ft-explore-info'),
    infoName: root.querySelector('.ft-explore-info-name'),
    infoText: root.querySelector('.ft-explore-info-text'),
    defs: buildArrowHeadDefs()
  };
  root.querySelector('.ft-explore-close').addEventListener('click', closeExplore);
  ex.el.bar.addEventListener('click', () => setCollapsed(false));
  ex.el.list.addEventListener('click', (ev) => {
    const row = ev.target.closest('.ft-explore-row');
    if (row) selectTarget(row.dataset.id);
  });

  // 縮小画像は、一覧で見える位置に来た行から読み込む(写真は最大 200 枚)
  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        loadThumb(entry.target);
      }
    }, { root: ex.el.list, rootMargin: '150px' })
    : null;
  ex.thumbObserver = observer;
  ex.cleanups.push(() => observer?.disconnect());
}

function loadThumb(img) {
  getPhotoThumbUrl(img.dataset.id).then((url) => { if (url) img.src = url; });
}

// 一覧を作り直す(番号・名前・案内している写真の印)
function renderList() {
  const { list, empty } = ex.el;
  ex.thumbObserver?.disconnect();
  list.textContent = '';
  for (const item of ex.items) {
    const name = getPhoto(item.id)?.name;   // 名前が変えられていたら合わせる
    if (typeof name === 'string') item.name = name;
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ft-explore-row';
    row.dataset.id = item.id;
    if (item.id === ex.targetId) {
      row.classList.add('is-target');
      row.setAttribute('aria-current', 'true');
    }
    const no = document.createElement('span');
    no.className = 'ft-explore-no';
    no.textContent = circledNumber(item.no);
    const nm = document.createElement('span');
    nm.className = 'ft-explore-name';
    nm.textContent = item.name;
    const img = document.createElement('img');
    img.className = 'ft-explore-thumb';
    img.alt = '';
    img.dataset.id = item.id;
    row.append(no, nm, img);
    li.appendChild(row);
    list.appendChild(li);
    item.row = row;
    if (ex.thumbObserver) ex.thumbObserver.observe(img);
    else loadThumb(img);
  }
  empty.hidden = ex.items.length > 0;
  list.hidden = ex.items.length === 0;
}

// 一覧をたたむ・広げる。たたんだときは、案内している写真の番号と名前をバーに出す
function setCollapsed(collapsed) {
  const target = findItem(ex.targetId);
  ex.collapsed = collapsed && !!target;
  if (!ex.collapsed) renderList();
  ex.el.panel.hidden = ex.collapsed;
  ex.el.bar.hidden = !ex.collapsed;
  ex.el.bar.setAttribute('aria-expanded', String(!ex.collapsed));
  if (ex.collapsed) {
    ex.el.bar.textContent = `${itemLabel(target)} ▼`;
    ex.el.bar.setAttribute('aria-label', `${itemLabel(target)}へ案内中。押すと写真の一覧を開きます`);
  }
}

// ===== 番号の印 =====
function numberIcon(item) {
  const target = item.id === ex.targetId;
  return L.divIcon({
    className: `ft-explore-marker${target ? ' is-target' : ''}`,
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

// ===== カメラの印(一覧に載っている写真の分だけ隠す) =====
function hideCameraMarkers() {
  for (const [marker, id] of ex.cameraMarkers) {
    if (findItem(id)) marker.getElement()?.classList.add(HIDDEN_CLASS);
  }
}

function showCameraMarkers() {
  for (const marker of ex.cameraMarkers.keys()) marker.getElement()?.classList.remove(HIDDEN_CLASS);
}

// 地図の変化を見る:
// - カメラの印が外された → 写真が消えたか確かめる(消した直後は写真の一覧の更新が済んでいないことがあるので、少し後で)
// - 印の見た目が変わって要素が作り直された(マーカーの設定) → 隠し直す
// - 地図画面を離れた → 終える
function watchMapChanges() {
  const { map, viewMap } = ex;
  const onLayerRemove = (e) => {
    if (ex?.cameraMarkers.has(e.layer)) setTimeout(checkDeletedPhotos, 0);
  };
  map.on('layerremove', onLayerRemove);
  ex.cleanups.push(() => map.off('layerremove', onLayerRemove));

  const pane = map.getPane('markerPane');
  if (pane && typeof MutationObserver === 'function') {
    const mo = new MutationObserver(() => ex && hideCameraMarkers());
    mo.observe(pane, { childList: true });
    ex.cleanups.push(() => mo.disconnect());
  }

  const vo = new MutationObserver(() => { if (viewMap.hidden) closeExplore(); });
  vo.observe(viewMap, { attributes: true, attributeFilter: ['hidden'] });
  ex.cleanups.push(() => vo.disconnect());

  const onToggle = () => { if (ex) { syncLocationWatch(); renderGuide(); } };
  ex.toggle?.addEventListener('change', onToggle);
  ex.cleanups.push(() => ex.toggle?.removeEventListener('change', onToggle));
}

// 消えた写真を一覧と地図から外す。ほかの写真の番号は変えない(欠番になる。仕様 6.5)
function checkDeletedPhotos() {
  if (!ex) return;
  const gone = ex.items.filter((it) => !getPhoto(it.id));
  if (gone.length === 0) return;
  for (const item of gone) {
    if (item.marker) ex.map.removeLayer(item.marker);
    for (const [marker, id] of ex.cameraMarkers) if (id === item.id) ex.cameraMarkers.delete(marker);
  }
  ex.items = ex.items.filter((it) => !gone.includes(it));
  if (ex.targetId && !findItem(ex.targetId)) {
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
function selectTarget(id) {
  if (!ex) return;
  const item = findItem(id);
  if (!item) return;
  const prev = findItem(ex.targetId);
  ex.targetId = id;
  ex.arrived = false;   // 選び直したら、また知らせる
  if (prev && prev !== item) updateNumberMarker(prev);
  updateNumberMarker(item);
  setCollapsed(true);
  renderGuide();
}

// 方角と距離(左下)と矢印を、今の状態に合わせて出し直す
function renderGuide() {
  if (!ex) return;
  const { info, infoName, infoText } = ex.el;
  const target = findItem(ex.targetId);
  if (!target) {
    info.hidden = true;
    removeArrow();
    return;
  }
  info.hidden = false;
  infoName.textContent = itemLabel(target);

  let text = '';
  if (!ex.toggle?.checked) text = MSG_MARKER_OFF;
  else if (ex.geo === 'error') text = MSG_UNKNOWN;
  else if (!ex.fix) text = MSG_WAITING;
  info.classList.toggle('is-message', !!text);
  if (text) {
    infoText.textContent = text;
    removeArrow();
    return;
  }

  const { lat, lng } = ex.fix;
  const meters = distanceMeters(lat, lng, target.lat, target.lng);
  const dist = formatDistance(meters);
  const dir = dist.zero ? '' : `${directionName8(bearingDegrees(lat, lng, target.lat, target.lng))}　`;
  infoText.textContent = `${dir}直線で約 ${dist.text}`;
  drawArrow([lat, lng], [target.lat, target.lng]);

  if (!ex.arrived && meters <= ARRIVE_METERS) {
    ex.arrived = true;
    showToast(`近くに着きました（${itemLabel(target)}）`);
  }
}

// 距離の書き方: 100m 未満は 1m 単位、1km 未満は 10m 単位、1km 以上は 0.1km 単位(仕様 6.2)
function formatDistance(meters) {
  if (meters < 99.5) {
    const m = Math.round(meters);
    return { text: `${m}m`, zero: m === 0 };
  }
  if (meters < 995) return { text: `${Math.round(meters / 10) * 10}m`, zero: false };
  return { text: `${(meters / 1000).toFixed(1)}km`, zero: false };
}

// ===== 矢印 =====
// 白い縁取りの線の上に、オレンジの線を重ねる。オレンジの線の終わりに矢じり(SVG の marker-end)を付ける。
// 線は画面の範囲で切り取って描く(renderer の padding を 0 にする)ので、撮影地点が画面の外にあるときは、
// 線の終わり=画面の端に矢じりが出て、その方向を示す(矢じりの先を画面の端に合わせる)。
// 撮影地点まで見えているときは、矢じりの先を線の終わりより少し手前に置き、
// 撮影地点の番号の印に隠れないようにする(ARROW_HEAD_GAP)
const ARROW_HEAD_LEN = 20;
const ARROW_HEAD_GAP = 18;

function buildArrowHeadDefs() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'absolute';
  const head = (id, refX) => `<marker id="${id}" viewBox="0 0 ${ARROW_HEAD_LEN} 20"
    refX="${refX}" refY="10" markerWidth="${ARROW_HEAD_LEN}" markerHeight="20"
    markerUnits="userSpaceOnUse" orient="auto" overflow="visible">
    <path d="M0,1 L${ARROW_HEAD_LEN},10 L0,19 Z" fill="#ef6c00" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
  </marker>`;
  svg.innerHTML = `<defs>${head(ARROW_HEAD_ID, ARROW_HEAD_LEN + ARROW_HEAD_GAP)}${head(ARROW_HEAD_EDGE_ID, ARROW_HEAD_LEN - 1)}</defs>`;
  document.body.appendChild(svg);
  return svg;
}

function drawArrow(from, to) {
  const { map } = ex;
  if (!ex.arrowLine) {
    if (!map.getPane(ARROW_PANE)) {
      const pane = map.createPane(ARROW_PANE);
      pane.style.zIndex = String(ARROW_PANE_Z);
      pane.style.pointerEvents = 'none';
    }
    ex.renderer = L.svg({ padding: 0, pane: ARROW_PANE });
    const common = { renderer: ex.renderer, pane: ARROW_PANE, interactive: false, lineCap: 'round' };
    ex.arrowCasing = L.polyline([from, to], { ...common, color: '#fff', weight: 8, opacity: 0.9 }).addTo(map);
    ex.arrowLine = L.polyline([from, to], { ...common, color: '#ef6c00', weight: 4, opacity: 1 }).addTo(map);
    // 地図を動かしたり拡大・縮小したりすると、線を画面の範囲で切り取り直すので、矢じりも付け直す
    ex.renderer.on('update', syncArrowHead);
  } else {
    ex.arrowCasing.setLatLngs([from, to]);
    ex.arrowLine.setLatLngs([from, to]);
  }
  ex.arrowTo = to;
  syncArrowHead();
}

// 画面に見えている線が矢じりより長いときだけ、矢じりを付ける。
// 線が画面に入っていないとき(Leaflet は "M0 0" にする)に矢じりだけが画面の左上に出たり、
// 撮影地点のすぐ近くで矢じりが逆向きに出たりしないようにする
function syncArrowHead() {
  const path = ex?.arrowLine?.getElement();
  if (!path) return;
  const n = (path.getAttribute('d') || '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
  const len = n.length >= 4 ? Math.hypot(n[n.length - 2] - n[0], n[n.length - 1] - n[1]) : 0;
  // 線の終わりが撮影地点でなければ、画面の端で切れている(座標は Leaflet の layer point。path と同じ)
  const end = ex.arrowTo && ex.map.latLngToLayerPoint(ex.arrowTo);
  const clipped = !!end && n.length >= 4 && Math.hypot(end.x - n[n.length - 2], end.y - n[n.length - 1]) > 1.5;
  const need = clipped ? ARROW_HEAD_LEN + 4 : ARROW_HEAD_LEN + ARROW_HEAD_GAP + 4;
  if (len > need) path.setAttribute('marker-end', `url(#${clipped ? ARROW_HEAD_EDGE_ID : ARROW_HEAD_ID})`);
  else path.removeAttribute('marker-end');
}

function removeArrow() {
  if (!ex) return;
  if (ex.arrowCasing) ex.map.removeLayer(ex.arrowCasing);
  if (ex.arrowLine) ex.map.removeLayer(ex.arrowLine);
  if (ex.renderer) {
    ex.renderer.off('update', syncArrowHead);
    ex.map.removeLayer(ex.renderer);
  }
  ex.arrowCasing = ex.arrowLine = ex.renderer = ex.arrowTo = null;
}

// ===== 現在地 =====
// 「現在地点をマーカー表示」がオンのときだけ監視する(オフなら知らせるだけで、自動でオンにはしない。仕様 6.3)
function syncLocationWatch() {
  if (ex.toggle?.checked) startLocationWatch();
  else stopLocationWatch();
}

function startLocationWatch() {
  if (ex.watchId != null || ex.geo === 'error') return;
  if (!('geolocation' in navigator)) {
    ex.geo = 'error';
    return;
  }
  ex.geo = 'waiting';
  ex.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, GEO_OPTIONS);
}

function stopLocationWatch() {
  if (!ex) return;
  if (ex.watchId != null) navigator.geolocation.clearWatch(ex.watchId);
  ex.watchId = null;
  ex.fix = null;
  if (ex.geo !== 'error' || !ex.toggle?.checked) ex.geo = 'off';
}

function onPosition(pos) {
  if (!ex || ex.watchId == null) return;
  ex.fix = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  ex.geo = 'ok';
  if (ex.reorderPending) reorderUntimed();
  renderGuide();
}

// 位置情報の利用が許可されていないときは「現在地が分かりません」。
// 一時的に取れないとき(時間切れなど)は、監視を続けて次の位置を待つ(それまでの位置があればそれを使う)
function onPositionError(err) {
  if (!ex || ex.watchId == null) return;
  if (err?.code === 1) {
    navigator.geolocation.clearWatch(ex.watchId);
    ex.watchId = null;
    ex.fix = null;
    ex.geo = 'error';
    renderGuide();
  }
}
