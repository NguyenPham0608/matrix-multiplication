// ---------- Settings ----------
// Teaching mode is a small fully associative cache that is easy to follow. The two real modes are
// hierarchies of set-associative LRU caches. The M5 line size and cache sizes come from `sysctl`
// on an M5, and the x86 numbers are round figures typical of a desktop chip. Ways and cycle costs
// are assumptions. An access's outcome is the index of the level that had the line, one past the
// last level meaning main memory, and it is also the position in names, colors and cycles.
const tag = (kind, text) => `<span class="tag ${kind}">${text}</span>`;
const MODES = {
  teaching: {
    kind: 'teaching',
    L: 4,
    defaultN: 16, maxN: 1024,             // starting size of every dimension, largest allowed
    tiles: [2, 4, 8], defaultT: 4,
    levels: null,
    names: ['Hit', 'Miss'],
    colors: ['--hit', '--miss'],
    blurb: 'A tiny fully associative LRU cache, 4 values per line, so every hit and miss is easy to see.',
  },
  m5: {
    kind: 'real',
    L: 16, lineBytes: 128,                 // 128-byte line of 8-byte doubles
    defaultN: 256, maxN: 512,
    tiles: [8, 16, 32, 64, 128], defaultT: 32,
    levels: [
      { sets: 128, ways: 8 },              // 128 sets x 8 ways x 128 B = 128 KB
      { sets: 16384, ways: 8 },            // 16384 sets x 8 ways x 128 B = 16 MB
    ],
    cycles: [4, 18, 350],                  // rough cost of an L1 hit, an L2 hit and a DRAM access
    names: ['L1', 'L2', 'DRAM'],
    colors: ['--hit', '--l2', '--miss'],
    summary: 'L1 128 KB, L2 16 MB',
    blurb: 'An L1 + L2 hierarchy shaped like an M5 performance core: 128-byte lines, set-associative, LRU.',
    specs: [
      ['Cache line', '128 B, so 16 doubles', `${tag('measured', 'measured')} <code>hw.cachelinesize</code>`],
      ['L1 data', '128 KB, 8-way', `${tag('measured', 'size measured')} ${tag('assumed', 'ways assumed')}`],
      ['L2', '16 MB, 8-way', `${tag('measured', 'size measured')} ${tag('assumed', 'ways assumed')}`],
      ['L3', 'none', 'macOS reports no L3; the system-level cache is not modeled'],
      ['Replacement', 'LRU in every set', `${tag('assumed', 'assumed')} real chips approximate LRU`],
      ['Cost per access', 'L1 ≈ 4, L2 ≈ 18, DRAM ≈ 350 cycles', tag('assumed', 'rough estimates')],
    ],
    note: 'Sizes come from <code>sysctl</code> on an M5 (performance-core values). Matrices are 8-byte doubles, stored row by row, each starting on a fresh line. Because sets are picked by address, power-of-two row lengths like 512 make a column of B land in just a few sets, which causes conflict misses that the fully associative teaching cache can\'t show.',
  },
  x86: {
    kind: 'real',
    L: 8, lineBytes: 64,
    defaultN: 256, maxN: 512,
    tiles: [8, 16, 32, 64, 128], defaultT: 32,
    levels: [
      { sets: 64, ways: 8 },               // 64 sets x 8 ways x 64 B = 32 KB
      { sets: 1024, ways: 8 },             // 1024 sets x 8 ways x 64 B = 512 KB
      { sets: 32768, ways: 16 },           // 32768 sets x 16 ways x 64 B = 32 MB
    ],
    cycles: [4, 14, 45, 250],
    names: ['L1', 'L2', 'L3', 'DRAM'],
    colors: ['--hit', '--l2', '--l3', '--miss'],
    summary: 'L1 32 KB, L2 512 KB, L3 32 MB',
    blurb: 'An L1 + L2 + L3 hierarchy with round numbers typical of an x86 desktop chip: 64-byte lines, set-associative, LRU.',
    specs: [
      ['Cache line', '64 B, so 8 doubles', tag('illustrative', 'typical')],
      ['L1 data', '32 KB, 8-way', tag('illustrative', 'typical')],
      ['L2', '512 KB, 8-way', tag('illustrative', 'typical')],
      ['L3', '32 MB, 16-way', `${tag('illustrative', 'typical')} shared by all cores on a real chip`],
      ['Replacement', 'LRU in every set', `${tag('assumed', 'assumed')} real chips approximate LRU`],
      ['Cost per access', 'L1 ≈ 4, L2 ≈ 14, L3 ≈ 45, DRAM ≈ 250 cycles', tag('assumed', 'rough estimates')],
    ],
    note: 'These are illustrative round numbers, not one specific processor, and they were not measured on this machine. With a 512 KB L2, the three matrices stop fitting at moderate sizes, which is when the L3 starts to matter. The L3 is too big to draw, so it only shows up in the counters.',
  },
};

const METHODS = [['Basic', 'ijk'], ['Reordering', 'ikj'], ['Tiled', 'tile']];

// Where each matrix sits in memory, counted in values. A is M×K, B is K×P and C is M×P, stored
// row by row. Each starts on a fresh cache line, so a matrix's size is rounded up to a whole line.
function layoutFor(M, K, P, L) {
  const rows = [M, K, M], cols = [K, P, P];
  const base = [0, 0, 0];
  for (let m = 1; m < 3; m++) base[m] = base[m - 1] + Math.ceil(rows[m - 1] * cols[m - 1] / L) * L;
  return { rows, cols, base, end: base[2] + Math.ceil(M * P / L) * L };
}

// ---------- State ----------
let mode = 'teaching';
const isReal = () => MODES[mode].kind === 'real';
let L = MODES.teaching.L;
let T = MODES.teaching.defaultT;
let M = 16, K = 16, P = 16; // A is M×K, B is K×P, C is M×P, set from the page
let lay = layoutFor(M, K, P, L);
let method = 'ijk';
let CAP = 16;
let gen = null;            // hands out the current run's accesses, a chunk at a time
let chunk = null;
let chunkLen = 0, chunkPos = 0;
let total = 0;
let pos = 0;
let sim = null;            // the simulated cache: { touch(line) -> outcome, caches }
let counts = [];           // accesses per outcome: one slot per level, then main memory
let perMatrix = [0, 0, 0];
let playing = false;
let speed = 12;            // accesses per animation frame; below 1 means one access every 1/speed frames
let idle = 0;
let dirty = true;

// For drawing: when each address was last touched, plus a ring of the most recent accesses
let lastTime = null;
const RECENT = 4096;
const recentAddr = new Int32Array(RECENT);
const recentHit = new Uint8Array(RECENT);  // outcome of access t

// Everything the simulation needs, in a form that can be posted to a worker
function config() {
  return { levels: MODES[mode].levels, L, T, M, K, P, cap: CAP };
}

// ---------- 1. Build the access sequence ----------
// Each access is a memory address, counted in values. Matrix X (0 = A, 1 = B, 2 = C) starts at
// lay.base[X], and its element [r][c] is r * cols + c after that. Address / L is the cache line.
//
// A run makes about 2·M·K·P accesses, billions for 1024-sized matrices, too many to store. So
// this generator fills buf with the accesses of one inner loop at a time and yields how many
// it wrote.
function* accessChunks(m, lay, buf, L, T) {
  const M = lay.rows[0], K = lay.rows[1], P = lay.cols[1];
  const [bA, bB, bC] = lay.base;
  let n = 0;

  if (m === 'ijk') {
    for (let i = 0; i < M; i++)
      for (let j = 0; j < P; j++) {
        for (let k = 0; k < K; k++) {
          buf[n++] = bA + i * K + k;
          buf[n++] = bB + k * P + j;
        }
        buf[n++] = bC + i * P + j;     // C[i][j] written once, it was in a register
        yield n; n = 0;
      }
  } else if (m === 'ikj') {
    for (let i = 0; i < M; i++)
      for (let k = 0; k < K; k++) {
        buf[n++] = bA + i * K + k;     // A[i][k] loaded once into a register
        for (let j = 0; j < P; j++) {
          buf[n++] = bB + k * P + j;
          buf[n++] = bC + i * P + j;   // C[i][j] read + write (same line, counted once)
        }
        yield n; n = 0;
      }
  } else {
    // Math.min cuts the last tile short when a dimension isn't a multiple of T
    for (let ii = 0; ii < M; ii += T)
      for (let kk = 0; kk < K; kk += T)
        for (let jj = 0; jj < P; jj += T)
          for (let i = ii; i < Math.min(ii + T, M); i++)
            for (let k = kk; k < Math.min(kk + T, K); k++) {
              buf[n++] = bA + i * K + k;
              for (let j = jj; j < Math.min(jj + T, P); j++) {
                buf[n++] = bB + k * P + j;
                buf[n++] = bC + i * P + j;
              }
              yield n; n = 0;
            }
  }
}

// How many accesses a run makes: 2 per multiply-add, plus one per inner loop
// (C for i, j, k; A for the others). The tiled method runs its inner loop once per j-tile.
function totalAccesses(m, M, K, P, T) {
  const innerLoops = m === 'ijk' ? M * P : m === 'ikj' ? M * K : M * K * Math.ceil(P / T);
  return 2 * M * K * P + innerLoops;
}

// ---------- 2. The caches ----------
// Fully associative with LRU eviction, kept as a doubly linked list of lines, most recent first.
// The links live in typed arrays indexed by line number, so each access is a few array writes,
// fast enough for the billions of accesses in a full run of 1024-sized matrices.
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
      next[prev[line]] = next[line];
      prev[next[line]] = prev[line];
    } else {
      cached[line] = 1;
      if (this.size === this.cap) {
        const old = prev[head];
        cached[old] = 0;
        next[prev[old]] = head;
        prev[head] = prev[old];
      } else {
        this.size++;
      }
    }
    next[line] = next[head];
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
    this.mask = sets - 1;
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
    tags[base] = line;
    return hit;
  }

  *lines() {
    const t = this.tags;
    for (let i = 0; i < t.length; i++) if (t[i] >= 0) yield t[i];
  }
}

// Builds the caches for a run. touch(line) returns the outcome. A level that misses loads the
// line, so by the time a lower level hits, every level above already holds it. Two or three levels.
function makeSim(cfg, nLines) {
  if (!cfg.levels) {
    const c = new LRU(nLines, cfg.cap);
    return { caches: [c], touch: line => (c.access(line) ? 0 : 1) };
  }
  const caches = cfg.levels.map(l => new SetAssoc(l.sets, l.ways));
  const [a, b, c] = caches;
  const touch = caches.length === 2
    ? line => (a.access(line) ? 0 : b.access(line) ? 1 : 2)
    : line => (a.access(line) ? 0 : b.access(line) ? 1 : c.access(line) ? 2 : 3);
  return { caches, touch };
}

function fullRun(m, cfg) {
  const L = cfg.L;
  const lay = layoutFor(cfg.M, cfg.K, cfg.P, L);
  const touch = makeSim(cfg, lay.end / L).touch;
  const buf = new Int32Array(2 * Math.max(cfg.K, cfg.P) + 1);
  const counts = new Array((cfg.levels ? cfg.levels.length : 1) + 1).fill(0);
  let done = 0, nextReport = 0;
  for (const n of accessChunks(m, lay, buf, L, cfg.T)) {
    for (let q = 0; q < n; q++) counts[touch(Math.floor(buf[q] / L))]++;
    done += n;
    if (done >= nextReport) { postMessage({ done }); nextReport += 1 << 24; }
  }
  postMessage({ done, counts });
}

const workerURL = URL.createObjectURL(new Blob([`
  ${layoutFor}
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
  runs = METHODS.map(([name, m]) => ({ name, m, total: totalAccesses(m, M, K, P, T), done: 0, counts: null }));
  workers = METHODS.map(([, m], i) => {
    const w = new Worker(workerURL);
    w.onmessage = e => {
      Object.assign(runs[i], e.data);
      if (runs[i].counts) w.terminate();
      renderComparison();
    };
    w.postMessage([m, cfg]);
    return w;
  });
  renderComparison();
}

const cyclesOf = c => c.reduce((sum, n, i) => sum + n * MODES[mode].cycles[i], 0);

function renderComparison() {
  const real = isReal(), def = MODES[mode];
  const done = runs.filter(r => r.counts);
  const score = r => (real ? cyclesOf(r.counts) : r.counts[1]);
  const max = Math.max(1, ...done.map(score));
  const pct = (a, b) => (a / b * 100).toFixed(1) + '%';

  document.getElementById('cmpTitle').textContent = real
    ? 'Full run, all three methods, estimated memory time'
    : 'Full run, all three methods, same cache size';

  document.getElementById('cmp').innerHTML = runs.map(r => {
    const name = `<span class="name${r.m === method ? ' current' : ''}">${r.name}</span>`;
    if (!r.counts) return `${name}<div class="track"></div><span class="num">running, ${percent(r.done / r.total)}</span>`;
    const c = r.counts;
    if (!real) return `${name}
      <div class="track"><div class="fill" style="width:${Math.max(0.5, c[1] / max * 100).toFixed(1)}%"></div></div>
      <span class="num">${c[1].toLocaleString()} misses, ${pct(c[0], r.total)} hits</span>`;
    const segments = c.map((n, i) =>
      `<div class="fill" style="width:${(n * def.cycles[i] / max * 100).toFixed(2)}%;background:var(${def.colors[i]})"></div>`).join('');
    return `${name}
      <div class="track">${segments}</div>
      <span class="num">${def.names.map((nm, i) => `${nm} ${pct(c[i], r.total)}`).join(' · ')}<br>about ${(cyclesOf(c) / r.total).toFixed(1)} cycles per access</span>`;
  }).join('');
}

function percent(f) {
  return (f * 100).toFixed(f < 0.01 ? 2 : f < 0.1 ? 1 : 0) + '%';
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  return b >= 1 << 20 ? +(b / (1 << 20)).toFixed(1) + ' MB' : +(b / 1024).toFixed(1) + ' KB';
}

const matOf = x => (x < lay.base[1] ? 0 : x < lay.base[2] ? 1 : 2);

// ---------- 4. Stepping the simulation ----------
function reset() {
  playing = false;
  updatePlayButton();
  gen = accessChunks(method, lay, chunk, L, T);
  chunkLen = chunkPos = 0;
  total = totalAccesses(method, M, K, P, T);
  pos = 0;
  sim = makeSim(config(), lay.end / L);
  counts = new Array(MODES[mode].names.length).fill(0);
  perMatrix = [0, 0, 0];
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
    if (level) perMatrix[matOf(x)]++;
    lastTime[x] = pos;
    recentAddr[pos % RECENT] = x;
    recentHit[pos % RECENT] = level;
    pos++;
  }
  if (pos >= total) { playing = false; updatePlayButton(); }
  dirty = true;
}

const hitRate = () => (pos ? (counts[0] / pos * 100).toFixed(1) + '%' : '–');
function cardsFor(m) {
  const names = MODES[m].names, mem = names.length - 1;
  if (MODES[m].kind === 'teaching') return [
    ['Hits', () => counts[0].toLocaleString()],
    ['Misses', () => counts[1].toLocaleString()],
    ['Hit rate', hitRate],
    ['Progress', () => percent(pos / total)],
  ];
  return [
    ...names.slice(0, mem).map((nm, i) => [`${nm} hits`, () => counts[i].toLocaleString()]),
    ['DRAM accesses', () => counts[mem].toLocaleString()],
    ['L1 hit rate', hitRate],
    ['Cycles / access', () => (pos ? (cyclesOf(counts) / pos).toFixed(1) : '–')],
    ['Progress', () => percent(pos / total)],
  ];
}
let cards = [];

function buildCards() {
  cards = cardsFor(mode);
  document.getElementById('cards').innerHTML = cards
    .map(([label], i) => `<div class="card"><div class="label">${label}</div><div class="value" id="card${i}">0</div></div>`)
    .join('');
}

function updateStats() {
  document.getElementById('progFill').style.width = (total ? pos / total * 100 : 0) + '%';
  // share of accesses served by each level, in the same colors as the grids
  const colors = MODES[mode].colors.map(c => `var(${c})`);
  document.getElementById('share').innerHTML = pos
    ? counts.map((c, i) => `<span style="width:${c / pos * 100}%;background:${colors[i]}"></span>`).join('')
    : '';
  cards.forEach(([, get], i) => { document.getElementById('card' + i).textContent = get(); });
  document.getElementById('per').textContent =
    `${isReal() ? 'L1 misses' : 'Misses'} by matrix: A ${perMatrix[0].toLocaleString()}, B ${perMatrix[1].toLocaleString()}, C ${perMatrix[2].toLocaleString()}`;
}

// ---------- 5. Drawing ----------
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const GAP = 24;
const MAX_H = 520;    // tallest the grids may get, so tall matrices still fit on screen
const L2_DRAW_MAX = 24000; // above this many matrix lines, the L2 layer is too slow to draw
let W = 0, cs = 10;
let ox = [0, 0, 0];

function resize() {
  const dpr = window.devicePixelRatio || 1;
  W = cv.clientWidth;
  const tallest = Math.max(M, K);
  const fit = Math.min((W - 2 * GAP) / (K + 2 * P), MAX_H / tallest);
  cs = fit >= 2 ? Math.floor(fit) : fit;   // whole pixels keep small grids crisp; big matrices need cells under 1 px
  ox = [0, K * cs + GAP, (K + P) * cs + 2 * GAP];
  const h = Math.ceil(cs * tallest) + 22;
  cv.width = W * dpr;
  cv.height = h * dpr;
  cv.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dirty = true;
}

function draw() {
  const css = getComputedStyle(document.documentElement);
  const color = name => css.getPropertyValue(name).trim();
  const muted = color('--muted'), border = color('--border-strong');
  const hitColors = MODES[mode].colors.map(color);
  const real = isReal();
  const { rows, cols, base } = lay;

  ctx.clearRect(0, 0, W, cv.height);
  const oy = 20;
  const gap = cs >= 4 ? 1 : 0;
  const dot = Math.max(cs - gap, 1);
  const fadeWindow = Math.min(RECENT, Math.max(24, speed * 10));
  ctx.font = '500 13px system-ui, sans-serif';
  ctx.textBaseline = 'top';

    const fillCell = x => {
    const m = matOf(x), idx = x - base[m];
    if (idx >= rows[m] * cols[m]) return;
    const r = Math.floor(idx / cols[m]);
    ctx.fillRect(ox[m] + (idx - r * cols[m]) * cs, oy + r * cs, dot, dot);
  };

    const fillLine = line => {
    const start = line * L, m = matOf(start), nc = cols[m];
    let idx = start - base[m];
    const end = Math.min(idx + L, rows[m] * nc);
    while (idx < end) {
      const r = Math.floor(idx / nc), c = idx - r * nc, cEnd = Math.min(end, (r + 1) * nc) - r * nc;
      ctx.fillRect(ox[m] + c * cs, oy + r * cs, Math.max((cEnd - c) * cs - gap, 1), dot);
      idx = r * nc + cEnd;
    }
  };

    ['A', 'B', 'C'].forEach((name, m) => {
    ctx.fillStyle = muted;
    ctx.fillText(`${name}  ${rows[m]}×${cols[m]}`, ox[m], 0);

    ctx.globalAlpha = 0.35;
    ctx.fillStyle = border;
    if (gap) {
      for (let r = 0; r < rows[m]; r++)
        for (let c = 0; c < cols[m]; c++) ctx.fillRect(ox[m] + c * cs, oy + r * cs, cs - 1, cs - 1);
    } else {
      ctx.fillRect(ox[m], oy, cols[m] * cs, rows[m] * cs);
    }
    ctx.globalAlpha = 1;
  });

    if (real && lay.end / L <= L2_DRAW_MAX) {
    ctx.fillStyle = color('--cached2');
    for (const line of sim.caches[1].lines()) fillLine(line);
  }
  ctx.fillStyle = color(real ? '--cached1' : '--cached');
  for (const line of sim.caches[0].lines()) fillLine(line);

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

  // marks where each cache line starts. When a row length isn't a multiple of L, lines wrap
  // from one row into the next, so the marks shift from row to row.
  if (gap) {
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let m = 0; m < 3; m++)
      for (let r = 0; r < rows[m]; r++)
        for (let c = (L - r * cols[m] % L) % L; c < cols[m]; c += L) {
          ctx.moveTo(ox[m] + c * cs - 0.5, oy + r * cs);
          ctx.lineTo(ox[m] + c * cs - 0.5, oy + (r + 1) * cs);
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
function updatePlayButton() {
  playBtn.textContent = playing ? 'Pause' : pos > 0 && pos < total ? 'Resume' : 'Play';
  playBtn.dataset.state = playing ? 'playing' : 'paused';
}

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
  document.querySelector('.tilefield').classList.toggle('off', m !== 'tile');
  document.getElementById('tile').disabled = m !== 'tile';
  if (andReset) { reset(); renderComparison(); }
}
document.getElementById('mijk').addEventListener('click', () => setMethod('ijk'));
document.getElementById('mikj').addEventListener('click', () => setMethod('ikj'));
document.getElementById('mtile').addEventListener('click', () => setMethod('tile'));

const dimIn = ['aR', 'aC', 'bR', 'bC'].map(id => document.getElementById(id));
const dimStatus = document.getElementById('dimStatus');
function updateDims() {
  const sz = (r, c) => `${r}×${c}`;
  const def = MODES[mode];
  document.getElementById('dims').textContent = isReal()
    ? `Line = ${L} doubles (${def.lineBytes} B) · A ${fmtBytes(M * K * 8)}, B ${fmtBytes(K * P * 8)}, C ${fmtBytes(M * P * 8)}, total ${fmtBytes((M * K + K * P + M * P) * 8)} · ${def.summary}`
    : `Line = ${L} values · A ${sz(M, K)}, B ${sz(K, P)}, C ${sz(M, P)}`;
}

// Reads the four size boxes. Valid sizes rebuild the run; otherwise the page says why not and the
// current run is left alone, with Play and Step switched off.
function setSize() {
  const max = MODES[mode].maxN;
  const [aR, aC, bR, bC] = dimIn.map(el => Math.round(+el.value));
  const problem = ![aR, aC, bR, bC].every(v => v >= 1 && v <= max)
    ? `Every dimension must be a whole number from 1 to ${max}.`
    : aC !== bR
      ? `A can't be multiplied by B: A has ${aC} columns but B has ${bR} rows. They must match.`
      : '';
  dimStatus.textContent = problem;
  dimStatus.classList.toggle('bad', !!problem);
  for (const id of ['play', 'step']) document.getElementById(id).disabled = !!problem;
  if (problem) {
    playing = false;
    updatePlayButton();
    return;
  }

  M = aR; K = aC; P = bC;
  lay = layoutFor(M, K, P, L);
  lastTime = new Float64Array(lay.end);
  chunk = new Int32Array(2 * Math.max(K, P) + 1);
  updateDims();
  resize();
  reset();
  startComparison();
}
const lockA = document.getElementById('lockA'), lockB = document.getElementById('lockB');
const byId = Object.fromEntries(dimIn.map(el => [el.id, el]));

// Boxes that must hold the same number: A's columns and B's rows always, plus the two sides of a
// matrix whose lock is on. Setting one box carries the number through everything tied to it.
function propagate(from) {
  const pairs = [['aC', 'bR']];
  if (lockA.getAttribute('aria-pressed') === 'true') pairs.push(['aR', 'aC']);
  if (lockB.getAttribute('aria-pressed') === 'true') pairs.push(['bR', 'bC']);
  const todo = [from];
  while (todo.length) {
    const id = todo.pop();
    for (const [x, y] of pairs) {
      const other = id === x ? y : id === y ? x : null;
      if (other && byId[other].value !== byId[id].value) {
        byId[other].value = byId[id].value;
        todo.push(other);
      }
    }
  }
}
dimIn.forEach(el => el.addEventListener('change', () => {
  propagate(el.id);
  setSize();
}));

// Turning a lock on squares that matrix right away, from the box that is shared with the other matrix
for (const [btn, shared, other] of [[lockA, 'aC', 'aR'], [lockB, 'bR', 'bC']]) {
  btn.addEventListener('click', () => {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    if (on) {
      byId[other].value = byId[shared].value;
      propagate(other);
      setSize();
    }
  });
}

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

// Switching modes swaps the cache model, the line size and sensible defaults for the matrix sizes and the tile size
const MODE_BUTTONS = { teaching: 'modeTeaching', m5: 'modeM5', x86: 'modeX86' };
function setMode(next) {
  mode = next;
  const m = MODES[mode];
  document.body.dataset.mode = m.kind;
  document.body.dataset.hier = m.levels ? m.levels.length : 1;
  for (const [k, id] of Object.entries(MODE_BUTTONS))
    document.getElementById(id).setAttribute('aria-pressed', String(k === mode));
  document.getElementById('modeBlurb').textContent = m.blurb;
  document.getElementById('specsBody').innerHTML = (m.specs || [])
    .map(([label, value, source]) => `<tr><th>${label}</th><td>${value}</td><td>${source}</td></tr>`).join('');
  document.getElementById('specsNote').innerHTML = m.note || '';
  L = m.L;
  T = m.defaultT;
  dimIn.forEach(el => { el.max = m.maxN; el.value = m.defaultN; });
  tileSel.innerHTML = m.tiles.map(t => `<option value="${t}"${t === T ? ' selected' : ''}>${t}×${t}</option>`).join('');
  buildCards();
  setMethod(method, false);
  setSize();
}
for (const [k, id] of Object.entries(MODE_BUTTONS))
  document.getElementById(id).addEventListener('click', () => mode !== k && setMode(k));

window.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, select, textarea, button, summary')) return;
  if (e.key === ' ') { e.preventDefault(); playBtn.click(); }
  else if (e.key === 'ArrowRight') document.getElementById('step').click();
  else if (e.key === 'r' || e.key === 'R') document.getElementById('reset').click();
});

window.addEventListener('resize', resize);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { dirty = true; });

// ---------- Start ----------
setSpeed();
setMode('teaching');
loop();
