# Improvement backlog

Rules for every scheduled run: **no UI, layout, colour, spacing, label or interaction changes.** Only correctness, performance, smoothness, memory, battery, robustness and build quality. One focused change per run, verified before it is committed.

## Open

- [ ] `spr()` rebuilds a 45-step keyframe array on every call. Cache the sampled curve per bounce value.
- [ ] No `visibilitychange` handling: the parallax rAF and the recording canvas loop keep running when the page is hidden. Pause both.
- [ ] Viewer: pause the outgoing `<video>` before `innerHTML` is replaced, and drop the poster data URI once the video has loaded.
- [ ] Native save base64-encodes 3 MB chunks on the JS thread. Smaller chunks plus a yield keeps big video saves responsive.
- [ ] `countdown()` can leave a pending `sleep` after cancel — make sure no capture fires after the timer is cancelled.
- [ ] `applyZoom()` re-reads `getCapabilities()` on every call. Cache per track.
- [ ] `MediaRecorder` stop race can leave `rec` non-null if `onstop` never fires. Add a watchdog timer.
- [ ] `renderThumb()` rewrites the whole thumb `innerHTML` each capture; swap only the changed child.
- [ ] Depth pass clears and re-configures the scratch canvas every frame; keep the surface warm and skip entirely when strength is 0.
- [ ] Add `tests/regress.js` to CI-style runs so every change is checked the same way (no console errors, capture size, video, settings, 4D, depth).
- [ ] Verify `localStorage` failures (private mode, quota, file://) are swallowed everywhere and the app still boots with defaults.
- [ ] Cold start: the 60 px → 0 border-radius transition runs before the first frame on slow devices; check whether it delays first paint.
- [ ] Long-press or double-tap on the shutter can queue captures; keep the `busy` guard airtight across all entry points (shutter, timer, native picker).
- [ ] Audio context: `plop()` creates an AudioContext lazily but never closes it; check the suspended-context path on repeated resumes.
- [ ] Check every `getAnimations()` call is guarded for browsers without WAAPI (old WebView).

## Done
- [x] `makePipe()` drew at rAF speed (up to 60 fps) while the recorder only asks `captureStream()` for 30 — the canvas loop now skips any frame that arrives before the next 1/30 s slot is due, so crop + depth work is done at most 30 times a second instead of 60. *(done 2026-11-01)*
- [x] `start()` stopped the live stream *before* asking for the new one, so a refused or failed camera flip / quality switch left a black, dead preview behind the gate. It now asks first and releases the old tracks only once the new stream is attached, retrying once after releasing them when the device reports the sensor busy (`NotReadableError`/`AbortError`); every exit path still releases the old tracks, so no camera is left open. *(done 2026-11-01)*
- [x] Capture blocks the main thread: burst frames, sharpness scoring, sharpen and the depth pass all run synchronously. Burst frames already awaited a frame callback and the depth pass works on a fifth-size scratch surface, but `sharpen()` walked every pixel of the full frame in one go. It now processes row bands of ~1.5 M px and yields between them, so the shutter animation and toast keep painting on slow phones. *(done 2026-11-01)*
- [x] `sharpScore()` allocated a fresh 320 px canvas and grey buffer for every burst candidate (~3 MB of RGBA each). One scratch surface and one `Float32Array` are now reused across frames. *(done 2026-11-01)*
- [x] Blob object URLs from `URL.createObjectURL` are never revoked. Revoke on drop and cap `items` (~30) so a long session cannot exhaust memory. *(done 2026-11-01)*
