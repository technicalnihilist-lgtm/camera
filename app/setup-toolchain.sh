#!/bin/bash
# Downloads a portable JDK + Android build-tools + platform so the APK can be
# rebuilt from a clean sandbox. Idempotent: does nothing if already present.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -x jdk/bin/java ] && [ -x sdk/android-14/aapt2 ] && [ -f sdk/android-34/android.jar ]; then
  echo "toolchain already present in $ROOT"
  exit 0
fi

echo "downloading JDK 17…"
curl -sL --max-time 280 "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse" -o jdk.tar.gz
mkdir -p jdk && tar -xzf jdk.tar.gz -C jdk --strip-components=1

echo "downloading build-tools 34 and platform 34…"
curl -sL --max-time 250 https://dl.google.com/android/repository/build-tools_r34-linux.zip -o bt.zip
curl -sL --max-time 250 https://dl.google.com/android/repository/platform-34-ext7_r03.zip -o plat.zip
mkdir -p sdk && unzip -q -o bt.zip -d sdk && unzip -q -o plat.zip -d sdk

# the pod caps virtual memory at 1.5 GB, which the JVM dislikes by default
printf '#!/bin/sh\nexec %s/jdk/bin/java -XX:-UseCompressedClassPointers -Xmx512m -XX:MaxMetaspaceSize=192m -Xss1m "$@"\n' "$ROOT" > jrun
chmod +x jrun
mkdir -p bin && ln -sf "$ROOT/jrun" bin/java

echo "toolchain ready"
