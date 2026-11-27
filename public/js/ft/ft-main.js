// ft-report(箕面 倒木報告)だけの処理の入口。
// minoh-hiking 由来のファイルの変更を最小限にするため、ft-report の処理はこの ft/ フォルダに置き、
// app.js の起動処理の最後で initFt() を 1 回呼ぶ。
// ファイルを足したら、service-worker.js の SHELL_LOCAL_PATHS の「ft-report 専用」の区画にも足すこと。

import { showToast } from '../common/messages.js';
import { checkAppShellUpdate } from '../data/update.js';
import { checkPublishedDataUpdate } from '../data/published-data.js';
import { openReportScreen } from './ft-report-screen.js';
import { openItemSettings } from './ft-item-settings.js';
import { openExplore } from './ft-explore.js';

// 起動時画面に足す、倒木報告のボタン(上から順に並べる)。open は押したときに開く画面(無ければ準備中)。
// below の付いたボタンは、列の下端(処理報告の下端。画面の上から 4 割)より下に置く(ft-style.css の .ft-home-btn-below)。
// selfCheck の付いたボタンは、更新版の確認を open の中で行う(探索・案内は「ハイキングマップ表示」のボタンを
// 押す形で地図画面を開き、そのボタンが確認するため。ここでも確認すると 2 度になる)
const FT_HOME_BUTTONS = [
  { id: 'ftBtnFind', label: '発見報告', open: () => openReportScreen('found') },       // docs/ft-funcspec-found.md
  { id: 'ftBtnGuide', label: '探索・案内', open: openExplore, selfCheck: true },   // docs/ft-funcspec-explore.md
  { id: 'ftBtnProcess', label: '処理報告', open: () => openReportScreen('process') },  // docs/ft-funcspec-process.md
  { id: 'ftBtnItems', label: '設定', open: openItemSettings, below: true }   // 項目設定。docs/ft-funcspec-items.md
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

  for (const { id, label, open, below, selfCheck } of FT_HOME_BUTTONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = id;
    btn.className = 'home-btn ft-home-btn';   // 見た目は既存のメニューのボタン(.home-btn)と同じ
    if (below) btn.classList.add('ft-home-btn-below');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      // 既存のメニューのボタンと同じく、あわせてアプリと公開データの更新版を確認する
      // (app.js の checkForUpdates と同じ処理。app.js を書き換えないよう、ここで呼ぶ)
      if (!selfCheck) {
        checkAppShellUpdate();
        checkPublishedDataUpdate();
      }
      if (open) open();
      else showToast(`「${label}」は準備中です`);   // まだ作っていない機能
    });
    nav.appendChild(btn);
  }

  // 読み上げ・Tab の順で既存のメニューより先になるよう、その前に入れる
  home.insertBefore(nav, home.querySelector('.home-menu'));
}
