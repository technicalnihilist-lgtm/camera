# Changelog

One entry per scheduled improvement run. Format: `date · run n/10 — what changed, and why`.

- **2026-11-01 · baseline** — v1.2 shipped: 4D tilt parallax, depth effect, consolidated Settings sheet, saved preferences. Repo restructured so the APK rebuilds from the repository layout (`app/src`, `app/res`, `app/keystore.jks`, `app/setup-toolchain.sh`), and `tests/regress.js` added as the standard verification pass.
- 2026-11-01 · run 1/10 — `items` is capped at 30 and dropped captures have their `blob:` object URL revoked; photos, recorded videos and native picks were never released, so a long session grew the JS heap without bound until the WebView was killed.
- 2026-11-01 · run 2/10 — `sharpScore()` now scores every burst candidate on one reused scratch canvas and one reused `Float32Array` instead of allocating a new 320-px canvas (~3 MB of RGBA) and grey buffer per frame, cutting ~15 MB of garbage per burst shot so the shutter animation and toast stay smooth on slow phones.
- 2026-11-01 · run 3/10 — `sharpen()` (Detail boost) processed the whole full-resolution frame in one synchronous loop, freezing the main thread for a few hundred ms at 12 MP right while the shutter animation and toast were running. It now works in ~1.5 M-px row bands and yields between them; output is byte-identical (verified across 4000×3000, odd, and degenerate frame sizes) and animation frames keep painting during the pass.
- 2026-11-01 · run 4/10 — `start()` now acquires the new stream before stopping the old one, so a failed camera flip or quality switch no longer leaves a black dead preview; a `NotReadableError`/`AbortError` from a still-held sensor releases the old tracks and retries once, and every exit path still stops the old tracks so no camera is left open.
