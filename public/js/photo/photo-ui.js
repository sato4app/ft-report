// 写真の操作(表示設定パネルの「写真を撮影」とその周り。移動経路の記録とは別の機能)
// - 「写真を撮影」トグルと、カメラボタン(メニューボタンの左)・写真の表示の「追加撮影」
// - 撮影(アプリ内カメラ → 位置の取り直し → 保存)と、その日の最初の撮影での「クリア/追加/中止」の確認
// - 枚数が上限に近づいたときの警告
// - パネルの枚数・「未出力あり/出力済み」・KMZ 読み込み・出力・クリア
// 写真のデータは photos.js、カメラは camera.js、写真の表示・一覧は photo-view.js、
// KMZ の組み立て・解析は kmz.js が担う。
import {
  setPhotoHandlers, getPhotos, getPhotoCount, fitMapToPhotos, addPhoto, clearPhotos, restorePhotos,
  importPhotos, hasUnexportedPhotos, markPhotosExported
} from './photos.js';
import { isCameraSupported, openCamera, setCameraStatus } from './camera.js';
import { isZipFile, loadPhotoBytes, buildPhotosKmz, parsePhotosKmz } from './kmz.js';
import { capturePhotoPosition } from '../map/geolocation.js';
import { openPhotoView, isPhotoViewOpen, refreshPhotoViewIndex, commitPhotoViewName } from './photo-view.js';
import { PHOTO_EXPORT_SEQ_KEY, PHOTO_SHOOT_CONFIRMED_KEY, PHOTO_MAX_COUNT, PHOTO_WARN_RATIO } from '../common/config.js';
import { t } from '../common/i18n.js';
import { logHistory, showToast, showToastAfterCurrent, notify, notifyError } from '../common/messages.js';
import { readLocal, writeLocal } from '../common/storage.js';
import { formatLocalDate } from '../common/utils.js';
import { on, blurActiveElement, closeModal, setModalHooks } from '../common/ui.js';
import { closeLayerPanel, setToggleStatus, buildStatPair } from '../map/layer-panel.js';
import {
  defaultExportName, writeExportSeq, openExportNameModal, readExportName, downloadBlob
} from '../common/file-export.js';

const el = {
  // 「写真を撮影」。ON のとき表示するカメラボタン(記録開始・停止トグルの左)と、
  // レイヤーパネル内の件数と出力済みかどうか(トグルの右)・読み込み・出力・クリア
  togglePhotoCapture: document.getElementById('togglePhotoCapture'),
  btnPhotoCamera: document.getElementById('btnPhotoCamera'),
  photoStatus: document.getElementById('photoStatus'),
  photoStats: document.getElementById('photoStats'),
  photoActions: document.getElementById('photoActions'),
  btnPhotoImport: document.getElementById('btnPhotoImport'),
  btnPhotoExport: document.getElementById('btnPhotoExport'),
  btnPhotoClear: document.getElementById('btnPhotoClear'),
  photoImportInput: document.getElementById('photoImportInput'),
  // 表示中の写真があるときに「クリア/追加/中止」を選ぶモーダル(その日の最初の撮影・読み込みで共用)
  photoExistingModal: document.getElementById('photoExistingModal'),
  photoExistingTitle: document.getElementById('photoExistingTitle'),
  photoExistingMessage: document.getElementById('photoExistingMessage'),
  btnPhotoExistingClear: document.getElementById('btnPhotoExistingClear'),
  btnPhotoExistingAppend: document.getElementById('btnPhotoExistingAppend'),
  // 写真の出力(KMZ)モーダル
  photoExportModal: document.getElementById('photoExportModal'),
  photoExportName: document.getElementById('photoExportName'),
  btnPhotoExportSave: document.getElementById('btnPhotoExportSave'),
  // 写真の表示の「追加撮影」(写真の表示の上にカメラを開いて追加で撮る)
  btnPhotoViewShoot: document.getElementById('btnPhotoViewShoot')
};

// ===== イベントの登録(app.js の bindEvents から1回呼ぶ) =====
export function bindPhotoEvents() {
  // 写真を撮影: ON でカメラボタンと、パネルの読み込み・出力・クリアを出す(移動経路とは無関係)。
  // OFF から ON にしたら、次の撮影で「クリア/追加」を聞き直す(→ openPhotoCamera)
  on(el.togglePhotoCapture, 'change', (e) => {
    const isOn = e.target.checked;
    if (isOn) writeShootConfirmedDate(null);
    updatePhotoButtonState(isOn);
    updatePhotoPanel();
  });

  // カメラボタン: アプリ内カメラを開く(移動経路の記録とは無関係に撮影できる)
  on(el.btnPhotoCamera, 'click', openPhotoCamera);
  // 写真の表示: 地図のカメラの印から開く。枚数・出力済みかどうかが変わったらパネルの表示を更新する
  setPhotoHandlers({ onClick: openPhotoView, onChanged: updatePhotoPanel });
  // 写真の表示の「追加撮影」: 写真の表示の上にカメラを開いて追加で撮る(撮った写真は最後に加わり、その表示に替わる)
  on(el.btnPhotoViewShoot, 'click', shootFromPhotoView);

  // 写真の読み込み: KMZ ファイルを選び、写真を地図に表示する。経路の記録中でも読み込める
  // (経路には触れないため)。既存の写真があるときは、クリア/追加/中止を選んでからファイル選択へ進む
  on(el.btnPhotoImport, 'click', () => {
    if (getPhotoCount() > 0) {
      openPhotoExistingModal('import');
      return;
    }
    openPhotoImportPicker(false);
  });
  on(el.photoImportInput, 'change', importPhotoFile);
  // 写真の「クリア/追加/中止」モーダルの2ボタン(中止は閉じるだけで、写真には手を付けない)
  on(el.btnPhotoExistingClear, 'click', () => resolvePhotoExisting(false));
  on(el.btnPhotoExistingAppend, 'click', () => resolvePhotoExisting(true));
  // 写真の出力: 全部の写真を KMZ 形式でファイルに出力する
  on(el.btnPhotoExport, 'click', openPhotoExportModal);
  on(el.btnPhotoExportSave, 'click', handlePhotoExportSave);

  on(el.btnPhotoClear, 'click', clearPhotosByUser);
}

// 写真のクリア: 全部の写真を消去する(経路は消さない)。
// 写真はアプリの中にしか無いため、出力していない写真があれば先に出力するよう添える。
// 出力済みのときは、経路と同じく保存を確かめてから消すよう添える
function clearPhotosByUser() {
  const n = getPhotoCount();
  if (n === 0) {
    showToast(t('photo.nothingToClear'));
    return;
  }
  const note = hasUnexportedPhotos() ? 'photo.unexportedWarning' : 'photo.exportedCheckNote';
  const message = `${t('photo.clearConfirm', { n })}\n\n${t(note)}`;
  if (!confirm(message)) return;
  clearPhotos();
  notify(t('photo.cleared'));
}

// 端末に保存してある写真を読み出して、撮影地点の印を地図に出す(起動時に1回)。
// マーカーのスタイルの反映(marker-settings.js の applyMarkerSettings)より後に呼ぶこと
export async function restorePhotosFromStorage() {
  const restored = await restorePhotos();
  if (restored > 0) logHistory(t('photo.restored', { n: restored }), '');
}

// ===== 表示設定パネルの表示 =====
// トグルの右の出力済みかどうかと、トグル ON のときだけ出す統計(枚数)・ボタン行
export function updatePhotoPanel() {
  // 写真が減って警告の枚数を下回ったら、次に達したときにまた警告する
  if (getPhotoCount() < photoWarnCount()) photosNearLimitWarned = false;
  const isOn = !!el.togglePhotoCapture?.checked;
  if (el.photoStats) el.photoStats.hidden = !isOn;
  if (el.photoActions) el.photoActions.hidden = !isOn;
  const count = getPhotoCount();
  setToggleStatus(el.photoStatus, count > 0, hasUnexportedPhotos());
  // 経路の統計と同じ形(ラベル+値の1組)で枚数を出す。写真が無いときも 0 を出す
  if (isOn && el.photoStats) {
    el.photoStats.replaceChildren(buildStatPair(t('photo.statCount'), t('photo.statCountValue', { n: count })));
  }
}

// ===== カメラボタンの表示 =====
// 画面に合わせてカメラボタンを出し分ける(app.js の showView から)。
// ハイキングマップ表示では「写真を撮影」トグルに従い、起動時画面では隠す
export function applyPhotoControlsForView(isMapView) {
  updatePhotoButtonState(isMapView && !!el.togglePhotoCapture?.checked);
}

// カメラボタンの表示: 「写真を撮影」ON のときだけ出す(アプリ内カメラが使えない端末では出さない)
// 写真の表示の「追加撮影」も同じ条件で出す(出せないときは「一覧」「戻る」の2つになる)
function updatePhotoButtonState(enabled) {
  const hidden = !enabled || !isCameraSupported();
  if (el.btnPhotoCamera) el.btnPhotoCamera.hidden = hidden;
  if (el.btnPhotoViewShoot) el.btnPhotoViewShoot.hidden = hidden;
}

// ===== 写真の出力(KMZ) =====
// KMZ を組み立てるには写真の画像を読み出す必要があり、これは非同期の処理になる。
// 待ってからダウンロードすると、端末によっては操作の続きと見なされず止められるため、
// 出力モーダルを開いた時点で読み出しを始め、ボタンを押したときは同期的にダウンロードする。
let photoBytes = null;          // 読み出した画像(photoBytesFor と同順)
let photoBytesFor = null;       // 読み出した対象の写真の一覧
let photoBytesLoading = null;   // 読み出し中の Promise

// 出力モーダルを閉じたら、読み出した画像を捨てる(大きいため持ち続けない)
setModalHooks('photoExportModal', { afterClose: releasePhotoBytes });

// 出力ファイル名の日付: 最初の写真の撮影日(撮影日時が無ければ今日)
function getPhotoDateStr() {
  return formatLocalDate(getPhotos().find((p) => p.timeMs)?.timeMs || Date.now());
}

// 写真の画像の読み出しを始める(済んでいれば何もしない)。済んだら resolve する
function preparePhotoBytes() {
  if (photoBytes || photoBytesLoading) return photoBytesLoading || Promise.resolve();
  const targets = getPhotos();
  const loading = loadPhotoBytes(targets).then((bytes) => {
    if (photoBytesLoading !== loading) return;   // 途中で捨てられた
    photoBytes = bytes;
    photoBytesFor = targets;
    photoBytesLoading = null;
  }).catch((err) => {
    if (photoBytesLoading === loading) photoBytesLoading = null;
    notifyError('photo.exportFailed', err);
  });
  photoBytesLoading = loading;
  return loading;
}

// 読み出した画像を捨てる(出力モーダルを閉じたとき。大きいため持ち続けない)
function releasePhotoBytes() {
  photoBytes = null;
  photoBytesFor = null;
  photoBytesLoading = null;
}

// 写真の出力モーダルを開く。画像の読み出しが済むまで「出力」は押せない
function openPhotoExportModal() {
  if (getPhotoCount() === 0) {
    showToast(t('photo.nothingToExport'));
    return;
  }
  el.btnPhotoExportSave.disabled = !photoBytes;
  openExportNameModal(el.photoExportModal, el.photoExportName,
    defaultExportName(PHOTO_EXPORT_SEQ_KEY, getPhotoDateStr()));
  preparePhotoBytes().then(() => {
    if (!el.photoExportModal.hidden) el.btnPhotoExportSave.disabled = !photoBytes;
  });
}

// 出力ボタン: KMZ を組み立ててダウンロードし、連番を保存してモーダルを閉じる
function handlePhotoExportSave() {
  const name = readExportName(el.photoExportName);
  if (!name) {
    showToast(t('track.exportNeedName'));
    return;
  }
  // 押したときに同期的にダウンロードするため、画像の読み出しが済んでいなければ待ってもらう
  if (!photoBytes) {
    showToast(t('photo.exportPreparing'));
    return;
  }
  if (exportPhotosKmz(name)) writeExportSeq(PHOTO_EXPORT_SEQ_KEY, name);
  closeModal(el.photoExportModal);
}

// 写真の KMZ を組み立ててダウンロードし、出力済みにする(読み出し済みの画像を使い、同期的に行う)。
// ダウンロードを始められたら true を返す。GPX と同じ理由で「出力しました」の完了メッセージは出さない
// (→ file-export.js の downloadBlob)
function exportPhotosKmz(name) {
  if (!photoBytes || !photoBytesFor) {
    showToast(t('photo.exportPreparing'));
    return false;
  }
  const fileName = `${name}.kmz`;
  try {
    downloadBlob(buildPhotosKmz(photoBytesFor, photoBytes, name), fileName);
  } catch (err) {
    notifyError('photo.exportFailed', err);
    return false;
  } finally {
    releasePhotoBytes();
  }
  markPhotosExported();
  return true;
}

// ===== 表示中の写真があるときの選択(クリア/追加/中止) =====
// その日の最初の撮影(カメラボタン)と、写真の読み込みで同じモーダルを共用する。
// 閉じただけ(キャンセル・×・背景)のときは何もしない。開いた用途を保持する。
let photoExistingMode = null;  // 'shoot' | 'import'

// 閉じたのは操作の中止。保持した用途を捨てる
setModalHooks('photoExistingModal', { afterClose: () => { photoExistingMode = null; } });

function openPhotoExistingModal(mode) {
  photoExistingMode = mode;
  const isShoot = mode === 'shoot';
  el.photoExistingTitle.textContent = t(isShoot ? 'photo.existingTitleShoot' : 'photo.existingTitleImport');
  // 出力していない写真があれば、先に出力するよう添える
  let message = t('photo.existingMessage', { n: getPhotoCount() });
  if (hasUnexportedPhotos()) message += `\n${t('photo.unexportedWarning')}`;
  el.photoExistingMessage.textContent = message;
  el.btnPhotoExistingClear.textContent = t(isShoot ? 'photo.existingClearShoot' : 'photo.existingClearImport');
  el.btnPhotoExistingAppend.textContent = t(isShoot ? 'photo.existingAppendShoot' : 'photo.existingAppendImport');
  closeLayerPanel();
  el.photoExistingModal.hidden = false;
}

// クリア/追加のどちらかが選ばれたとき: モーダルを閉じて、開いた用途の操作を続行する。
// 撮影でクリアを選んだときは、ここで写真を消してからカメラを開く。
// 読み込みでクリアを選んだときは、ファイルを読めてから消す(→ importPhotoKmz)。
// ファイル選択・カメラの起動はこのクリック操作の延長で呼ぶため同期的に進める。
function resolvePhotoExisting(append) {
  const mode = photoExistingMode;
  closeModal(el.photoExistingModal);
  if (mode === 'shoot') {
    writeShootConfirmedDate(formatLocalDate());
    if (!append) {
      clearPhotos();
      logHistory(t('photo.cleared'), '');
    }
    openPhotoCameraNow();
  } else if (mode === 'import') {
    openPhotoImportPicker(append);
  }
}

// ===== 写真の読み込み(KMZ) =====
// 既存の写真をクリアするか追加するかの選択(ファイル選択の前に選び、選択後の処理へ引き継ぐ)
let photoImportAppend = false;

function openPhotoImportPicker(append) {
  photoImportAppend = append;
  el.photoImportInput.value = '';
  el.photoImportInput.click();
}

// ファイル選択後: KMZ から写真を読み込む。GPX など KMZ 以外を選んだときは、
// 経路の「読み込み」を案内して何もしない
async function importPhotoFile(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    if (!(await isZipFile(file))) {
      showToast(t('photo.importIsNotKmz'));
      return;
    }
    await importPhotoKmz(file, { append: photoImportAppend });
  } catch (err) {
    notifyError('track.importFailed', err);
  }
}

// KMZ から写真を読み込んで地図に出す。append=false なら写真を消してから読み込む(経路には触れない)。
// 読み込んだ写真はファイルが手元にあるため出力済みのまま(未出力の写真に追加したときは未出力のまま)。
async function importPhotoKmz(file, { append }) {
  const items = await parsePhotosKmz(await file.arrayBuffer());
  if (items.length === 0) {
    showToast(t('photo.importNoPhotos'));
    return;
  }
  if (!append) await clearPhotos();
  let result;
  try {
    result = await importPhotos(items, (n) => t('photo.defaultName', { n }));
  } finally {
    // 読み込んだものが見えるよう、メニューを閉じて写真の全体を表示する
    closeLayerPanel();
    fitMapToPhotos();
  }
  const msg = result.skipped > 0
    ? t('photo.importedLimited', { name: file.name, n: result.added, skipped: result.skipped, max: PHOTO_MAX_COUNT })
    : t('photo.imported', { name: file.name, n: result.added });
  notify(msg, 'success');
  // 読み込み結果のトーストが読めるよう、警告のトーストはその後に出す
  warnIfPhotosNearLimit({ delayToast: true });
}

// ===== 写真の枚数が上限に近づいたときの警告 =====
// 上限(PHOTO_MAX_COUNT)の PHOTO_WARN_RATIO に達したら、保存(撮影・読み込み)の後に
// メッセージ履歴とトーストで知らせる。何度も出さないよう、達したときに1回だけ出し、
// 写真が減って下回ったら(削除・クリア → updatePhotoPanel)また出せるようにする。
// アプリを開き直したときは、達したままでも次の保存で1回出す(覚えるのはこの起動の間だけ)。
let photosNearLimitWarned = false;

function photoWarnCount() {
  return Math.ceil(PHOTO_MAX_COUNT * PHOTO_WARN_RATIO);
}

// 警告を出したら true を返す。delayToast は、直前のトーストを読める間をおいてから出すとき
function warnIfPhotosNearLimit({ delayToast = false } = {}) {
  const n = getPhotoCount();
  if (photosNearLimitWarned || n < photoWarnCount()) return false;
  photosNearLimitWarned = true;
  const msg = t('photo.nearLimit', { n, max: PHOTO_MAX_COUNT, percent: Math.round(PHOTO_WARN_RATIO * 100) });
  logHistory(msg, 'error');
  if (delayToast) showToastAfterCurrent(msg);
  else showToast(msg);
  return true;
}

// ===== 写真の撮影(アプリ内カメラ) =====
// 表示中の写真について「クリア/追加」を確認した日(yyyymmdd)。
// localStorage が使えない環境では、この変数だけで覚える(その間はアプリを開き直すと聞き直す)
let shootConfirmedDate = null;

function readShootConfirmedDate() {
  return readLocal(PHOTO_SHOOT_CONFIRMED_KEY, shootConfirmedDate);
}

function writeShootConfirmedDate(dateStr) {
  shootConfirmedDate = dateStr;
  writeLocal(PHOTO_SHOOT_CONFIRMED_KEY, dateStr || null);
}

// 撮影中(位置の取得・保存が終わっていない)の枚数。上限の判定と既定の名前の番号に含める
let pendingShots = 0;

// カメラボタン: 写真が残っていて、その日まだ確認していなければ、先に「クリア/追加」を選んでもらう
// (前回の山行の写真に混ぜないため)。同じ日の2回目以降は聞かずにカメラを開く。
function openPhotoCamera() {
  if (el.btnPhotoCamera.hidden) return;
  const today = formatLocalDate();
  if (getPhotoCount() > 0 && readShootConfirmedDate() !== today) {
    openPhotoExistingModal('shoot');
    return;
  }
  writeShootConfirmedDate(today);
  openPhotoCameraNow();
}

// アプリ内カメラを開く。上限に達していれば開かずに知らせる
function openPhotoCameraNow() {
  if (getPhotoCount() >= PHOTO_MAX_COUNT) {
    showToast(t('photo.limitReached', { max: PHOTO_MAX_COUNT }));
    return;
  }
  closeLayerPanel();
  openCamera({
    canShoot: () => {
      if (getPhotoCount() + pendingShots < PHOTO_MAX_COUNT) return true;
      setCameraStatus(t('photo.limitReached', { max: PHOTO_MAX_COUNT }));
      return false;
    },
    onShot: handlePhotoShot,
    onError: (msg) => notify(msg, 'error'),
    onIdleClose: () => showToast(t('camera.idleClosed'))
  });
}

// 写真の表示の「追加撮影」: 入力中の名前を保存し、写真の表示は開いたままカメラを重ねて開く
// (カメラを × で閉じれば元の写真の表示に戻る)。表示中の写真に足して撮るので「クリア/追加」は聞かない
function shootFromPhotoView() {
  if (el.btnPhotoViewShoot.hidden) return;
  commitPhotoViewName();
  blurActiveElement();
  writeShootConfirmedDate(formatLocalDate());
  openPhotoCameraNow();
}

// 撮った1枚を保存する: 位置を取り直してから写真を保存する(移動経路には何も書かない)。
// 位置が分からないときは保存しない(撮影地点の無い写真は地図に出せず、KMZ にも書けないため)。
// 保存が済んだら、カメラを閉じて撮った写真の表示を開く(撮影後のカメラ画面は残さない)。
// 保存を待つ間に × などでカメラが閉じられていたら、表示は開かずトーストで知らせる
async function handlePhotoShot({ blob, timeMs, closeIfWaiting }) {
  const name = t('photo.defaultName', { n: getPhotoCount() + pendingShots + 1 });
  pendingShots++;
  setCameraStatus(t('photo.locating', { name }));
  try {
    const latlng = await capturePhotoPosition();
    if (!latlng) {
      closeIfWaiting();
      notify(t('photo.noPosition'), 'error');
      return;
    }
    const photo = await addPhoto({ name, timeMs, lat: latlng[0], lng: latlng[1], blob });
    logHistory(t('photo.saved', { name }), 'success');
    // 上限に近づいたら警告する(トーストで出す)。警告を出したときは保存のトーストは省く
    const warned = warnIfPhotosNearLimit();
    if (closeIfWaiting()) {
      openPhotoView(photo.id);
    } else {
      // 待つ間にカメラが閉じられていた: 写真の表示が開いていれば枚数の表示だけ直し、保存したことを知らせる
      if (isPhotoViewOpen()) refreshPhotoViewIndex();
      if (!warned) showToast(t('photo.saved', { name }));
    }
  } catch (err) {
    // 保存できなかった(容量不足など)
    closeIfWaiting();
    notifyError('photo.saveFailed', err);
  } finally {
    pendingShots--;
    updatePhotoPanel();
  }
}
