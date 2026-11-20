// 出力(移動経路の GPX・写真の KMZ)のファイル名と保存
// ファイル名は yyyymmdd-nn を既定とする。日付は経路なら記録開始の当日(最初の記録点の記録日)、
// 写真なら最初の写真の撮影日(時刻が無い場合のみ今日の日付で代替。呼び出し側で決める)。
// 連番は経路(GPX)と写真(KMZ)で別々に数える。同じ日に1回ずつ出力すると名前がそろう。
// key は経路なら TRACK_EXPORT_SEQ_KEY、写真なら PHOTO_EXPORT_SEQ_KEY(config.js)。
import { readLocalJSON, writeLocalJSON } from './storage.js';

// 連番のデフォルト値: 同日の前回出力の連番 +1(保存が無い・日付が違う・不正値のときは 01)
function readNextExportSeq(key, dateStr) {
  const saved = readLocalJSON(key);
  if (saved && saved.date === dateStr && Number.isInteger(saved.seq)) return saved.seq + 1;
  return 1;
}

// 既定のファイル名(yyyymmdd-nn)
export function defaultExportName(key, dateStr) {
  return `${dateStr}-${String(readNextExportSeq(key, dateStr)).padStart(2, '0')}`;
}

// 出力に使ったファイル名から日付と連番を取り出して保存する(次回デフォルトの決定用)。
// 既定の書式(yyyymmdd-連番)から外れた自由入力のときは保存しない(連番の並びに影響させない)。
// 日付部分も編集できるため、記録日と違う日付で出力した場合はその日付で保存する
// (次回は記録日で照合するため既定は 01 に戻る)。
export function writeExportSeq(key, name) {
  const m = /^(\d{8})-(\d+)$/.exec(name);
  if (!m) return;
  writeLocalJSON(key, { date: m[1], seq: parseInt(m[2], 10) });
}

// 出力モーダルを開き、ファイル名の欄に既定の名前を入れる。拡張子を除く全体を編集できる。
// 開いた直後は未選択(全選択しない)にして、編集位置(キャレット)を末尾に置く。
export function openExportNameModal(modal, input, name) {
  input.value = name;
  modal.hidden = false;
  input.focus();
  // focus() 時の選択状態はブラウザ依存のため、明示的に選択なし・キャレット末尾にする
  input.setSelectionRange(name.length, name.length);
}

// 入力されたファイル名を整える。ファイル名に使えない文字は除去し、拡張子まで入力された場合は
// 二重に付かないよう落とす。末尾に空白があると拡張子を末尾と判定できないため、
// 除去 → trim → 拡張子落とし の順に行う。空なら '' を返す
export function readExportName(input) {
  return input.value
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .replace(/\.(gpx|kmz)$/i, '')
    .trim();
}

// Blob をファイルとしてダウンロードさせる(GPX・KMZ で共用)。
// 「出力しました」の完了メッセージは出さない。a[download] では保存されたかどうかがアプリに分からず、
// スマホでは保存の画面を閉じて(取りやめて)戻っても同じ流れになるため、出すと実際と食い違うことがある。
export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // click 直後の revoke はダウンロード開始前に無効化される場合があるため遅延させる
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
