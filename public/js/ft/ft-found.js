// 発見報告(仕様 docs/ft-funcspec-found.md)。
// 起動時画面の「発見報告」から開く。① 写真の選択 →「次へ」→ ② 入力 →「出力」→ ③ ファイル名の確認 → 共有・保存。
// - 画面(モーダル)はここで作る(index.html は書き換えない)。開くたびに作り、閉じたら取り除く。
// - 報告書と入力した内容は保存しない。閉じると消える。
// - 入力する項目・初期値・候補は、項目設定(ft-item-settings.js。設定の読み書きは ft-report-items.js)に従う。
//   入力しない項目は入力の画面に出さず、報告書では空欄にする。
// - 出力したあとも入力の画面は開いたまま(直してもう一度出力できる)。
// - 写真は変えない・消さない。
// - 「天気・気温を調べる」で、最初の写真の撮影時刻の箕面大滝付近の天気・気温を Open-Meteo から取って入れる(ft-weather.js)。
// - 背景(画面の外側)を押しても閉じない(入力した内容をうっかり失わないため)。閉じるのは「×」「閉じる」だけ。
import { getPhotos, getPhoto, getPhotoThumbUrl } from '../photo/photos.js';
import { blurActiveElement } from '../common/ui.js';
import { showToast } from '../common/messages.js';
import { downloadBlob } from '../common/file-export.js';
import { errorText } from '../common/utils.js';
import {
  FT_REPORT_MAX_PHOTOS, circledNumber, buildDateRange, formatPhotoTime, todayInputDate,
  defaultCaption, buildReport, defaultReportFileName, sanitizeFileName, loadMapFeatures, findNearestPoint
} from './ft-report-data.js';
import { FT_MAP_WARN_ZOOM } from './ft-report-map.js';
import { estimateReportMapZoom, buildReportPdf } from './ft-report-layout.js';
import { REPORT_ITEMS, hasCandidates, loadItemSettings } from './ft-report-items.js';
import { fetchMinohWeather, WEATHER_SOURCE } from './ft-weather.js';

// 開いている間の状態(閉じたら null)
let state = null;

// ===== 開く・閉じる =====
export function openFoundReport() {
  if (state) return;
  if (getPhotos().length === 0) {
    showToast('写真がありません。地図画面の「写真を撮影」で倒木の写真を撮ってください。', { durationSec: 5 });
    return;
  }
  state = {
    el: null,
    settings: loadItemSettings('found'),   // 項目設定(入力する項目・初期値・候補)
    selected: [],          // 選んだ写真の id(選んだ順)
    captions: new Map(),   // 写真の id → 見出し(選び直しても残す)
    dateKey: null,         // 日時の欄を作ったときの写真の組
    features: null,        // 地図データ(緊急ポイント・ルート)
    featuresPromise: null,
    observer: null,
    pdf: null,             // 作った PDF と、そのときの報告書の中身
    busy: false,
    weatherBusy: false     // 天気・気温を調べている間
  };
  state.featuresPromise = loadMapFeatures();
  buildDom();
  renderPhotoGrid();
  showStep('select');
}

function closeFoundReport() {
  if (!state || state.busy) return;
  blurActiveElement();
  state.observer?.disconnect();
  for (const node of [state.el.modal, state.el.exportModal, state.el.busy]) node.remove();
  state = null;
}

// ===== 画面を作る =====
function buildDom() {
  const modal = document.createElement('div');
  modal.className = 'modal ft-found-modal';
  modal.id = 'ftFoundModal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'ftFoundTitle');
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-panel ft-found-panel" role="document">
      <header class="modal-header">
        <h2 id="ftFoundTitle">発見報告</h2>
        <button type="button" class="btn-icon" data-ft-close aria-label="閉じる">×</button>
      </header>

      <div class="modal-body" data-step="select">
        <p class="modal-subtitle">報告に入れる写真を、番号を付けたい順に押してください（${FT_REPORT_MAX_PHOTOS} 枚まで）。もう一度押すと外れます。</p>
        <div class="photo-list-grid" data-ft-grid></div>
        <p class="ft-found-count" data-ft-count></p>
        <div class="button-group button-group-row">
          <button type="button" class="btn btn-primary" data-ft-next>次へ</button>
          <button type="button" class="btn btn-neutral" data-ft-close>閉じる</button>
        </div>
      </div>

      <div class="modal-body" data-step="input" hidden>
        <p class="ft-found-warn" data-ft-warn hidden>写真の範囲が広いため、地図の縮尺が小さくなります。地図は 1 枚なので、必要なら報告を分けてください。</p>
        <!-- 各欄の data-ft-item は項目設定の項目(ft-report-items.js の REPORT_ITEMS の key)。
             入力しない項目の欄は隠し、初期値と候補は applySettings で入れる -->
        <div class="ft-form">
          <div class="ft-field" data-ft-item="date">
            <label for="ftfDate">日時</label>
            <input type="text" id="ftfDate" autocomplete="off" />
          </div>
          <div class="ft-field-row">
            <div class="ft-field" data-ft-item="weather">
              <label for="ftfWeather">天気</label>
              <input type="text" id="ftfWeather" autocomplete="off" />
            </div>
            <div class="ft-field" data-ft-item="temperature">
              <label for="ftfTemperature">気温（℃）</label>
              <input type="number" id="ftfTemperature" step="any" />
            </div>
          </div>
          <!-- 天気・気温を調べる(ft-weather.js)。天気・気温の両方を入力しないときは出さない -->
          <div class="ft-weather-tool" data-ft-weather-tool>
            <button type="button" class="btn btn-secondary ft-weather-btn" data-ft-weather>天気・気温を調べる</button>
            <p class="ft-weather-note" data-ft-weather-note></p>
          </div>
          <div class="ft-field" data-ft-item="writer">
            <label for="ftfWriter">記入者</label>
            <input type="text" id="ftfWriter" autocomplete="off" />
          </div>
          <div class="ft-field" data-ft-item="subject">
            <label for="ftfSubject">対象案件</label>
            <input type="text" id="ftfSubject" autocomplete="off" />
          </div>
          <div class="ft-field" data-ft-item="place">
            <label for="ftfPlace">場所</label>
            <input type="text" id="ftfPlace" autocomplete="off" />
            <div class="ft-found-ref" data-ft-ref hidden>
              <p class="ft-found-ref-title">参考：写真に近い緊急ポイント（報告書には出ません）</p>
              <ul data-ft-ref-list></ul>
            </div>
          </div>
          <div class="ft-field" data-ft-item="reportTo">
            <label for="ftfReportTo">通報先</label>
            <input type="text" id="ftfReportTo" autocomplete="off" />
          </div>
          <div class="ft-field-row">
            <div class="ft-field" data-ft-item="reportMeans">
              <label for="ftfReportMeans">通報手段</label>
              <input type="text" id="ftfReportMeans" autocomplete="off" />
            </div>
            <div class="ft-field" data-ft-item="reportDate">
              <label for="ftfReportDate">通報日時</label>
              <input type="date" id="ftfReportDate" value="${todayInputDate()}" />
            </div>
          </div>
          <div class="ft-field" data-ft-item="participants">
            <label for="ftfParticipants">参加者</label>
            <input type="text" id="ftfParticipants" autocomplete="off" />
          </div>
          <div class="ft-field" data-ft-item="body">
            <label for="ftfBody">活動内容</label>
            <textarea id="ftfBody" rows="4"></textarea>
          </div>
          <div class="ft-field" data-ft-item="captions">
            <span class="ft-field-title">写真の見出し</span>
            <div class="ft-caption-list" data-ft-captions></div>
          </div>
          <fieldset class="ft-choice" data-ft-item="contactReportTo">
            <legend>通報先へ連絡</legend>
            <label><input type="radio" name="ftfContactReportTo" value="要" />要</label>
            <label><input type="radio" name="ftfContactReportTo" value="不要" />不要</label>
            <label><input type="radio" name="ftfContactReportTo" value="" checked />未選択</label>
          </fieldset>
          <fieldset class="ft-choice" data-ft-item="contactGov">
            <legend>行政への連絡</legend>
            <label><input type="radio" name="ftfContactGov" value="要" />要</label>
            <label><input type="radio" name="ftfContactGov" value="不要" />不要</label>
            <label><input type="radio" name="ftfContactGov" value="" checked />未選択</label>
          </fieldset>
          <div class="ft-field" data-ft-item="notes">
            <label for="ftfNotes">連絡事項</label>
            <textarea id="ftfNotes" rows="3"></textarea>
          </div>
          <p class="ft-found-none" data-ft-none hidden>項目設定で、入力する項目がすべて外されています。</p>
        </div>
        <div class="button-group button-group-row">
          <button type="button" class="btn btn-primary" data-ft-output>出力</button>
          <button type="button" class="btn btn-neutral" data-ft-back>戻る</button>
        </div>
      </div>
    </div>`;

  // ファイル名の確認(③)
  const exportModal = document.createElement('div');
  exportModal.className = 'modal';
  exportModal.id = 'ftFoundExportModal';
  exportModal.hidden = true;
  exportModal.setAttribute('role', 'dialog');
  exportModal.setAttribute('aria-modal', 'true');
  exportModal.setAttribute('aria-labelledby', 'ftFoundExportTitle');
  exportModal.innerHTML = `
    <div class="modal-backdrop" data-ft-export-cancel></div>
    <div class="modal-panel" role="document">
      <header class="modal-header">
        <h2 id="ftFoundExportTitle">報告書の出力（PDF）</h2>
        <button type="button" class="btn-icon" data-ft-export-cancel aria-label="閉じる">×</button>
      </header>
      <div class="modal-body">
        <div class="track-export-row">
          <label class="track-export-label" for="ftFoundFileName">ファイル名</label>
          <input type="text" id="ftFoundFileName" autocomplete="off" />
        </div>
        <p class="modal-note" data-ft-export-note></p>
        <div class="button-group button-group-row">
          <button type="button" class="btn btn-primary" data-ft-share>共有</button>
          <button type="button" class="btn btn-primary" data-ft-save>保存</button>
        </div>
        <div class="button-group ft-found-export-cancel">
          <button type="button" class="btn btn-neutral" data-ft-export-cancel>キャンセル</button>
        </div>
      </div>
    </div>`;

  // 作っている間の表示(操作を受け付けない)
  const busy = document.createElement('div');
  busy.className = 'blocking-overlay';
  busy.hidden = true;
  busy.setAttribute('role', 'alertdialog');
  busy.setAttribute('aria-modal', 'true');
  busy.setAttribute('aria-busy', 'true');
  busy.innerHTML = `
    <div class="blocking-overlay-panel" role="document">
      <div class="blocking-spinner" aria-hidden="true"></div>
      <p class="blocking-overlay-text">報告書を作っています。しばらくお待ちください。</p>
    </div>`;

  document.body.append(modal, exportModal, busy);

  const q = (sel) => modal.querySelector(sel);
  state.el = {
    modal, exportModal, busy,
    title: q('#ftFoundTitle'),
    selectBody: q('[data-step="select"]'),
    inputBody: q('[data-step="input"]'),
    grid: q('[data-ft-grid]'),
    count: q('[data-ft-count]'),
    next: q('[data-ft-next]'),
    warn: q('[data-ft-warn]'),
    ref: q('[data-ft-ref]'),
    refList: q('[data-ft-ref-list]'),
    captions: q('[data-ft-captions]'),
    date: q('#ftfDate'),
    weather: q('#ftfWeather'),
    temperature: q('#ftfTemperature'),
    writer: q('#ftfWriter'),
    subject: q('#ftfSubject'),
    place: q('#ftfPlace'),
    reportTo: q('#ftfReportTo'),
    reportMeans: q('#ftfReportMeans'),
    reportDate: q('#ftfReportDate'),
    participants: q('#ftfParticipants'),
    body: q('#ftfBody'),
    notes: q('#ftfNotes'),
    none: q('[data-ft-none]'),
    weatherTool: q('[data-ft-weather-tool]'),
    weatherBtn: q('[data-ft-weather]'),
    weatherNote: q('[data-ft-weather-note]'),
    fileName: exportModal.querySelector('#ftFoundFileName'),
    exportNote: exportModal.querySelector('[data-ft-export-note]'),
    share: exportModal.querySelector('[data-ft-share]'),
    save: exportModal.querySelector('[data-ft-save]')
  };

  modal.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.hasAttribute('data-ft-close')) closeFoundReport();
    else if (t.hasAttribute('data-ft-next')) showInputStep();
    else if (t.hasAttribute('data-ft-back')) showStep('select');
    else if (t.hasAttribute('data-ft-output')) startOutput();
    else if (t.hasAttribute('data-ft-weather')) lookupWeather();
  });
  exportModal.addEventListener('click', (e) => {
    const t = e.target.closest('[data-ft-export-cancel], [data-ft-share], [data-ft-save]');
    if (!t) return;
    if (t.hasAttribute('data-ft-export-cancel')) closeExportModal();
    else if (t.hasAttribute('data-ft-share')) sharePdf();
    else if (t.hasAttribute('data-ft-save')) savePdf();
  });

  applySettings();
}

// 項目設定を入力の画面に当てはめる: 入力しない項目の欄を隠し、初期値と候補を入れる
function applySettings() {
  const { el, settings } = state;
  for (const item of REPORT_ITEMS) {
    const s = settings[item.key];
    const field = el.modal.querySelector(`[data-ft-item="${item.key}"]`);
    if (field) field.hidden = !s.enabled;
    if (!s.enabled) continue;
    if (item.kind === 'choice') {
      const radio = el.modal.querySelector(`[data-ft-item="${item.key}"] input[value="${s.default}"]`);
      if (radio) radio.checked = true;
    } else if (item.kind !== 'auto' && el[item.key]) {
      el[item.key].value = s.default;
    }
    if (hasCandidates(item) && s.candidates.length > 0 && el[item.key]) {
      const list = document.createElement('datalist');
      list.id = `ftfList-${item.key}`;
      for (const c of s.candidates) {
        const opt = document.createElement('option');
        opt.value = c;
        list.append(opt);
      }
      el.inputBody.append(list);
      el[item.key].setAttribute('list', list.id);
    }
  }
  // 2 つ並べた欄が両方とも隠れたら、行ごと隠す
  for (const row of el.modal.querySelectorAll('.ft-field-row')) {
    row.hidden = [...row.children].every((c) => c.hidden);
  }
  // 天気・気温を調べるボタンは、天気か気温のどちらかを入力するときだけ出す
  el.weatherTool.hidden = !settings.weather.enabled && !settings.temperature.enabled;
  el.none.hidden = REPORT_ITEMS.some((item) => settings[item.key].enabled);
}

// 項目を入力するかどうか(項目設定)
function isEnabled(key) {
  return state.settings[key]?.enabled !== false;
}

function showStep(step) {
  blurActiveElement();
  const { el } = state;
  el.selectBody.hidden = step !== 'select';
  el.inputBody.hidden = step !== 'input';
  el.title.textContent = step === 'select' ? '発見報告（写真の選択）' : '発見報告（入力）';
  (step === 'select' ? el.selectBody : el.inputBody).scrollTop = 0;
}

// ===== ① 写真の選択 =====
function renderPhotoGrid() {
  const { el } = state;
  el.grid.textContent = '';
  // 縮小画像は、一覧の中で見える位置に近づいたタイルから作る(写真の一覧と同じ考え)
  const loadThumb = (tile) => {
    getPhotoThumbUrl(tile.dataset.id).then((url) => {
      if (url) tile.querySelector('img').src = url;
    });
  };
  state.observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        state.observer.unobserve(entry.target);
        loadThumb(entry.target);
      }
    }, { root: el.selectBody, rootMargin: '200px' })
    : null;

  for (const photo of getPhotos()) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'photo-list-tile ft-found-tile';
    tile.dataset.id = photo.id;
    tile.setAttribute('aria-pressed', 'false');
    const img = document.createElement('img');
    img.alt = '';
    const meta = document.createElement('span');
    meta.className = 'photo-list-name';
    const name = document.createElement('span');
    name.textContent = photo.name || '';
    const time = document.createElement('span');
    time.textContent = formatPhotoTime(photo.timeMs);
    meta.append(name, time);
    const badge = document.createElement('span');
    badge.className = 'ft-found-badge';
    badge.hidden = true;
    tile.append(img, meta, badge);
    tile.addEventListener('click', () => toggleSelect(photo.id));
    el.grid.append(tile);
    if (state.observer) state.observer.observe(tile);
    else loadThumb(tile);
  }
  updateSelection();
}

function toggleSelect(id) {
  const i = state.selected.indexOf(id);
  if (i >= 0) {
    state.selected.splice(i, 1);   // 外す(後ろの番号が詰まる)
  } else {
    if (state.selected.length >= FT_REPORT_MAX_PHOTOS) {
      showToast(`写真は ${FT_REPORT_MAX_PHOTOS} 枚まで選べます`);
      return;
    }
    state.selected.push(id);
    if (!state.captions.has(id)) state.captions.set(id, defaultCaption(getPhoto(id)));
  }
  updateSelection();
}

function updateSelection() {
  const { el, selected } = state;
  for (const tile of el.grid.children) {
    const idx = selected.indexOf(tile.dataset.id);
    const badge = tile.querySelector('.ft-found-badge');
    badge.hidden = idx < 0;
    badge.textContent = idx < 0 ? '' : circledNumber(idx + 1);
    tile.classList.toggle('is-selected', idx >= 0);
    tile.setAttribute('aria-pressed', String(idx >= 0));
  }
  el.count.textContent = `選んだ写真: ${selected.length} 枚`;
  el.next.disabled = selected.length === 0;
}

// 選んだ写真(選んだ順)。開いている間に消された写真は除く
function selectedPhotos() {
  state.selected = state.selected.filter((id) => getPhoto(id));
  return state.selected.map((id) => getPhoto(id));
}

// ===== ② 入力 =====
function showInputStep() {
  const photos = selectedPhotos();
  if (photos.length === 0) return;
  const { el } = state;
  // 写真を選び直したら、日時の欄を作り直す(手で書き換えていても入れ直す。仕様 4.3)
  const key = [...state.selected].sort().join(',');
  if (key !== state.dateKey) {
    if (isEnabled('date')) el.date.value = buildDateRange(photos);
    state.dateKey = key;
    resetWeatherTool(photos);
  }
  if (isEnabled('captions')) renderCaptions(photos);
  if (isEnabled('place')) renderPlaceRef(photos);
  el.warn.hidden = estimateReportMapZoom(photos.map((p) => [p.lat, p.lng])) >= FT_MAP_WARN_ZOOM;
  showStep('input');
}

// 写真の見出し(写真ごとに 1 行。番号を前に付けて表示する)
function renderCaptions(photos) {
  const { el } = state;
  el.captions.textContent = '';
  photos.forEach((photo, i) => {
    const row = document.createElement('div');
    row.className = 'ft-caption-row';
    const img = document.createElement('img');
    img.alt = '';
    getPhotoThumbUrl(photo.id).then((url) => { if (url) img.src = url; });
    const no = document.createElement('span');
    no.className = 'ft-caption-no';
    no.textContent = circledNumber(i + 1);
    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.value = state.captions.get(photo.id) ?? '';
    input.setAttribute('aria-label', `写真${circledNumber(i + 1)}の見出し`);
    input.addEventListener('input', () => state?.captions.set(photo.id, input.value));
    row.append(img, no, input);
    el.captions.append(row);
  });
}

// 場所の参考: 写真ごとに最も近い緊急ポイント(1 km 以内。仕様 4.4)。地図データが無ければ出さない
function renderPlaceRef(photos) {
  const { el } = state;
  el.ref.hidden = true;
  state.featuresPromise.then((features) => {
    if (!state || state.el !== el) return;
    state.features = features;
    if (!features?.points?.length) return;
    el.refList.textContent = '';
    photos.forEach((photo, i) => {
      const li = document.createElement('li');
      const near = findNearestPoint(features.points, photo.lat, photo.lng, 1000);
      if (near) {
        const m = near.meters < 100 ? Math.round(near.meters) : Math.round(near.meters / 10) * 10;
        li.textContent = `${circledNumber(i + 1)} ${near.point.id} ${near.point.name}（約 ${m}m）`;
      } else {
        li.textContent = `${circledNumber(i + 1)} 近くに緊急ポイントなし`;
      }
      el.refList.append(li);
    });
    el.ref.hidden = false;
  });
}

// ===== 天気・気温を調べる(仕様 4.6) =====
// 調べる時刻は、選んだ写真のうち撮影日時が分かるものの最も早い時刻(日時の欄の始まりと同じ)
function weatherTime(photos) {
  const times = photos.map((p) => p.timeMs).filter((t) => Number.isFinite(t));
  return times.length > 0 ? Math.min(...times) : null;
}

// 写真を選び直したとき: ボタンと説明を、選んだ写真に合わせて出し直す
function resetWeatherTool(photos) {
  const { el } = state;
  const t = weatherTime(photos);
  el.weatherBtn.disabled = t === null;
  el.weatherNote.textContent = t === null
    ? '撮影日時が分かる写真が無いため、調べられません。'
    : `${formatPhotoTime(t)} の、箕面大滝付近の天気と気温を入れます（Open-Meteo.com の気象モデルの推定値。インターネットにつながっているときだけ）。`;
}

async function lookupWeather() {
  if (!state || state.weatherBusy) return;
  const { el } = state;
  const t = weatherTime(selectedPhotos());
  if (t === null) return;
  state.weatherBusy = true;
  el.weatherBtn.disabled = true;
  el.weatherBtn.textContent = '調べています…';
  try {
    const result = await fetchMinohWeather(t);
    if (!state || state.el !== el) return;
    if (isEnabled('weather') && result.weather) el.weather.value = result.weather;
    if (isEnabled('temperature') && result.temperature !== null) el.temperature.value = String(result.temperature);
    const [, m, d, h] = result.hour.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2})/) || [];
    el.weatherNote.textContent = `${m}/${d} ${Number(h)}時台の値を入れました（直してかまいません）。${WEATHER_SOURCE}`;
  } catch (err) {
    // 圏外などで通信できないときは TypeError(英語の文)になるので、日本語に直して出す
    const reason = err instanceof TypeError ? '通信できません' : errorText(err);
    showToast(`天気・気温を取得できませんでした（${reason}）`, { durationSec: 5 });
  } finally {
    if (state && state.el === el) {
      state.weatherBusy = false;
      el.weatherBtn.disabled = false;
      el.weatherBtn.textContent = '天気・気温を調べる';
    }
  }
}

function checkedValue(name) {
  return state.el.modal.querySelector(`input[name="${name}"]:checked`)?.value ?? '';
}

// 入力の画面の値。入力しない項目(項目設定)は空にする(報告書では空欄)
function collectInput() {
  const { el } = state;
  const input = {
    date: el.date.value,
    weather: el.weather.value,
    temperature: el.temperature.value,
    writer: el.writer.value,
    subject: el.subject.value,
    place: el.place.value,
    reportTo: el.reportTo.value,
    reportMeans: el.reportMeans.value,
    reportDate: el.reportDate.value,
    participants: el.participants.value,
    body: el.body.value,
    contactReportTo: checkedValue('ftfContactReportTo'),
    contactGov: checkedValue('ftfContactGov'),
    notes: el.notes.value,
    captions: state.captions
  };
  for (const item of REPORT_ITEMS) {
    if (isEnabled(item.key)) continue;
    input[item.key] = item.key === 'captions' ? new Map() : '';
  }
  return input;
}

// ===== ③ 出力 =====
function setBusy(on) {
  state.busy = on;
  state.el.busy.hidden = !on;
}

async function startOutput() {
  if (!state || state.busy) return;
  blurActiveElement();
  const photos = selectedPhotos();
  if (photos.length === 0) return;
  const report = buildReport(collectInput(), photos);
  setBusy(true);
  let result;
  try {
    result = await buildReportPdf(report, await state.featuresPromise);
  } catch (err) {
    console.error('[ft] 報告書を作れませんでした:', err);
    showToast(`報告書を作れませんでした（${errorText(err)}）`, { durationSec: 5 });
    return;
  } finally {
    if (state) setBusy(false);
  }
  if (!state) return;
  state.pdf = { ...result, report };
  if (result.missingTiles > 0) showToast('地図の一部を取得できませんでした');
  openExportModal(defaultReportFileName(report), result.pageCount);
}

// 共有メニューで PDF を渡せるか
function canSharePdf() {
  try {
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function'
      && navigator.canShare({ files: [new File(['%PDF'], 'check.pdf', { type: 'application/pdf' })] });
  } catch {
    return false;
  }
}

function openExportModal(name, pageCount) {
  const { el } = state;
  el.fileName.value = name;
  el.exportNote.textContent = `${pageCount} ページの PDF です。ファイル名の後ろに「.pdf」が付きます。`;
  el.share.hidden = !canSharePdf();
  el.exportModal.hidden = false;
}

function closeExportModal() {
  blurActiveElement();
  if (state) state.el.exportModal.hidden = true;
}

// ファイル名(拡張子なし)。空なら既定の名前
function exportFileName() {
  const typed = sanitizeFileName(state.el.fileName.value.replace(/\.pdf$/i, ''));
  return typed || defaultReportFileName(state.pdf.report);
}

// 共有: 押した操作の中で、待たずに共有の画面を開く(待つと、端末によっては開けなくなる)
async function sharePdf() {
  if (!state?.pdf) return;
  const name = exportFileName();
  const file = new File([state.pdf.blob], `${name}.pdf`, { type: 'application/pdf' });
  try {
    await navigator.share({ files: [file], title: name });
  } catch (err) {
    if (err?.name === 'AbortError') return;   // 共有の画面を閉じた(ファイル名の確認に戻る)
    showToast(`共有できませんでした（${errorText(err)}）`, { durationSec: 5 });
    return;
  }
  closeExportModal();
  showToast('報告書を共有しました');
}

// 保存: 端末に保存(ダウンロード)。保存されたかどうかはアプリに分からないので、完了の知らせは出さない
function savePdf() {
  if (!state?.pdf) return;
  const name = exportFileName();
  downloadBlob(state.pdf.blob, `${name}.pdf`);
  closeExportModal();
}
