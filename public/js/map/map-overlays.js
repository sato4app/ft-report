// 地図に重ねる表示(オーバーレイ)の描画
// - 緊急ポイント / ハイキング(ルート + スポット) / 通行止め・通行困難地点 の3つのレイヤー
// - マーカーの設定によるスタイル(setOverlayStyle)と、ハイキングマップ表示での表示・非表示(setOverlaysVisible)
// - ポップアップと、ルートを押したときに近くのポイントを優先する処理
// - 場所を検索の対象にする地図データ(getSearchablePlaces)
// 表示データは published-data.js が取得して渡す(本モジュールは描画専用)。
import * as L from 'leaflet';
import { getMap, TAP_TOLERANCE } from './map.js';
import { buildMarkerIcon } from './marker-icons.js';
import { t, pickLang } from '../common/i18n.js';
import { escapeHtml, formatLocalDate } from '../common/utils.js';

// 地図データ(mapdata): 緊急ポイント・ルート・スポットを1本の FeatureCollection で受け取り、
// properties.type で振り分けて2つのレイヤー(緊急ポイント / ハイキング)を作る。
let mapdataGeoJSON = null;
// 通行止め・通行困難地点(closures)
let closureGeoJSON = null;

// マーカーの設定の種別(config.js の MARKER_TYPES の key)ごとのスタイル。未設定は null
const styles = {
  emergency: null,
  hikingRoute: null,
  spot: null,
  closureClosed: null,
  closureDifficult: null
};

// 通行止め・通行困難地点は kind でスタイルを分ける: closed(通行止め)=赤の通行止め(歩行者通行止め風) /
// difficult(通行困難)=黄色の警戒。色・形状は固定で、サイズのみマーカー設定で変更可能。
const CLOSURE_FALLBACK_STYLES = {
  closed: { color: '#DC2626', shape: 'noThoroughfare', size: 20 },
  difficult: { color: '#FACC15', shape: 'warning', size: 20 }
};
// kind → ポップアップ表示名の翻訳キー(表示名は i18n.js の辞書で管理)
const CLOSURE_KIND_KEYS = { closed: 'closure.kindClosed', difficult: 'closure.kindDifficult' };

// 3つのレイヤー。data は描くデータ(無ければレイヤーを作らない)、build はレイヤーを作る関数。
// 並びは表示する順(後から加えたものほど上に描かれる)
const overlays = {
  emergency: { layer: null, data: () => mapdataGeoJSON, build: buildEmergencyLayer },
  hiking: { layer: null, data: () => mapdataGeoJSON, build: buildHikingLayer },
  closure: { layer: null, data: () => closureGeoJSON, build: buildClosureLayer }
};
// マーカーの設定の種別 → そのスタイルで描くレイヤー
const OVERLAY_OF_STYLE = {
  emergency: 'emergency',
  hikingRoute: 'hiking',
  spot: 'hiking',
  closureClosed: 'closure',
  closureDifficult: 'closure'
};

// ===== データ・スタイル・表示の切替 =====
// 地図データを差し替える(キャッシュからの初期描画・公開データ更新時の再描画で共通)。
// 表示中だった場合は差し替え後も表示を維持する。null で非表示・破棄。
export function setMapdataGeoJSON(geojson) {
  mapdataGeoJSON = geojson;
  rebuildOverlay('emergency');
  rebuildOverlay('hiking');
}

// 通行止め・通行困難地点のデータを差し替える(扱いは setMapdataGeoJSON と同じ)
export function setClosureGeoJSON(geojson) {
  closureGeoJSON = geojson;
  rebuildOverlay('closure');
}

// マーカーの設定の種別 key のスタイルを変え、その種別を描くレイヤーを描き直す(表示中なら即時反映)
export function setOverlayStyle(key, style) {
  if (!(key in styles)) return;
  styles[key] = style;
  rebuildOverlay(OVERLAY_OF_STYLE[key]);
}

// 3つのレイヤーをまとめて表示/非表示にする(ハイキングマップ表示では表示、起動時画面では非表示)
export function setOverlaysVisible(visible) {
  const map = getMap();
  if (!map) return;
  for (const { layer } of Object.values(overlays)) {
    if (!layer) continue;
    if (visible) layer.addTo(map);
    else map.removeLayer(layer);
  }
}

// レイヤーを作り直す。旧レイヤーが表示中だった場合は差し替え後も表示を維持する。
// データが無ければレイヤーを破棄する(地図の初期化前は何もしない)
function rebuildOverlay(name) {
  const map = getMap();
  if (!map) return;
  const overlay = overlays[name];
  const old = overlay.layer;
  const wasVisible = !!old && map.hasLayer(old);
  if (old) map.removeLayer(old);
  overlay.layer = overlay.data() ? overlay.build() : null;
  if (overlay.layer && wasVisible) overlay.layer.addTo(map);
}

// 読み込んだデータの件数を返す(未読込は null)。表示状態に依らず常に実データの件数。
// ポイント=ポイントGPS(緊急ポイント)、ルート=route、スポット=spot。ルート中間点は数えない。
export function getFeatureCounts() {
  if (!mapdataGeoJSON) return { points: null, routes: null, spots: null };
  const countByType = (type) => mapdataGeoJSON.features.filter((f) => f.properties?.type === type).length;
  return {
    points: countByType('ポイントGPS'),
    routes: countByType('route'),
    spots: countByType('spot')
  };
}

// 場所を検索(place-search.js)の対象にする地図データ: 緊急ポイント・ルート・スポット(通行止めは含めない)。
// 各要素は { type: 'point' | 'route' | 'spot', id, name, englishName, latlngs: [[lat, lng], ...] }。
// id は緊急ポイントだけに入れる(ルート・スポットの id は検索の対象にしない)。latlngs はポイント・スポットが1点、
// ルートは地図に描く線と同じ(開始・終了ポイントまで伸ばした線)。地図データが無ければ空の配列
export function getSearchablePlaces() {
  if (!mapdataGeoJSON) return [];
  const TYPES = { 'ポイントGPS': 'point', route: 'route', spot: 'spot' };
  const places = [];
  for (const f of expandRouteFeatures(mapdataGeoJSON).features) {
    const p = f.properties || {};
    const type = TYPES[p.type];
    const g = f.geometry;
    if (!type || !g) continue;
    let latlngs;
    if (g.type === 'Point') latlngs = [[g.coordinates[1], g.coordinates[0]]];
    else if (g.type === 'LineString') latlngs = g.coordinates.map((c) => [c[1], c[0]]);
    else continue;
    places.push({
      type,
      id: type === 'point' ? String(p.id ?? '') : '',
      name: p.name || '',
      englishName: p.englishName || '',
      latlngs
    });
  }
  return places;
}

// 地図データの名称を表示言語で返す。英語表示では英語名(englishName)、無ければ日本語の名称(name)。
// どちらも無ければ空文字(ルートは呼び出し側で区間表記にする)
function featureName(p) {
  return pickLang({ ja: p.name, en: p.englishName || null }) || '';
}

function createPointMarker(latlng, style, className = 'custom-marker') {
  return L.marker(latlng, { icon: buildMarkerIcon(style, { className }) });
}

// ===== 緊急ポイント =====
function buildEmergencyLayer() {
  return L.geoJSON(mapdataGeoJSON, {
    // 同じデータに含まれる route・spot は別レイヤーが描画するため除外する
    filter: (feature) => feature.properties?.type === 'ポイントGPS',
    pointToLayer: (feature, latlng) => createPointMarker(latlng, styles.emergency),
    onEachFeature: (feature, layer) => {
      const p = feature.properties || {};
      const id = p.id ?? '';
      const name = featureName(p);
      layer.bindPopup(`<strong>${escapeHtml(id)}</strong><br>${escapeHtml(name)}`);
    }
  });
}

// ===== 通行止め・通行困難地点 =====
function buildClosureLayer() {
  return L.geoJSON(closureGeoJSON, {
    filter: (feature) => feature.geometry?.type === 'Point',
    pointToLayer: (feature, latlng) => {
      // kind が difficult 以外(closed・不明)は通行止めスタイルで描画する
      const style = feature.properties?.kind === 'difficult'
        ? (styles.closureDifficult || CLOSURE_FALLBACK_STYLES.difficult)
        : (styles.closureClosed || CLOSURE_FALLBACK_STYLES.closed);
      return createPointMarker(latlng, style, 'custom-marker closure-marker');
    },
    onEachFeature: (feature, layer) => {
      // 解除予定日の経過判定を開いた時点の日付で行うため、内容は開くたびに組み立てる
      layer.bindPopup(() => closurePopupHtml(feature.properties || {}));
    }
  });
}

function closurePopupHtml(p) {
  const kind = CLOSURE_KIND_KEYS[p.kind] ? t(CLOSURE_KIND_KEYS[p.kind]) : (p.kind || '');
  const lines = [`<strong>${escapeHtml(p.name ?? p.id ?? '')}</strong>`];
  if (kind) lines.push(escapeHtml(kind));
  if (p.reason) lines.push(t('closure.popupReason', { reason: escapeHtml(p.reason) }));
  // 解除予定日(YYYY-MM-DD)。通行止め・通行困難のどちらにも付き得る。値があるときのみ。
  // 予定日を過ぎても地点は消さず(解除の確認は運用側が行う)、過ぎている旨を添える。
  // 端末の現地日付(YYYY-MM-DD)と文字列で比べる
  if (p.reopenDate) {
    let reopen = t('closure.popupReopen', { date: escapeHtml(p.reopenDate) });
    if (p.reopenDate < formatLocalDate(Date.now(), '-')) reopen += t('closure.popupReopenPassed');
    lines.push(reopen);
  }
  if (p.note) lines.push(escapeHtml(p.note));
  if (p.updatedAt) lines.push(t('closure.popupUpdated', { date: escapeHtml(p.updatedAt) }));
  return lines.join('<br>');
}

// ===== ハイキング(ルート+スポット) =====
function sameCoord(a, b) {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1];
}

// ルート線の表示用コピーを作る(元データは変更しない)。
// 配信データの LineString は中間点のみのため、開始ポイント・終了ポイントの座標
// (startPointGPS / endPointGPS。null は補わない)をつないで端点まで伸ばす。
// 中間点と同じ座標の端点は重ねない。線にならない(2点未満の)ルートは描かない。
function expandRouteFeatures(gj) {
  if (!gj) return gj;
  const features = gj.features.flatMap((f) => {
    const p = f.properties;
    if (p?.type !== 'route' || f.geometry?.type !== 'LineString') return [f];
    const mid = f.geometry.coordinates;
    if (mid.length === 0) return [];
    const start = p.startPointGPS;
    const end = p.endPointGPS;
    const coords = [
      ...(start && !sameCoord(start, mid[0]) ? [start] : []),
      ...mid,
      ...(end && !sameCoord(end, mid[mid.length - 1]) ? [end] : [])
    ];
    if (coords.length < 2) return [];
    return [{ ...f, geometry: { ...f.geometry, coordinates: coords } }];
  });
  return { ...gj, features };
}

// ルートの id(`route_<開始>_to_<終了>`)を「開始 〜 終了」の区間表記にする。
// 想定外の書式なら id をそのまま返す。
function routeSectionLabel(id) {
  const m = /^route_(.+?)_to_(.+)$/.exec(String(id ?? ''));
  return m ? `${m[1]} 〜 ${m[2]}` : String(id ?? '');
}

function buildHikingLayer() {
  // ルートに開始/終了ポイントを補ったコピーを描画する
  const data = expandRouteFeatures(mapdataGeoJSON);
  return L.geoJSON(data, {
    // 描画するのは route(線)と spot(点)のみ。緊急ポイント('ポイントGPS')は
    // 緊急ポイントレイヤーが描画するため除外する(二重描画とスポット色の巻き込みを防ぐ)。
    filter: (feature) =>
      feature.properties?.type === 'route' || feature.properties?.type === 'spot',
    style: () => ({
      color: styles.hikingRoute?.color || '#ea580c',
      weight: styles.hikingRoute?.size || 3,
      opacity: 0.85
    }),
    pointToLayer: (feature, latlng) => createPointMarker(latlng, styles.spot),
    // ポップアップは「スポット」と「ルート(端点まで伸ばした線全体)」に付ける。
    // 配信データのスポットは名称(と英語名)・座標だけを持つ(id は編集用のため公開されない)。
    // ルートの名称は任意のため、表示できる名称が無ければ id から区間表記を組み立てて表示する。
    // 端点の緊急ポイントと重なる所は、マーカーが上の層にあって勝つ。
    onEachFeature: (feature, layer) => {
      const p = feature.properties || {};
      if (p.type === 'spot') {
        layer.bindPopup(`<strong>${escapeHtml(featureName(p))}</strong>`);
        return;
      }
      if (p.type === 'route') {
        // bindPopup は使わない。押した位置の近くにポイントがあればそちらを開くため(→ openRouteOrNearbyPoint)
        const html = `<strong>${escapeHtml(featureName(p) || routeSectionLabel(p.id))}</strong>`;
        layer.on('click', (e) => openRouteOrNearbyPoint(e, html));
      }
    }
  });
}

// ===== ルートのタップとポイントの優先 =====
// ルート(線)は Canvas で「太さ/2 + TAP_TOLERANCE」の幅で当たるが、ポイント(divIcon)は
// 見た目の大きさでしか当たらない。そのままではポイントのすぐ外を押すと近くのルートが反応して
// しまうため、ルートが押されたときは、ポイントにもルートと同じ余裕
// (中心から アイコンの一辺/2 + TAP_TOLERANCE 以内)で当たっているかを調べ、当たっていれば
// 一番近いポイントのポップアップを優先して開く。当たっていなければルートのポップアップを開く。
// 地図の何も無い所を押したときは対象外(開いているポップアップを閉じる操作のため)。
function openRouteOrNearbyPoint(e, html) {
  // 地図の click(開いたポップアップを閉じる処理)へ伝えない。bindPopup の既定動作と同じ
  L.DomEvent.stop(e);
  const point = findTappedPoint(e.containerPoint);
  if (point) {
    point.openPopup();
    return;
  }
  L.popup().setLatLng(e.latlng).setContent(html).openOn(getMap());
}

// 押した位置(コンテナ座標)に当たっているポイントのうち、一番近いものを返す(無ければ null)。
// 対象はポップアップを持つマーカー(緊急ポイント・スポット・通行止め・通行困難地点)で、表示中のレイヤーのみ
function findTappedPoint(containerPoint) {
  const map = getMap();
  let best = null;
  let bestDist = Infinity;
  for (const group of [overlays.emergency.layer, overlays.closure.layer, overlays.hiking.layer]) {
    if (!group || !map.hasLayer(group)) continue;
    group.eachLayer((layer) => {
      if (!(layer instanceof L.Marker) || !layer.getPopup()) return;
      const iconSize = layer.options.icon?.options?.iconSize?.[0] || 0;
      const dist = map.latLngToContainerPoint(layer.getLatLng()).distanceTo(containerPoint);
      if (dist <= iconSize / 2 + TAP_TOLERANCE && dist < bestDist) {
        best = layer;
        bestDist = dist;
      }
    });
  }
  return best;
}
