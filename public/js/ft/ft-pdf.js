// PDF の組み立て(ライブラリを使わない)。
// 1 ページに JPEG の画像を 1 枚、ページいっぱいに置くだけの PDF を作る。
// 文字は画像の中に描いてあるので、PDF に字体を入れる必要がない(代わりに文字の選択・検索はできない)。
// JPEG はそのまま(DCTDecode)入れるので、作り直しによる画質の低下は無い。

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;

const encoder = new TextEncoder();

// PDF の文字列(日本語を含む)。UTF-16BE に BOM を付けた 16 進の文字列にする
function pdfTextString(s) {
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

// PDF の日付(D:20261126153000+09'00')
function pdfDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    + `${sign}${p(Math.floor(abs / 60))}'${p(abs % 60)}'`;
}

// pages: [{ jpeg: Uint8Array, width, height }](width・height は画像のピクセル数)
// 用紙は A4 縦。返す値は PDF の Blob
export function buildImagePdf(pages, { title = '', producer = '' } = {}) {
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (num, body) => {
    offsets[num] = length;
    push(`${num} 0 obj\n${body}\nendobj\n`);
  };
  const streamObject = (num, dict, bytes) => {
    offsets[num] = length;
    push(`${num} 0 obj\n<< ${dict} /Length ${bytes.length} >>\nstream\n`);
    push(bytes);
    push('\nendstream\nendobj\n');
  };

  // 見出し(2 行目は、バイナリを含むファイルであることを示す慣例の行)
  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

  // 1: カタログ、2: ページの一覧、3: 文書の情報、4 以降: ページごとに ページ・中身・画像 の 3 つ
  const pageNum = (i) => 4 + i * 3;
  const kids = pages.map((_, i) => `${pageNum(i)} 0 R`).join(' ');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const info = [`/CreationDate (${pdfDate()})`];
  if (title) info.push(`/Title ${pdfTextString(title)}`);
  if (producer) info.push(`/Producer ${pdfTextString(producer)}`);
  object(3, `<< ${info.join(' ')} >>`);

  pages.forEach((page, i) => {
    const num = pageNum(i);
    const name = `/Im${i}`;
    object(num, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_WIDTH_PT} ${A4_HEIGHT_PT}]`
      + ` /Resources << /XObject << ${name} ${num + 2} 0 R >> >> /Contents ${num + 1} 0 R >>`);
    streamObject(num + 1, '', encoder.encode(`q\n${A4_WIDTH_PT} 0 0 ${A4_HEIGHT_PT} 0 0 cm\n${name} Do\nQ\n`));
    streamObject(num + 2,
      `/Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height}`
      + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
      page.jpeg);
  });

  // 相互参照表(各オブジェクトの位置。1 行はちょうど 20 バイト)
  const count = 4 + pages.length * 3;
  const xrefPos = length;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let num = 1; num < count; num++) xref += `${String(offsets[num]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  return new Blob(parts, { type: 'application/pdf' });
}
