# Changelog

One entry per scheduled improvement run. Format: `date · run n/10 — what changed, and why`.

- **2026-11-01 · baseline** — v1.2 shipped: 4D tilt parallax, depth effect, consolidated Settings sheet, saved preferences. Repo restructured so the APK rebuilds from the repository layout (`app/src`, `app/res`, `app/keystore.jks`, `app/setup-toolchain.sh`), and `tests/regress.js` added as the standard verification pass.
- 2026-11-01 · run 1/10 — `items` is capped at 30 and dropped captures have their `blob:` object URL revoked; photos, recorded videos and native picks were never released, so a long session grew the JS heap without bound until the WebView was killed.
