// 端末への保存(localStorage / sessionStorage)の読み書き
// プライベートウィンドウや保存を禁止した環境では、読み書きが例外になる。保存できなくても
// アプリの動作は続けるため、例外はここで握りつぶす(読めないときは fallback を返す)。
// キー名は config.js にまとめている。

// localStorage の値(無ければ null)。読めない環境では fallback を返す
export function readLocal(key, fallback = null) {
  try {
    return localStorage.getItem(key);
  } catch {
    return fallback;
  }
}

// localStorage へ保存する。value が null / undefined なら削除する
export function writeLocal(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch { /* 保存できなくても動作は続ける */ }
}

// JSON で保存した値(無い・壊れている・読めないときは null)
export function readLocalJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

export function writeLocalJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* 保存できなくても動作は続ける */ }
}

// sessionStorage の値を読み、同時に消す(再読み込みをまたいだ一度きりの受け渡し用)。
// 無い・読めないときは null
export function takeSession(key) {
  try {
    const value = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return value;
  } catch {
    return null;
  }
}

export function writeSession(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch { /* 控えられなくても動作は続ける(再読み込み後に元の画面へ戻らないだけ) */ }
}
