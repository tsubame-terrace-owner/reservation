# 予約システム (reservation)

## ざっくり

燕テラスのお客様向け **予約 Web サイト**。
GitHub Pages のフロントエンド + GAS のバックエンドで動く。

公開 URL: `https://tsubame-terrace-owner.github.io/reservation/`

## フォルダ構成

| フォルダ | 役割 |
|---|---|
| `docs/` | **GitHub Pages で公開されるフロントエンド**（お客様が見る画面）。`index.html`（トップ） / `menu.html`（お品書き） / `form.html` / `cancel.html` / `change.html` など |
| `docs/assets/` | 公開画像。ロゴ4種（縦型 `logo.png` / `logo-white.png`、横型 `logo-wide.png` / `logo-wide-white.png`。いずれも透過PNG。白版は背景動画や写真の上に載せる用） / `hero.mp4` / `menu/`（料理写真） |
| `gas/` | **GAS バックエンド** + HtmlService で配信するメール/管理画面 |
| `tools/` | 開発補助スクリプト。`prep-photo.py`（料理写真の切り出し・圧縮） |
| `spike/` | 実験用プロトタイプ（本番には影響しない） |
| `素材写真・ロゴ/` | ロゴ・写真の元素材（公開されない） |

## ページ構成

| ページ | 役割 |
|---|---|
| `index.html` | トップ。背景動画＋白ロゴ＋CTA2本（ランチメニュー／ご予約）。将来アクセス等を足せるよう `.hero-actions` に縦積みでまとめてある |
| `menu.html` | お品書き。プレート・デザート・ドリンクから1つずつ選ぶ構成。**2ヶ月に1回程度差し替える**（→ `/menu-update` スキル） |
| `form.html` | 予約フォーム |
| `cancel.html` / `change.html` | メールのリンクから `?token=` 付きで開く |

## システムの動線

```
[お客様] → docs/ (GitHub Pages) で予約フォーム入力
   ↓ form.html → fetch で GAS に送信
[GAS コード.gs] 予約を Sheets に記録
   ├→ [Google Sheets] 予約データ蓄積
   ├→ [MailApp] お客様に確認メール (EmailConfirmation.html)
   └→ オーナー宛に通知メール

[キャンセル/変更] → docs/cancel.html or change.html → GAS で処理
[リマインダー] → GAS の時間トリガー → EmailReminder.html を送信
[Admin.html] → オーナー専用の予約管理画面（GAS で配信）
```

## メールテンプレート（`gas/` 内）

| ファイル | 送信タイミング |
|---|---|
| `EmailConfirmation.html` | 予約完了時 |
| `EmailReminder.html` | 予約日が近づいたら |
| `EmailChange.html` | お客様が変更した時 |
| `EmailCancellation.html` | お客様がキャンセルした時 |
| `EmailThankYou.html` | 来店後のサンキューメール |

## 重要な設定

- GAS スクリプトプロパティに `FRONTEND_BASE_URL` を持つ
  - 現在: `https://tsubame-terrace-owner.github.io/reservation/`
  - メール本文の URL 生成・redirect 用
- `BOOKING_WINDOW_DAYS` = 30（予約受付の最大先日数）

## 旧 URL からの redirect

旧 URL `tsubame-terrace-owner.github.io/tsubame-terrace/` は別リポ `tsubame-terrace/` で redirect 中。
**2026-07-07 以降に旧リポ削除予定**。詳細は `燕テラス/tsubame-terrace/README.md` 参照。

## 修正時の注意

- **フロントエンドの修正** (`docs/` 配下): main ブランチへ push → 数分で GitHub Pages に反映
- **バックエンドの修正** (`gas/` 配下): **clasp で同期**（下記「GAS 同期（clasp）」参照）。旧来の手動コピペは不要になった
- **メールテンプレ修正**: `gas/Email*.html` を編集 → clasp push で反映
- お客様に見える文言の変更は **送信前にオーナーが確認** できる形にする

## フロントエンドの落とし穴（実際に本番で症状が出たもの）

`docs/` 配下を触る時に踏みやすい。いずれも 2026-08 に実際に発生した。

### CSSグリッドの `1fr` は画像の元幅まで広がる

```css
grid-template-columns: repeat(2, 1fr);          /* ✗ 列が画像の元幅(1000px)まで膨らみ横にはみ出す */
grid-template-columns: repeat(2, minmax(0,1fr)); /* ○ */
```

`1fr` は既定で「中身より狭くならない」ため、大きな画像を入れると列が膨張する。症状は「画像が異常に大きい／縦長の帯に見える」。

### スマホの `100vh` は実際の表示領域より大きい

URLバーや下部ツールバーの分を含んだ高さになるため、中央寄せの中身が**下寄りに見える**。`100svh` を使う。非対応ブラウザ用に `100vh` の行も残す。

```css
min-height: 100vh;   /* 保険 */
min-height: 100svh;  /* 実際の表示領域 */
```

### `<img>` の width/height には「表示サイズ」を書く

元画像の寸法（例 800）を書くと、**CSSがキャッシュで古い端末では巨大表示される**。HTMLだけ先に更新されCSSが古い、という組み合わせで起きる。CSSに依存せず正しい大きさで出るよう、実際に表示する寸法を書く。

### 写真の EXIF 回転

スマホ写真は生データが横長でも EXIF に「表示時は回せ」と入っていることがある。ブラウザはこれに従う。画像を加工する時は必ず `ImageOps.exif_transpose` を通す。**手書きせず `tools/prep-photo.py` を使う**。

### ヘッドレスEdgeの `--window-size` は viewport に効かない

スマホ幅の描画確認をする時は、390px幅の iframe に流し込んだラッパーHTMLを作って撮る。詳細は `/menu-update` スキル参照。

## スキル

| スキル | 用途 |
|---|---|
| `/menu-update` | `docs/menu.html` の季節ごとの差し替え。写真の受け取り・加工から公開まで |

## GAS 同期（clasp）

`gas/` 配下のコードは **clasp（Google 公式 CLI）でローカル ↔ GAS を同期**する。
2026-07-05 に導入。以前の「手動コピペ反映」は廃止。

### 前提（セットアップ済み）

- clasp インストール済み（`npm install -g @google/clasp`）
- 認証情報は `~/.clasprc.json`（ホーム側。**リポには入れない**）
- リポ直下 `.clasp.json` に `scriptId` と `rootDir: "gas"` を設定済み
- `gas/appsscript.json` がマニフェスト（push に必須）
- Google 側で「Apps Script API」を ON 済み

### コード同期（お客様に影響なし）

```
clasp push        # ローカル gas/ → GAS の倉庫コード（HEAD）を更新
clasp pull        # GAS → ローカルに取得（差分確認・復元時）
clasp status      # push 対象ファイル一覧
```

### お客様URLへ反映（本番デプロイ）

お客様のフォーム（`docs/form.html` 等）が叩く GAS URL は
**特定バージョンに固定されたデプロイ**を指している（＝ push だけでは反映されない）。

- 固定デプロイ ID: `AKfycbwGknTdmReT2qDHp_PrdF_u9MMZoWSbEBU8IMcLanTks-EDiDYxj1obttPRbokiue84`（お客様用・**この ID を維持すれば URL 不変**）
- もう1つ `@HEAD` のデプロイもあるが、お客様URLは上記の固定側

反映手順（3ステップ）:

```
clasp push                                   # ①倉庫コード更新
clasp create-version "変更の説明"             # ②新バージョン作成（番号が1つ増える）
clasp redeploy <お客様デプロイID> -V <番号> -d "変更の説明"   # ③お客様URLを新バージョンへ貼り替え（URL不変）
```

### 注意

- **`clasp push` は必ず `main` ブランチから実行する**。clasp はブランチを見ないので、
  古い `gas/` を持つ feature ブランチから push すると、**既にデプロイ済みの変更が本番から静かに消える**。
  feature ブランチで GAS を検証したい時は、先に `git merge main` してから push すること
- **push だけではお客様に反映されない**。必ず ②③まで実施
- 本番デプロイ（③）は**お客様の実画面が変わる**ので、文言変更はオーナー確認後に
- 変になったら `clasp pull` で戻す／固定デプロイを旧バージョンに `redeploy` して切り戻せる
- `.clasp.json` / `gas/appsscript.json` は秘密情報なし。git 管理して OK

## 本番操作の運用ルール（2026-07-05 合意）

スプレッドシート等のバックアップがある前提で、**Claude は本番（GAS・Google シート・GitHub）を直接操作してよい**。ただし以下は必須:

1. **事前確認**：実行前に「何が起きる／戻せるか／戻せないか」を提示し、確認を取ってから実行する
2. **入念なチェック**：破壊的・不可逆な操作の前に、差分確認・影響範囲・切り戻し手順を必ず点検する
3. **実データの消去・上書きは特に慎重に**（先に状態を確認し、バックアップの有無を明示）

技術的な強制力は `.claude/settings.local.json` に設定済み（読み取り系は自動許可、本番反映系＝`clasp push` / `redeploy` / `run` / `git push` 等は**必ず確認プロンプト**）。

## 申し送り（未完の整合作業）

**子ども内訳（小学生以上/未就学）対応の残り**（2026-07-07 時点）:
- お客様向けの `docs/form.html`・`docs/change.html` は**案C（お連れのお子様→小学生以上/未就学の内訳入力）に対応済み**。バックエンド（`schoolChildren`/`preschoolChildren` 列）・シートも対応済み・本番稼働中。
- ⚠️ **GAS配信の `gas/Form.html`・`gas/Admin.html`・`gas/Change.html` は旧UI（大人/子ども）のまま**。オーナーの手動予約画面などで、お客様は使わないため実害はないが未整合。
- → **これらの gas HTML を次に触る時に、案Cへ揃える**こと。参考実装は `docs/form.html`（ラジオ+内訳ステッパー+注意書き、payload に schoolChildren/preschoolChildren を送る）。
- 詳細はメモリ `child-reservation-migration` 参照。

**当日予約（枠開始30分前まで受付）**（2026-08-23 リリース）:
- お客様向けの `docs/form.html`・`docs/change.html` のみ対応。締切判定は GAS の `isSlotBookable()` に集約。
- ⚠️ **旧GAS UI（`gas/Form.html`・`gas/Change.html`）は当日予約に非対応**。
  `renderFormPage` / `renderChangePage` の中で `minDaysAhead: 1` をハードコードして挙動を凍結してある。
  上の案C対応でこれらを触る時は、この固定値も併せて見直すこと。
- `gas/Admin.html`（手動予約）は従来どおり当日の過ぎた枠にも入力できる。
  飛び込み客の事後記録に必要なので**意図的にそのまま**にしている。
- 当日予約を止めたい時は `CONFIG.MIN_BOOKING_DAYS_AHEAD` を `1` に戻して再デプロイすれば全面停止できる。

## 触らないでいいこと

- 認証導入（URL ベース、トークンは予約ごとの個別キー方式）
- 複数店舗対応
- 決済機能（現状ノータッチ運用）
