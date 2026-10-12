// Run with: node --test tests/core.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Z = require('../js/core.js');

// Deterministic PRNG (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class MemStorage {
  constructor() { this.m = new Map(); this.failWrites = false; }
  get length() { return this.m.size; }
  key(i) { return Array.from(this.m.keys())[i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { if (this.failWrites) throw new Error('QuotaExceededError'); this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

test('presets match the specification', () => {
  assert.deepEqual(Z.PRESETS.easy, { add: [[2, 60], [2, 60]], mul: [[2, 12], [2, 20]] });
  assert.deepEqual(Z.PRESETS.medium, { add: [[2, 100], [2, 100]], mul: [[2, 12], [2, 100]] });
  assert.deepEqual(Z.PRESETS.hard, { add: [[2, 300], [2, 300]], mul: [[2, 20], [2, 200]] });
  const d = Z.defaultSettings();
  assert.equal(d.difficulty, 'medium');
  assert.equal(d.duration, 120);
  assert.deepEqual(Z.enabledOps(d.ops), ['add', 'sub', 'mul', 'div']);
});

test('operands are inclusive, uniform-ish, and inverse problems are correct', () => {
  for (const name of ['easy', 'medium', 'hard']) {
    const ranges = Z.PRESETS[name];
    const r = rng(42);
    const seen = { add: [new Set(), new Set()], mul: [new Set(), new Set()] };
    const opCount = { add: 0, sub: 0, mul: 0, div: 0 };
    for (let i = 0; i < 200000; i++) {
      const q = Z.generateStandard(ranges, Z.OPS, r);
      opCount[q.op]++;
      let a, b;
      if (q.op === 'add') { a = q.left; b = q.right; assert.equal(q.answer, a + b); }
      if (q.op === 'sub') { a = q.right; b = q.answer; assert.equal(q.left - q.right, q.answer); assert.ok(q.answer > 0); }
      if (q.op === 'mul') { a = q.left; b = q.right; assert.equal(q.answer, a * b); }
      if (q.op === 'div') { a = q.right; b = q.answer; assert.equal(q.left / q.right, q.answer); assert.ok(Number.isInteger(q.answer)); }
      const fam = q.op === 'add' || q.op === 'sub' ? 'add' : 'mul';
      const [ra, rb] = ranges[fam];
      assert.ok(a >= ra[0] && a <= ra[1], `${name} ${q.op} a=${a}`);
      assert.ok(b >= rb[0] && b <= rb[1], `${name} ${q.op} b=${b}`);
      seen[fam][0].add(a);
      seen[fam][1].add(b);
    }
    for (const fam of ['add', 'mul']) {
      for (const i of [0, 1]) {
        const [lo, hi] = ranges[fam][i];
        assert.equal(seen[fam][i].size, hi - lo + 1, `${name} ${fam}[${i}] hits every value incl. endpoints`);
      }
    }
    for (const op of Z.OPS) assert.ok(Math.abs(opCount[op] / 200000 - 0.25) < 0.01, `${op} chosen uniformly`);
  }
});

test('only enabled operations are generated', () => {
  const r = rng(1);
  for (let i = 0; i < 5000; i++) assert.ok(['sub', 'div'].includes(Z.generateStandard(Z.PRESETS.easy, ['sub', 'div'], r).op));
});

test('answer check: exact whole input only', () => {
  assert.equal(Z.checkAnswer('56', 56), true);
  assert.equal(Z.checkAnswer(' 56 ', 56), true);
  assert.equal(Z.checkAnswer('5', 56), false);
  assert.equal(Z.checkAnswer('560', 56), false);
  assert.equal(Z.checkAnswer('', 56), false);
  assert.equal(Z.checkAnswer('5a6', 56), false);
  assert.equal(Z.checkAnswer('-56', 56), false);
});

function fixedRound(questions, duration) {
  let i = 0;
  return new Z.Round({
    id: 'r1', startedAt: 1700000000000, mode: 'standard', difficulty: 'medium', ranges: Z.PRESETS.medium,
    ops: ['add', 'sub', 'mul', 'div'], duration: duration || 60,
    nextQuestion: () => Object.assign({}, questions[i++ % questions.length]),
  });
}

test('round: partial input does not advance or record anything; full answer advances', () => {
  const r = fixedRound([Z.makeQuestion('mul', 7, 8), Z.makeQuestion('add', 12, 30)]);
  r.start(1000);
  assert.equal(r.input('5', 1500), 'pending');
  assert.equal(r.input('', 1600), 'pending');
  assert.equal(r.input('9', 1700), 'pending');
  assert.equal(r.records.length, 0, 'wrong/partial edits are not recorded');
  assert.equal(r.input('56', 2234.6), 'correct');
  assert.equal(r.score, 1);
  assert.equal(r.records[0].ms, 1235, 'time from display to correct answer');
  assert.equal(r.current.answer, 42);
  assert.equal(r.current.shownAt, 2234.6, 'next question timed from the moment it appears');
  assert.equal(r.input('42', 3000), 'correct');
  assert.equal(r.records[1].ms, 765);
});

test('round: answers at or after the deadline are rejected; time cannot extend', () => {
  const r = fixedRound([Z.makeQuestion('add', 2, 2)], 60);
  assert.equal(r.input('4', 0), 'closed', 'no answers before start');
  r.start(10000);
  assert.equal(r.deadline, 70000);
  assert.equal(r.input('4', 69999), 'correct');
  assert.equal(r.input('4', 70000), 'expired');
  assert.equal(r.input('4', 99999), 'expired');
  assert.equal(r.score, 1);
  // Timer callback fires late (throttled background tab): unfinished time is capped at the deadline.
  const s = r.finish(95000, 'completed');
  assert.equal(s.score, 1);
  assert.equal(s.status, 'completed');
  const last = s.questions[s.questions.length - 1];
  assert.equal(last.status, 'unfinished');
  assert.equal(last.ms, 1, 'unfinished time is shownAt→deadline, not shownAt→late callback');
  assert.equal(r.input('4', 96000), 'closed');
});

test('round: finish returns the session exactly once', () => {
  const r = fixedRound([Z.makeQuestion('add', 2, 2)]);
  r.start(0);
  assert.ok(r.finish(60000, 'completed'));
  assert.equal(r.finish(60000, 'completed'), null);
  assert.equal(r.finish(60001, 'abandoned'), null);
});

test('round: abandoned rounds keep the unfinished question time', () => {
  const r = fixedRound([Z.makeQuestion('mul', 6, 7)]);
  r.start(0);
  r.input('42', 2000);
  const s = r.finish(5500, 'abandoned');
  assert.equal(s.status, 'abandoned');
  assert.equal(s.score, 1);
  assert.deepEqual(s.questions.map((q) => [q.status, q.ms]), [['completed', 2000], ['unfinished', 3500]]);
});

test('statistics: median, summaries, unfinished excluded', () => {
  assert.equal(Z.median([3, 1, 2]), 2);
  assert.equal(Z.median([4, 1, 3, 2]), 2.5);
  assert.equal(Z.median([]), null);
  const qs = [
    { op: 'add', ms: 1000, status: 'completed' }, { op: 'add', ms: 3000, status: 'completed' },
    { op: 'mul', ms: 2000, status: 'completed' }, { op: 'mul', ms: 9000, status: 'unfinished' },
  ];
  const b = Z.opBreakdown(qs);
  assert.deepEqual([b.add.count, b.add.mean, b.add.median, b.add.total], [2, 2000, 2000, 4000]);
  assert.deepEqual([b.mul.count, b.mul.mean, b.mul.max], [1, 2000, 2000]);
  assert.equal(b.sub.count, 0);
  assert.equal(b.sub.median, null);
});

test('multiplication pairs group 7x8 with 8x7 and rank by median with a sample minimum', () => {
  const q = (l, r, ms, status) => ({ op: 'mul', left: l, right: r, answer: l * r, ms, status: status || 'completed' });
  const qs = [
    q(7, 8, 1000), q(8, 7, 2000), q(7, 8, 3000), q(8, 7, 4000), q(7, 8, 5000), // 5 samples, median 3000
    q(6, 9, 2500), q(9, 6, 2500), q(6, 9, 2500), q(6, 9, 2500), q(6, 9, 2600), // 5 samples, median 2500
    q(12, 13, 9000), q(12, 13, 9000), // only 2 samples
    q(7, 8, 60000, 'unfinished'), // ignored
    { op: 'div', left: 56, right: 7, answer: 8, ms: 7000, status: 'completed' },
  ];
  const obs = Z.mulObservations(qs, false);
  assert.equal(obs.length, 12);
  const pairs = Z.pairStats(obs);
  const p78 = pairs.find((p) => p.key === '7×8');
  assert.deepEqual([p78.count, p78.median, p78.mean, p78.max], [5, 3000, 3000, 5000]);
  const ranked = Z.rankPairs(pairs);
  assert.deepEqual(ranked.ranked.map((p) => p.key), ['7×8', '6×9']);
  assert.deepEqual(ranked.small.map((p) => p.key), ['12×13']);
  // Raw records keep original order.
  assert.equal(qs[1].left, 8);
  // Division as divisor × quotient.
  const withDiv = Z.mulObservations(qs, true);
  assert.equal(withDiv.length, 13);
  assert.deepEqual(withDiv[12], { a: 7, b: 8, ms: 7000, op: 'div' });
});

test('number stats count a question once per number (squares once) and split by role/size', () => {
  const obs = [{ a: 7, b: 7, ms: 4000 }, { a: 7, b: 8, ms: 1000 }, { a: 3, b: 7, ms: 2000 }, { a: 7, b: 50, ms: 6000 }];
  const nums = Z.numberStats(obs);
  const seven = nums.find((n) => n.n === 7);
  assert.equal(seven.count, 4, '7x7 counted once');
  assert.equal(seven.total, 13000);
  const b = Z.numberBreakdown(obs, 7);
  assert.equal(b.all.count, 4);
  assert.equal(b.first.count, 3); // 7x7, 7x8, 7x50
  assert.equal(b.second.count, 2); // 7x7, 3x7
  assert.equal(b.squares.count, 1);
  const byLabel = Object.fromEntries(b.buckets.map((k) => [k.label, k.count]));
  assert.deepEqual(byLabel, { '≤5': 1, '6–9': 2, '21–50': 1 });
});

test('settings keys separate modes, durations, ops and ranges; personal best respects them', () => {
  const base = { mode: 'standard', difficulty: 'medium', ranges: Z.PRESETS.medium, ops: ['add', 'sub', 'mul', 'div'], duration: 120 };
  const k = Z.settingsKey(base);
  assert.notEqual(k, Z.settingsKey(Object.assign({}, base, { duration: 60 })));
  assert.notEqual(k, Z.settingsKey(Object.assign({}, base, { ops: ['mul'] })));
  assert.notEqual(k, Z.settingsKey(Object.assign({}, base, { ranges: Z.PRESETS.hard })));
  // Custom ranges identical to a preset compare with that preset.
  assert.equal(k, Z.settingsKey(Object.assign({}, base, { difficulty: 'custom' })));
  const tgt = Object.assign({}, base, { mode: 'targeted', ops: ['mul'], target: { focus: 'slowest', randomPct: 25 } });
  assert.notEqual(Z.settingsKey(tgt), Z.settingsKey(Object.assign({}, base, { ops: ['mul'] })));
  assert.equal(Z.settingsLabel(base), 'Medium · Blitz 120s · + − × ÷');
  const sessions = [
    Object.assign({ id: 'a', score: 40, status: 'completed' }, base),
    Object.assign({ id: 'b', score: 55, status: 'abandoned' }, base),
    Object.assign({ id: 'c', score: 70, status: 'completed' }, tgt),
    Object.assign({ id: 'd', score: 45, status: 'completed' }, base, { duration: 60 }),
  ];
  assert.equal(Z.personalBest(sessions, k).id, 'a');
  assert.equal(Z.personalBest(sessions, k, 'a'), null);
});

test('targeted: parsing, weighting toward slow pairs, random mix, and fallback', () => {
  assert.deepEqual(Z.parseNumbers('7, 8 8;13'), [7, 8, 13]);
  assert.deepEqual(Z.parsePairs('7x8, 8*7, 6×9'), [[7, 8], [6, 9]]);
  assert.throws(() => Z.parsePairs('7-8'));
  assert.throws(() => Z.targetConfig({ focus: 'numbers', numbers: '', partner: [2, 12], randomPct: 25 }));

  const mul = Z.PRESETS.medium.mul;
  const empty = Z.buildTargetPlan({ focus: 'slowest', randomPct: 25 }, mul, []);
  assert.ok(empty.fallback);
  const r0 = rng(3);
  for (let i = 0; i < 100; i++) assert.equal(empty.next(r0).source, 'random');

  const history = [];
  const add = (a, b, ms, n) => { for (let i = 0; i < n; i++) history.push({ a, b, ms }); };
  add(7, 8, 4000, 5); add(6, 9, 2000, 5); add(3, 4, 1000, 6); add(12, 13, 9000, 4); // 12x13 under-sampled
  const plan = Z.buildTargetPlan({ focus: 'slowest', randomPct: 20 }, mul, history);
  assert.equal(plan.fallback, null);
  assert.deepEqual(plan.pool.map((p) => p.lo + 'x' + p.hi), ['7x8', '6x9', '3x4']);
  const r = rng(9);
  const counts = {};
  let random = 0;
  let prev = null;
  let repeats = 0;
  for (let i = 0; i < 20000; i++) {
    const q = plan.next(r);
    assert.equal(q.op, 'mul');
    assert.equal(q.answer, q.left * q.right);
    if (q.source === 'random') { random++; prev = null; continue; }
    const key = Z.pairKey(q.left, q.right);
    if (key === prev) repeats++;
    prev = key;
    counts[key] = (counts[key] || 0) + 1;
  }
  assert.ok(Math.abs(random / 20000 - 0.2) < 0.02, 'random share ≈ 20%');
  assert.equal(counts['12×13'], undefined, 'under-sampled pairs are not targeted');
  assert.ok(counts['7×8'] > counts['6×9'] && counts['6×9'] > counts['3×4'], 'slower pairs appear more often');
  assert.ok(repeats < 200, 'immediate repeats are rare');

  const nums = Z.buildTargetPlan(Z.targetConfig({ focus: 'numbers', numbers: '7', partner: [2, 12], randomPct: 0 }), mul, []);
  for (let i = 0; i < 2000; i++) {
    const q = nums.next(r);
    assert.ok(q.left === 7 || q.right === 7);
    const other = q.left === 7 ? q.right : q.left;
    assert.ok(other >= 2 && other <= 12);
  }
});

function sampleSession(id, score, extra) {
  const qs = [];
  for (let i = 0; i < score; i++) qs.push({ order: i + 1, op: 'mul', left: 7, right: 8, answer: 56, ms: 1000 + i, status: 'completed' });
  qs.push({ order: score + 1, op: 'sub', left: 50, right: 20, answer: 30, ms: 777, status: 'unfinished' });
  return Object.assign({ id, startedAt: 1700000000000 + score, mode: 'standard', difficulty: 'medium', ranges: Z.PRESETS.medium,
    ops: ['add', 'sub', 'mul', 'div'], duration: 120, score, status: 'completed', questions: qs }, extra);
}

test('storage: compact round-trip, keyed by id (no duplicates), failure surfaces as an error', () => {
  const mem = new MemStorage();
  const store = new Z.Store(mem);
  const s = sampleSession('abc-1', 3);
  store.saveSession(s);
  store.saveSession(s);
  const t = sampleSession('abc-2', 2, { mode: 'targeted', ops: ['mul'], target: { focus: 'pairs', randomPct: 10, pairs: [[7, 8]] } });
  t.questions[0].source = 'target';
  store.saveSession(t);
  const loaded = new Z.Store(mem).loadSessions();
  assert.equal(loaded.sessions.length, 2);
  const byId = Object.fromEntries(loaded.sessions.map((x) => [x.id, x]));
  assert.deepEqual(byId['abc-1'], Z.validateSession(s));
  assert.equal(byId['abc-2'].questions[0].source, 'target');
  assert.deepEqual(byId['abc-2'].target, { focus: 'pairs', randomPct: 10, pairs: [[7, 8]] });
  assert.deepEqual(loaded.errors, []);
  mem.setItem(Z.SESSION_PREFIX + 'bad', '{"nope":1}');
  assert.equal(new Z.Store(mem).loadSessions().errors.length, 1);
  mem.failWrites = true;
  assert.throws(() => store.saveSession(sampleSession('abc-3', 1)));
  mem.failWrites = false;
  store.saveSettings(Object.assign(Z.defaultSettings(), { duration: 60, difficulty: 'hard' }));
  assert.equal(store.loadSettings().duration, 60);
  store.clearSessions();
  assert.equal(store.loadSessions().sessions.length, 0);
  assert.equal(store.loadSettings().difficulty, 'hard', 'clearing history keeps settings');
});

test('backup: export → import round-trip, validation, and duplicate prevention', () => {
  const a = Z.validateSession(sampleSession('s-a', 3));
  const b = Z.validateSession(sampleSession('s-b', 5, { status: 'abandoned' }));
  const json = JSON.stringify(Z.exportBackup([a, b], Z.defaultSettings(), 1700000000000));
  const data = JSON.parse(json);
  assert.equal(data.format, 'zetamac-local-backup');
  assert.equal(data.version, 1);
  assert.equal(data.sessions[0].questions[0].sessionId, 's-a');
  assert.equal(data.sessions[0].questions[0].order, 1);
  assert.equal(typeof data.sessions[0].startedAt, 'string');

  const fresh = Z.parseBackup(json, []);
  assert.equal(fresh.sessions.length, 2);
  assert.deepEqual(fresh.sessions[0], a);
  assert.equal(fresh.duplicates, 0);
  assert.equal(fresh.settings.duration, 120);

  const again = Z.parseBackup(json, fresh.sessions);
  assert.equal(again.sessions.length, 0);
  assert.equal(again.duplicates, 2);

  // Same round under a different id is still a duplicate.
  const renamed = JSON.parse(json);
  renamed.sessions[0].id = 'other-id';
  assert.equal(Z.parseBackup(JSON.stringify(renamed), [a]).duplicates, 1);

  // Duplicates inside one file.
  const doubled = JSON.parse(json);
  doubled.sessions.push(doubled.sessions[0]);
  assert.equal(Z.parseBackup(JSON.stringify(doubled), []).duplicates, 1);

  // Invalid sessions rejected individually.
  const bad = JSON.parse(json);
  bad.sessions[0].questions[0].answer = 57; // 7×8 ≠ 57
  bad.sessions[1].score = 99; // score ≠ completed count
  const res = Z.parseBackup(JSON.stringify(bad), []);
  assert.equal(res.sessions.length, 0);
  assert.equal(res.invalid.length, 2);

  assert.throws(() => Z.parseBackup('not json', []), /valid JSON/);
  assert.throws(() => Z.parseBackup('{"format":"other"}', []), /not a Zetamac/);
  assert.throws(() => Z.parseBackup(JSON.stringify(Object.assign(data, { version: 99 })), []), /newer/);
});

test('settings sanitisation rejects bad values and empty op sets', () => {
  const s = Z.sanitizeSettings({ difficulty: 'insane', duration: 7, ops: { add: false, sub: false, mul: false, div: false },
    custom: { add: [[5, 1], [2, 3]], mul: [[2, 3], [2, 3]] } });
  assert.equal(s.difficulty, 'medium');
  assert.equal(s.duration, 120);
  assert.deepEqual(Z.enabledOps(s.ops), Z.OPS);
  assert.deepEqual(s.custom, Z.PRESETS.medium);
});
