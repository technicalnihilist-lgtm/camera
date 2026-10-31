#!/bin/bash
set -e
ulimit -v unlimited 2>/dev/null || true
cd /scratch/work
export PATH=/scratch/work/bin:$PATH
BT=/scratch/work/sdk/android-14
AJ=/scratch/work/sdk/android-34/android.jar
JAVA_OPTS="-XX:-UseCompressedClassPointers -Xmx1500m"

echo "== 1. compile java =="
rm -rf out && mkdir -p out/classes out/dex out/res
/scratch/work/jdk/bin/javac -J-XX:-UseCompressedClassPointers -J-Xmx1500m -source 8 -target 8 -bootclasspath $AJ \
  -d out/classes apk/src/app/liquidglass/camera/MainActivity.java 2>&1 | grep -v "bootstrap class path\|deprecat\|^Note" || true
find out/classes -name '*.class' | head

echo "== 2. dex =="
$BT/d8 --lib $AJ --min-api 24 --output out/dex $(find out/classes -name '*.class') 2>&1 | tail -3
ls -lh out/dex

echo "== 3. resources =="
$BT/aapt2 compile --dir apk/res -o out/res.zip 2>&1 | tail -3

echo "== 4. link =="
$BT/aapt2 link -o out/base.apk -I $AJ --manifest apk/AndroidManifest.xml \
  -A apk/assets --min-sdk-version 24 --target-sdk-version 34 \
  --version-code 2 --version-name 1.1 out/res.zip 2>&1 | tail -5
ls -lh out/base.apk

echo "== 5. add dex =="
cd out && mkdir -p stage && cp dex/classes.dex stage/classes.dex
cd stage && zip -q -u ../base.apk classes.dex
cd /scratch/work

echo "== 6. align + sign =="
if [ ! -f keystore.jks ]; then
  /scratch/work/jdk/bin/keytool -genkeypair -keystore keystore.jks -alias camera \
    -keyalg RSA -keysize 2048 -validity 10000 -storepass android -keypass android \
    -dname "CN=Liquid Glass Camera, OU=App, O=LiquidGlass, L=India, C=IN" 2>&1 | tail -2
fi
$BT/zipalign -f -p 4 out/base.apk out/aligned.apk
$BT/apksigner sign --ks keystore.jks --ks-pass pass:android --key-pass pass:android \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out out/liquid-glass-camera.apk out/aligned.apk
$BT/apksigner verify --print-certs out/liquid-glass-camera.apk | head -5
ls -lh out/liquid-glass-camera.apk
echo "BUILD OK"
