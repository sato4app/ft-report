// 項目設定の画面(仕様 docs/ft-funcspec-items.md)。起動時画面の「項目設定」から開く。
// 発見報告・処理報告の記入項目ごとに、入力する・しない、初期値、候補を決める。
// - 報告の種類(発見報告・処理報告)はタブで切り替える。切り替えても、保存するまでの変更は両方とも残る。
// - 「保存」で両方の報告の設定を保存して閉じる。「キャンセル」「×」は保存せずに閉じる。
// - 画面(モーダル)はここで作る(index.html は書き換えない)。開くたびに作り、閉じたら取り除く。
// - 背景(画面の外側)を押しても閉じない(変更をうっかり失わないため)。
import { blurActiveElement } from '../common/ui.js';
import { showToast } from '../common/messages.js';
import { escapeHtml } from '../common/utils.js';
import {
  REPORT_TYPES, REPORT_ITEMS, hasDefault, hasCandidates, hasToggle,
  loadItemSettings, saveItemSettings, defaultItemSettings
} from './ft-report-items.js';

// 開いている間の状態(閉じたら null)
let state = null;

export function openItemSettings() {
  if (state) return;
  const drafts = {};
  for (const t of REPORT_TYPES) drafts[t.key] = loadItemSettings(t.key);
  state = { drafts, current: REPORT_TYPES[0].key, el: null };
  buildDom();
  renderItems();
}

function closeItemSettings() {
  if (!state) return;
  blurActiveElement();
  state.el.modal.remove();
  state = null;
}

function buildDom() {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'ftItemsModal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'ftItemsTitle');
  const tabs = REPORT_TYPES.map((t) =>
    `<button type="button" class="ft-tab" role="tab" data-ft-type="${t.key}">${escapeHtml(t.label)}</button>`).join('');
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-panel ft-found-panel" role="document">
      <header class="modal-header">
        <h2 id="ftItemsTitle">項目設定</h2>
        <button type="button" class="btn-icon" data-ft-cancel aria-label="閉じる">×</button>
      </header>
      <div class="modal-body" data-ft-body>
        <div class="ft-tabs" role="tablist" aria-label="報告の種類">${tabs}</div>
        <p class="modal-note ft-items-note">報告の入力の画面に出す項目、最初から入る値（初期値）、入力欄で選べる候補を決めます。「入力する」を外した項目は入力の画面に出さず、報告書では空欄になります。設定はこの端末（このブラウザ）の中にだけ保存され、ほかの人やほかの端末には影響しません。</p>        <div class="ft-items" data-ft-items></div>
        <div class="button-group button-group-row">
          <button type="button" class="btn btn-primary" data-ft-save>保存</button>
          <button type="button" class="btn btn-neutral" data-ft-cancel>キャンセル</button>
        </div>
        <div class="button-group ft-items-reset">
          <button type="button" class="btn btn-secondary" data-ft-reset>この報告の設定を初めの状態に戻す</button>
        </div>
      </div>
    </div>`;
  document.body.append(modal);
  state.el = {
    modal,
    body: modal.querySelector('[data-ft-body]'),
    items: modal.querySelector('[data-ft-items]')
  };

  modal.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.hasAttribute('data-ft-cancel')) closeItemSettings();
    else if (t.hasAttribute('data-ft-save')) save();
    else if (t.hasAttribute('data-ft-reset')) resetCurrent();
    else if (t.dataset.ftType) switchType(t.dataset.ftType);
  });
  // 「入力する」を外した項目は、初期値・候補の欄を閉じる(値は残す)
  modal.addEventListener('change', (e) => {
    const box = e.target.closest('input[data-role="enabled"]');
    if (box) box.closest('.ft-item').classList.toggle('is-off', !box.checked);
  });
}

// 今の種類の設定を画面に出す
function renderItems() {
  const { el, current } = state;
  const settings = state.drafts[current];
  for (const tab of el.modal.querySelectorAll('.ft-tab')) {
    const on = tab.dataset.ftType === current;
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-selected', String(on));
  }
  el.items.textContent = '';
  for (const item of REPORT_ITEMS) {
    const s = settings[item.key];
    const card = document.createElement('div');
    card.className = 'ft-item';
    card.classList.toggle('is-off', !s.enabled);
    card.dataset.key = item.key;
    const id = `ftItem-${item.key}`;
    let body = '';
    if (item.kind === 'auto') {
      body = `<p class="ft-item-note">${escapeHtml(item.note || '')}</p>`;
    }
    if (hasDefault(item)) {
      let input;
      if (item.kind === 'choice') {
        const opt = (v, label) => `<option value="${v}"${s.default === v ? ' selected' : ''}>${label}</option>`;
        input = `<select id="${id}-default" data-role="default">${opt('', '未選択')}${opt('要', '要')}${opt('不要', '不要')}</select>`;
      } else if (item.kind === 'textarea') {
        input = `<textarea id="${id}-default" data-role="default" rows="3">${escapeHtml(s.default)}</textarea>`;
      } else if (item.kind === 'number') {
        input = `<input type="number" step="any" id="${id}-default" data-role="default" value="${escapeHtml(s.default)}" />`;
      } else {
        input = `<input type="text" id="${id}-default" data-role="default" autocomplete="off" value="${escapeHtml(s.default)}" />`;
      }
      body += `<div class="ft-field"><label for="${id}-default">初期値</label>${input}</div>`;
    }
    if (hasCandidates(item)) {
      body += `<div class="ft-field"><label for="${id}-candidates">候補（1 行に 1 つ）</label>`
        + `<textarea id="${id}-candidates" data-role="candidates" rows="3">${escapeHtml(s.candidates.join('\n'))}</textarea></div>`;
    }
    // 「入力する・しない」を選べない項目(タイトル)は、チェックの代わりに「必ず入力」と出す
    const head = hasToggle(item)
      ? `<label class="ft-item-head">
          <input type="checkbox" data-role="enabled"${s.enabled ? ' checked' : ''} />
          <span class="ft-item-name">${escapeHtml(item.label)}</span>
          <span class="ft-item-state">入力する</span>
        </label>`
      : `<div class="ft-item-head">
          <span class="ft-item-name">${escapeHtml(item.label)}</span>
          <span class="ft-item-state">必ず入力</span>
        </div>`;
    card.innerHTML = `${head}<div class="ft-item-body">${body}</div>`;
    el.items.append(card);
  }
}

// 画面の値を、今の種類の下書きに写す
function collectCurrent() {
  const settings = state.drafts[state.current];
  for (const card of state.el.items.querySelectorAll('.ft-item')) {
    const s = settings[card.dataset.key];
    const box = card.querySelector('[data-role="enabled"]');
    if (box) s.enabled = box.checked;   // 選べない項目(タイトル)は常に入力する
    const def = card.querySelector('[data-role="default"]');
    if (def) s.default = def.value;
    const cand = card.querySelector('[data-role="candidates"]');
    if (cand) s.candidates = cand.value.split(/\r?\n/).map((c) => c.trim()).filter(Boolean);
  }
}

function switchType(type) {
  if (type === state.current) return;
  collectCurrent();
  state.current = type;
  renderItems();
  state.el.body.scrollTop = 0;
}

function resetCurrent() {
  const label = REPORT_TYPES.find((t) => t.key === state.current)?.label || '';
  if (!window.confirm(`${label}の項目の設定を、初めの状態（全部の項目を入力する。タイトルは初めのタイトル、ほかの初期値はなし）に戻しますか。\n「保存」を押すまでは保存されません。`)) return;
  state.drafts[state.current] = defaultItemSettings();
  renderItems();
}

function save() {
  collectCurrent();
  for (const t of REPORT_TYPES) saveItemSettings(t.key, state.drafts[t.key]);
  closeItemSettings();
  showToast('項目の設定を保存しました');
}
