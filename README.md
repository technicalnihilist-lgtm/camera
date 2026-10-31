# Liquid Glass Camera

A camera app with a liquid-glass interface — real glass panels, spring-driven motion, a 4D tilt parallax and a depth-of-field effect — shipped two ways from the same code: a **signed Android APK** and a **single-file web app**.

<p align="center">
  <img src="screenshots/main.jpg" width="215" alt="Camera view with depth effect">
  <img src="screenshots/engine.jpg" width="215" alt="Capture engine settings">
  <img src="screenshots/motion.jpg" width="215" alt="Glass and motion settings">
  <img src="screenshots/viewer.jpg" width="215" alt="Photo viewer">
</p>

## Download

**[⬇ Download the APK](../../releases/latest)** — `liquid-glass-camera.apk` (Android 7.0+, ~41 KB)

The web version is the same app in one file: open [`index.html`](index.html) in Chrome or Safari. It needs a secure origin (https, localhost, or the file opened directly) before the browser will give it a camera.

## What it does

- **Photo, Video, Square** modes, with a spring-animated mode indicator
- **4D tilt parallax** — every glass layer sits at its own depth and drifts against the preview as you tilt the phone, with the specular highlight sweeping across the glass as it moves
- **Depth effect** — background softening that applies to the live preview, the saved photo *and* the recorded video, with a strength slider
- **1× / 2× / 3× zoom** — hardware zoom where the camera exposes it, digital zoom otherwise
- **Best-shot burst** — takes several frames and keeps the sharpest one
- **Detail boost** — a small unsharp pass on the captured frame
- **Tap to focus & expose** — sends a focus point of interest to the camera where supported
- **Quality presets** — Max / High / Standard control the requested stream size, JPEG quality and video bitrate
- **Grid, 3s / 10s timer, torch**, front/back flip
- **Video recording** with audio, plus a live recording timer
- **Viewer** with previous/next, and **Save** to the gallery

The important detail: **what you see is what you get**. The preview is a centre crop of the camera frame, and every capture (photo *and* video) is cropped through the same maths, so the saved file matches the framing on screen — including zoom, the selfie mirror and the depth falloff.

## How the two effects work

**4D parallax.** Each chrome layer — top bar, zoom pill, mode switcher, controls, toast — carries a depth value from 18 down to 9, and the preview itself carries −7 so it drifts the other way. Motion comes from `deviceorientation` (the phone's gyro, with the tilt baseline taken from the first reading so a held phone sits neutral) and falls back to pointer movement on desktop. Values are smoothed with a frame-rate-independent lerp, so it settles rather than jitters, and the render loop stops when the movement stops. On iOS the orientation permission is requested on the first tap. With `prefers-reduced-motion` the effect starts off.

**Depth of field.** A capture is composited against a blurred copy of itself: the frame is downscaled to a fifth, blurred, masked with a feathered radial gradient that keeps the middle sharp and fades to full blur at the edges, then drawn back over the original. The preview shows the same falloff live through a masked `backdrop-filter`, so you see the look before you shoot. Video runs the same pass inside the recording canvas, which is why the saved clip matches the preview.

It is a **centre-weighted** depth effect, not subject detection — there is no ML segmentation in this build, so a subject that is not near the middle will get softened along with the background. Turn it off, or drop the strength, when that matters.

## How the APK works

There is no React Native or Flutter here, and no web-to-app build service. The APK is a small Android wrapper around the same HTML file:

| File | Role |
| --- | --- |
| `app/MainActivity.java` | WebView host, camera/mic permission bridge, gallery save, file picker |
| `app/AndroidManifest.xml` | Manifest: camera + mic permissions, portrait, fullscreen |
| `app/build.sh` | The whole build: javac → d8 → aapt2 → zipalign → apksigner |
| `index.html` | The app itself, inlined into the APK as `assets/index.html` |

Two details make it work rather than being a broken WebView shell:

1. **The page is served from `http://127.0.0.1`** by a ~120-line socket server inside the app, not loaded from `file://`. Loopback counts as a secure origin, so `getUserMedia` and `MediaRecorder` are allowed. A `file://` page would be refused the camera by Chromium.
2. **Saving is native.** WebView ignores `<a download>` for `blob:` URLs, so the page hands the bytes to the app in 3 MB chunks over a `@JavascriptInterface` bridge, and the app writes them into `Pictures/Liquid Glass Camera` or `Movies/Liquid Glass Camera` through MediaStore.

Permissions requested at runtime: **Camera** (always), **Microphone** (only when you record video with sound).

## Build it yourself

You need a JDK and Android SDK build-tools 34 + platform 34. No Gradle required.

```bash
# layout expected by build.sh
#   jdk/                 portable JDK 17
#   sdk/android-14/      build-tools 34.0.0
#   sdk/android-34/android.jar
#   apk/src, apk/res, apk/assets/index.html, apk/AndroidManifest.xml

bash app/build.sh     # → out/liquid-glass-camera.apk
```

The output is signed with the debug-style key in the script; swap in your own keystore before publishing anywhere real.

## Notes

- Photo capture runs a burst on the main thread, so a shot takes a moment on slower phones — that is the burst, detail-boost and depth work, not a freeze.
- Video is recorded through a canvas pipeline, which is what bakes zoom, framing and depth into the file. Where the platform can't do MP4 it falls back to WebM.
- The APK is signed with a self-signed key, so Play Protect will ask before installing from a browser download — that is expected for sideloaded builds.
