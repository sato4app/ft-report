// 「ホーム画面に追加」の案内(起動時画面の下部に出すカード)
// スマホ・タブレットのブラウザで開いたとき、ホーム画面に追加(インストール)して使うよう案内する。
//
// - アプリとして起動したか(ホーム画面のアイコンから開いたか)は、表示の形
//   (display-mode: standalone など。iOS は navigator.standalone)で判定する。
//   IndexedDB・localStorage にデータがあるかでは判定しない。Android はブラウザとアプリで
//   保存領域が共通、iOS は別々のため、どちらの場合も「いまブラウザで開いているか」は分からない
// - 出すのは起動のたび。「今後表示しない」をオンにしたら出さない。アプリ自身が行う再読み込み
//   (アプリの更新・言語の切替)の直後は出さない(続けて使っている途中のため。判断は app.js)
// - パソコンでは出さない(対象はスマホ・タブレット)
// - 案内は端末に合わせて出し分ける:
//     iPhone・iPad … 共有ボタンから「ホーム画面に追加」の手順(追加させる仕組みが無いため文章で案内)
//     Android      … ブラウザがインストールの確認を出せる(beforeinstallprompt を受け取った)ときは
//                     「インストール」ボタン。出せないときはブラウザのメニューからの手順
//     アプリの中のブラウザ(LINE など) … 追加できないため、ブラウザで開き直すよう案内
// - アプリとして起動したときに「追加済み」の印(INSTALLED_AS_APP_KEY)を残す。Android では
//   ブラウザで開いたときにもこの印が読めるため、「ホーム画面のアイコンから開いてください」と案内する。
//   アプリを削除すると印だけが残るが、ブラウザがインストールの確認を出せる(＝未インストールと
//   分かった)ときは印を消して、インストールの案内に戻す
// - 使い方ガイドを開いている間は隠す(style.css。ガイドは、このカードが無い起動時画面の
//   ボタンの位置で吹き出しの置き場所を決めているため)

import { INSTALL_BANNER_OFF_KEY, INSTALLED_AS_APP_KEY } from '../common/config.js';
import { t } from '../common/i18n.js';
import { readLocal, writeLocal } from '../common/storage.js';
import { on } from '../common/ui.js';

// 本文の {shareIcon} を置き換える、iPhone・iPad の共有ボタンの図形(四角から上向きの矢印)
const SHARE_ICON_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path d="M12 15V3M8 7l4-4 4 4M8 10H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-2" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// アプリとして起動しているか(ホーム画面のアイコン・インストールしたアプリから開いたとき)
function isRunningAsApp() {
  if (navigator.standalone === true) return true; // iOS の従来の判定
  if (!window.matchMedia) return false;
  return ['standalone', 'fullscreen', 'minimal-ui']
    .some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches);
}

// 案内の対象の端末なら { os: 'ios' | 'android', inApp: アプリの中のブラウザか }、対象外(パソコンなど)なら null
function detectTarget() {
  const ua = navigator.userAgent || '';
  // iPadOS の Safari はパソコン(Mac)と同じ表記で名乗るため、タッチ操作できるかで見分ける
  const isIos = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  if (!isIos && !isAndroid) return null;
  // アプリの中のブラウザ: LINE・Facebook・Instagram などは名前を名乗る。
  // そのほか iOS は「Safari/」の表記が無いもの、Android は WebView の印「; wv)」があるもの
  const knownInApp = /FBAN|FBAV|Instagram|Line\/|MicroMessenger/.test(ua);
  const inApp = knownInApp || (isIos ? !/Safari\//.test(ua) : /; wv\)/.test(ua));
  return { os: isIos ? 'ios' : 'android', inApp };
}

const runningAsApp = isRunningAsApp();
const target = detectTarget();

// 案内を出してよいか(アプリとして起動していない・対象の端末・「今後表示しない」がオフ)
function shouldOffer() {
  return !runningAsApp && target !== null && readLocal(INSTALL_BANNER_OFF_KEY) !== '1';
}

// ===== 状態 =====
let el = null; // DOM 参照(案内を出すときに確定)
let deferredPrompt = null; // ブラウザのインストールの確認(beforeinstallprompt)。ボタンが押されるまで預かる
let active = false; // 案内を出している(閉じていない)か

// ブラウザがインストールの確認を出せるようになったとき(Android の Chrome など)。
// 起動処理の途中で届くことがあるため、読み込み時に登録しておく
window.addEventListener('beforeinstallprompt', (e) => {
  // インストールされていないと分かったので、古い「追加済み」の印を消す
  writeLocal(INSTALLED_AS_APP_KEY, null);
  // 案内を出さない端末・「今後表示しない」のときは、ブラウザ標準の案内に任せる
  if (!shouldOffer()) return;
  // ブラウザ標準の案内(画面下の小さなバー)を止め、こちらの「インストール」ボタンから出す
  e.preventDefault();
  deferredPrompt = e;
  if (active) render();
});

// インストールが済んだとき(「インストール」ボタン・ブラウザのメニューのどちらからでも)
window.addEventListener('appinstalled', () => {
  writeLocal(INSTALLED_AS_APP_KEY, '1');
  deferredPrompt = null;
  if (active) render();
});

// ===== 起動時 =====
// 起動時に1回呼ぶ。show が false(アプリ自身の再読み込みの直後)のときは、「追加済み」の印の記録だけ行う
export function initInstallBanner({ show = true } = {}) {
  if (runningAsApp) {
    writeLocal(INSTALLED_AS_APP_KEY, '1');
    return;
  }
  if (!show || !shouldOffer()) return;
  el = {
    banner: document.getElementById('installBanner'),
    title: document.getElementById('installBannerTitle'),
    text: document.getElementById('installBannerText'),
    note: document.getElementById('installBannerNote'),
    optOut: document.getElementById('installBannerOptOut'),
    btnInstall: document.getElementById('btnInstallApp'),
    btnClose: document.getElementById('btnInstallBannerClose')
  };
  // 端末に古い index.html が残っている(案内の要素が無い)ときは出さない
  if (!el.banner) return;
  // 「今後表示しない」は切り替えたときに保存する(閉じずに他の画面へ移っても効くように)
  on(el.optOut, 'change', () => writeLocal(INSTALL_BANNER_OFF_KEY, el.optOut.checked ? '1' : null));
  on(el.btnInstall, 'click', promptInstall);
  on(el.btnClose, 'click', closeBanner);
  active = true;
  render();
  el.banner.hidden = false;
}

// ===== 表示 =====
// 端末と状態に合わせて、見出し・本文・補足と「インストール」ボタンを出し分ける
function render() {
  let titleKey;
  let textKey;
  let noteKey = null;
  let canPrompt = false;
  if (target.inApp) {
    titleKey = 'install.titleInApp';
    textKey = 'install.textInApp';
  } else if (target.os === 'ios') {
    titleKey = 'install.titleIos';
    textKey = 'install.textIos';
    noteKey = 'install.noteIos';
  } else if (deferredPrompt) {
    titleKey = 'install.titleAndroid';
    textKey = 'install.textAndroidPrompt';
    canPrompt = true;
  } else if (readLocal(INSTALLED_AS_APP_KEY) === '1') {
    titleKey = 'install.titleInstalled';
    textKey = 'install.textInstalled';
  } else {
    titleKey = 'install.titleAndroid';
    textKey = 'install.textAndroidMenu';
  }
  el.title.textContent = t(titleKey);
  setTextWithShareIcon(el.text, t(textKey));
  el.note.textContent = noteKey ? t(noteKey) : '';
  el.note.hidden = !noteKey;
  el.btnInstall.hidden = !canPrompt;
}

// 文言の {shareIcon} を共有ボタンの図形に置き換えて入れる(それ以外は文字として入れる)
function setTextWithShareIcon(elem, text) {
  const parts = text.split('{shareIcon}');
  elem.replaceChildren();
  parts.forEach((part, i) => {
    if (i > 0) {
      const icon = document.createElement('span');
      icon.className = 'install-share-icon';
      icon.innerHTML = SHARE_ICON_SVG;
      elem.append(icon);
    }
    elem.append(part);
  });
}

// ===== 操作 =====
// 「インストール」ボタン: ブラウザのインストールの確認を出す(確認は1回しか出せない)
async function promptInstall() {
  const installEvent = deferredPrompt;
  if (!installEvent) return;
  deferredPrompt = null;
  try {
    await installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    if (outcome === 'accepted') writeLocal(INSTALLED_AS_APP_KEY, '1');
  } catch (err) {
    console.warn('[install] インストールの確認を出せませんでした:', err);
  }
  // 取りやめたときは、ブラウザのメニューからの手順に切り替わる
  if (active) render();
}

// 「閉じる」: この起動の間は出さない(次の起動でまた出す。「今後表示しない」がオンなら出さない)
function closeBanner() {
  active = false;
  el.banner.hidden = true;
}
