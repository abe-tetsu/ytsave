# ytsave

YouTube の動画を保存するデスクトップアプリ（macOS / Windows）。
URLを貼って「ダウンロード」を押すだけ。動画（mp4）か音声（mp3）を選べます。

中身は [yt-dlp](https://github.com/yt-dlp/yt-dlp) + [ffmpeg](https://ffmpeg.org/) を同梱した [Tauri](https://tauri.app/) アプリです。

> 自分の動画や、権利者が許可しているものだけに使ってください。

## ダウンロード

[Releases](../../releases) から OS に合ったファイルを取得します。

| OS | ファイル |
|---|---|
| macOS（Apple Silicon） | `ytsave_x.y.z_aarch64.dmg` |
| macOS（Intel） | `ytsave_x.y.z_x64.dmg` |
| Windows | `ytsave_x.y.z_x64-setup.exe` |

### 初回起動の注意

開発者署名をしていないため、初回だけ OS の警告が出ます。

- **macOS**: 「壊れているため開けません」と出たら、ターミナルで次を実行してから開き直してください。
  ```bash
  xattr -cr /Applications/ytsave.app
  ```
- **Windows**: SmartScreen の画面で「詳細情報」→「実行」を選びます。

## 使い方

1. 動画のURLを貼る
2. 形式（動画 mp4 / 音声 mp3）を選ぶ
3. 保存先を選ぶ（既定はダウンロードフォルダ）
4. 「ダウンロード」

YouTube 側の仕様変更で落とせなくなったら、画面下の「yt-dlp を更新」を押してください。

## 開発

```bash
npm install
scripts/fetch-sidecars.sh   # yt-dlp / ffmpeg を src-tauri/binaries/ に取得
npm run tauri dev
```

## リリース

バージョンを `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` で上げてから、タグを push します。

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions が3プラットフォームぶんをビルドして、Releases に下書きを作ります。内容を確認して Publish してください。
