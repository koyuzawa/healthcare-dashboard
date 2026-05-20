# healthcare-dashboard

iPhone「ヘルスケア」アプリから書き出した `export.zip` / `export.xml` を、
ブラウザだけで可視化するシンプルなダッシュボードです。

- **ローカル完結**：ファイルはブラウザ内でのみ処理され、どこにも送信されません。
- **ビルド不要**：`index.html` を開くだけで動きます（または任意の静的サーバーで配信）。
- **大きいファイルでもOK**：Blob をチャンク読みしながら集計するので、数百MBのXMLも扱えます。

## 使い方

1. iPhone の「ヘルスケア」アプリ → プロフィール → **すべてのヘルスケアデータを書き出す**
2. 生成された `export.zip` をPCに転送
3. このリポジトリの `index.html` をブラウザで開く
4. zip / xml をドロップしてアップロード

## 表示できるメトリクス

- 歩数
- 歩行・走行距離
- アクティブエネルギー
- 上った階数
- 心拍数（平均）
- 安静時心拍数
- 体重
- 睡眠時間（Asleep系のみ集計）

## ローカルで動かす

ファイルを直接開いても動きますが、一部のブラウザでは `file://` でのスクリプト実行が制限される
場合があります。その場合は任意の静的サーバーで配信してください。

```sh
# 例: Python の組み込みサーバー
python3 -m http.server 8000
# → http://localhost:8000 を開く
```

## デプロイ（GitHub Pages）

`main` ブランチに push されると `.github/workflows/pages.yml` が走り、自動で
GitHub Pages にデプロイされます。初回だけリポジトリ設定が必要です。

1. GitHub → リポジトリ → **Settings** → **Pages**
2. **Source** を **GitHub Actions** に変更（"Deploy from a branch" ではない方）
3. `main` に変更を push（またはActionsタブから "Deploy to GitHub Pages" を手動実行）
4. 公開先: `https://<ユーザー名>.github.io/healthcare-dashboard/`
