// Service Worker。担当はアプリシェルと地理院タイルだけ。
// - gsi-{version}: 地理院標準地図タイル(明示ダウンロードでのみ書込)。{version} はタイル一覧の
//   version。旧 version のキャッシュは自動削除しない(利用者がDL済みのタイルを保持する)。
// - app-shell-{日付}.{連番}: アプリシェル(HTML/CSS/JS、CDN、アイコン)。取得戦略は handleShellRequest。
// 公開API(/api/*)は横取りしない。取得とキャッシュはアプリ側(published-data.js)が version を見て行う。

const SHELL_CACHE = 'app-shell-2026-11-28.6';
const TILE_CACHE_PREFIX = 'gsi-';
const SHELL_CACHE_PREFIX = 'app-shell-';

// 開いている画面が古い版のまま残ったことを、画面の側で気づけるようになった最初の版。
// これより前の版(2026-10-21.1 以前)の画面は、ブラウザが裏で新しい版へ入れ替えても気づけない
// (起動時画面のボタンで版を比べても、キャッシュの版名はもう新しいため「更新なし」になる)。
// そのため、アプリを終了して開き直すまで古い画面のまま動き続ける。
// こうした版から切り替わったときは、activate で開いている画面を読み込み直す(→ reloadLegacyClients)。
// 注: 更新確認(update.js)は service-worker.js の中で最初に現れる版名の代入を読むため、
//     ここに「app-shell-」付きの版名を書かないこと。
const PAGE_OUTDATED_AWARE_SINCE = '2026-10-21.2';

// シェル各ファイルの内容ハッシュ一覧。デプロイ時に生成される(未生成なら null 扱い)。
const REVISIONS_URL = './shell-revisions.json';
// インストール時の一覧をキャッシュ自身に控えるためのキー。
// 実在しないパスを使い、シェル資産と衝突しないようにする。
const REVISIONS_KEY = './__shell-revisions__';

// アプリが自分で作る公開データのキャッシュ(published-data.js が put する)。
// SW は読み書きしないが、activate の掃除で消さないよう名前を知っておく必要がある。
// 消すとオフライン起動時に地図データが出ず、タイル一覧も失われる
// (オンラインでは気づけない)。
const APP_MANAGED_CACHES = ['mapdata-cache', 'closures-cache', 'tiles-cache'];

// 同一オリジンの相対パス。JS モジュールは js/ 配下に機能別のフォルダで置く(js/app.js の先頭の一覧)
const SHELL_LOCAL_PATHS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  // 共通(設定・言語・端末への保存・メッセージ・画面部品)
  './js/common/config.js',
  './js/common/i18n.js',
  './js/common/storage.js',
  './js/common/utils.js',
  './js/common/db.js',
  './js/common/messages.js',
  './js/common/ui.js',
  './js/common/page-guard.js',
  './js/common/file-export.js',
  // 地図・現在地・表示設定パネル・マーカーの設定・場所を検索
  './js/map/map.js',
  './js/map/map-overlays.js',
  './js/map/marker-icons.js',
  './js/map/one-finger-zoom.js',
  './js/map/geolocation.js',
  './js/map/layer-panel.js',
  './js/map/marker-settings.js',
  './js/map/place-search.js',
  // 移動経路
  './js/track/track.js',
  './js/track/track-ui.js',
  './js/track/gpx.js',
  // 写真
  './js/photo/photos.js',
  './js/photo/photo-ui.js',
  './js/photo/photo-view.js',
  './js/photo/photo-zoom.js',
  './js/photo/camera.js',
  './js/photo/kmz.js',
  // 配信データ・オフライン地図・アプリの更新
  './js/data/published-data.js',
  './js/data/tiles.js',
  './js/data/update.js',
  // 起動時画面から開く案内(情報・言語・使い方・QR)
  './js/info/info-modal.js',
  './js/info/faq.js',
  './js/info/faq-text.js',
  './js/info/version-history.js',
  './js/info/guide.js',
  './js/info/qrcode.js',
  './manifest.webmanifest',
  './manifest-en.webmanifest',   // スマホの言語が日本語以外のときの manifest(index.html で切替)
  './icons/icon-192-v2.png',
  './icons/icon-512-v2.png',
  './icons/icon-180.png',
  // 起動画面の中央に出す画像。シェルに含めないと、端末のHTTPキャッシュが
  // 失われたとき弱電波下で取得に十数秒かかり、初期表示が空白のままになる
  './icons/Startup-1024x1836.webp'
];
// 注: 以下のファイルは、この一覧に無くても public/ から削除しないこと。
// シェルは stale-while-revalidate のため、端末にはそれらを参照する旧 index.html /
// 旧 app.js がキャッシュされたまま残ることがあり、消すと 404 になる。
// 全端末がアプリ更新(SHELL_CACHE 比較 → confirm)を通した後に削除する。
//   - icons/Startup-512x918.webp    … 2026-08-15〜08-25 の index.html が参照した起動画像
//   - icons/Startup-512x918.png     … その WebP 化前の版。2026-08-15 より前の index.html が直接参照
//   - icons/Startup-v2-512x906.webp … v2 の 512px 版。2026-08-25 に 555px 版へ差し替えた
//   - closures.js                … 公開データ取得を published-data.js に統合する前の版
//   - orientation.js             … 現在地点表示ボタンで方角(扇形)を出していた版の app.js が
//                                  import している。方角は示す向きが安定しないため 2026-09-04 に廃止した
//   - js/photo/photo-explore.js  … app-shell-2026-11-28.1〜.3 の app.js が import する場所を検索(写真の一覧)。
//                                  2026-11-28.4 で文字を入力する検索に改め、js/map/place-search.js に移した。
//                                  中身は 2026-11-28.3 のまま(今の photos.js には無い setHiddenPhotoMarkers を使う)
// なお起動画像の元データ(.odg)は public/ ではなく assets/ に置く(public/ は全ファイルが
//   配信されるため)。差し替えの手順は docs/deployGuide-202609.md の 5.3。
// 2026-11-20(app-shell-2026-11-20.6)に、ルート直下にあった JS・CSS を js/・css/ の下へ移した。
//   それより前の版のシェルキャッシュは、旧 index.html・旧 app.js と、それらが import するモジュールを
//   すべて自分のキャッシュに持つ(過去の版で import 先がシェル一覧から漏れていないことを確認済み)。
//   旧版の画面は自分のキャッシュだけで動くため、ルート直下の旧ファイルは残していない。

// 外部CDN(完全URL一致で判定)
const SHELL_CDN_URLS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet-src.esm.js',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
];

const SHELL_ASSETS = [...SHELL_LOCAL_PATHS, ...SHELL_CDN_URLS];

// インストール: アプリシェルをキャッシュ。内容が変わっていないファイルは、shell-revisions.json
// (デプロイ時に scripts/gen-shell-revisions.mjs が生成する内容ハッシュ一覧)と照らして
// 旧キャッシュから複製し、ネットワークには出ない(全件を取り直すと、弱電波では更新直後の起動が
// 待たされる)。一覧が無い環境(ローカル配信など)では全件を取得する。
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const revisions = await fetchRevisions();
      const previous = await openPreviousShellCache();
      const previousRevisions = previous ? await readStoredRevisions(previous) : null;

      // 個別に処理して失敗を許容(CDNの一部が落ちていても継続)。
      // 内容が一覧のハッシュと一致しなかったファイルがあれば false が返る
      const results = await Promise.all(
        SHELL_ASSETS.map((url) =>
          installAsset(cache, url, { previous, revisions, previousRevisions }).catch((err) => {
            console.warn('[SW] shell add failed:', url, err);
            return true;
          })
        )
      );
      const allVerified = results.every(Boolean);

      // 一覧を控えておく。次回の install がこれと突き合わせて複製の可否を決める。
      // 同時に「デプロイ時の内容と一致することを確認済み」の目印にもなる(裏取得の省略判定)。
      // 一致しないファイルがあったときは控えない。目印が無ければ表示のたびに裏で取り直すため、
      // 古い内容が入ったままになるのを防げる(次の版上げでは全件を取り直す)。
      if (revisions && allVerified) {
        await cache.put(REVISIONS_KEY, new Response(JSON.stringify(revisions), {
          headers: { 'Content-Type': 'application/json' }
        }));
      }
      await self.skipWaiting();
    })()
  );
});

// 1ファイル分のインストール。複製できるものは複製し、それ以外だけ取得する。
// 内容が一覧のハッシュと一致した(または照合しようがない)なら true を返す。
async function installAsset(cache, url, { previous, revisions, previousRevisions }) {
  if (previous && canReuse(url, revisions, previousRevisions)) {
    const hit = await previous.match(url, { ignoreSearch: true });
    if (hit) {
      await cache.put(url, hit);
      return true;
    }
  }
  const { response, verified } = await fetchShellAsset(url, revisions);
  await cache.put(url, response);
  return verified;
}

// シェルのファイルを取得する。
// ブラウザの HTTP キャッシュは通さない(cache: 'reload')。GitHub Pages は全ファイルを
// max-age=600 で返すため、通すと10分以内に読んだ旧版の index.html などが新しい版の
// キャッシュに入り、「版は新しいのに画面は古い」状態のまま次の版上げまで直らなかった。
// 同一オリジンのファイルは取得した内容を一覧のハッシュと照合し、合わなければ
// (配信元の CDN が旧版を返した等)クエリを付けて取り直す。それでも合わなければ
// 取れた内容のまま入れて verified=false を返す(install が確認済みの目印を付けない)。
async function fetchShellAsset(url, revisions) {
  const response = await fetch(url, { cache: 'reload' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const expected = !SHELL_CDN_URLS.includes(url) && revisions ? revisions[url] : null;
  if (!expected || await revisionOf(response.clone()) === expected) return { response, verified: true };
  try {
    const sep = url.includes('?') ? '&' : '?';
    const retry = await fetch(`${url}${sep}rev=${expected}`, { cache: 'reload' });
    if (retry.ok && await revisionOf(retry.clone()) === expected) return { response: retry, verified: true };
  } catch { /* 取り直せなければ最初の内容を使う */ }
  console.warn('[SW] shell content does not match revisions:', url);
  return { response, verified: false };
}

// 内容ハッシュ(scripts/gen-shell-revisions.mjs と同じ SHA-1 の先頭12桁)
async function revisionOf(response) {
  const digest = await crypto.subtle.digest('SHA-1', await response.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

// 旧キャッシュの内容をそのまま使えるか。
// - CDN: URL にバージョンが入っており内容は変わらないため、あれば常に再利用できる
// - 同一オリジン: 新旧の内容ハッシュが一致するときだけ再利用できる
//   (どちらかの一覧が無ければ判断できないので取得し直す)
function canReuse(url, revisions, previousRevisions) {
  if (SHELL_CDN_URLS.includes(url)) return true;
  if (!revisions || !previousRevisions) return false;
  const now = revisions[url];
  return !!now && now === previousRevisions[url];
}

// 今回デプロイされた内容ハッシュ一覧。取得できなければ null(全件取得になる)
async function fetchRevisions() {
  try {
    const res = await fetch(REVISIONS_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// 直前のアプリシェルキャッシュ(あれば)。activate で1つに掃除されるため通常は1件。
async function openPreviousShellCache() {
  const keys = await caches.keys();
  const name = keys.find((k) => k.startsWith(SHELL_CACHE_PREFIX) && k !== SHELL_CACHE);
  return name ? caches.open(name) : null;
}

// そのキャッシュが作られたときの内容ハッシュ一覧
async function readStoredRevisions(cache) {
  try {
    const res = await cache.match(REVISIONS_KEY);
    return res ? await res.json() : null;
  } catch {
    return null;
  }
}

// このキャッシュが「デプロイ時の内容と一致する」ことを install で確認済みか。
// 確認済みなら stale-while-revalidate の裏取得は不要(新版の検知はアプリ側の
// 更新確認が service-worker.js を直接見て行うため、裏取得に頼る必要がない)。
let shellVerified = null;
function isShellVerified() {
  if (!shellVerified) {
    shellVerified = caches.open(SHELL_CACHE)
      .then((cache) => cache.match(REVISIONS_KEY))
      .then((res) => !!res)
      .catch(() => false);
  }
  return shellVerified;
}

// アプリからの SKIP_WAITING 要求で即座にアクティベート
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// アクティベート: 旧シェルキャッシュのみ掃除。
// タイル(gsi-*)とアプリ管理のキャッシュ(公開データ)は保持する。
// 切り替え前が旧版(PAGE_OUTDATED_AWARE_SINCE より前)だったときは、開いている画面を読み込み直す。
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // 掃除で消える前に、切り替え前の版を見ておく
      const fromLegacy = keys.some((k) =>
        k.startsWith(SHELL_CACHE_PREFIX) && k !== SHELL_CACHE &&
        isShellVersionBefore(k.slice(SHELL_CACHE_PREFIX.length), PAGE_OUTDATED_AWARE_SINCE));
      await Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && !APP_MANAGED_CACHES.includes(k) && !k.startsWith(TILE_CACHE_PREFIX))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
      if (fromLegacy) await reloadLegacyClients();
    })()
  );
});

// 'YYYY-MM-DD.N' 形式の版 a が b より前か(連番は数として比べる)。形式が違えば false
function isShellVersionBefore(a, b) {
  const parse = (v) => {
    const m = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/.exec(v);
    return m ? { date: m[1], seq: Number(m[2]) } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  return x.date < y.date || (x.date === y.date && x.seq < y.seq);
}

// 旧版の画面を、新しい版で読み込み直す。claim の後なので、開いている画面はこの SW の制御下にあり
// navigate できる。
// - ブラウザが新しい版を見つけて入れ替えるのは、アプリを開いた(画面を読み込んだ)ときなので、
//   読み込み直すのは開いた直後の画面になる。記録中などの操作を途中で止めることはまず無い。
// - navigate の完了(読み込み直した画面の表示)は待たない。その画面の取得はこの SW が activate を
//   終えるまで待たされるため、ここで待つと互いに待ち合って止まる。
// - navigate に対応していない端末では何もしない(従来どおり、開き直したときに新しい版になる)。
async function reloadLegacyClients() {
  try {
    const windows = await self.clients.matchAll({ type: 'window' });
    for (const client of windows) {
      client.navigate(client.url).catch((err) => console.warn('[SW] reload failed:', client.url, err));
    }
  } catch (err) {
    console.warn('[SW] reload of legacy pages failed:', err);
  }
}

// fetch: タイルとアプリシェルで挙動分岐
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 地理院標準地図タイル: キャッシュ優先・自動書込しない
  if (
    url.hostname === 'cyberjapandata.gsi.go.jp' &&
    url.pathname.startsWith('/xyz/std/')
  ) {
    event.respondWith(handleTileRequest(req));
    return;
  }

  // CDN(leaflet): cache-first(安定資産)
  if (SHELL_CDN_URLS.includes(req.url)) {
    event.respondWith(handleShellRequest(event));
    return;
  }

  // 公開API(/api/*)は横取りしない。version を見た取得とキャッシュはアプリ側が行う
  // (SW が network-first で挟むと、version ゲートと二重に取得しに行くことになる)。

  // 同一オリジンのアプリシェル: パス末尾で判定
  if (url.origin === self.location.origin) {
    const reqPath = url.pathname; // 例: "/index.html" "/style.css" "/"
    const swDir = self.location.pathname.replace(/[^/]*$/, ''); // 例: "/" or "/foo/"

    const isShell = SHELL_LOCAL_PATHS.some((p) => {
      const expected = swDir + p.replace(/^\.\//, '');
      // "./" は SW スコープ直下を表す(末尾スラッシュで一致)
      if (p === './') return reqPath === swDir;
      return reqPath === expected;
    });
    if (isShell) {
      // 同一オリジンのシェルは stale-while-revalidate(即返し+裏で更新)
      event.respondWith(handleShellRequest(event, { swr: true }));
      return;
    }
  }
});

async function handleTileRequest(req) {
  // 全 gsi-* キャッシュを横断検索(version 変更前にDLしたタイルも活用)
  const allKeys = await caches.keys();
  const tileCacheNames = allKeys.filter((k) => k.startsWith(TILE_CACHE_PREFIX));
  for (const name of tileCacheNames) {
    const cache = await caches.open(name);
    const hit = await cache.match(req);
    if (hit) return hit;
  }
  // キャッシュに無ければネット取得 → 書込まない
  try {
    return await fetch(req);
  } catch {
    // オフラインで未キャッシュ: 空の 504 を返す(Leaflet はそのタイルを描かないだけ)
    return new Response('', { status: 504, statusText: 'Tile not cached and offline' });
  }
}

// iOS/WebKit はナビゲーションに redirected フラグ付き Response を使えない
// (エラー: "Response served by service worker has redirections")。
// Vercel の cleanUrls により /index.html は / へ 308 リダイレクトされるため、
// キャッシュ済みシェル等を返す際は素の Response に作り直して redirected を消す。
function stripRedirect(response) {
  if (!response || !response.redirected) return response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

// アプリシェルの取得。
// - swr=true(同一オリジンのシェル): stale-while-revalidate。キャッシュを即返し、裏でネット取得して
//   次回用に更新する。install で内容一致を確認済み(REVISIONS_KEY あり)のキャッシュでは裏取得を省く。
//   新版の検知と適用は、アプリ側の更新確認(update.js。SHELL_CACHE 比較→confirm)が担う。
// - swr=false(CDN 等の安定資産): cache-first。
async function handleShellRequest(event, { swr = false } = {}) {
  const req = event.request;
  const cache = await caches.open(SHELL_CACHE);
  // ignoreSearch: クエリ付きの URL で起動されても
  // キャッシュ済みシェル(クエリなしで保存)に一致させる
  const cached = await cache.match(req, { ignoreSearch: true });

  if (swr) {
    // 確認済みのキャッシュは再検証しない(毎起動で全件を再検証すると、弱電波では遅くなる)
    if (cached && await isShellVerified()) return stripRedirect(cached);
    // 裏でネット取得→キャッシュ更新(失敗時は null)。SW が早期終了しないよう待機登録。
    const networkUpdate = fetch(req)
      .then((res) => {
        if (res.ok) cache.put(req, res.clone()).catch(() => { });
        return res;
      })
      .catch(() => null);
    event.waitUntil(networkUpdate);
    // キャッシュがあれば即返す。無ければネット取得を待つ。
    if (cached) return stripRedirect(cached);
    const net = await networkUpdate;
    return net ? stripRedirect(net) : new Response('', { status: 504 });
  }

  // cache-first
  if (cached) return stripRedirect(cached);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => { });
    return stripRedirect(res);
  } catch (err) {
    return new Response('', { status: 504 });
  }
}
