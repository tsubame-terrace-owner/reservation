---
name: menu-update
description: 燕テラスのメニューページ（docs/menu.html）を季節ごとに差し替える。写真の受け取り・加工、品名や説明文の入れ替え、スマホでの確認、本番公開までを一通り行う。「メニューを差し替えたい」「新しいお品書きにして」「料理写真を入れ替えて」等で使う。
---

# メニューページの差し替え

`docs/menu.html` の内容を新しいお品書きに入れ替える。**2ヶ月に1回程度**発生する定例作業。

## 前提

- メニューは **プレート・デザート・ドリンクから1つずつ選ぶ** 構成。基本料金 2,650円（税込）にデザートとドリンクが含まれ、品目によって追加料金が乗る
- 追加料金は**個別には表示しない**。ページ下部の注意書きで「お選びいただくメニューによって、追加料金が発生する場合がございます」とまとめて断る方針（2026-08 に店側と合意）
- 更新は人の手作業。スプレッドシート連携などの自動化は入れていない

## 手順

### 1. 新しい内容を受け取る

必要なのは **品名・説明文・カテゴリ分け**と**写真**。

情報源は次のどれかになる。いずれも**こちらからは読めない**ので、内容を貼ってもらうか画像として送ってもらう。

- Google ビジネスプロフィールのメニュー → **画面のスクリーンショットを送ってもらう**（画像なら読める）
- 店頭のお品書き → 同上。ただし**小さい文字の金額は読み取りを誤る**ので、確信が持てない数字は推測せず必ず確認する
- Google ドライブ／スプレッドシート → 認証が通っていないため読めない。「リンクを知っている全員が閲覧可」にしてURLをもらうか、内容を貼ってもらう

### 2. 写真を受け取る

**Google ドライブから直接は取得できない。** ダウンロードしてもらう。

落としてもらったら、`~/Downloads` を更新時刻で探せばよい（パスを聞く必要はない）。

```bash
find /c/Users/max51/Downloads -maxdepth 1 -type f -newermt "1 hour ago" -printf "%TH:%TM  %8s  %f\n" | sort
```

複数枚あってどれか分からない時は、一覧にして番号で選んでもらう。

```bash
python tools/prep-photo.py sheet /c/Users/max51/Downloads -o _photo-sheet.jpg
```

### 3. 写真を加工する

`tools/prep-photo.py` を使う。**手書きで画像処理コードを書かないこと**（EXIF回転の扱いを毎回間違える）。

```bash
# 切り出し位置の候補を見比べる（皿が欠けない位置を探す）
python tools/prep-photo.py try /c/Users/max51/Downloads/IMG_1234.JPG -o _crop-try.jpg

# 位置を決めて書き出す
python tools/prep-photo.py make /c/Users/max51/Downloads/IMG_1234.JPG docs/assets/menu/dessert-flan.jpg --pos 0.45
```

**必ず書き出した画像を目視で確認する。** 皿が切れていないか、料理が中心にあるか。

ファイル名は `plate-rice.jpg` `dessert-flan.jpg` のように**半角英数で中身が分かるもの**にする。`dessert-cream.jpg` に実はメレンゲが入っている、のような不一致は後で必ず混乱を生む。作業中に名前と中身がずれたら、その場で改名する。

不要になった写真は削除する。使わないファイルが残っていると、次回どれが現役か分からなくなる。

### 4. menu.html を編集する

`docs/menu.html` の本文に

```
▼▼▼ ここから下がメニュー本体。季節ごとの差し替えはこのブロックだけ触ればOK ▼▼▼
```

というコメントがある。**その範囲だけを編集する。** 上のCSSやヘッダーには触らない。

構造は次のとおり。

- `<section class="menu-section">` がカテゴリ1つ（プレート／デザート／ドリンク）
- 写真つきの品目は `<li class="menu-card">`。2列で並ぶ
- **写真なしの品目**は `<li class="menu-card menu-card--wide">`。2列の下に横幅いっぱいで入る
- ドリンクは写真なしのリスト。`ソフトドリンク` `ノンアルコール` `アルコール` の3つの `<div class="drink-group">` に分かれている

`<img>` の `width` / `height` には**表示サイズ**（120や1000ではなく、実際にCSSで表示する寸法）を書く。元画像のサイズを書くと、CSSがキャッシュで古い端末で巨大表示される（実際に本番で発生した）。カード内の写真は `width="1000" height="1000"` でよい。

### 5. スマホ幅で確認する

ローカルにサーバーを立てて確認する。

```bash
cd docs && python -m http.server 8766 &
```

PCブラウザなら `http://localhost:8766/menu.html`。

スマホ実機で見るなら、PCのLAN内アドレスを調べて同じWi-Fiから開いてもらう。

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object IPAddress, InterfaceAlias
```

**URLをユーザーに渡す時は、末尾に句読点や括弧を付けないこと。** コピーされて404になる。

ヘッドレスで撮って自分で確認する場合、**Edge に `--window-size` を指定しても viewport には効かない**。390px幅の iframe に流し込んだラッパーHTMLを作って、それを撮る。

```html
<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{margin:0;background:#333;padding:10px}iframe{border:0;background:#fff}</style></head><body>
<iframe src="menu.html" width="390" height="2600" scrolling="no"></iframe>
</body></html>
```

```bash
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu \
  --hide-scrollbars --window-size=430,2630 --screenshot="$PWD/shot.png" \
  --virtual-time-budget=9000 "http://localhost:8766/_frame.html"
```

確認用の一時ファイル（`_frame.html` 等）は**必ず消す**。

### 6. 公開する

写真と文言の差し替えだけなら `main` で直接作業してよい。大きく構成を変える場合や、数日かけてオーナー確認を挟む場合はブランチを切る。

公開前に**必ず**「何が変わるか／戻せるか」を提示して確認を取る（`CLAUDE.md` の運用ルール）。特に**お客様に見える文言が変わるので、オーナー確認を挟むか聞く**。

```bash
git add docs/menu.html docs/assets/menu
git commit -m "..."
git push origin main
```

反映は2〜5分。**ファイル名を変えずに写真を差し替えた場合はブラウザにキャッシュが残る**ので、確認時は `Ctrl + Shift + R`（スマホなら開き直し）を案内する。

### 7. 切り戻し

```bash
git revert <コミット> && git push origin main
```

または `main` を1つ前に戻して push。データには一切触れないので、いつでも安全に戻せる。

## やらないこと

- 追加料金の個別表示（方針として出さない）
- 提供期間の表示（更新忘れで「古い店」に見えるため置かない）
- `docs/styles.css` の変更（予約フォーム3ページに巻き添えが出る）。menu.html 固有の見た目は `<head>` 内の `<style>` に書く
