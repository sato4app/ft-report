// 報告の記入項目と、その設定(項目設定。仕様 docs/ft-funcspec-items.md)。
// 発見報告・処理報告で共通の項目の一覧を持ち、報告の種類ごとに次の設定を読み書きする:
//   enabled    … 入力する・しない(しない項目は入力の画面に出さず、報告書では空欄)
//   default    … 初期値(入力の画面を開いたときに最初から入る値)
//   candidates … 候補(入力欄で選べる値の一覧)
// 設定は端末の localStorage にだけ保存する(サーバーには送らない)。
import { readLocalJSON, writeLocalJSON } from '../common/storage.js';

const SETTINGS_KEY = 'ft-report.itemSettings';
// 以前の版で発見報告が覚えていた「前回の値」(記入者・通報先・通報手段)。
// 項目設定がまだ無い端末では、発見報告の初期値としてこの値を引き継ぐ
const LEGACY_LAST_INPUTS_KEY = 'ft-report.found.lastInputs';

// 報告の種類
export const REPORT_TYPES = [
  { key: 'found', label: '発見報告' },
  { key: 'process', label: '処理報告' }
];

// 記入項目(様式の欄の順)。kind で決められる設定が変わる:
//   text     … 1 行の文字。入力する・しない、初期値、候補
//   number   … 数字。入力する・しない、初期値
//   textarea … 複数行の文字。入力する・しない、初期値
//   choice   … 要・不要・未選択。入力する・しない、初期値
//   auto     … アプリが値を作る(日時・通報日時・写真の見出し)。入力する・しないだけ
// 番号は入力しない(空欄で出す)ので、ここには無い。
export const REPORT_ITEMS = [
  { key: 'date', label: '日時', kind: 'auto', note: '写真の撮影日時から作ります。' },
  { key: 'weather', label: '天気', kind: 'text', candidates: ['晴', '曇', '雨', '雪'] },
  { key: 'temperature', label: '気温（℃）', kind: 'number' },
  { key: 'writer', label: '記入者', kind: 'text' },
  { key: 'subject', label: '対象案件', kind: 'text' },
  { key: 'place', label: '場所', kind: 'text' },
  { key: 'reportTo', label: '通報先', kind: 'text' },
  { key: 'reportMeans', label: '通報手段', kind: 'text', candidates: ['メール', '電話', 'LINE'] },
  { key: 'reportDate', label: '通報日時', kind: 'auto', note: '今日の日付が入ります。' },
  { key: 'participants', label: '参加者', kind: 'text' },
  { key: 'body', label: '活動内容', kind: 'textarea' },
  { key: 'captions', label: '写真の見出し', kind: 'auto', note: '写真の名前が入ります（「写真3」など最初の名前のままなら空）。' },
  { key: 'contactReportTo', label: '通報先へ連絡', kind: 'choice' },
  { key: 'contactGov', label: '行政への連絡', kind: 'choice' },
  { key: 'notes', label: '連絡事項', kind: 'textarea' }
];

// 要・不要・未選択の値
export const CHOICE_VALUES = ['要', '不要', ''];

export function hasDefault(item) {
  return item.kind !== 'auto';
}

export function hasCandidates(item) {
  return item.kind === 'text';
}

// 初めの状態の設定(全部の項目を入力する。初期値は空。候補は項目の定義のもの)
export function defaultItemSettings() {
  const settings = {};
  for (const item of REPORT_ITEMS) {
    settings[item.key] = { enabled: true, default: '', candidates: [...(item.candidates || [])] };
  }
  return settings;
}

// 保存してある値を、今の項目の一覧に合わせて整える(項目が増えても減っても読めるように)
function normalize(saved) {
  const settings = defaultItemSettings();
  if (!saved || typeof saved !== 'object') return settings;
  for (const item of REPORT_ITEMS) {
    const s = saved[item.key];
    if (!s || typeof s !== 'object') continue;
    const target = settings[item.key];
    if (typeof s.enabled === 'boolean') target.enabled = s.enabled;
    if (hasDefault(item) && typeof s.default === 'string') {
      target.default = item.kind === 'choice' && !CHOICE_VALUES.includes(s.default) ? '' : s.default;
    }
    if (hasCandidates(item) && Array.isArray(s.candidates)) {
      target.candidates = s.candidates.map((c) => String(c).trim()).filter(Boolean);
    }
  }
  return settings;
}

// 報告の種類ごとの設定を読む(保存が無ければ初めの状態)
export function loadItemSettings(reportType) {
  const all = readLocalJSON(SETTINGS_KEY);
  if (all && typeof all === 'object' && all[reportType]) return normalize(all[reportType]);
  const settings = defaultItemSettings();
  // 項目設定を作る前の版で覚えていた前回の値を、発見報告の初期値として引き継ぐ
  if (reportType === 'found') {
    const last = readLocalJSON(LEGACY_LAST_INPUTS_KEY);
    for (const key of ['writer', 'reportTo', 'reportMeans']) {
      if (typeof last?.[key] === 'string' && last[key].trim()) settings[key].default = last[key].trim();
    }
  }
  return settings;
}

// 報告の種類ごとの設定を保存する
export function saveItemSettings(reportType, settings) {
  const all = readLocalJSON(SETTINGS_KEY);
  const next = all && typeof all === 'object' ? all : {};
  next[reportType] = normalize(settings);
  writeLocalJSON(SETTINGS_KEY, next);
}
