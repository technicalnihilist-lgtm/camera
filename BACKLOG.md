# Improvement backlog

Rules for every scheduled run: **no UI, layout, colour, spacing, label or interaction changes.** Only correctness, performance, smoothness, memory, battery, robustness and build quality. One focused change per run, verified before it is committed.

## Open

- [ ] No `visibilitychange` handling: the parallax rAF and the recording canvas loop keep running when the page is hidden. Pause both.
- [ ] Viewer: drop the poster data URI once the video has loaded (the pause/release half is done).
- [ ] Native save base64-encodes 3 MB chunks on the JS thread. Smaller chunks plus a yield keeps big video saves responsive.
- [ ] `countdown()` can leave a pending `sleep` after cancel — make sure no capture fires after the timer is cancelled.
- [ ] `applyZoom()` re-reads `getCapabilities()` on every call. Cache per track.
- [ ] `renderThumb()` rewrites the whole thumb `innerHTML` each capture; swap only the changed child.
- [ ] Depth pass clears and re-configures the scratch canvas every frame; keep the surface warm and skip entirely when strength is 0.
- [ ] Add `tests/regress.js` to CI-style runs so every change is checked the same way (no console errors, capture size, video, settings, 4D, depth).
- [ ] Verify `localStorage` failures (private mode, quota, file://) are swallowed everywhere and the app still boots with defaults.
- [ ] Cold start: the 60 px → 0 border-radius transition runs before the first frame on slow devices; check whether it delays first paint.
- [ ] Long-press or double-tap on the shutter can queue captures; keep the `busy` guard airtight across all entry points (shutter, timer, native picker).
- [ ] Audio context: `plop()` creates an AudioContext lazily but never closes it; check the suspended-context path on repeated resumes.
- [ ] Check every `getAnimations()` call is guarded for browsers without WAAPI (old WebView).

## Done
- [x] `spr()` rebuilt the 45-point spring curve (45 exp/cos/sin) and a fresh array of 45 keyframe objects with two template strings each on every call — ~0.38 ms of main-thread work and ~90 string allocations per bounce, on the tap that was supposed to start the animation, for endpoint pairs the app replays constantly (every control tap, every toast, every capture). The curve is now sampled once per bounce value and each keyframe set is built once and shared with `el.animate()` (which copies it); the cache is dropped when the bounce slider changes. Keyframes are byte-identical, verified against the old generator across 272 parameter/bounce combinations. *(done 2026-11-02)*
- [x] `MediaRecorder.stop()` only marks the recorder inactive and posts the stop task, so a WebView that swallows the event left `rec` non-null for the rest of the session: the shutter believed a take was still running, `#app` kept its `rec` state, the capture pipe's canvas loop kept drawing every frame and the mic stayed open. Finalising is now a single idempotent `finishRec(rr)` reached from `onstop`, from a throwing `stop()`, or from a 2 s watchdog armed in `stopRec()` — whichever lands first, and only once. *(done 2026-11-02)*
- [x] The stage box was measured with `getBoundingClientRect()` on every pointermove (parallax) and on every drawn recording frame (`cropRect()` → `viewAspect()`), and both reads landed right after the parallax loop had written `style.translate` — so each one forced a full synchronous layout, ~120 flushes a second while a finger drags a settings slider and ~30 a second while recording. `#stage` is `inset:0` in a fixed-size `#app`, so its box is now measured once into `stageBox()` and reused; `resize` drops the cache. Framing maths and the recorded crop are unchanged. *(done 2026-11-02)*
- [x] The poster for a recorded clip was encoded straight off the recording canvas (up to 3840×2160): tapping stop forced a synchronous readback + JPEG encode of ~8 Mpx on the main thread (575 ms measured at 4K) and kept a 236 KB base64 string alive for every clip. It is now downscaled into one reused scratch surface (long edge 1080) before encoding — 221 ms and 55 KB, same picture at thumb and phone size. *(done 2026-11-01)*
- [x] `makePipe()` drew at rAF speed (up to 60 fps) while the recorder only asks `captureStream()` for 30 — the canvas loop now skips any frame that arrives before the next 1/30 s slot is due, so crop + depth work is done at most 30 times a second instead of 60. *(done 2026-11-01)*
- [x] `start()` stopped the live stream *before* asking for the new one, so a refused or failed camera flip / quality switch left a black, dead preview behind the gate. It now asks first and releases the old tracks only once the new stream is attached, retrying once after releasing them when the device reports the sensor busy (`NotReadableError`/`AbortError`); every exit path still releases the old tracks, so no camera is left open. *(done 2026-11-01)*
- [x] Capture blocks the main thread: burst frames, sharpness scoring, sharpen and the depth pass all run synchronously. Burst frames already awaited a frame callback and the depth pass works on a fifth-size scratch surface, but `sharpen()` walked every pixel of the full frame in one go. It now processes row bands of ~1.5 M px and yields between them, so the shutter animation and toast keep painting on slow phones. *(done 2026-11-01)*
- [x] `sharpScore()` allocated a fresh 320 px canvas and grey buffer for every burst candidate (~3 MB of RGBA each). One scratch surface and one `Float32Array` are now reused across frames. *(done 2026-11-01)*
- [x] Blob object URLs from `URL.createObjectURL` are never revoked. Revoke on drop and cap `items` (~30) so a long session cannot exhaust memory. *(done 2026-11-01)*
- [x] The viewer replaced `#vm`'s markup on every prev/next tap while the outgoing `<video>` was still playing, so the detached element kept its blob source and decoder buffers alive until GC and nothing guaranteed it stayed paused outside Blink. `renderView()` now pauses it and releases the source (`stopViewMedia()`) before the swap, freeing the decoder on the spot; measured: outgoing video goes from playing-with-`src` to paused-with-no-`src` on the first prev tap. *(done 2026-11-02)*
