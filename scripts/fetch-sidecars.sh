#!/usr/bin/env bash
# 同梱する yt-dlp / ffmpeg を GitHub Releases から取得して src-tauri/binaries/ に置く。
# 使い方: scripts/fetch-sidecars.sh [target-triple]   （省略時はこのマシンの triple）
set -euo pipefail

TARGET="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
YTDLP_VERSION="${YTDLP_VERSION:-latest}"   # 例: 2026.08.19（latest なら最新）
FFMPEG_TAG="${FFMPEG_TAG:-b6.1.1}"          # eugeneware/ffmpeg-static のタグ
DIR="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/binaries"

case "$TARGET" in
  aarch64-apple-darwin)   YT=yt-dlp_macos; FF=ffmpeg-darwin-arm64; EXT="" ;;
  x86_64-apple-darwin)    YT=yt-dlp_macos; FF=ffmpeg-darwin-x64;   EXT="" ;;
  x86_64-pc-windows-msvc) YT=yt-dlp.exe;   FF=ffmpeg-win32-x64;    EXT=".exe" ;;
  *) echo "unsupported target: $TARGET" >&2; exit 1 ;;
esac

if [ "$YTDLP_VERSION" = latest ]; then
  YT_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YT"
else
  YT_URL="https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/$YT"
fi
FF_URL="https://github.com/eugeneware/ffmpeg-static/releases/download/$FFMPEG_TAG/$FF"

mkdir -p "$DIR"
echo "yt-dlp  <- $YT_URL"
curl -fL --retry 3 -o "$DIR/yt-dlp-$TARGET$EXT" "$YT_URL"
echo "ffmpeg  <- $FF_URL"
curl -fL --retry 3 -o "$DIR/ffmpeg-$TARGET$EXT" "$FF_URL"
chmod +x "$DIR"/*
ls -la "$DIR"
