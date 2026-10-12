/* UI layer: screens, gameplay wiring, results and statistics rendering. */
(function () {
  'use strict';
  const Z = window.ZCore;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtS = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(2) + ' s');
  const fmtTotal = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(1) + ' s');
  const fmtDate = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const qText = (q) => `${q.left} ${Z.OP_SYMBOL[q.op]} ${q.right}`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  /* ---------------- state ---------------- */

  const state = {
    store: null,
    storageError: null,
    settings: Z.defaultSettings(),
    sessions: [],
    unsaved: new Set(), // ids of sessions whose save failed
    round: null,
    roundMeta: null, // { plan, label, key }
    timer: null,
    lastSession: null,
    stats: { includeDivision: false, heatText: 'median', number: null },
  };

  function initStorage() {
    try {
      const ls = window.localStorage;
      const probe = 'zetamac.probe';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      state.store = new Z.Store(ls);
    } catch (e) {
      state.storageError = e;
    }
  }

  /* ---------------- banner ---------------- */

  function updateBanner() {
    const b = $('#banner');
    const msgs = [];
    if (state.storageError) {
      msgs.push(`Browser storage is unavailable (${esc(state.storageError.message || state.storageError)}). ` +
        'Rounds will NOT be kept after you close this page.');
    }
    if (state.unsaved.size) {
      msgs.push(`${plural(state.unsaved.size, 'round')} could not be saved to browser storage and exist only in this tab.`);
    }
    if (state.loadErrors && state.loadErrors.length) {
      msgs.push(`${plural(state.loadErrors.length, 'stored round')} could not be read and ${state.loadErrors.length === 1 ? 'was' : 'were'} skipped.`);
    }
    if (!msgs.length) { b.hidden = true; return; }
    b.innerHTML = msgs.join(' ') + (state.unsaved.size || state.storageError
      ? ' <button type="button" id="banner-export">Export backup now</button>' : '');
    b.hidden = false;
    const btn = $('#banner-export');
    if (btn) btn.onclick = exportBackup;
  }

  /* ---------------- persistence ---------------- */

  function persistSession(s) {
    if (!state.store) { state.unsaved.add(s.id); updateBanner(); return false; }
    // Retry anything that failed earlier first.
    const ids = Array.from(state.unsaved).concat(s.id);
    let ok = true;
    for (const id of new Set(ids)) {
      const sess = state.sessions.find((x) => x.id === id);
      if (!sess) continue;
      try {
        state.store.saveSession(sess);
        state.unsaved.delete(id);
      } catch (e) {
        state.unsaved.add(id);
        state.lastSaveError = e;
        if (id === s.id) ok = false;
      }
    }
    updateBanner();
    return ok;
  }

  function saveSettings() {
    if (!state.store) return;
    try { state.store.saveSettings(state.settings); } catch (e) { /* settings are a convenience; history banner covers failures */ }
  }

  /* ---------------- screens ---------------- */

  function show(name) {
    ['setup', 'game', 'results', 'stats'].forEach((n) => { $('#screen-' + n).hidden = n !== name; });
    document.body.classList.toggle('playing', name === 'game');
    $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
    state.screen = name;
    if (name === 'stats') renderStats();
    if (name === 'setup') { renderSetup(); $('#start-btn').focus(); }
  }

  /* ---------------- setup ---------------- */

  function readSetupForm() {
    const f = $('#setup-form');
    const s = state.settings;
    s.mode = f.querySelector('input[name=mode]:checked').value;
    s.difficulty = f.querySelector('input[name=difficulty]:checked').value;
    s.duration = Number(f.querySelector('input[name=duration]:checked').value);
    const ops = activeOps();
    Z.OPS.forEach((o) => { ops[o] = f.querySelector(`input[name=op][value=${o}]`).checked; });
    s.targeted.focus = f.querySelector('input[name=focus]:checked').value;
    s.targeted.numbers = $('#t-numbers').value;
    s.targeted.pairs = $('#t-pairs').value;
    s.targeted.partner = [Number($('#t-partner-min').value), Number($('#t-partner-max').value)];
    const pct = Number($('#t-random').value);
    s.targeted.randomPct = Number.isInteger(pct) ? Math.min(50, Math.max(0, pct)) : 25;
  }

  function fillSetupForm() {
    const s = state.settings;
    const f = $('#setup-form');
    f.querySelector(`input[name=mode][value=${s.mode}]`).checked = true;
    f.querySelector(`input[name=difficulty][value=${s.difficulty}]`).checked = true;
    f.querySelector(`input[name=duration][value="${s.duration}"]`).checked = true;
    fillOps();
    fillRanges();
    f.querySelector(`input[name=focus][value=${s.targeted.focus}]`).checked = true;
    $('#t-numbers').value = s.targeted.numbers;
    $('#t-pairs').value = s.targeted.pairs;
    $('#t-partner-min').value = s.targeted.partner[0];
    $('#t-partner-max').value = s.targeted.partner[1];
    $('#t-random').value = s.targeted.randomPct;
  }

  // Standard and targeted rounds keep separate operation choices.
  function activeOps() {
    const s = state.settings;
    return s.mode === 'targeted' ? s.targeted.ops : s.ops;
  }

  function fillOps() {
    const ops = activeOps();
    Z.OPS.forEach((o) => { $(`input[name=op][value=${o}]`).checked = !!ops[o]; });
  }

  // Show the active ranges: the preset's values, or the saved custom ranges.
  function fillRanges() {
    const ranges = Z.rangesFor(state.settings);
    $$('[data-range]').forEach((inp) => {
      const [k, i, j] = inp.dataset.range.split('.');
      const v = ranges[k][i][j];
      inp.value = Number.isFinite(v) ? v : '';
    });
  }

  // Editing any range switches to Custom, keeping every other displayed value.
  function onRangeInput() {
    const s = state.settings;
    s.difficulty = 'custom';
    $('input[name=difficulty][value=custom]').checked = true;
    $$('[data-range]').forEach((inp) => {
      const [k, i, j] = inp.dataset.range.split('.');
      s.custom[k][i][j] = inp.value.trim() === '' ? NaN : Number(inp.value);
    });
    saveSettings();
    renderSetup();
  }

  // Returns { config } for a startable round or { error }.
  function buildRoundConfig() {
    const s = state.settings;
    const ranges = Z.rangesFor(s);
    if (!Z.validRanges(ranges)) return { error: 'Each range needs whole numbers from 1 upward, with min ≤ max.' };
    const ops = Z.enabledOps(activeOps());
    if (!ops.length) return { error: 'Choose at least one operation.' };
    if (s.mode === 'standard') {
      return { config: { mode: 'standard', difficulty: s.difficulty, ranges, ops, duration: s.duration } };
    }
    let target;
    try { target = Z.targetConfig(s.targeted); } catch (e) { return { error: e.message }; }
    const plan = Z.buildTargetPlan(target, ranges, ops, historyQuestions());
    return { config: { mode: 'targeted', difficulty: s.difficulty, ranges, ops, duration: s.duration, target }, plan };
  }

  // Every question (completed or unfinished) from completed rounds, standard and targeted.
  function historyQuestions() {
    const qs = [];
    state.sessions.forEach((s) => { if (s.status === 'completed') qs.push(...s.questions); });
    return qs;
  }

  function renderSetup() {
    const s = state.settings;
    const targeted = s.mode === 'targeted';
    $('#targeted-panel').hidden = !targeted;
    $$('[data-focus]').forEach((el) => { el.hidden = el.dataset.focus !== s.targeted.focus; });
    const ops = activeOps();
    // Subtraction uses the addition ranges and division the multiplication ranges.
    const rangeUsed = { add: ops.add || ops.sub, mul: ops.mul || ops.div };
    $$('.op-row').forEach((row) => {
      const op = row.dataset.row;
      row.classList.toggle('off', !ops[op]);
      row.classList.toggle('range-off', op in rangeUsed && !rangeUsed[op]);
    });

    const built = buildRoundConfig();
    $('#setup-error').textContent = built.error || '';
    $('#start-btn').disabled = !!built.error;

    if (s.mode === 'targeted') renderTargetInfo(built);

    const pb = $('#setup-pb');
    if (built.config) {
      const key = Z.settingsKey(built.config);
      const best = Z.personalBest(state.sessions, key);
      const n = state.sessions.filter((x) => x.status === 'completed' && Z.settingsKey(x) === key).length;
      pb.textContent = best ? `Personal best for these settings: ${best.score} (${plural(n, 'completed round')}).`
        : 'No completed rounds with these exact settings yet.';
    } else {
      pb.textContent = '';
    }
  }

  function renderTargetInfo(built) {
    const t = state.settings.targeted;
    const pct = t.randomPct;
    const what = { slowest: 'your slowest problems', numbers: 'your numbers', pairs: 'your operand pairs' }[t.focus];
    $('#target-explain').textContent = `${100 - pct}% of questions use ${what}, ${pct}% are random, across the operations below.`;
    let detail;
    if (t.focus === 'slowest') {
      detail = `Each question first picks one of the selected operations evenly. For that operation, it draws from up to ${Z.SLOWEST_POOL_SIZE} ` +
        `of your slowest problems within the ranges below. Candidates are problems with at least ${Z.MIN_PAIR_SAMPLES} completed answers (scored by median time) ` +
        'and problems left unfinished when time ran out, if you had already spent longer on them than your typical time for that operation. ' +
        'Unfinished times are capped at 3× your typical time. A problem\'s chance is proportional to its score squared. ' +
        'An operation with fewer than 3 candidates gets random questions. 7 + 8 and 8 + 7 (or 7 × 8 and 8 × 7) count as one problem.';
    } else if (t.focus === 'numbers') {
      detail = 'Each targeted question uses one of your numbers (chosen evenly) and a random partner from the range you set, ' +
        'with the selected operation chosen evenly: n + p, (n + p) − n, n × p or (n × p) ÷ n, in either order.';
    } else {
      detail = 'Each pair is used with the selected operations: 7x8 gives 7 + 8, 15 − 7, 7 × 8 and 56 ÷ 7 (either order). Pairs are chosen evenly.';
    }
    $('#target-details').textContent = detail + ' The same problem is not shown twice in a row. ' +
      'Targeted rounds have their own history and personal bests, separate from standard rounds.';

    const prev = $('#target-preview');
    if (!built.plan) { prev.innerHTML = ''; return; }
    let html = built.plan.fallback ? `<p class="notice">${esc(built.plan.fallback)}</p>` : '';
    const pools = built.plan.pools || {};
    const withPools = Z.OPS.filter((op) => pools[op] && pools[op].length);
    if (withPools.length) {
      html += '<div class="muted small">Current focus · score · samples · share within operation</div>';
      withPools.forEach((op) => {
        html += '<div class="pool-row">' + pools[op].slice(0, 8).map((p) =>
          `<span class="chip${p.sampled ? '' : ' stalled'}" title="${p.sampled ? `median ${fmtS(p.median)}, n=${p.count}` : ''}${p.stalled ? `${p.sampled ? '; ' : ''}left unfinished after ${fmtS(p.unfinishedMax)}` : ''}">` +
          `${esc(p.key)} · ${fmtS(p.score)} · ${p.sampled ? 'n=' + p.count : 'unfinished'} · ${Math.round(p.weight * 100)}%</span>`).join('') +
          (pools[op].length > 8 ? `<span class="muted small"> +${pools[op].length - 8} more</span>` : '') + '</div>';
      });
    }
    prev.innerHTML = html;
  }

  function onSetupChange() {
    readSetupForm();
    saveSettings();
    renderSetup();
  }

  /* ---------------- game ---------------- */

  function startRound() {
    const built = buildRoundConfig();
    if (built.error) { show('setup'); return; }
    const c = built.config;
    const rng = Math.random;
    const nextQuestion = c.mode === 'targeted'
      ? () => built.plan.next(rng)
      : () => Z.generateStandard(c.ranges, c.ops, rng);
    state.round = new Z.Round(Object.assign({ id: Z.makeId(), startedAt: Date.now(), nextQuestion }, c));
    state.roundMeta = { plan: built.plan || null, label: Z.settingsLabel(c) };

    show('game');
    $('#game-label').textContent = state.roundMeta.label + (built.plan && built.plan.fallback ? ' (random fallback: not enough history)' : '');
    $('#score').textContent = '0';
    $('#time-left').textContent = String(c.duration);
    const input = $('#answer');
    input.value = '';
    renderQuestion();
    input.focus();
    // The clock starts only once the first question and the input are ready.
    state.round.start(performance.now());
    tick();
    state.timer = setInterval(tick, 100);
  }

  function renderQuestion() {
    $('#problem').textContent = qText(state.round.current);
  }

  function tick() {
    const r = state.round;
    if (!r || r.state !== 'running') return;
    const now = performance.now();
    if (r.isExpired(now)) { endRound('completed'); return; }
    const secs = String(Math.ceil(r.remaining(now) / 1000));
    const el = $('#time-left');
    if (el.textContent !== secs) el.textContent = secs;
  }

  function onAnswerInput() {
    const r = state.round;
    if (!r) return;
    const input = $('#answer');
    const res = r.input(input.value, performance.now());
    if (res === 'correct') {
      input.value = '';
      renderQuestion();
      $('#score').textContent = String(r.score);
    } else if (res === 'expired') {
      endRound('completed');
    }
  }

  function endRound(reason) {
    const r = state.round;
    if (!r) return;
    const session = r.finish(performance.now(), reason === 'pagehide' ? 'abandoned' : reason);
    clearInterval(state.timer);
    state.timer = null;
    state.round = null;
    if (!session) return; // already ended: never save twice
    state.sessions.push(session);
    const saved = persistSession(session);
    state.lastSession = session;
    state.lastSaved = saved;
    if (reason !== 'pagehide') renderResults(session, saved);
  }

  /* ---------------- results ---------------- */

  function renderResults(s, saved) {
    show('results');
    const key = Z.settingsKey(s);
    const completed = Z.completedOf(s.questions);
    const unfinished = Z.unfinishedOf(s.questions);
    const sum = Z.summarize(completed.map((q) => q.ms));

    $('#r-label').textContent = Z.settingsLabel(s) + ' · ' + fmtDate(s.startedAt);
    $('#r-score').textContent = s.score;
    $('#r-status').textContent = s.status === 'abandoned' ? 'abandoned — excluded from records' : (s.score === 1 ? 'point' : 'points');

    const prev = Z.personalBest(state.sessions, key, s.id);
    let pb = '';
    if (s.status === 'abandoned') pb = prev ? `Personal best for these settings: ${prev.score}` : '';
    else if (!prev) pb = '<span class="pb-new">First completed round with these settings — this is your personal best.</span>';
    else if (s.score > prev.score) pb = `<span class="pb-new">New personal best!</span> Previous best: ${prev.score}`;
    else pb = `Personal best for these settings: ${prev.score}${s.score === prev.score ? ' (tied)' : ''}`;
    $('#r-pb').innerHTML = pb;

    const sv = $('#r-saved');
    if (saved) {
      sv.className = 'save-status ok';
      sv.textContent = '✓ Saved to this browser.';
    } else {
      sv.className = 'save-status fail';
      const why = state.storageError ? 'browser storage is unavailable' : (state.lastSaveError ? state.lastSaveError.message : 'unknown error');
      sv.textContent = `✗ Not saved (${why}). Export a backup from Statistics before closing this tab.`;
    }
    const plan = state.roundMeta && state.roundMeta.plan;
    $('#r-note').textContent = plan && plan.fallback ? plan.fallback : '';

    const tiles = [
      ['Completed', String(completed.length), 'questions'],
      ['Average time', fmtS(sum.mean), 'completed questions'],
      ['Median time', fmtS(sum.median), 'completed questions'],
      ['Unfinished', unfinished.length ? fmtS(unfinished[0].ms) : '—', 'spent on the last question'],
    ];
    $('#r-tiles').innerHTML = tiles.map(([k, v, sub]) =>
      `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`).join('');

    const br = Z.opBreakdown(s.questions);
    const opsRows = s.ops.map((op) => Object.assign({ op }, br[op]));
    sortableTable($('#r-ops'), [
      { key: 'op', label: 'Operation', value: (r) => Z.OPS.indexOf(r.op), render: (r) => `${Z.OP_SYMBOL[r.op]} ${Z.OP_NAME[r.op]}` },
      { key: 'count', label: 'Completed', value: (r) => r.count, render: (r) => r.count },
      { key: 'mean', label: 'Average', value: (r) => r.mean, render: (r) => fmtS(r.mean) },
      { key: 'median', label: 'Median', value: (r) => r.median, render: (r) => fmtS(r.median) },
      { key: 'total', label: 'Total', value: (r) => r.total, render: (r) => fmtTotal(r.total) },
    ], opsRows);

    const slow = completed.slice().sort((a, b) => b.ms - a.ms).slice(0, 5);
    $('#r-slowest').innerHTML = slow.length
      ? '<table><tbody>' + slow.map((q) => `<tr><td class="mono">${qText(q)} = ${q.answer}</td><td>${fmtS(q.ms)}</td></tr>`).join('') + '</tbody></table>'
      : '<p class="empty">No completed questions this round.</p>';
    $('#r-unfinished').innerHTML = unfinished.length
      ? '<table><tbody>' + unfinished.map((q) => `<tr class="unfinished"><td class="mono">${qText(q)} = ${q.answer}</td><td>${fmtS(q.ms)}</td></tr>`).join('') +
        '</tbody></table><p class="muted small">Unfinished questions are not included in any timing averages.</p>'
      : '<p class="empty">None.</p>';

    sortableTable($('#r-questions'), [
      { key: 'order', label: '#', value: (q) => q.order, render: (q) => q.order },
      { key: 'q', label: 'Question', cls: 'l mono', value: (q) => q.answer, render: (q) => qText(q) },
      { key: 'answer', label: 'Answer', cls: 'mono', value: (q) => q.answer, render: (q) => q.answer },
      { key: 'ms', label: 'Time', value: (q) => q.ms, render: (q) => fmtS(q.ms), defaultDir: 'desc' },
      { key: 'status', label: 'Status', cls: 'l', value: (q) => q.status, render: (q) => q.status === 'completed' ? 'completed' : '<span class="tag">unfinished</span>' },
    ], s.questions, { key: 'order', dir: 'asc', rowClass: (q) => (q.status === 'unfinished' ? 'unfinished' : '') });

    // Delay focus slightly so a keystroke typed at the buzzer can't restart instantly.
    setTimeout(() => { if (state.screen === 'results') $('#again-btn').focus(); }, 600);
  }

  /* ---------------- sortable table ---------------- */

  // columns: [{ key, label, value(row), render(row), cls, defaultDir }]
  function sortableTable(container, columns, rows, opts) {
    opts = opts || {};
    const st = { key: opts.key || columns[0].key, dir: opts.dir || 'asc' };
    function draw() {
      const col = columns.find((c) => c.key === st.key);
      const sorted = rows.slice().sort((x, y) => {
        const a = col.value(x);
        const b = col.value(y);
        if (a == null && b == null) return 0;
        if (a == null) return 1;
        if (b == null) return -1;
        const c = typeof a === 'string' ? a.localeCompare(b) : a - b;
        return st.dir === 'asc' ? c : -c;
      });
      const head = columns.map((c) => {
        const sort = c.key === st.key ? (st.dir === 'asc' ? 'ascending' : 'descending') : 'none';
        return `<th class="${(c.cls || '').replace('mono', '')}" aria-sort="${sort}"><button type="button" data-k="${c.key}">${c.label}</button></th>`;
      }).join('');
      const body = sorted.map((r) => `<tr class="${opts.rowClass ? opts.rowClass(r) : ''}"${opts.rowAttr ? ' ' + opts.rowAttr(r) : ''}>` +
        columns.map((c) => `<td class="${c.cls || ''}">${c.render(r)}</td>`).join('') + '</tr>').join('');
      container.innerHTML = `<div class="table-wrap${opts.scroll ? ' scroll-y' : ''}"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
      $$('th button', container).forEach((b) => {
        b.onclick = () => {
          if (st.key === b.dataset.k) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
          else { st.key = b.dataset.k; st.dir = columns.find((c) => c.key === st.key).defaultDir || 'asc'; }
          draw();
        };
      });
      if (opts.onDraw) opts.onDraw(container);
    }
    if (!rows.length) { container.innerHTML = `<p class="empty">${opts.empty || 'No data.'}</p>`; return; }
    draw();
  }

  /* ---------------- statistics ---------------- */

  function readFilters() {
    return {
      mode: $('#f-mode').value,
      settings: $('#f-settings').value || 'all',
      diff: $('#f-diff').value,
      op: $('#f-op').value,
      from: $('#f-from').value,
      to: $('#f-to').value,
      abandoned: $('#f-abandoned').checked,
    };
  }

  function sessionPasses(s, f, ignoreSettings) {
    if (f.mode !== 'all' && s.mode !== f.mode) return false;
    if (!f.abandoned && s.status !== 'completed') return false;
    if (f.diff !== 'all' && s.difficulty !== f.diff) return false;
    if (f.from) { const t = new Date(f.from + 'T00:00:00').getTime(); if (s.startedAt < t) return false; }
    if (f.to) { const t = new Date(f.to + 'T23:59:59.999').getTime(); if (s.startedAt > t) return false; }
    if (!ignoreSettings && f.settings !== 'all' && Z.settingsKey(s) !== f.settings) return false;
    if (f.op !== 'all' && !s.ops.includes(f.op)) return false;
    return true;
  }

  function refreshSettingsOptions(f) {
    const sel = $('#f-settings');
    const groups = new Map();
    state.sessions.filter((s) => sessionPasses(s, f, true)).forEach((s) => {
      const k = Z.settingsKey(s);
      if (!groups.has(k)) groups.set(k, { label: Z.settingsLabel(s), n: 0 });
      groups.get(k).n++;
    });
    const current = sel.value;
    sel.innerHTML = '<option value="all">All settings (no score comparisons)</option>' +
      Array.from(groups.entries()).sort((a, b) => b[1].n - a[1].n)
        .map(([k, g]) => `<option value="${esc(k)}">${esc(g.label)} — ${plural(g.n, 'round')}</option>`).join('');
    sel.value = groups.has(current) ? current : 'all';
  }

  function renderStats() {
    refreshSettingsOptions(readFilters());
    const f = readFilters();
    const body = $('#stats-body');
    renderStorageInfo();

    if (!state.sessions.length) {
      body.innerHTML = '<div class="card"><p class="empty">No rounds yet. Play a round from <b>Practice</b> and your history, trends and multiplication analysis will appear here.</p></div>';
      return;
    }
    const sessions = state.sessions.filter((s) => sessionPasses(s, f, false));
    if (!sessions.length) {
      body.innerHTML = '<div class="card"><p class="empty">No rounds match these filters.</p></div>';
      return;
    }
    let questions = [];
    sessions.forEach((s) => questions.push(...s.questions));
    if (f.op !== 'all') questions = questions.filter((q) => q.op === f.op);
    const completed = Z.completedOf(questions);
    const unfinished = Z.unfinishedOf(questions);
    const sum = Z.summarize(completed.map((q) => q.ms));
    const nDone = sessions.filter((s) => s.status === 'completed').length;

    body.innerHTML = `
      <div class="tiles">
        <div class="tile"><div class="k">Rounds</div><div class="v">${sessions.length}</div><div class="s">${nDone} completed${sessions.length - nDone ? `, ${sessions.length - nDone} abandoned` : ''}</div></div>
        <div class="tile"><div class="k">Completed questions</div><div class="v">${completed.length}</div><div class="s">${f.op === 'all' ? 'all operations' : Z.OP_NAME[f.op]}</div></div>
        <div class="tile"><div class="k">Average time</div><div class="v">${fmtS(sum.mean)}</div><div class="s">n=${sum.count}</div></div>
        <div class="tile"><div class="k">Median time</div><div class="v">${fmtS(sum.median)}</div><div class="s">n=${sum.count}</div></div>
        <div class="tile"><div class="k">Unfinished</div><div class="v">${unfinished.length}</div><div class="s">excluded from averages</div></div>
      </div>
      <div class="card" id="st-trend"></div>
      <div class="card"><h2>Session history</h2><div id="st-history"></div></div>
      <div class="card"><h2>By operation</h2><div id="st-ops"></div></div>
      <div id="st-mul"></div>`;

    renderTrend($('#st-trend'), sessions, f);

    sortableTable($('#st-history'), [
      { key: 'date', label: 'Date', value: (s) => s.startedAt, render: (s) => fmtDate(s.startedAt), defaultDir: 'desc' },
      { key: 'mode', label: 'Mode', cls: 'l', value: (s) => s.mode, render: (s) => s.mode },
      { key: 'settings', label: 'Settings', cls: 'l', value: (s) => Z.settingsLabel(s), render: (s) => esc(Z.settingsLabel(s)) },
      { key: 'score', label: 'Score', value: (s) => s.score, render: (s) => s.score, defaultDir: 'desc' },
      { key: 'median', label: 'Median', value: (s) => Z.summarize(Z.completedOf(s.questions).map((q) => q.ms)).median,
        render: (s) => fmtS(Z.summarize(Z.completedOf(s.questions).map((q) => q.ms)).median), defaultDir: 'desc' },
      { key: 'status', label: 'Status', cls: 'l', value: (s) => s.status,
        render: (s) => (s.status === 'abandoned' ? '<span class="tag warn">abandoned</span>' : 'completed') + (state.unsaved.has(s.id) ? ' <span class="tag warn">unsaved</span>' : '') },
    ], sessions, { key: 'date', dir: 'desc', scroll: true });

    const br = Z.opBreakdown(questions);
    const unf = {};
    unfinished.forEach((q) => { unf[q.op] = (unf[q.op] || 0) + 1; });
    sortableTable($('#st-ops'), [
      { key: 'op', label: 'Operation', value: (r) => Z.OPS.indexOf(r.op), render: (r) => `${Z.OP_SYMBOL[r.op]} ${Z.OP_NAME[r.op]}` },
      { key: 'count', label: 'Completed', value: (r) => r.count, render: (r) => r.count },
      { key: 'mean', label: 'Average', value: (r) => r.mean, render: (r) => fmtS(r.mean) },
      { key: 'median', label: 'Median', value: (r) => r.median, render: (r) => fmtS(r.median) },
      { key: 'total', label: 'Total', value: (r) => r.total, render: (r) => fmtTotal(r.total) },
      { key: 'unf', label: 'Unfinished', value: (r) => unf[r.op] || 0, render: (r) => unf[r.op] || 0 },
    ], Z.OPS.map((op) => Object.assign({ op }, br[op])).filter((r) => r.count || unf[r.op]), { empty: 'No questions for this filter.' });

    if (f.op === 'all' || f.op === 'mul' || f.op === 'div') renderMultiplication($('#st-mul'), questions, f);
  }

  /* ----- score trend (only within one settings group) ----- */

  function renderTrend(el, sessions, f) {
    if (f.settings === 'all') {
      const groups = new Map();
      sessions.filter((s) => s.status === 'completed').forEach((s) => {
        const k = Z.settingsKey(s);
        if (!groups.has(k)) groups.set(k, { label: Z.settingsLabel(s), list: [] });
        groups.get(k).list.push(s);
      });
      el.innerHTML = '<h2>Scores by settings group</h2><p class="section-note">Scores are only compared between identical settings and modes. ' +
        'Pick a group in the <b>Settings</b> filter to see its score trend.</p><div id="st-groups"></div>';
      const rows = Array.from(groups.values()).map((g) => {
        const scores = g.list.map((s) => s.score);
        return { label: g.label, n: g.list.length, best: Math.max(...scores), mean: scores.reduce((a, b) => a + b, 0) / scores.length,
          last: g.list[g.list.length - 1].score, lastAt: g.list[g.list.length - 1].startedAt };
      });
      sortableTable($('#st-groups'), [
        { key: 'label', label: 'Settings', cls: 'l', value: (r) => r.label, render: (r) => esc(r.label) },
        { key: 'n', label: 'Rounds', value: (r) => r.n, render: (r) => r.n, defaultDir: 'desc' },
        { key: 'best', label: 'Best', value: (r) => r.best, render: (r) => r.best, defaultDir: 'desc' },
        { key: 'mean', label: 'Average', value: (r) => r.mean, render: (r) => r.mean.toFixed(1), defaultDir: 'desc' },
        { key: 'last', label: 'Latest', value: (r) => r.lastAt, render: (r) => `${r.last} <span class="muted small">(${fmtDate(r.lastAt)})</span>`, defaultDir: 'desc' },
      ], rows, { key: 'n', dir: 'desc', empty: 'No completed rounds match these filters.' });
      return;
    }
    const list = sessions.filter((s) => s.status === 'completed').sort((a, b) => a.startedAt - b.startedAt);
    const label = sessions.length ? Z.settingsLabel(sessions[0]) : '';
    if (!list.length) {
      el.innerHTML = `<h2>Score trend</h2><p class="empty">No completed rounds for ${esc(label)} in this date range.</p>`;
      return;
    }
    const scores = list.map((s) => s.score);
    const best = Math.max(...scores);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    el.innerHTML = `<h2>Score trend</h2><p class="section-note">${esc(label)} · ${plural(list.length, 'completed round')} · best ${best} · average ${mean.toFixed(1)}</p>` +
      (list.length < 2 ? '<p class="empty">Play at least two rounds with these settings to see a trend.</p>' : '<div class="chart-wrap" id="trend-wrap"></div>');
    if (list.length >= 2) drawTrend($('#trend-wrap'), list, best);
  }

  function drawTrend(wrap, list, best) {
    const W = 800, H = 230, L = 40, R = 16, T = 14, B = 28;
    const maxY = Math.max(5, Math.ceil(best * 1.1));
    const step = niceStep(maxY / 4);
    const top = Math.ceil(maxY / step) * step;
    const x = (i) => L + (list.length === 1 ? 0 : (i * (W - L - R)) / (list.length - 1));
    const y = (v) => T + (H - T - B) * (1 - v / top);
    let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Score per round, oldest to newest">`;
    for (let v = 0; v <= top; v += step) {
      svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    }
    svg += `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
    svg += `<line class="pb" x1="${L}" x2="${W - R}" y1="${y(best)}" y2="${y(best)}"/><text x="${W - R}" y="${y(best) - 4}" text-anchor="end">best ${best}</text>`;
    svg += `<polyline class="line" points="${list.map((s, i) => `${x(i)},${y(s.score)}`).join(' ')}"/>`;
    list.forEach((s, i) => { svg += `<circle class="dot" cx="${x(i)}" cy="${y(s.score)}" r="4"/>`; });
    svg += `<text x="${L}" y="${H - 8}">${esc(new Date(list[0].startedAt).toLocaleDateString())}</text>`;
    svg += `<text x="${W - R}" y="${H - 8}" text-anchor="end">${esc(new Date(list[list.length - 1].startedAt).toLocaleDateString())}</text>`;
    const colW = (W - L - R) / Math.max(1, list.length - 1);
    list.forEach((s, i) => { svg += `<rect class="hit" data-i="${i}" x="${x(i) - colW / 2}" y="${T}" width="${colW}" height="${H - T - B}"/>`; });
    svg += '</svg><div class="tooltip" hidden></div>';
    wrap.innerHTML = svg;
    const tip = $('.tooltip', wrap);
    $$('.hit', wrap).forEach((r) => {
      r.addEventListener('mouseenter', () => {
        const i = Number(r.dataset.i);
        const s = list[i];
        const med = Z.summarize(Z.completedOf(s.questions).map((q) => q.ms)).median;
        tip.innerHTML = `<b>${s.score}</b> · ${esc(fmtDate(s.startedAt))}<br>median ${fmtS(med)}`;
        tip.hidden = false;
        const box = wrap.getBoundingClientRect();
        const px = (x(i) / W) * box.width;
        const py = (y(s.score) / H) * box.height;
        tip.style.left = Math.min(box.width - 160, Math.max(0, px - 60)) + 'px';
        tip.style.top = Math.max(0, py - 52) + 'px';
      });
      r.addEventListener('mouseleave', () => { tip.hidden = true; });
    });
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
    const m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }

  /* ----- multiplication analysis ----- */

  function renderMultiplication(el, questions, f) {
    const st = state.stats;
    const includeDiv = st.includeDivision || f.op === 'div';
    const obs = Z.mulObservations(questions, includeDiv).filter((o) => f.op !== 'div' || o.op === 'div');
    const minN = Z.MIN_PAIR_SAMPLES;
    el.innerHTML = `
      <div class="card">
        <h2>Multiplication analysis</h2>
        <div class="controls-row">
          <label><input type="checkbox" id="m-div" ${includeDiv ? 'checked' : ''} ${f.op === 'div' ? 'disabled' : ''}> Include division as divisor × quotient</label>
          <span class="muted">${plural(obs.length, 'completed fact')} · weaknesses are judged by response time only</span>
        </div>
        <div id="m-content"></div>
      </div>`;
    $('#m-div').onchange = (e) => { st.includeDivision = e.target.checked; renderStats(); };
    const content = $('#m-content');
    if (!obs.length) {
      content.innerHTML = '<p class="empty">No completed multiplication questions match these filters yet.</p>';
      return;
    }
    const pairs = Z.pairStats(obs);
    const ranked = Z.rankPairs(pairs, minN);
    content.innerHTML = `
      <h3>Slowest pairs (≥${minN} samples, ranked by median)</h3>
      <p class="section-note">7 × 8 and 8 × 7 are grouped as one pair. ${plural(ranked.ranked.length, 'pair')} qualify.</p>
      <div id="m-ranked"></div>
      <h3>Pairs with fewer than ${minN} samples</h3>
      <p class="section-note">Too few answers to rank reliably; shown for reference. ${plural(ranked.small.length, 'pair')}.</p>
      <div id="m-small"></div>
      <h3>By number</h3>
      <p class="section-note">Each question counts once for every distinct number in it (so 7 × 7 counts once for 7). Click a row for a breakdown.</p>
      <div class="grid2"><div id="m-numbers"></div><div id="m-breakdown"></div></div>
      <h3>Heatmap</h3>
      <div id="m-heat"></div>`;

    const pairCols = [
      { key: 'pair', label: 'Pair', cls: 'l mono', value: (p) => p.lo * 100000 + p.hi, render: (p) => `${p.lo} × ${p.hi}` },
      { key: 'count', label: 'Count', value: (p) => p.count, render: (p) => p.count, defaultDir: 'desc' },
      { key: 'mean', label: 'Average', value: (p) => p.mean, render: (p) => fmtS(p.mean), defaultDir: 'desc' },
      { key: 'median', label: 'Median', value: (p) => p.median, render: (p) => fmtS(p.median), defaultDir: 'desc' },
      { key: 'max', label: 'Slowest', value: (p) => p.max, render: (p) => fmtS(p.max), defaultDir: 'desc' },
    ];
    sortableTable($('#m-ranked'), [{ key: 'rank', label: 'Rank', value: (p) => p.rank, render: (p) => p.rank }].concat(pairCols),
      ranked.ranked.map((p, i) => Object.assign({ rank: i + 1 }, p)),
      { key: 'rank', dir: 'asc', scroll: true, empty: `No pair has ${minN}+ completed answers yet. Keep playing — pairs appear here once they have enough samples.` });
    sortableTable($('#m-small'), pairCols, ranked.small, { key: 'median', dir: 'desc', scroll: true, empty: 'None.' });

    const nums = Z.numberStats(obs);
    if (st.number == null || !nums.some((n) => n.n === st.number)) {
      const pool = nums.filter((n) => n.count >= minN);
      st.number = (pool.length ? pool : nums).slice().sort((a, b) => b.median - a.median)[0].n;
    }
    sortableTable($('#m-numbers'), [
      { key: 'n', label: 'Number', cls: 'l mono', value: (r) => r.n, render: (r) => `<button type="button" class="small ghost" data-num="${r.n}">${r.n}</button>` },
      { key: 'count', label: 'Count', value: (r) => r.count, defaultDir: 'desc',
        render: (r) => (r.count < minN ? `<span class="tag" title="fewer than ${minN} samples">small</span> ` : '') + r.count },
      { key: 'mean', label: 'Average', value: (r) => r.mean, render: (r) => fmtS(r.mean), defaultDir: 'desc' },
      { key: 'median', label: 'Median', value: (r) => r.median, render: (r) => fmtS(r.median), defaultDir: 'desc' },
      { key: 'max', label: 'Slowest', value: (r) => r.max, render: (r) => fmtS(r.max), defaultDir: 'desc' },
    ], nums, {
      key: 'median', dir: 'desc', scroll: true,
      onDraw: (c) => $$('[data-num]', c).forEach((b) => { b.onclick = () => { st.number = Number(b.dataset.num); renderBreakdown(obs); }; }),
    });
    renderBreakdown(obs);
    renderHeatmap($('#m-heat'), pairs, minN);
  }

  function renderBreakdown(obs) {
    const n = state.stats.number;
    const b = Z.numberBreakdown(obs, n);
    const row = (label, s) => `<tr><td>${label}</td><td>${s.count}</td><td>${fmtS(s.mean)}</td><td>${fmtS(s.median)}</td><td>${fmtS(s.max)}</td></tr>`;
    $('#m-breakdown').innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>Number ${n}</th><th>Count</th><th>Average</th><th>Median</th><th>Slowest</th></tr></thead>
        <tbody>
          ${row('All questions with ' + n, b.all)}
          ${row('As first factor (' + n + ' × …)', b.first)}
          ${row('As second factor (… × ' + n + ')', b.second)}
          ${b.squares.count ? row(`Square (${n} × ${n})`, b.squares) : ''}
          <tr><th colspan="5" class="l">By size of the other factor</th></tr>
          ${b.buckets.map((k) => row('other factor ' + k.label, k)).join('')}
        </tbody>
      </table></div>
      <p class="muted small">Squares count in both role rows but once overall. Role is the position as displayed (for division: divisor first, quotient second).</p>`;
  }

  function renderHeatmap(el, pairs, minN) {
    const st = state.stats;
    const MAX_COLS = 250;
    const los = pairs.map((p) => p.lo);
    const his = pairs.map((p) => p.hi);
    const rowMin = Math.min(...los), rowMax = Math.max(...los);
    const colMin = Math.min(...his);
    let colMax = Math.max(...his);
    const truncated = colMax - colMin + 1 > MAX_COLS;
    if (truncated) colMax = colMin + MAX_COLS - 1;
    const map = new Map(pairs.map((p) => [p.key, p]));

    // 7 quantile bins over pair medians so colour shows relative slowness.
    const meds = pairs.map((p) => p.median).sort((a, b) => a - b);
    const edges = [];
    for (let i = 1; i < 7; i++) edges.push(meds[Math.min(meds.length - 1, Math.floor((i * meds.length) / 7))]);
    const bin = (m) => { let k = 0; while (k < edges.length && m >= edges[k]) k++; return k + 1; };

    let html = `<div class="controls-row">
        <span>Rows: smaller factor · columns: larger factor · colour: median time (darker = slower in light mode, lighter = slower in dark mode)</span>
        <label>Cell text <select id="hm-text"><option value="median">median (s)</option><option value="count">sample count</option><option value="none">none</option></select></label>
      </div>`;
    const binRange = new Map();
    pairs.forEach((p) => {
      const k = bin(p.median);
      const r = binRange.get(k) || [Infinity, -Infinity];
      binRange.set(k, [Math.min(r[0], p.median), Math.max(r[1], p.median)]);
    });
    const swatches = Array.from(binRange.entries()).sort((a, b) => a[0] - b[0]).map(([k, [a, b]]) =>
      `<span><span class="sw s${k}"></span>${(a / 1000).toFixed(1)}${b > a ? '–' + (b / 1000).toFixed(1) : ''} s</span>`);
    html += `<div class="legend">${swatches.join('')}<span><span class="sw low"></span>fewer than ${minN} samples</span><span><span class="sw none"></span>no data</span></div>`;
    html += '<div class="heatmap-wrap"><table class="heatmap"><thead><tr><th>×</th>';
    for (let c = colMin; c <= colMax; c++) html += `<th>${c}</th>`;
    html += '</tr></thead><tbody>';
    for (let r = rowMin; r <= rowMax; r++) {
      html += `<tr><th>${r}</th>`;
      for (let c = colMin; c <= colMax; c++) {
        if (c < r) { html += '<td class="hm-out"></td>'; continue; }
        const p = map.get(`${r}×${c}`);
        if (!p) { html += `<td class="hm-none" title="${r} × ${c}: no data"></td>`; continue; }
        const text = st.heatText === 'median' ? (p.median / 1000).toFixed(1) : st.heatText === 'count' ? p.count : '';
        html += `<td class="s${bin(p.median)}${p.count < minN ? ' hm-low' : ''}" title="${r} × ${c}: median ${fmtS(p.median)}, average ${fmtS(p.mean)}, slowest ${fmtS(p.max)}, n=${p.count}${p.count < minN ? ' (small sample)' : ''}">${text}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    if (truncated) html += `<p class="muted small">Showing larger factors ${colMin}–${colMax} only; use the pair tables for the rest.</p>`;
    el.innerHTML = html;
    const sel = $('#hm-text');
    sel.value = st.heatText;
    sel.onchange = () => { st.heatText = sel.value; renderHeatmap(el, pairs, minN); };
  }

  /* ---------------- data controls ---------------- */

  function renderStorageInfo() {
    const info = $('#storage-info');
    const nq = state.sessions.reduce((a, s) => a + s.questions.length, 0);
    if (!state.store) {
      info.textContent = `Browser storage unavailable. ${plural(state.sessions.length, 'round')} held in this tab only.`;
      return;
    }
    let kb = '';
    try { kb = ` · about ${Math.ceil(state.store.bytesUsed() / 1024)} KB used`; } catch (e) { /* ignore */ }
    const where = location.protocol === 'file:' ? 'this browser’s local storage for pages opened from files on this computer'
      : `this browser’s local storage for ${location.origin}`;
    info.textContent = `${plural(state.sessions.length, 'round')} (${plural(nq, 'question')}) stored in ${where}${kb}. Nothing is sent anywhere.`;
  }

  function exportBackup() {
    const data = Z.exportBackup(state.sessions, state.settings, Date.now());
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    a.href = URL.createObjectURL(blob);
    a.download = `zetamac-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    dataMsg(`Exported ${plural(state.sessions.length, 'round')} to ${a.download}.`);
  }

  function dataMsg(text, isError) {
    const m = $('#data-msg');
    m.textContent = text;
    m.className = 'small ' + (isError ? 'error' : '');
  }

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let res;
      try { res = Z.parseBackup(String(reader.result), state.sessions); } catch (e) { dataMsg('Import failed: ' + e.message, true); return; }
      let saved = 0;
      let failed = 0;
      res.sessions.forEach((s) => {
        state.sessions.push(s);
        if (persistSession(s)) saved++; else failed++;
      });
      state.sessions.sort((a, b) => a.startedAt - b.startedAt);
      if (res.settings) { state.settings = res.settings; saveSettings(); fillSetupForm(); }
      const parts = [`Imported ${plural(res.sessions.length, 'new round')}`];
      if (res.duplicates) parts.push(`skipped ${plural(res.duplicates, 'duplicate')}`);
      if (res.invalid.length) parts.push(`rejected ${res.invalid.length} invalid (first problem: #${res.invalid[0].index + 1} ${res.invalid[0].error})`);
      if (failed) parts.push(`${failed} could NOT be saved to browser storage`);
      else if (saved) parts.push('all saved');
      dataMsg(parts.join(', ') + '.', failed > 0 || res.invalid.length > 0);
      renderStats();
    };
    reader.onerror = () => dataMsg('Could not read that file.', true);
    reader.readAsText(file);
  }

  function clearHistory() {
    const n = state.sessions.length;
    if (!n) { dataMsg('There is no history to clear.'); return; }
    if (!window.confirm(`Delete all ${plural(n, 'round')} from this browser? Export a backup first if you might want them. This cannot be undone.`)) return;
    try {
      if (state.store) state.store.clearSessions();
    } catch (e) {
      dataMsg('Clearing failed: ' + e.message, true);
      return;
    }
    state.sessions = [];
    state.unsaved.clear();
    updateBanner();
    dataMsg(`Deleted ${plural(n, 'round')}.`);
    renderStats();
  }

  /* ---------------- wiring ---------------- */

  function bind() {
    $('#setup-form').addEventListener('change', (e) => {
      if (e.target.dataset.range) return; // handled on input
      if (e.target.name === 'mode') {
        state.settings.mode = e.target.value;
        fillOps();
      }
      onSetupChange();
      if (e.target.name === 'difficulty') fillRanges();
    });
    $('#setup-form').addEventListener('input', (e) => {
      if (e.target.dataset.range) onRangeInput();
      else if (e.target.type === 'text' || e.target.type === 'number') onSetupChange();
    });
    $('#setup-form').addEventListener('submit', (e) => { e.preventDefault(); if (!$('#start-btn').disabled) startRound(); });

    $('#answer').addEventListener('input', onAnswerInput);
    $('#abandon-btn').addEventListener('click', () => endRound('abandoned'));
    $('#screen-game').addEventListener('mousedown', (e) => {
      if (e.target.id !== 'abandon-btn') setTimeout(() => $('#answer').focus(), 0);
    });

    document.addEventListener('keydown', (e) => {
      if (state.screen === 'game' && e.key === 'Escape') { e.preventDefault(); endRound('abandoned'); return; }
      if (state.screen === 'setup' && e.key === 'Enter' && !e.defaultPrevented) {
        const t = e.target;
        if (t.tagName === 'BUTTON' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return;
        e.preventDefault();
        if (!$('#start-btn').disabled) startRound();
      }
    });
    // Radios/checkboxes don't submit forms on Enter in every browser.
    $('#setup-form').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && (e.target.type === 'radio' || e.target.type === 'checkbox')) {
        e.preventDefault();
        if (!$('#start-btn').disabled) startRound();
      }
    });
    document.addEventListener('visibilitychange', tick);
    // Leaving mid-round: keep what was played, marked as abandoned.
    window.addEventListener('pagehide', () => { if (state.round && state.round.state === 'running') endRound('pagehide'); });

    $('#again-btn').addEventListener('click', startRound);
    $('#change-btn').addEventListener('click', () => show('setup'));
    $$('.nav-btn').forEach((b) => b.addEventListener('click', () => show(b.dataset.nav)));

    ['#f-mode', '#f-settings', '#f-diff', '#f-op', '#f-from', '#f-to', '#f-abandoned'].forEach((id) => $(id).addEventListener('change', renderStats));
    $('#f-reset').addEventListener('click', () => {
      $('#f-mode').value = 'all'; $('#f-settings').value = 'all'; $('#f-diff').value = 'all'; $('#f-op').value = 'all';
      $('#f-from').value = ''; $('#f-to').value = ''; $('#f-abandoned').checked = false;
      renderStats();
    });
    $('#export-btn').addEventListener('click', exportBackup);
    $('#import-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) importFile(file);
      e.target.value = '';
    });
    $('#clear-btn').addEventListener('click', clearHistory);
    $('#jump-data').addEventListener('click', () => $('#data-card').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  function init() {
    initStorage();
    if (state.store) {
      state.settings = state.store.loadSettings();
      const loaded = state.store.loadSessions();
      state.sessions = loaded.sessions;
      state.loadErrors = loaded.errors;
    }
    updateBanner();
    fillSetupForm();
    bind();
    show('setup');
  }

  init();
})();
