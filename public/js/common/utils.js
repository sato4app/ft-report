// 複数のモジュールで使う小さな関数
// (日付・時刻の書式 / 文字のエスケープ / 例外の文言 / 画像の JPEG 化 / 方角 / 番号の書き方)

// 2桁のゼロ埋め
export function pad2(n) {
  return String(n).padStart(2, '0');
}

// 端末の現地日付。年・月・日を sep でつなぐ(既定は区切り無しの yyyymmdd。'-' で YYYY-MM-DD)。
// YYYY-MM-DD どうしは文字列の比較で日付の前後を判定できる
export function formatLocalDate(ms = Date.now(), sep = '') {
  const d = new Date(ms);
  return [d.getFullYear(), pad2(d.getMonth() + 1), pad2(d.getDate())].join(sep);
}

// 端末の現地時刻(HH:MM)
export function formatLocalTime(ms = Date.now()) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// XML(GPX・KML)に書く文字のエスケープ
export function escapeXml(s) {
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

// HTML(地図のポップアップ)に入れる文字のエスケープ
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// 例外の内容を、利用者に見せる文言({message})へ入れる短い文字列にする
export function errorText(err) {
  return err?.message || err?.name || '';
}

// 地点 from から見た地点 to の方角(度。北が 0、東が 90)。from / to は { lat, lng }(Leaflet の LatLng でもよい)。
// 移動経路の進行方向(track.js)と、場所を検索の方角(place-search.js)で使う
export function bearingDegrees(from, to) {
  const toRad = Math.PI / 180;
  const lat1 = from.lat * toRad;
  const lat2 = to.lat * toRad;
  const dLng = (to.lng - from.lng) * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

// 番号を丸数字にする(1〜20 は ①〜⑳、21 からは (21)、(22)、…)。日英で同じ書き方
export function circledNumber(n) {
  return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `(${n})`;
}

// 画像(video / ImageBitmap など)を width × height の大きさに描いて JPEG にする。
// 描くのはこの関数を呼んだ時点(呼んだ後に映像を止めてもよい)。作れなければ null で解決する
export function drawToJpeg(source, width, height, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(source, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}
