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
function makeCtx() {
  const gradient = { addColorStop() {} };
  return new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return makeCanvas();
      if (k === 'fillRect') return (...a) => { fillRects.push(a); };
      if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => gradient;
      if (typeof k === 'string') return () => {};
      return undefined;
    },
    set() { return true; }
  });
}
function makeCanvas() {
  return { width: 0, height: 0, style: {}, getContext: () => makeCtx(), addEventListener() {}, __canvas: true };
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
    getContext() { return makeCtx(); },
    click() {}
  };
  return el;
}

const byId = {};
['scene', 'progress', 'hud', 'pool', 'rate-num', 'rate-label', 'history', 'gen-slider', 'gen-val', 'panel', 'panel-head', 'panel-arrow', 'sources', 'harvest', 'sysline', 'hint'].forEach(id => { byId[id] = makeEl(id); });
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
let gridMaxCells = 0;
let maxBadCells = 0;
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

// simulate frames
if (!failed && rafCb) {
  let now = performance.now();
  const modes = ['grid', 'particles', 'noise', 'rain'];
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
    if (f === 100) { (globalListeners.keydown || []).forEach(fn => fn({ key: '2', keyCode: 50 })); modeIdx = 1; }
    if (f === 200) { (globalListeners.keydown || []).forEach(fn => fn({ key: '3', keyCode: 51 })); modeIdx = 2; }
    if (f === 300) { (globalListeners.keydown || []).forEach(fn => fn({ key: '4', keyCode: 52 })); modeIdx = 3; }
    try { rafCb(now); }
    catch (e) {
      errors.push('frame ' + f + ' [' + modes[modeIdx] + ']: ' + e.message);
      console.error('FRAME ERROR:', errors[errors.length - 1]);
      failed = true;
      break;
    }
    const gsz = vm.runInContext('grid.cells.size', sandbox);
    if (gsz > gridMaxCells) gridMaxCells = gsz;
    const badCells = vm.runInContext('Array.from(grid.cells.values()).filter(v=>!(typeof v.key === "number" && isFinite(v.key))).length', sandbox);
    if (badCells > maxBadCells) maxBadCells = badCells;
  }
  if (!failed) console.log('FRAMES OK (' + frames + ' frames, all modes)');
}

// verify every fillRect got finite numeric coordinates (grid cells must be visible)
if (!failed) {
  if (maxBadCells > 0) {
    console.error('BAD CELL KEYS: ' + maxBadCells + ' cells had non-numeric keys (prng out-of-bounds bug)');
    failed = true;
  } else {
    console.log('CELL KEYS OK (all ' + gridMaxCells + ' peak cells have valid numeric keys)');
  }
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
    for (let i = 0; i < 8; i++) rafCb(performance.now() + i * 16.6);
    const boiled = vm.runInContext('JSON.stringify(Array.from(grain.img.data))', sandbox);
    if (boiled !== base) console.log('NOISE BOIL OK (static changes with entropy present)');
    else { console.error('NOISE BOIL FAILED: static unchanged at E=0.5'); failed = true; }
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

// pointer-only scenario: mouse moving raises E, then stopping the mouse must
// decay the pointer rate and freeze the field (no stale-rate boiling)
if (!failed) {
  try {
    vm.runInContext('mode = "noise"; srcList.forEach(s => s.enabled = false); SRC.pointer.enabled = true; E = 0', sandbox);
    const hudTicks = intervals.filter(iv => iv.ms === 250);
    // move the mouse: 300 events with realistic jittered timing, HUD ticks every 12 events
    for (let i = 0; i < 300; i++) {
      clock.t += 8 + (i % 5); // jittered inter-event gap, like a real mouse
      (globalListeners.pointermove || []).forEach(fn => fn({ clientX: 100 + i * 2, clientY: 200 + (i % 9) * 5 }));
      if (i % 12 === 0) { clock.t += 250; hudTicks.forEach(iv => { try { iv.fn(); } catch (e) {} }); }
    }
    clock.t += 250; hudTicks.forEach(iv => { try { iv.fn(); } catch (e) {} });
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

// verify grid actually populated during its time in grid mode (frames 0-100)
if (!failed) {
  try {
    if (gridMaxCells >= 30) {
      console.log('GRID POPULATION OK (' + gridMaxCells + ' cells alive at peak)');
    } else {
      console.error('GRID POPULATION FAILED: peak=' + gridMaxCells);
      failed = true;
    }
  } catch (e) {
    console.error('GRID CHECK ERROR:', e.message);
    failed = true;
  }
}

// verify pause toggles
if (!failed) {
  try {
    vm.runInContext("togglePause()", sandbox);
    const p1 = vm.runInContext('paused', sandbox);
    vm.runInContext("togglePause()", sandbox);
    const p2 = vm.runInContext('paused', sandbox);
    if (p1 === true && p2 === false) console.log('PAUSE TOGGLE OK');
    else { console.error('PAUSE TOGGLE FAILED:', p1, p2); failed = true; }
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
