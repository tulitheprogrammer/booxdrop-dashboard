#!/bin/bash
# Build and install BooxDrop.app from source.
# Requires Xcode command line tools (swiftc).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/BooxDrop.app"
SRC="$ROOT/native/main.swift"

echo "→ compiling…"
swiftc -O -o "$ROOT/native/BooxDropBin" "$SRC"

echo "→ assembling bundle…"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/dashboard"
cp "$ROOT/native/BooxDropBin" "$APP/Contents/MacOS/BooxDrop"
chmod +x "$APP/Contents/MacOS/BooxDrop"

cp "$ROOT/dashboard/index.html" \
   "$ROOT/dashboard/app.js" \
   "$ROOT/dashboard/reader.js" \
   "$ROOT/dashboard/styles.css" \
   "$ROOT/dashboard/favicon.png" \
   "$APP/Contents/Resources/dashboard/"

mkdir -p "$APP/Contents/Resources/dashboard/vendor"
cp "$ROOT/dashboard/vendor/"*.mjs \
   "$ROOT/dashboard/vendor/"*.js \
   "$APP/Contents/Resources/dashboard/vendor/" 2>/dev/null || true

echo "→ signing (ad-hoc)…"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

echo "→ installing to /Applications…"
rm -rf "/Applications/BooxDrop.app"
cp -R "$APP" "/Applications/"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "/Applications/BooxDrop.app" 2>/dev/null || true

echo "✓ done — launch it from /Applications or with: open -a BooxDrop"
