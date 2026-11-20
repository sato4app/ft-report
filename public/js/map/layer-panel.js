// 表示設定パネル(ハイキングマップ表示のメニュー ≡)
// - パネルの開閉
// - パネル内のトグルの状態の保存・復元
// - 移動経路・写真の統計の表示部品と、トグルの右に添える「未出力あり/出力済み」
import { MAP_TOGGLES_KEY } from '../common/config.js';
import { t } from '../common/i18n.js';
import { readLocalJSON, writeLocalJSON } from '../common/storage.js';

const panel = document.getElementById('mapLayerPanel');

export function isLayerPanelOpen() {
  return !panel.hidden;
}

export function setLayerPanelOpen(open) {
  panel.hidden = !open;
}

// 閉じる(読み込んだもの・開いた写真などが見えるように、パネルを片付けるとき)
export function closeLayerPanel() {
  panel.hidden = true;
}

// ===== トグルの状態の保存 =====
// 対象はパネル内のチェックボックス全部(id で対応付ける)。
// トグルを追加しても、パネル内に id 付きで置けば保存・復元の対象になる。
export function mapToggleInputs() {
  return panel ? panel.querySelectorAll('input[type="checkbox"][id]') : [];
}

export function saveMapToggles() {
  const states = {};
  for (const input of mapToggleInputs()) states[input.id] = input.checked;
  writeLocalJSON(MAP_TOGGLES_KEY, states);
}

// 保存済みの状態を戻す。checked を書き換えるだけで change は発火させない
// (各トグルの反映は起動処理が checked を読んで行う)。保存に無いトグルは HTML の初期値のまま
export function restoreMapToggles() {
  const states = readLocalJSON(MAP_TOGGLES_KEY);
  if (!states || typeof states !== 'object') return;
  for (const input of mapToggleInputs()) {
    if (typeof states[input.id] === 'boolean') input.checked = states[input.id];
  }
}

// ===== 移動経路・写真の表示部品 =====
// トグルの右に添える出力済みかどうか(「未出力あり」「出力済み」)。データが無ければ出さない
export function setToggleStatus(elem, hasData, unexported) {
  if (!elem) return;
  elem.hidden = !hasData;
  elem.classList.toggle('is-unexported', hasData && unexported);
  elem.textContent = hasData ? t(unexported ? 'common.unexported' : 'common.exported') : '';
}

// 統計表のセル(「経路 n」など、ラベル単体のもの)
export function buildStatCell(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

// 統計表のセル(「地点数 12」のようなラベル+値の1組)
export function buildStatPair(label, value) {
  const wrap = document.createElement('span');
  wrap.className = 'track-stat';
  wrap.appendChild(buildStatCell('track-stat-label', label));
  wrap.appendChild(buildStatCell('track-stat-value', value));
  return wrap;
}
