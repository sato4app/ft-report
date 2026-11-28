// 写真の表示と一覧
// - 写真の表示(地図のカメラの印・写真の一覧・撮影の直後から開く): 名前の変更・前後の写真・削除・拡大表示
// - 写真の一覧(タイル): 押した写真の表示を開く
// 写真のデータは photos.js、拡大表示は photo-zoom.js、撮影・入出力は photo-ui.js が担う。
import { getPhotos, getPhoto, renamePhoto, deletePhoto, getPhotoThumbUrl } from './photos.js';
import { openPhotoZoom, closePhotoZoom } from './photo-zoom.js';
import { getLang, t } from '../common/i18n.js';
import { notify, notifyError } from '../common/messages.js';
import { on, blurActiveElement, closeModal, setModalHooks } from '../common/ui.js';
import { closeLayerPanel } from '../map/layer-panel.js';

const el = {
  // 写真の表示(名前の変更)
  photoViewModal: document.getElementById('photoViewModal'),
  photoViewImage: document.getElementById('photoViewImage'),
  photoViewName: document.getElementById('photoViewName'),
  photoViewTitle: document.getElementById('photoViewTitle'),
  btnPhotoViewPrev: document.getElementById('btnPhotoViewPrev'),
  btnPhotoViewNext: document.getElementById('btnPhotoViewNext'),
  btnPhotoViewZoom: document.getElementById('btnPhotoViewZoom'),
  photoViewMeta: document.getElementById('photoViewMeta'),
  btnPhotoDelete: document.getElementById('btnPhotoDelete'),
  btnPhotoViewList: document.getElementById('btnPhotoViewList'),
  // 写真の一覧(タイル)
  photoListModal: document.getElementById('photoListModal'),
  photoListTitle: document.getElementById('photoListTitle'),
  photoListBody: document.getElementById('photoListBody'),
  photoListGrid: document.getElementById('photoListGrid')
};

// 写真の表示は、閉じる前に入力中の名前を保存する(フォーカスを外すと change が来ない端末があるため先に)。
// 閉じたら、拡大表示も閉じ(同じ画像を使っているため)、表示していた画像の URL を手放す
setModalHooks('photoViewModal', {
  beforeClose: commitPhotoViewName,
  afterClose: () => {
    closePhotoZoom();
    releasePhotoView();
  }
});
// 写真の一覧を閉じたら、タイルの見張りを止める(縮小画像は photos.js が写真ごとに覚えている)
setModalHooks('photoListModal', { afterClose: releasePhotoList });

// ===== イベントの登録(app.js の bindEvents から1回呼ぶ) =====
export function bindPhotoViewEvents() {
  // 名前の入力を確定したとき(Enter・欄の外へ)に保存する。閉じたときも保存する(setModalHooks)
  on(el.photoViewName, 'change', commitPhotoViewName);
  // 名前の欄を押したとき、既定の名前(写真xx)のままなら全体を選択して打ち替えやすくする
  on(el.photoViewName, 'focus', selectDefaultPhotoName);
  // 写真の表示の左右の矢印ボタン: 前・次の写真へ(名前は移る前に保存する)
  on(el.btnPhotoViewPrev, 'click', () => stepPhotoView(-1));
  on(el.btnPhotoViewNext, 'click', () => stepPhotoView(1));
  // 画像・右下の虫めがね: 写真を画面いっぱいに広げて、指で拡大できる表示を開く(photo-zoom.js)
  on(el.photoViewImage, 'click', openViewingPhotoZoom);
  on(el.btnPhotoViewZoom, 'click', openViewingPhotoZoom);
  // 名前の欄の右のごみ箱: 表示中の写真を削除する
  on(el.btnPhotoDelete, 'click', deleteViewingPhoto);
  // 「一覧」: 写真の一覧(タイル)へ切り替える。押した写真の表示に戻る
  on(el.btnPhotoViewList, 'click', () => openPhotoList(viewingPhotoId));
}

// ===== 写真の表示(名前の変更) =====
let viewingPhotoId = null;
let viewingPhotoUrl = null;

// 写真の表示が開いているか
export function isPhotoViewOpen() {
  return !el.photoViewModal.hidden;
}

// 撮影日時の表示(端末の現地時刻。言語に合わせた書式)
function formatPhotoTime(ms) {
  if (!Number.isFinite(ms)) return t('photo.takenAtUnknown');
  const time = new Date(ms).toLocaleString(getLang() === 'en' ? 'en-US' : 'ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  return t('photo.takenAt', { time });
}

// 写真の表示を開く(地図のカメラの印・写真の一覧・撮影の直後から)。
// 既に開いているとき(「追加撮影」で撮った後)は、入力中の名前を保存してから撮った写真に替える
export function openPhotoView(id) {
  if (isPhotoViewOpen()) commitPhotoViewName();
  if (!showPhotoInView(id)) return;
  closeLayerPanel();
  el.photoViewModal.hidden = false;
}

// 写真の表示に1枚を出す(開くとき・矢印ボタンで前後へ移るとき)。
// 見出しに「何枚目/全何枚」(撮影・読み込みの順)を出し、端の写真では < / > を押せなくする
function showPhotoInView(id) {
  const photos = getPhotos();
  const index = photos.findIndex((p) => p.id === id);
  if (index < 0) return false;
  const photo = photos[index];
  releasePhotoView();
  viewingPhotoId = id;
  viewingPhotoUrl = URL.createObjectURL(photo.blob);
  el.photoViewImage.src = viewingPhotoUrl;
  el.photoViewImage.alt = photo.name;
  el.photoViewName.value = photo.name;
  el.photoViewMeta.textContent = formatPhotoTime(photo.timeMs);
  setPhotoViewIndex(index, photos.length);
  return true;
}

// 見出しの「何枚目/全何枚」と、左右の矢印ボタンを押せるかどうか
function setPhotoViewIndex(index, total) {
  el.photoViewTitle.textContent = t('photo.viewTitleIndex', { n: index + 1, total });
  el.btnPhotoViewPrev.disabled = index === 0;
  el.btnPhotoViewNext.disabled = index === total - 1;
}

// 表示中の写真はそのままで、枚数が変わったときに見出しと矢印ボタンだけ直す
export function refreshPhotoViewIndex() {
  const photos = getPhotos();
  const index = photos.findIndex((p) => p.id === viewingPhotoId);
  if (index >= 0) setPhotoViewIndex(index, photos.length);
}

// 表示中の写真を拡大表示で開く。名前の入力中ならキーボードを閉じる(名前は閉じたとき等に保存する)
function openViewingPhotoZoom() {
  if (!viewingPhotoUrl) return;
  blurActiveElement();
  openPhotoZoom(viewingPhotoUrl, el.photoViewImage.alt);
}

// 左右の矢印ボタン: 入力中の名前を保存してから、前(step=-1)・次(step=1)の写真へ移る
function stepPhotoView(step) {
  const photos = getPhotos();
  const index = photos.findIndex((p) => p.id === viewingPhotoId);
  const target = photos[index + step];
  if (index < 0 || !target) return;
  commitPhotoViewName();
  showPhotoInView(target.id);
}

// 入力中の名前を保存する。空にされたときは元の名前に戻す。
// 名前を変えた写真は未出力に戻る(→ photos.js の renamePhoto)
export function commitPhotoViewName() {
  const photo = viewingPhotoId ? getPhoto(viewingPhotoId) : null;
  if (!photo) return;
  const name = el.photoViewName.value.trim();
  if (!name) {
    el.photoViewName.value = photo.name;
    return;
  }
  if (name === photo.name) return;
  renamePhoto(photo.id, name).catch((err) => notifyError('photo.saveFailed', err));
  el.photoViewImage.alt = name;
}

// 既定の名前(i18n の photo.defaultName: 写真{n} / Photo {n})。撮影時の言語で付くため両方を対象にする
const DEFAULT_PHOTO_NAME_RE = /^(写真\d+|Photo \d+)$/;

// 名前の欄にフォーカスが来たとき、既定の名前のままなら全体を選択する(自分で付けた名前は選択しない)。
// タップでのフォーカスはその後のキャレット配置で選択が外れるため、一呼吸おいてから選択する
function selectDefaultPhotoName() {
  const input = el.photoViewName;
  if (!DEFAULT_PHOTO_NAME_RE.test(input.value.trim())) return;
  setTimeout(() => {
    if (document.activeElement === input) input.setSelectionRange(0, input.value.length);
  }, 0);
}

// ごみ箱: 表示中の写真を確認のうえ削除し、次の写真(最後の写真なら前の写真)を表示する。
// 写真が無くなったら写真の表示を閉じる。入力中の名前は、消す写真のものなので保存しない
function deleteViewingPhoto() {
  const photo = viewingPhotoId ? getPhoto(viewingPhotoId) : null;
  if (!photo) return;
  if (!confirm(t('photo.deleteConfirm', { name: photo.name }))) return;
  const photos = getPhotos();
  const index = photos.findIndex((p) => p.id === photo.id);
  const next = photos[index + 1] || photos[index - 1] || null;
  deletePhoto(photo.id).catch((err) => notifyError('photo.deleteFailed', err));
  notify(t('photo.deleted', { name: photo.name }));
  if (next) showPhotoInView(next.id);
  else closeModal(el.photoViewModal);
}

// 写真の表示を閉じたとき: 表示していた画像の URL を手放す
function releasePhotoView() {
  viewingPhotoId = null;
  if (viewingPhotoUrl) URL.revokeObjectURL(viewingPhotoUrl);
  viewingPhotoUrl = null;
  if (el.photoViewImage) el.photoViewImage.removeAttribute('src');
}

// ===== 写真の一覧(タイル) =====
// 全部の写真を撮影・読み込みの順にタイル状に並べる。押した写真の表示を開く。
// タイルの画像は、一覧の中で見える位置に近づいたものから縮小画像を作って入れる
// (200枚を一度に展開しないため。縮小画像は photos.js の getPhotoThumbUrl)。
let photoListObserver = null;

function openPhotoList(currentId) {
  const photos = getPhotos();
  if (photos.length === 0) return;
  // 写真の表示から来たときは、入力中の名前を保存して閉じる(closeModal)
  if (isPhotoViewOpen()) closeModal(el.photoViewModal);
  releasePhotoList();
  el.photoListTitle.textContent = t('photo.listTitle', { n: photos.length });
  if ('IntersectionObserver' in window) {
    photoListObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        photoListObserver?.unobserve(entry.target);
        loadPhotoTile(entry.target);
      }
    }, { root: el.photoListBody, rootMargin: '200px 0px' });
  }
  let currentTile = null;
  const tiles = photos.map((photo) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'photo-list-tile';
    tile.dataset.photoId = photo.id;
    tile.setAttribute('aria-label', photo.name);
    tile.title = photo.name;
    const img = document.createElement('img');
    img.alt = '';
    const name = document.createElement('span');
    name.className = 'photo-list-name';
    name.setAttribute('aria-hidden', 'true');
    name.textContent = photo.name;
    tile.append(img, name);
    tile.addEventListener('click', () => {
      closeModal(el.photoListModal);
      openPhotoView(photo.id);
    });
    if (photo.id === currentId) {
      tile.classList.add('is-current');
      currentTile = tile;
    }
    return tile;
  });
  el.photoListGrid.replaceChildren(...tiles);
  closeLayerPanel();
  el.photoListModal.hidden = false;
  // 表示していた写真のタイルが見えるよう、一覧の中だけをスクロールする
  // (scrollIntoView は画面ごと動かすことがあるため使わない)
  el.photoListBody.scrollTop = 0;
  if (currentTile) {
    const offset = currentTile.getBoundingClientRect().top - el.photoListBody.getBoundingClientRect().top;
    el.photoListBody.scrollTop = Math.max(0, offset - el.photoListBody.clientHeight / 2 + currentTile.offsetHeight / 2);
  }
  for (const tile of tiles) {
    if (photoListObserver) photoListObserver.observe(tile);
    else loadPhotoTile(tile);
  }
}

// タイルに縮小画像を入れる(作り終えたときに一覧が閉じられていても害はない)
function loadPhotoTile(tile) {
  getPhotoThumbUrl(tile.dataset.photoId).then((url) => {
    if (url) tile.querySelector('img').src = url;
  });
}

// 一覧を閉じたとき: タイルの見張りを止め、タイルを取り除く
function releasePhotoList() {
  photoListObserver?.disconnect();
  photoListObserver = null;
  el.photoListGrid?.replaceChildren();
}
