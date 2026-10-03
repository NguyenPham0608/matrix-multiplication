// ---------- Settings ----------
const L = 4;               // values per cache line
const T = 4;               // tile size for the tiled method
const N_MIN = 2, N_MAX = 1024;

// Values from the start of one matrix to the next: N * N rounded up to a whole cache line,
// so every matrix starts on a fresh line.
const strideFor = N => Math.ceil(N * N / L) * L;

// ---------- State ----------
let N = 16;                // matrices are N × N, set from the page
let STRIDE = strideFor(N);
let method = 'ijk';        // 'ijk' | 'ikj' | 'tile'
let CAP = 16;              // cache capacity in lines
let gen = null;            // hands out the current run's accesses, a chunk at a time
let chunk = null;          // the chunk gen last filled
let chunkLen = 0, chunkPos = 0;
let total = 0;             // how many accesses the whole run makes
let pos = 0;               // how many accesses we have simulated so far
let cache = null;          // the simulated cache (LRU)
let hits = 0, misses = 0;
let perMatrix = [0, 0, 0]; // misses for A, B, C
let playing = false;
let speed = 12;            // accesses per animation frame; below 1 means one access every 1/speed frames
let idle = 0;              // frames since the last access, used when slower than 1 per frame

// For drawing: when each address was last touched, plus a ring of the most recent accesses
let lastTime = null;
const RECENT = 4096;                       // the most accesses a fade can span
const recentAddr = new Int32Array(RECENT); // access number t is stored at t % RECENT
const recentHit = new Uint8Array(RECENT);

// ---------- 1. Build the access sequence ----------
// Each access is a memory address, counted in values. Matrix M (0 = A, 1 = B, 2 = C) starts at
// M * stride, and its element [r][c] is r * N + c after that. Address / L is the cache line.
//
// A run makes about 2N³ accesses, billions at N = 1024, too many to store. So this generator
// fills buf with the accesses of one inner loop at a time and yields how many it wrote.
function* accessChunks(m, N, buf) {
  const stride = strideFor(N);
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
function totalAccesses(m, N) {
  const innerLoops = m === 'tile' ? N * N * Math.ceil(N / T) : N * N;
  return 2 * N ** 3 + innerLoops;
}

// ---------- 2. The cache ----------
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

// ---------- 3. Full-run comparison ----------
// Runs one method to the end and counts hits. At N = 1024 that takes a while, so it runs in a
// background worker (one per method) and reports progress with postMessage.
function fullRun(m, N, CAP) {
  const cache = new LRU(3 * strideFor(N) / L, CAP);
  const buf = new Int32Array(2 * N + 1);
  let hits = 0, done = 0, nextReport = 0;
  for (const n of accessChunks(m, N, buf)) {
    for (let q = 0; q < n; q++) if (cache.access(Math.floor(buf[q] / L))) hits++;
    done += n;
    if (done >= nextReport) { postMessage({ done }); nextReport += 1 << 24; }
  }
  postMessage({ done, hits });
}

// The worker runs the same functions as the page, copied in as source text.
const workerURL = URL.createObjectURL(new Blob([`
  const L = ${L}, T = ${T};
  const strideFor = ${strideFor};
  ${accessChunks}
  ${LRU}
  ${fullRun}
  onmessage = e => fullRun(...e.data);
`], { type: 'text/javascript' }));

const METHODS = [['i, j, k', 'ijk'], ['i, k, j', 'ikj'], ['Tiled', 'tile']];
let workers = [];
let runs = [];

function startComparison() {
  workers.forEach(w => w.terminate());
  runs = METHODS.map(([name, m]) => ({ name, total: totalAccesses(m, N), done: 0, hits: null }));
  workers = METHODS.map(([, m], i) => {
    const w = new Worker(workerURL);
    w.onmessage = e => {
      Object.assign(runs[i], e.data);
      if (runs[i].hits !== null) w.terminate();
      renderComparison();
    };
    w.postMessage([m, N, CAP]);
    return w;
  });
  renderComparison();
}

function renderComparison() {
  const max = Math.max(1, ...runs.filter(r => r.hits !== null).map(r => r.total - r.hits));

  document.getElementById('cmp').innerHTML = runs.map(r => r.hits === null ? `
    <span>${r.name}</span>
    <div class="track"></div>
    <span class="num">running, ${percent(r.done / r.total)}</span>
  ` : `
    <span>${r.name}</span>
    <div class="track"><div class="fill" style="width:${Math.max(0.5, (r.total - r.hits) / max * 100).toFixed(1)}%"></div></div>
    <span class="num">${(r.total - r.hits).toLocaleString()} misses, ${(r.hits / r.total * 100).toFixed(1)}% hits</span>
  `).join('');
}

// Extra decimals while small, so progress through the huge runs at large N still shows
function percent(f) {
  return (f * 100).toFixed(f < 0.01 ? 2 : f < 0.1 ? 1 : 0) + '%';
}

// ---------- 4. Stepping the simulation ----------
function reset() {
  playing = false;
  updatePlayButton();
  gen = accessChunks(method, N, chunk);
  chunkLen = chunkPos = 0;
  total = totalAccesses(method, N);
  pos = 0;
  cache = new LRU(3 * STRIDE / L, CAP);
  hits = 0; misses = 0; perMatrix = [0, 0, 0];
  updateStats();
}

function advance(n) {
  for (let q = 0; q < n && pos < total; q++) {
    if (chunkPos === chunkLen) { chunkLen = gen.next().value; chunkPos = 0; }
    const x = chunk[chunkPos++];
    const hit = cache.access(Math.floor(x / L));
    if (hit) hits++; else { misses++; perMatrix[Math.floor(x / STRIDE)]++; }
    lastTime[x] = pos;
    recentAddr[pos % RECENT] = x;
    recentHit[pos % RECENT] = hit ? 1 : 0;
    pos++;
  }
  if (pos >= total) { playing = false; updatePlayButton(); }
}

function updateStats() {
  document.getElementById('hits').textContent = hits.toLocaleString();
  document.getElementById('miss').textContent = misses.toLocaleString();
  document.getElementById('rate').textContent = pos ? (hits / pos * 100).toFixed(1) + '%' : '–';
  document.getElementById('prog').textContent = percent(pos / total);
  document.getElementById('per').textContent =
    `Misses by matrix: A ${perMatrix[0]}, B ${perMatrix[1]}, C ${perMatrix[2]}`;
}

// ---------- 5. Drawing ----------
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const GAP = 24;       // space between the three grids
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
}

function draw() {
  const css = getComputedStyle(document.documentElement);
  const color = name => css.getPropertyValue(name).trim();
  const muted = color('--muted'), border = color('--border-strong');
  const hitC = color('--hit'), missC = color('--miss'), cachedC = color('--cached');

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

  // lines currently in the cache
  ctx.fillStyle = cachedC;
  for (const line of cache.lines())
    for (let v = 0; v < L; v++) fillCell(line * L + v);

  // recently accessed: hit or miss, fading with age. Oldest first, and each cell
  // only for its latest access.
  for (let age = Math.min(fadeWindow, pos) - 1; age >= 0; age--) {
    const t = pos - 1 - age, x = recentAddr[t % RECENT];
    if (lastTime[x] !== t) continue;
    ctx.fillStyle = recentHit[t % RECENT] ? hitC : missC;
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
  draw();
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

function setMethod(m) {
  method = m;
  for (const k of ['ijk', 'ikj', 'tile'])
    document.getElementById('m' + k).setAttribute('aria-pressed', String(k === m));
  reset();
}
document.getElementById('mijk').addEventListener('click', () => setMethod('ijk'));
document.getElementById('mikj').addEventListener('click', () => setMethod('ikj'));
document.getElementById('mtile').addEventListener('click', () => setMethod('tile'));

const sizeIn = document.getElementById('size');
function setSize() {
  N = Math.min(N_MAX, Math.max(N_MIN, Math.round(+sizeIn.value) || N));
  sizeIn.value = N;
  STRIDE = strideFor(N);
  lastTime = new Float64Array(3 * STRIDE);
  chunk = new Int32Array(2 * N + 1);  // the longest inner loop: 2N accesses plus 1
  document.getElementById('dims').textContent = `Line = ${L} values, matrices ${N}×${N}`;
  resize();
  reset();
  startComparison();
}
sizeIn.addEventListener('change', setSize);

// The speed slider is logarithmic: from 1 access every 120 frames (about 2 s) up to a million per frame.
const SPEED_MIN = 1 / 120, SPEED_MAX = 1e6;
const speedIn = document.getElementById('speed');
function setSpeed() {
  const s = SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, speedIn.value / speedIn.max);
  speed = s >= 1 ? Math.round(s) : 1 / Math.round(1 / s);
  const text = speed >= 1 ? speed.toLocaleString() + ' / frame' : '1 per ' + Math.round(1 / speed) + ' frames';
  document.getElementById('speedOut').textContent = text;
  speedIn.setAttribute('aria-valuetext', text);
}
speedIn.addEventListener('input', setSpeed);
document.getElementById('cap').addEventListener('input', e => {
  CAP = +e.target.value;
  document.getElementById('capOut').textContent = CAP + ' lines';
  startComparison();
  reset();
});

window.addEventListener('resize', resize);

// ---------- Start ----------
setSpeed();
setSize();
loop();
