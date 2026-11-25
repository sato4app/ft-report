# ft-report（箕面-倒木報告）の概要

## 1. 位置づけ

- 大阪府箕面市の森林整備計画の一環として、国土地理院地図の上で倒木のある場所を記録し、倒木処理を含めた報告を円滑に進めることを支援する、スマホで使う Web アプリ（PWA）。
- アプリ名は「箕面-倒木報告」。ホーム画面の名前（アイコンの下に出る名前）とページのタイトルも同じ。
- テーマ色はオレンジ。
- 日本語のみ対応する。
- 今後、起動時画面に「倒木報告」のボタンを足して表示する予定。

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
| `public/icons/ft-icon-192.png`・`ft-icon-512.png`・`ft-icon-180.png` | アイコン。当面は minoh-hiking のアイコンの複製で、後で差し替える |
| `public/js/ft/ft-main.js` | ft-report だけの処理の入口（`initFt()`。今は何もしない） |
| `public/css/ft-style.css` | ft-report だけのスタイル。style.css のテーマ色（緑）をオレンジに上書きする。ft-report で足す画面部品のスタイルもここに置く |
| `.gitattributes` | 取り込みのとき README.md・CLAUDE.md は ft-report 側を残す（`merge=ours`） |
| `docs/ft-overview.md` | この文書 |

### 5.2 minoh-hiking 由来のファイルで書き換えた箇所

| ファイル | 箇所 |
|---|---|
| `public/index.html` | `theme-color`（オレンジ）、`<title>`、manifest の参照先、`apple-mobile-web-app-title`、端末の言語で manifest を切り替えるスクリプト（先頭で return）、アイコンの参照先、`ft-style.css` の読み込み、「このアプリについて」のアプリ名・URL・ソースコードのリンク |
| `public/js/common/i18n.js` | 日本語の `app.title`・`info.appNameValue`・`guide.introTitle` |
| `public/js/common/config.js` | `PUBLISH_API_BASE`（常に minoh-hiking の公開API を見る） |
| `public/service-worker.js` | `SHELL_CACHE`（ft-report の版名）と取り込んだ minoh-hiking の版のコメント、`SHELL_LOCAL_PATHS` の末尾の ft-report 専用の区画 |
| `public/js/app.js` | `initFt` の import と、起動処理の最後での呼び出し |
| `README.md` | 全面的に ft-report の内容 |

起動時画面の画像（「箕面の森ハイキングマップ」の文字入り）と、使い方の紹介文（ハイキング向けの文）は minoh-hiking のまま変えていない（不都合が出たら検討する）。

## 6. 今後決めること

- 倒木報告のための機能（記録する項目・報告のしかた）
- データ共有（サーバーに保管する）機能を持たせるか。持たせる場合は、「外部へ送信しない」趣旨の文言（よくある質問・使い方など）を見直す
- アイコンの差し替え
- 本番（Vercel）の URL
