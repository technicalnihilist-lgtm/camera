#!/usr/bin/env node
/*
 * Regression check for Liquid Glass Camera.
 *
 *   node tests/regress.js [path-to-index.html]
 *
 * Drives the real page in headless Chromium with a fake camera and asserts the
 * behaviour that must not break. Exits 1 on any failure. Safe to run in the
 * sandbox: needs only node + puppeteer-core + /usr/local/bin/chromium.
 */
const path = require('path');
function loadPuppeteer() {
  const tries = ['puppeteer-core', '/usr/lib/node_modules/puppeteer-core',
    '/usr/local/lib/node_modules/puppeteer-core',
    (process.env.HOME || '') + '/.npm-global/lib/node_modules/puppeteer-core'];
  for (const t of tries) { try { return require(t); } catch (e) {} }
  throw new Error('puppeteer-core not installed');
}
const puppeteer = loadPuppeteer();

const TARGET = process.argv[2] || path.join(__dirname, '..', 'index.html');
const URL = 'file://' + path.resolve(TARGET);
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/chromium';
const wait = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '  ' + detail : ''));
  if (!ok) failures++;
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    protocolTimeout: 240000,
    args: ['--no-sandbox', '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 840 });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });
  await page.evaluateOnNewDocument(() => {
    addEventListener('unhandledrejection', e =>
      console.error('unhandledrejection: ' + ((e.reason && e.reason.message) || e.reason)));
  });

  await page.goto(URL, { waitUntil: 'load' });
  await wait(2500);

  const state = () => page.evaluate(() => {
    const q = s => document.querySelector(s);
    return {
      gate: q('#gate').hidden,
      vw: q('#v').videoWidth,
      vh: q('#v').videoHeight,
      thumb: !!q('#thumb img'),
      sheetHidden: q('#sheet').hidden,
      hasSections: [...document.querySelectorAll('#sheet .sec')].map(e => e.textContent.trim()),
      depth: q('#app').classList.contains('depth'),
      par: q('#app').classList.contains('par'),
      hasDepthCtl: !!(q('#sheet #eDepth') && q('#sheet #rD') && q('#sheet #rP')),
      depthInEngine: !!q('#eng #eDepth'),
    };
  });

  const s0 = await state();
  check('camera starts', s0.gate === true && s0.vw > 0, s0.vw + 'x' + s0.vh);
  check('settings sheet closed at boot', s0.sheetHidden === true);
  check('depth + 4D on by default', s0.depth && s0.par);
  check('depth controls live in settings', s0.hasDepthCtl === true);
  check('capture engine has no depth controls', s0.depthInEngine === false);

  // use the small stream so the suite stays quick on a 2-core pod
  await page.click('#bE'); await wait(900);
  await page.click('#qseg button[data-q="std"]'); await wait(2200);
  await page.click('#edone'); await wait(1400);

  // photo capture, framing must match the preview aspect
  await page.click('#shut');
  for (let i = 0; i < 40 && !(await page.evaluate(() => !!document.querySelector('#thumb img'))); i++) await wait(500);
  const shot = await page.evaluate(() => new Promise(res => {
    const img = document.querySelector('#thumb img');
    if (!img) return res(null);
    const done = () => {
      const st = document.querySelector('#stage').getBoundingClientRect();
      res({ w: img.naturalWidth, h: img.naturalHeight, aspect: st.width / st.height });
    };
    img.complete ? done() : (img.onload = done, setTimeout(() => res(null), 4000));
  }));
  check('photo captured', !!shot, shot ? shot.w + 'x' + shot.h : 'no image');
  if (shot) {
    const got = shot.w / shot.h;
    check('photo framing matches preview', Math.abs(got - shot.aspect) < 0.03,
      'got ' + got.toFixed(3) + ' want ' + shot.aspect.toFixed(3));
  }

  // Detail boost runs in place over row bands now: it must still produce
  // exactly the bytes the reference convolution does, borders included
  const sharp = await page.evaluate(async () => {
    const w = 97, h = 61, k = 0.4;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    const im = x.createImageData(w, h), d = im.data;
    let s = 7;
    for (let i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = (s >>> 16) & 255; }
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    x.putImageData(im, 0, 0);
    // read back first: the reference must start from the bytes the canvas holds
    const src = new Uint8ClampedArray(x.getImageData(0, 0, w, h).data), ref = new Uint8ClampedArray(src);
    const cn = 1 + 4 * k, st = w * 4;
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
      const p = (j * w + i) * 4;
      for (let q = p; q < p + 3; q++) ref[q] = cn * src[q] - k * (src[q - 4] + src[q + 4] + src[q - st] + src[q + st]);
    }
    await sharpen(c, k);
    const got = x.getImageData(0, 0, w, h).data;
    let diff = 0;
    for (let i = 0; i < ref.length; i++) if (ref[i] !== got[i]) diff++;
    return { diff, n: ref.length };
  });
  check('detail boost is byte-identical to the reference', sharp.diff === 0,
    sharp.diff + ' of ' + sharp.n + ' bytes differ');

  // settings sheet
  await page.click('#bS');
  await wait(900);
  const s1 = await state();
  check('settings sheet opens', s1.sheetHidden === false);
  check('settings has both sections',
    s1.hasSections.length === 2 && /glass/i.test(s1.hasSections[0]) && /4d/i.test(s1.hasSections[1]),
    JSON.stringify(s1.hasSections));

  // 4D parallax responds to pointer movement
  await page.mouse.move(60, 300); await wait(80); await page.mouse.move(340, 700);
  await wait(500);
  const parMove = await page.evaluate(() => document.querySelector('.top').style.translate || '');
  check('4D parallax moves layers', /\d/.test(parMove) && parMove !== '0px 0px', parMove);

  // toggles
  await page.click('#eDepth'); await wait(250);
  const off = await state();
  check('depth toggle turns effect off', off.depth === false);
  await page.click('#eDepth'); await wait(250);
  const on = await state();
  check('depth toggle turns effect back on', on.depth === true);

  await page.click('#sdone'); await wait(1400);
  const closed = await state();
  check('settings sheet closes', closed.sheetHidden === true);

  // video recording
  await page.click('.modes button[data-m="video"]'); await wait(400);
  await page.click('#shut'); await wait(2500);
  const rec = await page.evaluate(() => document.querySelector('#app').classList.contains('rec'));
  check('recording starts', rec === true);
  await page.click('#shut'); await wait(2200);
  // the poster is only a placeholder until the clip's first frame decodes, so
  // note how big it is before the viewer can show that frame
  const posterLen = await page.evaluate(() => ((items[items.length - 1] || {}).p || '').length);
  await page.click('#thumb'); await wait(1000);
  const vid = await page.evaluate(() => new Promise(res => {
    const v = document.querySelector('#vm video');
    if (!v) return res(null);
    const done = () => res({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
    v.readyState >= 1 ? done() : (v.onloadedmetadata = done, setTimeout(() => res(null), 3000));
  }));
  check('video recorded and playable', !!vid && vid.w > 0 && vid.d > 0,
    vid ? vid.w + 'x' + vid.h + ' ' + vid.d.toFixed(1) + 's' : 'no video');

  // the poster data URI is a placeholder, not part of the clip: once the first
  // frame is on screen it must be released instead of being kept for the life
  // of the item (and past its eviction)
  const posterDrop = await page.evaluate(async () => {
    const w = ms => new Promise(k => setTimeout(k, ms));
    const it = items[vi], v = document.querySelector('#vm video');
    for (let i = 0; i < 40 && v && v.readyState < 2; i++) await w(100);
    await w(200);
    return { after: (it.p || '').length, attr: v ? v.hasAttribute('poster') : null,
      ready: v ? v.readyState : -1, src: v ? v.currentSrc !== '' : false,
      w: v ? v.videoWidth : 0 };
  });
  check('the poster data URI is released once the clip has loaded',
    posterLen > 1000 && posterDrop.after === 0 && posterDrop.attr === false &&
    posterDrop.ready >= 2 && posterDrop.src && posterDrop.w > 0,
    'poster ' + posterLen + ' chars -> ' + posterDrop.after + ', attribute ' +
    (posterDrop.attr ? 'kept' : 'removed') + ', readyState ' + posterDrop.ready +
    ', ' + posterDrop.w + 'px frame');

  // closing the viewer must release the clip, not leave the detached <video>
  // holding its blob source and decoder until GC
  const closedView = await page.evaluate(async () => {
    const v = document.querySelector('#vm video');
    window.__ov = v;
    document.querySelector('#vc').click();
    await new Promise(k => setTimeout(k, 1800));   // let the sheet animate out
    const o = window.__ov;
    return {
      vmEmpty: document.querySelector('#vm').innerHTML === '',
      hidden: document.querySelector('#view').hidden,
      paused: o ? o.paused : null,
      src: o ? (o.getAttribute('src') || '') : 'released',
    };
  });
  check('closing the viewer releases the clip',
    closedView.vmEmpty && closedView.hidden && closedView.paused === true && closedView.src === '',
    'src ' + (closedView.src ? 'kept' : 'released') + ', paused ' + closedView.paused);

  // native save through the Android bridge (only wired when window.AndroidCam exists)
  const p2 = await browser.newPage();
  await p2.setViewport({ width: 400, height: 840 });
  p2.on('pageerror', e => errors.push('pageerror(native): ' + e.message));
  p2.on('console', m => { if (m.type() === 'error') errors.push('console(native): ' + m.text().slice(0, 160)); });
  await p2.evaluateOnNewDocument(() => {
    const acc = [];
    window.__br = { calls: 0, maxB64: 0, bytes: 0, mime: '', aborted: false };
    window.AndroidCam = {
      open(mime) { window.__br.mime = mime; return 1; },
      write(id, b64) {
        // stand in for the Java-side Base64.decode + FileOutputStream.write: an
        // @JavascriptInterface call does not return until that work is done, so
        // the JS thread is blocked for the whole round trip
        const end = performance.now() + b64.length * 3 / 1e6;
        while (performance.now() < end) { /* block */ }
        window.__br.calls++;
        if (b64.length > window.__br.maxB64) window.__br.maxB64 = b64.length;
        const s = atob(b64), u = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
        acc.push(u); window.__br.bytes += u.length;
        return 'ok';
      },
      close() { window.__br.acc = acc; return 'ok ' + window.__br.bytes; },
      abort() { window.__br.aborted = true; },
    };
    window.__saved = () => {
      const out = new Uint8Array(window.__br.bytes);
      let o = 0;
      for (const u of window.__br.acc) { out.set(u, o); o += u.length; }
      return out;
    };
  });
  await p2.goto(URL, { waitUntil: 'load' });
  await wait(2500);
  // a clip of known size: 8 MB goes through the bridge in many slices however the
  // chunk size is set, and the bytes are known, so the loop is checked end to end
  const CLIP = 8 * 1024 * 1024;
  await p2.evaluate(n => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i += 997) b[i] = (i * 31) & 255;
    items.push({ t: 'v', u: URL.createObjectURL(new Blob([b], { type: 'video/webm' })), x: 'webm', p: '' });
    vi = items.length - 1;
    window.__st = { max: 0, last: 0, on: true };
    const tick = () => {
      const t = performance.now();
      if (window.__st.last) window.__st.max = Math.max(window.__st.max, t - window.__st.last);
      window.__st.last = t;
      if (window.__st.on) setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
    document.querySelector('#vs').click();
  }, CLIP);
  let toastTxt = '';
  for (let i = 0; i < 80; i++) {
    await wait(250);
    toastTxt = await p2.evaluate(() => document.querySelector('#toast').textContent);
    if (/Saved to your Gallery|Could not save/.test(toastTxt)) break;
  }
  const save = await p2.evaluate(async () => {
    window.__st.on = false;
    const it = items[items.length - 1];
    const src = new Uint8Array(await (await fetch(it.u)).arrayBuffer());
    const got = window.__saved();
    let same = src.length === got.length;
    if (same) for (let i = 0; i < src.length; i++) if (src[i] !== got[i]) { same = false; break; }
    return { toast: document.querySelector('#toast').textContent, src: src.length, got: got.length,
      same, calls: window.__br.calls, maxB64: window.__br.maxB64,
      stall: +window.__st.max.toFixed(1), aborted: window.__br.aborted };
  });
  check('native save writes the clip byte for byte',
    save.same && save.src === save.got && save.src > 0 && !save.aborted,
    save.src + ' bytes in ' + save.calls + ' calls');
  check('native save hands the bridge small slices', save.maxB64 <= 768 * 1024,
    'largest ' + (save.maxB64 / 1024).toFixed(0) + ' KB base64, longest stall ' + save.stall + ' ms');

  // timer: a cancel must stop the countdown at once, and never capture
  const p3 = await browser.newPage();
  await p3.setViewport({ width: 400, height: 840 });
  p3.on('pageerror', e => errors.push('pageerror(timer): ' + e.message));
  p3.on('console', m => { if (m.type() === 'error') errors.push('console(timer): ' + m.text().slice(0, 160)); });
  await p3.goto(URL, { waitUntil: 'load' });
  await wait(2500);
  const cdCancel = await p3.evaluate(async () => {
    const shut = document.querySelector('#shut'), cd = document.querySelector('#cd');
    S.tm = 10;
    const n0 = items.length;
    shut.click();                                  // countdown starts
    await new Promise(k => setTimeout(k, 1200));
    const shown = cd.textContent;
    shut.click();                                  // cancel
    await new Promise(k => requestAnimationFrame(() => k()));
    const busyAfter = busy, textAfter = cd.textContent;
    await new Promise(k => setTimeout(k, 1200));   // the tick it used to wait out
    const blocked = (() => {
      document.querySelector('#flip').click();
      return /Wait for the timer/.test(document.querySelector('#toast').textContent);
    })();
    return { shown, busyAfter, textAfter, captured: items.length > n0, blocked };
  });
  check('cancelling the timer unlocks the shutter at once',
    cdCancel.busyAfter === false && cdCancel.textAfter === '' && cdCancel.shown !== '',
    'overlay "' + cdCancel.shown + '" -> "' + cdCancel.textAfter + '", busy ' + cdCancel.busyAfter);
  check('a cancelled timer never captures', cdCancel.captured === false && cdCancel.blocked === false);
  const cdFire = await p3.evaluate(async () => {
    const w = ms => new Promise(k => setTimeout(k, ms));
    // the cancel test above flipped the camera, so the preview is re-acquiring
    // the sensor; a shutter tapped into that gap returns 'Camera is not ready'
    // and never retries. Wait for a live frame first, and allow for a slow
    // burst + sharpen + encode on a loaded pod rather than a fixed 10 s.
    for (let i = 0; i < 40 && !document.querySelector('#v').videoWidth; i++) await w(250);
    const n0 = items.length;
    S.tm = 1;
    document.querySelector('#shut').click();
    for (let i = 0; i < 120 && items.length === n0; i++) await w(500);
    S.tm = 0;
    return items.length > n0;
  });
  check('an uncancelled timer still captures', cdFire === true);

  // release the other pages first: the fake camera serves one stream at a time
  // and a page that cannot get one would fail this check for the wrong reason
  await page.close(); await p2.close(); await p3.close();

  // an older WebView has el.animate() (Chrome 36) but no Element.getAnimations()
  // (Chrome 84); every cancel site used to reach for it unguarded and moveInd
  // runs during boot, so the throw left the app on a dead gate with no camera
  const p4 = await browser.newPage();
  await p4.setViewport({ width: 400, height: 840 });
  const oldErrors = [];
  p4.on('pageerror', e => oldErrors.push(e.message));
  p4.on('console', m => { if (m.type() === 'error') oldErrors.push(m.text().slice(0, 160)); });
  await p4.evaluateOnNewDocument(() => {
    delete Element.prototype.getAnimations;
    delete Document.prototype.getAnimations;
  });
  await p4.goto(URL, { waitUntil: 'load' });
  await wait(2500);
  const noWaapi = await p4.evaluate(async () => {
    const q = s => document.querySelector(s);
    const out = { has: typeof Element.prototype.getAnimations, gate: q('#gate').hidden,
      vw: q('#v').videoWidth, toast: '', err: '' };
    // a toast must still render without the cancel path throwing
    try {
      toast('probe');
      await new Promise(k => setTimeout(k, 120));
      out.toast = q('#toast').textContent;
      // the shutter cancels the flash ring before it reads a frame, so this is
      // the path that used to make capture impossible without getAnimations()
      const n0 = items.length;
      q('#shut').click();
      for (let i = 0; i < 40 && items.length === n0; i++) await new Promise(k => setTimeout(k, 500));
      out.shot = items.length > n0;
    } catch (e) { out.err = String((e && e.message) || e); }
    return out;
  });
  check('boots without Element.getAnimations',
    noWaapi.has === 'undefined' && !noWaapi.err && noWaapi.gate === true && noWaapi.vw > 0 &&
    noWaapi.toast !== '' && noWaapi.shot === true,
    'getAnimations ' + noWaapi.has + ', preview ' + noWaapi.vw + ', toast "' + noWaapi.toast + '"' +
    ', shot ' + noWaapi.shot + (noWaapi.err ? ', threw ' + noWaapi.err : ''));
  check('no errors without Element.getAnimations', oldErrors.length === 0, oldErrors.slice(0, 2).join(' | '));

  // the water sound's AudioContext used to be created on the first tap and left
  // running for the rest of the session, holding the audio output stream (and the
  // device's audio hardware) awake for silence. It must sleep once its sound is
  // over, wake for the next tap, and let go as soon as the page is hidden.
  await p4.close();
  const p5 = await browser.newPage();
  await p5.setViewport({ width: 400, height: 840 });
  const audioErrors = [];
  p5.on('pageerror', e => audioErrors.push('pageerror(audio): ' + e.message));
  p5.on('console', m => { if (m.type() === 'error') audioErrors.push('console(audio): ' + m.text().slice(0, 160)); });
  await p5.evaluateOnNewDocument(() => {
    window.__osc = 0;
    const P = (window.AudioContext || window.webkitAudioContext).prototype;
    const co = P.createOscillator;
    P.createOscillator = function () { window.__osc++; return co.apply(this, arguments); };
  });
  await p5.goto(URL, { waitUntil: 'load' });
  await wait(2500);
  const acState = () => p5.evaluate(() => ({
    state: typeof AC === 'undefined' || !AC ? 'none' : AC.state,
    clock: typeof AC === 'undefined' || !AC ? 0 : AC.currentTime,
    osc: window.__osc,
  }));
  await p5.evaluate(() => { S.snd = true; });
  await p5.click('#bG');
  await wait(250);
  const acOn = await acState();
  await wait(1800);
  const acIdleState = await acState();
  await wait(300);
  const acFrozen = await acState();
  await p5.click('#bG');
  await wait(250);
  const acWoken = await acState();
  await wait(300);
  const acClock = await acState();
  const acHidden = await p5.evaluate(async () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
    await new Promise(k => setTimeout(k, 250));
    return AC ? AC.state : 'none';
  });
  check('the audio context sleeps once its sound has finished',
    acOn.state === 'running' && acOn.osc > 0 && acIdleState.state === 'suspended' &&
    Math.abs(acFrozen.clock - acIdleState.clock) < 0.02,
    acOn.state + ' (' + acOn.osc + ' oscillators) -> ' + acIdleState.state +
    ', clock ' + acIdleState.clock.toFixed(2) + ' -> ' + acFrozen.clock.toFixed(2) + ' while asleep');
  check('a tap after the sleep still plays the sound',
    acWoken.state === 'running' && acWoken.osc > acOn.osc && acClock.clock > acWoken.clock,
    acWoken.state + ', ' + acWoken.osc + ' oscillators, clock ' +
    acWoken.clock.toFixed(2) + ' -> ' + acClock.clock.toFixed(2));
  check('hiding the page releases the audio context', acHidden === 'suspended', acHidden);
  check('no errors from the audio path', audioErrors.length === 0, audioErrors.slice(0, 2).join(' | '));
  await p5.close();

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e.message); process.exit(2); });
