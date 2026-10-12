/*
 * Core logic: problem generation, round engine, statistics, storage format,
 * backup import/export. No DOM access, so it runs in the browser (as a classic
 * script exposing window.ZCore) and in Node for tests (module.exports).
 */
(function (root) {
  'use strict';

  const OPS = ['add', 'sub', 'mul', 'div'];
  const OP_SYMBOL = { add: '+', sub: '−', mul: '×', div: '÷' };
  const OP_NAME = { add: 'Addition', sub: 'Subtraction', mul: 'Multiplication', div: 'Division' };
  const OP_CODE = { add: 'a', sub: 's', mul: 'm', div: 'd' };
  const CODE_OP = { a: 'add', s: 'sub', m: 'mul', d: 'div' };

  // Ranges: { add: [[min,max],[min,max]], mul: [[min,max],[min,max]] } (inclusive).
  const PRESETS = {
    easy: { add: [[2, 60], [2, 60]], mul: [[2, 12], [2, 20]] },
    medium: { add: [[2, 100], [2, 100]], mul: [[2, 12], [2, 100]] },
    hard: { add: [[2, 300], [2, 300]], mul: [[2, 20], [2, 200]] },
  };
  const DIFFICULTIES = ['easy', 'medium', 'hard', 'custom'];
  const DURATIONS = { 60: 'Bullet', 120: 'Blitz', 180: 'Rapid' };
  const RANGE_LIMIT = 100000;
  const MIN_PAIR_SAMPLES = 5;
  const SLOWEST_POOL_SIZE = 15;
  const MIN_SLOWEST_PAIRS = 3;

  const BACKUP_FORMAT = 'zetamac-local-backup';
  const BACKUP_VERSION = 1;
  const SESSION_PREFIX = 'zetamac.session.';
  const SETTINGS_KEY = 'zetamac.settings';

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const isInt = (n) => Number.isInteger(n);
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function defaultSettings() {
    return {
      mode: 'standard',
      difficulty: 'medium',
      custom: clone(PRESETS.medium),
      duration: 120,
      ops: { add: true, sub: true, mul: true, div: true },
      targeted: {
        focus: 'slowest',
        numbers: '7, 8',
        pairs: '7x8, 6x9, 7x12',
        partner: [2, 12],
        randomPct: 25,
        ops: { add: true, sub: true, mul: true, div: true },
      },
    };
  }

  /* ---------------- validation helpers ---------------- */

  function validRange(r) {
    return Array.isArray(r) && r.length === 2 && isInt(r[0]) && isInt(r[1]) &&
      r[0] >= 1 && r[1] >= r[0] && r[1] <= RANGE_LIMIT;
  }

  function validRanges(ranges) {
    return !!ranges && Array.isArray(ranges.add) && Array.isArray(ranges.mul) &&
      ranges.add.length === 2 && ranges.mul.length === 2 &&
      validRange(ranges.add[0]) && validRange(ranges.add[1]) &&
      validRange(ranges.mul[0]) && validRange(ranges.mul[1]);
  }

  function rangesFor(settings) {
    if (settings.difficulty === 'custom') return clone(settings.custom);
    return clone(PRESETS[settings.difficulty]);
  }

  function enabledOps(opsObj) {
    return OPS.filter((o) => opsObj[o]);
  }

  // Merge stored settings over defaults, discarding anything malformed.
  function sanitizeSettings(raw) {
    const s = defaultSettings();
    if (!raw || typeof raw !== 'object') return s;
    if (raw.mode === 'standard' || raw.mode === 'targeted') s.mode = raw.mode;
    if (DIFFICULTIES.includes(raw.difficulty)) s.difficulty = raw.difficulty;
    if (validRanges(raw.custom)) s.custom = clone(raw.custom);
    if (DURATIONS[raw.duration]) s.duration = Number(raw.duration);
    if (raw.ops && typeof raw.ops === 'object') {
      const ops = {};
      OPS.forEach((o) => { ops[o] = !!raw.ops[o]; });
      if (enabledOps(ops).length) s.ops = ops;
    }
    const t = raw.targeted;
    if (t && typeof t === 'object') {
      if (['numbers', 'pairs', 'slowest'].includes(t.focus)) s.targeted.focus = t.focus;
      if (typeof t.numbers === 'string') s.targeted.numbers = t.numbers.slice(0, 500);
      if (typeof t.pairs === 'string') s.targeted.pairs = t.pairs.slice(0, 1000);
      if (validRange(t.partner)) s.targeted.partner = t.partner.slice();
      if (isInt(t.randomPct) && t.randomPct >= 0 && t.randomPct <= 50) s.targeted.randomPct = t.randomPct;
      if (t.ops && typeof t.ops === 'object') {
        const ops = {};
        OPS.forEach((o) => { ops[o] = !!t.ops[o]; });
        if (enabledOps(ops).length) s.targeted.ops = ops;
      }
    }
    return s;
  }

  /* ---------------- random & generation ---------------- */

  function randInt(min, max, rng) {
    return min + Math.floor(rng() * (max - min + 1));
  }

  function makeQuestion(op, a, b) {
    switch (op) {
      case 'add': return { op, left: a, right: b, answer: a + b };
      case 'sub': return { op, left: a + b, right: a, answer: b };
      case 'mul': return { op, left: a, right: b, answer: a * b };
      case 'div': return { op, left: a * b, right: a, answer: b };
      default: throw new Error('Unknown op ' + op);
    }
  }

  // Standard mode: uniform op among enabled ones, then independent uniform operands.
  function generateStandard(ranges, ops, rng) {
    const op = ops[Math.floor(rng() * ops.length)];
    const r = op === 'add' || op === 'sub' ? ranges.add : ranges.mul;
    return makeQuestion(op, randInt(r[0][0], r[0][1], rng), randInt(r[1][0], r[1][1], rng));
  }

  function checkAnswer(input, answer) {
    const s = String(input).trim();
    return /^\d+$/.test(s) && Number(s) === answer;
  }

  /* ---------------- targeted practice ---------------- */

  function parseNumbers(text) {
    const out = [];
    String(text).split(/[\s,;]+/).forEach((tok) => {
      if (!tok) return;
      if (!/^\d+$/.test(tok)) throw new Error(`"${tok}" is not a whole number`);
      const n = Number(tok);
      if (n < 1 || n > RANGE_LIMIT) throw new Error(`${n} is out of range`);
      if (!out.includes(n)) out.push(n);
    });
    return out;
  }

  // Operand pairs such as "7x8, 6 9, 47+38". Order is not significant.
  function parsePairs(text) {
    const out = [];
    const seen = new Set();
    String(text).split(/[,;\n]+/).forEach((tok) => {
      tok = tok.trim();
      if (!tok) return;
      const m = /^(\d+)\s*(?:[x×*+]|\s)\s*(\d+)$/i.exec(tok);
      if (!m) throw new Error(`"${tok}" is not a pair like 7x8`);
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a < 1 || b < 1 || a > RANGE_LIMIT || b > RANGE_LIMIT) throw new Error(`${tok} is out of range`);
      const key = pairKey(a, b);
      if (!seen.has(key)) { seen.add(key); out.push([a, b]); }
    });
    return out;
  }

  function pairKey(a, b) {
    return a <= b ? `${a}×${b}` : `${b}×${a}`;
  }

  // Normalise the targeted settings into the config stored with a session.
  function targetConfig(t) {
    const cfg = { focus: t.focus, randomPct: t.randomPct };
    if (t.focus === 'numbers') {
      cfg.numbers = parseNumbers(t.numbers);
      if (!cfg.numbers.length) throw new Error('Enter at least one number to practise.');
      if (!validRange(t.partner)) throw new Error('The partner range is invalid.');
      cfg.partner = t.partner.slice();
    } else if (t.focus === 'pairs') {
      cfg.pairs = parsePairs(t.pairs);
      if (!cfg.pairs.length) throw new Error('Enter at least one pair, e.g. 7x8.');
    }
    return cfg;
  }

  const inR = (n, r) => n >= r[0] && n <= r[1];

  // Generator operands (a from the first range, b from the second) behind a question.
  function operandsOf(q) {
    if (q.op === 'sub' || q.op === 'div') return [q.right, q.answer];
    return [q.left, q.right];
  }

  // A "problem" is what the learner sees: a + b and a × b ignore order; a − b and a ÷ b keep it.
  function problemKey(q) {
    const sym = OP_SYMBOL[q.op];
    if (q.op === 'add' || q.op === 'mul') return `${Math.min(q.left, q.right)} ${sym} ${Math.max(q.left, q.right)}`;
    return `${q.left} ${sym} ${q.right}`;
  }

  // Could the standard generator produce this problem with these ranges?
  function problemFits(q, ranges) {
    const [r0, r1] = q.op === 'add' || q.op === 'sub' ? ranges.add : ranges.mul;
    const [a, b] = operandsOf(q);
    if (q.op === 'add' || q.op === 'mul') return (inR(a, r0) && inR(b, r1)) || (inR(b, r0) && inR(a, r1));
    return inR(a, r0) && inR(b, r1);
  }

  /*
   * Per-problem timing for one operation, from questions with any status.
   * Completed answers give count/median; unfinished ones are tracked separately.
   */
  function problemStats(questions, op) {
    const map = new Map();
    for (const q of questions) {
      if (q.op !== op) continue;
      const key = problemKey(q);
      let g = map.get(key);
      if (!g) {
        const sample = (q.op === 'add' || q.op === 'mul')
          ? { left: Math.min(q.left, q.right), right: Math.max(q.left, q.right) } : { left: q.left, right: q.right };
        g = { key, op, left: sample.left, right: sample.right, answer: q.answer, times: [], unfinished: [] };
        map.set(key, g);
      }
      (q.status === 'completed' ? g.times : g.unfinished).push(q.ms);
    }
    return Array.from(map.values()).map((g) => {
      const s = summarize(g.times);
      return { key: g.key, op, left: g.left, right: g.right, answer: g.answer, count: s.count, median: s.median, mean: s.mean,
        max: s.max, unfinishedCount: g.unfinished.length, unfinishedMax: g.unfinished.length ? Math.max(...g.unfinished) : null };
    });
  }

  /*
   * Slowest-problem candidates for one operation, inside the current ranges.
   * - Problems with MIN_PAIR_SAMPLES+ completed answers score their median time.
   * - Problems left unfinished at the buzzer score the time spent on them, but only
   *   when that is longer than the operation's typical (median) completed time.
   * Unfinished times are capped at 3× the typical time so one stalled question can't dominate.
   */
  function slowestCandidates(questions, op, ranges) {
    const typical = median(questions.filter((q) => q.op === op && q.status === 'completed').map((q) => q.ms));
    const cap = typical ? typical * 3 : Infinity;
    const out = [];
    for (const p of problemStats(questions, op)) {
      if (!problemFits({ op, left: p.left, right: p.right, answer: p.answer }, ranges)) continue;
      const sampled = p.count >= MIN_PAIR_SAMPLES;
      const stalled = p.unfinishedCount > 0 && (typical == null || p.unfinishedMax > typical);
      if (!sampled && !stalled) continue;
      const score = Math.max(sampled ? p.median : 0, stalled ? Math.min(p.unfinishedMax, cap) : 0);
      out.push(Object.assign({}, p, { score, sampled, stalled }));
    }
    return out.sort((x, y) => y.score - x.score || y.count - x.count || (x.key < y.key ? -1 : 1))
      .slice(0, SLOWEST_POOL_SIZE);
  }

  function weightedPick(pool, rng) {
    let u = rng();
    for (const p of pool) { if ((u -= p.weight) < 0) return p; }
    return pool[pool.length - 1];
  }

  /*
   * Question source for targeted mode across the selected operations.
   * `history` is a list of past questions (completed and unfinished) from completed rounds.
   * Each question first picks an operation evenly, then either a random question for it
   * (randomPct%, or always when that operation has too little history) or a targeted one.
   * Returns { next(rng), fallback, randomOps, pools }.
   */
  function buildTargetPlan(cfg, ranges, ops, history) {
    const randomShare = cfg.randomPct / 100;
    const pickers = {};
    const pools = {};
    const randomOps = [];

    for (const op of ops) {
      if (cfg.focus === 'numbers') {
        pickers[op] = (rng) => [cfg.numbers[Math.floor(rng() * cfg.numbers.length)], randInt(cfg.partner[0], cfg.partner[1], rng)];
      } else if (cfg.focus === 'pairs') {
        pickers[op] = (rng) => cfg.pairs[Math.floor(rng() * cfg.pairs.length)].slice();
      } else {
        const cands = slowestCandidates(history, op, ranges);
        if (cands.length < MIN_SLOWEST_PAIRS) { randomOps.push(op); pools[op] = []; continue; }
        const weights = cands.map((p) => p.score * p.score);
        const total = weights.reduce((x, y) => x + y, 0);
        pools[op] = cands.map((p, i) => Object.assign({}, p, { weight: weights[i] / total }));
        // Sub/div keep their exact orientation; add/mul are shuffled in next().
        pickers[op] = (rng) => operandsOf(weightedPick(pools[op], rng));
      }
    }

    let fallback = null;
    if (randomOps.length === ops.length) {
      fallback = 'Not enough history yet, so this round is random practice. Slowest-problem practice needs ' +
        `${MIN_SLOWEST_PAIRS} problems per operation that you've answered ${MIN_PAIR_SAMPLES}+ times or left unfinished.`;
    } else if (randomOps.length) {
      fallback = `Random questions for ${randomOps.map((o) => OP_NAME[o].toLowerCase()).join(', ')}: not enough history yet.`;
    }

    let prevKey = null;
    function next(rng) {
      const op = ops[Math.floor(rng() * ops.length)];
      let q;
      if (!pickers[op] || rng() < randomShare) {
        q = generateStandard(ranges, [op], rng);
        q.source = 'random';
      } else {
        // Avoid showing the identical problem twice in a row when there is a choice.
        for (let i = 0; i < 20; i++) {
          let [a, b] = pickers[op](rng);
          if (cfg.focus !== 'slowest' || op === 'add' || op === 'mul') { if (rng() < 0.5) [a, b] = [b, a]; }
          q = makeQuestion(op, a, b);
          if (problemKey(q) !== prevKey) break;
        }
        q.source = 'target';
      }
      prevKey = problemKey(q);
      return q;
    }
    return { next, fallback, randomOps, pools };
  }

  /* ---------------- round engine ---------------- */

  function makeId() {
    const c = root.crypto;
    if (c && typeof c.randomUUID === 'function') {
      try { return c.randomUUID(); } catch (e) { /* insecure context */ }
    }
    const bytes = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /*
   * A single round. Times passed in are monotonic milliseconds (performance.now()).
   * opts: { id, startedAt (epoch ms), mode, difficulty, ranges, ops, duration, target, nextQuestion() }
   */
  class Round {
    constructor(opts) {
      this.opts = opts;
      this.state = 'ready';
      this.score = 0;
      this.records = [];
      this.current = opts.nextQuestion();
      this.deadline = null;
    }

    // Call once the first question is on screen and the input is focused.
    start(now) {
      if (this.state !== 'ready') return;
      this.state = 'running';
      this.startTime = now;
      this.deadline = now + this.opts.duration * 1000;
      this.current.shownAt = now;
    }

    remaining(now) {
      if (this.state === 'ready') return this.opts.duration * 1000;
      if (this.state !== 'running') return 0;
      return Math.max(0, this.deadline - now);
    }

    isExpired(now) {
      return this.state === 'running' && now >= this.deadline;
    }

    // Called on every edit. Returns 'correct' | 'pending' | 'expired' | 'closed'.
    input(value, now) {
      if (this.state !== 'running') return 'closed';
      if (now >= this.deadline) return 'expired';
      const q = this.current;
      if (!checkAnswer(value, q.answer)) return 'pending';
      this.records.push(this._record(q, now - q.shownAt, 'completed'));
      this.score++;
      this.current = this.opts.nextQuestion();
      this.current.shownAt = now;
      return 'correct';
    }

    _record(q, ms, status) {
      const r = { order: this.records.length + 1, op: q.op, left: q.left, right: q.right, answer: q.answer,
        ms: Math.max(0, Math.round(ms)), status };
      if (q.source) r.source = q.source;
      return r;
    }

    // Ends the round and returns the session exactly once (null afterwards).
    finish(now, reason) {
      if (this.state !== 'running') return null;
      this.state = 'ended';
      const abandoned = reason === 'abandoned';
      const end = abandoned ? Math.min(now, this.deadline) : this.deadline;
      this.records.push(this._record(this.current, end - this.current.shownAt, 'unfinished'));
      const o = this.opts;
      const session = {
        id: o.id,
        startedAt: o.startedAt,
        mode: o.mode,
        difficulty: o.difficulty,
        ranges: clone(o.ranges),
        ops: o.ops.slice(),
        duration: o.duration,
        score: this.score,
        status: abandoned ? 'abandoned' : 'completed',
        questions: this.records,
      };
      if (o.target) session.target = clone(o.target);
      return session;
    }
  }

  /* ---------------- settings keys & labels ---------------- */

  const rangeStr = (r) => `${r[0]}-${r[1]}`;
  const rangeLabel = (r) => (r[0] === r[1] ? `${r[0]}` : `${r[0]}–${r[1]}`);
  const sameRange = (x, y) => x[0] === y[0] && x[1] === y[1];
  const samePair = (x, y) => sameRange(x[0], y[0]) && sameRange(x[1], y[1]);

  function usesAdd(ops) { return ops.includes('add') || ops.includes('sub'); }
  function usesMul(ops) { return ops.includes('mul') || ops.includes('div'); }

  // Sessions are only compared when this key matches.
  function settingsKey(s) {
    const mul = `mul:${rangeStr(s.ranges.mul[0])},${rangeStr(s.ranges.mul[1])}`;
    if (s.mode === 'targeted') {
      const t = s.target || { focus: 'slowest', randomPct: 0 };
      let detail = 'slowest';
      if (t.focus === 'numbers') detail = `numbers:${t.numbers.join(',')}|partner:${rangeStr(t.partner)}`;
      if (t.focus === 'pairs') detail = `pairs:${t.pairs.map((p) => pairKey(p[0], p[1])).sort().join(',')}`;
      const ops = OPS.filter((o) => s.ops.includes(o));
      // Multiplication-only keys keep the original format, so older targeted rounds still compare.
      if (ops.length === 1 && ops[0] === 'mul') return `targeted|${s.duration}|${detail}|random:${t.randomPct}|${mul}`;
      const parts = ['targeted', s.duration, detail, `random:${t.randomPct}`, `ops:${ops.join('+')}`];
      if (usesAdd(ops)) parts.push(`add:${rangeStr(s.ranges.add[0])},${rangeStr(s.ranges.add[1])}`);
      if (usesMul(ops)) parts.push(mul);
      return parts.join('|');
    }
    const ops = OPS.filter((o) => s.ops.includes(o));
    const parts = ['standard', s.duration, ops.join('+')];
    if (usesAdd(ops)) parts.push(`add:${rangeStr(s.ranges.add[0])},${rangeStr(s.ranges.add[1])}`);
    if (usesMul(ops)) parts.push(mul);
    return parts.join('|');
  }

  // Name the ranges by preset when the relevant ranges match one.
  function difficultyLabel(ranges, ops) {
    for (const name of ['easy', 'medium', 'hard']) {
      const p = PRESETS[name];
      if ((!usesAdd(ops) || samePair(p.add, ranges.add)) && (!usesMul(ops) || samePair(p.mul, ranges.mul))) {
        return capitalize(name);
      }
    }
    const parts = [];
    if (usesAdd(ops)) parts.push(`add ${rangeLabel(ranges.add[0])} & ${rangeLabel(ranges.add[1])}`);
    if (usesMul(ops)) parts.push(`mul ${rangeLabel(ranges.mul[0])} × ${rangeLabel(ranges.mul[1])}`);
    return `Custom (${parts.join('; ')})`;
  }

  function durationLabel(d) {
    return DURATIONS[d] ? `${DURATIONS[d]} ${d}s` : `${d}s`;
  }

  function settingsLabel(s) {
    if (s.mode === 'targeted') {
      const t = s.target || {};
      const ops = OPS.filter((o) => s.ops.includes(o));
      let focus = 'slowest problems';
      if (t.focus === 'numbers') focus = `numbers ${t.numbers.join(', ')} with ${rangeLabel(t.partner)}`;
      if (t.focus === 'pairs') focus = `pairs ${t.pairs.map((p) => `${p[0]}&${p[1]}`).join(', ')}`;
      return `Targeted · ${focus} · ${ops.map((o) => OP_SYMBOL[o]).join(' ')} · ${t.randomPct}% random · ` +
        `${difficultyLabel(s.ranges, ops)} · ${durationLabel(s.duration)}`;
    }
    const ops = OPS.filter((o) => s.ops.includes(o));
    return `${difficultyLabel(s.ranges, ops)} · ${durationLabel(s.duration)} · ${ops.map((o) => OP_SYMBOL[o]).join(' ')}`;
  }

  /* ---------------- statistics ---------------- */

  function median(values) {
    if (!values.length) return null;
    const v = values.slice().sort((x, y) => x - y);
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  function summarize(times) {
    if (!times.length) return { count: 0, mean: null, median: null, total: 0, max: null, min: null };
    let total = 0;
    let max = -Infinity;
    let min = Infinity;
    for (const t of times) { total += t; if (t > max) max = t; if (t < min) min = t; }
    return { count: times.length, mean: total / times.length, median: median(times), total, max, min };
  }

  const completedOf = (questions) => questions.filter((q) => q.status === 'completed');
  const unfinishedOf = (questions) => questions.filter((q) => q.status === 'unfinished');

  function opBreakdown(questions) {
    const out = {};
    OPS.forEach((op) => {
      out[op] = summarize(questions.filter((q) => q.status === 'completed' && q.op === op).map((q) => q.ms));
    });
    return out;
  }

  // Completed multiplication facts. `a` is the first-factor role, `b` the second.
  // Division (a×b)÷a contributes divisor a and quotient b when includeDivision is set.
  function mulObservations(questions, includeDivision) {
    const obs = [];
    for (const q of questions) {
      if (q.status !== 'completed') continue;
      if (q.op === 'mul') obs.push({ a: q.left, b: q.right, ms: q.ms, op: 'mul' });
      else if (includeDivision && q.op === 'div') obs.push({ a: q.right, b: q.answer, ms: q.ms, op: 'div' });
    }
    return obs;
  }

  // Groups 7×8 and 8×7 together.
  function pairStats(obs) {
    const map = new Map();
    for (const o of obs) {
      const lo = Math.min(o.a, o.b);
      const hi = Math.max(o.a, o.b);
      const key = `${lo}×${hi}`;
      let g = map.get(key);
      if (!g) { g = { key, lo, hi, times: [] }; map.set(key, g); }
      g.times.push(o.ms);
    }
    return Array.from(map.values()).map((g) => {
      const s = summarize(g.times);
      return { key: g.key, lo: g.lo, hi: g.hi, count: s.count, mean: s.mean, median: s.median, max: s.max };
    });
  }

  function rankPairs(stats, minN) {
    const n = minN || MIN_PAIR_SAMPLES;
    const byMedian = (x, y) => y.median - x.median || y.count - x.count || x.lo - y.lo || x.hi - y.hi;
    return {
      ranked: stats.filter((p) => p.count >= n).sort(byMedian),
      small: stats.filter((p) => p.count < n).sort(byMedian),
    };
  }

  // Each question counts once per number, so 7×7 adds one sample to 7.
  function numberStats(obs) {
    const map = new Map();
    for (const o of obs) {
      for (const n of new Set([o.a, o.b])) {
        if (!map.has(n)) map.set(n, []);
        map.get(n).push(o.ms);
      }
    }
    return Array.from(map.entries()).map(([n, times]) => Object.assign({ n }, summarize(times)))
      .sort((x, y) => x.n - y.n);
  }

  const SIZE_BUCKETS = [
    [1, 5, '≤5'], [6, 9, '6–9'], [10, 12, '10–12'], [13, 20, '13–20'], [21, 50, '21–50'],
    [51, 100, '51–100'], [101, 200, '101–200'], [201, Infinity, '201+'],
  ];

  function numberBreakdown(obs, n) {
    const first = obs.filter((o) => o.a === n).map((o) => o.ms);
    const second = obs.filter((o) => o.b === n).map((o) => o.ms);
    const involving = obs.filter((o) => o.a === n || o.b === n);
    const buckets = SIZE_BUCKETS.map(([lo, hi, label]) => {
      const times = involving.filter((o) => {
        const other = o.a === n ? o.b : o.a;
        return other >= lo && other <= hi;
      }).map((o) => o.ms);
      return Object.assign({ label, lo, hi }, summarize(times));
    }).filter((b) => b.count > 0);
    return {
      n,
      all: summarize(involving.map((o) => o.ms)),
      first: summarize(first),
      second: summarize(second),
      squares: summarize(involving.filter((o) => o.a === o.b).map((o) => o.ms)),
      buckets,
    };
  }

  function personalBest(sessions, key, excludeId) {
    let best = null;
    for (const s of sessions) {
      if (s.status !== 'completed' || s.id === excludeId) continue;
      if (settingsKey(s) !== key) continue;
      if (!best || s.score > best.score) best = s;
    }
    return best;
  }

  /* ---------------- validation & serialisation ---------------- */

  function validateQuestion(q) {
    if (!q || typeof q !== 'object') throw new Error('question is not an object');
    if (!OPS.includes(q.op)) throw new Error('bad operation');
    for (const k of ['left', 'right', 'answer']) {
      if (!isInt(q[k]) || q[k] < 0) throw new Error(`bad ${k}`);
    }
    const ok = { add: q.left + q.right, sub: q.left - q.right, mul: q.left * q.right,
      div: q.right ? q.left / q.right : NaN }[q.op];
    if (ok !== q.answer) throw new Error('answer does not match operands');
    if (typeof q.ms !== 'number' || !isFinite(q.ms) || q.ms < 0 || q.ms > 3600e3) throw new Error('bad time');
    if (q.status !== 'completed' && q.status !== 'unfinished') throw new Error('bad question status');
    const out = { op: q.op, left: q.left, right: q.right, answer: q.answer, ms: Math.round(q.ms), status: q.status };
    if (q.source === 'target' || q.source === 'random') out.source = q.source;
    return out;
  }

  // Validates and normalises a full (readable) session object. Throws on error.
  function validateSession(x) {
    if (!x || typeof x !== 'object') throw new Error('session is not an object');
    if (typeof x.id !== 'string' || !/^[\w-]{1,100}$/.test(x.id)) throw new Error('bad id');
    const startedAt = typeof x.startedAt === 'string' ? Date.parse(x.startedAt) : x.startedAt;
    if (typeof startedAt !== 'number' || !isFinite(startedAt)) throw new Error('bad timestamp');
    if (x.mode !== 'standard' && x.mode !== 'targeted') throw new Error('bad mode');
    if (!DIFFICULTIES.includes(x.difficulty)) throw new Error('bad difficulty');
    if (!validRanges(x.ranges)) throw new Error('bad ranges');
    if (!Array.isArray(x.ops) || !x.ops.length || !x.ops.every((o) => OPS.includes(o))) throw new Error('bad ops');
    if (typeof x.duration !== 'number' || !(x.duration > 0) || x.duration > 3600) throw new Error('bad duration');
    if (!isInt(x.score) || x.score < 0) throw new Error('bad score');
    if (x.status !== 'completed' && x.status !== 'abandoned') throw new Error('bad status');
    if (!Array.isArray(x.questions)) throw new Error('missing questions');
    let qs = x.questions.slice();
    if (qs.every((q) => q && isInt(q.order))) qs.sort((p, q) => p.order - q.order);
    qs = qs.map((q, i) => Object.assign({ order: i + 1 }, validateQuestion(q)));
    if (completedOf(qs).length !== x.score) throw new Error('score does not match completed questions');
    const s = {
      id: x.id, startedAt, mode: x.mode, difficulty: x.difficulty, ranges: clone(x.ranges),
      ops: OPS.filter((o) => x.ops.includes(o)), duration: x.duration, score: x.score, status: x.status,
      questions: qs,
    };
    if (x.mode === 'targeted') {
      const t = x.target;
      if (!t || !['numbers', 'pairs', 'slowest'].includes(t.focus)) throw new Error('bad target');
      if (!isInt(t.randomPct) || t.randomPct < 0 || t.randomPct > 100) throw new Error('bad target mix');
      s.target = { focus: t.focus, randomPct: t.randomPct };
      if (t.focus === 'numbers') {
        if (!Array.isArray(t.numbers) || !t.numbers.length || !t.numbers.every((n) => isInt(n) && n >= 1)) throw new Error('bad target numbers');
        if (!validRange(t.partner)) throw new Error('bad target partner');
        s.target.numbers = t.numbers.slice();
        s.target.partner = t.partner.slice();
      }
      if (t.focus === 'pairs') {
        if (!Array.isArray(t.pairs) || !t.pairs.length || !t.pairs.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => isInt(n) && n >= 1))) throw new Error('bad target pairs');
        s.target.pairs = t.pairs.map((p) => p.slice());
      }
    }
    return s;
  }

  // Compact form for localStorage: questions as [opCode, left, right, answer, ms, done, source?].
  function toStored(s) {
    return {
      v: 1, id: s.id, t: s.startedAt, m: s.mode, d: s.difficulty, r: s.ranges, o: s.ops, dur: s.duration,
      sc: s.score, st: s.status, tg: s.target,
      q: s.questions.map((q) => {
        const row = [OP_CODE[q.op], q.left, q.right, q.answer, q.ms, q.status === 'completed' ? 1 : 0];
        if (q.source) row.push(q.source === 'target' ? 't' : 'r');
        return row;
      }),
    };
  }

  function fromStored(o) {
    if (!o || o.v !== 1 || !Array.isArray(o.q)) throw new Error('unknown stored format');
    return validateSession({
      id: o.id, startedAt: o.t, mode: o.m, difficulty: o.d, ranges: o.r, ops: o.o, duration: o.dur,
      score: o.sc, status: o.st, target: o.tg,
      questions: o.q.map((row) => {
        const q = { op: CODE_OP[row[0]], left: row[1], right: row[2], answer: row[3], ms: row[4],
          status: row[5] === 1 ? 'completed' : 'unfinished' };
        if (row[6]) q.source = row[6] === 't' ? 'target' : 'random';
        return q;
      }),
    });
  }

  function exportBackup(sessions, settings, now) {
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date(now).toISOString(),
      settings,
      sessions: sessions.slice().sort((a, b) => a.startedAt - b.startedAt).map((s) => {
        const out = Object.assign({}, s, { startedAt: new Date(s.startedAt).toISOString() });
        out.questions = s.questions.map((q) => Object.assign({ sessionId: s.id }, q));
        return out;
      }),
    };
  }

  // Same round imported under a different id still counts as a duplicate.
  function fingerprint(s) {
    return [s.startedAt, s.mode, s.score, s.questions.length,
      s.questions.map((q) => `${q.left},${q.right},${q.ms}`).join(';')].join('|');
  }

  // Returns { sessions (new, valid), duplicates, invalid: [{index, error}], settings }.
  function parseBackup(text, existing) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('File is not valid JSON.'); }
    if (!data || data.format !== BACKUP_FORMAT) throw new Error('This is not a Zetamac Local backup file.');
    if (!isInt(data.version) || data.version < 1) throw new Error('Backup has no valid version.');
    if (data.version > BACKUP_VERSION) throw new Error(`Backup version ${data.version} is newer than this app supports (${BACKUP_VERSION}).`);
    if (!Array.isArray(data.sessions)) throw new Error('Backup has no sessions list.');
    const ids = new Set(existing.map((s) => s.id));
    const prints = new Set(existing.map(fingerprint));
    const result = { sessions: [], duplicates: 0, invalid: [], settings: null };
    data.sessions.forEach((raw, index) => {
      let s;
      try { s = validateSession(raw); } catch (e) { result.invalid.push({ index, error: e.message }); return; }
      const fp = fingerprint(s);
      if (ids.has(s.id) || prints.has(fp)) { result.duplicates++; return; }
      ids.add(s.id);
      prints.add(fp);
      result.sessions.push(s);
    });
    if (data.settings) result.settings = sanitizeSettings(data.settings);
    return result;
  }

  /* ---------------- storage (any localStorage-like object) ---------------- */

  class Store {
    constructor(storage) { this.storage = storage; }

    loadSessions() {
      const sessions = [];
      const errors = [];
      const keys = [];
      for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i);
        if (k && k.startsWith(SESSION_PREFIX)) keys.push(k);
      }
      for (const k of keys) {
        try { sessions.push(fromStored(JSON.parse(this.storage.getItem(k)))); } catch (e) { errors.push(`${k}: ${e.message}`); }
      }
      sessions.sort((a, b) => a.startedAt - b.startedAt);
      return { sessions, errors };
    }

    // Keyed by id, so saving the same session twice can never duplicate it.
    saveSession(s) {
      const key = SESSION_PREFIX + s.id;
      const text = JSON.stringify(toStored(s));
      this.storage.setItem(key, text);
      if (this.storage.getItem(key) !== text) throw new Error('read-back check failed');
    }

    clearSessions() {
      const keys = [];
      for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i);
        if (k && k.startsWith(SESSION_PREFIX)) keys.push(k);
      }
      keys.forEach((k) => this.storage.removeItem(k));
    }

    loadSettings() {
      try { return sanitizeSettings(JSON.parse(this.storage.getItem(SETTINGS_KEY))); } catch (e) { return defaultSettings(); }
    }

    saveSettings(settings) {
      this.storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }

    bytesUsed() {
      let n = 0;
      for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i);
        if (k && k.startsWith('zetamac.')) n += k.length + (this.storage.getItem(k) || '').length;
      }
      return n * 2; // UTF-16
    }
  }

  const ZCore = {
    OPS, OP_SYMBOL, OP_NAME, PRESETS, DIFFICULTIES, DURATIONS, MIN_PAIR_SAMPLES, SLOWEST_POOL_SIZE,
    SIZE_BUCKETS, BACKUP_FORMAT, BACKUP_VERSION, SESSION_PREFIX, SETTINGS_KEY,
    defaultSettings, sanitizeSettings, validRange, validRanges, rangesFor, enabledOps,
    randInt, makeQuestion, generateStandard, checkAnswer,
    parseNumbers, parsePairs, pairKey, targetConfig, buildTargetPlan,
    problemKey, problemFits, problemStats, slowestCandidates, operandsOf,
    makeId, Round,
    settingsKey, settingsLabel, difficultyLabel, durationLabel, rangeLabel,
    median, summarize, completedOf, unfinishedOf, opBreakdown, mulObservations, pairStats, rankPairs,
    numberStats, numberBreakdown, personalBest,
    validateSession, toStored, fromStored, exportBackup, parseBackup, fingerprint, Store,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ZCore;
  else root.ZCore = ZCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
