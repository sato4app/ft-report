// アプリのエントリポイント
// - 起動処理(各機能モジュールの初期化と、起動時の復元)
// - SPA ビュー切替(home / map)と、マップ画面の上部の表示(メニューボタン・時刻)
// - 起動時画面のボタン(更新版の確認・QRコード)と、アプリ更新の再読み込みをまたいだ画面の保持
//
// 機能別の実装は js/ 配下のフォルダに分けている(ファイルを足したら service-worker.js の
// SHELL_LOCAL_PATHS にも足すこと):
//   common/ … 共通
//     config.js         … 既定値・共有定数(保存のキー・URL・マーカー種別)
//     i18n.js           … 表示言語(日本語/English)の辞書と一括置換
//     storage.js        … 端末への保存(localStorage / sessionStorage)の読み書き
//     db.js             … IndexedDB(ダウンロード履歴・移動経路・写真)
//     messages.js       … メッセージ履歴・トースト
//     ui.js             … 画面部品の共通処理(イベント登録・フォーカス・モーダルの開閉)
//     page-guard.js     … ページの拡大・ずれ・振って取り消しの防止
//     file-export.js    … 出力(GPX・KMZ)のファイル名と保存
//     utils.js          … 日付の書式・エスケープなどの小さな共通関数
//   map/ … 地図・現在地
//     map.js            … Leaflet 地図(初期化・右下のボタン・操作の検知)
//     map-overlays.js   … 地図に重ねる表示(緊急ポイント・ハイキング・通行止め)
//     marker-icons.js   … マーカーの図形
//     one-finger-zoom.js… 1本指ズーム
//     geolocation.js    … 現在地表示・追従・記録の開始/停止(現在地の監視)
//     layer-panel.js    … 表示設定パネル(≡)の開閉・トグルの保存・統計の表示部品
//     marker-settings.js… マーカーの色・形状・サイズ設定
//   track/ … 移動経路
//     track.js          … 移動経路のデータ・描画・端末への保存・画面スリープの防止
//     track-ui.js       … 移動経路の操作(記録開始・停止・GPX 読み込み・出力・クリア)
//     gpx.js            … GPX の組み立て・解析
//   photo/ … 写真(「写真を撮影」。移動経路の記録とは別の機能)
//     photos.js         … 撮った写真の保持・地図への表示・端末への保存
//     photo-ui.js       … 写真の操作(撮影・KMZ 読み込み・出力・クリア)
//     photo-view.js     … 写真の表示(名前の変更)・写真の一覧
//     photo-zoom.js     … 写真の拡大表示
//     camera.js         … アプリ内カメラ
//     kmz.js            … KMZ の組み立て・解析
//   data/ … 配信データ・オフライン地図・アプリの更新
//     published-data.js … 公開API から配信データ(地図データ・通行止め・タイル一覧)を取得
//     tiles.js          … オフライン地図のDL・マニフェスト・更新バナー
//     update.js         … アプリシェルの更新確認
//   info/ … 起動時画面から開く案内
//     info-modal.js     … 情報・言語モーダル(ご利用の注意・よくある質問・バージョン情報・言語の設定など)
//     faq.js / faq-text.js … ご利用の注意・よくある質問の描画 / 文言(正本)
//     version-history.js … バージョン履歴の記載内容(正本)と描画
//     guide.js          … 使い方ガイド(画面を順に案内するオーバーレイ)
//     qrcode.js         … QRコードの生成(外部ライブラリ非依存)

import {
  initMap, resizeMap, getMap, setZoomDisplayVisible,
  setCurrentMarkerButtonHandler, setCurrentMarkerButtonState
} from './map/map.js';
import { setOverlaysVisible } from './map/map-overlays.js';
import {
  setLocationActiveForMapView, setCurrentMarkerVisible, setFollowCurrentLocation, showCurrentLocationSpot
} from './map/geolocation.js';
import { closeCamera } from './photo/camera.js';
import { loadPublishedData, checkPublishedDataUpdate } from './data/published-data.js';
import { RESTORE_SCREEN_KEY } from './common/config.js';
import { t, applyStaticTranslations } from './common/i18n.js';
import { logHistory, renderMessageList, notify } from './common/messages.js';
import {
  checkAppShellUpdate, getCachedAppShellVersion, watchAppShellReplacement, setBeforeAppReload
} from './data/update.js';
import {
  getManifestVersion, evaluateManifestVersion, openDownloadModal,
  migrateLegacyPackages, initTilesEvents, setStatus, requestPersistentStorage
} from './data/tiles.js';
import { initMarkerSettings, applyMarkerSettings, openMarkerSettingsModal } from './map/marker-settings.js';
import { renderQrSvg } from './info/qrcode.js';
import { initGuide, openGuide, maybeAutoOpenGuide, isGuideOpen } from './info/guide.js';
import { takeSession, writeSession } from './common/storage.js';
import { formatLocalTime } from './common/utils.js';
import { on, isKeyboardInput, blurActiveElement, closeModal, closeAllModals } from './common/ui.js';
import { guardPageViewport, watchTypingUndoHistory, resetPageScroll } from './common/page-guard.js';
import {
  isLayerPanelOpen, setLayerPanelOpen, closeLayerPanel, mapToggleInputs, saveMapToggles, restoreMapToggles
} from './map/layer-panel.js';
import {
  bindInfoEvents, openAppSettingsModal, restoreAppSettingsModalAfterReload, updateFeatureCounts
} from './info/info-modal.js';
import {
  bindTrackEvents, applyTrackControlsForView, updateTrackPanel,
  logInterruptedTrackRecording, restoreTrackFromStorage
} from './track/track-ui.js';
import {
  bindPhotoEvents, applyPhotoControlsForView, updatePhotoPanel, restorePhotosFromStorage
} from './photo/photo-ui.js';
import { bindPhotoViewEvents } from './photo/photo-view.js';
import { initFt } from './ft/ft-main.js';

// ===== 状態 =====
let currentView = 'home';

// ===== DOM要素 =====
const el = {
  // ビュー
  views: {
    home: document.getElementById('viewHome'),
    map: document.getElementById('viewMap')
  },

  // ホーム
  btnOpenDownload: document.getElementById('btnOpenDownload'),
  btnOpenAppSettings: document.getElementById('btnOpenAppSettings'),
  btnOpenQrCode: document.getElementById('btnOpenQrCode'),
  btnOpenGuide: document.getElementById('btnOpenGuide'),

  // QRコードモーダル(起動画面の「QR」から表示)
  qrCodeModal: document.getElementById('qrCodeModal'),
  qrCodeImage: document.getElementById('qrCodeImage'),
  qrCodeUrl: document.getElementById('qrCodeUrl'),

  // マップ
  btnMapLayers: document.getElementById('btnMapLayers'),
  mapClock: document.getElementById('mapClock'),
  toggleClock: document.getElementById('toggleClock'),
  toggleZoomDisplay: document.getElementById('toggleZoomDisplay'),
  // 現在地点の表示・地図追従トグル(移動経路を記録の上に配置)
  toggleCurrentMarker: document.getElementById('toggleCurrentMarker'),
  toggleCenterCurrent: document.getElementById('toggleCenterCurrent'),

  // マップ画面メニュー内の設定ショートカット
  btnMapOpenMarkerSettings: document.getElementById('btnMapOpenMarkerSettings')
};

// 初期化の一段階を実行する。失敗しても後続(地図の初期化など)を止めない
function initStep(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[app] 初期化の途中で問題が発生しました(${name}):`, err);
  }
}

// ===== 初期化 =====
async function init() {
  // 選択言語が英語のとき、静的なHTML文言(data-i18n属性)を一括置換する。
  // 以降の confirm・トースト等の動的文言より必ず先に適用する
  applyStaticTranslations();
  // マップのメニューのトグルを前回の状態に戻す。
  // 各トグルの反映は以降の初期化・マップ画面への切替が checked を読んで行うため、最初に行う
  initStep('restoreMapToggles', restoreMapToggles);
  // ページの拡大・ずれでマップ画面の上部ボタンが画面外へ出ないようにする
  initStep('guardPageViewport', guardPageViewport);
  // 文字を入力した後、iPhone を振ると出る「取り消す - 入力」を出さないようにする
  initStep('watchTypingUndoHistory', watchTypingUndoHistory);

  // 開いている間にブラウザが新しい版へ入れ替えたら知らせる(登録より前に見張りを始める。
  // 登録をきっかけにブラウザが更新を確かめ、すぐ入れ替わることがあるため)
  initStep('watchAppShellReplacement', watchAppShellReplacement);
  // アプリ更新で再読み込みするときは、その時の画面を控えておき、再読み込み後に戻す
  setBeforeAppReload(saveScreenForReload);
  // SW 登録
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('service-worker.js');
    } catch (err) {
      console.warn('SW登録失敗:', err);
    }
  }

  initStep('bindEvents', bindEvents);
  initStep('initTilesEvents', initTilesEvents);
  initStep('initMarkerSettings', initMarkerSettings);
  initStep('renderMessageList', renderMessageList);
  await migrateLegacyPackages();
  // ダウンロード済みのタイルがあれば、保存領域の永続化を依頼する(起動を待たせない)
  requestPersistentStorage();
  // アプリの更新版の確認は起動時には行わず、起動時画面のボタンをタップしたときに行う(bindEvents)

  // 共有地図を初期化(箕面大滝中心 / z=15、ホーム/マップで共通)
  initMap('map');
  // 現在地点表示ボタンは押されていないときは灰色。ラベル(title/aria-label)も
  // ここで初期化する(押されるまで一度も設定されないため)
  setCurrentMarkerButtonState(false);
  // ズームレベル表示は「ズームレベルを表示」トグルの状態に従う
  setZoomDisplayVisible(el.toggleZoomDisplay ? el.toggleZoomDisplay.checked : true);
  // 各マーカーのスタイル(保存済み設定。無ければ config.js の既定値)は、公開データの読込・
  // 経路と写真の復元より前に設定しておく(レイヤー・線・マーカーを作るときに反映される。
  // 後で設定すると既定の見た目で描かれてしまう)。現在地マーカー(青丸)も、現在地の監視
  // (マップ画面に入ったとき)が始まる前に設定される
  applyMarkerSettings();
  // 公開API から配信データ(地図データ・通行止め)を取得。キャッシュからの初期描画と、
  // 更新があったときの再描画(起動時・起動画面のボタンのタップ時の確認)で onApplied が
  // 呼ばれるため、そのつど表示状態と件数を合わせる。
  loadPublishedData({
    onApplied: () => {
      if (currentView === 'map') setOverlaysVisible(true);
      updateFeatureCounts();
      // タイル一覧も配信で届くため、ここで保存済み version と比較する
      // (相違があれば更新バナーを出す)
      evaluateManifestVersion();
      // 起動時に確認したバージョンを履歴に残す(1回だけ)
      logStartupVersionCheckOnce();
    }
  });
  // 前回の記録が停止操作を経ずに終わっていたら履歴に残す(起動ごとに1回)。
  // 経路の復元より先に出して、履歴が起きた順(中断 → 復元)に並ぶようにする
  logInterruptedTrackRecording();
  // 端末に保存してある移動経路を読み出して表示する
  await restoreTrackFromStorage();
  // 写真も端末から戻す(撮影地点の印を地図に出す)
  await restorePhotosFromStorage();
  // パネルの件数・統計表・ボタン行を、トグルの状態とデータに合わせて描画しておく
  updateDataPanels();

  // 初期表示はホーム(オーバーレイは非表示のまま)
  showView('home');
  // 言語変更によるリロード直後なら、情報・言語モーダルを開いた状態に戻す。
  // showView() は開いているモーダルを閉じるため、その後に呼ぶ
  restoreAppSettingsModalAfterReload();

  // 使い方ガイド。ページによって画面と表示設定パネルを切り替えるため、
  // その操作だけを関数で渡す(guide.js から app.js を import すると相互参照になる)
  initGuide({
    showView,
    getCurrentView: () => currentView,
    isLayerPanelOpen,
    setLayerPanelOpen
  });
  // アプリ更新による再読み込みの直後なら、更新前の画面(マップ画面・開いていたモーダル・使い方)に戻す
  restoreScreenAfterReload();
  // 初回起動時だけ自動で開く(2回目以降は起動画面の「使い方」ボタンから)
  maybeAutoOpenGuide();

  requestAnimationFrame(() => resizeMap());
  initStep('initFt', initFt); // ft-report だけの初期化(js/ft/ft-main.js)
}

// 移動経路・写真のパネル表示をまとめて最新化する(起動時・パネルを開いたとき)
function updateDataPanels() {
  updateTrackPanel();
  updatePhotoPanel();
}

// メニューの「現在地点をマーカー表示」トグルの状態を反映する。
// ズームボタン上の現在地点表示ボタンは別系統のため、ここでは触らない。
function applyCurrentMarkerVisible(isOn) {
  el.toggleCurrentMarker.checked = isOn;
  setCurrentMarkerVisible(isOn);
}

// 現在地点表示ボタン(ズームボタンの上)を押したとき。
// メニューのトグルとは独立した単発の操作で、押している間だけボタンを青くする。
// 表示が終わったら(3秒経過・測位失敗)灰色へ戻す。
function handleCurrentSpotButton() {
  setCurrentMarkerButtonState(true);
  showCurrentLocationSpot({ onEnd: () => setCurrentMarkerButtonState(false) });
}

function bindEvents() {
  // ホームメニュー: data-view 属性でビュー切替
  for (const btn of document.querySelectorAll('[data-view]')) {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  }
  on(el.btnOpenDownload, 'click', openDownloadModal);
  // 起動画面の「情報・言語/Info & Language」ボタンは情報・言語モーダルを表示
  on(el.btnOpenAppSettings, 'click', openAppSettingsModal);
  // 起動画面の「QR」ボタンは、いま開いている URL の QRコードを表示
  on(el.btnOpenQrCode, 'click', openQrCodeModal);
  // 起動画面の「使い方」ボタンは、アプリの使い方を順に案内するガイドを開く
  on(el.btnOpenGuide, 'click', openGuide);
  // 起動画面のボタンのどれをタップしても、あわせて更新版を確認する。
  // - アプリ: 新しい版があれば更新するか尋ねる(確認の回数の制御は update.js 側)
  // - 公開データ(地図データ・通行止め・タイル一覧): 新しい版があればそのまま取り込んで
  //   描き直す(published-data.js。反映後の処理は loadPublishedData の onApplied)
  // 各ボタン本来の動作(画面切替・モーダル表示など)はそのまま行う
  for (const btn of el.views.home.querySelectorAll('.home-btn')) {
    btn.addEventListener('click', checkForUpdates);
  }

  // 情報・言語モーダル(言語の設定・押すと下に開く6項目・外部サイトの確認・履歴の消去)
  bindInfoEvents();

  // モーダル閉じる(各モーダル内の [data-close-modal] が、その親モーダルを閉じる)
  for (const elem of document.querySelectorAll('[data-close-modal]')) {
    elem.addEventListener('click', () => {
      const modal = elem.closest('.modal');
      // フォーカス解除(モバイルのキーボード対策)と用途の破棄は closeModal に集約
      closeModal(modal);
      // マーカーの設定モーダルを閉じた後、現在のビュー状態(マップ画面の戻る/メニュー
      // ボタン等)を正規化して表示崩れを防ぐ
      if (modal && modal.id === 'settingsModal' && currentView === 'map') {
        showView('map');
      }
      // どのモーダルを閉じた場合も、マップ画面の操作要素を確実に表示状態へ戻す
      if (currentView === 'map') normalizeMapChrome();
    });
  }

  // ハイキングマップ表示中は文字入力を行わない。モーダルが開いていないのに
  // 文字入力欄へフォーカスが入った場合(閉じ忘れ・ポケット内の誤タッチ等)は即座に外し、
  // ソフトキーボードや文字入力ウインドウが出ないようにする。
  // 開いているモーダル内の入力欄(GPX のファイル名など)は対象外
  document.addEventListener('focusin', (e) => {
    if (currentView !== 'map') return;
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    if (!isKeyboardInput(target)) return;
    if (target.closest('.modal:not([hidden])')) return;
    target.blur();
  });

  // マップ表示設定(開くとき、移動経路・写真の件数と統計表を最新化する)
  on(el.btnMapLayers, 'click', () => {
    setLayerPanelOpen(!isLayerPanelOpen());
    if (isLayerPanelOpen()) updateDataPanels();
  });
  // 地図部分(#map)クリックでメニューを閉じる(マップ画面でメニュー表示中のみ)
  const mapEl = document.getElementById('map');
  if (mapEl) {
    mapEl.addEventListener('click', () => {
      if (currentView === 'map' && isLayerPanelOpen()) closeLayerPanel();
    });
  }
  // 時刻表示トグル(表示設定パネル内): ON でメニューボタンの左に現在時刻を表示
  on(el.toggleClock, 'change', (e) => setClockVisible(e.target.checked));
  // ズームレベル表示トグル(表示設定パネル内): ON で地図右下に現在のズームレベルを表示。
  // 表示要素は地図コントロール内にあり、マップ画面でのみ出るためビュー切替の反映は不要。
  on(el.toggleZoomDisplay, 'change', (e) => setZoomDisplayVisible(e.target.checked));
  // 現在地点をマーカー表示: 現在地マーカー(青丸)の表示/非表示を切替。
  // 現在地点表示ボタンが出す円とは独立だが、青丸を出すかはこのトグルに従う。
  on(el.toggleCurrentMarker, 'change', (e) => applyCurrentMarkerVisible(e.target.checked));
  // 現在地点表示ボタンはメニューのトグルとは独立(押すたびに円を3秒だけ表示する)
  setCurrentMarkerButtonHandler(handleCurrentSpotButton);
  // 現在地点は中央に表示: 地図を現在地へ追従させるか切替。
  // 他のトグルと同じく、切り替えてもメニュー(表示設定パネル)は開いたままにする
  // (ON にした直後の現在地は画面中央=パネルの真下に来るため、結果はパネルを閉じると見える)。
  on(el.toggleCenterCurrent, 'change', (e) => setFollowCurrentLocation(e.target.checked));
  // 移動経路を記録・写真を撮影のトグルと、それぞれのボタン・モーダル
  bindTrackEvents();
  bindPhotoEvents();
  bindPhotoViewEvents();
  // 表示設定パネルのトグルは切り替えるたびに保存する(次回起動時に restoreMapToggles で戻す)。
  // 各トグルの処理(上)より後に登録し、取り消しで checked を戻した場合も最終の状態を保存する
  for (const input of mapToggleInputs()) on(input, 'change', saveMapToggles);

  // マップ画面メニューから「マーカーの設定」モーダルを開く
  on(el.btnMapOpenMarkerSettings, 'click', () => {
    closeLayerPanel();
    openMarkerSettingsModal();
  });
}

// ===== 時刻表示 =====
let clockTimerId = null;

// 現在時刻を HH:MM 形式で時刻表示要素に反映
function updateClock() {
  el.mapClock.textContent = formatLocalTime();
}

// 時刻表示の ON/OFF。ON で要素を表示し1秒ごとに更新、OFF で停止・非表示
function setClockVisible(isOn) {
  if (clockTimerId !== null) {
    clearInterval(clockTimerId);
    clockTimerId = null;
  }
  if (isOn) {
    updateClock();
    clockTimerId = setInterval(updateClock, 1000);
    el.mapClock.hidden = false;
  } else {
    el.mapClock.hidden = true;
  }
}

// マップ画面の操作要素(メニューボタン ≡・時刻)を確実に表示状態へ戻す。
// これらは #map(position: fixed で常に画面全体)の上に絶対配置しているため、
// 何らかの理由でページがスクロールすると地図はそのままでボタンだけが
// 表示領域の外(主に上)へ出てしまい「消えた」ように見える。
// モーダルを閉じたときとマップ画面に入るときに呼び、位置と表示状態を正常化する。
function normalizeMapChrome() {
  resetPageScroll();

  // 表示状態も明示的に復帰(hidden / display の取り残し対策)
  el.btnMapLayers.hidden = false;
  el.btnMapLayers.style.display = '';
  // 時刻は「時刻を表示」トグルの状態に従う
  setClockVisible(el.toggleClock.checked);
}

// ===== ビュー切替 =====
function showView(name) {
  if (!el.views[name]) return;

  // 前の画面に残った入力状態を持ち込まない。
  // マーカーの設定のサイズ入力(数値入力欄)などにフォーカスが残っていると、
  // ハイキングマップ表示中にソフトキーボードや文字入力ウインドウが出てしまうため、
  // フォーカスを外してから、開いたままのモーダルをすべて閉じる。カメラも閉じる(映像を止める)
  blurActiveElement();
  closeAllModals();
  closeCamera();

  for (const [key, view] of Object.entries(el.views)) {
    view.hidden = (key !== name);
  }
  currentView = name;

  // ビューを切り替えたらマップ画面のメニューは閉じる。
  // 開いたまま「起動時の画面に戻る」で離れても、次にマップ画面へ入ったときは
  // メニューボタン(≡)で開くまで表示しない。
  closeLayerPanel();

  // ビュー名を body クラスに反映(地図コントロールの表示/非表示などで使用)
  for (const cls of [...document.body.classList]) {
    if (cls.startsWith('view-state-')) document.body.classList.remove(cls);
  }
  document.body.classList.add(`view-state-${name}`);

  if (name === 'map') {
    // マップビュー: メニューボタン等を確実に表示(モーダル閉じ後等の表示崩れ対策)
    normalizeMapChrome();

    // マップビュー: 緊急ポイント・ハイキングルート・通行止め等を常に表示
    setOverlaysVisible(true);
    // マップビューに入ったら現在地監視を開始。表示/追従はメニュートグルの状態に従う。
    // 先に監視を有効化してから各トグル状態を反映する(再表示の無駄打ちを避ける)。
    setLocationActiveForMapView(true, {
      onError: (msg) => {
        // 位置情報が取得できない場合(非HTTPS環境・権限拒否など)は現在地を表示できない。
        // 原因が分かるよう履歴・ステータスに出力する(連続エラーは geolocation.js 側で抑制)。
        setStatus(msg, 'error');
        logHistory(msg, 'error');
      }
    });
    applyCurrentMarkerVisible(el.toggleCurrentMarker.checked);
    setFollowCurrentLocation(el.toggleCenterCurrent.checked);
    // 移動経路を記録トグルの状態に応じて記録開始/停止ボタンの表示を更新
    applyTrackControlsForView(true);
    // 写真を撮影トグルの状態に応じてカメラボタンの表示を更新
    applyPhotoControlsForView(true);
    // 時刻表示は normalizeMapChrome() でトグルの状態に従って反映済み
    requestAnimationFrame(() => resizeMap());
  } else if (name === 'home') {
    // ホーム: 全オーバーレイを非表示にして地理院地図のみ表示
    setOverlaysVisible(false);
    // 移動記録中はマップ画面を離れても記録を続ける(記録は「記録停止」ボタンか
    // 「移動経路を記録」トグル OFF でのみ終了する)。geolocation.js 側も、記録中は
    // ビューに関わらず現在地監視を継続する。
    setLocationActiveForMapView(false);
    // 記録操作ボタン群・カメラボタンはマップ画面のUIなので隠す(記録状態自体は保持する)
    applyTrackControlsForView(false);
    applyPhotoControlsForView(false);
    // マップ以外では時刻表示を停止・非表示(トグル状態は保持)
    setClockVisible(false);
    requestAnimationFrame(() => resizeMap());
  }
}

// ===== QRコードモーダル(起動画面の「QR」から表示) =====
// いま開いている URL(location.href)をその場で QRコードにする。開くたびに作り直すのは、
// クエリ付きで開いた場合や PWA の起動 URL でも実際のアドレスとずれないようにするため。
function openQrCodeModal() {
  const url = location.href;
  el.qrCodeUrl.textContent = url;
  try {
    el.qrCodeImage.innerHTML = renderQrSvg(url);
  } catch (e) {
    // URL が長すぎる等で作れなかったとき。空欄のまま出さず理由を残す
    el.qrCodeImage.replaceChildren();
    const msg = t('qr.failed');
    el.qrCodeUrl.textContent = `${msg} (${url})`;
    notify(msg, 'error');
  }
  el.qrCodeModal.hidden = false;
}

// ===== アプリ更新の再読み込みをまたいだ画面の保持 =====
// アプリ更新の確認は起動画面のボタンのタップで走るため、確認が出るのはボタンで移った先
// (マップ画面・地図データのダウンロード・情報・言語・QRコード・使い方)の上になる。
// 更新(再読み込み)のたびに起動画面へ戻らないよう、再読み込みの直前に画面を控えて戻す。
// 戻すモーダルは、起動画面のボタンから開くものに限る(開き直すための関数があるもの)
const RESTORABLE_MODALS = {
  downloadModal: () => openDownloadModal(),
  appSettingsModal: () => openAppSettingsModal(),
  qrCodeModal: () => openQrCodeModal()
};

function saveScreenForReload() {
  const openModal = document.querySelector('.modal:not([hidden])');
  const screen = {
    view: currentView,
    modal: openModal && RESTORABLE_MODALS[openModal.id] ? openModal.id : null,
    guide: isGuideOpen()
  };
  // マップ画面なら、表示していた位置とズームレベルも戻す
  const map = getMap();
  if (currentView === 'map' && map) {
    const center = map.getCenter();
    screen.map = { lat: center.lat, lng: center.lng, zoom: map.getZoom() };
  }
  writeSession(RESTORE_SCREEN_KEY, JSON.stringify(screen));
}

// 控えは一度きりの復元用なので、読み取ったら必ず削除する(以降の通常起動では起動画面のまま)
function restoreScreenAfterReload() {
  let screen = null;
  try {
    screen = JSON.parse(takeSession(RESTORE_SCREEN_KEY));
  } catch { /* 壊れた控えは使わない */ }
  if (!screen || typeof screen !== 'object') return;
  if (screen.view === 'map') {
    showView('map');
    const m = screen.map;
    const map = getMap();
    if (map && m && Number.isFinite(m.lat) && Number.isFinite(m.lng) && Number.isFinite(m.zoom)) {
      map.setView([m.lat, m.lng], m.zoom, { animate: false });
    }
  }
  RESTORABLE_MODALS[screen.modal]?.();
  if (screen.guide) openGuide();
}

// ===== 更新版の確認(起動画面のボタンのタップ時) =====
// アプリと公開データの更新版を、同じきっかけでまとめて確認する
function checkForUpdates() {
  checkAppShellUpdate();
  checkPublishedDataUpdate();
}

// ===== 起動時のバージョン確認(履歴記録) =====
// 起動時に確認したバージョン(地図/アプリ)を履歴に残す
// onApplied はキャッシュ描画と更新取得のつど呼ばれるため、履歴への記録は1回に絞る
let startupVersionLogged = false;
async function logStartupVersionCheckOnce() {
  if (startupVersionLogged) return;
  startupVersionLogged = true;
  const v = getManifestVersion();
  const mv = v ? `v${v}` : t('common.unknown');
  const shell = (await getCachedAppShellVersion()) || t('common.unknown');
  logHistory(t('startup.versionCheck', { map: mv, app: shell }), '');
}

// 起動
init();
