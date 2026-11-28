// 場所を検索(地図の上の場所を名称で探し、現在地から案内する)。仕様は docs/funcspec-202611.md の 4.12。
// 入力した文字で、緊急ポイント(ID・名称)・ルート(名称)・スポット(名称)・写真(名前)を探し、
// 現在地から近い順に一覧で出す(各行に番号・方角・距離・種類。写真は縮小画像も)。
// 結果を押すと、その場所まで、現在地からの矢印と方角・距離で案内する
// (一覧はたたんでバーにし、すぐ下に方角と距離を出す。約 30m 以内に入ったら「近くに着きました」と知らせる)。
// 入口は表示設定パネル(≡)の「場所を検索」トグルで、ON のとき上部に出す虫眼鏡のボタン(#btnExplore)。
// openExplore() は、どの画面から呼んでも地図画面に切り替えてから開く(ft-report は起動時画面のボタンから呼ぶ)。
// 更新版の確認は openExplore() の中ではしない(呼ぶ側のボタンが行う)。
// 現在地は geolocation.js の監視を受け取る(ここでは監視しない。addLocationListener)。
// 端末に保存するのは、選んだ場所の履歴(新しい順に 5 件まで。結果の下に出す)だけ。入力した文字・案内の相手は
// 覚えない。地図データ・写真は変えない。
// id・class・i18n のキー・export する関数の名前は、2026.99 からの呼び名 explore を使う
// (2026.99 は写真の一覧として photo/photo-explore.js に置いた。2026.100 で検索に改め、ここへ移した)。
import * as L from 'leaflet';
import { getMap } from './map.js';
import { getSearchablePlaces } from './map-overlays.js';
import {
  addLocationListener, getFreshLatLng, isCurrentMarkerVisible, isLocationUnavailable
} from './geolocation.js';
import { closeLayerPanel } from './layer-panel.js';
import { getPhotos, getPhoto, getPhotoThumbUrl, addPhotosRemovedListener } from '../photo/photos.js';
import { EXPLORE_HISTORY_KEY } from '../common/config.js';
import { t, pickLang } from '../common/i18n.js';
import { showToast } from '../common/messages.js';
import { readLocalJSON, writeLocalJSON } from '../common/storage.js';
import { on } from '../common/ui.js';
import { bearingDegrees, circledNumber } from '../common/utils.js';

// 近くに着いたと知らせる距離(m)。GPS の誤差(数 m〜十数 m)があるため目安
const ARRIVE_METERS = 30;
// 一覧に出す結果の上限(近い順。番号は ①〜⑳)。それより多いときは、一覧の最後に残りの件数を出す
const MAX_RESULTS = 20;
// 選んだ場所の履歴(結果の下に出す)の上限。端末に保存する(EXPLORE_HISTORY_KEY)
const HISTORY_MAX = 5;
// 履歴の行の、番号の代わりに出す時計の印(固定の SVG)
const HISTORY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">' +
  '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
// 入力が止まってから探すまでの待ち(ms)。打つたびに一覧を作り直さないように
const SEARCH_DELAY_MS = 150;
// 矢印の線の重なり順(地図の線(overlayPane 400)より上、マーカー(markerPane 600)より下)
const ARROW_PANE = 'explorePane';
const ARROW_PANE_Z = 450;
// 矢じり(SVG の marker)の大きさと、場所まで見えているときに矢じりの先を置く手前の距離(px。
// 場所の印に隠れないように)。id は場所まで見えているとき・画面の端で切れたときの 2 種類
const ARROW_HEAD_LEN = 20;
const ARROW_HEAD_GAP = 18;
const ARROW_HEAD_ID = 'exploreArrowHead';
const ARROW_HEAD_EDGE_ID = 'exploreArrowHeadEdge';
// 8 方位の i18n キーの末尾(北から時計回り)
const DIRECTION_KEYS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
// 結果の種類の i18n キー
const KIND_KEYS = {
  point: 'explore.kindPoint',
  route: 'explore.kindRoute',
  spot: 'explore.kindSpot',
  photo: 'explore.kindPhoto'
};

const el = {
  // 表示設定パネルの「場所を検索」と、ON のとき上部に出す虫眼鏡のボタン
  toggle: document.getElementById('toggleExplore'),
  button: document.getElementById('btnExplore'),
  // 入力欄と結果の一覧(広げた状態)。結果の下に、選んだ場所の履歴(同じスクロールの中)
  panel: document.getElementById('explorePanel'),
  input: document.getElementById('exploreInput'),
  note: document.getElementById('exploreNote'),
  scroll: document.getElementById('exploreScroll'),
  list: document.getElementById('exploreList'),
  history: document.getElementById('exploreHistory'),
  historyList: document.getElementById('exploreHistoryList'),
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
  if (el.input) el.input.placeholder = t('explore.placeholder');
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
  // 結果の行・履歴の行を押す(どちらも同じスクロールの中にある)
  on(el.scroll, 'click', (ev) => {
    const row = ev.target.closest('.explore-row');
    if (row) selectResult(row.dataset.key);
  });
  // 入力: 打ち終えたら探す。日本語の変換中(確定前)は探さず、確定してから探す
  on(el.input, 'input', (e) => {
    if (!e.isComposing) scheduleSearch();
  });
  on(el.input, 'compositionend', scheduleSearch);
  // Enter(キーボードの「検索」)ですぐに探し、キーボードを閉じて結果を見えるようにする
  on(el.input, 'keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    runSearch();
    el.input.blur();
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
// 場所を検索を開く(入力欄を空にしてフォーカスを入れる)。起動時画面から呼んでも、
// ハイキングマップ画面に切り替えてから開く。開いていれば、閉じてから開き直す。
// 開けたら true を返す。更新版の確認はしない(起動時画面のボタンから呼ぶときは、ボタンの側で行う)
export function openExplore() {
  const map = getMap();
  if (!map || !hooks || !el.panel) return false;
  if (ex) closeExplore();
  if (!mapViewShown) hooks.showMapView();
  if (!mapViewShown) return false;
  // 一覧が見えるよう、表示設定パネル(≡)は閉じる
  closeLayerPanel();

  ex = {
    map,
    query: '',              // 探している文字(normalizeForSearch した形)
    matches: [],            // 当たった場所すべて(近い順。現在地が分からないときは地図データ・写真の順)
    results: [],            // 一覧に出す分(matches の先頭 MAX_RESULTS 件)
    sorted: false,          // matches を現在地から近い順に並べたか
    history: [],            // 選んだ場所の履歴(新しい順。結果の下に出す。→ loadHistoryItems)
    target: null,           // 案内している場所(results または history の要素)
    arrived: false,         // 案内している場所について「近くに着きました」を知らせたか
    collapsed: false,
    fix: currentFix(),      // 現在地 [lat, lng](分からないときは null)
    arrow: null,            // 矢印 { renderer, casing, line, to }
    arrowDefs: null,        // 矢じりの SVG(defs)
    thumbObserver: null,
    searchTimer: null
  };

  el.input.value = '';
  ex.history = loadHistoryItems();
  for (const item of ex.history) measure(item);
  startThumbObserver();
  setCollapsed(false);
  renderGuide();
  updateExploreButton();
  // 押した操作の続きでフォーカスを入れると、スマホでもキーボードが開く
  el.input.focus();
  return true;
}

// 場所を検索を終える。入力欄・一覧(バー)・矢印・方角と距離を消す
export function closeExplore() {
  if (!ex) return;
  clearTimeout(ex.searchTimer);
  ex.thumbObserver?.disconnect();
  removeArrow();
  ex.arrowDefs?.remove();
  if (document.activeElement === el.input) el.input.blur();
  el.input.value = '';
  el.panel.hidden = true;
  el.stack.hidden = true;
  el.list.textContent = '';
  el.historyList.textContent = '';
  ex = null;
  updateExploreButton();
}

// 場所を検索を開いているか
export function isExploreOpen() {
  return !!ex;
}

// ===== 検索 =====
// 比べる前にそろえる: 全角・半角(NFKC。英数字・記号は半角、半角カナは全角)、大文字・小文字、空白の有無
function normalizeForSearch(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

// ID の書き方の違いを許すための形(normalizeForSearch した文字に使う)。「F-01」を「f1」「f01」「f-1」と打っても
// 当たるようにする。名称・写真の名前にも同じく使う(この形での一致は、ふつうの一致に足すだけ)。
// - withoutHyphens: ハイフンの類(各種ダッシュ・下線と、日本語入力のまま英数字の隣で打った「ー」)を除く。
//   打った文字と対象の両方に使う
// - withoutLeadingZeros: 数字の頭の 0 を除く(f01 → f1)。対象の側にだけ使う。打った文字の 0 は残すので、
//   「f01」は F-01 に当たり、F-11 には当たらない(「f1」は F-01 と、f1 で始まる F-11〜 に当たる)
function withoutHyphens(s) {
  return s
    .replace(/([a-z0-9])ー/g, '$1')
    .replace(/ー([a-z0-9])/g, '$1')
    .replace(/[-‐‑‒–—―−_]/g, '');
}

function withoutLeadingZeros(s) {
  return s.replace(/(^|\D)0+(?=\d)/g, '$1');
}

function scheduleSearch() {
  if (!ex) return;
  clearTimeout(ex.searchTimer);
  ex.searchTimer = setTimeout(runSearch, SEARCH_DELAY_MS);
}

// 入力欄の文字で探し直す(文字が変わっていなければ何もしない)
function runSearch() {
  if (!ex) return;
  clearTimeout(ex.searchTimer);
  const query = normalizeForSearch(el.input.value);
  if (query === ex.query) return;
  ex.query = query;
  ex.matches = query ? findPlaces(query) : [];
  ex.sorted = false;
  orderResults();
  renderList();
}

// 部分一致で探す。緊急ポイントは ID・名称・英語名、ルート・スポットは名称・英語名、写真は名前を比べる。
// ID の書き方の違い(F-01 と f1 など)も許す(→ withoutHyphens・withoutLeadingZeros)
// (ルート・スポットの ID は比べない)。並びは地図データ(緊急ポイント・ルート・スポット)の後に写真
function findPlaces(query) {
  // ふつうの形で当たるか、ID の書き方の違いを許す形(withoutHyphens・withoutLeadingZeros)で当たれば一致とする。
  // ハイフンを除くと空になる入力(「-」だけなど)は、ふつうの形だけで比べる(空の文字は何にでも当たるため)
  const loose = withoutHyphens(query);
  const hit = (...texts) => texts.some((s) => {
    if (!s) return false;
    const text = normalizeForSearch(s);
    if (text.includes(query)) return true;
    if (!loose) return false;
    const dehyphened = withoutHyphens(text);
    return dehyphened.includes(loose) || withoutLeadingZeros(dehyphened).includes(loose);
  });
  const found = [];
  getSearchablePlaces().forEach((p, i) => {
    if (!hit(p.id, p.name, p.englishName)) return;
    found.push(makeItem({ kind: p.type, id: p.id, name: p.name, englishName: p.englishName, latlngs: p.latlngs }, `${p.type}:${i}`));
  });
  for (const photo of getPhotos()) {
    if (!hit(photo.name)) continue;
    found.push(makeItem({ kind: 'photo', name: photo.name, latlngs: [[photo.lat, photo.lng]], photoId: photo.id }, `photo:${photo.id}`));
  }
  return found;
}

// 一覧の 1 件(結果・履歴で共通)。src は { kind, id, name, englishName, latlngs, photoId }(履歴に保存する形)。
// key は一覧の行の data-key、place はどの場所か(履歴の重なりを除く・案内中の行に印を付けるのに使う)
function makeItem(src, key) {
  const place = placeKey(src);
  return {
    key: key ?? `h:${place}`, place, kind: src.kind, label: placeLabel(src), latlngs: src.latlngs,
    photoId: src.photoId || null, src: { ...src, key: place }
  };
}

// 場所を見分ける文字列。写真は写真の id、ほかは種類・ID(緊急ポイント)か名称・最初の点の位置
// (地図データを更新しても変わらないもの。配列の番号は使わない)
function placeKey(src) {
  if (src.kind === 'photo') return `photo:${src.photoId}`;
  const [lat, lng] = src.latlngs[0];
  return `${src.kind}:${src.id || src.name || src.englishName || ''}@${lat.toFixed(5)},${lng.toFixed(5)}`;
}

// 一覧に出す名前: 表示言語の名称(英語表示では英語名、無ければ名称)。緊急ポイントは ID を前に付ける。
// 写真は今の名前(名前を変えていれば合わせる)
function placeLabel(src) {
  if (src.kind === 'photo') return (getPhoto(src.photoId)?.name ?? src.name) || '';
  const name = pickLang({ ja: src.name || null, en: src.englishName || null }) || src.name || src.englishName || '';
  return src.kind === 'point' && src.id ? `${src.id} ${name}`.trim() : name;
}

// ===== 選んだ場所の履歴 =====
// 結果を選んだときに、その場所の写しを新しい順に HISTORY_MAX 件まで端末に保存する(同じ場所は先頭へ移す)。
// 保存できない環境では、アプリを開いている間だけ覚える。写真が消えたら、その写真の履歴も消す
let historyRecords = null;

function readHistory() {
  if (historyRecords) return historyRecords;
  const saved = readLocalJSON(EXPLORE_HISTORY_KEY);
  historyRecords = (Array.isArray(saved) ? saved : []).filter(isValidRecord).slice(0, HISTORY_MAX);
  return historyRecords;
}

function writeHistory(records) {
  historyRecords = records;
  writeLocalJSON(EXPLORE_HISTORY_KEY, records);
}

function isValidRecord(r) {
  return !!r && typeof r === 'object' && typeof r.key === 'string' && !!KIND_KEYS[r.kind] &&
    Array.isArray(r.latlngs) && r.latlngs.length > 0 &&
    r.latlngs.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

// 一覧に出す履歴(消えた写真の履歴は出さない)
function loadHistoryItems() {
  return readHistory()
    .filter((r) => r.kind !== 'photo' || getPhoto(r.photoId))
    .map((r) => makeItem(r));
}

function rememberChoice(item) {
  const record = { ...item.src };
  writeHistory([record, ...readHistory().filter((r) => r.key !== record.key)].slice(0, HISTORY_MAX));
  ex.history = loadHistoryItems();
  for (const h of ex.history) measure(h);
}

// 当たった場所を、現在地が分かっていれば近い順に並べ、先頭 MAX_RESULTS 件に番号を付けて一覧に出す分にする。
// 現在地が分からないときは見つけた順のまま(初めて現在地が分かったときに並べ直す。→ onLocationEvent)
function orderResults() {
  for (const item of ex.matches) measure(item);
  if (ex.fix) {
    ex.matches.sort((a, b) => a.meters - b.meters);
    ex.sorted = true;
  }
  ex.results = ex.matches.slice(0, MAX_RESULTS);
  ex.results.forEach((item, i) => { item.no = i + 1; });
}

// 現在地からの直線距離と、場所の中で現在地にいちばん近い点(案内の矢印の先)を求める。
// ルート(線)は線の上でいちばん近い点まで、ポイント・スポット・写真はその地点まで
function measure(item) {
  if (!ex.fix) {
    item.near = null;
    item.meters = null;
    return;
  }
  item.near = nearestPoint(ex.fix, item.latlngs);
  item.meters = L.latLng(ex.fix).distanceTo(item.near);
}

// 点 from に最も近い、折れ線 latlngs 上の点([lat, lng])。1 点だけならその点。
// 数 km の範囲なので、from を原点に経度を cos(緯度) で縮めた平面で求める(距離は呼び出し側が測り直す)
function nearestPoint(from, latlngs) {
  if (latlngs.length === 1) return latlngs[0];
  const [lat0, lng0] = from;
  const kx = Math.cos(lat0 * Math.PI / 180);
  const xy = ([lat, lng]) => [(lng - lng0) * kx, lat - lat0];
  let best = latlngs[0];
  let bestD2 = Infinity;
  for (let i = 0; i < latlngs.length - 1; i++) {
    const [ax, ay] = xy(latlngs[i]);
    const [bx, by] = xy(latlngs[i + 1]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const k = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const x = ax + k * dx;
    const y = ay + k * dy;
    const d2 = x * x + y * y;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = [lat0 + y, lng0 + x / kx];
    }
  }
  return best;
}

// ===== 一覧 =====
// 縮小画像(写真の結果・履歴だけ)は、一覧で見える位置に来た行から読み込む
function startThumbObserver() {
  if (typeof IntersectionObserver !== 'function') return;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      loadThumb(entry.target);
    }
  }, { root: el.scroll, rootMargin: '150px' });
  ex.thumbObserver = observer;
}

function loadThumb(img) {
  getPhotoThumbUrl(img.dataset.id).then((url) => { if (url) img.src = url; });
}

// 一覧を作り直す(番号・名前・方角と距離・種類・縮小画像・案内している場所の印)。
// 結果の下に、選んだ場所の履歴(新しい順。HISTORY_MAX 件まで)を同じスクロールの中に出す
function renderList() {
  const { list, historyList } = el;
  ex.thumbObserver?.disconnect();
  list.textContent = '';
  for (const item of ex.results) list.appendChild(buildRow(item));
  const more = ex.matches.length - ex.results.length;
  if (more > 0) {
    const li = document.createElement('li');
    li.className = 'explore-more';
    li.textContent = t('explore.more', { n: more });
    list.appendChild(li);
  }
  list.hidden = list.childElementCount === 0;
  historyList.textContent = '';
  for (const item of ex.history) historyList.appendChild(buildRow(item));
  el.history.hidden = ex.history.length === 0;
  renderNote();
}

// 1 件の行。左に番号(履歴は時計の印)、中に名前(1 行目)と方角・距離・種類(2 行目)、写真なら右に縮小画像
function buildRow(item) {
  const li = document.createElement('li');
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'explore-row';
  row.dataset.key = item.key;
  if (ex.target && item.place === ex.target.place) {
    row.classList.add('is-target');
    row.setAttribute('aria-current', 'true');
  }
  const no = document.createElement('span');
  no.className = 'explore-no';
  if (item.no) no.textContent = circledNumber(item.no);
  else no.innerHTML = HISTORY_ICON;
  const main = document.createElement('span');
  main.className = 'explore-main';
  const name = document.createElement('span');
  name.className = 'explore-name';
  name.textContent = item.label;
  const sub = document.createElement('span');
  sub.className = 'explore-sub';
  const dist = document.createElement('span');
  dist.className = 'explore-dist';
  const kind = document.createElement('span');
  kind.className = 'explore-kind';
  kind.textContent = t(KIND_KEYS[item.kind]);
  sub.append(dist, kind);
  main.append(name, sub);
  row.append(no, main);
  if (item.photoId) {
    const img = document.createElement('img');
    img.className = 'explore-thumb';
    img.alt = '';
    img.dataset.id = item.photoId;
    row.appendChild(img);
    if (ex.thumbObserver) ex.thumbObserver.observe(img);
    else loadThumb(img);
  }
  li.appendChild(row);
  item.distEl = dist;
  updateRowDistance(item);
  return li;
}

// 行の方角と距離(「北東 120m」)。現在地が分からないときは出さない(一覧の上の知らせで伝える)
function updateRowDistance(item) {
  if (!item.distEl) return;
  if (item.meters == null) {
    item.distEl.textContent = '';
    return;
  }
  const distance = formatDistance(item.meters);
  item.distEl.textContent = distance.zero
    ? distance.text
    : t('explore.rowInfo', { direction: directionName(item), distance: distance.text });
}

// 入力欄と一覧の間の 1 行: 入力前は探せるものの説明、当たらなければその旨、
// 当たったときは並びの説明(現在地が分からないときは、その理由)
function renderNote() {
  let text;
  let message = false;
  if (!ex.query) text = t('explore.hint');
  else if (ex.matches.length === 0) text = t('explore.noResults');
  else if (!ex.fix) {
    text = locationMessage();
    message = true;
  } else text = t('explore.sortedNote');
  el.note.textContent = text;
  el.note.classList.toggle('is-message', message);
}

// 一覧をたたむ・広げる。たたんだときは、案内している場所の番号と名前をバーに出し、
// そのすぐ下に方角と距離を出す(一覧を広げている間は、どちらも出さない。矢印は出し続ける)
function setCollapsed(collapsed) {
  const target = ex.target;
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

// バー・知らせに出す「③ 名前」の形(履歴から選んだときは番号を付けない)
function itemLabel(item) {
  return item.no ? `${circledNumber(item.no)} ${item.label}`.trim() : item.label;
}

// ===== 写真が消えたとき =====
// 結果と履歴から外す(履歴は端末の保存からも消す)。ほかの結果の番号は変えない(欠番になる)。
// 増えた写真は、探し直すまで結果に足さない
function onPhotosRemoved(ids) {
  const gone = new Set(ids.map((id) => `photo:${id}`));
  const records = readHistory();
  const kept = records.filter((r) => !gone.has(r.key));
  if (kept.length !== records.length) writeHistory(kept);
  if (!ex) return;
  const count = ex.matches.length + ex.history.length;
  ex.matches = ex.matches.filter((m) => !gone.has(m.place));
  ex.history = ex.history.filter((h) => !gone.has(h.place));
  // 案内している場所は、探し直した後の結果に無いこともあるので別に調べる
  const targetGone = !!ex.target && gone.has(ex.target.place);
  if (ex.matches.length + ex.history.length === count && !targetGone) return;
  ex.results = ex.results.filter((r) => !gone.has(r.place));
  if (targetGone) {
    // 案内している写真が消えた: 案内をやめて一覧を広げる
    ex.target = null;
    ex.arrived = false;
    removeArrow();
    setCollapsed(false);
  } else if (!ex.collapsed) {
    renderList();
  }
  renderGuide();
}

// ===== 案内 =====
// 結果・履歴を押したとき。その場所の案内を始め、履歴の先頭に残して、一覧をたたむ(キーボードも閉じる)。
// 案内中の場所をもう一度押したときも、選び直したことにする(「近くに着きました」をまた知らせる)
function selectResult(key) {
  if (!ex) return;
  const item = ex.results.find((r) => r.key === key) || ex.history.find((h) => h.key === key);
  if (!item) return;
  rememberChoice(item);
  ex.target = item;
  ex.arrived = false;
  if (document.activeElement === el.input) el.input.blur();
  setCollapsed(true);
  renderGuide();
}

// 方角と距離(バーのすぐ下)と矢印を、今の状態に合わせて出し直す
function renderGuide() {
  if (!ex) return;
  const target = ex.target;
  if (!target) {
    el.info.hidden = true;
    removeArrow();
    return;
  }
  el.info.hidden = false;

  // 現在地が分からないときは、方角と距離の代わりに知らせを出し、矢印は出さない
  const message = locationMessage();
  el.info.classList.toggle('is-message', !!message);
  if (message) {
    el.infoText.textContent = message;
    removeArrow();
    return;
  }

  measure(target);
  const distance = formatDistance(target.meters);
  el.infoText.textContent = distance.zero
    ? t('explore.infoNoDirection', { distance: distance.text })
    : t('explore.info', { direction: directionName(target), distance: distance.text });
  drawArrow(ex.fix, target.near);

  if (!ex.arrived && target.meters <= ARRIVE_METERS) {
    ex.arrived = true;
    showToast(t('explore.arrived', { label: itemLabel(target) }));
  }
}

// 現在地が分からないときの知らせ(分かっていれば空)
function locationMessage() {
  if (!isCurrentMarkerVisible()) return t('explore.markerOff');
  if (isLocationUnavailable()) return t('explore.unknown');
  if (!ex.fix) return t('explore.waiting');
  return '';
}

// 現在地から見た場所の向き(8 方位。地図と同じく北を基準にし、端末の向きは使わない)
function directionName(item) {
  const deg = bearingDegrees({ lat: ex.fix[0], lng: ex.fix[1] }, { lat: item.near[0], lng: item.near[1] });
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
// 現在地を見直す。一時的に位置が取れないときは知らせが来ない(それまでの位置を使い続け、次の位置を待つ)。
// 結果の並びは、初めて現在地が分かったときに一度だけ近い順にする(歩いても並べ直さない。距離は出し直す)
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
  if (ex.fix && !ex.sorted && ex.matches.length > 0) {
    orderResults();
    for (const item of ex.history) measure(item);
    renderList();
    if (ex.collapsed) setCollapsed(true);   // バーの番号を合わせる
  } else {
    for (const item of [...ex.results, ...ex.history]) {
      measure(item);
      updateRowDistance(item);
    }
    renderNote();
  }
  renderGuide();
}

// ===== 矢印 =====
// 白い縁取りの線の上に色の線を重ね、色の線の終わりに矢じり(SVG の marker-end)を付ける。
// 線は画面の範囲で切り取って描く(専用のレンダラの padding を 0 にする)ので、場所が画面の外に
// あるときは、線の終わり=画面の端に矢じりが出て、その方向を示す(矢じりの先を画面の端に合わせる)。
// 場所まで見えているときは、矢じりの先を線の終わりより ARROW_HEAD_GAP 手前に置く。
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
// 場所のすぐ近くで矢じりが逆向きに出たりしないようにする
function syncArrowHead() {
  const path = ex?.arrow?.line.getElement();
  if (!path) return;
  const n = (path.getAttribute('d') || '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
  const len = n.length >= 4 ? Math.hypot(n[n.length - 2] - n[0], n[n.length - 1] - n[1]) : 0;
  // 線の終わりが場所でなければ、画面の端で切れている(座標は Leaflet の layer point。path と同じ)
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
