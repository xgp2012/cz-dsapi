#!/usr/bin/env bash
# 在没有 root 的机器（例如 Android 上的 Linux 容器 / Proot）里，
# 把 Chromium 需要的 so 和字体解包到 ~/.local/chromium-deps，不需要 sudo。
#
# 用法： npm run setup:deps
#       CHROMIUM_DEPS_DIR=/somewhere npm run setup:deps
#
# 原理：apt-get download 只下载 .deb（不需要 root），dpkg-deb -x 解包到自定义前缀，
# 运行时由 src/browser/env.mjs 把目录塞进 LD_LIBRARY_PATH / FONTCONFIG_FILE。
set -euo pipefail

PREFIX="${CHROMIUM_DEPS_DIR:-$HOME/.local/chromium-deps}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "→ 安装前缀: $PREFIX"

PACKAGES=(
  libnss3 libnspr4
  libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64
  libcups2t64 libgbm1 libdrm2
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2
  libxkbcommon0 libx11-6 libxcb1 libxext6 libxi6 libxtst6
  libpango-1.0-0 libcairo2 libpixman-1-0 libxrender1
  libasound2t64
  libglib2.0-0t64 libdbus-1-3 libexpat1 libfreetype6
  libharfbuzz0b libthai0 libfribidi0 libgraphite2-3 libdatrie1 libbsd0 libmd0
  libselinux1 libsystemd0 liblz4-1 libzstd1 libcap2 liblzma5
  libfontconfig1 fontconfig-config
  fonts-dejavu-core fonts-liberation fonts-noto-color-emoji
)

# 中文字体单独装（体积大，但截图/渲染中文需要）
EXTRA_FONTS=(fonts-noto-cjk)

cd "$WORK"
echo "→ 解析依赖…"
apt-cache depends --recurse --no-recommends --no-suggests \
  --no-conflicts --no-breaks --no-replaces --no-enhances \
  "${PACKAGES[@]}" 2>/dev/null | grep '^\w' | sort -u > deps.txt

# 这些包要么不需要，要么体积太大
grep -vE '^(fonts-noto-core|fonts-urw-base35|fonts-texgyre|fonts-croscore|fonts-freefont-otf|fonts-freefont-ttf|fonts-noto-mono|gcc-[0-9]+-base)$' \
  deps.txt > list.txt || cp deps.txt list.txt

echo "→ 下载 $(wc -l < list.txt) 个依赖包…"
# 有些发行版没有 t64 后缀（非 Ubuntu 24.04+），失败就跳过
xargs -a list.txt -r apt-get download 2>/dev/null || true
for f in "${EXTRA_FONTS[@]}"; do apt-get download "$f" 2>/dev/null || true; done

mkdir -p "$PREFIX"
echo "→ 解包…"
count=0
for deb in *.deb; do
  [ -e "$deb" ] || continue
  dpkg-deb -x "$deb" "$PREFIX" && count=$((count + 1))
done

echo "→ 完成：$count 个包，占用 $(du -sh "$PREFIX" | cut -f1)"
echo "   重启服务即可生效（src/browser/env.mjs 会自动读取）"
