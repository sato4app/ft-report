# ft-report（箕面倒木報告）の概要

## 1. 位置づけ

- 大阪府箕面市の森林整備計画の一環として、国土地理院地図の上で倒木のある場所を記録し、倒木処理を含めた報告を円滑に進めることを支援する、スマホで使う Web アプリ（PWA）。
- アプリ名は「箕面倒木報告」。ホーム画面の名前（アイコンの下に出る名前）とページのタイトルも同じ。
- テーマ色はオレンジ。
- 日本語のみ対応する。ただし、minoh-hiking の英語の言語設定は残す（「情報・言語」で English を選ぶと、minoh-hiking の英語の文言になる。ft-report で足した画面は日本語のまま）。
- minoh-hiking の機能は、基本的にそのまま残す。ft-report の機能は足すだけにする。

## 2. minoh-hiking との関係

- minoh-hiking（https://github.com/sato4app/minoh-hiking）を履歴ごと引き継いで作った。機能の 80〜90% は minoh-hiking と同じ。
- minoh-hiking を上流（upstream）、ft-report を下流とし、minoh-hiking の変更を git の merge で取り込み続ける。
  - コードは minoh-hiking → ft-report の一方向にだけ流す。ft-report のコードは minoh-hiking に入れない。
  - 共通部分の不具合は minoh-hiking で直してから取り込む。
- 取り込みでぶつからないよう、次のようにしている。
  - ft-report で新しく作るファイルは、名前の頭に `ft-` を付ける（新しく作るフォルダは `ft`）。
  - ft-report の処理は `ft-` の新しいファイルに置き、minoh-hiking 由来のファイルは必要な行だけを書き換える。
  - minoh-hiking 由来の英語の文言・言語の設定、保存キー（`minoh-hiking.` で始まるもの）、IndexedDB の名前などは変えない。
- 将来、データ共有（サーバーに保管する）機能を持たせる可能性がある（未決定）。その種のコードは ft-report にだけ置く。

## 3. 公開データ

- 地図データ（緊急ポイント・ハイキングルート・スポット）と通行止め・通行困難地点は、minoh-hiking の公開API（`https://minoh-hiking.vercel.app/api/*`）から GET で受け取る。
- 配信先（GitHub Pages・Vercel・ローカル）によらず、常に minoh-hiking の本番の API を見る（`public/js/common/config.js` の `PUBLISH_API_BASE`）。ft-report は自分の API（`api/`）を使わない。

## 4. 配信

minoh-hiking と同じ 2 段階で配信する。

| 配信先 | 位置づけ | 反映のきっかけ |
|---|---|---|
| GitHub Pages（https://sato4app.github.io/ft-report/） | テスト用 | `main` への push（`.github/workflows/pages.yml`） |
| Vercel | 本番（URL は未定） | `release` への push（GitHub Pages で確認したコミット） |

- GitHub Pages では、minoh-hiking の確認用（https://sato4app.github.io/minoh-hiking/）と同じオリジンになる。そのため、端末内のデータ（設定・写真・経路）とキャッシュが minoh-hiking と分かれない。GitHub Pages はテストにだけ使い、テストでは minoh-hiking とブラウザ（またはプロファイル）を分けて開く。
- Vercel の本番は、minoh-hiking とオリジンが分かれるので、この問題は起きない。

## 5. ft-report で変えた箇所

### 5.1 新しく作ったファイル

| ファイル | 内容 |
|---|---|
| `public/ft-manifest.webmanifest` | ft-report の manifest（名前・テーマ色（オレンジ `#ef6c00`）・アイコン） |
| `public/icons/ft-icon-192.png`・`ft-icon-512.png`・`ft-icon-180.png` | アイコン（2026-11-26 に ft-report 用の絵に差し替えた） |
| `public/icons/ft-startup-1024x1834.webp` | 起動時画面の画像（「箕面の森 倒木報告」の文字入り） |
| `assets/ft-startup-20261126-v3.odg` | 起動時画面の画像の元データ（LibreOffice Draw）。`-v1`・`-v2` は前の版。公開しない（`public/` の外） |
| `assets/ft-startup-1024x1835.png` | 起動時画面の画像の絵の部分。公開しない |
| `public/js/ft/ft-main.js` | ft-report だけの処理の入口（`initFt()`）。起動時画面の倒木報告のボタン（発見報告・探索・案内・処理報告と、項目設定を開く「設定」）を作る。「探索・案内」「処理報告」はまだ作っておらず、押すと「準備中です」と出る |
| `public/js/ft/ft-found.js` | 発見報告の画面（写真の選択・入力・出力） |
| `public/js/ft/ft-report-data.js` | 報告書の中身の組み立て（PDF・Excel で共通）と、地図データ（緊急ポイント・ルート）の読み込み |
| `public/js/ft/ft-report-layout.js` | 報告書の様式の配置と PDF の作成 |
| `public/js/ft/ft-report-map.js` | 報告書の地図の画像 |
| `public/js/ft/ft-pdf.js` | PDF の組み立て（ライブラリを使わない） |
| `public/js/ft/ft-report-items.js` | 報告の記入項目の一覧と、項目設定の読み書き（発見報告・処理報告で共通） |
| `public/js/ft/ft-item-settings.js` | 項目設定の画面 |
| `public/js/ft/ft-weather.js` | 発見報告の「天気・気温を調べる」（箕面大滝付近の天気・気温を Open-Meteo から取る） |
| `public/css/ft-style.css` | ft-report だけのスタイル。style.css のテーマ色（緑）をオレンジに上書きする。起動時画面の倒木報告のボタンなど、ft-report で足す画面部品のスタイルもここに置く |
| `.gitattributes` | 取り込みのとき README.md・CLAUDE.md は ft-report 側を残す（`merge=ours`） |
| `docs/ft-overview.md` | この文書 |
| `docs/ft-funcspec-found.md` | 発見報告の機能仕様書（2026-11-26 実装） |
| `docs/ft-funcspec-items.md` | 項目設定の機能仕様書（2026-11-26 実装） |

### 5.2 minoh-hiking 由来のファイルで書き換えた箇所

| ファイル | 箇所 |
|---|---|
| `public/index.html` | `theme-color`（オレンジ）、`<title>`、manifest の参照先、`apple-mobile-web-app-title`、端末の言語で manifest を切り替えるスクリプト（先頭で return）、アイコンの参照先、`ft-style.css` の読み込み、起動時画面の画像の参照先、「このアプリについて」のアプリ名・URL・ソースコードのリンク |
| `public/js/common/i18n.js` | 日本語の `app.title`・`info.appNameValue`・`guide.introTitle` |
| `public/js/common/config.js` | `PUBLISH_API_BASE`（常に minoh-hiking の公開API を見る） |
| `public/service-worker.js` | `SHELL_CACHE`（ft-report の版名）と取り込んだ minoh-hiking の版のコメント、`SHELL_LOCAL_PATHS` の末尾の ft-report 専用の区画 |
| `public/js/app.js` | `initFt` の import と、起動処理の最後での呼び出し |
| `README.md` | 全面的に ft-report の内容 |

使い方の紹介文（ハイキング向けの文）は minoh-hiking のまま変えていない（不都合が出たら検討する）。

## 6. 今後決めること

- 倒木報告のための機能のうち、「探索・案内」と「処理報告」の中身（発見報告は作った。→ `docs/ft-funcspec-found.md`）
- 報告書の Excel の出力（様式の元の Excel に値と写真を入れる形を検討する）
- データ共有（サーバーに保管する）機能を持たせるか。持たせる場合は、「外部へ送信しない」趣旨の文言（よくある質問・使い方など）を見直す
- 本番（Vercel）の URL
