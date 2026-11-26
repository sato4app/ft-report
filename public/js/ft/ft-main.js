// ft-report(箕面 倒木報告)だけの処理の入口。
// minoh-hiking 由来のファイルの変更を最小限にするため、ft-report の処理はこの ft/ フォルダに置き、
// app.js の起動処理の最後で initFt() を 1 回呼ぶ。
// ファイルを足したら、service-worker.js の SHELL_LOCAL_PATHS の「ft-report 専用」の区画にも足すこと。

import { showToast } from '../common/messages.js';
import { checkAppShellUpdate } from '../data/update.js';
import { checkPublishedDataUpdate } from '../data/published-data.js';

// 起動時画面に足す、倒木報告のボタン(上から順に並べる)
const FT_HOME_BUTTONS = [
  { id: 'ftBtnFind', label: '発見' },
  { id: 'ftBtnGuide', label: '案内' },
  { id: 'ftBtnProcess', label: '処理' }
];

// ft-report の初期化
export function initFt() {
  addHomeButtons();
}

// 起動時画面の左側に、倒木報告のボタンを縦に並べる(位置と見た目は ft-style.css の .ft-home-menu)。
// index.html を書き換えないよう、ボタンはここで作って #viewHome に足す
function addHomeButtons() {
  const home = document.getElementById('viewHome');
  if (!home) return;

  const nav = document.createElement('nav');
  nav.className = 'ft-home-menu';
  nav.setAttribute('aria-label', '倒木報告メニュー');

  for (const { id, label } of FT_HOME_BUTTONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = id;
    btn.className = 'home-btn ft-home-btn';   // 見た目は既存のメニューのボタン(.home-btn)と同じ
    btn.textContent = label;
    btn.addEventListener('click', () => {
      // 既存のメニューのボタンと同じく、あわせてアプリと公開データの更新版を確認する
      // (app.js の checkForUpdates と同じ処理。app.js を書き換えないよう、ここで呼ぶ)
      checkAppShellUpdate();
      checkPublishedDataUpdate();
      // 各機能はまだ作っていない
      showToast(`「${label}」は準備中です`);
    });
    nav.appendChild(btn);
  }

  // 読み上げ・Tab の順で既存のメニューより先になるよう、その前に入れる
  home.insertBefore(nav, home.querySelector('.home-menu'));
}
