// マーカーの図形(SVG)とアイコン
// 地図のマーカー(緊急ポイント・通行止め・現在地点・移動記録・写真撮影地点など)と、
// マーカーの設定の形状欄の見本(marker-settings.js)・使い方ガイドの本文中の図形(guide.js)で共用する。
import * as L from 'leaflet';

// マーカーの形状を SVG で描く。size は一辺(px。4〜80 に丸める)
export function shapeToSVG(shape, color, size) {
  const s = Math.max(4, Math.min(80, size || 10));
  const c = s / 2;
  const r = (s - 2) / 2;
  const stroke = '#ffffff';
  switch (shape) {
    case 'circle':
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><circle cx="${c}" cy="${c}" r="${r}" fill="${color}" stroke="${stroke}" stroke-width="1"/></svg>`;
    case 'square':
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><rect x="1" y="1" width="${s - 2}" height="${s - 2}" fill="${color}" stroke="${stroke}" stroke-width="1"/></svg>`;
    case 'triangle': {
      const pts = `${c},1 ${s - 1},${s - 1} 1,${s - 1}`;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><polygon points="${pts}" fill="${color}" stroke="${stroke}" stroke-width="1"/></svg>`;
    }
    case 'diamond': {
      const pts = `${c},1 ${s - 1},${c} ${c},${s - 1} 1,${c}`;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><polygon points="${pts}" fill="${color}" stroke="${stroke}" stroke-width="1"/></svg>`;
    }
    case 'star':
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><polygon points="${starPoints(s)}" fill="${color}" stroke="${stroke}" stroke-width="1"/></svg>`;
    case 'line':
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><line x1="1" y1="${c}" x2="${s - 1}" y2="${c}" stroke="${color}" stroke-width="${Math.max(2, Math.round(s / 3))}"/></svg>`;
    case 'noThoroughfare': {
      // 通行止め(ISO 7010 P004「No thoroughfare」・道路標識「歩行者通行止め」風)。
      // 白地に色の輪と斜線、中に黒の歩く人。斜線は人の上に重ねる。
      // 赤丸に白の横棒(⛔)は車両進入禁止の標識と同じ形で誤解されやすいため使わない。
      // 人の形は 100 四方で設計して輪の内側に収める(小さいサイズでは読めなくてもよい)
      const glyph = '#111827';
      const sw = Math.max(2, s * 0.13);          // 輪・斜線の太さ
      const rr = s / 2 - 1 - sw / 2;             // 輪の中心半径(外側 1px は白の縁)
      const ri = rr - sw / 2;                    // 輪の内側の半径
      const k = (ri * 1.7) / 100;
      const o = c - 50 * k;
      const q = (x, y) => `${(o + x * k).toFixed(2)},${(o + y * k).toFixed(2)}`;
      const body =
        `M${q(52, 31)} L${q(46, 60)} ` +
        `M${q(50, 36)} L${q(37, 50)} L${q(33, 62)} ` +
        `M${q(50, 36)} L${q(62, 47)} L${q(72, 51)} ` +
        `M${q(46, 60)} L${q(58, 76)} L${q(61, 93)} ` +
        `M${q(46, 60)} L${q(37, 78)} L${q(25, 89)}`;
      const d = ri * 0.74;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">` +
        `<circle cx="${c}" cy="${c}" r="${(s / 2 - 0.5).toFixed(2)}" fill="${stroke}"/>` +
        `<circle cx="${c}" cy="${c}" r="${rr.toFixed(2)}" fill="${stroke}" stroke="${color}" stroke-width="${sw.toFixed(2)}"/>` +
        `<path d="${body}" fill="none" stroke="${glyph}" stroke-width="${(13 * k).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<circle cx="${(o + 56 * k).toFixed(2)}" cy="${(o + 15 * k).toFixed(2)}" r="${(11 * k).toFixed(2)}" fill="${glyph}"/>` +
        `<line x1="${(c - d).toFixed(2)}" y1="${(c - d).toFixed(2)}" x2="${(c + d).toFixed(2)}" y2="${(c + d).toFixed(2)}" stroke="${color}" stroke-width="${(sw * 0.9).toFixed(2)}"/></svg>`;
    }
    case 'warning': {
      // 警戒(日本の道路標識の警戒標識風)。色のひし形に黒の外枠と「!」、その外側にひし形に沿った白の縁。
      // 利用者に日本人が多いため、国際的な ⚠(三角)ではなく見慣れたひし形にしている。
      // 黄色は地理院地図の等高線(黄土色)・県道(黄色)に溶け込むため、黒枠で輪郭を出し、
      // 白の縁で背景の線から切り離す(丸い下地は通行止めの丸と形が紛れるため使わない)。
      // ひし形は s 四方のまま、縁の分だけ SVG を広げる(アイコンの大きさは shapeBoxSize)。
      // 「!」はフォント差をなくすため文字ではなく棒と点で描く
      const glyph = '#111827';
      const pad = shapeHaloPad(shape, s);
      const S = s + pad * 2;
      const sw = Math.max(1.5, s * 0.09);       // 黒枠の太さ
      const ring = Math.max(1.5, s * 0.1);      // 黒枠の外に見える白の縁の幅
      const inset = sw / 2 + 0.5;
      const p = (x, y) => `${(x + pad).toFixed(1)},${(y + pad).toFixed(1)}`;
      const pts = `${p(c, inset)} ${p(s - inset, c)} ${p(c, s - inset)} ${p(inset, c)}`;
      const w = Math.max(2, s * 0.11);
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">` +
        `<polygon points="${pts}" fill="${stroke}" stroke="${stroke}" stroke-width="${(sw + ring * 2).toFixed(1)}" stroke-linejoin="round"/>` +
        `<polygon points="${pts}" fill="${color}" stroke="${glyph}" stroke-width="${sw.toFixed(1)}" stroke-linejoin="round"/>` +
        `<rect x="${(c - w / 2 + pad).toFixed(1)}" y="${(s * 0.27 + pad).toFixed(1)}" width="${w.toFixed(1)}" height="${(s * 0.3).toFixed(1)}" rx="${(w / 2).toFixed(1)}" fill="${glyph}"/>` +
        `<circle cx="${c + pad}" cy="${(s * 0.7 + pad).toFixed(1)}" r="${(w * 0.55).toFixed(1)}" fill="${glyph}"/></svg>`;
    }
    case 'camera': {
      // 写真撮影地点。色の丸に白の縁、中に白抜きのカメラ(レンズは丸の色が透けて見える)。
      // カメラの形は 24 四方で設計し、丸の内側に収まるよう縮めて中央に置く
      // (小さいサイズでは細部が読めなくてもよい)
      const sw = Math.max(1.5, s * 0.08);        // 白の縁の太さ
      const g = s * 0.6;                          // カメラの一辺
      const k = g / 24;
      const o = c - g / 2;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">` +
        `<circle cx="${c}" cy="${c}" r="${(s / 2 - sw / 2).toFixed(2)}" fill="${color}" stroke="${stroke}" stroke-width="${sw.toFixed(2)}"/>` +
        `<path transform="translate(${o.toFixed(2)} ${o.toFixed(2)}) scale(${k.toFixed(4)})" fill="${stroke}" fill-rule="evenodd" ` +
        `d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>`;
    }
    default:
      return shapeToSVG('circle', color, size);
  }
}

// 形状の外側に付ける縁の幅(片側 px)。現在は警戒(warning)の白の縁のみ
function shapeHaloPad(shape, s) {
  return shape === 'warning' ? Math.ceil(Math.max(1.5, s * 0.1)) + 1 : 0;
}

// shapeToSVG が返す SVG の一辺(px)。縁を持つ形状はマーカーのサイズより大きくなる
function shapeBoxSize(shape, size) {
  const s = Math.max(4, Math.min(80, size || 10));
  return s + shapeHaloPad(shape, s) * 2;
}

function starPoints(s) {
  const cx = s / 2;
  const cy = s / 2;
  const outerR = (s - 2) / 2;
  const innerR = outerR * 0.4;
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    const r = i % 2 === 0 ? outerR : innerR;
    pts.push(`${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`);
  }
  return pts.join(' ');
}

// マーカー用 divIcon を生成する共通関数(ポイント系・移動記録系・現在地点・写真撮影地点のマーカーで共用)。
// style の欠損値は fallback で補い、rotationDeg を与えると中心まわりに回転する。
export function buildMarkerIcon(style, {
  fallbackShape = 'circle',
  fallbackColor = '#dc2626',
  fallbackSize = 10,
  rotationDeg = 0,
  className = 'custom-marker'
} = {}) {
  const shape = style?.shape || fallbackShape;
  const svg = shapeToSVG(shape, style?.color || fallbackColor, style?.size || fallbackSize);
  // 縁を持つ形状(warning)は SVG がサイズより大きいので、アイコンの枠も SVG に合わせる
  const size = shapeBoxSize(shape, style?.size || fallbackSize);
  const html = rotationDeg
    ? `<div style="width:${size}px;height:${size}px;transform:rotate(${rotationDeg}deg);transform-origin:50% 50%;">${svg}</div>`
    : svg;
  return L.divIcon({
    html,
    className,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}
