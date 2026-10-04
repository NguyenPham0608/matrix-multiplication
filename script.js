// ---------- Settings ----------
// Teaching mode is a small fully associative cache that is easy to follow. Every hardware model is
// a hierarchy of set-associative LRU caches built from published cache sizes. Associativity and
// cycle costs are assumptions unless marked measured. An access's outcome is the index of the
// level that had the line, one past the last level meaning main memory, and it is also the
// position in names, colors and cycles.
const tag = (kind, text) => `<span class="tag ${kind}">${text}</span>`;
const KB = 1024, MB = 1024 * KB;
const LEVEL_COLORS = ['--hit', '--l2', '--l3'];

const MODES = {
  teaching: {
    kind: 'teaching',
    L: 4,
    defaultN: 16, maxN: 1024,             // starting size of every dimension, largest allowed
    tiles: [2, 4, 8], defaultT: 4,
    levels: null,
    names: ['Hit', 'Miss'],
    colors: ['--hit', '--miss'],
  },
};

// weakest to strongest within each group: name, group, line size in bytes, cache levels (size, ways, how well known), memory name,
// rough cycle cost per level and for memory, then a note shown under the spec table
const HARDWARE = [
  ['x86', 'x86 desktop (typical)', 'CPU', 64,
    [['L1', 32 * KB, 8, 'typical'], ['L2', 512 * KB, 8, 'typical'], ['L3', 32 * MB, 16, 'typical']], 'DRAM', [4, 14, 45, 250],
    'Round numbers typical of a desktop chip, not one specific processor. With a 512 KB L2, the three matrices stop fitting at moderate sizes, which is when the L3 starts to matter.'],
  ['m5', 'Apple M5', 'CPU', 128,
    [['L1', 128 * KB, 8, 'measured'], ['L2', 16 * MB, 8, 'measured']], 'DRAM', [4, 18, 350],
    'Sizes come from <code>sysctl</code> on an M5 (performance-core values). macOS reports no L3; the system-level cache is not modeled. Because sets are picked by address, power-of-two row lengths like 512 make a column of B land in just a few sets, which causes conflict misses that the fully associative teaching cache can\'t show.'],
  ['ryzen', 'AMD Ryzen 9 7950X', 'CPU', 64,
    [['L1', 32 * KB, 8, 'typical'], ['L2', 1 * MB, 8, 'typical'], ['L3', 32 * MB, 16, 'typical']], 'DRAM', [4, 14, 47, 250],
    'Zen 4 core. The L3 is one CCD\'s share; the other CCD\'s L3 is not reachable from this core.'],
  ['i9', 'Intel Core i9-14900K', 'CPU', 64,
    [['L1', 48 * KB, 12, 'typical'], ['L2', 2 * MB, 16, 'typical'], ['L3', 36 * MB, 12, 'typical']], 'DRAM', [5, 16, 80, 250],
    'Raptor Lake performance core. The L3 is shared by all cores on the real chip.'],
  ['rtx4090', 'NVIDIA RTX 4090', 'GPU', 128,
    [['L1', 128 * KB, 8, 'typical'], ['L2', 72 * MB, 16, 'typical']], 'GDDR', [33, 250, 500],
    'Ada Lovelace. The large L2 is what lets consumer GPUs get by with narrower GDDR memory.'],
  ['rtx5090', 'NVIDIA RTX 5090', 'GPU', 128,
    [['L1', 128 * KB, 8, 'typical'], ['L2', 96 * MB, 16, 'typical']], 'GDDR', [33, 250, 500],
    'Blackwell consumer part. Numbers are the published totals; the L1 is per streaming multiprocessor.'],
  ['a100', 'NVIDIA A100', 'GPU', 128,
    [['L1', 192 * KB, 8, 'typical'], ['L2', 40 * MB, 16, 'typical']], 'HBM', [33, 200, 600],
    'One streaming multiprocessor\'s view: its L1 (shared with shared memory) and the L2 shared by the whole GPU. A real kernel runs thousands of threads at once; this traces one thread\'s accesses in order.'],
  ['h100', 'NVIDIA H100', 'GPU', 128,
    [['L1', 256 * KB, 8, 'typical'], ['L2', 50 * MB, 16, 'typical']], 'HBM', [33, 260, 650],
    'One streaming multiprocessor\'s view of a Hopper GPU. The L2 is shared by the whole chip. This traces one thread\'s accesses in order, not a parallel kernel.'],
  ['h200', 'NVIDIA H200', 'GPU', 128,
    [['L1', 256 * KB, 8, 'typical'], ['L2', 50 * MB, 16, 'typical']], 'HBM', [33, 260, 600],
    'Same Hopper die as the H100 with faster, larger HBM3e. The caches are identical, so only the memory cost differs.'],
  ['mi300x', 'AMD MI300X', 'GPU', 128,
    [['L1', 32 * KB, 8, 'typical'], ['L2', 4 * MB, 16, 'typical'], ['L3', 256 * MB, 16, 'typical']], 'HBM', [50, 250, 450, 800],
    'CDNA 3. The L2 is one XCD\'s share and the L3 is the 256 MB Infinity Cache shared by the whole package.'],
  ['b200', 'NVIDIA B200', 'GPU', 128,
    [['L1', 256 * KB, 8, 'typical'], ['L2', 126 * MB, 16, 'typical']], 'HBM', [33, 260, 550],
    'Blackwell datacenter part, two dies on one package. The L2 figure is the reported total across both dies; HBM3E brings the memory cost down from Hopper. This traces one thread\'s accesses in order, not a parallel kernel.'],
  ['mi350x', 'AMD MI350X', 'GPU', 128,
    [['L1', 32 * KB, 8, 'typical'], ['L2', 4 * MB, 16, 'typical'], ['L3', 256 * MB, 16, 'typical']], 'HBM', [50, 250, 450, 750],
    'CDNA 4. Same cache layout as the MI300X (4 MB L2 per XCD, 256 MB Infinity Cache) with faster HBM3E, so the memory cost is a little lower.'],
  ['mi355x', 'AMD MI355X', 'GPU', 128,
    [['L1', 32 * KB, 8, 'typical'], ['L2', 4 * MB, 16, 'typical'], ['L3', 256 * MB, 16, 'typical']], 'HBM', [50, 250, 450, 750],
    'CDNA 4, the higher-clocked liquid-cooled version of the MI350X. The caches and memory are identical, so the trace matches the MI350X; the real difference is clock speed, which this model does not simulate.'],
];

for (const [id, name, group, lineBytes, levels, mem, cycles, note] of HARDWARE) {
  const L = lineBytes / 8;
  const gpu = group === 'GPU';
  MODES[id] = {
    kind: 'real', name, group, L, lineBytes,
    defaultN: gpu ? 512 : 256, maxN: gpu ? 1024 : 512,
    tiles: gpu ? [8, 16, 32, 64, 128, 256] : [8, 16, 32, 64, 128], defaultT: gpu ? 64 : 32,
    levels: levels.map(([, size, ways]) => ({ sets: size / (lineBytes * ways), ways })),
    cycles,
    names: [...levels.map(l => l[0]), mem],
    colors: [...LEVEL_COLORS.slice(0, levels.length), '--miss'],
    summary: levels.map(([nm, size]) => `${nm} ${fmtBytes(size)}`).join(', '),
    specs: [
      ['Cache line', `${lineBytes} B, so ${L} doubles`, tag(levels[0][3], levels[0][3])],
      ...levels.map(([nm, size, ways, how]) => [nm, `${fmtBytes(size)}, ${ways}-way`,
        `${tag(how, how === 'measured' ? 'size measured' : 'size ' + how)} ${tag('assumed', 'ways assumed')}`]),
      ['Replacement', 'LRU in every set', `${tag('assumed', 'assumed')} real chips approximate LRU`],
      ['Cost per access', [...levels.map(l => l[0]), mem].map((nm, i) => `${nm} ≈ ${cycles[i]}`).join(', ') + ' cycles', tag('assumed', 'rough estimates')],
    ],
    note: note + ' Matrices are 8-byte doubles, stored row by row, each starting on a fresh line.',
  };
}

const METHODS = [['Naive', 'ijk'], ['Reordered', 'ikj'], ['Tiled', 'tile']];
const METHOD_DESC = {
  ijk: 'The textbook triple loop. Each output walks down a column of B, so every step lands on a new cache line.',
  ikj: 'Inner loops swapped. B and C are read along rows, so every line that gets loaded is fully used.',
  tile: 'Works on small blocks at a time. The block in use stays in cache while it is reused.',
};

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
    this.sets = sets;
    this.tags = new Int32Array(sets * ways).fill(-1);
  }

  // Returns true for a hit, false for a miss.
  access(line) {
    const { tags, ways } = this;
    const base = (line % this.sets) * ways;
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
  const pct = (a, b) => (a / b * 100).toFixed(1) + '%';

  // every bar spans the full width, split by who served each access
  document.getElementById('cmp').innerHTML = runs.map(r => {
    const name = `<span class="name${r.m === method ? ' current' : ''}">${r.name}</span>`;
    if (!r.counts) return `${name}<div class="track"></div><span class="num">${percent(r.done / r.total)}</span>`;
    const c = r.counts;
    const segments = c.map((n, i) =>
      `<div class="fill" style="width:${(n / r.total * 100).toFixed(2)}%;background:var(${def.colors[i]})"></div>`).join('');
    const num = real
      ? `${def.names.map((nm, i) => `${nm} ${pct(c[i], r.total)}`).join(' · ')}<br>${(cyclesOf(c) / r.total).toFixed(1)} cycles / access`
      : `${pct(c[0], r.total)} hit · ${c[1].toLocaleString()} misses`;
    return `${name}<div class="track">${segments}</div><span class="num">${num}</span>`;
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
  ];
  return [
    ...names.slice(0, mem).map((nm, i) => [`${nm} hits`, () => counts[i].toLocaleString()]),
    [names[mem], () => counts[mem].toLocaleString()],
    ['L1 hit rate', hitRate],
    ['Cycles / access', () => (pos ? (cyclesOf(counts) / pos).toFixed(1) : '–')],
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
  // the progress bar fills with the run, split by who served each access, in the grid colors
  const done = total ? pos / total : 0;
  const fill = document.getElementById('progFill');
  fill.style.width = done * 100 + '%';
  fill.innerHTML = pos
    ? counts.map((c, i) => `<span style="width:${c / pos * 100}%;background:var(${MODES[mode].colors[i]})"></span>`).join('')
    : '';
  document.getElementById('progOut').textContent = percent(done);
  cards.forEach(([, get], i) => { document.getElementById('card' + i).textContent = get(); });
  document.getElementById('per').textContent =
    `${isReal() ? 'L1 misses' : 'Misses'} · A ${perMatrix[0].toLocaleString()} · B ${perMatrix[1].toLocaleString()} · C ${perMatrix[2].toLocaleString()}`;
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
  playBtn.textContent = playing ? 'Pause' : 'Play';
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
  document.querySelector('.tilefield').hidden = m !== 'tile';
  const desc = document.getElementById('methodDesc');
  document.getElementById('m' + m).insertAdjacentElement('afterend', desc);   // sits right under the chosen button
  desc.textContent = METHOD_DESC[m];
  desc.classList.remove('show');
  void desc.offsetWidth;            // restart the fade so the card pops on every change
  desc.classList.add('show');
  if (andReset) { reset(); renderComparison(); }
}
document.getElementById('mijk').addEventListener('click', () => setMethod('ijk'));
document.getElementById('mikj').addEventListener('click', () => setMethod('ikj'));
document.getElementById('mtile').addEventListener('click', () => setMethod('tile'));

const dimIn = ['aR', 'aC', 'bR', 'bC'].map(id => document.getElementById(id));
const dimStatus = document.getElementById('dimStatus');
function updateDims() {
  const def = MODES[mode];
  document.getElementById('dims').textContent = isReal()
    ? `${L} doubles per line · ${fmtBytes((M * K + K * P + M * P) * 8)} of matrices · ${def.summary}`
    : `${L} values per line`;
}

// Reads the four size boxes. Valid sizes rebuild the run; otherwise the page says why not and the
// current run is left alone, with Play and Step switched off.
function setSize() {
  const max = MODES[mode].maxN;
  const [aR, aC, bR, bC] = dimIn.map(el => Math.round(+el.value));
  const problem = ![aR, aC, bR, bC].every(v => v >= 1 && v <= max)
    ? `Sizes must be 1 to ${max}.`
    : aC !== bR
      ? `A's columns (${aC}) must match B's rows (${bR}).`
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
  const text = speed >= 1 ? speed.toLocaleString() + ' / frame' : '1 / ' + Math.round(1 / speed) + ' frames';
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
const hwSel = document.getElementById('hw');
const groups = [...new Set(HARDWARE.map(h => h[2]))];
hwSel.innerHTML = groups.map(g => `<optgroup label="${g}">${HARDWARE.filter(h => h[2] === g)
  .map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</optgroup>`).join('');

function buildLegend(m) {
  const item = (style, text) => `<span><span class="sw" style="${style}"></span>${text}</span>`;
  document.getElementById('legend').innerHTML = m.kind === 'teaching'
    ? item('background:var(--hit)', 'Hit') + item('background:var(--miss)', 'Miss') + item('background:var(--cached)', 'Cached')
    : m.names.map((nm, i) => item(`background:var(${m.colors[i]})`, nm)).join('')
      + item('background:var(--cached1)', 'In L1')
      + `<span><span class="sw cached2"></span>In L2</span>`;
}

function setMode(next) {
  mode = next;
  const m = MODES[mode];
  const real = m.kind === 'real';
  document.body.dataset.mode = m.kind;
  document.getElementById('modeTeaching').setAttribute('aria-pressed', String(!real));
  document.getElementById('modeHardware').setAttribute('aria-pressed', String(real));
  document.querySelector('.hwfield').hidden = !real;
  if (real) hwSel.value = mode;
  buildLegend(m);
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
document.getElementById('modeTeaching').addEventListener('click', () => mode !== 'teaching' && setMode('teaching'));
document.getElementById('modeHardware').addEventListener('click', () => isReal() || setMode(hwSel.value));
hwSel.addEventListener('change', () => setMode(hwSel.value));

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
