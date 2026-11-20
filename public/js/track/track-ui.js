// 移動経路の操作(表示設定パネルの「移動経路を記録」とその周り)
// - 「移動経路を記録」トグルと、記録開始・停止ボタン(メニューボタンの左)
// - 記録の停止(■の長押し・続けてのタップ → 確認)
// - 表示中の経路があるときの「クリア/追加/中止」の選択(記録開始・GPX 読み込みで共用)
// - パネルの統計表・「未出力あり/出力済み」・GPX 読み込み・出力・クリア
// - 起動時の経路の復元と、停止操作を経ずに終わった記録の検出
// 経路のデータと描画は track.js、記録の開始・停止(現在地の監視を含む)は geolocation.js、
// GPX の組み立て・解析は gpx.js が担う。
import {
  getTrackStats, getTrackStatsList, getTrackSegments, clearTrack, loadTrackSegments, fitMapToTrack,
  restoreSavedTrack, setOnTrackPointAppended, setOnTrackNotice, isTrackRecording
} from './track.js';
import { startTrackRecording, stopTrackRecording } from '../map/geolocation.js';
import { hasUnexportedPhotos, getPhotoCount } from '../photo/photos.js';
import { isZipFile } from '../photo/kmz.js';
import { buildTrackGpx, parseTrackGpx } from './gpx.js';
import {
  TRACK_EXPORT_SEQ_KEY, TRACK_RECORDING_FLAG_KEY, TRACK_UNEXPORTED_KEY,
  TRACK_STOP_HOLD_MS, TRACK_STOP_CONFIRM_SEC, TRACK_STOP_TAP_INTERVAL_MS, TRACK_STOP_TAP_GUARD_MS,
  TRACK_BATTERY_NOTICE_SEC
} from '../common/config.js';
import { t } from '../common/i18n.js';
import { logHistory, showToast, showToastAfterCurrent, notify, notifyError } from '../common/messages.js';
import { getNoticeText } from '../info/faq.js';
import { readLocal, writeLocal } from '../common/storage.js';
import { formatLocalDate } from '../common/utils.js';
import { on, closeModal, setModalHooks } from '../common/ui.js';
import { closeLayerPanel, saveMapToggles, setToggleStatus, buildStatCell, buildStatPair } from '../map/layer-panel.js';
import {
  defaultExportName, writeExportSeq, openExportNameModal, readExportName, downloadBlob
} from '../common/file-export.js';

const el = {
  toggleTrackRecording: document.getElementById('toggleTrackRecording'),
  // 「移動経路を記録」ON のとき表示する記録開始・停止トグル(メニューボタンの左)
  btnTrackToggle: document.getElementById('btnTrackToggle'),
  // レイヤーパネル内: 移動経路の件数と出力済みかどうか(トグルの右)・統計表(経路ごとの
  // 地点数・移動距離)・読み込み・出力・クリア。統計とボタンはトグル ON のときだけ出す。
  // 統計は経路の本数に応じてここで組み立てる
  trackStatus: document.getElementById('trackStatus'),
  trackStats: document.getElementById('trackStats'),
  trackActions: document.getElementById('trackActions'),
  btnTrackImport: document.getElementById('btnTrackImport'),
  btnTrackExport: document.getElementById('btnTrackExport'),
  btnTrackClear: document.getElementById('btnTrackClear'),
  trackImportInput: document.getElementById('trackImportInput'),
  // 表示中の経路があるときに「クリア/追加/中止」を選ぶモーダル(記録開始・読み込みで共用)
  trackExistingModal: document.getElementById('trackExistingModal'),
  trackExistingTitle: document.getElementById('trackExistingTitle'),
  trackExistingMessage: document.getElementById('trackExistingMessage'),
  btnTrackExistingClear: document.getElementById('btnTrackExistingClear'),
  btnTrackExistingAppend: document.getElementById('btnTrackExistingAppend'),
  // 移動経路の記録の停止を確認するモーダル(■の長押し・続けてのタップ・トグルのオフで共用)
  trackStopModal: document.getElementById('trackStopModal'),
  trackStopAutoClose: document.getElementById('trackStopAutoClose'),
  btnTrackStopOk: document.getElementById('btnTrackStopOk'),
  // 移動経路の出力(GPX)モーダル。未出力の写真があるときは出し忘れの案内を添える
  trackExportModal: document.getElementById('trackExportModal'),
  trackExportName: document.getElementById('trackExportName'),
  trackExportPhotoNote: document.getElementById('trackExportPhotoNote'),
  btnTrackExportSave: document.getElementById('btnTrackExportSave')
};

// ===== イベントの登録(app.js の bindEvents から1回呼ぶ) =====
export function bindTrackEvents() {
  on(el.toggleTrackRecording, 'change', onTrackToggleChange);

  // 記録開始・停止トグルボタン: 移動経路を記録トグル ON のときのみ表示・操作可。
  // 記録中なら停止、停止中なら開始する(押下ごとにアイコンが切り替わる)。
  on(el.btnTrackToggle, 'click', (e) => {
    // ボタンが表示されている(=移動経路を記録 ON で現在地表示が有効)ときのみ動作。
    // checked の値に依存すると、位置情報エラーで checked が戻されたとき無言で
    // 効かなくなるため、ボタン自身の表示状態で判定する。
    if (el.btnTrackToggle.hidden) return;
    if (!isTrackRecording()) {
      beginTrackRecording();
      return;
    }
    // キーボード(Enter/Space)での操作は click の detail が 0。意図した操作なので確認を出す
    if (e.detail === 0) {
      openTrackStopModal('track.stopByButton');
      return;
    }
    // 記録中の停止は長押し(→ bindTrackStopHold)か、続けてのタップ(→ handleTrackStopTap)
    handleTrackStopTap();
  });
  bindTrackStopHold();
  on(el.btnTrackStopOk, 'click', confirmTrackStop);

  // 読み込み: GPX ファイルを選び、記録済みの移動経路として地図に表示する(写真は扱わない)。
  // 記録中は経路が入れ替わると記録が壊れるため受け付けない。
  // 既存の経路があるときは、クリア/追加/中止をモーダルで選んでからファイル選択へ進む。
  on(el.btnTrackImport, 'click', () => {
    if (isTrackRecording()) {
      showToast(t('track.importWhileRecording'));
      return;
    }
    if (hasTrack()) {
      openTrackExistingModal('import');
      return;
    }
    openTrackImportPicker(false);
  });
  on(el.trackImportInput, 'change', importTrackFile);

  // 「クリア/追加/中止」モーダルの2ボタン。中止(キャンセル・×・背景)は
  // 共通の [data-close-modal] が閉じるだけで、経路には手を付けない。
  on(el.btnTrackExistingClear, 'click', () => resolveTrackExisting(false));
  on(el.btnTrackExistingAppend, 'click', () => resolveTrackExisting(true));

  // 出力: 記録済みの移動経路を GPX 形式でファイルに出力する(写真は写真の「出力」から)
  on(el.btnTrackExport, 'click', openTrackExportModal);
  on(el.btnTrackExportSave, 'click', handleTrackExportSave);

  // 記録点が追加されるたびにパネル内の件数・統計表を最新化する。
  // 記録で増えたとき(読み込みではないとき)は、経路を未出力にする
  setOnTrackPointAppended(({ recorded = false } = {}) => {
    if (recorded) setTrackUnexported(true);
    updateTrackPanel();
  });

  // 移動記録からの通知(画面スリープ防止が使えない場合など)。
  // 記録開始と同時に届くため、「移動記録を開始しました」のトーストを
  // 上書きしないよう、そのトーストが消えてから表示する。
  setOnTrackNotice((msg) => {
    logHistory(msg, 'error');
    showToastAfterCurrent(msg);
  });

  on(el.btnTrackClear, 'click', clearTrackByUser);
}

// 「移動経路を記録」トグルの切替
function onTrackToggleChange(e) {
  const isOn = e.target.checked;
  if (!isOn) {
    // OFF: 軌跡が消去される前に終了処理(統計の出力)を行う。
    // 記録中は確認を挟む(誤って触れただけで記録が終わらないようにする)。確認は
    // モーダルで答えを待たずに返るため、トグルはいったん ON に戻し、停止が選ばれたら
    // OFF にする(→ confirmTrackStop)。この後の saveMapToggles も ON のまま保存する
    if (isTrackRecording()) {
      e.target.checked = true;
      openTrackStopModal('track.stopByToggle');
      return;
    }
    finishTrackRecording('track.stopByToggle');
  }
  // ON にしたときは、ご利用の注意と同じ電池の注意を、読み切れるよう長めに出す
  // (起動時にトグルの状態を戻すときは change が来ないので出ない)
  if (isOn) showToast(getNoticeText('trackBattery'), { durationSec: TRACK_BATTERY_NOTICE_SEC });
  // 記録開始・停止ボタンの表示を切替。
  // 現在地の監視は「現在地点をマーカー表示」等のトグルが管理するため、ここでは触らない。
  updateTrackButtonState(isOn);
  // パネルの統計表・ボタン行も、トグル ON のときだけ出す
  updateTrackPanel();
}

// クリア: 記録した移動経路(線・開始点・現在地点)を消去する(写真は消さない)。
// 出力していない経路があれば、先に出力するよう添える。出力済みのときは、保存されたかどうかが
// アプリに分からない(保存の画面で取りやめても出力済みになる)ため、保存を確かめてから消すよう添える
function clearTrackByUser() {
  if (!hasTrack()) {
    showToast(t('track.nothingToClear'));
    return;
  }
  const note = hasUnexportedTrack() ? 'track.unexportedWarning' : 'track.exportedCheckNote';
  const message = `${t('track.clearConfirm')}\n\n${t(note)}`;
  if (!confirm(message)) return;
  clearTrack();
  setTrackUnexported(false);
  writeTrackRecordingFlag(false);
  setTrackRecordingActive(false);
  updateTrackPanel();
  notify(t('track.cleared'));
}

// ===== 記録開始・停止ボタンの表示 =====
// 画面に合わせて記録開始・停止ボタンを出し分ける(app.js の showView から)。
// ハイキングマップ表示では「移動経路を記録」トグルに従い、起動時画面では隠す(記録状態自体は保持する)
export function applyTrackControlsForView(isMapView) {
  updateTrackButtonState(isMapView && el.toggleTrackRecording.checked);
}

// 移動経路を記録トグルの状態に応じて、記録開始/停止ボタンの表示を切替
function updateTrackButtonState(enabled) {
  if (el.btnTrackToggle) el.btnTrackToggle.hidden = !enabled;
  // ボタンの見た目(開始▶/停止■)は実際の記録状態に合わせる。
  // 起動時画面へ移動しても記録は続くため、ここで一律に停止状態へは戻さない
  // (トグル OFF の場合は呼び出し元が先に finishTrackRecording している)。
  setTrackRecordingActive(isTrackRecording());
}

// 記録中かどうかに応じてトグルボタンのアイコン(開始▶/停止■)とラベルを切り替える
function setTrackRecordingActive(active) {
  el.btnTrackToggle.classList.toggle('is-recording', active);
  const label = active ? t('track.stop') : t('track.start');
  el.btnTrackToggle.setAttribute('aria-label', label);
  el.btnTrackToggle.setAttribute('title', label);
}

// ===== 起動時の復元 =====
// 記録の実行中フラグ(localStorage)。記録開始で立て、停止・クリア・読み込みで降ろす。
// 停止操作を経ずにアプリが終わると立ったまま残るため、次の起動でそれを検出できる。
function writeTrackRecordingFlag(isOn) {
  writeLocal(TRACK_RECORDING_FLAG_KEY, isOn ? '1' : null);
}

// 起動時に1回だけ呼ぶ。前回の記録が停止操作を経ずに終わっていたら履歴に残す。
// 経路そのものは端末に保存してあり起動時に復元されるが、記録は再開されないため、
// 中断していたあいだに歩いた区間は残らない。「■ を押していないのに止まっていた」
// の切り分けに使う(この行があれば操作ではなくアプリの中断が原因)。
// 経路の復元より先に呼んで、履歴が起きた順(中断 → 復元)に並ぶようにする
export function logInterruptedTrackRecording() {
  if (readLocal(TRACK_RECORDING_FLAG_KEY) !== '1') return;
  writeTrackRecordingFlag(false);
  logHistory(t('track.interrupted'), 'error');
}

// 端末に保存してある移動経路を読み出して地図に表示する(起動時に1回)。
// 記録は再開しない(→ track.js の restoreSavedTrack)ため、続きを記録するには
// 改めて記録開始ボタンを押し、「追加」を選ぶ。
// 何が表示されているのかが分かるよう、復元したときは履歴に残す。
// 地図は初期表示のまま(箕面大滝・z=15)にしておく。経路の位置へ勝手に飛ぶと、
// 起動画面の地図が前回の場所に変わってしまうため。
// マーカーのスタイルの反映(marker-settings.js の applyMarkerSettings)より後に呼ぶこと
export async function restoreTrackFromStorage() {
  const restored = await restoreSavedTrack();
  if (restored === 0) return;
  const stats = getTrackStats();
  logHistory(t('track.restored', { summary: formatTrackSummary(stats, 0, 1) }), '');
}

// 表示中の経路(記録点)が1つでもあるか。クリア・出力・記録開始/読み込みの確認の要否に使う
function hasTrack() {
  return getTrackStats().pointCount > 0;
}

// ===== 経路を出力(GPX)したか =====
// 経路ごとには持たず、1つの印で全体を表す(1本でも未出力があれば全部を未出力として扱う。
// 出力は常に全部の経路をまとめて書き出すため、それで足りる)。
// 記録点が増えたら未出力、出力・クリア・置き換えの読み込みで出力済みにする。
// 印が無いとき・読めないとき(この印を入れる前から端末に残っている経路)は、念のため未出力とみなす。
function hasUnexportedTrack() {
  if (!hasTrack()) return false;
  return readLocal(TRACK_UNEXPORTED_KEY, '1') !== '0';
}

function setTrackUnexported(isOn) {
  writeLocal(TRACK_UNEXPORTED_KEY, isOn ? '1' : '0');
}

// 記録地点数・移動距離の統計文言(履歴・トースト用。距離は統計表と同じ小数点以下1位)。
// 経路が複数あるときは「経路 n:」を先頭に付ける。地点数0の経路は残らないため番号は付けない。
function formatTrackSummary(stats, index, total) {
  const km = (stats.distanceM / 1000).toFixed(1);
  const summary = t('track.summary', { points: stats.pointCount, km });
  if (total <= 1 || stats.pointCount === 0) return summary;
  return `${t('track.routeIndex', { n: index + 1 })}: ${summary}`;
}

// ===== 表示設定パネルの表示 =====
// トグルの右の出力済みかどうかと、トグル ON のときだけ出す統計表・ボタン行
export function updateTrackPanel() {
  const isOn = !!el.toggleTrackRecording?.checked;
  if (el.trackStats) el.trackStats.hidden = !isOn;
  if (el.trackActions) el.trackActions.hidden = !isOn;
  // 記録開始直後の地点数0の経路だけのときは出さない(まだ何も無いため)
  setToggleStatus(el.trackStatus, hasTrack(), hasUnexportedTrack());
  if (isOn) renderTrackStats();
}

// レイヤーパネル内の統計表を描く。経路1本につき1行で、経路が複数あるときだけ
// 行の左に「経路 n」を添える。
function renderTrackStats() {
  if (!el.trackStats) return;
  const list = getTrackStatsList();
  // 経路が無いときも 0 の行を1行出す(表の枠が消えて見えなくなるのを避ける)
  const rows = list.length > 0 ? list : [{ pointCount: 0, distanceM: 0 }];
  const showIndex = rows.length > 1;
  el.trackStats.classList.toggle('has-index', showIndex);
  el.trackStats.innerHTML = '';
  rows.forEach((stats, i) => {
    if (showIndex) {
      el.trackStats.appendChild(buildStatCell('track-stat-index', t('track.routeIndex', { n: i + 1 })));
    }
    el.trackStats.appendChild(buildStatPair(t('track.statPoints'), String(stats.pointCount)));
    el.trackStats.appendChild(
      buildStatPair(t('track.statDistance'), `${(stats.distanceM / 1000).toFixed(1)} (km)`)
    );
  });
}

// ===== 表示中の経路があるときの選択(クリア/追加/中止) =====
// 記録開始と読み込みで同じモーダルを共用する。中止(キャンセル・×・背景)を選べるよう
// confirm ではなくモーダルにしており、閉じただけのときは何もしない。
// どちらのボタンが押されたかを判断するため、開いた用途を保持する。
let trackExistingMode = null;  // 'record' | 'import'

// 閉じたのは操作の中止。保持した用途を捨てる
setModalHooks('trackExistingModal', { afterClose: () => { trackExistingMode = null; } });

function openTrackExistingModal(mode) {
  trackExistingMode = mode;
  const isRecord = mode === 'record';
  el.trackExistingTitle.textContent = t(isRecord ? 'track.existingTitleRecord' : 'track.existingTitleImport');
  // 出力していない経路があれば、先に出力するよう添える
  const routes = getTrackStatsList().length;
  let message = t('track.existingMessage', { routes });
  if (hasUnexportedTrack()) message += `\n${t('track.unexportedWarning')}`;
  el.trackExistingMessage.textContent = message;
  el.btnTrackExistingClear.textContent = t(isRecord ? 'track.existingClearRecord' : 'track.existingClearImport');
  el.btnTrackExistingAppend.textContent = t(isRecord ? 'track.existingAppendRecord' : 'track.existingAppendImport');
  el.trackExistingModal.hidden = false;
}

// クリア/追加のどちらかが選ばれたとき: モーダルを閉じて、開いた用途の操作を続行する。
// ファイル選択(input.click())はこのクリック操作の延長で呼ぶ必要があるため同期的に進める。
function resolveTrackExisting(append) {
  const mode = trackExistingMode;
  closeModal(el.trackExistingModal);
  if (mode === 'record') startTrackRecordingNow(append);
  else if (mode === 'import') openTrackImportPicker(append);
}

// ===== 記録の開始 =====
// 移動記録を開始(記録開始ボタン)。既存の経路が表示されている場合は、
// クリア/追加/中止をモーダルで選んでから開始する(→ resolveTrackExisting)。
function beginTrackRecording() {
  if (hasTrack()) {
    openTrackExistingModal('record');
    return;
  }
  startTrackRecordingNow(false);
}

// 実際に記録を開始する。開始を履歴に残す。
// 軌跡は「クリア」まで移動記録と共に保持するため、追加時(append)はそのまま残す。
function startTrackRecordingNow(append) {
  startTrackRecording({ append });
  setTrackRecordingActive(true);
  writeTrackRecordingFlag(true);
  // クリアして開始した場合は統計表も 0 に戻す
  updateTrackPanel();
  notify(t('track.started'), 'success');
}

// ===== 移動記録の停止(長押し・続けてのタップ → 確認) =====
// 記録中は画面が消えないため、ポケットの中で布越しに触れて記録停止ボタン(■)が押され、
// 停止の確認が出たままになることがあった。そこで停止は■の長押し(TRACK_STOP_HOLD_MS)か、
// 続けての複数回のタップに限り、確認は操作が無ければ TRACK_STOP_CONFIRM_SEC 秒で
// 閉じて記録を続ける。
// 確認を標準の confirm にしないのは、表示中はページの処理が止まり位置が記録されないため。
// このボタンはメニューボタン(≡)のすぐ左(間隔 8px)にあり、≡ を狙った指が触れることもある。
// 停止すると記録中の経路がその場で確定し、押す前の状態には戻せない
// (再開しても別の経路として記録される)。開始は取り消せるので長押しも確認も要らない。
let trackStopHoldTimer = null;       // 長押しの判定タイマー
let trackStopHoldFired = false;      // 長押しで確認を出した(指を離したときの click を無視する)
let trackStopBy = null;              // 停止の確認を開いた操作(履歴用の文言キー)
let trackStopAutoCloseTimer = null;  // 停止の確認を自動で閉じるタイマー
let trackStopLastTapAt = 0;          // 前回のタップの時刻(ms)
let trackStopTapGuardUntil = 0;      // タップで確認を出した直後、この時刻(ms)までの click を捨てる

// 停止の確認を閉じたのは停止の取り消し(記録は続ける)。自動で閉じるタイマーも止める
setModalHooks('trackStopModal', {
  afterClose: () => {
    trackStopBy = null;
    clearTimeout(trackStopAutoCloseTimer);
    trackStopAutoCloseTimer = null;
  }
});

// 記録中の■の短いタップ。前のタップから TRACK_STOP_TAP_INTERVAL_MS 以内なら(続けて複数回の
// タップ)停止の確認を出し、そうでなければ止め方だけを伝える
function handleTrackStopTap() {
  const now = Date.now();
  const isRepeated = now - trackStopLastTapAt <= TRACK_STOP_TAP_INTERVAL_MS;
  trackStopLastTapAt = now;
  if (!isRepeated) {
    showToast(t('track.stopHoldHint'));
    return;
  }
  trackStopLastTapAt = 0;
  // 続けてのタップは確認が出た後も勢いで続き、指の下に現れた確認の背景や「停止する」に
  // 当たるため、少しの間は確認への click を捨てる(→ bindTrackStopHold の click の捕捉)
  trackStopTapGuardUntil = now + TRACK_STOP_TAP_GUARD_MS;
  openTrackStopModal('track.stopByTaps');
}

function bindTrackStopHold() {
  const btn = el.btnTrackToggle;
  if (!btn) return;
  btn.style.setProperty('--hold-ms', `${TRACK_STOP_HOLD_MS}ms`);
  const cancelHold = () => {
    clearTimeout(trackStopHoldTimer);
    trackStopHoldTimer = null;
    btn.classList.remove('is-holding');
  };
  btn.addEventListener('pointerdown', (e) => {
    if (!isTrackRecording() || btn.hidden || e.button !== 0) return;
    cancelHold();
    trackStopHoldFired = false;
    btn.classList.add('is-holding');
    trackStopHoldTimer = setTimeout(() => {
      cancelHold();
      trackStopHoldFired = true;
      openTrackStopModal('track.stopByButton');
    }, TRACK_STOP_HOLD_MS);
  });
  // 指を離す・ボタンの外へずらす・地図の操作などに取られたら、長押しをやめる
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
    btn.addEventListener(type, cancelHold);
  }
  // 長押しで出る端末のメニュー(コンテキストメニュー)を出さない
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // 長押しで確認を出した後、指を離したときの click を捨てる。端末によっては、指の下に
  // 現れた確認の背景(押すと閉じる)へ click が届き、出した確認がすぐ閉じてしまうため。
  // click が来ないまま次の操作に移ったときは、その pointerdown で印を降ろす
  document.addEventListener('pointerdown', () => { trackStopHoldFired = false; }, true);
  document.addEventListener('click', (e) => {
    // 続けてのタップで確認を出した直後の、余分なタップによる click を捨てる
    if (Date.now() < trackStopTapGuardUntil && e.detail !== 0 && el.trackStopModal.contains(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!trackStopHoldFired || e.detail === 0) return;
    trackStopHoldFired = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

// 停止の確認を開く。stopBy は履歴に添える操作の文言キー
function openTrackStopModal(stopBy) {
  if (!isTrackRecording()) return;
  trackStopBy = stopBy;
  el.trackStopAutoClose.textContent = t('track.stopAutoClose', { sec: TRACK_STOP_CONFIRM_SEC });
  el.trackStopModal.hidden = false;
  clearTimeout(trackStopAutoCloseTimer);
  trackStopAutoCloseTimer = setTimeout(() => closeModal(el.trackStopModal), TRACK_STOP_CONFIRM_SEC * 1000);
}

// 停止の確認で「停止する」が選ばれたとき
function confirmTrackStop() {
  const stopBy = trackStopBy;
  closeModal(el.trackStopModal);
  if (!isTrackRecording()) return;
  finishTrackRecording(stopBy);
  // トグルのオフから開いたときは、ここでトグルを OFF にして保存する
  if (stopBy === 'track.stopByToggle') {
    el.toggleTrackRecording.checked = false;
    updateTrackButtonState(false);
    saveMapToggles();
  }
}

// 移動記録を終了(記録停止ボタン/トグルOFF)。記録中だったときのみ、いま記録していた経路の
// 地点数・移動距離を履歴とトーストに出す(記録中の経路は常に最後の経路)。
// 軌跡が消去される前に統計を取得する必要がある点に注意。
// stopBy には停止のきっかけとなった操作の文言キー('track.stopByButton' / 'track.stopByTaps' /
// 'track.stopByToggle')を渡し、履歴にだけ添える(「操作していないのに止まっていた」ときの切り分け用。
// トーストは操作直後に本人が見るものなので付けない)。
function finishTrackRecording(stopBy) {
  const wasRecording = isTrackRecording();
  const list = getTrackStatsList();
  const stats = list[list.length - 1] || { pointCount: 0, distanceM: 0 };
  stopTrackRecording();
  setTrackRecordingActive(false);
  writeTrackRecordingFlag(false);
  if (wasRecording) {
    const summary = formatTrackSummary(stats, list.length - 1, list.length);
    const history = stopBy
      ? t('track.finishedBy', { by: t(stopBy), summary })
      : t('track.finished', { summary });
    logHistory(history, 'success');
    showToast(t('track.finished', { summary }));
  }
  // 地点数0で終わった経路は破棄されるため、統計表を取り直す
  updateTrackPanel();
  // 軌跡は「クリア」まで保持するため、ここではリセットしない。
}

// ===== 移動経路の出力(GPX) =====
// 出力ファイル名の日付: 記録開始の当日(最初の記録点の記録日。時刻が無ければ今日)
function getTrackDateStr() {
  const first = getTrackSegments()[0]?.[0];
  return formatLocalDate(first?.timeMs || Date.now());
}

// 出力モーダルを開く。出力していない写真があるときは、写真の出し忘れの案内を添える
// (写真は写真の「出力」から別に出力する)。
function openTrackExportModal() {
  if (!hasTrack()) {
    showToast(t('track.nothingToExport'));
    return;
  }
  if (el.trackExportPhotoNote) {
    const unexportedPhotos = hasUnexportedPhotos();
    el.trackExportPhotoNote.hidden = !unexportedPhotos;
    el.trackExportPhotoNote.textContent = unexportedPhotos ? t('track.exportPhotoNote', { n: getPhotoCount() }) : '';
  }
  openExportNameModal(el.trackExportModal, el.trackExportName,
    defaultExportName(TRACK_EXPORT_SEQ_KEY, getTrackDateStr()));
}

// 出力ボタン: GPX を生成してダウンロードし、連番を保存して出力済みにし、モーダルを閉じる
// (完了メッセージを出さない理由は file-export.js の downloadBlob)。
function handleTrackExportSave() {
  const name = readExportName(el.trackExportName);
  if (!name) {
    showToast(t('track.exportNeedName'));
    return;
  }
  const segments = getTrackSegments().filter((seg) => seg.length > 0);
  if (segments.length === 0) {
    showToast(t('track.nothingToExport'));
    closeModal(el.trackExportModal);
    return;
  }
  const fileName = `${name}.gpx`;
  downloadBlob(new Blob([buildTrackGpx(segments, name)], { type: 'application/gpx+xml' }), fileName);
  writeExportSeq(TRACK_EXPORT_SEQ_KEY, name);
  setTrackUnexported(false);
  updateTrackPanel();
  closeModal(el.trackExportModal);
}

// ===== 移動経路の読み込み(GPX) =====
// 既存の経路をクリアするか追加するかの選択。選択はファイル選択より前に行うため、
// 結果をここで保持してファイル選択後の処理(importTrackFile)へ引き継ぐ。
let importAppend = false;

// ファイル選択ダイアログを開く。append は選択後の反映方法として保持する。
function openTrackImportPicker(append) {
  importAppend = append;
  // 同じファイルを続けて選べるよう、選択値を毎回クリアしてから開く
  el.trackImportInput.value = '';
  el.trackImportInput.click();
}

// ファイル選択後: GPX を移動経路として表示する。事前に選んだ「クリア/追加」に従う。
// KMZ(写真)を選んだときは、写真の「読み込み」を案内して何もしない。
// クリアして読み込んだ経路はファイルが手元にあるため出力済みとし、追加のときは元の印のままにする。
async function importTrackFile(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    if (await isZipFile(file)) {
      showToast(t('track.importIsKmz'));
      return;
    }
    const segments = parseTrackGpx(await file.text());
    if (segments.length === 0) {
      showToast(t('track.importNoPoints'));
      return;
    }
    const count = loadTrackSegments(segments, { append: importAppend });
    if (!importAppend) setTrackUnexported(false);
    // 読み込んだ経路は記録済みの状態として扱い(記録開始ボタンは停止表示に戻す)、
    // 統計表を更新して、読み込んだものが見えるようメニューを閉じて全体を表示する
    writeTrackRecordingFlag(false);
    setTrackRecordingActive(false);
    updateTrackPanel();
    closeLayerPanel();
    fitMapToTrack();
    // 経路が複数含まれていた場合は経路数も添える
    const msg = segments.length > 1
      ? t('track.importedMulti', { name: file.name, routes: segments.length, count })
      : t('track.imported', { name: file.name, count });
    notify(msg, 'success');
  } catch (err) {
    notifyError('track.importFailed', err);
  }
}
