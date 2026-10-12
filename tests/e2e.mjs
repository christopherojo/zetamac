// End-to-end check in real Chrome, opening index.html via file:// with networking disabled.
// Usage: node tests/e2e.mjs [path-to-chrome]   (takes ~75 s: one full 60 s round)
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHROME = process.argv[2] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = pathToFileURL(join(ROOT, 'index.html')).href;
const PROFILE = mkdtempSync(join(tmpdir(), 'zetamac-e2e-profile-'));
const DOWNLOADS = mkdtempSync(join(tmpdir(), 'zetamac-e2e-dl-'));
const PORT = 9300 + Math.floor(Math.random() * 500);
const SHOTS = process.env.SHOTS || null; // directory for screenshots, optional
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
async function shot(cdp, name, width = 1200, height = 900) {
  if (!SHOTS) return;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(150);
  const { data } = await cdp.send('Page.captureScreenshot', { captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height: await cdp.evaluate('document.documentElement.scrollHeight'), scale: 1 } });
  (await import('node:fs')).writeFileSync(join(SHOTS, name + '.png'), Buffer.from(data, 'base64'));
}
function check(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  passed++;
  console.log('  ✓ ' + msg);
}

let current = null; // Chrome process, killed on any failure
async function launch() {
  const proc = current = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    // Offline: every network request would fail.
    '--proxy-server=http://127.0.0.1:9', '--host-resolver-rules=MAP * ~NOTFOUND',
    'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return { proc, cdp: await connect(page.webSocketDebuggerUrl) };
    } catch (e) { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('Chrome did not start');
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method) listeners.forEach((l) => l(msg));
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return { send, evaluate, on: (fn) => listeners.push(fn), close: () => ws.close() };
}

async function waitFor(cdp, expr, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await cdp.evaluate(expr)) return true;
    await sleep(50);
  }
  throw new Error('Timed out waiting for: ' + expr);
}

async function key(cdp, k) {
  const codes = { Enter: 13, Escape: 27, Backspace: 8 };
  if (codes[k]) {
    const base = { key: k, code: k, windowsVirtualKeyCode: codes[k], nativeVirtualKeyCode: codes[k] };
    await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base, k === 'Enter' ? { text: '\r' } : {}));
    if (k === 'Enter') await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'char', text: '\r' }, base));
    await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
    return;
  }
  // Digit: real key events, which produce an input event per character.
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: k, code: 'Digit' + k, windowsVirtualKeyCode: 48 + Number(k) });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: 'Digit' + k, windowsVirtualKeyCode: 48 + Number(k) });
}

const currentAnswer = `(() => { const t = document.querySelector('#problem').textContent.split(' ');
  const a = Number(t[0]), b = Number(t[2]);
  return ({'+': a + b, '−': a - b, '×': a * b, '÷': a / b})[t[1]]; })()`;
const storedSessions = `Object.keys(localStorage).filter(k => k.startsWith('zetamac.session.')).map(k => JSON.parse(localStorage.getItem(k)))`;

async function main() {
  const requests = [];
  let { proc, cdp } = await launch();
  const watchNetwork = async (c) => {
    c.on((m) => { if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url); });
    await c.send('Network.enable');
    await c.send('Page.enable');
  };
  await watchNetwork(cdp);

  console.log('Round 1: standard Bullet round, typed with real key events');
  await cdp.send('Page.navigate', { url: PAGE });
  await waitFor(cdp, `document.readyState === 'complete' && !!window.ZCore`);
  check(await cdp.evaluate(`!document.querySelector('#screen-setup').hidden`), 'setup screen shown on open');
  check(await cdp.evaluate(`document.querySelector('input[name=difficulty]:checked').value === 'medium' &&
    document.querySelector('input[name=duration]:checked').value === '120' &&
    [...document.querySelectorAll('input[name=op]')].every(i => i.checked)`), 'defaults: Medium, 120 s, all four operations');

  const rangeVals = `[...document.querySelectorAll('[data-range]')].map(i => i.value).join(',')`;
  const diff = `document.querySelector('input[name=difficulty]:checked').value`;
  check(await cdp.evaluate(rangeVals) === '2,100,2,100,2,12,2,100', 'range fields show the Medium preset');
  await cdp.evaluate(`document.querySelector('input[name=difficulty][value=hard]').click()`);
  check(await cdp.evaluate(rangeVals) === '2,300,2,300,2,20,2,200', 'selecting Hard fills the range fields');
  await cdp.evaluate(`const i = document.querySelector('[data-range="add.0.1"]'); i.value = '250'; i.dispatchEvent(new Event('input', {bubbles: true}))`);
  check(await cdp.evaluate(diff) === 'custom', 'editing a range switches to Custom');
  check(await cdp.evaluate(rangeVals) === '2,250,2,300,2,20,2,200', 'other range values are kept after the edit');
  await cdp.evaluate(`document.querySelector('input[name=difficulty][value=medium]').click()`);
  check(await cdp.evaluate(rangeVals) === '2,100,2,100,2,12,2,100', 'switching back to Medium shows Medium values');
  await cdp.evaluate(`document.querySelector('input[name=difficulty][value=custom]').click()`);
  check(await cdp.evaluate(rangeVals) === '2,250,2,300,2,20,2,200', 'choosing Custom restores the edited ranges');
  await cdp.evaluate(`location.reload()`);
  await sleep(300);
  await waitFor(cdp, `document.readyState === 'complete' && !!window.ZCore`);
  check(await cdp.evaluate(diff) === 'custom' && await cdp.evaluate(rangeVals) === '2,250,2,300,2,20,2,200', 'custom ranges persist across reload');
  await cdp.evaluate(`const i = document.querySelector('[data-range="mul.1.0"]'); i.value = ''; i.dispatchEvent(new Event('input', {bubbles: true}))`);
  check(await cdp.evaluate(`document.querySelector('#start-btn').disabled`), 'an empty range field blocks Start');
  await cdp.evaluate(`document.querySelector('input[name=difficulty][value=medium]').click()`);
  check(await cdp.evaluate(`!document.querySelector('#start-btn').disabled`) && await cdp.evaluate(diff) === 'medium', 'back on Medium, Start is enabled');

  // Choose Bullet (60 s) and confirm at-least-one-operation validation.
  await cdp.evaluate(`document.querySelector('input[name=duration][value="60"]').click()`);
  await cdp.evaluate(`[...document.querySelectorAll('input[name=op]')].forEach(i => { if (i.checked) i.click(); })`);
  check(await cdp.evaluate(`document.querySelector('#start-btn').disabled && /at least one/.test(document.querySelector('#setup-error').textContent)`),
    'cannot start with no operations selected');
  await cdp.evaluate(`[...document.querySelectorAll('input[name=op]')].forEach(i => i.click())`);
  check(await cdp.evaluate(`!document.querySelector('#start-btn').disabled`), 'start enabled again with operations selected');

  await shot(cdp, '1-setup');
  await shot(cdp, '1b-setup-mobile', 390, 844);
  if (SHOTS) await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.evaluate(`document.activeElement.blur()`);
  await key(cdp, 'Enter');
  await waitFor(cdp, `!document.querySelector('#screen-game').hidden`);
  const t0 = Date.now();
  check(await cdp.evaluate(`document.activeElement.id === 'answer'`), 'answer box has focus when the round starts');
  check(await cdp.evaluate(`document.querySelector('#time-left').textContent`) === '60', 'clock shows 60');

  // Answer until a multi-digit answer is up; the timestamp after the last key is when it appeared.
  let problem, ans, shownAt;
  do {
    for (const d of String(await cdp.evaluate(currentAnswer))) await key(cdp, d);
    shownAt = Date.now();
    problem = await cdp.evaluate(`document.querySelector('#problem').textContent`);
    ans = String(await cdp.evaluate(currentAnswer));
  } while (ans.length < 2);
  const scoreBefore = Number(await cdp.evaluate(`document.querySelector('#score').textContent`));
  await key(cdp, ans[0]);
  check(await cdp.evaluate(`document.querySelector('#problem').textContent`) === problem, 'partial answer does not advance');
  // A wrong complete answer, then backspace corrections.
  const wrong = String(Number(ans) + 1);
  for (const d of wrong.slice(1)) await key(cdp, d);
  check(await cdp.evaluate(`document.querySelector('#problem').textContent`) === problem, 'wrong answer leaves the question in place');
  for (let i = 0; i < wrong.length; i++) await key(cdp, 'Backspace');
  check(await cdp.evaluate(`document.querySelector('#answer').value`) === '', 'backspace clears the box');
  await sleep(700);
  for (const d of ans) await key(cdp, d);
  const expectedMs = Date.now() - shownAt;
  check(await cdp.evaluate(`document.querySelector('#problem').textContent`) !== problem ||
    Number(await cdp.evaluate(`document.querySelector('#score').textContent`)) === scoreBefore + 1, 'correct answer advances without Enter');
  check(Number(await cdp.evaluate(`document.querySelector('#score').textContent`)) === scoreBefore + 1, 'score increments by one');
  check(await cdp.evaluate(`document.querySelector('#answer').value === '' && document.activeElement.id === 'answer'`), 'box cleared and focus kept');
  await shot(cdp, '2-game');
  const timedIndex = scoreBefore; // 0-based index of the question answered after a ~0.7 s pause

  // Answer a batch of questions, then idle until the deadline.
  let answered = scoreBefore + 1;
  for (let i = 0; i < 15; i++) {
    const a = String(await cdp.evaluate(currentAnswer));
    for (const d of a) await key(cdp, d);
    answered++;
  }
  const lastCorrectAt = Date.now();
  check(Number(await cdp.evaluate(`document.querySelector('#score').textContent`)) === answered, `score is ${answered} after ${answered} answers`);
  const unfinishedProblem = await cdp.evaluate(`document.querySelector('#problem').textContent`);
  // Type a partial answer to the final question; it must not count.
  const finalAns = String(await cdp.evaluate(currentAnswer));
  if (finalAns.length > 1) await key(cdp, finalAns[0]);

  await waitFor(cdp, `!document.querySelector('#screen-results').hidden`, 70000);
  const elapsed = Date.now() - t0;
  check(elapsed > 59000 && elapsed < 62500, `round ended at the 60 s deadline (${(elapsed / 1000).toFixed(2)} s after start)`);
  // Late answer after the deadline is ignored.
  await cdp.evaluate(`document.querySelector('#answer').value = '${finalAns}'; document.querySelector('#answer').dispatchEvent(new Event('input'))`);

  let stored = await cdp.evaluate(storedSessions);
  check(stored.length === 1, 'exactly one session saved');
  const s1 = stored[0];
  check(s1.sc === answered && s1.st === 'completed' && s1.dur === 60, 'saved score, status and duration are correct');
  check(s1.q.length === answered + 1, 'every completed question plus one unfinished question saved');
  const last = s1.q[s1.q.length - 1];
  check(last[5] === 0 && `${last[1]} ${({ a: '+', s: '−', m: '×', d: '÷' })[last[0]]} ${last[2]}` === unfinishedProblem, 'final question saved as unfinished');
  const expectedUnfinished = 60000 - (lastCorrectAt - t0);
  check(Math.abs(last[4] - expectedUnfinished) < 1500, `unfinished time ≈ time spent on it (${last[4]} ms vs ~${expectedUnfinished} ms)`);
  const timed = s1.q[timedIndex][4];
  check(timed >= 700 && Math.abs(timed - expectedMs) < 300,
    `question timed from display to correct answer, incl. wrong attempts and a 0.7 s pause (${timed} ms vs ~${expectedMs} ms observed)`);
  check(s1.q.slice(0, -1).every((q) => q[5] === 1), 'all other questions completed');
  check(await cdp.evaluate(`/Saved to this browser/.test(document.querySelector('#r-saved').textContent)`), 'results confirm the save');
  check(await cdp.evaluate(`document.querySelector('#r-score').textContent`) === String(answered), 'results show the score');
  check(await cdp.evaluate(`/personal best/i.test(document.querySelector('#r-pb').textContent)`), 'results show personal-best line');
  check(await cdp.evaluate(`document.querySelectorAll('#r-questions tbody tr').length`) === answered + 1, 'question table lists every question');
  await cdp.evaluate(`[...document.querySelectorAll('#r-questions th button')].find(b => b.textContent === 'Time').click()`);
  const times = await cdp.evaluate(`[...document.querySelectorAll('#r-questions tbody tr td:nth-child(4)')].map(td => parseFloat(td.textContent))`);
  check(times.every((t, i) => i === 0 || times[i - 1] >= t), 'question table sorts by time');

  await sleep(700);
  check(await cdp.evaluate(`document.querySelector('#again-btn').classList.contains('primary') && document.activeElement.id === 'again-btn'`),
    'Play again is the primary action and receives focus');
  await shot(cdp, '3-results');
  console.log('Round 2: abandoned with Escape');
  await cdp.evaluate(`document.querySelector('#again-btn').click()`);
  await waitFor(cdp, `!document.querySelector('#screen-game').hidden`);
  for (let i = 0; i < 2; i++) { for (const d of String(await cdp.evaluate(currentAnswer))) await key(cdp, d); }
  await key(cdp, 'Escape');
  await waitFor(cdp, `!document.querySelector('#screen-results').hidden`);
  stored = await cdp.evaluate(storedSessions);
  check(stored.length === 2 && stored.some((s) => s.st === 'abandoned' && s.sc === 2), 'abandoned round saved and marked abandoned');
  check(stored.every((x) => x.dur === 60 && JSON.stringify(x.r) === JSON.stringify(stored[0].r)), 'Play again reused the previous settings');
  check(await cdp.evaluate(`/abandoned/.test(document.querySelector('#r-status').textContent)`), 'results label the round as abandoned');

  console.log('Persistence: quit Chrome normally and reopen');
  const exited = new Promise((r) => proc.on('exit', r));
  await cdp.send('Browser.close').catch(() => {});
  await exited;
  cdp.close();
  ({ proc, cdp } = await launch());
  await watchNetwork(cdp);
  await cdp.send('Page.navigate', { url: PAGE });
  await waitFor(cdp, `document.readyState === 'complete' && !!window.ZCore`);
  stored = await cdp.evaluate(storedSessions);
  check(stored.length === 2, `both rounds still present after browser restart (found ${stored.length})`);
  check(await cdp.evaluate(`document.querySelector('input[name=duration]:checked').value`) === '60', 'last-used settings remembered (60 s)');
  check(await cdp.evaluate(`/Personal best for these settings: ${answered}/.test(document.querySelector('#setup-pb').textContent)`), 'personal best excludes the abandoned round');

  await cdp.evaluate(`document.querySelector('[data-nav=stats]').click()`);
  await waitFor(cdp, `!document.querySelector('#screen-stats').hidden`);
  check(await cdp.evaluate(`document.querySelectorAll('#st-history tbody tr').length`) === 1, 'history excludes abandoned rounds by default');
  await cdp.evaluate(`document.querySelector('#f-abandoned').click()`);
  check(await cdp.evaluate(`document.querySelectorAll('#st-history tbody tr').length`) === 2, 'abandoned round visible when included');
  check(await cdp.evaluate(`!!document.querySelector('#st-mul h2') || /multiplication/i.test(document.querySelector('#stats-body').textContent)`), 'multiplication analysis rendered');

  console.log('Backup: export, clear, import, re-import');
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });
  await cdp.evaluate(`document.querySelector('#export-btn').click()`);
  let file = null;
  for (let i = 0; i < 50 && !file; i++) { await sleep(100); file = readdirSync(DOWNLOADS).find((f) => f.endsWith('.json')); }
  check(!!file, `backup downloaded (${file})`);
  const backupPath = join(DOWNLOADS, file);
  const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
  check(backup.format === 'zetamac-local-backup' && backup.version === 1 && backup.sessions.length === 2 && backup.settings.duration === 60,
    'backup is versioned JSON with both sessions and settings');
  check(backup.sessions.every((s) => s.questions.every((q) => q.sessionId === s.id && typeof q.order === 'number')), 'question records carry sessionId and order');

  await cdp.evaluate(`window.confirm = () => true; document.querySelector('#clear-btn').click()`);
  check((await cdp.evaluate(storedSessions)).length === 0, 'history cleared after confirmation');

  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#import-file' });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [backupPath] });
  await waitFor(cdp, `/Imported/.test(document.querySelector('#data-msg').textContent)`);
  check(/Imported 2 new rounds/.test(await cdp.evaluate(`document.querySelector('#data-msg').textContent`)), 'import restores 2 rounds');
  check((await cdp.evaluate(storedSessions)).length === 2, 'imported rounds saved to storage');
  await cdp.evaluate(`document.querySelector('#data-msg').textContent = ''`);
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [backupPath] });
  await waitFor(cdp, `/Imported/.test(document.querySelector('#data-msg').textContent)`);
  check(/Imported 0 new rounds, skipped 2 duplicates/.test(await cdp.evaluate(`document.querySelector('#data-msg').textContent`)), 're-import skips duplicates');
  check((await cdp.evaluate(storedSessions)).length === 2, 'still exactly 2 rounds stored');

  console.log('Targeted practice');
  const opsChecked = `[...document.querySelectorAll('input[name=op]')].filter(i => i.checked).map(i => i.value).join()`;
  await cdp.evaluate(`document.querySelector('[data-nav=setup]').click()`);
  await cdp.evaluate(`document.querySelector('input[name=mode][value=targeted]').click()`);
  check(await cdp.evaluate(`[...document.querySelectorAll('.op-row')].filter(r => !r.hidden).length`) === 4,
    'targeted mode offers all four operations with their ranges');
  check(await cdp.evaluate(`!document.querySelector('#targeted-panel').hidden && !!document.querySelector('details.how summary')`),
    'targeted controls and "How selection works" are visible');
  // Choose + and × for targeted; standard keeps its own selection.
  await cdp.evaluate(`['sub', 'div'].forEach(o => { const i = document.querySelector('input[name=op][value=' + o + ']'); if (i.checked) i.click(); })`);
  check(await cdp.evaluate(opsChecked) === 'add,mul', 'targeted operations set to + and ×');
  await cdp.evaluate(`document.querySelector('input[name=mode][value=standard]').click()`);
  check(await cdp.evaluate(opsChecked) === 'add,sub,mul,div', 'standard mode keeps its own operations');
  await cdp.evaluate(`document.querySelector('input[name=mode][value=targeted]').click()`);
  check(await cdp.evaluate(opsChecked) === 'add,mul', 'targeted operations restored when switching back');

  await cdp.evaluate(`document.querySelector('input[name=focus][value=numbers]').click()`);
  await cdp.evaluate(`const n = document.querySelector('#t-numbers'); n.value = '7'; n.dispatchEvent(new Event('input', {bubbles: true}));
    const r = document.querySelector('#t-random'); r.value = '0'; r.dispatchEvent(new Event('input', {bubbles: true}));`);
  await cdp.evaluate(`document.querySelector('#start-btn').click()`);
  await waitFor(cdp, `!document.querySelector('#screen-game').hidden`);
  const probs = [];
  for (let i = 0; i < 8; i++) {
    probs.push(await cdp.evaluate(`document.querySelector('#problem').textContent`));
    for (const d of String(await cdp.evaluate(currentAnswer))) await key(cdp, d);
  }
  check(probs.every((p) => /^(7 [+×] \d+|\d+ [+×] 7)$/.test(p)), `targeted questions are + or × with 7 (${probs.join(', ')})`);
  await key(cdp, 'Escape');
  await waitFor(cdp, `!document.querySelector('#screen-results').hidden`);
  stored = await cdp.evaluate(storedSessions);
  check(stored.some((s) => s.m === 'targeted' && s.tg && s.tg.focus === 'numbers' && s.o.join() === 'add,mul'),
    'targeted round stored with its operations and target settings');
  check(await cdp.evaluate(`/^Targeted · numbers 7 with 2–12 · \\+ ×/.test(document.querySelector('#r-label').textContent)`), 'targeted round labelled with its operations');

  // Slowest problems: seed history with slow subtraction problems, one only ever left unfinished.
  await cdp.evaluate(`(() => {
    const Z = window.ZCore, qs = [];
    const add = (a, b, ms, n, status) => { for (let i = 0; i < n; i++) qs.push(Object.assign(Z.makeQuestion('sub', a, b), { ms, status: status || 'completed' })); };
    add(20, 30, 900, 30); add(7, 8, 4000, 5); add(9, 9, 3500, 5); add(6, 7, 3000, 5);
    add(40, 33, 5000, 1, 'unfinished');
    const s = { id: 'seed-sub', startedAt: Date.now() - 864e5, mode: 'standard', difficulty: 'medium', ranges: Z.PRESETS.medium,
      ops: ['sub'], duration: 120, score: 45, status: 'completed', questions: qs.map((q, i) => Object.assign({ order: i + 1 }, q)) };
    localStorage.setItem('zetamac.session.seed-sub', JSON.stringify(Z.toStored(Z.validateSession(s))));
  })()`);
  await cdp.send('Page.reload');
  await waitFor(cdp, `document.readyState === 'complete' && !!window.ZCore && !document.querySelector('#screen-setup').hidden`);
  check(await cdp.evaluate(`document.querySelector('input[name=mode]:checked').value`) === 'targeted', 'targeted mode remembered after reload');
  await cdp.evaluate(`document.querySelector('input[name=focus][value=slowest]').click()`);
  await cdp.evaluate(`['add', 'mul'].forEach(o => document.querySelector('input[name=op][value=' + o + ']').click());
    document.querySelector('input[name=op][value=sub]').click()`);
  check(await cdp.evaluate(opsChecked) === 'sub', 'targeted operations set to − only');
  const chips = await cdp.evaluate(`[...document.querySelectorAll('#target-preview .chip')].map(c => c.textContent)`);
  // Typical − time is 0.9 s, so the unfinished 73 − 40 (5 s) scores min(5 s, 3 × 0.9 s) = 2.7 s.
  // (Round 1's unfinished question may also qualify; it is real history.)
  const chipKeys = chips.map((c) => c.split(' · ')[0]);
  const idx = (k) => chipKeys.indexOf(k);
  check(['15 − 7', '18 − 9', '13 − 6', '73 − 40', '50 − 20'].every((k) => idx(k) >= 0) &&
    idx('15 − 7') < idx('18 − 9') && idx('18 − 9') < idx('13 − 6') && idx('13 − 6') < idx('73 − 40') && idx('73 − 40') < idx('50 − 20') &&
    chips[idx('73 − 40')].includes('unfinished') && chips[idx('73 − 40')].includes('2.70 s'),
    `preview ranks slow problems by median and includes the unfinished one, capped (${chips.join(' | ')})`);
  await shot(cdp, '6-targeted-setup');
  if (SHOTS) await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.evaluate(`document.querySelector('#start-btn').click()`);
  await waitFor(cdp, `!document.querySelector('#screen-game').hidden`);
  const pool = chipKeys;
  const seen = [];
  for (let i = 0; i < 8; i++) {
    seen.push(await cdp.evaluate(`document.querySelector('#problem').textContent`));
    for (const d of String(await cdp.evaluate(currentAnswer))) await key(cdp, d);
  }
  check(seen.every((p) => pool.includes(p)), `slowest-problem round draws only from the pool at 0% random (${seen.join(', ')})`);
  check(seen.every((p, i) => i === 0 || p !== seen[i - 1]), 'no problem shown twice in a row');
  await key(cdp, 'Escape');
  await waitFor(cdp, `!document.querySelector('#screen-results').hidden`);
  stored = await cdp.evaluate(storedSessions);
  check(stored.some((s) => s.m === 'targeted' && s.tg.focus === 'slowest' && s.o.join() === 'sub' && s.q.every((q) => q[6] === 't')),
    'slowest-problem round saved as targeted with targeted sources');

  await cdp.evaluate(`document.querySelector('[data-nav=stats]').click()`);
  await cdp.evaluate(`document.querySelector('#f-mode').value = 'targeted'; document.querySelector('#f-mode').dispatchEvent(new Event('change')); document.querySelector('#f-abandoned').checked = true; document.querySelector('#f-abandoned').dispatchEvent(new Event('change'))`);
  check(await cdp.evaluate(`[...document.querySelectorAll('#st-history tbody tr td:nth-child(2)')].every(td => td.textContent === 'targeted')`),
    'statistics can show targeted rounds on their own');
  await cdp.evaluate(`document.querySelector('#f-mode').value = 'all'; document.querySelector('#f-mode').dispatchEvent(new Event('change'))`);
  await shot(cdp, '4-stats');
  await shot(cdp, '5-stats-mobile', 390, 844);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  const beforeFailure = (await cdp.evaluate(storedSessions)).length;

  console.log('Save failure is reported, not hidden');
  await cdp.evaluate(`Storage.prototype.setItem = function () { throw new DOMException('quota exceeded (simulated)', 'QuotaExceededError'); }`);
  await cdp.evaluate(`document.querySelector('[data-nav=setup]').click(); document.querySelector('input[name=mode][value=standard]').click(); document.querySelector('#start-btn').click()`);
  await waitFor(cdp, `!document.querySelector('#screen-game').hidden`);
  for (const d of String(await cdp.evaluate(currentAnswer))) await key(cdp, d);
  await key(cdp, 'Escape');
  await waitFor(cdp, `!document.querySelector('#screen-results').hidden`);
  check(await cdp.evaluate(`/Not saved/.test(document.querySelector('#r-saved').textContent)`), 'results say the round was NOT saved');
  check(await cdp.evaluate(`!document.querySelector('#banner').hidden && /could not be saved/.test(document.querySelector('#banner').textContent)`), 'banner warns about the unsaved round');
  check((await cdp.evaluate(storedSessions)).length === beforeFailure, `storage unchanged (${beforeFailure} rounds)`);

  console.log('Offline');
  const external = requests.filter((u) => !/^(file|data|blob|about|chrome|devtools):/.test(u));
  check(external.length === 0, `no network requests (saw ${requests.length} requests, all local)`);
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8') + readFileSync(join(ROOT, 'styles.css'), 'utf8');
  check(!/https?:\/\//.test(html), 'no remote URLs in HTML/CSS');

  cdp.close();
  proc.kill();
  await new Promise((r) => proc.on('exit', r));
  console.log(`\nAll ${passed} end-to-end checks passed.`);
}

main().then(() => {
  rmSync(PROFILE, { recursive: true, force: true });
  rmSync(DOWNLOADS, { recursive: true, force: true });
  process.exit(0);
}).catch((e) => {
  console.error(e);
  if (current) current.kill();
  process.exit(1);
});
