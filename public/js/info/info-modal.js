// 情報・言語モーダル(起動画面の「情報・言語/Info & Language」から表示)
// ご利用の注意・よくある質問・メッセージ履歴・バージョン情報・バージョン履歴・このアプリについて・
// 言語/Language をまとめる(マーカーの設定はマップ画面メニューから開く)。
// 6項目は設定ではなく情報の表示なので、スイッチではなく押すと下に開く見出しにしている。
// このアプリについて の外部サイトへのリンクは、開く前に確認画面(#externalSiteModal)を出す。
import { REOPEN_APP_SETTINGS_KEY } from '../common/config.js';
import { getLang, setLang, t } from '../common/i18n.js';
import { renderMessageList, clearMessageLog } from '../common/messages.js';
import { showNotices, showQuestions } from './faq.js';
import { showVersionHistory } from './version-history.js';
import { getFeatureCounts } from '../map/map-overlays.js';
import { getMapdataVersion, getClosureVersion, getClosureCount } from '../data/published-data.js';
import { getManifestVersion, getSavedManifestVersion } from '../data/tiles.js';
import { getCachedAppShellVersion, promptMapTileUpdate } from '../data/update.js';
import { takeSession, writeSession } from '../common/storage.js';
import { on, closeModal, setModalHooks } from '../common/ui.js';

const el = {
  appSettingsModal: document.getElementById('appSettingsModal'),
  languageSelect: document.getElementById('languageSelect'),
  // 押すと下に開く6項目(見出しのボタンと、開く中身)
  btnInfoNotices: document.getElementById('btnInfoNotices'),
  infoNoticesBody: document.getElementById('infoNoticesBody'),
  faqNotices: document.getElementById('faqNotices'),
  btnInfoFaq: document.getElementById('btnInfoFaq'),
  infoFaqBody: document.getElementById('infoFaqBody'),
  faqContent: document.getElementById('faqContent'),
  btnInfoMessages: document.getElementById('btnInfoMessages'),
  infoMessagesBody: document.getElementById('infoMessagesBody'),
  btnClearMessages: document.getElementById('btnClearMessages'),
  btnInfoVersion: document.getElementById('btnInfoVersion'),
  infoVersionBody: document.getElementById('infoVersionBody'),
  btnInfoHistory: document.getElementById('btnInfoHistory'),
  infoHistoryBody: document.getElementById('infoHistoryBody'),
  versionHistory: document.getElementById('versionHistory'),
  btnInfoAbout: document.getElementById('btnInfoAbout'),
  infoAboutBody: document.getElementById('infoAboutBody'),
  // バージョン情報の値
  versionManifest: document.getElementById('versionManifest'),
  versionAppShell: document.getElementById('versionAppShell'),
  versionMapdata: document.getElementById('versionMapdata'),
  versionClosures: document.getElementById('versionClosures'),
  // データ件数表示(ポイント/ルート/スポット/通行止め)
  countPoints: document.getElementById('countPoints'),
  countRoutes: document.getElementById('countRoutes'),
  countSpots: document.getElementById('countSpots'),
  countClosures: document.getElementById('countClosures'),
  // 外部サイトを開く確認(このアプリについて のリンクから表示)
  externalSiteModal: document.getElementById('externalSiteModal'),
  externalSiteMessage: document.getElementById('externalSiteMessage'),
  externalSiteUrl: document.getElementById('externalSiteUrl'),
  btnExternalSiteOpen: document.getElementById('btnExternalSiteOpen')
};

// 6項目(見出しのボタンと、開く中身)。開くたびに閉じた状態へ戻すときに使う
const DISCLOSURES = [
  [el.btnInfoNotices, el.infoNoticesBody],
  [el.btnInfoFaq, el.infoFaqBody],
  [el.btnInfoMessages, el.infoMessagesBody],
  [el.btnInfoVersion, el.infoVersionBody],
  [el.btnInfoHistory, el.infoHistoryBody],
  [el.btnInfoAbout, el.infoAboutBody]
];

// ===== イベントの登録(app.js の bindEvents から1回呼ぶ) =====
export function bindInfoEvents() {
  // 言語/Language: 現在の設定値を表示し、変更時は保存して
  // リロードし、選択言語で全文言を再表示する。
  // リロードすると起動画面に戻ってしまうため、フラグを立てて再読み込み後に
  // 情報・言語モーダルを開き直す(操作を続けられるようにする)
  el.languageSelect.value = getLang();
  on(el.languageSelect, 'change', (e) => {
    setLang(e.target.value);
    writeSession(REOPEN_APP_SETTINGS_KEY, '1');
    location.reload();
  });
  // 見出しを押すと下に開く/閉じる。第3引数は開いたときの処理
  // ご利用の注意: 初めて開いたときだけ中身を組み立てる。参照リンク(→Q5 など)で
  // よくある質問へ移るときは、よくある質問が閉じていれば先に開く(openQuestions)
  bindInfoDisclosure(el.btnInfoNotices, el.infoNoticesBody, () => showNotices(el.faqNotices, openQuestions));
  // よくある質問: 初めて開いたときだけ中身を組み立てる。
  // 開くたびに、答えを閉じた最初の表示(見出しと質問だけ)に戻す
  bindInfoDisclosure(el.btnInfoFaq, el.infoFaqBody, () => showQuestions(el.faqContent));
  bindInfoDisclosure(el.btnInfoMessages, el.infoMessagesBody, renderMessageList);
  // バージョン情報: 開いたら、その時点の値を反映する
  bindInfoDisclosure(el.btnInfoVersion, el.infoVersionBody, showVersionInfo);
  // バージョン履歴: 初めて開いたときだけ中身を組み立てる
  bindInfoDisclosure(el.btnInfoHistory, el.infoHistoryBody, () => showVersionHistory(el.versionHistory));
  bindInfoDisclosure(el.btnInfoAbout, el.infoAboutBody);
  // このアプリについて の外部サイトへのリンク: すぐには開かず、全画面の確認画面を出す。
  // キャンセル(data-close-modal)なら開かずに情報・言語モーダルへ戻る。
  // 「開く」なら別ウインドウで開き、確認画面は閉じておく。アプリの画面(情報・言語モーダル)は
  // そのまま残るため、開いたウインドウを閉じれば元の画面に戻れる
  for (const link of el.infoAboutBody.querySelectorAll('a[data-external-site]')) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openExternalSiteModal(link.href, t(link.dataset.externalSite));
    });
  }
  on(el.btnExternalSiteOpen, 'click', () => {
    if (externalSiteHref) window.open(externalSiteHref, '_blank', 'noopener');
    closeModal(el.externalSiteModal);
  });
  // メッセージ履歴の消去
  on(el.btnClearMessages, 'click', clearMessageLog);
}

// ===== 押すと下に開く見出し =====
// 見出しのボタンと中身の開閉状態をそろえる(要素が無い端末でも落ちないようにする)
function setInfoDisclosure(button, body, open) {
  if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (body) body.hidden = !open;
}

// 見出しのボタンを押したときの開閉。onOpen は開いたときに呼ぶ
function bindInfoDisclosure(button, body, onOpen) {
  on(button, 'click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    setInfoDisclosure(button, body, open);
    if (open) {
      onOpen?.();
      return;
    }
    // 開いた見出しは本文の上端に残る(CSS の position: sticky)ため、長い中身を読み進めた所で
    // 閉じると、見出しが本来の位置(本文の上の外)へ戻って見えなくなる。その場合は見出しが
    // 上端に来るよう本文だけをスクロールし直す(scrollIntoView は画面ごと動かすことがあるため使わない)
    const scroller = button.closest('.modal-body');
    if (!scroller) return;
    const offset = button.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    if (offset < 0) scroller.scrollTop += offset;
  });
}

// 「よくある質問」が閉じていれば開く(ご利用の注意の参照リンクから呼ぶ)。
// 開いているときは何もしない(開くときの処理で、読んでいた答えが閉じてしまうため)
function openQuestions() {
  if (!el.btnInfoFaq || el.btnInfoFaq.getAttribute('aria-expanded') === 'true') return;
  setInfoDisclosure(el.btnInfoFaq, el.infoFaqBody, true);
  showQuestions(el.faqContent);
}

export function openAppSettingsModal() {
  // 6項目は開くたびに必ず閉じた状態へ戻す。開いたままだと、次に開いたときに長い内容が
  // 広がった状態で始まり、その下にある「言語の設定」までスクロールが必要になるため
  for (const [button, body] of DISCLOSURES) setInfoDisclosure(button, body, false);

  // 履歴は開いたときにすぐ見えるよう事前に描画しておく
  renderMessageList();

  el.appSettingsModal.hidden = false;
}

// 「言語の設定/Language Settings」の変更でリロードした直後だけ、情報・言語モーダルを
// 開き直す。フラグは一度きりの復元用なので、読み取ったら必ず削除する
// (以降の通常起動では起動画面のまま)。
export function restoreAppSettingsModalAfterReload() {
  if (takeSession(REOPEN_APP_SETTINGS_KEY) === '1') openAppSettingsModal();
}

// ===== 外部サイトを開く確認 =====
// 開く先は「開く」が押されるまで保持し、閉じたら捨てる
let externalSiteHref = null;
setModalHooks('externalSiteModal', { afterClose: () => { externalSiteHref = null; } });

function openExternalSiteModal(href, siteName) {
  externalSiteHref = href;
  el.externalSiteMessage.textContent = t('info.externalMessage', { site: siteName });
  el.externalSiteUrl.textContent = href;
  el.externalSiteModal.hidden = false;
}

// ===== バージョン情報 =====
// 読み込んだポイント/ルート/スポット/通行止めの件数を
// 「バージョン情報」内に横一列で反映(未読込は "-")。
export function updateFeatureCounts() {
  const c = getFeatureCounts();
  const show = (elem, n) => { elem.textContent = n == null ? '-' : String(n); };
  show(el.countPoints, c.points);
  show(el.countRoutes, c.routes);
  show(el.countSpots, c.spots);
  // 通行止め・通行困難地点: 現在反映されているデータの件数
  show(el.countClosures, getClosureCount());
}

// 「バージョン情報」を開いたとき、その時点の値を反映する。
async function showVersionInfo() {
  el.versionManifest.textContent = getManifestVersion() || t('common.unknown');
  // 公開データ: 現在反映されているデータのバージョン
  el.versionMapdata.textContent = getMapdataVersion() || '-';
  el.versionClosures.textContent = getClosureVersion() || '-';
  // データ件数(ポイント/ルート/スポット/通行止め)を開いた時点の最新値で反映
  updateFeatureCounts();
  // アプリシェルのバージョンはキャッシュ名から取るため非同期(他の値を先に反映する)
  el.versionAppShell.textContent = (await getCachedAppShellVersion()) || t('common.unknown');

  // 地図タイル: ダウンロード済みバージョン vs サイト最新マニフェスト
  // (オフライン地図を未ダウンロードの場合は saved が無く、対象外)。
  // 新しければ「地図データのダウンロード」からの手動更新を案内する(自動更新はしない)。
  // アプリ本体の更新確認はここでは行わない(起動時画面のボタンのタップで行う。
  // この画面を開く「情報・言語/Info & Language」もその1つ)
  const savedMap = getSavedManifestVersion();
  const latestMap = getManifestVersion();
  if (savedMap && latestMap && savedMap !== latestMap) {
    promptMapTileUpdate(savedMap, latestMap);
  }
}
