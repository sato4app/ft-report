// 報告書の配置と PDF の作成(仕様 docs/ft-funcspec-found.md の 5.1・5.2)。
// 様式(山麓保全委員会 山林部会活動報告)に合わせて、A4 縦のページを 1 枚ずつ画像(canvas)に描き、
// JPEG にして PDF(ft-pdf.js)に並べる。文字はスマホの日本語の字体で描く。
//
// ページの中身:
//   1 ページ目の上部 … 番号の枠(緑。空欄)と見出し、表(日時・天気・気温・記入者 / 対象案件・場所 /
//                      通報先・通報手段・通報日時 / 参加者)
//   活動内容の欄     … 本文 → 地図 → 写真(1 行に 3 枚。各写真の上に見出し)の順に流し込む。
//                      収まらない分は次のページへ送る(本文は行の途中で、写真は行ごとに。地図は分けない)
//   連絡事項の欄     … 最後のページの末尾。通報先へ連絡・行政への連絡(選んだ方を丸で囲む)と本文
//   2 ページ目以降   … 上部に「タイトル（続き）」と対象案件
//   どのページも     … 下に「1 / 3」の形のページ番号
import { FT_REPORT_TITLE } from './ft-report-data.js';
import { renderReportMap, computeMapView } from './ft-report-map.js';
import { buildImagePdf } from './ft-pdf.js';

// ===== 寸法(A4 を 200dpi 相当で描く) =====
// 表の列の幅・欄の組み方・色・罫線は、様式の元の Excel に合わせる(Excel はリポジトリに置かない。数値は仕様書の 5.2):
//   列 A=11(欄の名前)、B=1.11(すき間)、C〜L=8.78 ずつ、M=9.22(合計 109.1。印刷で約 182mm)
//   見出しの行の下は太線、活動内容・連絡事項の欄は点線の罫線、欄の名前の地は #EEECE1
//   字体は Meiryo UI 11pt(85% で印刷)。ここではスマホで読みやすいよう少し大きくしている
const PAGE_W = 1654;
const PAGE_H = 2339;
const MM = PAGE_W / 210;   // 1mm のピクセル数
const PT = 200 / 72;       // 1pt のピクセル数
const MARGIN_X = Math.round(14 * MM);
const MARGIN_TOP = Math.round(12 * MM);
const MARGIN_BOTTOM = Math.round(14 * MM);
const LEFT = MARGIN_X;
const RIGHT = PAGE_W - MARGIN_X;
const CONTENT_BOTTOM = PAGE_H - MARGIN_BOTTOM;
const CONTENT_W = RIGHT - LEFT;
const JPEG_QUALITY = 0.85;

// 文字(様式は Meiryo UI。無い端末では、その端末の日本語の字体)
const FONT_FAMILY = '"Hiragino Kaku Gothic ProN", "Hiragino Sans", "Meiryo UI", Meiryo, "Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic", sans-serif';
const FONT_PX = Math.round(10.5 * PT);    // 本文・欄の値
const LABEL_PX = Math.round(10 * PT);     // 欄の名前
const SMALL_PX = Math.round(9 * PT);      // 連絡の欄の名前・ページ番号
const TITLE_PX = Math.round(13 * PT);     // 見出し
const LINE_H = Math.round(FONT_PX * 1.45);

// 色
const COLOR_TEXT = '#111';
const COLOR_LINE = '#222';
const COLOR_LABEL_BG = '#eeece1';      // 欄の名前の地(様式の薄いベージュ)
const COLOR_NUMBER_BG = '#00b050';     // 番号の枠(様式の緑)
const COLOR_CONTACT_BG = '#d8e4bc';    // 「通報先へ連絡」「行政への連絡」の地

// 表の列(様式の Excel の列の幅の比で割り付ける)
const COL_UNIT = CONTENT_W / 109.1;
const COL_A = Math.round(11 * COL_UNIT);     // 欄の名前(日時・対象案件・通報先・参加者・活動内容・連絡事項)
const COL_B = Math.round(1.11 * COL_UNIT);   // 欄の名前と中身のすき間
const COL_C = Math.round(8.78 * COL_UNIT);   // C〜L の 1 列
const LABEL_W = COL_A;
const CELL_PAD_X = 12;
const CELL_PAD_Y = 8;
const ROW_MIN_H = Math.round(7 * MM);
const NUMBER_BOX_W = COL_A;
const NUMBER_BOX_H = Math.round(11 * MM);
const HEADER_BAR_H = 6;

// 活動内容の欄
const AREA_X = LEFT + LABEL_W;
const AREA_PAD = COL_B;
const INNER_X = AREA_X + AREA_PAD;
const INNER_W = RIGHT - AREA_PAD - INNER_X;
const ITEM_GAP = 20;
const MAP_W = INNER_W;
const MAP_H = Math.round(INNER_W * 2 / 3);   // 地図の縦横比 3:2
const MAP_SCALE = 2;                          // 地図のタイル 1px を 2px で描く(地図の文字を読める大きさにする)
const PHOTO_COLS = 3;
const PHOTO_GAP = 20;
const PHOTO_CELL_W = Math.floor((INNER_W - PHOTO_GAP * (PHOTO_COLS - 1)) / PHOTO_COLS);
const PHOTO_H = Math.round(PHOTO_CELL_W * 3 / 4);
const CAPTION_MAX_LINES = 2;
const CAPTION_GAP = 6;

// 2 ページ目以降の上部
const CONT_HEADER_H = 64;
const CONT_AREA_TOP = MARGIN_TOP + CONT_HEADER_H + 16;

// 行の頭に来ないようにする文字(前の行の末尾にぶら下げる)
const NO_LINE_START = new Set(Array.from('、。，．,.）)」』】〕〉》]}！？!?ー…'));

function font(px, bold = false) {
  return `${bold ? 'bold ' : ''}${px}px ${FONT_FAMILY}`;
}

// 文字を幅 maxW で折り返す(改行はそのまま行の区切り)。空の文字なら空の配列
function wrapText(ctx, text, maxW) {
  const src = String(text ?? '');
  if (!src) return [];
  const lines = [];
  for (const para of src.split(/\r?\n/)) {
    let line = '';
    for (const ch of Array.from(para)) {
      const next = line + ch;
      if (line && !NO_LINE_START.has(ch) && ctx.measureText(next).width > maxW) {
        lines.push(line);
        line = /\s/.test(ch) ? '' : ch;   // 折り返す所の空白は次の行の頭に残さない
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

// 行数を max までにする(切った場合は最後の行の末尾を「…」にする)
function clampLines(lines, max) {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  kept[max - 1] = `${Array.from(kept[max - 1]).slice(0, -1).join('')}…`;
  return kept;
}

// 地図のズーム(入力の画面で、縮尺が小さすぎるときの注意に使う。仕様 4.5)
export function estimateReportMapZoom(latLngs) {
  return computeMapView(latLngs, MAP_W / MAP_SCALE, MAP_H / MAP_SCALE).zoom;
}

// ===== 表(1 ページ目の上部) =====
// 各行は欄の並び。label は欄の名前、text は値。w を省いた欄は行の残りの幅を使う。
// 欄の組み方は様式の Excel と同じ(A=欄の名前、値は B から。C〜L は 1 列 COL_C、M は残り)
//   日時 B〜G / 天気 H / I / 気温 J / K / 記入者 L / M
//   対象案件 B〜G / 場所 H / I〜M
//   通報先 B〜E / 通報手段 F / G〜I / 通報日時 J / K〜M
//   参加者 B〜M
function tableRows(r) {
  return [
    [
      { label: '日　時', w: COL_A }, { text: r.date, w: COL_B + COL_C * 5 },
      { label: '天気', w: COL_C }, { text: r.weather, w: COL_C },
      { label: '気温', w: COL_C }, { text: r.temperature, w: COL_C },
      { label: '記入者', w: COL_C }, { text: r.writer }
    ],
    [
      { label: '対象案件', w: COL_A }, { text: r.subject, w: COL_B + COL_C * 5 },
      { label: '場所', w: COL_C }, { text: r.place }
    ],
    [
      { label: '通報先', w: COL_A }, { text: r.reportTo, w: COL_B + COL_C * 3 },
      { label: '通報手段', w: COL_C }, { text: r.reportMeans, w: COL_C * 3 },
      { label: '通報日時', w: COL_C }, { text: r.reportDate }
    ],
    [
      { label: '参加者', w: COL_A }, { text: r.participants }
    ]
  ];
}

// 欄の名前の字の大きさ(欄の幅に入らなければ小さくする)
function labelFontPx(ctx, label, w) {
  let px = LABEL_PX;
  ctx.font = font(px);
  while (px > 18 && ctx.measureText(label).width > w - 12) {
    px -= 1;
    ctx.font = font(px);
  }
  return px;
}

// 欄の幅を決め、値を折り返し、行の高さを求める
function measureTable(ctx, r) {
  return tableRows(r).map((cells) => {
    let used = 0;
    const laid = cells.map((c) => {
      const w = c.w ?? (CONTENT_W - used);
      used += w;
      if (c.label) return { ...c, w, lines: [c.label], px: labelFontPx(ctx, c.label, w) };
      ctx.font = font(FONT_PX);
      return { ...c, w, lines: wrapText(ctx, c.text, w - CELL_PAD_X * 2) };
    });
    const maxLines = Math.max(1, ...laid.map((c) => c.lines.length));
    return { cells: laid, h: Math.max(ROW_MIN_H, maxLines * LINE_H + CELL_PAD_Y * 2) };
  });
}

// ===== ページの組み立て =====
// どの中身をどのページのどの位置に置くかを決める(描く前に、全部のページ数を知るため)
function planPages(ctx, report) {
  const table = measureTable(ctx, report);
  const tableTop = MARGIN_TOP + NUMBER_BOX_H + HEADER_BAR_H + 22;
  const tableBottom = tableTop + table.reduce((s, row) => s + row.h, 0);

  const pages = [];
  let page = null;
  let y = 0;
  const startPage = (first) => {
    if (page) page.endY = y;   // 前のページの中身の終わり(ここから下に罫線を引く)
    page = {
      first,
      table: first ? table : null,
      tableTop,
      areaTop: first ? tableBottom : CONT_AREA_TOP,
      areaBottom: CONTENT_BOTTOM,
      items: [],
      notes: null
    };
    pages.push(page);
    y = page.areaTop + AREA_PAD;
  };
  // 高さ h の中身が今のページに収まらなければ次のページへ(ページが空なら、そのまま置く)
  const ensure = (h) => {
    if (y + h > page.areaBottom - AREA_PAD && page.items.length > 0) startPage(false);
  };
  startPage(true);

  ctx.font = font(FONT_PX);
  // 本文(行の途中で次のページへ送る)
  const bodyLines = wrapText(ctx, report.body, INNER_W);
  for (const text of bodyLines) {
    ensure(LINE_H);
    page.items.push({ type: 'text', text, y });
    y += LINE_H;
  }
  if (bodyLines.length > 0) y += ITEM_GAP / 2;

  // 地図(分けない)
  ensure(MAP_H);
  page.items.push({ type: 'map', y });
  y += MAP_H + ITEM_GAP;

  // 写真(3 枚ずつの行で送る)
  for (let i = 0; i < report.photos.length; i += PHOTO_COLS) {
    const row = report.photos.slice(i, i + PHOTO_COLS);
    const captions = row.map((p) => clampLines(wrapText(ctx, p.heading, PHOTO_CELL_W), CAPTION_MAX_LINES));
    const captionH = Math.max(1, ...captions.map((c) => c.length)) * LINE_H;
    const h = captionH + CAPTION_GAP + PHOTO_H;
    ensure(h);
    page.items.push({ type: 'photos', y, row, captions, captionH });
    y += h + ITEM_GAP;
  }

  // 連絡事項(最後のページの末尾。収まらなければ次のページの末尾)
  const notesLines = wrapText(ctx, report.notes, INNER_W);
  const notesH = ROW_MIN_H + Math.max(3, notesLines.length) * LINE_H + CELL_PAD_Y * 2;
  if (y + notesH > page.areaBottom) startPage(false);
  page.notes = { lines: notesLines, top: page.areaBottom - notesH };
  page.endY = y;
  return pages;
}

// ===== 描画 =====
function drawCellText(ctx, lines, x, y, w, h, align) {
  const top = y + (h - lines.length * LINE_H) / 2;
  ctx.textAlign = align;
  const tx = align === 'center' ? x + w / 2 : x + CELL_PAD_X;
  lines.forEach((line, i) => ctx.fillText(line, tx, top + LINE_H * (i + 0.5)));
}

// 1 ページ目の上部(番号の枠・見出し・表)
function drawFirstHeader(ctx, report, page) {
  // 番号の枠(緑の地。番号は空欄)
  ctx.fillStyle = COLOR_NUMBER_BG;
  ctx.fillRect(LEFT, MARGIN_TOP, NUMBER_BOX_W, NUMBER_BOX_H);
  if (report.number) {
    ctx.font = font(TITLE_PX, true);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(report.number, LEFT + NUMBER_BOX_W / 2, MARGIN_TOP + NUMBER_BOX_H / 2);
  }
  // 見出し(報告書のタイトル。項目設定・入力の画面で変えられる)。番号の枠の右の残りの幅の中央。
  // 入らなければ字を小さくする。空なら書かない
  const titleLeft = LEFT + NUMBER_BOX_W + 20;
  const titleW = RIGHT - titleLeft;
  let px = TITLE_PX;
  ctx.font = font(px, true);
  while (px > 20 && ctx.measureText(report.title).width > titleW) {
    px -= 1;
    ctx.font = font(px, true);
  }
  ctx.fillStyle = COLOR_TEXT;
  ctx.textAlign = 'center';
  ctx.fillText(report.title, titleLeft + titleW / 2, MARGIN_TOP + NUMBER_BOX_H / 2);
  // 見出しの下の太い線
  ctx.fillRect(LEFT, MARGIN_TOP + NUMBER_BOX_H + 8, CONTENT_W, HEADER_BAR_H);

  // 表
  let y = page.tableTop;
  for (const row of page.table) {
    let x = LEFT;
    for (const cell of row.cells) {
      if (cell.label) {
        ctx.fillStyle = COLOR_LABEL_BG;
        ctx.fillRect(x, y, cell.w, row.h);
        ctx.font = font(cell.px);
        ctx.fillStyle = COLOR_TEXT;
        drawCellText(ctx, cell.lines, x, y, cell.w, row.h, 'center');
      } else {
        ctx.font = font(FONT_PX);
        ctx.fillStyle = COLOR_TEXT;
        drawCellText(ctx, cell.lines, x, y, cell.w, row.h, 'left');
      }
      ctx.strokeRect(x, y, cell.w, row.h);
      x += cell.w;
    }
    y += row.h;
  }
}

// 2 ページ目以降の上部: 「タイトル（続き）　対象案件」(入らなければ字を小さくする)
function drawContinuedHeader(ctx, report) {
  const head = `${report.title}（続き）`;
  const text = report.subject ? `${head}　${report.subject}` : head;
  let px = LABEL_PX;
  ctx.font = font(px, true);
  while (px > 18 && ctx.measureText(text).width > CONTENT_W) {
    px -= 1;
    ctx.font = font(px, true);
  }
  ctx.fillStyle = COLOR_TEXT;
  ctx.textAlign = 'left';
  ctx.fillText(text, LEFT, MARGIN_TOP + CONT_HEADER_H / 2 - 4);
  ctx.fillRect(LEFT, MARGIN_TOP + CONT_HEADER_H, CONTENT_W, 4);
}

// 左に欄の名前が付いた枠(活動内容・連絡事項)
function drawLabeledBox(ctx, top, bottom, label) {
  ctx.fillStyle = COLOR_LABEL_BG;
  ctx.fillRect(LEFT, top, LABEL_W, bottom - top);
  ctx.font = font(LABEL_PX);
  ctx.fillStyle = COLOR_TEXT;
  ctx.textAlign = 'center';
  ctx.fillText(label, LEFT + LABEL_W / 2, (top + bottom) / 2);
  ctx.strokeRect(LEFT, top, CONTENT_W, bottom - top);
  ctx.beginPath();
  ctx.moveTo(AREA_X, top);
  ctx.lineTo(AREA_X, bottom);
  ctx.stroke();
}

// 点線の罫線(様式の活動内容・連絡事項の欄と同じ)。y の位置に 1 本引く
function drawRuledLine(ctx, y) {
  ctx.save();
  ctx.setLineDash([4, 5]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#666';
  ctx.beginPath();
  ctx.moveTo(INNER_X, y);
  ctx.lineTo(RIGHT, y);
  ctx.stroke();
  ctx.restore();
}

// 中身の無いところ(from から to まで)に、行の高さごとに罫線を引く
function drawRuledLines(ctx, from, to) {
  for (let y = from + LINE_H; y <= to - 6; y += LINE_H) drawRuledLine(ctx, y);
}

// 写真を枠(w × h)に縦横比を保って収めて描く
async function drawPhoto(ctx, blob, x, y, w, h) {
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(blob);
    const s = Math.min(w / bitmap.width, h / bitmap.height);
    const dw = bitmap.width * s;
    const dh = bitmap.height * s;
    ctx.drawImage(bitmap, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  } catch {
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(x, y, w, h);
    ctx.font = font(SMALL_PX);
    ctx.fillStyle = '#555';
    ctx.textAlign = 'center';
    ctx.fillText('写真を読めませんでした', x + w / 2, y + h / 2);
  } finally {
    bitmap?.close?.();
  }
}

// 連絡事項の欄(最後のページの末尾)
function drawNotes(ctx, report, notes) {
  const top = notes.top;
  const bottom = CONTENT_BOTTOM;
  drawLabeledBox(ctx, top, bottom, '連絡事項');

  // 通報先へ連絡 要 不要 ／ 行政への連絡 要 不要(選んだ方を丸で囲む)
  const rowMid = top + ROW_MIN_H / 2;
  const group = (x, label, value) => {
    ctx.font = font(SMALL_PX);
    const lw = ctx.measureText(label).width + 20;
    const lh = ROW_MIN_H - 20;
    ctx.fillStyle = COLOR_CONTACT_BG;
    ctx.fillRect(x, rowMid - lh / 2, lw, lh);
    ctx.strokeRect(x, rowMid - lh / 2, lw, lh);
    ctx.fillStyle = COLOR_TEXT;
    ctx.textAlign = 'center';
    ctx.fillText(label, x + lw / 2, rowMid);
    ctx.font = font(FONT_PX);
    const options = [{ text: '要', cx: x + lw + 70 }, { text: '不要', cx: x + lw + 190 }];
    for (const opt of options) {
      ctx.fillText(opt.text, opt.cx, rowMid);
      if (opt.text === value) {
        const tw = ctx.measureText(opt.text).width;
        ctx.beginPath();
        ctx.ellipse(opt.cx, rowMid, tw / 2 + 24, FONT_PX / 2 + 12, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  };
  group(AREA_X + 14, '通報先へ連絡', report.contactReportTo);
  group(AREA_X + Math.round((RIGHT - AREA_X) * 0.45), '行政への連絡', report.contactGov);
  ctx.beginPath();
  ctx.moveTo(AREA_X, top + ROW_MIN_H);
  ctx.lineTo(RIGHT, top + ROW_MIN_H);
  ctx.stroke();

  // 本文(行ごとに罫線)
  ctx.font = font(FONT_PX);
  ctx.fillStyle = COLOR_TEXT;
  ctx.textAlign = 'left';
  const textTop = top + ROW_MIN_H + CELL_PAD_Y;
  notes.lines.forEach((line, i) => {
    const ly = textTop + LINE_H * (i + 0.5);
    if (ly < bottom) ctx.fillText(line, INNER_X, ly);
  });
  drawRuledLines(ctx, textTop, bottom);
}

async function drawPage(page, index, total, report, mapCanvas) {
  const canvas = document.createElement('canvas');
  canvas.width = PAGE_W;
  canvas.height = PAGE_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = COLOR_LINE;
  ctx.lineWidth = 2;
  ctx.imageSmoothingQuality = 'high';

  if (page.first) drawFirstHeader(ctx, report, page);
  else drawContinuedHeader(ctx, report);

  // 活動内容の欄(このページの連絡事項の上まで)
  const areaBottom = page.notes ? page.notes.top : page.areaBottom;
  drawLabeledBox(ctx, page.areaTop, areaBottom, '活動内容');
  for (const item of page.items) {
    if (item.type === 'text') {
      ctx.font = font(FONT_PX);
      ctx.fillStyle = COLOR_TEXT;
      ctx.textAlign = 'left';
      ctx.fillText(item.text, INNER_X, item.y + LINE_H / 2);
      drawRuledLine(ctx, item.y + LINE_H);
    } else if (item.type === 'map') {
      ctx.drawImage(mapCanvas, INNER_X, item.y, MAP_W, MAP_H);
      ctx.strokeRect(INNER_X, item.y, MAP_W, MAP_H);
    } else if (item.type === 'photos') {
      for (let col = 0; col < item.row.length; col++) {
        const x = INNER_X + col * (PHOTO_CELL_W + PHOTO_GAP);
        ctx.font = font(FONT_PX);
        ctx.fillStyle = COLOR_TEXT;
        ctx.textAlign = 'left';
        item.captions[col].forEach((line, i) => ctx.fillText(line, x, item.y + LINE_H * (i + 0.5)));
        await drawPhoto(ctx, item.row[col].blob, x, item.y + item.captionH + CAPTION_GAP, PHOTO_CELL_W, PHOTO_H);
      }
    }
  }
  // 中身の下の空いたところに罫線(様式と同じ)
  drawRuledLines(ctx, page.endY, areaBottom);
  if (page.notes) drawNotes(ctx, report, page.notes);

  // ページ番号
  ctx.font = font(SMALL_PX);
  ctx.fillStyle = '#555';
  ctx.textAlign = 'center';
  ctx.fillText(`${index + 1} / ${total}`, PAGE_W / 2, PAGE_H - MARGIN_BOTTOM / 2);
  return canvas;
}

function canvasToJpegBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error('ページの画像を作れませんでした'));
        return;
      }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/jpeg', JPEG_QUALITY);
  });
}

// 報告書の PDF を作る。
//   report:   ft-report-data.js の buildReport の値
//   features: 地図データ(loadMapFeatures の値。null なら地図に緊急ポイント・ルートを描かない)
// 返す値: { blob(PDF), pageCount, missingTiles(地図で取れなかったタイルの数) }
export async function buildReportPdf(report, features) {
  const map = await renderReportMap({
    photos: report.photos, features, width: MAP_W, height: MAP_H, scale: MAP_SCALE
  });
  const measureCtx = document.createElement('canvas').getContext('2d');
  const pages = planPages(measureCtx, report);
  const images = [];
  for (let i = 0; i < pages.length; i++) {
    const canvas = await drawPage(pages[i], i, pages.length, report, map.canvas);
    images.push({ jpeg: await canvasToJpegBytes(canvas), width: PAGE_W, height: PAGE_H });
    // 大きな canvas はすぐ手放す(スマホは canvas に使えるメモリが少ない)
    canvas.width = 0;
    canvas.height = 0;
  }
  map.canvas.width = 0;
  map.canvas.height = 0;
  // PDF の文書の情報のタイトル(タイトルが空なら、初めのタイトル)
  const baseTitle = report.title || FT_REPORT_TITLE;
  const title = report.subject ? `${baseTitle} ${report.subject}` : baseTitle;
  const blob = buildImagePdf(images, { title, producer: '箕面倒木報告' });
  return { blob, pageCount: pages.length, missingTiles: map.missingTiles };
}
