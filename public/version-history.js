// 「バージョン履歴」の記載内容と描画
// 情報・言語/Info & Language の「バージョン履歴」で表示する内容で、**本ファイルの VERSION_HISTORY が
// この記載内容の正本**。履歴を足す・直すときは VERSION_HISTORY だけを直す(描画のコードは触らなくてよい)。
//
// 1件 = { date: 'YYYY-MM-DD', text: { ja, en } }。
// - 表示は配列の順で、**最新から順**(上が新しい)に並べる。新しい履歴は先頭に足す。
// - date は YYYY-MM-DD 形式で書き、書いたとおりに表示する(日英共通。言語で書き分けない)。
// - en が無いときは ja を出す(faq.js の pick と同じ)。英文中の画面の名前(「Take Photos」など)は、
//   i18n.js の英語表記と必ず一致させること(英語表示の利用者が画面上で項目を見つけられるように)。

import { getLang } from './i18n.js';

export const VERSION_HISTORY = [
  {
    date: '2026-11-20',
    text: { ja: '機能追加: 写真を撮影', en: 'New feature: Take Photos' }
  },
  {
    date: '2026-10-15',
    text: { ja: '初期公開バージョン(βテスト開始)', en: 'First public version (beta testing began)' }
  },
  {
    date: '2026-05-07',
    text: { ja: 'deploy実施(αテスト開始)', en: 'Deployed (alpha testing began)' }
  }
];

// ===== 描画 =====
let built = false;

// 表示言語の文言を取り出す。未訳のときは日本語で出す(空欄にはしない)
function pick(entry) {
  return entry[getLang()] ?? entry.ja;
}

// 「バージョン履歴」を開いたときに呼ぶ。中身は変わらない(言語の切替は再読み込みを伴う)ので、
// 組み立ては最初の1回だけ。日付を左、内容を右に並べる
export function showVersionHistory(container) {
  if (!container || built) return;
  built = true;
  const list = document.createElement('ul');
  list.className = 'version-history-list';
  for (const entry of VERSION_HISTORY) {
    const li = document.createElement('li');
    const date = document.createElement('span');
    date.className = 'version-history-date';
    date.textContent = entry.date;
    const text = document.createElement('span');
    text.className = 'version-history-text';
    text.textContent = pick(entry.text);
    li.append(date, text);
    list.append(li);
  }
  container.append(list);
}
