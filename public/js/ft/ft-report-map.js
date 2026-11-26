// 報告書の地図の画像(仕様 docs/ft-funcspec-found.md の 5.3)。
// 地理院タイル(標準地図)を fetch で取り、画像(canvas)に並べ、その上に
// ハイキングルート・緊急ポイント・写真の位置(番号付きの丸)・縮尺・出典を描く。
// マップ画面の表示設定(各レイヤーの表示・非表示)には関係なく描く。
// タイルは Service Worker を通るので、ダウンロード済みの範囲は圏外でも描ける
// (マップ画面と同じく CORS 付きで取ったタイルなので、画像に描いても書き出せる)。
import { TILE_URL_BASE } from '../common/config.js';

const TILE_SIZE = 256;
// ズームの上限(写真が 1 枚・近いときに拡大しすぎない)と下限
const MAX_ZOOM = 17;
const MIN_ZOOM = 5;
// これより小さいズームになるときは、入力の画面で注意を出す(仕様 4.5)
export const FT_MAP_WARN_ZOOM = 14;
// 緊急ポイントの番号はこのズーム以上で、印はこのズーム以上で描く
// (縮尺が小さい地図では緊急ポイントが密集し、重なって読めなくなるため)
const POINT_LABEL_MIN_ZOOM = 14;
const POINT_MIN_ZOOM = 12;
// 写真の範囲の外側に足す余白(地図の幅・高さに対する割合。片側)
const PAD_RATIO = 0.12;
// タイルを同時に取りに行く数
const TILE_CONCURRENCY = 6;

// 描く色(既定のマーカーの色に合わせる。config.js の MARKER_TYPES)
const ROUTE_COLOR = '#007d00';
const POINT_COLOR = '#00AA00';
const POINT_LABEL_COLOR = '#065f46';
const PHOTO_COLOR = '#ea580c';
const MISSING_TILE_COLOR = '#d1d5db';
const FONT_FAMILY = '"Hiragino Kaku Gothic ProN", "Hiragino Sans", "Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic", Meiryo, sans-serif';

// 緯度経度を、ズーム z の世界座標(ピクセル)にする(Web メルカトル)
function project(lat, lng, z) {
  const size = TILE_SIZE * 2 ** z;
  const sin = Math.sin(lat * Math.PI / 180);
  return {
    x: (lng + 180) / 360 * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size
  };
}

// 写真が全部入るズームと、地図の中心(そのズームの世界座標)を求める。
// viewW・viewH は地図の大きさ(タイルの 1px を 1 とした論理ピクセル)。
// 余白を足して収まる、いちばん大きい整数のズームを選ぶ(上限 17・下限 5)
export function computeMapView(latLngs, viewW, viewH) {
  const pts = latLngs.map(([lat, lng]) => project(lat, lng, 0));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const usableW = viewW * (1 - 2 * PAD_RATIO);
  const usableH = viewH * (1 - 2 * PAD_RATIO);
  const zx = maxX > minX ? Math.log2(usableW / (maxX - minX)) : Infinity;
  const zy = maxY > minY ? Math.log2(usableH / (maxY - minY)) : Infinity;
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(Math.min(zx, zy))));
  const scale = 2 ** zoom;
  return { zoom, center: { x: (minX + maxX) / 2 * scale, y: (minY + maxY) / 2 * scale } };
}

// 決まった数ずつ並べて動かす
async function runLimited(jobs, limit) {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await job();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}

async function fetchTileBitmap(z, x, y) {
  const res = await fetch(`${TILE_URL_BASE}/${z}/${x}/${y}.png`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return createImageBitmap(await res.blob());
}

// 縮尺の目安の長さ(m)。maxPx(論理ピクセル)に収まる、きりのよい長さを選ぶ
function pickScaleLength(metersPerPx, maxPx) {
  const candidates = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
  let best = candidates[0];
  for (const m of candidates) {
    if (m / metersPerPx <= maxPx) best = m;
  }
  return best;
}

// 白い縁取りの付いた文字(地図の上でも読めるように)
function drawHaloText(ctx, text, x, y, { fill, halo = '#fff', haloWidth }) {
  ctx.lineJoin = 'round';
  ctx.strokeStyle = halo;
  ctx.lineWidth = haloWidth;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

// 地図の画像を作る。
//   photos:   報告書の写真(ft-report-data.js の buildReport の photos。no・lat・lng を使う)
//   features: 地図データ(loadMapFeatures の値。null なら緊急ポイント・ルートは描かない)
//   width・height: 画像の大きさ(px)
//   scale:    タイル 1px を何 px で描くか(報告書は 200dpi なので、2 倍にして地図の文字を読める大きさにする)
// 返す値: { canvas, zoom, missingTiles(取れなかったタイルの数) }
export async function renderReportMap({ photos, features, width, height, scale = 2 }) {
  const viewW = width / scale;
  const viewH = height / scale;
  const { zoom, center } = computeMapView(photos.map((p) => [p.lat, p.lng]), viewW, viewH);
  const left = center.x - viewW / 2;
  const top = center.y - viewH / 2;
  // 世界座標 → 画像の座標
  const toCanvas = (lat, lng) => {
    const p = project(lat, lng, zoom);
    return { x: (p.x - left) * scale, y: (p.y - top) * scale };
  };

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = MISSING_TILE_COLOR;
  ctx.fillRect(0, 0, width, height);

  // ----- タイル -----
  const n = 2 ** zoom;
  const tx0 = Math.floor(left / TILE_SIZE);
  const tx1 = Math.floor((left + viewW) / TILE_SIZE);
  const ty0 = Math.max(0, Math.floor(top / TILE_SIZE));
  const ty1 = Math.min(n - 1, Math.floor((top + viewH) / TILE_SIZE));
  let missingTiles = 0;
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      // 隣り合うタイルの境目に隙間ができないよう、端を整数にそろえる
      const dx = Math.round((tx * TILE_SIZE - left) * scale);
      const dy = Math.round((ty * TILE_SIZE - top) * scale);
      const dw = Math.round(((tx + 1) * TILE_SIZE - left) * scale) - dx;
      const dh = Math.round(((ty + 1) * TILE_SIZE - top) * scale) - dy;
      const x = ((tx % n) + n) % n;
      jobs.push(async () => {
        try {
          const bitmap = await fetchTileBitmap(zoom, x, ty);
          ctx.drawImage(bitmap, dx, dy, dw, dh);
          bitmap.close?.();
        } catch {
          missingTiles++;
        }
      });
    }
  }
  await runLimited(jobs, TILE_CONCURRENCY);

  // ----- ハイキングルート -----
  if (features?.routes) {
    ctx.save();
    ctx.strokeStyle = ROUTE_COLOR;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 4 * scale;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const route of features.routes) {
      const pts = route.map(([lat, lng]) => toCanvas(lat, lng));
      // 地図の外だけを通る線は描かない
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      if (Math.max(...xs) < 0 || Math.min(...xs) > width || Math.max(...ys) < 0 || Math.min(...ys) > height) continue;
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
    }
    ctx.restore();
  }

  // ----- 緊急ポイント(印と番号。縮尺が小さいときは番号・印を省く) -----
  if (features?.points && zoom >= POINT_MIN_ZOOM) {
    const r = 5 * scale;
    ctx.save();
    ctx.font = `bold ${11 * scale}px ${FONT_FAMILY}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const pt of features.points) {
      const p = toCanvas(pt.lat, pt.lng);
      if (p.x < -r || p.x > width + r || p.y < -r || p.y > height + r) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = POINT_COLOR;
      ctx.fill();
      ctx.lineWidth = 1.5 * scale;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      if (pt.id && zoom >= POINT_LABEL_MIN_ZOOM) {
        drawHaloText(ctx, pt.id, p.x + r + 2 * scale, p.y, {
          fill: POINT_LABEL_COLOR, haloWidth: 3 * scale
        });
      }
    }
    ctx.restore();
  }

  // ----- 写真の位置(番号付きの丸)。小さい番号が上に来るよう、後ろの番号から描く -----
  {
    const r = 11 * scale;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const photo of [...photos].reverse()) {
      const p = toCanvas(photo.lat, photo.lng);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = PHOTO_COLOR;
      ctx.fill();
      ctx.lineWidth = 2.5 * scale;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      const label = String(photo.no);
      ctx.font = `bold ${(label.length > 1 ? 11 : 13) * scale}px ${FONT_FAMILY}`;
      ctx.fillStyle = '#fff';
      ctx.fillText(label, p.x, p.y + 0.5 * scale);
    }
    ctx.restore();
  }

  // ----- 縮尺の目安(左下) -----
  {
    const lat = photos.reduce((s, p) => s + p.lat, 0) / photos.length;
    const metersPerPx = 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** zoom;
    const meters = pickScaleLength(metersPerPx, 110);
    const barW = meters / metersPerPx * scale;
    const label = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
    const x = 10 * scale;
    const y = height - 12 * scale;
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.fillRect(x - 4 * scale, y - 18 * scale, barW + 8 * scale, 24 * scale);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2 * scale;
    ctx.beginPath();
    ctx.moveTo(x, y - 6 * scale);
    ctx.lineTo(x, y);
    ctx.lineTo(x + barW, y);
    ctx.lineTo(x + barW, y - 6 * scale);
    ctx.stroke();
    ctx.font = `${10 * scale}px ${FONT_FAMILY}`;
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, x + barW / 2, y - 6 * scale);
    ctx.restore();
  }

  // ----- 出典(右下) -----
  {
    const text = '出典：国土地理院';
    ctx.save();
    ctx.font = `${10 * scale}px ${FONT_FAMILY}`;
    const w = ctx.measureText(text).width;
    const padX = 4 * scale;
    const h = 16 * scale;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.fillRect(width - w - padX * 2, height - h, w + padX * 2, h);
    ctx.fillStyle = '#111';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, width - padX, height - h / 2);
    ctx.restore();
  }

  return { canvas, zoom, missingTiles };
}
