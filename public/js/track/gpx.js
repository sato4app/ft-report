// 移動経路の出力・読み込み(GPX 1.1)
// 経路(track.js の getTrackSegments の点列)と GPX 文字列の相互変換だけを担う。
// 画面の操作(ファイル名・ダウンロード・ファイル選択)は track-ui.js が行う。
import { t } from '../common/i18n.js';
import { escapeXml } from '../common/utils.js';

// GPX 1.1 文字列を生成(トラック1本・経路1本ごとに trkseg 1本、各点に記録時刻を含む)。
// 経路を trkseg で分けるため、出力した GPX を読み込み直すと同じ経路構成に戻る。
// 記録点に名前があれば <name> で付ける(GPX 1.1 の順序は <time> の後)。名前は読み込んだ GPX に
// 付いていたものだけ(以前の版が撮影地点に付けた写真の名前など)で、本アプリの記録では付けない。
export function buildTrackGpx(segments, name) {
  const trksegs = segments.map((points) => {
    const trkpts = points.map((p) => {
      const time = p.timeMs ? `<time>${new Date(p.timeMs).toISOString()}</time>` : '';
      const pointName = p.name ? `<name>${escapeXml(p.name)}</name>` : '';
      return `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}">${time}${pointName}</trkpt>`;
    }).join('\n');
    return `    <trkseg>\n${trkpts}\n    </trkseg>`;
  }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="minoh-hiking" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    '  <trk>\n' +
    `    <name>${escapeXml(name)}</name>\n` +
    `${trksegs}\n` +
    '  </trk>\n' +
    '</gpx>\n';
}

// GPX 文字列から移動経路を取り出し、経路ごとの点列の配列で返す(<time> と <name> は任意)。
// trkseg 1本を1本の経路として扱うため、記録を分けて出力した GPX
// (本アプリの複数経路出力を含む)をそのまま複数の経路として復元できる。
// <name> は記録点の名前(以前の版が撮影地点に付けた写真の名前など)で、そのまま保持して再出力に戻す。
export function parseTrackGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error(t('track.importInvalidXml'));
  const toPoints = (nodes) => [...nodes]
    .map((node) => {
      const timeText = node.getElementsByTagName('time')[0]?.textContent;
      const ms = timeText ? Date.parse(timeText) : NaN;
      const nameText = node.getElementsByTagName('name')[0]?.textContent.trim();
      return {
        lat: parseFloat(node.getAttribute('lat')),
        lng: parseFloat(node.getAttribute('lon')),
        timeMs: Number.isFinite(ms) ? ms : null,
        name: nameText || null
      };
    })
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

  const segments = [...doc.getElementsByTagName('trkseg')]
    .map((seg) => toPoints(seg.getElementsByTagName('trkpt')))
    .filter((points) => points.length > 0);
  if (segments.length > 0) return segments;
  // trkseg を持たない GPX への保険: 文書順の trkpt を1本の経路として扱う
  const all = toPoints(doc.getElementsByTagName('trkpt'));
  return all.length > 0 ? [all] : [];
}
