// 画面部品の共通処理(イベント登録・フォーカス・モーダルの開閉)

// 要素が見つからないときに落ちないイベント登録。
// 端末に古い index.html が残ったまま新しい app.js が読み込まれると(シェルの新旧が
// 混ざった状態)、一部の要素が取得できずに初期化が丸ごと止まり、地図まで出なくなる。
// その場合でも残りの初期化を続け、起動時画面のボタンからアプリを更新できるようにする。
export function on(target, type, handler, options) {
  if (!target) {
    console.warn(`[app] 要素が見つからないため ${type} を登録しませんでした(表示が古い可能性があります)`);
    return;
  }
  target.addEventListener(type, handler, options);
}

// ===== フォーカス =====
// ソフトキーボード(文字入力ウインドウ)が開く入力欄かどうか。
// チェックボックス・選択リスト・色ピッカーはキーボードを開かないため対象外
const KEYBOARD_INPUT_TYPES = new Set(['text', 'number', 'search', 'tel', 'url', 'email', 'password']);
export function isKeyboardInput(elem) {
  if (elem.tagName === 'TEXTAREA') return true;
  return elem.tagName === 'INPUT' && KEYBOARD_INPUT_TYPES.has(elem.type);
}

// 入力欄からフォーカスを外す。
// モバイルではフォーカスが残ったまま要素を隠すとソフトキーボードや
// 文字入力ウインドウが表示され続けるため、要素を隠す前に呼ぶ
export function blurActiveElement() {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) active.blur();
}

// ===== モーダル =====
// モーダルを閉じるときの、モーダルごとの処理(各機能のモジュールが setModalHooks で登録する)。
// - beforeClose: 閉じる前に呼ぶ(開いているときだけ)。入力中の内容の保存など、フォーカスを外す前に
//                済ませたい処理(フォーカスを外すと change が来ない端末があるため)
// - afterClose:  閉じた後に呼ぶ。保持していた用途・画像などの後始末
const modalHooks = new Map();

export function setModalHooks(id, hooks) {
  modalHooks.set(id, hooks);
}

// モーダルを閉じる。入力欄にフォーカスが残ったまま非表示にすると、モバイルでは
// ソフトキーボードや文字入力ウインドウが開いたままになる(非表示後は activeElement が
// body へ移るため外せない)。モーダルを閉じるときは必ずこの関数を通す
export function closeModal(modal) {
  const hooks = modal ? modalHooks.get(modal.id) : null;
  if (modal && !modal.hidden) hooks?.beforeClose?.();
  blurActiveElement();
  if (!modal) return;
  modal.hidden = true;
  hooks?.afterClose?.();
}

// 開いているモーダルをすべて閉じる(ビュー切替時の後始末)
export function closeAllModals() {
  for (const modal of document.querySelectorAll('.modal')) {
    if (modal.hidden) continue;
    closeModal(modal);
  }
}
