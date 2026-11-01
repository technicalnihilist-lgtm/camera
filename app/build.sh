#!/bin/bash
# Builds and signs the APK from the repository layout.
#   repo/
#     index.html                     the app
#     app/AndroidManifest.xml        manifest (versionCode/versionName live here)
#     app/src/app/liquidglass/camera/MainActivity.java
#     app/res/...                    launcher icon
#     app/keystore.jks               signing key (dev key, password: android)
#     jdk/ sdk/                      from app/setup-toolchain.sh
set -e
ulimit -v unlimited 2>/dev/null || true

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app"
BT="$ROOT/sdk/android-14"
AJ="$ROOT/sdk/android-34/android.jar"
OUT="$ROOT/out"
export PATH="$ROOT/bin:$PATH"

[ -x "$BT/aapt2" ] || { echo "run app/setup-toolchain.sh first"; exit 1; }
[ -f "$AJ" ] || { echo "run app/setup-toolchain.sh first"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/assets"
cp "$ROOT/index.html" "$OUT/assets/index.html"

echo "== compile =="
"$ROOT/jdk/bin/javac" -J-XX:-UseCompressedClassPointers -J-Xmx1200m \
  -source 8 -target 8 -bootclasspath "$AJ" -d "$OUT/classes" \
  "$APP/src/app/liquidglass/camera/MainActivity.java" 2>&1 | grep -v "bootstrap class path\|deprecat\|^Note" || true

echo "== dex =="
"$BT/d8" --lib "$AJ" --min-api 24 --output "$OUT/dex" $(find "$OUT/classes" -name '*.class') 2>&1 | tail -2

echo "== resources =="
"$BT/aapt2" compile --dir "$APP/res" -o "$OUT/res.zip" 2>&1 | tail -2

echo "== link =="
"$BT/aapt2" link -o "$OUT/base.apk" -I "$AJ" --manifest "$APP/AndroidManifest.xml" \
  -A "$OUT/assets" --min-sdk-version 24 --target-sdk-version 34 "$OUT/res.zip" 2>&1 | tail -3

echo "== package =="
mkdir -p "$OUT/stage" && cp "$OUT/dex/classes.dex" "$OUT/stage/classes.dex"
( cd "$OUT/stage" && zip -q -u ../base.apk classes.dex )

echo "== align + sign =="
KS="$APP/keystore.jks"
[ -f "$KS" ] || { echo "missing $KS"; exit 1; }
"$BT/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out "$OUT/liquid-glass-camera.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify --print-certs "$OUT/liquid-glass-camera.apk" | head -2
ls -lh "$OUT/liquid-glass-camera.apk"
echo "BUILD OK"
