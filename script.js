// ---------- Settings ----------
// Teaching mode is a small fully associative cache that is easy to follow. Real mode models the
// performance cores of an Apple M5: 128-byte lines holding 16 doubles, an 8-way L1 data cache of
// 128 KB and an 8-way L2 of 16 MB. Line size and cache sizes come from `sysctl` on an M5; the
// number of ways and the cycle costs are assumptions.
const MODES = {
  teaching: {
    L: 4,                                  // values per cache line
    defaultN: 16, maxN: 1024,
    tiles: [2, 4, 8], defaultT: 4,
    blurb: 'A tiny fully associative LRU cache, 4 values per line, so every hit and miss is easy to see.',
  },
  real: {
    L: 16,                                 // 128-byte line of 8-byte doubles
    defaultN: 256, maxN: 512,
    tiles: [8, 16, 32, 64, 128], defaultT: 32,
    l1: { sets: 128, ways: 8 },            // 128 sets x 8 ways x 128 B = 128 KB
    l2: { sets: 16384, ways: 8 },          // 16384 sets x 8 ways x 128 B = 16 MB
    cycles: [4, 18, 350],                  // rough cost of an L1 hit, an L2 hit and a DRAM access
    blurb: 'An L1 + L2 hierarchy shaped like an M5 performance core: 128-byte lines, set-associative, LRU.',
  },
};

const METHODS = [['Basic', 'ijk'], ['Reordering', 'ikj'], ['Tiled', 'tile']];
const METHOD_DESC = {
  ijk: 'Textbook triple loop. For every C[i][j] it walks down a column of B, so each step lands on a different cache line.',
  ikj: 'Swaps the two inner loops. Now B and C are both walked along rows, so every line that gets loaded is fully used.',
  tile: 'Works on small T×T blocks of each matrix at a time, so the block being used stays in the cache while it is reused.',
};

// Values from the start of one matrix to the next: N * N rounded up to a whole cache line,
// so every matrix starts on a fresh line.
const strideFor = (N, L) => Math.ceil(N * N / L) * L;

// ---------- State ----------
let mode = 'teaching';
let L = MODES.teaching.L;  // values per cache line
let T = MODES.teaching.defaultT; // tile size for the tiled method
let N = 16;                // matrices are N × N, set from the page
let STRIDE = strideFor(N, L);
let method = 'ijk';        // 'ijk' | 'ikj' | 'tile'
let CAP = 16;              // teaching cache capacity in lines
let gen = null;            // hands out the current run's accesses, a chunk at a time
let chunk = null;          // the chunk gen last filled
let chunkLen = 0, chunkPos = 0;
let total = 0;             // how many accesses the whole run makes
let pos = 0;               // how many accesses we have simulated so far
let sim = null;            // the simulated cache: { touch(line) -> level, l1, l2 }
let counts = [0, 0, 0];    // accesses served by L1, L2, DRAM (teaching: hit, unused, miss)
let perMatrix = [0, 0, 0]; // misses for A, B, C
let playing = false;
let speed = 12;            // accesses per animation frame; below 1 means one access every 1/speed frames
let idle = 0;              // frames since the last access, used when slower than 1 per frame
let dirty = true;          // the canvas needs redrawing

// For drawing: when each address was last touched, plus a ring of the most recent accesses
let lastTime = null;
const RECENT = 4096;                       // the most accesses a fade can span
const recentAddr = new Int32Array(RECENT); // access number t is stored at t % RECENT
const recentHit = new Uint8Array(RECENT);  // which level served access t: 0 = L1, 1 = L2, 2 = DRAM

// Everything the simulation needs, in a form that can be posted to a worker
function config() {
  const m = MODES[mode];
  return {
    mode, L, T, cap: CAP,
    l1Sets: m.l1?.sets, l1Ways: m.l1?.ways, l2Sets: m.l2?.sets, l2Ways: m.l2?.ways,
  };
}

// ---------- 1. Build the access sequence ----------
// Each access is a memory address, counted in values. Matrix M (0 = A, 1 = B, 2 = C) starts at
// M * stride, and its element [r][c] is r * N + c after that. Address / L is the cache line.
//
// A run makes about 2N³ accesses, billions at N = 1024, too many to store. So this generator
// fills buf with the accesses of one inner loop at a time and yields how many it wrote.
function* accessChunks(m, N, buf, L, T) {
  const stride = Math.ceil(N * N / L) * L;
  let n = 0;
  const add = (M, r, c) => { buf[n++] = M * stride + r * N + c; };

  if (m === 'ijk') {
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        for (let k = 0; k < N; k++) {
          add(0, i, k);          // A[i][k]
          add(1, k, j);          // B[k][j]
        }
        add(2, i, j);            // C[i][j] written once, it was in a register
        yield n; n = 0;
      }
  } else if (m === 'ikj') {
    for (let i = 0; i < N; i++)
      for (let k = 0; k < N; k++) {
        add(0, i, k);            // A[i][k] loaded once into a register
        for (let j = 0; j < N; j++) {
          add(1, k, j);          // B[k][j]
          add(2, i, j);          // C[i][j] read + write (same line, counted once)
        }
        yield n; n = 0;
      }
  } else {
    // Math.min cuts the last tile short when N isn't a multiple of T
    for (let ii = 0; ii < N; ii += T)
      for (let kk = 0; kk < N; kk += T)
        for (let jj = 0; jj < N; jj += T)
          for (let i = ii; i < Math.min(ii + T, N); i++)
            for (let k = kk; k < Math.min(kk + T, N); k++) {
              add(0, i, k);
              for (let j = jj; j < Math.min(jj + T, N); j++) {
                add(1, k, j);
                add(2, i, j);
              }
              yield n; n = 0;
            }
  }
}

// How many accesses a run makes: 2 per multiply-add, plus one per inner loop
// (C for i, j, k; A for the others). The tiled method runs its inner loop once per j-tile.
function totalAccesses(m, N, T) {
  const innerLoops = m === 'tile' ? N * N * Math.ceil(N / T) : N * N;
  return 2 * N ** 3 + innerLoops;
}

// ---------- 2. The caches ----------
// Fully associative with LRU eviction, kept as a doubly linked list of lines, most recent first.
// The links live in typed arrays indexed by line number, so each access is a few array writes,
// fast enough for the billions of accesses in a full run at N = 1024.
class LRU {
  constructor(lines, cap) {
    this.cap = cap;
    this.size = 0;
    this.head = lines;                    // index `lines` is the list's sentinel node
    this.prev = new Int32Array(lines + 1).fill(lines);
    this.next = new Int32Array(lines + 1).fill(lines);
    this.cached = new Uint8Array(lines);
  }

  has(line) { return this.cached[line] === 1; }

  // Returns true for a hit, false for a miss.
  access(line) {
    const { prev, next, cached, head } = this;
    const hit = cached[line] === 1;
    if (hit) {
      next[prev[line]] = next[line];      // unlink, to move it to the front below
      prev[next[line]] = prev[line];
    } else {
      cached[line] = 1;                   // miss: load the line
      if (this.size === this.cap) {
        const old = prev[head];           // evict least recently used, at the back
        cached[old] = 0;
        next[prev[old]] = head;
        prev[head] = prev[old];
      } else {
        this.size++;
      }
    }
    next[line] = next[head];              // insert at the front
    prev[line] = head;
    prev[next[head]] = line;
    next[head] = line;
    return hit;
  }

  *lines() {
    for (let l = this.next[this.head]; l !== this.head; l = this.next[l]) yield l;
  }
}

// Set-associative with LRU inside each set, like real hardware: a line can only live in the set
// its address maps to (line number mod sets). Each set keeps its `ways` tags most recent first.
class SetAssoc {
  constructor(sets, ways) {
    this.ways = ways;
    this.mask = sets - 1;                 // sets is a power of two
    this.tags = new Int32Array(sets * ways).fill(-1);
  }

  // Returns true for a hit, false for a miss.
  access(line) {
    const { tags, ways } = this;
    const base = (line & this.mask) * ways;
    let i = 0;
    while (i < ways && tags[base + i] !== line) i++;
    const hit = i < ways;
    if (!hit) i = ways - 1;               // miss: the least recently used tag, at the back, is dropped
    for (; i > 0; i--) tags[base + i] = tags[base + i - 1];
    tags[base] = line;                    // either way, this line is now the most recent
    return hit;
  }

  *lines() {
    const t = this.tags;
    for (let i = 0; i < t.length; i++) if (t[i] >= 0) yield t[i];
  }
}

// Builds the cache for a run. touch(line) returns which level served the access:
// 0 = L1 (or a hit in teaching mode), 1 = L2, 2 = DRAM (or a miss in teaching mode).
function makeSim(cfg, nLines) {
  if (cfg.mode === 'teaching') {
    const l1 = new LRU(nLines, cfg.cap);
    return { l1, l2: null, touch: line => (l1.access(line) ? 0 : 2) };
  }
  const l1 = new SetAssoc(cfg.l1Sets, cfg.l1Ways);
  const l2 = new SetAssoc(cfg.l2Sets, cfg.l2Ways);
  // L2 only sees what L1 missed, which is how a real hierarchy is fed
  return { l1, l2, touch: line => (l1.access(line) ? 0 : l2.access(line) ? 1 : 2) };
}

function fullRun(m, N, cfg) {
  const L = cfg.L;
  const touch = makeSim(cfg, 3 * strideFor(N, L) / L).touch;
  const buf = new Int32Array(2 * N + 1);
  const counts = [0, 0, 0];
  let done = 0, nextReport = 0;
  for (const n of accessChunks(m, N, buf, L, cfg.T)) {
    for (let q = 0; q < n; q++) counts[touch(Math.floor(buf[q] / L))]++;
    done += n;
    if (done >= nextReport) { postMessage({ done }); nextReport += 1 << 24; }
  }
  postMessage({ done, counts });
}

const workerURL = URL.createObjectURL(new Blob([`
  ${strideFor}
  ${accessChunks}
  ${LRU}
  ${SetAssoc}
  ${makeSim}
  ${fullRun}
  onmessage = e => fullRun(...e.data);
`], { type: 'text/javascript' }));

// ---------- 3. Full-run comparison, one worker per method ----------
let workers = [];
let runs = [];

function startComparison() {
  workers.forEach(w => w.terminate());
  const cfg = config();
  runs = METHODS.map(([name, m]) => ({ name, total: totalAccesses(m, N, T), done: 0, counts: null }));
  workers = METHODS.map(([, m], i) => {
    const w = new Worker(workerURL);
    w.onmessage = e => {
      Object.assign(runs[i], e.data);
      if (runs[i].counts) w.terminate();
      renderComparison();
    };
    w.postMessage([m, N, cfg]);
    return w;
  });
  renderComparison();
}

// Estimated memory time of a run in cycles (real mode only)
const cyclesOf = c => c[0] * MODES.real.cycles[0] + c[1] * MODES.real.cycles[1] + c[2] * MODES.real.cycles[2];

function renderComparison() {
  const real = mode === 'real';
  const done = runs.filter(r => r.counts);
  const score = r => (real ? cyclesOf(r.counts) : r.counts[2]);   // what the bars compare
  const max = Math.max(1, ...done.map(score));
  const pct = (a, b) => (a / b * 100).toFixed(1) + '%';

  document.getElementById('cmpTitle').textContent = real
    ? 'Full run, all three methods, estimated memory time'
    : 'Full run, all three methods, same cache size';

  document.getElementById('cmp').innerHTML = runs.map(r => {
    if (!r.counts) return `
      <span>${r.name}</span>
      <div class="track"></div>
      <span class="num">running, ${percent(r.done / r.total)}</span>`;
    const c = r.counts;
    if (!real) return `
      <span>${r.name}</span>
      <div class="track"><div class="fill" style="width:${Math.max(0.5, c[2] / max * 100).toFixed(1)}%"></div></div>
      <span class="num">${c[2].toLocaleString()} misses, ${pct(c[0], r.total)} hits</span>`;
    const part = (n, i) => `${(n * MODES.real.cycles[i] / max * 100).toFixed(2)}%`;
    return `
      <span>${r.name}</span>
      <div class="track">
        <div class="fill" style="width:${part(c[0], 0)};background:var(--hit)"></div>
        <div class="fill" style="width:${part(c[1], 1)};background:var(--l2)"></div>
        <div class="fill" style="width:${part(c[2], 2)}"></div>
      </div>
      <span class="num">L1 ${pct(c[0], r.total)} · L2 ${pct(c[1], r.total)} · DRAM ${pct(c[2], r.total)}<br>about ${(cyclesOf(c) / r.total).toFixed(1)} cycles per access</span>`;
  }).join('');
}

function percent(f) {
  return (f * 100).toFixed(f < 0.01 ? 2 : f < 0.1 ? 1 : 0) + '%';
}

function fmtBytes(b) {
  return b >= 1 << 20 ? +(b / (1 << 20)).toFixed(1) + ' MB' : +(b / 1024).toFixed(1) + ' KB';
}

// ---------- 4. Stepping the simulation ----------
function reset() {
  playing = false;
  updatePlayButton();
  gen = accessChunks(method, N, chunk, L, T);
  chunkLen = chunkPos = 0;
  total = totalAccesses(method, N, T);
  pos = 0;
  sim = makeSim(config(), 3 * STRIDE / L);
  counts = [0, 0, 0]; perMatrix = [0, 0, 0];
  lastTime.fill(-1);
  updateStats();
  dirty = true;
}

function advance(n) {
  const { touch } = sim;
  for (let q = 0; q < n && pos < total; q++) {
    if (chunkPos === chunkLen) { chunkLen = gen.next().value; chunkPos = 0; }
    const x = chunk[chunkPos++];
    const level = touch(Math.floor(x / L));
    counts[level]++;
    if (level) perMatrix[Math.floor(x / STRIDE)]++;
    lastTime[x] = pos;
    recentAddr[pos % RECENT] = x;
    recentHit[pos % RECENT] = level;
    pos++;
  }
  if (pos >= total) { playing = false; updatePlayButton(); }
  dirty = true;
}

// Counter cards for each mode: a label, and a function giving the text to show
const CARDS = {
  teaching: [
    ['Hits', () => counts[0].toLocaleString()],
    ['Misses', () => counts[2].toLocaleString()],
    ['Hit rate', () => (pos ? (counts[0] / pos * 100).toFixed(1) + '%' : '–')],
    ['Progress', () => percent(pos / total)],
  ],
  real: [
    ['L1 hits', () => counts[0].toLocaleString()],
    ['L2 hits', () => counts[1].toLocaleString()],
    ['DRAM accesses', () => counts[2].toLocaleString()],
    ['L1 hit rate', () => (pos ? (counts[0] / pos * 100).toFixed(1) + '%' : '–')],
    ['Cycles / access', () => (pos ? (cyclesOf(counts) / pos).toFixed(1) : '–')],
    ['Progress', () => percent(pos / total)],
  ],
};

function buildCards() {
  document.getElementById('cards').innerHTML = CARDS[mode]
    .map(([label], i) => `<div class="card"><div class="label">${label}</div><div class="value" id="card${i}">0</div></div>`)
    .join('');
}

function updateStats() {
  CARDS[mode].forEach(([, get], i) => { document.getElementById('card' + i).textContent = get(); });
  document.getElementById('per').textContent =
    `${mode === 'real' ? 'L1 misses' : 'Misses'} by matrix: A ${perMatrix[0].toLocaleString()}, B ${perMatrix[1].toLocaleString()}, C ${perMatrix[2].toLocaleString()}`;
}

// ---------- 5. Drawing ----------
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const GAP = 24;       // space between the three grids
const L2_DRAW_MAX = 24000; // above this many matrix lines, the L2 layer is too slow to draw
let W = 0, cs = 10;   // canvas CSS width, cell size in px

function resize() {
  const dpr = window.devicePixelRatio || 1;
  W = cv.clientWidth;
  const fit = (W - 2 * GAP) / (3 * N);
  cs = fit >= 2 ? Math.floor(fit) : fit;   // whole pixels keep small grids crisp; big N needs cells under 1 px
  const h = Math.ceil(cs * N) + 22;
  cv.width = W * dpr;            // real pixels, so it's sharp on retina
  cv.height = h * dpr;
  cv.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dirty = true;
}

function draw() {
  const css = getComputedStyle(document.documentElement);
  const color = name => css.getPropertyValue(name).trim();
  const muted = color('--muted'), border = color('--border-strong');
  const hitColors = [color('--hit'), color('--l2'), color('--miss')];   // by level that served the access
  const real = mode === 'real';

  ctx.clearRect(0, 0, W, cv.height);
  const gw = cs * N, oy = 20;
  const gap = cs >= 4 ? 1 : 0;           // space between cells, once they're big enough to show it
  const dot = Math.max(cs - gap, 1);     // drawn size of a cell, at least 1 px so accesses show at big N
  const fadeWindow = Math.min(RECENT, Math.max(24, speed * 10)); // how long a highlight lingers
  ctx.font = '500 13px system-ui, sans-serif';
  ctx.textBaseline = 'top';

  // Fills the cell at address x, skipping the padding after a matrix's last row
  const fillCell = x => {
    const M = Math.floor(x / STRIDE), idx = x - M * STRIDE;
    if (idx >= N * N) return;
    ctx.fillRect(M * (gw + GAP) + (idx % N) * cs, oy + Math.floor(idx / N) * cs, dot, dot);
  };

  // Fills a whole cache line, one rectangle per matrix row it touches
  const fillLine = line => {
    const start = line * L, M = Math.floor(start / STRIDE);
    let idx = start - M * STRIDE;
    const end = Math.min(idx + L, N * N);
    while (idx < end) {
      const r = Math.floor(idx / N), c = idx - r * N, cEnd = Math.min(end, (r + 1) * N) - r * N;
      ctx.fillRect(M * (gw + GAP) + c * cs, oy + r * cs, Math.max((cEnd - c) * cs - gap, 1), dot);
      idx = r * N + cEnd;
    }
  };

  // empty grids
  ['A', 'B', 'C'].forEach((name, m) => {
    const ox = m * (gw + GAP);
    ctx.fillStyle = muted;
    ctx.fillText(name, ox, 0);

    ctx.globalAlpha = 0.35;
    ctx.fillStyle = border;
    if (gap) {
      for (let r = 0; r < N; r++)
        for (let c = 0; c < N; c++) ctx.fillRect(ox + c * cs, oy + r * cs, cs - 1, cs - 1);
    } else {
      ctx.fillRect(ox, oy, gw, gw);      // cells too small to tell apart
    }
    ctx.globalAlpha = 1;
  });

  // lines currently in the cache: L2 underneath, then L1 on top
  if (real && 3 * STRIDE / L <= L2_DRAW_MAX) {
    ctx.fillStyle = color('--cached2');
    for (const line of sim.l2.lines()) fillLine(line);
  }
  ctx.fillStyle = color(real ? '--cached1' : '--cached');
  for (const line of sim.l1.lines()) fillLine(line);

  // recently accessed: colored by who served it, fading with age. Oldest first, and each cell
  // only for its latest access.
  for (let age = Math.min(fadeWindow, pos) - 1; age >= 0; age--) {
    const t = pos - 1 - age, x = recentAddr[t % RECENT];
    if (lastTime[x] !== t) continue;
    ctx.fillStyle = hitColors[recentHit[t % RECENT]];
    ctx.globalAlpha = age === 0 ? 1 : Math.max(0.12, 1 - age / fadeWindow);
    fillCell(x);
  }
  ctx.globalAlpha = 1;

  // marks where each cache line starts. When N isn't a multiple of L, lines wrap
  // from one row into the next, so the marks shift from row to row.
  if (gap) {
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let m = 0; m < 3; m++) {
      const ox = m * (gw + GAP);
      for (let r = 0; r < N; r++)
        for (let c = (L - r * N % L) % L; c < N; c += L) {
          ctx.moveTo(ox + c * cs - 0.5, oy + r * cs);
          ctx.lineTo(ox + c * cs - 0.5, oy + (r + 1) * cs);
        }
    }
    ctx.stroke();
  }
}

// ---------- 6. Animation loop ----------
function loop() {
  if (playing) {
    if (speed >= 1) { advance(speed); updateStats(); }
    else if (++idle >= Math.round(1 / speed)) { idle = 0; advance(1); updateStats(); }
  }
  if (dirty) { draw(); dirty = false; }
  requestAnimationFrame(loop);
}

// ---------- 7. Controls ----------
const playBtn = document.getElementById('play');
function updatePlayButton() { playBtn.textContent = playing ? 'Pause' : 'Play'; }

playBtn.addEventListener('click', () => {
  if (pos >= total) reset();
  playing = !playing;
  idle = Infinity;               // at slow speeds, take the first step right away
  updatePlayButton();
});
document.getElementById('step').addEventListener('click', () => {
  playing = false; updatePlayButton(); advance(1); updateStats();
});
document.getElementById('reset').addEventListener('click', reset);

function setMethod(m, andReset = true) {
  method = m;
  for (const k of ['ijk', 'ikj', 'tile'])
    document.getElementById('m' + k).setAttribute('aria-pressed', String(k === m));
  document.getElementById('methodDesc').textContent = METHOD_DESC[m];
  document.getElementById('tileLabel').style.opacity = document.getElementById('tile').style.opacity = m === 'tile' ? 1 : 0.5;
  if (andReset) reset();
}
document.getElementById('mijk').addEventListener('click', () => setMethod('ijk'));
document.getElementById('mikj').addEventListener('click', () => setMethod('ikj'));
document.getElementById('mtile').addEventListener('click', () => setMethod('tile'));

const sizeIn = document.getElementById('size');
function updateDims() {
  const bytes = N * N * 8;
  document.getElementById('dims').textContent = mode === 'real'
    ? `Line = ${L} doubles (128 B) · each ${N}×${N} matrix is ${fmtBytes(bytes)}, all three ${fmtBytes(3 * bytes)} · L1 128 KB, L2 16 MB`
    : `Line = ${L} values, matrices ${N}×${N}`;
}
function setSize() {
  const m = MODES[mode];
  N = Math.min(m.maxN, Math.max(N_MIN, Math.round(+sizeIn.value) || N));
  sizeIn.value = N;
  STRIDE = strideFor(N, L);
  lastTime = new Float64Array(3 * STRIDE);   // reset() clears it
  chunk = new Int32Array(2 * N + 1);  // the longest inner loop: 2N accesses plus 1
  updateDims();
  resize();
  reset();
  startComparison();
}
const N_MIN = 2;
sizeIn.addEventListener('change', setSize);

const tileSel = document.getElementById('tile');
tileSel.addEventListener('change', () => {
  T = +tileSel.value;
  reset();
  startComparison();
});

// The speed slider is logarithmic: from 1 access every 120 frames (about 2 s) up to a million per frame.
const SPEED_MIN = 1 / 120, SPEED_MAX = 1e6;
const speedIn = document.getElementById('speed');
function setSpeed() {
  const s = SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, speedIn.value / speedIn.max);
  speed = s >= 1 ? Math.round(s) : 1 / Math.round(1 / s);
  const text = speed >= 1 ? speed.toLocaleString() + ' / frame' : '1 per ' + Math.round(1 / speed) + ' frames';
  document.getElementById('speedOut').textContent = text;
  speedIn.setAttribute('aria-valuetext', text);
  dirty = true;
}
speedIn.addEventListener('input', setSpeed);
document.getElementById('cap').addEventListener('input', e => {
  CAP = +e.target.value;
  document.getElementById('capOut').textContent = CAP + ' lines';
  startComparison();
  reset();
});

// Switching modes swaps the cache model, the line size and sensible defaults for N and the tile size
function setMode(next) {
  mode = next;
  const m = MODES[mode];
  document.body.dataset.mode = mode;
  document.getElementById('modeTeaching').setAttribute('aria-pressed', String(mode === 'teaching'));
  document.getElementById('modeReal').setAttribute('aria-pressed', String(mode === 'real'));
  document.getElementById('modeBlurb').textContent = m.blurb;
  L = m.L;
  T = m.defaultT;
  N = m.defaultN;
  sizeIn.max = m.maxN;
  sizeIn.value = N;
  tileSel.innerHTML = m.tiles.map(t => `<option value="${t}"${t === T ? ' selected' : ''}>${t}×${t}</option>`).join('');
  buildCards();
  setMethod(method, false);
  setSize();            // also resets
}
document.getElementById('modeTeaching').addEventListener('click', () => mode !== 'teaching' && setMode('teaching'));
document.getElementById('modeReal').addEventListener('click', () => mode !== 'real' && setMode('real'));

window.addEventListener('resize', resize);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { dirty = true; });

// ---------- Start ----------
setSpeed();
setMode('teaching');
loop();
