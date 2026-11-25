## ft-report - 箕面-倒木報告

### 概要

大阪府箕面市の森林整備計画の一環として、国土地理院地図の上で倒木のある場所を記録し、
倒木処理を含めた報告を円滑に進めることを支援する、スマホで使う Web アプリ（PWA）。

- アプリ名: 箕面-倒木報告（ホーム画面の名前も同じ）
- 対応言語: 日本語のみ

> 現在は初期設定を終えた段階で、機能は minoh-hiking と同じ。倒木報告のための機能（起動時画面の「倒木報告」のボタンなど）は、これから追加する。

### minoh-hiking との関係

- [minoh-hiking](https://github.com/sato4app/minoh-hiking)（箕面ハイキングマップ）を履歴ごと引き継いで作った派生アプリで、機能の大部分は minoh-hiking と共通。
- minoh-hiking を上流（upstream）とし、minoh-hiking の変更を git の merge で取り込み続ける。コードは minoh-hiking → ft-report の一方向にだけ流す。
- ft-report だけのファイルは、名前の頭に `ft-` を付ける（例: `public/js/ft/ft-main.js`・`public/css/ft-style.css`・`public/ft-manifest.webmanifest`）。
- 地図データ・通行止めなどの公開データは、minoh-hiking の公開API（`https://minoh-hiking.vercel.app/api/*`）から受け取る。

### 配信先

| 配信先 | 位置づけ | 反映のきっかけ |
|---|---|---|
| GitHub Pages（https://sato4app.github.io/ft-report/） | テスト用 | `main` への push |
| Vercel | 本番（URL は未定） | `release` への push（GitHub Pages で確認したコミット） |

### ドキュメント

| 文書 | 内容 |
|---|---|
| [ft-report の概要](docs/ft-overview.md) | ft-report の位置づけ・minoh-hiking との関係・配信・ft-report で変えた箇所 |

`docs/` にある、名前が `ft-` で始まらない文書は minoh-hiking のもの（内容は minoh-hiking のアプリについて書かれている）。
取り込みのたびにぶつからないよう、消さずに残している。

### ライセンス

ソースコードは [MIT License](LICENSE) で公開している（Copyright (c) 2026 sato4app）。

※ アプリのアイコン（当面）と起動画面の画像は、minoh-hiking のものを使っている（生成AI で作成した画像をもとにしており、著作権は主張していない）。
MIT License はソースコードに対するものである。

なお、アプリが表示する地図データ（国土地理院の地理院タイル、ハイキングマップ情報、通行止め・通行困難地点）は
本リポジトリに含まれず、本ライセンスの対象外である（それぞれの提供元の利用条件に従う）。
