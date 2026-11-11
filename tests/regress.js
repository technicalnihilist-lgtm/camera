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

  // the framing box is the stage's layout box, not whatever the intro/bounce/
  // parallax transform happened to be at the moment it was first measured
  const sbox = await page.evaluate(() => {
    dispatchEvent(new Event('resize'));                 // drops the cached box
    const st = document.querySelector('#stage'), keep = st.style.transform;
    st.style.transform = 'scale(.6) translateY(40px)';  // an intro/bounce frame
    const b = stageBox();
    st.style.transform = keep;
    dispatchEvent(new Event('resize'));
    const a = document.querySelector('#app').getBoundingClientRect();
    return { w: b.width, h: b.height, l: b.left, t: b.top,
      aw: a.width, ah: a.height, al: a.left, at: a.top };
  });
  check('the framing box ignores the stage animation',
    Math.abs(sbox.w - sbox.aw) < 1 && Math.abs(sbox.h - sbox.ah) < 1 &&
    Math.abs(sbox.l - sbox.al) < 1 && Math.abs(sbox.t - sbox.at) < 1,
    sbox.w + 'x' + sbox.h + ' at ' + sbox.l + ',' + sbox.t +
    ' vs stage ' + sbox.aw + 'x' + sbox.ah + ' at ' + sbox.al + ',' + sbox.at);

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
    window.__br = { calls: 0, opens: 0, maxB64: 0, bytes: 0, mime: '', aborted: false };
    window.AndroidCam = {
      open(mime) { window.__br.mime = mime; window.__br.opens++; return 1; },
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

  // a second tap while a save is still in flight must not start a second save:
  // it opened a second bridge session and interleaved its writes into the same
  // gallery file, doubling it, and fired a second toast
  const dbl = await p2.evaluate(async n => {
    const b = new Uint8Array(n);
    items.push({ t: 'v', u: URL.createObjectURL(new Blob([b], { type: 'video/webm' })), x: 'webm', p: '' });
    vi = items.length - 1;
    const before = { opens: window.__br.opens, bytes: window.__br.bytes };
    const vs = document.querySelector('#vs');
    vs.click();
    setTimeout(() => vs.click(), 60);
    const t0 = performance.now();
    while (performance.now() - t0 < 8000) {
      await new Promise(r => setTimeout(r, 50));
      if (window.__br.opens > before.opens && window.__br.bytes >= before.bytes + n) break;
    }
    await new Promise(r => setTimeout(r, 400));
    return { opens: window.__br.opens - before.opens, wrote: window.__br.bytes - before.bytes, n };
  }, 2 * 1024 * 1024);
  check('a second tap during a save does not start a second one',
    dbl.opens === 1 && dbl.wrote === dbl.n,
    dbl.opens + ' session(s), ' + dbl.wrote + ' of ' + dbl.n + ' bytes');

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

  // applyConstraints() replaces a track's whole constraint set, so a hardware
  // zoom set by the zoom row used to be dropped by the very next constraint set
  // the app wrote — the resolution bump and the focus/exposure pass after a
  // restart, the single-shot focus a tap on the preview asks for, its 3 s
  // restore, and the torch toggle — while the zoom row still showed the tapped
  // level. A camera that reports a zoom capability must see the zoom in every
  // constraint set the app writes. (The fake device has no zoom, so it is
  // advertised here and the calls themselves are what get checked.)
  const p6 = await browser.newPage();
  await p6.setViewport({ width: 400, height: 840 });
  p6.on('pageerror', e => errors.push('pageerror(zoom): ' + e.message));
  p6.on('console', m => { if (m.type() === 'error') errors.push('console(zoom): ' + m.text().slice(0, 160)); });
  await p6.evaluateOnNewDocument(() => {
    const P = MediaStreamTrack.prototype;
    const caps = P.getCapabilities;
    P.getCapabilities = function () {
      let c = {};
      try { c = caps.apply(this, arguments) || {}; } catch (e) { c = {}; }
      return Object.assign({}, c, {
        zoom: { min: 1, max: 3, step: 0.1 }, torch: false,
        focusMode: ['continuous', 'single-shot', 'none'],
        exposureMode: ['continuous', 'manual'],
        whiteBalanceMode: ['continuous', 'manual'],
        pointsOfInterest: true, width: { max: 3840 }, height: { max: 2160 },
      });
    };
    const apply = P.applyConstraints;
    window.__ac = [];
    P.applyConstraints = function (cs) {
      try { window.__ac.push({ id: this.id, cs: JSON.parse(JSON.stringify(cs || {})) }); } catch (e) {}
      return apply.apply(this, arguments);
    };
    window.__last = () => {
      const id = stream && stream.getVideoTracks()[0] && stream.getVideoTracks()[0].id;
      const mine = window.__ac.filter(c => c.id === id);
      return mine.length ? mine[mine.length - 1].cs : null;
    };
    window.__zoomOf = cs => {
      if (!cs) return null;
      const sets = (cs.advanced || []).concat([cs]);
      for (const s of sets) if (s && s.zoom !== undefined) return s.zoom;
      return null;
    };
  });
  await p6.goto(URL, { waitUntil: 'load' });
  await wait(2500);
  const zoomRestart = await p6.evaluate(async () => {
    const w = ms => new Promise(k => setTimeout(k, ms));
    document.querySelector('.zoom button[data-z="2"]').click();
    await w(400);
    const afterTap = window.__zoomOf(window.__last());
    document.querySelector('#flip').click();          // new stream + tune()
    for (let i = 0; i < 40 && !document.querySelector('#v').videoWidth; i++) await w(250);
    await w(1500);                                    // let tune() finish
    return { afterTap, afterRestart: window.__zoomOf(window.__last()),
      sets: window.__ac.length, z: S.z, dz: S.dz };
  });
  check('a camera restart keeps the hardware zoom',
    zoomRestart.afterTap === 2 && zoomRestart.afterRestart === 2 && zoomRestart.dz === 1,
    'zoom ' + zoomRestart.z + 'x: after the zoom tap ' + zoomRestart.afterTap +
    ', after a flip + tune ' + zoomRestart.afterRestart + ' (S.dz ' + zoomRestart.dz + ')');

  // The same replacement rule bit tune()'s own pass: it wrote continuous focus,
  // exposure and white balance as three separate constraint sets in a row, so
  // each one threw away the previous one and only the last was in effect when
  // the loop finished. All three must be in the set the track is left with.
  const zoomModes = await p6.evaluate(() => {
    const cs = window.__last();
    if (!cs) return null;
    const got = {};
    for (const s of (cs.advanced || []).concat([cs]))
      if (s) for (const k of ['focusMode', 'exposureMode', 'whiteBalanceMode'])
        if (s[k] !== undefined) got[k] = s[k];
    return got;
  });
  check('tune() leaves focus, exposure and white balance all in effect',
    !!zoomModes && zoomModes.focusMode === 'continuous' &&
    zoomModes.exposureMode === 'continuous' && zoomModes.whiteBalanceMode === 'continuous',
    JSON.stringify(zoomModes));

  const zoomFocus = await p6.evaluate(async () => {
    const w = ms => new Promise(k => setTimeout(k, ms));
    const st = document.querySelector('#stage');
    st.dispatchEvent(new PointerEvent('pointerdown', { clientX: 200, clientY: 300, bubbles: true }));
    await w(600);
    const onTap = window.__zoomOf(window.__last());
    await w(3200);                                    // the 3 s restore to continuous
    return { onTap, afterRestore: window.__zoomOf(window.__last()) };
  });
  check('tap-to-focus keeps the hardware zoom, before and after its restore',
    zoomFocus.onTap === 2 && zoomFocus.afterRestore === 2,
    'on the tap ' + zoomFocus.onTap + ', after the 3 s restore ' + zoomFocus.afterRestore);

  // The same replacement rule runs the other way and was still open. tune() is
  // the only writer that puts the camera's continuous focus, exposure and white
  // balance into effect, and the sets written after it — a zoom tap, the torch
  // toggle, a tap-to-focus and its restore — sent only their own constraint, so
  // the first tap on 1x/2x/3x dropped all three and left the sensor on its
  // default modes. The set the track is left with after a zoom tap must still
  // carry them, and the zoom it was asked for.
  const zoomTapModes = await p6.evaluate(async () => {
    const w = ms => new Promise(k => setTimeout(k, ms));
    document.querySelector('.zoom button[data-z="3"]').click();
    await w(500);
    const cs = window.__last();
    const got = {};
    for (const s of ((cs && cs.advanced) || []).concat([cs])) if (s)
      for (const k of ['focusMode', 'exposureMode', 'whiteBalanceMode', 'zoom'])
        if (s[k] !== undefined) got[k] = s[k];
    return got;
  });
  check('a zoom tap keeps focus, exposure and white balance in effect',
    zoomTapModes.focusMode === 'continuous' && zoomTapModes.exposureMode === 'continuous' &&
    zoomTapModes.whiteBalanceMode === 'continuous' && zoomTapModes.zoom === 3,
    JSON.stringify(zoomTapModes));
  await p6.close();

  // The burst waits for the preview's next frame between candidates, and that
  // wait used to end only when requestVideoFrameCallback fired. A stalled
  // stream — camera grabbed by another app, a track that muted without an
  // `ended` event — never presents another frame, so snap() waited for ever,
  // `busy` stayed true and every control was dead until the app was restarted.
  // With the callback never firing, a capture must still complete and the next
  // tap must still capture.
  const p7 = await browser.newPage();
  await p7.setViewport({ width: 400, height: 840 });
  p7.on('pageerror', e => errors.push('pageerror(stall): ' + e.message));
  p7.on('console', m => { if (m.type() === 'error') errors.push('console(stall): ' + m.text().slice(0, 160)); });
  await p7.evaluateOnNewDocument(() => {
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value() { return 0; },            // a preview that never presents another frame
    });
    // no still capture, so the burst off the preview is the path taken
    Object.defineProperty(window, 'ImageCapture', { configurable: true, value: undefined });
  });
  await p7.goto(URL, { waitUntil: 'load' });
  await wait(2500);
  await p7.click('#bE'); await wait(900);
  await p7.click('#qseg button[data-q="std"]'); await wait(2200);
  await p7.click('#edone'); await wait(1400);
  const stalled = await p7.evaluate(async () => {
    const w = ms => new Promise(k => setTimeout(k, ms));
    const t0 = performance.now();
    const n0 = items.length;
    document.querySelector('#shut').click();
    let took = -1;
    for (let i = 0; i < 100; i++) {
      await w(100);
      if (took < 0 && items.length > n0) took = performance.now() - t0;
      if (took >= 0 && !busy) break;
    }
    const busyAfter = busy;
    const n1 = items.length;
    document.querySelector('#shut').click();
    for (let i = 0; i < 100 && items.length === n1; i++) await w(100);
    return { took, busy: busyAfter, first: items.length - n0, again: items.length - n1 };
  });
  check('a stalled preview cannot lock the shutter',
    stalled.first >= 1 && stalled.busy === false && stalled.again >= 1,
    'first capture ' + (stalled.took < 0 ? 'never finished' : Math.round(stalled.took) + ' ms') +
    ', busy ' + stalled.busy + ', next tap captured ' + stalled.again);
  await p7.close();

  // the tilt sensor subscription follows the 4D setting
  const p8 = await browser.newPage();
  await p8.setViewport({ width: 400, height: 840 });
  await p8.evaluateOnNewDocument(() => {
    window.__do = { add: 0, remove: 0 };
    const A = EventTarget.prototype.addEventListener, R = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (t, f, o) {
      if (t === 'deviceorientation' && this === window) window.__do.add++;
      return A.call(this, t, f, o);
    };
    EventTarget.prototype.removeEventListener = function (t, f, o) {
      if (t === 'deviceorientation' && this === window) window.__do.remove++;
      return R.call(this, t, f, o);
    };
    // headless Chromium answers the sensor permission with 'prompt' and never
    // resolves it, so stand in for a device where the user has allowed it
    Object.defineProperty(DeviceOrientationEvent, 'requestPermission',
      { configurable: true, value: () => Promise.resolve('granted') });
  });
  await p8.goto(URL, { waitUntil: 'load' });
  await wait(2500);
  const tilt = () => p8.evaluate(() => ({
    add: __do.add, remove: __do.remove, on: PAR.on, listening: PAR.listening,
  }));
  const t0 = await tilt();
  check('the tilt sensor is not subscribed before the first tap',
    t0.add === 0 && t0.listening === false, 'adds ' + t0.add + ', listening ' + t0.listening);
  await p8.mouse.click(200, 420);
  await wait(400);
  const t1 = await tilt();
  check('the first tap subscribes the tilt sensor',
    t1.add === 1 && t1.listening === true, 'adds ' + t1.add + ', listening ' + t1.listening);
  await p8.click('#bS'); await wait(900);
  await p8.click('#t4d'); await wait(400);
  const t2 = await tilt();
  check('turning 4D off releases the tilt sensor',
    t2.on === false && t2.listening === false && t2.remove === 1,
    '4D ' + t2.on + ', listening ' + t2.listening + ', removes ' + t2.remove);
  await p8.click('#t4d'); await wait(400);
  const t3 = await tilt();
  check('turning 4D back on re-subscribes the tilt sensor',
    t3.on === true && t3.listening === true && t3.add === 2 && t3.remove === 1,
    '4D ' + t3.on + ', listening ' + t3.listening + ', adds ' + t3.add);
  await p8.close();

  // a permission answer that is not 'denied' still subscribes (Chromium: 'prompt')
  const sensorPage = async answer => {
    const p = await browser.newPage();
    await p.setViewport({ width: 400, height: 840 });
    await p.evaluateOnNewDocument(ans => {
      window.__do = { add: 0 };
      const A = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (t, f, o) {
        if (t === 'deviceorientation' && this === window) window.__do.add++;
        return A.call(this, t, f, o);
      };
      Object.defineProperty(DeviceOrientationEvent, 'requestPermission',
        { configurable: true, value: () => Promise.resolve(ans) });
    }, answer);
    await p.goto(URL, { waitUntil: 'load' });
    await wait(2500);
    return p;
  };
  const p9 = await sensorPage('prompt');
  await p9.mouse.click(200, 420);
  await wait(400);
  const t4 = await p9.evaluate(() => {
    const tilt = { add: __do.add, listening: PAR.listening };
    const fire = (b, g) => dispatchEvent(new DeviceOrientationEvent('deviceorientation',
      { alpha: 0, beta: b, gamma: g }));
    // the fake sensor platform emits its own events; start from a clean base
    PAR.base = null;
    fire(30, 10); fire(10, 10);
    tilt.gyro = PAR.gyro;
    tilt.ayAfter = PAR.ay;
    return tilt;
  });
  check('a "prompt" permission answer still starts 4D tilt',
    t4.add === 1 && t4.listening === true && t4.gyro === true && Math.abs(t4.ayAfter - 0.5) < 0.01,
    'adds ' + t4.add + ', listening ' + t4.listening + ', ay ' + t4.ayAfter.toFixed(2));
  await p9.close();

  const p10 = await sensorPage('denied');
  await p10.mouse.click(200, 420);
  await wait(400);
  const t5 = await p10.evaluate(() => ({ add: __do.add, listening: PAR.listening }));
  check('a denied permission does not subscribe the tilt sensor',
    t5.add === 0 && t5.listening === false, 'adds ' + t5.add + ', listening ' + t5.listening);
  await p10.close();

  // The depth pass's scratch surface and the poster's scratch surface are
  // module-level like stillC and pipeC, but unlike them they were never
  // released: a 12 MP frame pins a few MB of RGBA in dScratch and a
  // 1080-long-edge poster a few MB in pScratch for as long as the WebView
  // lives after the page is hidden. Both must be let go when the page hides
  // and must still work afterwards.
  const p11 = await browser.newPage();
  await p11.setViewport({ width: 400, height: 840 });
  const memErrors = [];
  p11.on('pageerror', e => memErrors.push('pageerror(mem): ' + e.message));
  p11.on('console', m => { if (m.type() === 'error') memErrors.push('console(mem): ' + m.text().slice(0, 160)); });
  await p11.goto(URL, { waitUntil: 'load' });
  await wait(2500);
  const warm = await p11.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1440; c.height = 1080;
    const x = c.getContext('2d'); x.fillStyle = '#345'; x.fillRect(0, 0, 1440, 1080);
    const uri = posterFrom(c);
    const d = document.createElement('canvas'); d.width = 640; d.height = 480;
    depthPass(d.getContext('2d'), d, .8);
    sharpScore(c, 0, 0, 1440, 1080);
    return { d: dScratch.width * dScratch.height, p: pScratch.width * pScratch.height, uri: uri.length,
      s: sScratch.width * sScratch.height, gray: !!sGray };
  });
  const released = await p11.evaluate(async () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
    await new Promise(k => setTimeout(k, 150));
    return { d: dScratch.width * dScratch.height, p: pScratch.width * pScratch.height,
      s: sScratch.width * sScratch.height, gray: !!sGray };
  });
  const healed = await p11.evaluate(async () => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
    const c = document.createElement('canvas'); c.width = 1440; c.height = 1080;
    const x = c.getContext('2d'); x.fillStyle = '#345'; x.fillRect(0, 0, 1440, 1080);
    const uri = posterFrom(c);
    const d = document.createElement('canvas'); d.width = 640; d.height = 480;
    depthPass(d.getContext('2d'), d, .8);
    const sc = sharpScore(c, 0, 0, 1440, 1080);
    return { d: dScratch.width * dScratch.height, p: pScratch.width * pScratch.height, uri: uri.length,
      s: sScratch.width * sScratch.height, gray: !!sGray, sc: sc };
  });
  check('hiding the page releases the depth and poster scratch surfaces',
    warm.d > 0 && warm.p > 0 && released.d === 0 && released.p === 0,
    'dScratch ' + warm.d + ' -> ' + released.d + ' px, pScratch ' + warm.p + ' -> ' + released.p + ' px');
  check('the depth pass and the poster still work after the page is shown again',
    healed.d > 0 && healed.p > 0 && healed.uri > 1000,
    'dScratch ' + healed.d + ' px, pScratch ' + healed.p + ' px, poster ' + healed.uri + ' chars');
  // The sharpness scorer's surface and grey buffer are the same kind of
  // module-level scratch as dScratch and pScratch, and they are the only ones
  // that were never let go: both must be dropped as the page hides and rebuilt
  // by the next burst, with the score itself unchanged.
  check('hiding the page releases the sharpness scratch surface',
    warm.s > 0 && warm.gray === true && released.s === 0 && released.gray === false,
    'sScratch ' + warm.s + ' -> ' + released.s + ' px, grey ' + warm.gray + ' -> ' + released.gray);
  check('the sharpness score still works after the page is shown again',
    healed.s > 0 && healed.gray === true && isFinite(healed.sc),
    'sScratch ' + healed.s + ' px, grey ' + healed.gray + ', score ' + healed.sc);
  check('no errors from the scratch surfaces', memErrors.length === 0, memErrors.slice(0, 2).join(' | '));
  await p11.close();

  // A camera app must let go of the sensor when it is not on screen. The
  // Android wrapper keeps the WebView process alive behind the home screen, so
  // an un-released preview track leaves the sensor, the ISP and the system's
  // camera-in-use indicator running for as long as the app sits in the
  // background. The tracks must be stopped as the page hides, taken up again
  // when it is shown, and left alone while a take is recording.
  const p12 = await browser.newPage();
  await p12.setViewport({ width: 400, height: 840 });
  const camErrors = [];
  p12.on('pageerror', e => camErrors.push('pageerror(cam): ' + e.message));
  p12.on('console', m => { if (m.type() === 'error') camErrors.push('console(cam): ' + m.text().slice(0, 160)); });
  await p12.goto(URL, { waitUntil: 'load' });
  await wait(2500);
  const camBefore = await p12.evaluate(() => ({ live: !!stream, w: v.videoWidth }));
  const camHidden = await p12.evaluate(async () => {
    const tr = stream ? stream.getTracks() : [];
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
    await new Promise(k => setTimeout(k, 250));
    return { n: tr.length, states: tr.map(t => t.readyState), stream: stream === null, src: v.srcObject === null };
  });
  check('hiding the page releases the camera',
    camBefore.live && camBefore.w > 0 && camHidden.n > 0 &&
    camHidden.states.every(s => s === 'ended') && camHidden.stream && camHidden.src,
    camHidden.n + ' track(s) ' + camHidden.states.join(',') + ', stream ' + camHidden.stream + ', srcObject null ' + camHidden.src);
  const camShown = await p12.evaluate(async () => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
    for (let i = 0; i < 40; i++) {
      await new Promise(k => setTimeout(k, 100));
      if (stream && v.videoWidth > 0) break;
    }
    return { live: !!stream, w: v.videoWidth, states: stream ? stream.getTracks().map(t => t.readyState) : [] };
  });
  check('showing the page takes the camera up again',
    camShown.live && camShown.w > 0 && camShown.states.every(s => s === 'live'),
    camShown.w + 'x, tracks ' + camShown.states.join(','));
  const camRec = await p12.evaluate(async () => {
    const s = stream; rec = { fake: true };
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
    await new Promise(k => setTimeout(k, 200));
    const kept = stream === s && s.getTracks().every(t => t.readyState === 'live');
    rec = null;
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
    await new Promise(k => setTimeout(k, 250));
    return { kept, live: !!stream };
  });
  check('a hide during a take does not stop the recording',
    camRec.kept && camRec.live, 'stream kept ' + camRec.kept + ', still live ' + camRec.live);
  check('no errors from the camera lifecycle', camErrors.length === 0, camErrors.slice(0, 2).join(' | '));
  await p12.close();

  // A photo capture owns the camera in exactly the same way a take does, and the
  // hide handler released the sensor regardless of whether a shot was in flight:
  // a page hidden while the burst was still running had its tracks stopped and
  // `v.srcObject` cleared underneath snapShot(), so the frame grab failed, the
  // crop measured 0x0 and the photo the user had already taken was dropped with
  // "Camera is not ready yet" — on a page nobody could see. The capture keeps
  // the camera for as long as it is using it and releases it on its way out, so
  // a hidden page pins the sensor for at most the length of one capture.
  const p23 = await browser.newPage();
  await p23.setViewport({ width: 400, height: 840 });
  const shotErrors = [];
  p23.on('pageerror', e => shotErrors.push('pageerror(shot): ' + e.message));
  p23.on('console', m => { if (m.type() === 'error') shotErrors.push('console(shot): ' + m.text().slice(0, 160)); });
  await p23.goto(URL, { waitUntil: 'load' });
  await wait(2500);
  await p23.click('#bE'); await wait(900);
  await p23.click('#qseg button[data-q="std"]'); await wait(2200);
  await p23.click('#edone'); await wait(1400);
  const hideShot = await p23.evaluate(async () => {
    const before = items.length;
    document.querySelector('#shut').click();      // busy and capturing are set synchronously
    const inFlight = busy && capturing;
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
    const kept = stream !== null && v.srcObject !== null;
    for (let i = 0; i < 120; i++) {
      await new Promise(k => setTimeout(k, 100));
      if (!busy && !capturing) break;
    }
    const saved = items.length - before;
    const released = stream === null && v.srcObject === null && camPaused;
    return { inFlight, kept, saved, released };
  });
  check('a hide during a photo capture still saves the shot',
    hideShot.inFlight && hideShot.kept && hideShot.saved === 1,
    'in flight ' + hideShot.inFlight + ', camera kept ' + hideShot.kept + ', saved ' + hideShot.saved);
  check('and the camera is released once that capture is done',
    hideShot.released, 'released ' + hideShot.released);
  const hideShotBack = await p23.evaluate(async () => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
    for (let i = 0; i < 40; i++) {
      await new Promise(k => setTimeout(k, 100));
      if (stream && v.videoWidth > 0) break;
    }
    return { live: !!stream, w: v.videoWidth };
  });
  check('and taken up again when the page comes back',
    hideShotBack.live && hideShotBack.w > 0, hideShotBack.w + 'px');
  // The countdown in front of a photo capture is part of that capture, and the
  // hide handler only protected the capture itself: a hide during the countdown
  // released the camera and left the countdown running, so the timed shot the
  // user had already asked for came back as "Camera is not ready yet" on a page
  // nobody could see — 0 photos. The countdown now holds the camera the same
  // way a capture does and lets go on its way out.
  const timedHide = await p23.evaluate(async () => {
    document.querySelector('#bE').click(); await new Promise(k => setTimeout(k, 700));
    document.querySelector('#eBurst').click();          // one frame per shot, so the capture is quick
    document.querySelector('#edone').click(); await new Promise(k => setTimeout(k, 900));
    const before = items.length;
    S.tm = 1;                                          // the shortest tick the timer can run
    document.querySelector('#shut').click();
    await new Promise(k => setTimeout(k, 250));
    const wasCounting = counting && busy;
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
    const kept = stream !== null && v.srcObject !== null;
    for (let i = 0; i < 120; i++) {
      await new Promise(k => setTimeout(k, 100));
      if (!busy && !capturing && !counting) break;
    }
    const saved = items.length - before;
    const released = stream === null && v.srcObject === null && camPaused;
    S.tm = 0;
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
    for (let i = 0; i < 40; i++) {
      await new Promise(k => setTimeout(k, 100));
      if (stream && v.videoWidth > 0) break;
    }
    return { wasCounting, kept, saved, released, back: !!stream };
  });
  check('a hide during the countdown still takes the timed photo',
    timedHide.wasCounting && timedHide.kept && timedHide.saved === 1,
    'counting ' + timedHide.wasCounting + ', camera kept ' + timedHide.kept + ', saved ' + timedHide.saved);
  check('and the countdown lets go of the camera once the shot is in',
    timedHide.released && timedHide.back, 'released ' + timedHide.released + ', back ' + timedHide.back);
  check('no errors from the hidden capture', shotErrors.length === 0, shotErrors.slice(0, 2).join(' | '));
  await p23.close();

  // A start() that is still waiting for the device when the page hides must not
  // leave the app without a camera on return. The hide makes that start stale —
  // it stops the stream it is given and attaches nothing — and the handler only
  // remembered to take the camera up again when there was already a stream, so
  // the app came back to a black preview with no camera and no message and
  // stayed that way until the camera was flipped or the app restarted.
  const p13 = await browser.newPage();
  await p13.setViewport({ width: 400, height: 840 });
  const slowErrors = [];
  p13.on('pageerror', e => slowErrors.push('pageerror(slow): ' + e.message));
  p13.on('console', m => { if (m.type() === 'error') slowErrors.push('console(slow): ' + m.text().slice(0, 160)); });
  await p13.evaluateOnNewDocument(() => {
    const orig = MediaDevices.prototype.getUserMedia;
    MediaDevices.prototype.getUserMedia = function (c) {
      return new Promise((ok, no) => setTimeout(() => {
        try { orig.call(this, c).then(ok, no); } catch (e) { no(e); }
      }, 900));
    };
  });
  await p13.goto(URL, { waitUntil: 'load' });
  await wait(200);
  const slowPending = await p13.evaluate(() => typeof startPending !== 'undefined' && !!startPending && !stream);
  const slowHide = await p13.evaluate(async () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
    await new Promise(k => setTimeout(k, 1200));
    return { stream: !!stream, paused: camPaused };
  });
  const slowShow = await p13.evaluate(async () => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    window.dispatchEvent(new Event('visibilitychange'));
    for (let i = 0; i < 40; i++) {
      await new Promise(k => setTimeout(k, 100));
      if (stream && v.videoWidth > 0) break;
    }
    // the fade-in is a 0.6 s CSS transition that only starts once play() has
    // resolved, and videoWidth is set before that — wait for it, bounded
    for (let i = 0; i < 40; i++) {
      if (+getComputedStyle(v).opacity > 0.9) break;
      await new Promise(k => setTimeout(k, 100));
    }
    return { live: !!stream, w: v.videoWidth, op: +getComputedStyle(v).opacity, gate: document.querySelector('#gate').hidden };
  });
  check('a hide while the camera is still starting does not leave the app without one',
    slowPending && slowHide.stream === false && slowHide.paused === true &&
    slowShow.live && slowShow.w > 0 && slowShow.op > 0.9 && slowShow.gate === true,
    'pending ' + slowPending + ', on hide stream ' + slowHide.stream + ' paused ' + slowHide.paused +
    ', on return ' + slowShow.w + 'px, opacity ' + slowShow.op + ', gate hidden ' + slowShow.gate);
  check('no errors from the slow-start camera', slowErrors.length === 0, slowErrors.slice(0, 2).join(' | '));
  await p13.close();

  // `prefers-reduced-motion: reduce` turns 4D parallax off before the first
  // frame, but the switches were placed by hand at the sites that set the flag
  // and the boot default was not one of them: the sheet showed "4D tilt
  // parallax" switched on over a page with no parallax at all, so the feature
  // looked broken until the already-on switch was tapped. The setters place the
  // switch from the state in effect now.
  const p14 = await browser.newPage();
  await p14.setViewport({ width: 400, height: 840 });
  await p14.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  // a first run: no saved preference to restore over the reduced-motion default
  await p14.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
  await p14.goto(URL, { waitUntil: 'load' });
  await wait(1200);
  const rmBoot = await p14.evaluate(() => ({
    sw: document.querySelector('#t4d .sw').classList.contains('on'),
    par: document.querySelector('#app').classList.contains('par'),
    on: PAR.on,
  }));
  check('the 4D switch shows the state in effect under reduced motion',
    rmBoot.sw === false && rmBoot.par === false && rmBoot.on === false,
    'switch on ' + rmBoot.sw + ', par class ' + rmBoot.par + ', PAR.on ' + rmBoot.on);
  const rmTap = await p14.evaluate(async () => {
    document.querySelector('#t4d').click();
    await new Promise(k => setTimeout(k, 300));
    return {
      sw: document.querySelector('#t4d .sw').classList.contains('on'),
      par: document.querySelector('#app').classList.contains('par'),
    };
  });
  check('one tap on it turns 4D on, switch and page agreeing',
    rmTap.sw === true && rmTap.par === true,
    'switch on ' + rmTap.sw + ', par class ' + rmTap.par);
  await p14.close();

  // The parallax smoothing was a flat 0.14 per frame, so how long a tilt took
  // to settle was set by the display's refresh rate rather than by time: the
  // same 20 frames is 333 ms at 60 Hz and 167 ms at 120 Hz, so on a 120 Hz
  // phone the layers snapped to the tilt in half the time they were tuned for.
  // The step is scaled by the frame's own interval now, normalised to a 60 Hz
  // frame, so every rate settles in the same wall-clock time and a 60 Hz
  // cadence steps by exactly 0.14 as before. Drive the loop from a virtual
  // animation clock so a refresh rate can be simulated exactly.
  const p15 = await browser.newPage();
  await p15.setViewport({ width: 400, height: 840 });
  await p15.evaluateOnNewDocument(() => {
    let id = 0; const q = new Map();
    window.__now = 0;
    window.requestAnimationFrame = cb => { q.set(++id, cb); return id; };
    window.cancelAnimationFrame = i => { q.delete(i); };
    window.__drop = () => q.clear();
    window.__tick = dt => {
      window.__now += dt;
      const due = [...q.entries()]; q.clear();
      for (const [, cb] of due) { try { cb(window.__now); } catch (e) {} }
    };
  });
  await p15.goto(URL, { waitUntil: 'load' });
  await wait(1200);
  const settle = rate => p15.evaluate(dt => {
    window.__drop(); PAR.raf = 0; PAR.tx = PAR.ty = 0;
    PAR.ax = 0; PAR.ay = -1; PAR.k = 1;
    parKick();
    const trace = [];
    for (let n = 0; n < 300; n++) {
      window.__tick(dt);
      trace.push(Math.abs(PAR.ty));
      if (Math.abs(Math.abs(PAR.ty) - 1) < 0.05) break;
    }
    return { ticks: trace.length, ms: Math.round(trace.length * dt),
      at100: +(trace[Math.round(100 / dt) - 1] || 0).toFixed(3) };
  }, rate);
  const s60 = await settle(1000 / 60);
  const s120 = await settle(1000 / 120);
  check('4D parallax settles in the same time at 60 Hz and 120 Hz',
    Math.abs(s120.ms - s60.ms) <= 25 && Math.abs(s120.at100 - s60.at100) <= 0.05,
    '60 Hz ' + s60.ticks + ' frames / ' + s60.ms + ' ms, 120 Hz ' + s120.ticks + ' frames / ' + s120.ms +
    ' ms, ' + s60.at100 + ' vs ' + s120.at100 + ' of the way at 100 ms');
  check('the 60 Hz parallax curve is unchanged', s60.ticks === 20 && Math.abs(s60.at100 - 0.595) <= 0.02,
    s60.ticks + ' frames, ' + s60.at100 + ' of the way at 100 ms');
  await p15.close();


  // The take's microphone request had no bound and it holds the app-wide `busy`
  // flag, so a permission prompt that was never answered left the promise
  // pending for ever and every control answered "Wait for the timer to finish"
  // until the app was restarted. The wait is bounded now, the take falls back to
  // the silent recording the app already supports, and a stream that arrives
  // after the bound is stopped so the microphone is never left open.
  const p16 = await browser.newPage();
  await p16.setViewport({ width: 400, height: 840 });
  const micErrors = [];
  p16.on('pageerror', e => micErrors.push('pageerror(mic): ' + e.message));
  p16.on('console', m => { if (m.type() === 'error') micErrors.push('console(mic): ' + m.text().slice(0, 160)); });
  await p16.evaluateOnNewDocument(() => {
    window.__lateStopped = 0; window.__micAsks = 0; window.__resolvers = [];
    const orig = MediaDevices.prototype.getUserMedia;
    MediaDevices.prototype.getUserMedia = function (c) {
      if (c && c.audio && !c.video) {
        // a microphone that is granted but never opens: the promise is held open
        window.__micAsks++;
        return new Promise(ok => window.__resolvers.push(() => ok({
          getTracks: () => [{ stop() { window.__lateStopped++; } }],
          getAudioTracks: () => [],
        })));
      }
      return orig.call(this, c);
    };
    navigator.permissions.query = () => Promise.resolve({ state: 'granted' });
  });
  await p16.goto(URL, { waitUntil: 'load' });
  await wait(2500);
  const micWait = await p16.evaluate(async () => {
    const t0 = performance.now(); let threw = false;
    try { await micStream(); } catch (e) { threw = true; }
    return { ms: Math.round(performance.now() - t0), threw, asks: window.__micAsks };
  });
  check('a granted microphone that never opens is given up on',
    micWait.threw && micWait.asks === 1 && micWait.ms >= 4500 && micWait.ms <= 7000,
    'waited ' + micWait.ms + ' ms, ' + micWait.asks + ' request(s)');
  const wedgedMic = await p16.evaluate(async () => {
    const w = ms => new Promise(k => setTimeout(k, ms));
    document.querySelector('.modes button[data-m="video"]').click();
    await w(300);
    document.querySelector('#shut').click();
    for (let i = 0; i < 200; i++) { await w(100); if (rec) break; }
    const started = !!rec, locked = busy, mic = !!micS;
    const asked = window.__resolvers.length;
    window.__resolvers.splice(0).forEach(f => f());   // the dialog is answered after the fact
    await w(400);
    return { started, locked, mic, asked, late: window.__lateStopped };
  });
  check('an unanswered mic prompt cannot lock the shutter for the session',
    wedgedMic.started && wedgedMic.locked === false && wedgedMic.mic === false,
    'take started ' + wedgedMic.started + ', busy ' + wedgedMic.locked + ', mic ' + wedgedMic.mic);
  check('a mic stream that arrives after the bound is stopped on arrival',
    wedgedMic.asked >= 1 && wedgedMic.late === wedgedMic.asked,
    wedgedMic.asked + ' late stream(s), ' + wedgedMic.late + ' stopped');
  const micTake = await p16.evaluate(async () => {
    const w = ms => new Promise(k => setTimeout(k, ms));
    // the recorder hands over its first 250 ms slice when it is due; a take
    // stopped before that has nothing to save, which is not what this checks
    for (let i = 0; i < 25 && !chunks.length; i++) await w(100);
    document.querySelector('#shut').click();      // stop the take
    for (let i = 0; i < 40 && rec; i++) await w(100);
    await w(400);
    const it = items[items.length - 1] || {};
    return { rec: !!rec, busy, kind: it.t || '', n: items.length };
  });
  check('the take started without a microphone still records a clip',
    micTake.rec === false && micTake.busy === false && micTake.kind === 'v' && micTake.n >= 1,
    'rec ' + micTake.rec + ', busy ' + micTake.busy + ', item ' + micTake.kind);
  check('no errors from the wedged microphone', micErrors.length === 0, micErrors.slice(0, 2).join(' | '));
  await p16.close();

  // A microphone the user has already refused is answered from the permission
  // state instead of by a request that can only be rejected.
  const p17 = await browser.newPage();
  await p17.setViewport({ width: 400, height: 840 });
  await p17.evaluateOnNewDocument(() => {
    window.__micAsks = 0;
    const orig = MediaDevices.prototype.getUserMedia;
    MediaDevices.prototype.getUserMedia = function (c) {
      if (c && c.audio && !c.video) { window.__micAsks++; return Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); }
      return orig.call(this, c);
    };
    navigator.permissions.query = () => Promise.resolve({ state: 'denied' });
  });
  await p17.goto(URL, { waitUntil: 'load' });
  await wait(2500);
  const deniedMic = await p17.evaluate(async () => {
    const w = ms => new Promise(k => setTimeout(k, ms));
    const t0 = performance.now(); let threw = false;
    try { await micStream(); } catch (e) { threw = true; }
    const ms = Math.round(performance.now() - t0);
    document.querySelector('.modes button[data-m="video"]').click();
    await w(300);
    document.querySelector('#shut').click();
    for (let i = 0; i < 200; i++) { await w(100); if (rec) break; }
    return { ms, threw, asks: window.__micAsks, started: !!rec, locked: busy };
  });
  check('a refused microphone is answered without asking for it',
    deniedMic.threw && deniedMic.ms < 300 && deniedMic.asks === 0 && deniedMic.started && deniedMic.locked === false,
    'refused in ' + deniedMic.ms + ' ms, ' + deniedMic.asks + ' request(s), take started ' + deniedMic.started);
  await p17.close();

  // The three image decode/encode waits on the capture path (the still's JPEG
  // decode, each preview frame's grab, the shot's JPEG encode) used to be the
  // only awaits between a shutter tap and a saved photo that no event ever
  // ends. A wedged encoder left that promise pending for ever, so `busy` never
  // came off and every control answered "Wait for the timer to finish" until
  // the app was restarted. Wedge the encode and check the shutter comes back.
  const p18 = await browser.newPage();
  await p18.setViewport({ width: 400, height: 840 });
  p18.on('pageerror', e => errors.push('pageerror(encode): ' + e.message));
  p18.on('console', m => { if (m.type() === 'error') errors.push('console(encode): ' + m.text().slice(0, 160)); });
  await p18.evaluateOnNewDocument(() => {
    const real = HTMLCanvasElement.prototype.toBlob;
    window.__wedged = false;
    HTMLCanvasElement.prototype.toBlob = function (cb, ...a) {
      if (window.__wedged) return;            // the encode never calls back
      return real.call(this, cb, ...a);
    };
  });
  await p18.goto(URL, { waitUntil: 'load' });
  await wait(2500);
  const wedged = await p18.evaluate(async () => {
    const w = ms => new Promise(k => setTimeout(k, ms));
    E.q = 'std'; E.burst = false;              // a quick shot; the encode is what hangs
    window.__wedged = true;
    document.querySelector('#shut').click();
    const t0 = performance.now(); let ms = -1;
    for (let i = 0; i < 400; i++) { await w(50); if (!busy) { ms = Math.round(performance.now() - t0); break; } }
    const lost = items.length;
    window.__wedged = false;                   // and the shutter must still work
    document.querySelector('#shut').click();
    for (let i = 0; i < 100; i++) { await w(100); if (!busy && items.length > lost) break; }
    return { ms, lost, after: items.length, locked: busy };
  });
  check('a wedged JPEG encode does not lock the shutter',
    wedged.ms >= 0 && wedged.ms < 16000 && wedged.locked === false && wedged.lost === 0,
    'unlocked after ' + wedged.ms + ' ms, ' + wedged.lost + ' photo(s) written');
  check('the shutter still captures after the encode gave up',
    wedged.after >= 1,
    wedged.after + ' photo(s) after the timeout');
  await p18.close();

  // A camera that advertises `zoom` and then does not move when asked. The
  // zoom goes out as an `advanced` constraint set, which the spec says a UA
  // skips rather than rejects when it cannot satisfy it, so applyConstraints()
  // resolves with the track still at 1x: the zoom row showed the tapped level
  // and the preview and the capture both stayed unzoomed, silently. The zoom is
  // read back off getSettings() now and the digital zoom the app already has
  // takes over, so the tap zooms either way.
  const p19 = await browser.newPage();
  await p19.setViewport({ width: 400, height: 840 });
  p19.on('pageerror', e => errors.push('pageerror(zoomskip): ' + e.message));
  p19.on('console', m => { if (m.type() === 'error') errors.push('console(zoomskip): ' + m.text().slice(0, 160)); });
  await p19.evaluateOnNewDocument(() => {
    const P = MediaStreamTrack.prototype;
    const caps = P.getCapabilities, get = P.getSettings, apply = P.applyConstraints;
    P.getCapabilities = function () {
      let c = {};
      try { c = caps.apply(this, arguments) || {}; } catch (e) {}
      return Object.assign({}, c, { zoom: { min: 1, max: 3, step: 0.1 } });
    };
    P.getSettings = function () {
      let s = {};
      try { s = get.apply(this, arguments) || {}; } catch (e) {}
      return Object.assign({}, s, { zoom: 1 });      // reports 1x, whatever is asked
    };
    P.applyConstraints = function (cs) {
      const only = cs && Array.isArray(cs.advanced) && cs.advanced.every(a => a && a.zoom !== undefined);
      if (only) return Promise.resolve();            // the set is skipped, not applied
      return apply.apply(this, arguments);
    };
  });
  await p19.goto(URL, { waitUntil: 'load' });
  await wait(2500);
  const zoomSkip = await p19.evaluate(async () => {
    const w = ms => new Promise(k => setTimeout(k, ms));
    document.querySelector('.zoom button[data-z="2"]').click();
    await w(700);
    const r2 = cropRect();
    const keep = S.dz; S.dz = 1; const r1 = cropRect(); S.dz = keep;
    return { z: S.z, dz: S.dz, scale: document.querySelector('#v').style.transform,
      ratio: r1.sw / r2.sw };
  });
  check('a camera that ignores the zoom falls back to the digital zoom',
    zoomSkip.dz === 2 && /scale\(2/.test(zoomSkip.scale) && Math.abs(zoomSkip.ratio - 2) < 0.05,
    'S.dz ' + zoomSkip.dz + ', preview ' + zoomSkip.scale +
    ', capture crop ' + zoomSkip.ratio.toFixed(2) + 'x narrower');
  await p19.close();

  // start() awaited v.play() with no bound. play() settles only once the element
  // has actually started playing, so a preview whose frames stop arriving (a
  // wedged media pipeline, a camera grabbed by another app) left it pending for
  // ever and every statement after it was skipped: the preview was never faded
  // in, the gate never taken down, and neither applyZoom() nor tune() ran — a
  // black preview with no message and no camera tuning for the rest of the
  // session. The wait is bounded now, and a play() that does not start is
  // treated as the failed play() the app has always ignored.
  const p20 = await browser.newPage();
  await p20.setViewport({ width: 400, height: 840 });
  p20.on('pageerror', e => errors.push('pageerror(hungplay): ' + e.message));
  p20.on('console', m => { if (m.type() === 'error') errors.push('console(hungplay): ' + m.text().slice(0, 160)); });
  await p20.evaluateOnNewDocument(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.id === 'v') { window.__hungPlay = (window.__hungPlay || 0) + 1; return new Promise(() => {}); }
      return play.apply(this, arguments);
    };
  });
  await p20.goto(URL, { waitUntil: 'load' });
  const hung = await p20.evaluate(async () => {
    const w = ms => new Promise(k => setTimeout(k, ms));
    let op = '0';
    for (let i = 0; i < 90; i++) {
      await w(100);
      op = getComputedStyle(document.querySelector('#v')).opacity;
      if (op === '1') break;
    }
    return {
      asked: window.__hungPlay || 0, op,
      gate: document.querySelector('#gate').hidden,
      w: document.querySelector('#v').videoWidth,
      tuned: document.querySelector('#info').textContent.trim().length > 0,
    };
  });
  check('a preview whose play() never settles still comes up',
    hung.asked > 0 && hung.op === '1' && hung.gate === true && hung.w > 0 && hung.tuned,
    'play() hung, preview opacity ' + hung.op + ', gate hidden ' + hung.gate +
    ', stream ' + hung.w + 'px, tuned ' + hung.tuned);
  await p20.close();


  // "Use phone camera app" is the only way out of the gate when the browser will
  // not give the page a camera, and taking the gate down was all it did: nothing
  // put it back if the picker was dismissed. The app was left on a black preview
  // with no message and no "Allow camera" to retry from — no start() runs while
  // there is no stream to resume — and the shutter only reopened the picker. A
  // pick that starts at the gate now restores it when it is dismissed, and a
  // pick that delivers a file is still the native-picker mode it asked for.
  const p21 = await browser.newPage();
  await p21.setViewport({ width: 400, height: 840 });
  p21.on('pageerror', e => errors.push('pageerror(nativepick): ' + e.message));
  p21.on('console', m => { if (m.type() === 'error') errors.push('console(nativepick): ' + m.text().slice(0, 160)); });
  await p21.evaluateOnNewDocument(() => {
    navigator.mediaDevices.getUserMedia = () => {
      window.__camAsks = (window.__camAsks || 0) + 1;
      return Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    };
  });
  await p21.goto(URL, { waitUntil: 'load' });
  await wait(1500);
  const gate0 = await p21.evaluate(() => ({
    hidden: document.querySelector('#gate').hidden,
    msg: document.querySelector('#gm').textContent,
    btn: document.querySelector('#gb').textContent,
  }));
  const fc1p = p21.waitForFileChooser({ timeout: 8000 });
  await p21.click('#gn');
  const fc1 = await fc1p;
  await fc1.cancel();
  await wait(500);
  const gate1 = await p21.evaluate(() => ({
    hidden: document.querySelector('#gate').hidden,
    msg: document.querySelector('#gm').textContent,
    btn: document.querySelector('#gb').textContent,
    items: items.length,
  }));
  check('a cancelled picker leaves the gate back on screen',
    gate0.hidden === false && gate1.hidden === false && gate1.items === 0 &&
    gate1.msg === gate0.msg && gate1.btn === gate0.btn,
    'gate hidden ' + gate1.hidden + ', same message ' + (gate1.msg === gate0.msg) +
    ', button "' + gate1.btn + '"');

  const tmpPick = path.join(require('os').tmpdir(), 'lgc-pick.jpg');
  require('fs').writeFileSync(tmpPick, Buffer.alloc(4096, 7));
  let gate2 = { hidden: false, items: -1, native: false }, gate3 = { hidden: false, items: -1 };
  try {
    const fc2p = p21.waitForFileChooser({ timeout: 8000 });
    await p21.click('#gn');
    const fc2 = await fc2p;
    await fc2.accept([tmpPick]);
    await wait(600);
    gate2 = await p21.evaluate(() => ({
      hidden: document.querySelector('#gate').hidden, items: items.length, native: native,
    }));
  } catch (e) { gate2.err = e.message.slice(0, 80); }
  check('a picker that delivers a file still takes the gate down',
    gate2.hidden === true && gate2.items === 1 && gate2.native === true,
    'gate hidden ' + gate2.hidden + ', ' + gate2.items + ' item(s), native ' + gate2.native +
    (gate2.err ? ', ' + gate2.err : ''));

  // a picker opened later from the shutter is native-picker mode, not the gate
  try {
    const fc3p = p21.waitForFileChooser({ timeout: 8000 });
    await p21.click('#shut');
    const fc3 = await fc3p;
    await fc3.cancel();
    await wait(500);
    gate3 = await p21.evaluate(() => ({
      hidden: document.querySelector('#gate').hidden, items: items.length,
    }));
  } catch (e) { gate3.err = e.message.slice(0, 80); }
  check('a picker opened from the shutter cannot bring the gate back',
    gate3.hidden === true && gate3.items === 1,
    'gate hidden ' + gate3.hidden + ', ' + gate3.items + ' item(s)' +
    (gate3.err ? ', ' + gate3.err : ''));
  await p21.close();

  // The quality row is the only control outside the flip button that calls
  // start(), and unlike the flip, the mode row and the zoom row it had no
  // rec/busy guard. The top bar stays live while a Max-quality burst runs, so a
  // quality tap during a capture tore the camera down underneath snapShot():
  // startId moved on, the old tracks were released and v.srcObject was replaced
  // between the crop being measured and the frame being drawn. A capture owns
  // the camera until it is done; the tap is refused instead.
  const p22 = await browser.newPage();
  await p22.setViewport({ width: 400, height: 840 });
  p22.on('pageerror', e => errors.push('pageerror(quality): ' + e.message));
  p22.on('console', m => { if (m.type() === 'error') errors.push('console(quality): ' + m.text().slice(0, 160)); });
  await p22.goto(URL, { waitUntil: 'load' });
  await wait(2500);
  /* The preview is the precondition of both checks below, and a fixed wait does
     not express it: measured on this pod, the fake device takes 1.3–2.8 s to
     deliver the first frame of a Max-quality stream, so a 2.5 s sleep lands on a
     page with no stream about half the time and the shutter tap is refused with
     "Camera is not ready yet" — the two checks then fail for a reason that has
     nothing to do with what they are about. Wait for the preview itself, keeping
     the same 2.5 s as a floor. */
  for (let i = 0; i < 40; i++) {
    if (await p22.evaluate(() => !!(stream && document.querySelector('#v').videoWidth))) break;
    await wait(250);
  }
  const qswap = await p22.evaluate(async () => {
    const w = ms => new Promise(k => setTimeout(k, ms));
    D.depth = false; E.sharp = false;              // the burst still takes a second to decode
    const id0 = startId, q0 = E.q, n0 = items.length;
    document.querySelector('#shut').click();
    await w(120);
    const heldBusy = busy;
    document.querySelector('#bE').click();         // the engine sheet, while the capture runs
    await w(400);
    document.querySelector('#qseg button[data-q="high"]').click();
    for (let i = 0; i < 150; i++) { await w(100); if (!busy) break; }
    await w(400);
    return { heldBusy, id0, id1: startId, q0, q1: E.q, n0, n1: items.length };
  });
  check('a quality tap cannot swap the camera under a capture in flight',
    qswap.heldBusy === true && qswap.id1 === qswap.id0 && qswap.q1 === qswap.q0,
    'capture held the camera ' + qswap.heldBusy + ', start ' + qswap.id0 + ' -> ' + qswap.id1 +
    ', quality ' + qswap.q0 + ' -> ' + qswap.q1);
  check('the capture interrupted by the quality tap still saves its photo',
    qswap.n1 === qswap.n0 + 1, (qswap.n1 - qswap.n0) + ' photo(s) saved');
  await p22.close();

  // The six on/off rows in Settings and Capture engine showed their state only as
  // a colour on an empty <i class="sw">, which is decoration: the <button> itself
  // carried no state, so a screen reader announced "Water sound, button" whether
  // the sound was on or off. The three top-bar toggles have always maintained
  // aria-pressed; every switch row must now report the state that is actually in
  // effect, from a boot default, a restored preference and a tap alike.
  const SWITCHES = ['#snd', '#t4d', '#eDepth', '#eBurst', '#eSharp', '#eAF'];
  const p25 = await browser.newPage();
  await p25.setViewport({ width: 400, height: 840 });
  p25.on('pageerror', e => errors.push('pageerror(switches): ' + e.message));
  p25.on('console', m => { if (m.type() === 'error') errors.push('console(switches): ' + m.text().slice(0, 160)); });
  // a first run: no saved preference to restore over the authored defaults
  await p25.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
  await p25.goto(URL, { waitUntil: 'load' });
  await wait(1500);
  const swBoot = await p25.evaluate(ids => ids.map(id => {
    const b = document.querySelector(id), w = b.querySelector('.sw');
    return { id, pressed: b.getAttribute('aria-pressed'), on: w.classList.contains('on') };
  }), SWITCHES);
  check('every switch row reports its state at boot',
    swBoot.every(s => s.pressed === 'true' && s.on === true),
    swBoot.map(s => s.id + '=' + s.pressed + (s.on ? '' : '(class off)')).join(' '));
  const swTap = await p25.evaluate(ids => {
    const out = [];
    for (const id of ids) {
      const b = document.querySelector(id);
      b.click();
      const off = { id, pressed: b.getAttribute('aria-pressed'), on: b.querySelector('.sw').classList.contains('on') };
      b.click();
      const back = { id, pressed: b.getAttribute('aria-pressed'), on: b.querySelector('.sw').classList.contains('on') };
      out.push({ off, back });
    }
    return out;
  }, SWITCHES);
  check('a switch row reports the state a tap puts it in',
    swTap.every(r => r.off.pressed === 'false' && r.off.on === false &&
      r.back.pressed === 'true' && r.back.on === true),
    swTap.map(r => r.off.id + ' off=' + r.off.pressed + ' back=' + r.back.pressed).join(' '));
  check('the switch class and the reported state never disagree',
    swTap.every(r => (r.off.pressed === 'true') === r.off.on && (r.back.pressed === 'true') === r.back.on));
  await p25.close();

  // ...and it must report the state *in effect*, not the authored one: under
  // reduced motion the page turns 4D parallax off before the first frame, so its
  // row has to read off while the others read on.
  const p26 = await browser.newPage();
  await p26.setViewport({ width: 400, height: 840 });
  p26.on('pageerror', e => errors.push('pageerror(reduced): ' + e.message));
  p26.on('console', m => { if (m.type() === 'error') errors.push('console(reduced): ' + m.text().slice(0, 160)); });
  await p26.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  // a first run: no saved preference to restore over the reduced-motion default
  await p26.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
  await p26.goto(URL, { waitUntil: 'load' });
  await wait(1500);
  const swReduced = await p26.evaluate(() => {
    const g = id => document.querySelector(id).getAttribute('aria-pressed');
    return { par: g('#t4d'), depth: g('#eDepth'), snd: g('#snd'),
      parOn: document.querySelector('#app').classList.contains('par') };
  });
  check('a switch row under reduced motion reports the state in effect',
    swReduced.par === 'false' && swReduced.parOn === false &&
    swReduced.depth === 'true' && swReduced.snd === 'true',
    '4D=' + swReduced.par + ' (page par ' + swReduced.parOn + '), depth=' + swReduced.depth +
    ', sound=' + swReduced.snd);
  await p26.close();

  // getUserMedia() for the preview was the last await on the camera path with no
  // natural end, and it holds the whole start: a request that neither answers
  // nor fails left the app on a black preview for ever — the gate stays down
  // because nothing failed, no start() is ever retried, and the shutter only
  // says "Camera is not ready yet". That is what an unanswered permission
  // prompt looks like, and a WebView whose request is dropped with its activity.
  // The wait is bounded now (8 s for a granted camera, 20 s for a prompt), the
  // timeout takes the gate's failure path, and a stream that arrives afterwards
  // is stopped on arrival.
  const p27 = await browser.newPage();
  await p27.setViewport({ width: 400, height: 840 });
  const hangErrors = [];
  p27.on('pageerror', e => hangErrors.push('pageerror(hang): ' + e.message));
  p27.on('console', m => { if (m.type() === 'error') hangErrors.push('console(hang): ' + m.text().slice(0, 160)); });
  await p27.evaluateOnNewDocument(() => {
    window.__camAsks = 0; window.__lateStopped = 0; window.__hang = true; window.__late = null;
    const orig = MediaDevices.prototype.getUserMedia;
    MediaDevices.prototype.getUserMedia = function (c) {
      if (window.__hang && c && c.video) {
        // a camera that is asked for and never answers
        window.__camAsks++;
        return new Promise(ok => {
          window.__late = () => ok({
            getTracks: () => [{ stop() { window.__lateStopped++; } }],
            getVideoTracks: () => [], getAudioTracks: () => [],
          });
        });
      }
      return orig.call(this, c);
    };
    navigator.permissions.query = () => Promise.resolve({ state: 'granted' });
  });
  await p27.goto(URL, { waitUntil: 'load' });
  await wait(3000);
  const hangEarly = await p27.evaluate(() => ({
    gate: document.querySelector('#gate').hidden, pending: startPending, asks: window.__camAsks,
  }));
  await wait(6500);
  const hangLate = await p27.evaluate(() => ({
    gate: document.querySelector('#gate').hidden, msg: document.querySelector('#gm').textContent,
    pending: startPending, asks: window.__camAsks,
  }));
  check('a camera request that never answers cannot leave the app on a black preview',
    hangEarly.gate === true && hangEarly.pending !== 0 && hangLate.gate === false &&
    /did not answer/i.test(hangLate.msg) && hangLate.pending === 0,
    'pending ' + hangEarly.pending + ' at 3 s, gate hidden ' + hangLate.gate + ' at 9.5 s, ' +
    JSON.stringify(hangLate.msg.slice(0, 40)));
  const hangBack = await p27.evaluate(async () => {
    const w = ms => new Promise(k => setTimeout(k, ms));
    window.__hang = false;
    if (window.__late) window.__late();          // the prompt is answered after the bound
    await w(300);
    document.querySelector('#gb').click();       // the gate's own retry
    for (let i = 0; i < 60; i++) { await w(100); if (stream && v.videoWidth > 0) break; }
    // the fade-in is a CSS transition that starts once play() has resolved
    for (let i = 0; i < 40; i++) { if (+getComputedStyle(v).opacity > 0.9) break; await w(100); }
    return { gate: document.querySelector('#gate').hidden, vw: v.videoWidth,
      op: +getComputedStyle(v).opacity, late: window.__lateStopped };
  });
  check('the gate brings the camera back after a request that timed out',
    hangBack.gate === true && hangBack.vw > 0 && hangBack.op > 0.9,
    hangBack.vw + 'px, opacity ' + hangBack.op);
  check('a camera stream that arrives after the bound is stopped',
    hangBack.late >= 1, hangBack.late + ' late stream(s) stopped');
  check('no errors from the camera request that never answered',
    hangErrors.length === 0, hangErrors.slice(0, 2).join(' | '));
  await p27.close();

  check('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e.message); process.exit(2); });
