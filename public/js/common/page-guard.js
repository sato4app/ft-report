// ページ全体の振る舞いの抑止
// - ページの拡大・ずれの防止(guardPageViewport / resetPageScroll)
// - iPhone の「振って取り消し」の防止(watchTypingUndoHistory)
import { isKeyboardInput } from './ui.js';

const mapView = document.getElementById('viewMap');

// アプリ全体は body { overflow: hidden } でスクロールしない前提。
// 入力欄へのフォーカス等でページ・マップ画面がスクロールしていたら原点に戻す
export function resetPageScroll() {
  const scroller = document.scrollingElement || document.documentElement;
  if (scroller.scrollTop !== 0 || scroller.scrollLeft !== 0) {
    scroller.scrollTop = 0;
    scroller.scrollLeft = 0;
  }
  if (mapView && (mapView.scrollTop !== 0 || mapView.scrollLeft !== 0)) {
    mapView.scrollTop = 0;
    mapView.scrollLeft = 0;
  }
}

// ===== ページの拡大・ずれの防止 =====
// マップ画面の上部ボタン(≡・時刻・記録・カメラ)は、地図(#map、position: fixed で常に画面全体)の
// 上に絶対配置している。ページ自体が拡大されたりスクロールしたりすると、地図はそのままで
// ボタンだけが画面の外(主に上)へ出て押せなくなる。そこでページの拡大とずれを起こさせない。
// - 拡大: 地図の上は Leaflet が止めているが、ボタン・時刻の周りやメニュー・モーダルの上で
//   2本指を広げるとページが拡大され、地図の上では(Leaflet が受け取るため)戻せなくなる。
//   写真の表示で写真を拡大して閉じたときも、ページが拡大されたまま残る。
//   viewport の指定(index.html)・html の touch-action(style.css)で止め、
//   iOS は利用者の拡大を viewport の指定では止められないため、ここで gesturestart を取り消す。
//   さらに念のため、地図と写真の拡大表示の外で2本指を動かしたときは touchmove を取り消す
//   (2本指の拡大縮小は地図と写真の拡大表示だけで使う。起動時画面・設定・メニューでは何も起きない)。
// - ずれ: スクロールが起きたら、その場で原点へ戻す。文字入力中(ソフトキーボード表示中)は
//   入力欄を見せるためのスクロールなので戻さない(モーダルを閉じたときに app.js の normalizeMapChrome が戻す)
export function guardPageViewport() {
  const cancel = (e) => e.preventDefault();
  document.addEventListener('gesturestart', cancel, { passive: false });
  document.addEventListener('gesturechange', cancel, { passive: false });
  // 地図(Leaflet)と写真の拡大表示(photo-zoom.js)は、2本指の操作を自分で拡大縮小に使うため除く
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length < 2) return;
    if (e.target instanceof Element && e.target.closest('#map, #photoZoomStage')) return;
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  // scroll はバブリングしないため capture で受ける(パネル内のスクロールは対象外)
  document.addEventListener('scroll', (e) => {
    if (e.target !== document && e.target !== mapView) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && isKeyboardInput(active)) return;
    resetPageScroll();
  }, { capture: true, passive: true });
}

// ===== 振って取り消し(iPhone)の防止 =====
// iPhone は本体を振ると、ページで入力した文字を取り消すか尋ねる(「取り消す - 入力」)。
// 入力欄から離れた後もページを開いている間は尋ねるため、移動経路の記録中(画面が消えない)に
// ポケットへ入れて歩くと、揺れで出てしまう。Web からこの機能を止める手段は無いので、
// 入力欄から離れたら取り消しの履歴を消して、尋ねる対象を無くす。
// 履歴は JavaScript から直接は消せないが、iPhone のブラウザ(WebKit)はページ内の iframe を
// 外すとき、ページ全体の取り消しの履歴を消す(FrameLoader::closeURL)。そこで空の iframe を
// 置いてすぐ外す。ほかのブラウザでは履歴は残るが、空の iframe を出し入れするだけなので害は無い
export function watchTypingUndoHistory() {
  document.addEventListener('focusout', (e) => {
    if (!(e.target instanceof HTMLElement) || !isKeyboardInput(e.target)) return;
    // フォーカスが移り終わってから確かめる。別の入力欄へ移っただけなら、そこを離れるときに消す
    setTimeout(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && isKeyboardInput(active)) return;
      clearTypingUndoHistory();
    }, 0);
  });
}

function clearTypingUndoHistory() {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  document.body.appendChild(frame);
  frame.remove();
}
