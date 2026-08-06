// Headless smoke test for index.html — runs the inline script with stubbed browser APIs.
'use strict';
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('/home/grigio/Code/entropy-viz/index.html', 'utf8');
const TEST_W = +(process.env.TEST_W || 900), TEST_H = +(process.env.TEST_H || 700);
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
if (!script) { console.error('NO SCRIPT'); process.exit(1); }

/* ---------- stubs ---------- */
const fillRects = [];
const fillTexts = [];
const ctxStyles = [];
const drawImages = [];
function ensureData(state) {
  if (!state.data && state.width && state.height) {
    state.data = new Uint8ClampedArray(state.width * state.height * 4);
  }
  return state.data;
}
function rasterize(state, text, x, y) {
  const d = ensureData(state);
  if (!d || !text) return;
  const w = state.width, h = state.height;
  const half = Math.floor(String(text).length * 6);
  const bx = Math.floor(x), by = Math.floor(y);
  for (let dx = -half; dx <= half; dx++) {
    for (let dy = -10; dy <= 4; dy++) {
      const px = bx + dx, py = by + dy;
      if (px >= 0 && px < w && py >= 0 && py < h) {
        const o = (py * w + px) * 4;
        d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = 255;
      }
    }
  }
}
function clearRegion(state, x, y, w, h) {
  const d = ensureData(state);
  if (!d) return;
  for (let py = Math.max(0, Math.floor(y)); py < Math.min(state.height, Math.ceil(y + h)); py++) {
    for (let px = Math.max(0, Math.floor(x)); px < Math.min(state.width, Math.ceil(x + w)); px++) {
      const o = (py * state.width + px) * 4;
      d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 0;
    }
  }
}
function makeCtx(state) {
  const gradient = { addColorStop() {} };
  return new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return makeCanvas();
      if (k === 'fillRect') return (x, y, w, h) => { fillRects.push([x, y, w, h]); if (state.data) clearRegion(state, x, y, w, h); };
      if (k === 'clearRect') return (x, y, w, h) => { if (state.data) clearRegion(state, x, y, w, h); };
      if (k === 'fillText') return (text, x, y) => { fillTexts.push([text, x, y]); rasterize(state, text, x, y); };
      if (k === 'drawImage') return (...a) => { drawImages.push(a); };
      if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'putImageData') return (img) => { state.data = img.data.slice(); state.width = img.width; state.height = img.height; };
      if (k === 'getImageData') return (x, y, w, h) => {
        const data = state.data ? state.data.slice() : new Uint8ClampedArray(w * h * 4);
        return { data, width: state.width || w, height: state.height || h };
      };
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => gradient;
      if (typeof k === 'string') return () => {};
      return undefined;
    },
    set(t, k, v) { if (k === 'fillStyle') ctxStyles.push(v); return true; }
  });
}
function makeCanvas() {
  const state = { width: 0, height: 0, data: null };
  const canvas = {
    style: {},
    addEventListener() {},
    __state: state,
    get width() { return state.width; },
    set width(v) { state.width = v | 0; },
    get height() { return state.height; },
    set height(v) { state.height = v | 0; },
    getContext: () => makeCtx(state)
  };
  return canvas;
}
function makeEl(tag) {
  const el = {
    tag,
    style: {},
    dataset: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, f) {
        if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }
        else { f ? this._s.add(c) : this._s.delete(c); }
        return this._s.has(c);
      },
      contains(c) { return this._s.has(c); }
    },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    dispatch(type, ev) { (this.listeners[type] || []).forEach(fn => fn(ev || {})); },
    appendChild() {},
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html || ''; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text || ''; },
    set value(v) { this._value = v; },
    get value() { return this._value; },
    querySelector() { return makeEl('span'); },
    querySelectorAll() { return []; },
    getContext() { return makeCtx({ width: 0, height: 0, data: null }); },
    click() {}
  };
  return el;
}

const byId = {};
['scene', 'progress', 'hud', 'pool', 'rate-num', 'rate-label', 'history', 'gen-slider', 'gen-val', 'panel', 'panel-head', 'panel-arrow', 'sources', 'harvest', 'sysline', 'hint', 'pause-btn'].forEach(id => { byId[id] = makeEl(id); });
const doc = {
  querySelector: sel => byId[sel.slice(1)] || makeEl('div'),
  querySelectorAll: () => [makeEl('button'), makeEl('button'), makeEl('button'), makeEl('button')],
  createElement: tag => tag === 'canvas' ? makeCanvas() : makeEl(tag),
  addEventListener(type, fn) { (this.listeners = this.listeners || {})[type] = (this.listeners[type] || []).concat(fn); }
};

const win = {
  innerWidth: TEST_W,
  innerHeight: TEST_H,
  devicePixelRatio: 1,
  addEventListener(type, fn) { (this.listeners = this.listeners || {})[type] = (this.listeners[type] || []).concat(fn); }
};

let rafCb = null;
// controllable clock so the harness can simulate the passage of time
const clock = { t: performance.now() };
const performanceStub = { now: () => clock.t };
const intervals = [], timeouts = [];
const globalListeners = {};
// helper: run the non-CPU interval callbacks (CPU probe spins on wall clock)
function runIntervals() {
  intervals.forEach(iv => { if (iv.ms === 1000) return; try { iv.fn(); } catch (e) { throw e; } });
}
const sandbox = {
  window: win,
  document: doc,
  navigator: { hardwareConcurrency: 8, deviceMemory: 8, onLine: true, getBattery: undefined },
  performance: performanceStub,
  crypto: globalThis.crypto,
  requestAnimationFrame: cb => { rafCb = cb; return 1; },
  matchMedia: () => ({ matches: TEST_W <= 640 }),
  addEventListener: (type, fn) => { (globalListeners[type] = globalListeners[type] || []).push(fn); },
  Image: function () { this.onload = null; this.onerror = null; },
  setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
  setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
  clearInterval: () => {},
  clearTimeout: () => {},
  devicePixelRatio: 1,
  innerWidth: TEST_W,
  innerHeight: TEST_H,
  Math, Float64Array, Float32Array, Uint32Array, Uint8Array, Uint8ClampedArray, Int32Array, Int16Array,
  Map, Set, Array, Object, Number, String, Boolean, Date, JSON, Symbol, Proxy, Reflect,
  console, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const errors = [];
let failed = false;
try {
  vm.runInContext(script, sandbox, { filename: 'index-inline.js' });
  console.log('INIT OK');
} catch (e) {
  console.error('INIT ERROR:', e.message, '\n', e.stack.split('\n').slice(0, 4).join('\n'));
  failed = true;
}

// initial noise must be full black (all RGB channels zero) right after init
if (!failed) {
  try {
    const blackPct = vm.runInContext('(function(){ const d=grain.img.data; let nz=0; for(let i=0;i<d.length;i+=4) if(d[i]||d[i+1]||d[i+2]) nz++; return (1 - nz/(d.length/4)) * 100; })()', sandbox);
    if (blackPct > 99.9) {
      console.log('NOISE INIT BLACK OK (' + blackPct.toFixed(1) + '% black pixels)');
    } else {
      console.error('NOISE INIT BLACK FAILED: only ' + blackPct.toFixed(1) + '% black pixels');
      failed = true;
    }
  } catch (e) { console.error('NOISE INIT BLACK CHECK ERROR:', e.message); failed = true; }
}

// CHAOS art: the black canvas must start with the white ASCII art baked into a
// full-res art layer (drawn at reset), and that layer must deteriorate gradually
// as entropy arrives rather than vanishing instantly.
if (!failed) {
  try {
    // a few pristine frames to exercise the draw path
    for (let i = 0; i < 3; i++) rafCb(performance.now() + i * 16.6);
    const artCount = fillTexts.filter(a => String(a[0]).length > 20).length; // art lines are 41 chars; rain glyphs are 1
    const whiteUsed = ctxStyles.includes('#ffffff');
    const leftFresh = vm.runInContext('art.remaining', sandbox);
    if (artCount >= 5 && whiteUsed && leftFresh > 0) {
      console.log('NOISE CHAOS ART OK (' + artCount + ' ASCII lines, ' + leftFresh + ' art pixels, white)');
    } else {
      console.error('NOISE CHAOS ART FAILED: lines=' + artCount + ' white=' + whiteUsed + ' artPixels=' + leftFresh);
      failed = true;
    }
  } catch (e) { console.error('NOISE CHAOS ART CHECK ERROR:', e.message); failed = true; }
}

// simulate frames
if (!failed && rafCb) {
  let now = performance.now();
  const modes = ['noise', 'particles'];
  let modeIdx = 0;
  const frames = 400;
  for (let f = 0; f < frames; f++) {
    now += 16.6;
    // exercise events periodically
    if (f % 60 === 0) {
      (globalListeners.pointermove || []).forEach(fn => fn({ clientX: 100 + f % 500, clientY: 200 + f % 400 }));
      (globalListeners.keydown || []).forEach(fn => fn({ key: 'a', keyCode: 65 }));
      // run harvester + HUD ticks so entropy E rises during the simulation
      runIntervals();
    }
    if (f === 150) { (globalListeners.keydown || []).forEach(fn => fn({ key: '2', keyCode: 50 })); modeIdx = 1; }
    try { rafCb(now); }
    catch (e) {
      errors.push('frame ' + f + ' [' + modes[modeIdx] + ']: ' + e.message);
      console.error('FRAME ERROR:', errors[errors.length - 1]);
      failed = true;
      break;
    }
  }
  if (!failed) console.log('FRAMES OK (' + frames + ' frames, all modes)');
}

// verify every fillRect got finite numeric coordinates
if (!failed) {
  const bad = fillRects.filter(a => a.slice(0, 4).some(v => typeof v !== 'number' || !isFinite(v)));
  if (bad.length === 0) {
    console.log('FILLRECT COORDS OK (' + fillRects.length + ' draw calls, all finite)');
  } else {
    console.error('FILLRECT COORD BUG: ' + bad.length + ' bad calls, e.g. ' + JSON.stringify(bad[0]));
    failed = true;
  }
}

// verify the grain palette spans the full hue wheel (noise view full color range)
if (!failed) {
  try {
    const palCheck = vm.runInContext('(function(){ let maxH=0, seen=[]; for(let i=0;i<256;i++){ const p=i*3; const r=grainPal[p], g=grainPal[p+1], b=grainPal[p+2]; const mx=Math.max(r,g,b), mn=Math.min(r,g,b); let h; if(mx===mn) h=0; else if(mx===r) h=60*(((g-b)/(mx-mn))%6); else if(mx===g) h=60*((b-r)/(mx-mn)+2); else h=60*((r-g)/(mx-mn)+4); if(h<0) h+=360; seen[Math.floor(h/30)]=true; } return seen.filter(Boolean).length; })()', sandbox);
    if (palCheck >= 12) {
      console.log('GRAIN PALETTE OK (all 12 hue sectors covered)');
    } else {
      console.error('GRAIN PALETTE FAILED: only ' + palCheck + ' hue sectors covered');
      failed = true;
    }
  } catch (e) { console.error('GRAIN PALETTE CHECK ERROR:', e.message); failed = true; }
}

// verify the noise field boils with entropy present and freezes when all sources are disabled
if (!failed) {
  try {
    vm.runInContext('mode = "noise"', sandbox);
    // A) with entropy present the static must boil (change between frames)
    vm.runInContext('E = 0.5', sandbox);
    const base = vm.runInContext('JSON.stringify(Array.from(grain.img.data))', sandbox);
    for (let i = 0; i < 40; i++) rafCb(performance.now() + i * 16.6);
    const boiled = vm.runInContext('JSON.stringify(Array.from(grain.img.data))', sandbox);
    if (boiled !== base) console.log('NOISE BOIL OK (static changes with entropy present)');
    else { console.error('NOISE BOIL FAILED: static unchanged at E=0.5'); failed = true; }
    // the static must eventually cover every cell: no permanent black gaps
    const coverPct = vm.runInContext('(function(){ const d=grain.img.data; let nz=0; for(let i=0;i<d.length;i+=4) if(d[i]||d[i+1]||d[i+2]) nz++; return nz/(d.length/4)*100; })()', sandbox);
    if (coverPct > 99) {
      console.log('NOISE FULL COVERAGE OK (' + coverPct.toFixed(2) + '% cells colored)');
    } else {
      console.error('NOISE FULL COVERAGE FAILED: only ' + coverPct.toFixed(2) + '% colored (gaps remain)');
      failed = true;
    }
    // B) all sources disabled -> E decays below threshold -> field freezes bit-for-bit
    vm.runInContext('srcList.forEach(s => s.enabled = false)', sandbox);
    for (let i = 0; i < 20; i++) intervals.forEach(iv => { try { iv.fn(); } catch (e) {} });
    const eVal = vm.runInContext('E', sandbox);
    const frozen1 = vm.runInContext('JSON.stringify(Array.from(grain.img.data))', sandbox);
    for (let i = 0; i < 20; i++) rafCb(performance.now() + 1000 + i * 16.6);
    const frozen2 = vm.runInContext('JSON.stringify(Array.from(grain.img.data))', sandbox);
    if (eVal < 0.005 && frozen1 === frozen2) {
      console.log('NOISE FREEZE OK (E=' + eVal.toFixed(4) + ', static frozen)');
    } else {
      console.error('NOISE FREEZE FAILED: E=' + eVal + ', changed=' + (frozen1 !== frozen2));
      failed = true;
    }
    vm.runInContext('srcList.forEach(s => s.enabled = true)', sandbox);
  } catch (e) { console.error('NOISE FREEZE CHECK ERROR:', e.message); failed = true; }
}

// the noise grain must be drawn with uniform scale so colored squares never stretch
if (!failed) {
  try {
    const scale = vm.runInContext('grain.scale', sandbox);
    const gw = vm.runInContext('grain.cw', sandbox), gh = vm.runInContext('grain.ch', sandbox);
    const sqDraw = drawImages.filter(a => a.length >= 5 && Math.abs(a[3] - gw * scale) < 0.001 && Math.abs(a[4] - gh * scale) < 0.001).length;
    if (sqDraw >= 1) {
      console.log('SQUARE PIXELS OK (uniform cover scale ' + scale.toFixed(2) + ')');
    } else {
      console.error('SQUARE PIXELS FAILED: no uniform-scale grain draw found');
      failed = true;
    }
  } catch (e) { console.error('SQUARE PIXELS CHECK ERROR:', e.message); failed = true; }
}

// all particles must be drawn at the same 2x2 size (only tiny dot draws count;
// full-screen background fills are larger by design)
if (!failed) {
  const smallDraws = fillRects.filter(a => a.length === 4 && a[2] <= 4 && a[3] <= 4);
  const dot2 = smallDraws.filter(a => a[2] === 2 && a[3] === 2).length;
  const non2 = smallDraws.filter(a => !(a[2] === 2 && a[3] === 2)).length;
  if (dot2 > 0 && non2 === 0) {
    console.log('PARTICLE SIZE OK (' + dot2 + ' dot draws, all exactly 2x2)');
  } else {
    console.error('PARTICLE SIZE FAILED: 2x2=' + dot2 + ' otherSmall=' + non2);
    failed = true;
  }
}

// CHAOS art must deteriorate gradually with entropy: protected during the hold
// window, then eroded pixel by pixel to nothing (never vanishing in one frame)
if (!failed) {
  try {
    vm.runInContext('mode = "noise"; artReset(); E = 0.5', sandbox);
    const leftFresh = vm.runInContext('art.remaining', sandbox);
    const baseT = performance.now();
    // inside the hold window the art is untouched even at high entropy
    for (let i = 0; i < 10; i++) rafCb(baseT + i * 16.6);
    const leftHold = vm.runInContext('art.remaining', sandbox);
    // past the hold window the art erodes frame by frame until it is gone
    for (let i = 0; i < 150; i++) rafCb(baseT + 4000 + i * 16.6);
    const leftAfter = vm.runInContext('art.remaining', sandbox);
    const holdOK = leftHold === leftFresh;
    const eroded = leftAfter < leftFresh / 2; // pixels landing erased a big share
    if (leftFresh > 0 && holdOK && eroded) {
      console.log('NOISE CHAOS DETERIORATE OK (' + leftFresh + ' -> hold ' + leftHold + ' -> ' + leftAfter + ')');
    } else {
      console.error('NOISE CHAOS DETERIORATE FAILED: fresh=' + leftFresh + ' hold=' + leftHold + ' after=' + leftAfter);
      failed = true;
    }
  } catch (e) { console.error('NOISE CHAOS DETERIORATE CHECK ERROR:', e.message); failed = true; }
}

// particles view mirrors the noise view: CHAOS formed by anchored white particles
// that dissolve as entropy flows, and the pointer paints particles directly
if (!failed) {
  try {
    vm.runInContext('mode = "particles"; artReset(); partReset(); chaosReset()', sandbox);
    const cFresh = vm.runInContext('chaos.n', sandbox);
    // pointer paints particles directly in this mode (no frames running)
    const partBefore = vm.runInContext('part.n', sandbox);
    (globalListeners.pointermove || []).forEach(fn => fn({ clientX: 300, clientY: 300 }));
    const partAfter = vm.runInContext('part.n', sandbox);
    // entropy releases the anchored art particles (deterioration)
    vm.runInContext('E = 0.5', sandbox);
    for (let i = 0; i < 60; i++) rafCb(performance.now() + 4000 + i * 16.6);
    const cFree = vm.runInContext('(function(){ let f=0; for(let i=0;i<chaos.n;i++) if(chaos.free[i]) f++; return f; })()', sandbox);
    if (cFresh > 0 && partAfter > partBefore && cFree > 0) {
      console.log('PARTICLES CHAOS OK (' + cFresh + ' anchored, ' + cFree + ' released, pointer spawned ' + (partAfter - partBefore) + ')');
    } else {
      console.error('PARTICLES CHAOS FAILED: fresh=' + cFresh + ' spawned=' + (partAfter - partBefore) + ' free=' + cFree);
      failed = true;
    }
    vm.runInContext('E = 0', sandbox);
  } catch (e) { console.error('PARTICLES CHAOS CHECK ERROR:', e.message); failed = true; }
}

// pointer-only scenario: mouse moving raises E, then stopping the mouse must
// decay the pointer rate and freeze the field (no stale-rate boiling)
if (!failed) {
  try {
    vm.runInContext('mode = "noise"; srcList.forEach(s => s.enabled = false); SRC.pointer.enabled = true; E = 0', sandbox);
    const hudTicks = intervals.filter(iv => iv.ms === 250);
    // snapshot before any movement: with no frames running, only direct painting
    // can change the grain, so any difference proves the pointer paints on canvas
    const paintBefore = vm.runInContext('JSON.stringify(Array.from(grain.img.data))', sandbox);
    // move the mouse: 300 events with realistic jittered timing, HUD ticks every 12 events
    for (let i = 0; i < 300; i++) {
      clock.t += 8 + (i % 5); // jittered inter-event gap, like a real mouse
      (globalListeners.pointermove || []).forEach(fn => fn({ clientX: 100 + i * 2, clientY: 200 + (i % 9) * 5 }));
      if (i % 12 === 0) { clock.t += 250; hudTicks.forEach(iv => { try { iv.fn(); } catch (e) {} }); }
    }
    clock.t += 250; hudTicks.forEach(iv => { try { iv.fn(); } catch (e) {} });
    const paintAfter = vm.runInContext('JSON.stringify(Array.from(grain.img.data))', sandbox);
    const painted = paintAfter !== paintBefore;
    if (!painted) { console.error('POINTER PAINT FAILED: grain unchanged after mouse movement'); failed = true; }
    else console.log('POINTER PAINT OK (direct colored squares left on canvas)');
    const eHigh = vm.runInContext('E', sandbox);
    const pbHigh = vm.runInContext('SRC.pointer.bps', sandbox);
    // mouse stops: advance the clock through decay ticks only (field untouched)
    for (let i = 0; i < 40; i++) { clock.t += 250; hudTicks.forEach(iv => { try { iv.fn(); } catch (e) {} }); }
    const eLow = vm.runInContext('E', sandbox);
    const pbLow = vm.runInContext('SRC.pointer.bps', sandbox);
    const frozen1 = vm.runInContext('JSON.stringify(Array.from(grain.img.data))', sandbox);
    for (let i = 0; i < 20; i++) { clock.t += 16.6; rafCb(clock.t); }
    const frozen2 = vm.runInContext('JSON.stringify(Array.from(grain.img.data))', sandbox);
    if (eHigh > 0.005 && pbHigh > 30 && pbLow < 50 && eLow < 0.005 && frozen1 === frozen2) {
      console.log('POINTER IDLE DECAY OK (bps ' + Math.round(pbHigh) + ' -> ' + pbLow.toExponential(1) + ', E ' + eHigh.toFixed(3) + ' -> ' + eLow.toExponential(1) + ', frozen)');
    } else {
      console.error('POINTER IDLE DECAY FAILED: eHigh=' + eHigh + ' pbHigh=' + pbHigh + ' pbLow=' + pbLow + ' eLow=' + eLow + ' changed=' + (frozen1 !== frozen2));
      failed = true;
    }
    vm.runInContext('srcList.forEach(s => s.enabled = true)', sandbox);
  } catch (e) { console.error('POINTER IDLE DECAY CHECK ERROR:', e.message); failed = true; }
}

// verify pause toggles via a real click on the button (wiring, not just the fn)
if (!failed) {
  try {
    byId['pause-btn'].dispatch('click');
    const p1 = vm.runInContext('paused', sandbox);
    byId['pause-btn'].dispatch('click');
    const p2 = vm.runInContext('paused', sandbox);
    const iconPaused = byId['pause-btn'].textContent === '\u25b6'; // play icon while paused
    if (p1 === true && p2 === false && iconPaused === false) console.log('PAUSE CLICK OK (toggles and restores icon)');
    else { console.error('PAUSE CLICK FAILED:', p1, p2, 'iconPaused=' + iconPaused); failed = true; }
  } catch (e) { console.error('PAUSE CHECK ERROR:', e.message); failed = true; }
}

// HUD ticks
if (!failed) {
  try {
    for (let i = 0; i < 5; i++) intervals.forEach(iv => { try { iv.fn(); } catch (e) { throw e; } });
    console.log('HUD TICKS OK');
  } catch (e) {
    console.error('HUD TICK ERROR:', e.message);
    failed = true;
  }
}

// slider input
if (!failed) {
  try {
    const slider = byId['gen-slider'];
    slider._value = 30;
    slider.dispatch('input');
    console.log('SLIDER OK');
  } catch (e) { console.error('SLIDER ERROR:', e.message); failed = true; }
}

process.exit(failed ? 1 : 0);
