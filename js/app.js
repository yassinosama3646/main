/* Rebuild 100 — app logic. Vanilla JS, localStorage, no build step. */
(function () {
  'use strict';
  const { EXERCISES, SPLITS, PHASES, TOTAL_DAYS, GUIDE, MEALS, DEFAULT_SETTINGS } = window.R100;
  const KEY = 'rebuild100.v1';

  /* ---------- state + persistence ----------
     Source of truth while the page runs: `state` (in memory).
     Durable copies: localStorage (always, instant) and the artifact's `db` capability
     (when the claude.ai viewer grants it: survives reloads, devices and republishes).
     Records: sessions/<date>, body/<date>, habits/<date>, settings/main, meta/reset.
     Rules that protect data:
       - nothing is written to the account until the first download (merge) succeeded;
       - sessions merge per exercise and per set (union), never whole-record replace;
       - deletes carry a timestamp and lose to a newer remote write;
       - a reset writes a tombstone so stale devices do not resurrect old logs;
       - unsynced changes live in a persisted queue, so a killed tab loses nothing. */
  const PENDING_KEY = KEY + '.pending', FAILED_KEY = KEY + '.failed', SYNCED_KEY = KEY + '.synced';
  const LEGACY_TS = 1;                  // stamp for records that predate timestamps
  const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
  const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
  let state = load();
  let pending = loadMap(PENDING_KEY);   // path -> body | {__del:true, at}
  let failed = loadMap(FAILED_KEY);     // path -> error code (permanent write failures)
  let lastSynced = loadMap(SYNCED_KEY); // path -> signature of the last body both sides agreed on (3-way merge base)
  let baseline = new Map();             // path -> signature of the last persisted body
  let dbNs = null, db = null;           // dbNs: namespace once granted; db: same, but only after the first merge succeeded
  let dbState = 'off', dbErr = null, flushing = false, flushT = null, failures = 0, mergeAttempt = 0, mergeT = null, unsubs = [];
  let dirty = false, renderQueued = false;
  const inflight = new Set();           // paths whose write is on the wire: snapshots about them are stale by definition
  let viewDate = todayStr();
  let activeTab = 'today';
  let restTimer = null;
  const COLLECTIONS = ['sessions', 'body', 'habits', 'settings', 'meta'];

  function sanitize(raw) {
    const s = isObj(raw) ? raw : {};
    const out = {};
    out.settings = Object.assign({}, DEFAULT_SETTINGS, isObj(s.settings) ? s.settings : {});
    out.sessions = {}; if (isObj(s.sessions)) Object.keys(s.sessions).forEach(d => { const v = s.sessions[d]; if (DATE_RE.test(d) && isObj(v)) { v.sets = isObj(v.sets) ? v.sets : {}; Object.keys(v.sets).forEach(ex => { if (!Array.isArray(v.sets[ex])) delete v.sets[ex]; else v.sets[ex] = v.sets[ex].filter(isObj); }); out.sessions[d] = v; } });
    out.body = Array.isArray(s.body) ? s.body.filter(b => isObj(b) && DATE_RE.test(b.date) && isFinite(Number(b.kg))) : [];
    out.habits = {}; if (isObj(s.habits)) Object.keys(s.habits).forEach(d => { if (DATE_RE.test(d) && isObj(s.habits[d])) out.habits[d] = s.habits[d]; });
    out.resetAt = typeof s.resetAt === 'number' ? s.resetAt : 0;
    return out;
  }
  function load() { let raw = null; try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { raw = null; } return sanitize(raw); }
  function loadMap(key) { try { const a = JSON.parse(localStorage.getItem(key) || '[]'); return new Map(Array.isArray(a) ? a.filter(e => Array.isArray(e) && typeof e[0] === 'string').map(e => [e[0], e[1] === null ? { __del: true, at: 0 } : e[1]]) : []); } catch (e) { return new Map(); } }
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const sig = (body) => JSON.stringify(body, (k, v) => k === 'updatedAt' ? undefined : v);
  const DEFAULT_SIG = sig(DEFAULT_SETTINGS);
  const ts = (b) => (b && typeof b.updatedAt === 'number') ? b.updatedAt : 0;
  const isDel = (v) => !!(v && v.__del);

  /* Flattened view: db path -> the live state object that is the document body. */
  function records() {
    const m = new Map();
    Object.keys(state.sessions).forEach(d => { if (state.sessions[d]) m.set('sessions/' + d, state.sessions[d]); });
    state.body.forEach(b => { if (b && b.date) m.set('body/' + b.date, b); });
    Object.keys(state.habits).forEach(d => { if (state.habits[d]) m.set('habits/' + d, state.habits[d]); });
    m.set('settings/main', state.settings);
    if (state.resetAt) m.set('meta/reset', { at: state.resetAt, updatedAt: state.resetAt });
    return m;
  }
  function rebuildBaseline() { baseline = new Map(); records().forEach((b, p) => baseline.set(p, sig(b))); }
  rebuildBaseline();

  /* Compare live state with the last persisted signatures; stamp and queue what changed. */
  function diffAndQueue() {
    const now = Date.now();
    const live = records();
    live.forEach((body, path) => {
      const sg = sig(body);
      if (baseline.get(path) !== sg) { body.updatedAt = now; baseline.set(path, sg); pending.set(path, clone(body)); failed.delete(path); dirty = true; }
    });
    Array.from(baseline.keys()).forEach(path => { if (!live.has(path)) { baseline.delete(path); pending.set(path, { __del: true, at: now }); dirty = true; } });
  }
  function persistLocal(force) {
    if (!dirty && !force) return;                                   // a tab that changed nothing never overwrites another tab's work
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(Array.from(pending.entries()))); } catch (e) { /* storage unavailable */ }
    try { localStorage.setItem(FAILED_KEY, JSON.stringify(Array.from(failed.entries()))); } catch (e) { /* storage unavailable */ }
    try { localStorage.setItem(SYNCED_KEY, JSON.stringify(Array.from(lastSynced.entries()))); } catch (e) { /* storage unavailable */ }
  }
  function baseOf(path) { const sg = lastSynced.get(path); if (!sg) return null; try { return JSON.parse(sg); } catch (e) { return null; } }
  let saveT = null;
  function flushLocalNow() { clearTimeout(saveT); saveT = null; const before = pending.size; diffAndQueue(); persistLocal(); if (pending.size !== before) scheduleFlush(0); }
  function save(now) {
    clearTimeout(saveT);
    const run = () => { saveT = null; diffAndQueue(); persistLocal(); scheduleFlush(0); };
    if (now) run(); else saveT = setTimeout(run, 250);
  }
  window.addEventListener('pagehide', () => save(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(true); else if (dbNs && !db) scheduleMerge(0); else scheduleFlush(0); });
  /* another tab of this same browser wrote newer data: adopt it */
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY || !e.newValue) return;
    let other = null; try { other = sanitize(JSON.parse(e.newValue)); } catch (x) { return; }
    const theirs = new Map();
    Object.keys(other.sessions).forEach(d => theirs.set('sessions/' + d, other.sessions[d]));
    other.body.forEach(b => theirs.set('body/' + b.date, b));
    Object.keys(other.habits).forEach(d => theirs.set('habits/' + d, other.habits[d]));
    theirs.set('settings/main', other.settings);
    let changed = false;
    theirs.forEach((r, path) => { const res = reconcile(path, records().get(path), r); if (res.apply) { applyRemote(path, res.body); changed = true; } });
    if (changed) requestRender();
  });

  /* ----- merging: union, newer wins on a real conflict, deterministic ----- */
  function newerFirst(a, b) { const ta = ts(a), tb = ts(b); if (ta !== tb) return ta > tb ? [a, b] : [b, a]; return JSON.stringify(a) >= JSON.stringify(b) ? [a, b] : [b, a]; }
  const filled = (v) => !(v === '' || v == null);
  /* Three-way cell merge: n = newer side, o = older side, b = common base (may be undefined).
     Only one side changed from the base -> that side. Both changed -> prefer a filled value, then the newer side. */
  const same = (a, b) => String(a == null ? '' : a) === String(b == null ? '' : b);
  function cell(nv, ov, bv, hasBase) {
    if (hasBase) { if (same(nv, bv)) return ov; if (same(ov, bv)) return nv; }
    if (filled(nv)) return nv; if (filled(ov)) return ov; return nv == null ? ov : nv;
  }
  function mergeSession(x, y, base) {
    const [n, o] = newerFirst(x, y);
    const hb = isObj(base); const bs = (hb && base.sets) || {};
    const out = {
      workoutId: cell(n.workoutId, o.workoutId, hb ? base.workoutId : null, hb) || null,
      splitId: cell(n.splitId, o.splitId, hb ? base.splitId : null, hb) || null,
      sets: {}, done: false, notes: '', finishedAt: null,
    };
    const bd = hb ? !!base.done : false;
    out.done = hb ? ((!!n.done !== bd) ? !!n.done : !!o.done) : !!(n.done || o.done);
    out.finishedAt = cell(n.finishedAt, o.finishedAt, hb ? base.finishedAt : null, hb) || null;
    const exs = new Set([...Object.keys(n.sets || {}), ...Object.keys(o.sets || {})]);
    exs.forEach(ex => {
      const a = (n.sets && n.sets[ex]) || [], b = (o.sets && o.sets[ex]) || [], c = bs[ex] || [];
      const len = Math.max(a.length, b.length); const rows = [];
      for (let i = 0; i < len; i++) {
        const ra = a[i] || {}, rb = b[i] || {}, rc = c[i] || {};
        const hasB = hb && !!c[i];
        const w = cell(ra.w, rb.w, rc.w, hasB), r = cell(ra.r, rb.r, rc.r, hasB);
        const done = hasB ? ((!!ra.done !== !!rc.done) ? !!ra.done : !!rb.done) : !!(ra.done || rb.done);
        rows.push({ w: w == null ? '' : w, r: r == null ? '' : r, done });
      }
      out.sets[ex] = rows;
    });
    const nn = n.notes || '', on = o.notes || '', bn = hb ? (base.notes || '') : null;
    if (hb && nn === bn) out.notes = on; else if (hb && on === bn) out.notes = nn;
    else out.notes = nn.includes(on) ? nn : (on.includes(nn) ? on : (nn + '\n' + on).trim());
    out.updatedAt = Math.max(ts(n), ts(o));
    return out;
  }
  function mergeFlat(x, y, base) {
    const [n, o] = newerFirst(x, y); const hb = isObj(base);
    const out = {}; new Set([...Object.keys(o), ...Object.keys(n)]).forEach(k => { if (k === 'updatedAt') return; out[k] = hb ? cell(n[k], o[k], base[k], Object.prototype.hasOwnProperty.call(base, k) || true) : (n[k] != null ? n[k] : o[k]); });
    out.updatedAt = Math.max(ts(n), ts(o)); return out;
  }
  function mergeSettings(x, y, base) {
    const xd = sig(x) === DEFAULT_SIG, yd = sig(y) === DEFAULT_SIG;
    if (xd !== yd) return clone(xd ? y : x);                        // untouched defaults never beat real settings
    return mergeFlat(x, y, base);
  }
  function mergeBodies(col, x, y, base) {
    if (col === 'sessions') return mergeSession(x, y, base);
    if (col === 'habits' || col === 'body') return mergeFlat(x, y, base);
    if (col === 'settings') return mergeSettings(x, y, base);
    return clone(newerFirst(x, y)[0]);
  }
  /* Decide what to do for one path given the local record (l) and the remote one (r).
     Returns {body, apply, push}: apply = replace local with body, push = write body to the account. */
  function reconcile(path, l, r) {
    const col = path.split('/')[0];
    const pend = pending.get(path);
    if (isDel(pend)) {
      if (r && ts(r) > pend.at) { pending.delete(path); return { body: clone(r), apply: true, push: false }; }   // remote wrote after our delete: the delete loses
      return { body: null, apply: false, push: false };
    }
    if (r && !l) {
      if (state.resetAt && ts(r) < state.resetAt) return { body: null, apply: false, push: false };
      return { body: clone(r), apply: true, push: false };
    }
    if (l && !r) {
      if (col === 'settings' && sig(l) === DEFAULT_SIG) return { body: null, apply: false, push: false };        // never upload untouched defaults
      if (state.resetAt && ts(l) < state.resetAt && col !== 'meta' && col !== 'settings') return { body: null, apply: false, push: false, drop: true };
      return { body: l, apply: false, push: true };
    }
    if (!l && !r) return { body: null, apply: false, push: false };
    if (sig(l) === sig(r)) { lastSynced.set(path, sig(r)); return { body: l, apply: false, push: false }; }
    const m = mergeBodies(col, l, r, baseOf(path));
    const changedLocal = sig(m) !== sig(l), changedRemote = sig(m) !== sig(r);
    if (changedRemote) m.updatedAt = Math.max(ts(l), ts(r), m.updatedAt || 0) + 1;    // so every device sees the merge as newer
    else m.updatedAt = ts(r);
    return { body: m, apply: changedLocal || ts(m) !== ts(l), push: changedRemote };
  }

  /* ----- db sync ----- */
  function setDbState(st, err) { dbState = st; dbErr = err || null; renderSyncState(); }
  function renderSyncState() {
    const n = pending.size, f = failed.size;
    const map = {
      off: 'Saved on this device only · back up weekly in Settings',
      connecting: 'Saved on device · connecting to your account…',
      merging: 'Saved on device · downloading your logs…',
      syncing: `Syncing ${n} change${n === 1 ? '' : 's'}…`,
      synced: 'Saved on this device and in your account',
      error: `Saved on device · ${n} change${n === 1 ? '' : 's'} waiting to sync (retrying)`,
    };
    let text = map[dbState] || '';
    if (f && dbState !== 'off') text += ` · ${f} record${f === 1 ? '' : 's'} could not be saved to your account`;
    const line = document.getElementById('syncstate'); if (line) { line.textContent = text; line.dataset.state = f && dbState === 'synced' ? 'error' : dbState; }
    const chip = document.getElementById('syncchip'); if (chip) { chip.textContent = dbState === 'off' ? 'Device only' : dbState === 'synced' ? (f ? 'Synced with errors' : 'Synced') : dbState === 'error' ? 'Sync retrying' : 'Connecting…'; chip.className = 'chip ' + (dbState === 'synced' && !f ? 'good' : dbState === 'error' || f ? 'warn' : ''); }
    const btn = document.getElementById('syncNow'); if (btn) btn.disabled = !dbNs;
    const det = document.getElementById('syncdetail'); if (det) det.textContent = `${Object.keys(state.sessions).length} sessions · ${state.body.length} weigh-ins · ${Object.keys(state.habits).length} habit days`;
  }
  function scheduleFlush(ms) { if (!db) return; clearTimeout(flushT); flushT = setTimeout(flush, ms || 0); }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function flush() {
    if (!db || flushing) return;
    if (!pending.size) { setDbState('synced'); return; }
    flushing = true; setDbState('syncing');
    try {
      while (pending.size) {
        if (!db) return;                                              // revoked mid-flight
        const [path, body] = pending.entries().next().value;
        pending.delete(path); inflight.add(path);
        try {
          if (isDel(body)) { await db.doc(path).delete(); lastSynced.delete(path); } else { await db.doc(path).set(body); lastSynced.set(path, sig(body)); }
          inflight.delete(path);
          failures = 0; dirty = true; persistLocal(); renderSyncState();
        } catch (e) {
          inflight.delete(path);
          const code = e && e.code;
          const permanent = code === 'invalid_argument' || code === 'transform_error' || code === 'quota_exceeded' || !code;
          if (permanent) { if (!pending.has(path)) failed.set(path, code || 'error'); dirty = true; persistLocal(); failures = 0; continue; }
          if (!pending.has(path)) pending.set(path, body);            // a newer queued body wins over the failed one
          dirty = true; persistLocal();
          if (code === 'revoked' || code === 'not_granted' || code === 'capability_disabled' || code === 'capability_removed') { goOffline(); return; }
          failures += 1;
          if (failures >= 3) { setDbState('error', e); scheduleFlush(15000); return; }
          await sleep(400 + Math.random() * 600);
        }
      }
      setDbState('synced');
    } finally { flushing = false; }
  }
  function goOffline() { unsubs.forEach(u => { try { u(); } catch (e) {} }); unsubs = []; db = null; dbNs = null; setDbState('off'); }
  function docPath(col, id) { return col + '/' + id; }
  function validPath(path) { const [col, id] = path.split('/'); return !!id && (col === 'settings' ? id === 'main' : col === 'meta' ? id === 'reset' : DATE_RE.test(id)); }
  function applyRemote(path, body) {
    if (!validPath(path) || !isObj(body)) return false;
    const [col, id] = path.split('/');
    if (col === 'sessions') state.sessions[id] = body;
    else if (col === 'habits') state.habits[id] = body;
    else if (col === 'body') { state.body = state.body.filter(b => b.date !== id); state.body.push(Object.assign({ date: id }, body)); }
    else if (col === 'settings') state.settings = Object.assign({}, DEFAULT_SETTINGS, body);
    else if (col === 'meta') { state.resetAt = Math.max(state.resetAt || 0, Number(body.at) || 0); pruneBeforeReset(); }
    baseline.set(path, sig(records().get(path) || body));
    dirty = true;
    return true;
  }
  function removeLocal(path) {
    const [col, id] = path.split('/');
    if (col === 'sessions') delete state.sessions[id];
    else if (col === 'habits') delete state.habits[id];
    else if (col === 'body') state.body = state.body.filter(b => b.date !== id);
    else return false;
    baseline.delete(path); lastSynced.delete(path); dirty = true;
    return true;
  }
  function pruneBeforeReset() {
    if (!state.resetAt) return;
    records().forEach((b, path) => { const col = path.split('/')[0]; if ((col === 'sessions' || col === 'body' || col === 'habits') && ts(b) < state.resetAt) { removeLocal(path); pending.delete(path); } });
  }

  async function connectDb() {
    if (!(window.claude && typeof window.claude.use === 'function')) { setDbState('off'); return; }
    setDbState('connecting');
    try { dbNs = await window.claude.use('db'); } catch (e) { dbNs = null; }
    if (!dbNs) { setDbState('off'); return; }
    scheduleMerge(0);
  }
  function scheduleMerge(ms) { clearTimeout(mergeT); mergeT = setTimeout(runMerge, ms); }
  async function runMerge() {
    if (!dbNs || db) return;
    setDbState('merging');
    try {
      await initialMerge();
      db = dbNs; mergeAttempt = 0;
      subscribeRemote();
      scheduleFlush(0);
      if (!pending.size) setDbState('synced');
    } catch (e) {
      const code = e && e.code;
      if (code === 'revoked' || code === 'not_granted' || code === 'capability_disabled' || code === 'capability_removed') { goOffline(); return; }
      mergeAttempt += 1; setDbState('error', e);
      scheduleMerge([1000, 3000, 10000, 30000][Math.min(mergeAttempt - 1, 3)] + Math.random() * 500);  // keeps retrying every 30 s
    }
  }
  async function getAll(c) {
    try { return await dbNs.collection(c).get(); }
    catch (e) { if (e && e.code === 'unavailable') { await sleep(300 + Math.random() * 400); return dbNs.collection(c).get(); } throw e; }
  }
  async function initialMerge() {
    const remote = new Map();
    for (const c of COLLECTIONS) { const snap = await getAll(c); snap.docs.forEach(d => { if (d.exists) remote.set(docPath(c, d.id), d.data()); }); }
    flushLocalNow();                                                    // stamp anything typed while we were downloading
    const rr = remote.get('meta/reset'); if (rr && Number(rr.at) > (state.resetAt || 0)) { state.resetAt = Number(rr.at); baseline.set('meta/reset', sig(records().get('meta/reset'))); pruneBeforeReset(); }
    const local = records();
    let changed = false;
    new Set([...remote.keys(), ...local.keys()]).forEach(path => {
      if (!validPath(path)) return;
      const r = remote.get(path), l = local.get(path);
      const res = reconcile(path, l, r);
      if (r && !isDel(pending.get(path))) lastSynced.set(path, sig(r)); else if (!r) lastSynced.delete(path);
      if (res.drop) { removeLocal(path); pending.delete(path); changed = true; return; }
      if (res.apply) { applyRemote(path, res.body); pending.delete(path); changed = true; }
      if (res.push) { const b = res.body; if (!b.updatedAt) b.updatedAt = LEGACY_TS; baseline.set(path, sig(b)); pending.set(path, clone(b)); }
      else if (!res.apply && l && !r) pending.delete(path);
    });
    dirty = true; persistLocal();
    if (changed) requestRender();
  }
  function subscribeRemote() {
    unsubs.forEach(u => { try { u(); } catch (e) {} }); unsubs = [];
    COLLECTIONS.forEach(c => {
      const u = db.collection(c).onSnapshot(snap => {
        let changed = false;
        const changes = snap.docChanges();
        if (changes.length && saveT) flushLocalNow();                 // typed-but-unsaved edits get stamped before anything remote lands
        changes.forEach(ch => {
          const path = docPath(c, ch.doc.id); if (!validPath(path)) return;
          const l = records().get(path);
          if (inflight.has(path)) return;                              // a write of ours is on the wire: this snapshot predates it
          if (ch.type === 'removed') {
            if (pending.has(path)) return;                            // our own newer change is still queued
            if (l) { changed = removeLocal(path) || changed; }
            return;
          }
          const r = ch.doc.data(); if (!r) return;
          // a queued local write is not a reason to ignore the server: both are merged three-way against the last agreed body
          const res = reconcile(path, l, r);
          if (!isDel(pending.get(path))) lastSynced.set(path, sig(r));
          if (res.apply) changed = applyRemote(path, res.body) || changed;
          if (res.push) { const b = res.body; baseline.set(path, sig(b)); pending.set(path, clone(b)); scheduleFlush(50); }
        });
        if (changed) { dirty = true; persistLocal(); requestRender(); }
      }, (e) => {
        if (e && e.code === 'revoked') { goOffline(); return; }
        // any other terminal error kills the listener: reconnect from scratch after a pause
        unsubs.forEach(x => { try { x(); } catch (y) {} }); unsubs = []; db = null; setDbState('error', e); scheduleMerge(3000 + Math.random() * 2000);
      });
      unsubs.push(u);
    });
  }
  /* Re-render, but never under the user's fingers: wait until the focused input is left. */
  function typing() { const a = document.activeElement; return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.closest('main')); }
  function requestRender() { if (typing()) { renderQueued = true; renderSyncState(); return; } renderQueued = false; render(); }
  document.addEventListener('focusout', () => { if (renderQueued) setTimeout(() => { if (renderQueued && !typing()) { renderQueued = false; render(); } }, 50); });

  /* ---------- dates ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function parse(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function fmt(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); }
  function diffDays(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
  function human(s) { return parse(s).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }); }
  function humanLong(s) { return parse(s).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }

  /* ---------- plan logic ---------- */
  const dayIndex = (dateStr) => diffDays(state.settings.startDate, dateStr) + 1;
  const dateOfDay = (n) => addDays(state.settings.startDate, n - 1);
  function phaseFor(n) {
    if (n < 1) return null;
    return PHASES.find(p => n >= p.from && n <= p.to) || PHASES[PHASES.length - 1];
  }
  function splitFor(n) {
    const o = state.settings.splitOverride;
    if (o && SPLITS[o]) return SPLITS[o];
    const p = phaseFor(n);
    return SPLITS[p ? p.split : 'ul4'];
  }
  function splitIdFor(n) { return Object.keys(SPLITS).find(k => SPLITS[k] === splitFor(n)); }
  function plannedWorkoutId(n) {
    if (n < 1) return null;
    const sp = splitFor(n);
    return sp.pattern[((n - 1) % 7 + 7) % 7];
  }
  function prescribe(item, phase) {
    if (item.cardio) return { sets: 1, deload: false };
    if (!phase) return { sets: item.sets, deload: false };
    if (phase.setMod === 'deload') return { sets: 2, deload: true };
    let s = item.sets;
    if (phase.setMod === -1) s -= 1;
    if (phase.setMod === 1 && item.priority) s += 1;
    return { sets: Math.max(2, s), deload: false };
  }
  function topReps(reps) { const m = String(reps).match(/(\d+)(?:\s*[–-]\s*(\d+))?/); if (!m || /min|s\b/.test(reps)) return null; return Number(m[2] || m[1]); }
  function bottomReps(reps) { const m = String(reps).match(/(\d+)/); return m ? Number(m[1]) : null; }
  function restLabel(sec) { return sec % 60 === 0 ? (sec / 60) + ' min' : sec < 120 ? sec + ' s' : (sec / 60).toFixed(1) + ' min'; }
  function isTimed(reps) { return /min|\ss$|s\b/.test(String(reps)); }

  function hasLoggedSets(sess) { return !!(sess && sess.sets && Object.keys(sess.sets).some(ex => sess.sets[ex].some(x => (x.w !== '' && x.w != null) || (x.r !== '' && x.r != null) || x.done))); }
  function hasContent(sess) { return !!(sess && (hasLoggedSets(sess) || sess.done || (sess.notes && sess.notes.trim()))); }
  function workoutName(sess) { const sp = SPLITS[sess.splitId]; const w = sp && sp.workouts[sess.workoutId]; return w ? w.name : (sess.workoutId || 'Session'); }

  /* previous performance of an exercise before a date */
  function lastPerformance(exId, beforeDate) {
    const dates = Object.keys(state.sessions).filter(d => d < beforeDate && state.sessions[d].sets && state.sessions[d].sets[exId]).sort();
    for (let i = dates.length - 1; i >= 0; i--) {
      const sets = state.sessions[dates[i]].sets[exId].filter(s => s.r !== '' && s.r != null);
      if (sets.length) return { date: dates[i], sets };
    }
    return null;
  }
  function suggestion(exId, item, beforeDate) {
    const lp = lastPerformance(exId, beforeDate);
    if (!lp || isTimed(item.reps)) return null;
    const top = topReps(item.reps);
    const bottom = bottomReps(item.reps);
    const reps = lp.sets.map(s => Number(s.r));
    const w = lp.sets.map(s => Number(s.w || 0));
    const maxW = Math.max(...w);
    if (reps.every(r => r >= top)) {
      const bigLift = /leg_press|hack_squat|back_squat|hip_thrust|rdl/.test(exId);
      const jump = bigLift ? 5 : 2.5;
      return { kind: 'up', text: `Earned a jump: try ${(maxW + jump).toFixed(1).replace(/\.0$/, '')} kg (+${jump})` };
    }
    if (reps.filter(r => r < bottom).length >= 2) return { kind: 'down', text: 'Missed the range twice: drop 5–10% today' };
    return { kind: 'hold', text: `Hold ${maxW} kg, aim for ${top} reps on every set` };
  }

  /* ---------- nutrition ---------- */
  function latestWeight() {
    const b = [...state.body].sort((a, c) => a.date < c.date ? 1 : -1);
    return b.length ? Number(b[0].kg) : Number(state.settings.startWeightKg);
  }
  function nutrition(n) {
    const s = state.settings, w = latestWeight();
    const bmr = s.sex === 'f' ? 10 * w + 6.25 * s.heightCm - 5 * s.age - 161 : 10 * w + 6.25 * s.heightCm - 5 * s.age + 5;
    const tdee = bmr * Number(s.activity);
    const ph = phaseFor(n) || PHASES[0];
    const kcal = Math.round((tdee + ph.kcalOffset) / 50) * 50;
    const protein = Math.round(2.1 * w / 5) * 5;
    const fat = Math.round(0.9 * w / 5) * 5;
    const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
    return { bmr: Math.round(bmr), tdee: Math.round(tdee), kcal, protein, fat, carbs, phase: ph, weight: w };
  }
  function weeklyAverages() {
    const byWeek = {};
    state.body.forEach(e => {
      const n = dayIndex(e.date); if (n < 1) return;
      const wk = Math.floor((n - 1) / 7) + 1;
      (byWeek[wk] = byWeek[wk] || []).push(e);
    });
    return Object.keys(byWeek).map(Number).sort((a, b) => a - b).map(wk => {
      const es = byWeek[wk];
      const avg = es.reduce((s, e) => s + Number(e.kg), 0) / es.length;
      const waists = es.filter(e => e.waist).map(e => Number(e.waist));
      const waist = waists.length ? waists.reduce((a, b) => a + b, 0) / waists.length : null;
      return { wk, n: es.length, avg, waist, phase: phaseFor((wk - 1) * 7 + 1) };
    });
  }
  function trendAdvice() {
    const wks = weeklyAverages().filter(w => w.n >= 3);
    if (wks.length < 2) return { text: 'Log at least 3 weigh-ins a week for two weeks and the app will tell you whether to adjust calories.', kind: 'muted' };
    const a = wks[wks.length - 2], b = wks[wks.length - 1];
    const rate = b.avg - a.avg;
    const [lo, hi] = b.phase.rateTarget;
    const r = rate.toFixed(2);
    if (rate < lo) return { text: `Week ${b.wk} average moved ${r} kg vs week ${a.wk}. That is below the ${lo} to ${hi} kg target for ${b.phase.name}: add 150 kcal (carbs) for the next week.`, kind: 'warn' };
    if (rate > hi) return { text: `Week ${b.wk} average moved +${r} kg vs week ${a.wk}. That is above the ${lo} to ${hi} kg target for ${b.phase.name}: cut 150 kcal (carbs or fat) for the next week.`, kind: 'warn' };
    return { text: `Week ${b.wk} average moved ${rate >= 0 ? '+' : ''}${r} kg vs week ${a.wk}: inside the ${lo} to ${hi} kg target. Change nothing.`, kind: 'good' };
  }

  /* ---------- utils ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function toast(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }
  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

  /* ---------- render root ---------- */
  function render() {
    const n = dayIndex(todayStr());
    $('#daypill').textContent = n < 1 ? `Starts in ${1 - n} d` : n > TOTAL_DAYS ? `Day ${n} · beyond 100` : `Day ${n} / ${TOTAL_DAYS}`;
    renderSyncState();
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab));
    document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-' + activeTab);
    ({ today: renderToday, plan: renderPlan, progress: renderProgress, nutrition: renderNutrition, guide: renderGuide, settings: renderSettings })[activeTab]();
  }

  /* ---------- TODAY ---------- */
  function renderToday() {
    const root = $('#view-today'); root.innerHTML = '';
    const n = dayIndex(viewDate);
    const ph = phaseFor(n);
    const sess = state.sessions[viewDate];
    const planSp = splitFor(n), planSpId = splitIdFor(n);
    const sp = (sess && sess.splitId && SPLITS[sess.splitId] && sess.workoutId && SPLITS[sess.splitId].workouts[sess.workoutId]) ? SPLITS[sess.splitId] : planSp;
    const spId = Object.keys(SPLITS).find(k => SPLITS[k] === sp);
    const plannedId = plannedWorkoutId(n);
    const chosenId = sess ? (sp.workouts[sess.workoutId] ? sess.workoutId : null) : plannedId;
    const isToday = viewDate === todayStr();

    // header
    root.appendChild(el(`
      <section class="card accent">
        <div class="row between">
          <div>
            <div class="eyebrow">${isToday ? 'Today' : human(viewDate)} · ${n < 1 ? 'before start' : n > TOTAL_DAYS ? 'after day 100' : 'Day ' + n + ' of ' + TOTAL_DAYS}</div>
            <h1>${esc(ph ? ph.name : 'Countdown')}</h1>
            <p class="muted small">${ph ? esc(ph.goal) : 'Your first session is on ' + humanLong(state.settings.startDate) + '. Use the days before to buy food, set up the gym membership and log a starting weight and waist.'}</p>
          </div>
        </div>
        <div class="row">
          <button class="btn sm" id="prevDay">‹ Prev</button>
          <button class="btn sm" id="todayBtn" ${isToday ? 'disabled' : ''}>Today</button>
          <button class="btn sm" id="nextDay">Next ›</button>
          <span class="chip accent">${esc(sp.short)}</span>
          ${ph ? `<span class="chip">RPE ${esc(ph.rpe)}</span>` : ''}
        </div>
      </section>`));
    $('#prevDay').onclick = () => { viewDate = addDays(viewDate, -1); render(); };
    $('#nextDay').onclick = () => { viewDate = addDays(viewDate, 1); render(); };
    $('#todayBtn').onclick = () => { viewDate = todayStr(); render(); };

    // quick weigh-in
    const todayEntry = state.body.find(b => b.date === viewDate);
    const wcard = el(`
      <section class="card">
        <div class="row between"><h3>Morning check-in</h3><span class="chip ${todayEntry ? 'good' : ''}">${todayEntry ? 'Logged' : 'Not logged'}</span></div>
        <div class="row">
          <label class="field" style="flex:1">Weight (kg)<input type="number" step="0.1" inputmode="decimal" id="qw" value="${todayEntry ? esc(todayEntry.kg) : ''}" placeholder="${latestWeight()}"></label>
          <label class="field" style="flex:1">Waist at navel (cm)<input type="number" step="0.5" inputmode="decimal" id="qwaist" value="${todayEntry && todayEntry.waist ? esc(todayEntry.waist) : ''}" placeholder="optional"></label>
          <button class="btn primary" id="qsave" style="align-self:end">Save</button>
        </div>
        <p class="muted small">Weigh after the toilet, before food, same scale. Only the 7-day average matters.</p>
      </section>`);
    root.appendChild(wcard);
    $('#qsave').onclick = () => {
      const kg = parseFloat($('#qw').value); if (!kg) { toast('Enter a weight'); return; }
      const waist = parseFloat($('#qwaist').value) || null;
      state.body = state.body.filter(b => b.date !== viewDate); state.body.push({ date: viewDate, kg, waist }); save(true); toast('Saved'); render();
    };

    // morning timeline
    root.appendChild(morningCard(n));

    // habits
    const hb = state.habits[viewDate] || {};
    const habits = [['protein', 'Protein hit', nutrition(n).protein + ' g'], ['steps', 'Steps', '8–10k (gym walk ≈ 3k)'], ['sleep', 'Sleep', '7–9 h'], ['creatine', 'Creatine', '5 g']];
    const hcard = el(`<section class="card"><h3>Daily non-negotiables</h3><div class="habits"></div></section>`);
    habits.forEach(([k, label, sub]) => {
      const h = el(`<button class="habit ${hb[k] ? 'on' : ''}" type="button"><input type="checkbox" ${hb[k] ? 'checked' : ''} tabindex="-1"><span><b>${label}</b><small>${sub}</small></span></button>`);
      h.onclick = () => { state.habits[viewDate] = state.habits[viewDate] || {}; state.habits[viewDate][k] = !state.habits[viewDate][k]; save(); renderToday(); };
      $('.habits', hcard).appendChild(h);
    });
    root.appendChild(hcard);

    if (n < 1) return;

    // workout selector
    const optionList = (sid) => Object.keys(SPLITS[sid].workouts).map(id => `<option value="${sid}|${id}" ${sid === spId && id === chosenId ? 'selected' : ''}>${esc(SPLITS[sid].workouts[id].name)}</option>`).join('');
    const options = optionList(spId) + (planSpId !== spId ? `<optgroup label="${esc(planSp.short)} (plan)">${optionList(planSpId)}</optgroup>` : '');
    const sel = el(`
      <section class="card">
        <div class="row between">
          <div><div class="eyebrow">${plannedId ? 'Planned' : 'Rest day'}</div><h2>${plannedId ? esc(planSp.workouts[plannedId].name) : 'Recovery · walk, stretch, eat protein'}</h2></div>
          ${sess && sess.done ? '<span class="chip good">Completed</span>' : ''}
        </div>
        <label class="field">Do a different session today
          <select id="wsel"><option value="" ${!chosenId ? 'selected' : ''}>Rest / cardio only</option>${options}</select>
        </label>
        ${!plannedId ? `<p class="muted small">Optional on rest days: 20–30 min incline walk (zone 2) and your step target. Skipping the walk is fine; skipping steps is not.</p>` : ''}
      </section>`);
    root.appendChild(sel);
    $('#wsel').onchange = (e) => {
      const v = e.target.value || '';
      const cur = state.sessions[viewDate];
      if (!v) {
        if (cur && hasContent(cur)) { toast('This day has logged work or notes. It stays.'); e.target.value = cur.splitId + '|' + cur.workoutId; return; }
        if (cur) delete state.sessions[viewDate];
      } else {
        const [sid, id] = v.split('|');
        if (!SPLITS[sid] || !SPLITS[sid].workouts[id]) return;
        state.sessions[viewDate] = Object.assign({ workoutId: id, splitId: sid, sets: {}, done: false, notes: '' }, cur || {}, { workoutId: id, splitId: sid });
      }
      save(true); renderToday();
    };

    if (!chosenId) return;
    const wk = sp.workouts[chosenId];
    if (!wk) { root.appendChild(el(`<section class="card"><p class="small muted">This day was logged under a workout that no longer exists in the selected split. Pick a session above to continue.</p></section>`)); return; }
    // Nothing is written to storage until you type or tick something: viewing a day never creates a record.
    const s = state.sessions[viewDate] || { workoutId: chosenId, splitId: spId, sets: {}, done: false, notes: '' };
    // If another device's copy of this day arrived while you were typing, your typed values are merged in, never dropped.
    const commit = () => { const cur = state.sessions[viewDate]; if (cur !== s) state.sessions[viewDate] = cur ? mergeSession(Object.assign({}, s, { updatedAt: Date.now() }), cur, baseOf('sessions/' + viewDate)) : s; save(); };

    const wcardEl = el(`<section class="card"><div class="row between"><div><div class="eyebrow">${esc(wk.focus)}</div><h2>${esc(wk.name)}</h2></div>${ph && ph.setMod === 'deload' ? '<span class="chip warn">Deload: 2 sets, −20% load</span>' : ''}</div>
      <p class="muted small">Your walk in was the general warm-up. Do 2–3 min of mobility, then ramp sets on the first lift (one extra on lower days). Rest times are per set. Tap ⏱ to start the rest timer.</p></section>`);
    root.appendChild(wcardEl);

    wk.items.forEach((item, idx) => {
      const ex = EXERCISES[item.ex];
      const p = prescribe(item, ph);
      const stored = s.sets[item.ex] || [];
      const rows = stored.slice();
      while (rows.length < p.sets) rows.push({ w: '', r: '', done: false });
      const own = (i) => { const arr = s.sets[item.ex] = s.sets[item.ex] || []; while (arr.length <= i) arr.push(rows[arr.length]); };
      const lp = lastPerformance(item.ex, viewDate);
      const sug = suggestion(item.ex, item, viewDate);
      const timed = isTimed(item.reps) || item.cardio;
      const card = el(`
        <div class="exercise ${item.priority ? 'priority' : ''}">
          <div class="row between">
            <div style="min-width:0">
              <div class="ex-name">${idx + 1}. ${esc(ex.name)}</div>
              <div class="ex-meta"><span class="num"><b>${p.sets} × ${esc(item.reps)}</b></span>${item.rest ? `<span>Rest ${restLabel(item.rest)}</span>` : ''}<span>${esc(ex.m)}</span></div>
              ${item.note ? `<div class="ex-note">${esc(item.note)}</div>` : ''}
            </div>
            ${item.rest ? `<button class="btn sm" data-rest="${item.rest}" title="Start rest timer">⏱ ${restLabel(item.rest)}</button>` : ''}
          </div>
          ${lp ? `<div class="last">Last (${human(lp.date)}): <b>${lp.sets.map(x => `${x.w || '–'}×${x.r}`).join(', ')}</b></div>` : '<div class="last">First time: pick a weight you could do for the top of the range with 3 reps spare. Write it down.</div>'}
          ${sug ? `<div class="suggest" style="${sug.kind === 'down' ? 'color:var(--bad);background:var(--bad-soft)' : sug.kind === 'hold' ? 'color:var(--muted);background:var(--surface-2)' : ''}">${sug.kind === 'up' ? '▲' : sug.kind === 'down' ? '▼' : '='} ${esc(sug.text)}</div>` : ''}
          <details class="cue"><summary>Form cues &amp; substitutions</summary><div class="ex-cue">${esc(ex.cue)}<br><span class="muted">Swap for: ${esc(ex.sub.join(' · '))}</span></div></details>
          <div class="sethead"><span>Set</span><span>${timed ? 'Load / incline' : 'kg'}</span><span>${timed ? 'min / s' : 'reps'}</span><span>✓</span></div>
          <div class="sets"></div>
        </div>`);
      const setsEl = $('.sets', card);
      rows.forEach((row, i) => {
        const r = el(`<div class="setrow ${row.done ? 'done' : ''}"><span class="idx">${i + 1}</span><input type="number" step="0.5" inputmode="decimal" value="${esc(row.w)}" placeholder="${lp && lp.sets[i] ? esc(lp.sets[i].w) : ''}" aria-label="weight set ${i + 1}"><input type="number" step="1" inputmode="numeric" value="${esc(row.r)}" placeholder="${lp && lp.sets[i] ? esc(lp.sets[i].r) : ''}" aria-label="reps set ${i + 1}"><input type="checkbox" ${row.done ? 'checked' : ''} aria-label="set ${i + 1} done"></div>`);
        const [wIn, rIn, cIn] = r.querySelectorAll('input');
        wIn.oninput = () => { own(i); row.w = wIn.value; commit(); };
        rIn.oninput = () => { own(i); row.r = rIn.value; commit(); };
        cIn.onchange = () => {
          own(i); row.done = cIn.checked;
          if (row.done) { if (!row.w && wIn.placeholder) { row.w = wIn.placeholder; wIn.value = row.w; } if (!row.r && rIn.placeholder) { row.r = rIn.placeholder; rIn.value = row.r; } if (item.rest) startRest(item.rest); }
          r.classList.toggle('done', row.done); commit();
        };
        setsEl.appendChild(r);
      });
      const rb = $('[data-rest]', card); if (rb) rb.onclick = () => startRest(Number(rb.dataset.rest));
      wcardEl.appendChild(card);
    });

    const foot = el(`
      <section class="card">
        <label class="field">Session notes (energy, pain, PRs)<textarea id="notes" maxlength="2000" style="min-height:70px;font-family:inherit;font-size:.95rem">${esc(s.notes || '')}</textarea></label>
        <button class="btn ${s.done ? '' : 'primary'} block" id="finish">${s.done ? 'Mark as not finished' : 'Finish workout'}</button>
      </section>`);
    root.appendChild(foot);
    $('#notes').oninput = (e) => { s.notes = e.target.value; commit(); };
    $('#finish').onclick = () => { s.done = !s.done; s.finishedAt = s.done ? new Date().toISOString() : null; commit(); save(true); toast(s.done ? 'Workout logged. Eat.' : 'Reopened'); renderToday(); };
  }

  /* morning timeline from wake time */
  function addMin(hhmm, m) { const [h, mi] = hhmm.split(':').map(Number); const t = (h * 60 + mi + m + 1440) % 1440; return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; }
  function morningCard(n) {
    const wake = state.settings.wakeTime || '05:00';
    const walk = Number(state.settings.walkToGymMin) || 12;
    const training = n >= 1 && plannedWorkoutId(n);
    const bed = addMin(wake, -(7.75 * 60));
    const rows = training ? [
      [wake, 'Wake, toilet, weigh in before anything else. Log it above.'],
      [addMin(wake, 10), 'Pre-gym snack: banana + whey, or yoghurt + honey. Coffee. 500 ml water.'],
      [addMin(wake, 45), `Walk to the gym (${walk} min, ~1,500 steps). Brisk: this is the warm-up.`],
      [addMin(wake, 45 + walk), '2–3 min mobility, ramp sets, then the session (50–60 min).'],
      [addMin(wake, 45 + walk + 60), 'Walk home. On lower days: the 20-min incline walk here, or the 30-min route home.'],
      [addMin(wake, 45 + walk + 60 + walk + 15), 'Breakfast: 40–50 g protein, the biggest meal of the day.'],
    ] : [
      [wake, 'Wake, weigh in before anything else. Rest days are for sleeping 30 min longer if you can.'],
      [addMin(wake, 30), 'Breakfast with 40–50 g protein.'],
      ['Any time', 'Steps to 8–10k. A 30-min walk outside is the whole cardio requirement today.'],
    ];
    const c = el(`<section class="card"><div class="row between"><h3>Morning routine</h3><span class="chip warn">Lights out by ${bed}</span></div>
      <div class="tablewrap"><table class="plain"><tbody>${rows.map(r => `<tr><td class="num" style="white-space:nowrap;width:70px"><b>${esc(r[0])}</b></td><td class="small">${esc(r[1])}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">Built from your wake time (${wake}). Change it in Settings. 7.75 h of sleep is the floor that keeps the plan alive.</p></section>`);
    return c;
  }

  /* rest timer */
  function startRest(sec) {
    stopRest();
    let left = sec;
    const box = el(`<div class="rest-timer" role="timer"><span class="num" id="restLeft">${mmss(left)}</span><button type="button" id="restSkip">Skip</button></div>`);
    document.body.appendChild(box);
    $('#restSkip').onclick = stopRest;
    restTimer = setInterval(() => {
      left -= 1; const sp = $('#restLeft'); if (sp) sp.textContent = mmss(left);
      if (left <= 0) { beep(); stopRest(); toast('Rest over. Next set.'); }
    }, 1000);
  }
  function stopRest() { clearInterval(restTimer); restTimer = null; const b = $('.rest-timer'); if (b) b.remove(); }
  function mmss(s) { return `${Math.floor(s / 60)}:${pad(s % 60)}`; }
  function beep() {
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) {}
    try { const ctx = new (window.AudioContext || window.webkitAudioContext)(); const o = ctx.createOscillator(); const g = ctx.createGain(); o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.08; o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 350); } catch (e) {}
  }

  /* ---------- PLAN ---------- */
  function renderPlan() {
    const root = $('#view-plan'); root.innerHTML = '';
    const today = todayStr(); const tn = dayIndex(today);
    const endDate = dateOfDay(TOTAL_DAYS);

    // summary
    let planned = 0, done = 0, missed = 0;
    for (let d = 1; d <= Math.min(TOTAL_DAYS, tn); d++) {
      const ds = dateOfDay(d); const pw = plannedWorkoutId(d); const s = state.sessions[ds];
      if (s && s.done) done++;
      if (pw) { planned++; if (!(s && s.done) && ds < today) missed++; }
    }
    root.appendChild(el(`
      <section class="card">
        <div class="eyebrow">${human(state.settings.startDate)} → ${human(endDate)}</div>
        <h1>100-day challenge</h1>
        <div class="grid3">
          <div class="stat"><div class="label">Workouts done</div><div class="value num">${done}</div><div class="sub">${planned} planned so far</div></div>
          <div class="stat"><div class="label">Adherence</div><div class="value num">${planned ? Math.round(100 * Math.min(done, planned) / planned) : 0}%</div><div class="sub">${missed} missed</div></div>
          <div class="stat"><div class="label">Days left</div><div class="value num">${Math.max(0, TOTAL_DAYS - Math.max(0, tn))}</div><div class="sub">ends ${human(endDate)}</div></div>
        </div>
        <div class="phasebar">${PHASES.map(p => `<div class="${tn > p.to ? 'past' : tn >= p.from ? 'active' : ''}" title="${esc(p.name)}"></div>`).join('')}</div>
        <div class="legend"><span><i style="background:var(--good)"></i>done</span><span><i style="background:var(--accent-soft)"></i>planned</span><span><i style="background:var(--bad-soft)"></i>missed</span><span><i style="background:var(--warn-soft)"></i>deload</span><span><i style="border:1px solid var(--line)"></i>rest</span></div>
        <div class="cal" id="cal"></div>
        <p class="muted small">Tap a day to open it. You can log past sessions you forgot.</p>
      </section>`));
    const cal = $('#cal');
    for (let d = 1; d <= TOTAL_DAYS; d++) {
      const ds = dateOfDay(d); const pw = plannedWorkoutId(d); const s = state.sessions[ds]; const ph = phaseFor(d);
      let cls = pw ? 'planned' : 'rest';
      if (ph && ph.id === 'deload' && pw) cls = 'deload';
      if (s && s.done) cls += ' done'; else if (pw && ds < today) cls = 'missed';
      if (ds === today) cls += ' today';
      const c = el(`<button class="cell ${cls}" title="${esc(human(ds))}${pw ? ' · ' + esc(splitFor(d).workouts[pw].name) : ' · rest'}">${d}</button>`);
      c.onclick = () => { viewDate = ds; activeTab = 'today'; render(); window.scrollTo(0, 0); };
      cal.appendChild(c);
    }

    // phases
    const pc = el(`<section class="card"><h2>Phases</h2></section>`);
    PHASES.forEach(p => {
      const active = tn >= p.from && tn <= p.to;
      pc.appendChild(el(`<div class="phase ${active ? 'active' : ''}">
        <div class="row between"><h3>${esc(p.name)}</h3><span class="chip ${active ? 'accent' : ''}">Days ${p.from}–${p.to} · ${esc(SPLITS[p.split].short)} · RPE ${esc(p.rpe)}</span></div>
        <p class="small muted">${human(dateOfDay(p.from))} → ${human(dateOfDay(p.to))}</p>
        <p class="small">${esc(p.goal)}</p>
        <ul>${p.rules.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>`));
    });
    root.appendChild(pc);

    // expectations
    root.appendChild(el(`<section class="card guide"><h2>${esc(GUIDE.expectations.title)}</h2>${GUIDE.expectations.body.map(t => `<p>${esc(t)}</p>`).join('')}</section>`));

    // splits
    const sc = el(`<section class="card"><h2>Splits</h2><p class="muted small">The plan picks the split for each phase. Override it here if your week changes. <b>Current: ${state.settings.splitOverride ? esc(SPLITS[state.settings.splitOverride].name) + ' (override)' : 'following the plan'}</b></p><div class="stack" id="splits"></div></section>`);
    const sl = $('#splits', sc);
    const dayNames = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'];
    Object.keys(SPLITS).forEach(id => {
      const sp = SPLITS[id];
      const inUse = state.settings.splitOverride === id;
      const card = el(`<div class="split ${sp.recommended ? 'rec' : ''}">
        <div class="row between"><h3>${esc(sp.name)}</h3><span class="chip ${sp.recommended ? 'accent' : id === 'bro5' ? 'bad' : ''}">${esc(sp.tag)}</span></div>
        <div class="days">${sp.pattern.map((w, i) => `<span class="${w ? '' : 'off'}">${dayNames[i]} ${w ? esc(sp.workouts[w].name.split(' — ')[0]) : 'off'}</span>`).join('')}</div>
        <p>${esc(sp.why)}</p>
        <div class="row" style="margin-top:8px">
          <button class="btn sm ${inUse ? '' : 'primary'}" data-use="${id}" ${inUse ? 'disabled' : ''}>${inUse ? 'In use' : 'Use this split'}</button>
          <button class="btn sm" data-preview="${id}">Preview workouts</button>
        </div>
        <div class="preview" hidden></div></div>`);
      $('[data-use]', card).onclick = () => { state.settings.splitOverride = id; save(true); toast(sp.short + ' selected'); renderPlan(); };
      $('[data-preview]', card).onclick = () => {
        const pv = $('.preview', card); pv.hidden = !pv.hidden;
        if (!pv.innerHTML) pv.innerHTML = Object.values(sp.workouts).map(w => `<div style="margin-top:10px"><b>${esc(w.name)}</b><ul class="small" style="margin:4px 0 0;padding-left:18px">${w.items.map(it => `<li>${esc(EXERCISES[it.ex].name)} — ${it.sets}×${esc(it.reps)}</li>`).join('')}</ul></div>`).join('');
      };
      sl.appendChild(card);
    });
    if (state.settings.splitOverride) {
      const b = el(`<button class="btn block">Back to following the plan</button>`); b.onclick = () => { state.settings.splitOverride = null; save(true); renderPlan(); }; sl.appendChild(b);
    }
    root.appendChild(sc);
  }

  /* ---------- PROGRESS ---------- */
  function renderProgress() {
    const root = $('#view-progress'); root.innerHTML = '';
    const body = [...state.body].sort((a, b) => a.date < b.date ? -1 : 1);
    const start = Number(state.settings.startWeightKg);
    const latest = body.length ? Number(body[body.length - 1].kg) : start;
    const firstWaist = body.find(b => b.waist); const lastWaist = [...body].reverse().find(b => b.waist);
    const advice = trendAdvice();

    root.appendChild(el(`
      <section class="card">
        <h1>Progress</h1>
        <div class="grid3">
          <div class="stat"><div class="label">Start</div><div class="value num">${start.toFixed(1)}</div><div class="sub">kg</div></div>
          <div class="stat"><div class="label">Latest</div><div class="value num">${latest.toFixed(1)}</div><div class="sub">${(latest - start >= 0 ? '+' : '') + (latest - start).toFixed(1)} kg</div></div>
          <div class="stat"><div class="label">Waist</div><div class="value num">${lastWaist ? Number(lastWaist.waist).toFixed(1) : '–'}</div><div class="sub">${firstWaist && lastWaist && firstWaist !== lastWaist ? (lastWaist.waist - firstWaist.waist >= 0 ? '+' : '') + (lastWaist.waist - firstWaist.waist).toFixed(1) + ' cm' : 'cm at navel'}</div></div>
          <div class="stat"><div class="label">Goal</div><div class="value num">${Number(state.settings.goalKg).toFixed(0)}</div><div class="sub">kg lean, 6–9 months</div></div>
        </div>
        <div class="chip ${advice.kind === 'good' ? 'good' : advice.kind === 'warn' ? 'warn' : ''}" style="white-space:normal;align-items:flex-start;padding:8px 10px">${esc(advice.text)}</div>
      </section>`));

    // chart
    const cc = el(`<section class="card"><div class="row between"><h3>Body weight</h3><span class="muted small">dots = daily · line = 7-day average</span></div><div class="chart-wrap" id="chart"></div></section>`);
    root.appendChild(cc);
    drawChart($('#chart', cc), body);

    // log form
    const lf = el(`<section class="card"><h3>Add or edit a weigh-in</h3>
      <div class="row">
        <label class="field">Date<input type="date" id="bdate" value="${todayStr()}"></label>
        <label class="field">Weight (kg)<input type="number" step="0.1" inputmode="decimal" id="bkg"></label>
        <label class="field">Waist (cm)<input type="number" step="0.5" inputmode="decimal" id="bwaist"></label>
        <button class="btn primary" id="badd" style="align-self:end">Save</button>
      </div></section>`);
    root.appendChild(lf);
    $('#badd').onclick = () => {
      const date = $('#bdate').value, kg = parseFloat($('#bkg').value), waist = parseFloat($('#bwaist').value) || null;
      if (!date || !kg) { toast('Date and weight needed'); return; }
      state.body = state.body.filter(b => b.date !== date); state.body.push({ date, kg, waist }); save(true); renderProgress();
    };

    // weekly table
    const wks = weeklyAverages();
    if (wks.length) {
      const tw = el(`<section class="card"><h3>Weekly averages</h3><div class="tablewrap"><table class="plain"><thead><tr><th>Week</th><th>Phase</th><th class="r">Avg kg</th><th class="r">Δ week</th><th class="r">Target</th><th class="r">Waist</th></tr></thead><tbody></tbody></table></div></section>`);
      const tb = $('tbody', tw);
      wks.forEach((w, i) => {
        const prev = wks[i - 1]; const d = prev ? w.avg - prev.avg : null;
        const [lo, hi] = w.phase.rateTarget; const ok = d == null ? null : d >= lo && d <= hi;
        tb.appendChild(el(`<tr><td class="num">${w.wk}</td><td class="small">${esc(w.phase.name.replace(/Phase \d · /, ''))}</td><td class="r num">${w.avg.toFixed(2)}</td><td class="r num">${d == null ? '–' : `<span class="chip ${ok ? 'good' : 'warn'}">${d >= 0 ? '+' : ''}${d.toFixed(2)}</span>`}</td><td class="r num small">${lo} to ${hi}</td><td class="r num">${w.waist ? w.waist.toFixed(1) : '–'}</td></tr>`));
      });
      root.appendChild(tw);
    }

    // PRs
    const prs = {};
    Object.keys(state.sessions).forEach(d => {
      const s = state.sessions[d]; if (!s.sets) return;
      Object.keys(s.sets).forEach(ex => s.sets[ex].forEach(set => {
        const w = parseFloat(set.w), r = parseInt(set.r, 10); if (!w || !r) return;
        const e1 = w * (1 + r / 30);
        if (!prs[ex] || e1 > prs[ex].e1) prs[ex] = { e1, w, r, date: d };
      }));
    });
    const list = Object.keys(prs).sort((a, b) => prs[b].e1 - prs[a].e1);
    const pc = el(`<section class="card"><h3>Personal bests (estimated 1RM)</h3>${list.length ? '<div class="tablewrap"><table class="plain"><thead><tr><th>Exercise</th><th class="r">Best set</th><th class="r">e1RM</th><th>Date</th></tr></thead><tbody></tbody></table></div>' : '<p class="muted small">Log sets with weight and reps and your bests appear here.</p>'}</section>`);
    if (list.length) { const tb = $('tbody', pc); list.forEach(ex => tb.appendChild(el(`<tr><td>${esc(EXERCISES[ex] ? EXERCISES[ex].name : ex)}</td><td class="r num">${prs[ex].w} × ${prs[ex].r}</td><td class="r num">${prs[ex].e1.toFixed(1)}</td><td class="small">${human(prs[ex].date)}</td></tr>`))); }
    root.appendChild(pc);

    // workout history: every logged session, newest first
    const hist = Object.keys(state.sessions).filter(d => state.sessions[d] && (state.sessions[d].done || hasLoggedSets(state.sessions[d]))).sort().reverse();
    const hc = el(`<section class="card"><div class="row between"><h3>Workout history</h3><span class="chip">${hist.length} logged</span></div>${hist.length ? '<div class="stack" id="hist"></div>' : '<p class="muted small">Every session you log appears here with its weights and reps. Nothing yet.</p>'}</section>`);
    hist.forEach(d => {
      const ss = state.sessions[d];
      const lines = Object.keys(ss.sets || {}).map(ex => { const done = ss.sets[ex].filter(x => x.w !== '' || x.r !== ''); return done.length ? `<li><b>${esc(EXERCISES[ex] ? EXERCISES[ex].name : ex)}</b> <span class="num">${done.map(x => `${x.w || '–'}×${x.r || '–'}`).join(', ')}</span></li>` : ''; }).join('');
      const item = el(`<div class="exercise" style="padding-top:10px"><div class="row between"><div><div class="eyebrow">${human(d)} · Day ${dayIndex(d)}</div><b>${esc(workoutName(ss))}</b></div><span class="chip ${ss.done ? 'good' : 'warn'}">${ss.done ? 'Finished' : 'Not finished'}</span></div>${lines ? `<ul class="small" style="margin:6px 0 0;padding-left:18px">${lines}</ul>` : ''}${ss.notes ? `<p class="small muted" style="margin-top:4px">${esc(ss.notes)}</p>` : ''}<button class="btn sm" style="margin-top:8px" data-open="${d}">Open day</button></div>`);
      $('[data-open]', item).onclick = () => { viewDate = d; activeTab = 'today'; render(); window.scrollTo(0, 0); };
      $('#hist', hc).appendChild(item);
    });
    root.appendChild(hc);

    // measurements reminder
    root.appendChild(el(`<section class="card"><h3>Measure on Day 1, 50 and 100</h3><p class="small muted">Cold flexed upper arm, chest at nipple line, waist at navel, same tape, morning. Take front, side and back photos in the same light. Progress you cannot see week to week becomes obvious over 50 days.</p></section>`));
  }

  function drawChart(wrap, body) {
    wrap.innerHTML = '';
    if (body.length < 2) { wrap.innerHTML = '<p class="muted small">Two or more weigh-ins draw the chart.</p>'; return; }
    const W = 640, H = 240, L = 44, R = 16, T = 16, B = 30;
    const startD = state.settings.startDate;
    const xs = body.map(b => diffDays(startD, b.date));
    const minX = Math.min(0, ...xs), maxX = Math.max(TOTAL_DAYS - 1, ...xs);
    const ys = body.map(b => Number(b.kg));
    // 7-day moving average by date window
    const ma = body.map((b, i) => { const win = body.filter(o => diffDays(o.date, b.date) >= 0 && diffDays(o.date, b.date) < 7); return win.reduce((s, o) => s + Number(o.kg), 0) / win.length; });
    const minY = Math.floor(Math.min(...ys, ...ma) - 0.5), maxY = Math.ceil(Math.max(...ys, ...ma) + 0.5);
    const x = v => L + (v - minX) / (maxX - minX || 1) * (W - L - R);
    const y = v => T + (maxY - v) / (maxY - minY || 1) * (H - T - B);
    const ticks = []; const step = (maxY - minY) <= 4 ? 1 : (maxY - minY) <= 10 ? 2 : 5;
    for (let v = minY; v <= maxY; v += step) ticks.push(v);
    const line = ma.map((v, i) => `${i ? 'L' : 'M'}${x(xs[i]).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = `${line} L${x(xs[xs.length - 1]).toFixed(1)},${y(minY)} L${x(xs[0]).toFixed(1)},${y(minY)} Z`;
    const dayTicks = [1, 25, 50, 75, 100];
    const svg = el(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Body weight over the 100 days">
      ${ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="var(--font-body)">${v}</text>`).join('')}
      ${dayTicks.map(d => `<text x="${x(d - 1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)" font-family="var(--font-body)">D${d}</text>`).join('')}
      <path d="${area}" fill="var(--accent)" opacity="0.08"/>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${body.map((b, i) => `<circle cx="${x(xs[i])}" cy="${y(ys[i])}" r="3" fill="var(--surface)" stroke="var(--muted)" stroke-width="1.5"/>`).join('')}
      <circle cx="${x(xs[xs.length - 1])}" cy="${y(ma[ma.length - 1])}" r="4.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>
      <text x="${Math.min(x(xs[xs.length - 1]) + 8, W - R - 40)}" y="${y(ma[ma.length - 1]) - 8}" font-size="12" font-weight="700" fill="var(--fg)" font-family="var(--font-body)">${ma[ma.length - 1].toFixed(1)} kg</text>
    </svg>`);
    wrap.appendChild(svg);
    const tip = el(`<div class="chart-tip" hidden></div>`); wrap.appendChild(tip);
    svg.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect(); const px = (e.clientX - rect.left) / rect.width * W;
      let best = 0; xs.forEach((v, i) => { if (Math.abs(x(v) - px) < Math.abs(x(xs[best]) - px)) best = i; });
      tip.hidden = false; tip.textContent = `${human(body[best].date)} · ${ys[best].toFixed(1)} kg · avg ${ma[best].toFixed(1)}`;
      tip.style.left = (x(xs[best]) / W * 100) + '%'; tip.style.top = (y(ys[best]) / H * 100) + '%';
    });
    svg.addEventListener('mouseleave', () => tip.hidden = true);
  }

  /* ---------- NUTRITION ---------- */
  function renderNutrition() {
    const root = $('#view-nutrition'); root.innerHTML = '';
    const n = Math.max(1, dayIndex(todayStr()));
    const nu = nutrition(n);
    const advice = trendAdvice();
    root.appendChild(el(`
      <section class="card accent">
        <div class="eyebrow">${esc(nu.phase.name)} · based on ${nu.weight.toFixed(1)} kg</div>
        <h1>Eat to recomp</h1>
        <div class="grid2">
          <div class="stat"><div class="label">Calories / day</div><div class="value num">${nu.kcal}</div><div class="sub">maintenance ≈ ${nu.tdee} kcal</div></div>
          <div class="stat"><div class="label">Protein</div><div class="value num">${nu.protein} g</div><div class="sub">2.1 g per kg, every day</div></div>
          <div class="stat"><div class="label">Fat</div><div class="value num">${nu.fat} g</div><div class="sub">hormones, satiety</div></div>
          <div class="stat"><div class="label">Carbs</div><div class="value num">${nu.carbs} g</div><div class="sub">fuel training, adjust here</div></div>
        </div>
        <div class="chip ${advice.kind === 'good' ? 'good' : advice.kind === 'warn' ? 'warn' : ''}" style="white-space:normal;align-items:flex-start;padding:8px 10px">${esc(advice.text)}</div>
      </section>`));

    const ph = el(`<section class="card"><h3>Calories by phase</h3><div class="tablewrap"><table class="plain"><thead><tr><th>Phase</th><th>Days</th><th class="r">kcal</th><th class="r">Weekly target</th></tr></thead><tbody>
      ${PHASES.map(p => { const k = Math.round((nu.tdee + p.kcalOffset) / 50) * 50; return `<tr><td>${esc(p.name)}</td><td class="num small">${p.from}–${p.to}</td><td class="r num">${k}</td><td class="r num small">${p.rateTarget[0]} to ${p.rateTarget[1] >= 0 ? '+' + p.rateTarget[1] : p.rateTarget[1]} kg</td></tr>`; }).join('')}
      </tbody></table></div>
      <p class="muted small">Estimates from the Mifflin-St Jeor equation (BMR ${nu.bmr} kcal × activity ${state.settings.activity}). Your real maintenance shows up in the weekly average: the app corrects the number using the trend, not the formula.</p></section>`);
    root.appendChild(ph);

    root.appendChild(el(`<section class="card"><h3>Rules that do the work</h3><ol class="small" style="margin:0;padding-left:18px">
      <li>Protein target hit every day. Spread over 4–5 meals of 30–45 g.</li>
      <li>Calories hit on average over the week. One meal out does not matter; a weekend that is +2,000 kcal does.</li>
      <li>Change calories only by 150 at a time and only after two weeks of weekly averages say so.</li>
      <li>Train days and rest days: same protein, same calories. Simpler and it works.</li>
      <li>Fibre 30 g+, 3 litres of water, vegetables with lunch and dinner. This is what keeps you full in a deficit.</li>
      <li>Alcohol: zero in Phase 1, max 2 drinks a week after. It blocks muscle protein synthesis for about a day and ruins sleep.</li>
      <li>Creatine monohydrate 5 g a day, any time. Expect +1–2 kg water in week 1; do not panic.</li>
    </ol></section>`));

    const meals = el(`<section class="card"><h3>Example day (≈${MEALS.reduce((s, m) => s + m.kcal, 0)} kcal · ${MEALS.reduce((s, m) => s + m.p, 0)} g protein)</h3><div class="tablewrap"><table class="plain"><thead><tr><th>Meal</th><th>Food</th><th class="r">Protein</th><th class="r">kcal</th></tr></thead><tbody>
      ${MEALS.map(m => `<tr><td>${esc(m.when)}</td><td class="small">${esc(m.food)}</td><td class="r num">${m.p} g</td><td class="r num">${m.kcal}</td></tr>`).join('')}
    </tbody></table></div><p class="muted small">Scale rice, oats, potatoes and oil up or down to hit the phase calories. Keep the protein foods fixed.</p></section>`);
    root.appendChild(meals);

    root.appendChild(el(`<section class="card guide"><h2>${esc(GUIDE.fatloss.title)}</h2>${GUIDE.fatloss.body.map(t => `<p>${esc(t)}</p>`).join('')}</section>`));
  }

  /* ---------- GUIDE ---------- */
  function renderGuide() {
    const root = $('#view-guide'); root.innerHTML = '';
    root.appendChild(el(`<section class="card"><h1>How to train</h1><p class="muted small">Read once in week 1, then come back when something stalls.</p></section>`));
    root.appendChild(el(`<section class="card guide"><h2>Warm-up (10 minutes, every session)</h2><ol>${GUIDE.warmup.map(t => `<li>${esc(t)}</li>`).join('')}</ol></section>`));
    root.appendChild(el(`<section class="card guide"><h2>Training at 6 AM</h2><ul>${GUIDE.morning.map(t => `<li>${esc(t)}</li>`).join('')}</ul></section>`));
    root.appendChild(el(`<section class="card guide"><h2>Progression: how the weights go up</h2><ul>${GUIDE.progression.map(t => `<li>${esc(t)}</li>`).join('')}</ul></section>`));
    root.appendChild(el(`<section class="card guide"><h2>RPE and reps in reserve</h2><ul>${GUIDE.rpe.map(t => `<li>${esc(t)}</li>`).join('')}</ul></section>`));
    root.appendChild(el(`<section class="card guide"><h2>${esc(GUIDE.chest.title)}</h2>${GUIDE.chest.body.map(t => `<p>${esc(t)}</p>`).join('')}</section>`));
    root.appendChild(el(`<section class="card guide"><h2>${esc(GUIDE.biceps.title)}</h2>${GUIDE.biceps.body.map(t => `<p>${esc(t)}</p>`).join('')}</section>`));
    root.appendChild(el(`<section class="card guide"><h2>Which split, and why Upper/Lower first</h2>
      <p>Research comparing splits agrees on one thing: when weekly sets are equal, how you package them matters far less than whether you show up. Training a muscle twice a week has an edge over once a week, and four days is the schedule most people actually keep for months.</p>
      <p>So the order is: Upper/Lower 4-day until Day 56, then Upper/Lower/Push/Pull/Legs 5-day for the final six weeks when you can recover from more volume. PPL 6-day is there if you ever want it. The body-part split is listed so you know why it is not the pick.</p>
      <p>Switch only in Settings or on the Plan tab. Changing splits every two weeks is the fastest way to make no progress.</p></section>`));
    root.appendChild(el(`<section class="card guide"><h2>When to see a professional</h2>
      <ul><li>Sharp joint pain (not muscle burn) that persists past two sessions: see a physio, swap the exercise in the meantime.</li>
      <li>Chest tissue that stays firm under the nipple after Phase 2: GP or endocrinologist for a gynecomastia check.</li>
      <li>Weight dropping more than 1 kg a week for two weeks despite eating the plan: see a doctor; it is not normal.</li></ul>
      <p class="muted small">This app is a training and nutrition plan written for a healthy 21-year-old. It is not medical advice.</p></section>`));
    const ex = el(`<section class="card guide"><h2>Exercise library</h2><div class="stack" id="exlib"></div></section>`);
    Object.keys(EXERCISES).forEach(id => { const e = EXERCISES[id]; $('#exlib', ex).appendChild(el(`<details class="cue"><summary><b>${esc(e.name)}</b> <span class="muted">· ${esc(e.m)}</span></summary><div class="ex-cue">${esc(e.cue)}<br><span class="muted">Swap for: ${esc(e.sub.join(' · '))}</span></div></details>`)); });
    root.appendChild(ex);
  }

  /* ---------- SETTINGS ---------- */
  function renderSettings() {
    const root = $('#view-settings'); root.innerHTML = '';
    const s = state.settings;
    const f = el(`<section class="card"><h1>Settings</h1>
      <div class="grid2">
        <label class="field">Day 1 (first training day)<input type="date" id="sStart" value="${esc(s.startDate)}"></label>
        <label class="field">Height (cm)<input type="number" id="sH" value="${esc(s.heightCm)}"></label>
        <label class="field">Age<input type="number" id="sA" value="${esc(s.age)}"></label>
        <label class="field">Starting weight (kg)<input type="number" step="0.1" id="sW" value="${esc(s.startWeightKg)}"></label>
        <label class="field">Goal weight (kg)<input type="number" step="0.5" id="sG" value="${esc(s.goalKg)}"></label>
        <label class="field">Activity multiplier<select id="sAct">
          <option value="1.4" ${s.activity == 1.4 ? 'selected' : ''}>1.4 · desk job, under 6k steps</option>
          <option value="1.5" ${s.activity == 1.5 ? 'selected' : ''}>1.5 · 4–5 gym days + 8–10k steps</option>
          <option value="1.6" ${s.activity == 1.6 ? 'selected' : ''}>1.6 · on your feet all day + gym</option>
          <option value="1.75" ${s.activity == 1.75 ? 'selected' : ''}>1.75 · physical job + gym</option></select></label>
        <label class="field">Wake time on gym days<input type="text" id="sWake" value="${esc(s.wakeTime || '05:00')}" placeholder="05:00" pattern="[0-2][0-9]:[0-5][0-9]"></label>
        <label class="field">Walk to gym (minutes, one way)<input type="number" id="sWalk" value="${esc(s.walkToGymMin || 12)}"></label>
        <label class="field">Split<select id="sSplit"><option value="">Follow the 100-day plan</option>${Object.keys(SPLITS).map(k => `<option value="${k}" ${s.splitOverride === k ? 'selected' : ''}>${esc(SPLITS[k].name)}</option>`).join('')}</select></label>
      </div>
      <button class="btn primary" id="sSave">Save settings</button></section>`);
    root.appendChild(f);
    $('#sSave').onclick = () => {
      s.startDate = $('#sStart').value || s.startDate; s.heightCm = Number($('#sH').value) || s.heightCm; s.age = Number($('#sA').value) || s.age;
      s.startWeightKg = Number($('#sW').value) || s.startWeightKg; s.goalKg = Number($('#sG').value) || s.goalKg; s.activity = Number($('#sAct').value) || s.activity;
      const wt = $('#sWake').value.trim(); if (/^\d{1,2}:\d{2}$/.test(wt)) s.wakeTime = wt.padStart(5, '0');
      s.walkToGymMin = Number($('#sWalk').value) || s.walkToGymMin;
      s.splitOverride = $('#sSplit').value || null; save(true); toast('Saved'); render();
    };

    const sy = el(`<section class="card"><h3>Where your data is</h3>
      <p class="small" id="syncdetail"></p>
      <div class="row"><button class="btn sm" id="syncNow" ${db ? '' : 'disabled'}>Sync now</button><span class="chip" id="syncchip"></span></div>
      <p class="muted small">Inside claude.ai this page saves every change to your account's database as well as the device, so the same logs show on phone and laptop. Opened as a plain file or from GitHub Pages it saves on the device only.</p></section>`);
    root.appendChild(sy);
    $('#syncNow', sy).onclick = () => { if (dbNs && !db) scheduleMerge(0); save(true); toast('Syncing'); };
    renderSyncState();

    const io = el(`<section class="card"><h3>Backup and restore</h3>
      <p class="muted small">Your data lives only in this browser. Copy the backup text somewhere safe once a week (notes app, email to yourself). Paste it back here on a new phone.</p>
      <textarea id="ioText" placeholder="Backup text appears here"></textarea>
      <div class="row"><button class="btn" id="ioExport">Create backup</button><button class="btn" id="ioCopy">Copy</button><button class="btn" id="ioImport">Restore from text</button></div></section>`);
    root.appendChild(io);
    $('#ioExport').onclick = () => { $('#ioText').value = JSON.stringify(state); toast('Backup ready. Tap Copy.'); };
    $('#ioCopy').onclick = () => {
      const ta = $('#ioText'); if (!ta.value) ta.value = JSON.stringify(state);
      const fallback = () => { ta.focus(); ta.select(); toast('Select all and copy'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(() => toast('Copied'), fallback); else fallback();
    };
    $('#ioImport').onclick = () => {
      try {
        const obj = JSON.parse($('#ioText').value); if (!obj || !obj.settings) throw new Error('bad');
        const incoming = Object.assign({ sessions: {}, body: [], habits: {} }, obj); incoming.settings = Object.assign({}, DEFAULT_SETTINGS, obj.settings);
        // merge instead of replace: a backup never erases newer logs on this device, and nothing in it is lost either
        const inc = sanitize(incoming);
        const theirs = new Map();
        Object.keys(inc.sessions).forEach(d => theirs.set('sessions/' + d, inc.sessions[d]));
        inc.body.forEach(b => theirs.set('body/' + b.date, b));
        Object.keys(inc.habits).forEach(d => theirs.set('habits/' + d, inc.habits[d]));
        theirs.set('settings/main', inc.settings);
        let applied = 0;
        theirs.forEach((r, path) => { if (!r.updatedAt) r.updatedAt = LEGACY_TS; const l = records().get(path); const res = reconcile(path, l, r); if (res.apply || (!l && res.body)) { const body = res.body || r; const [col, id] = path.split('/'); if (col === 'sessions') state.sessions[id] = body; else if (col === 'habits') state.habits[id] = body; else if (col === 'body') { state.body = state.body.filter(x => x.date !== id); state.body.push(Object.assign({ date: id }, body)); } else if (col === 'settings') state.settings = Object.assign({}, DEFAULT_SETTINGS, body); applied++; } });
        save(true); toast(`Restored: ${applied} record${applied === 1 ? '' : 's'} added or merged`); render();
      }
      catch (e) { toast('That text is not a valid backup'); }
    };

    const rs = el(`<section class="card"><h3>Start over</h3><p class="muted small">Deletes every logged workout, weigh-in and habit from this device <b>and from your account, on every device</b>. Settings stay. A backup of everything is placed in the box above first.</p>
      <button class="btn danger" id="rs1">Delete all logs</button>
      <div class="confirm" id="rsBox" hidden><p class="small"><b>This cannot be undone.</b> Type <b>DELETE</b> to confirm.</p><div class="row" style="margin-top:8px"><input type="text" id="rsWord" placeholder="DELETE" style="max-width:140px" autocomplete="off"><button class="btn danger" id="rs2" disabled>Delete everything</button><button class="btn" id="rs3">Cancel</button></div></div></section>`);
    root.appendChild(rs);
    $('#rs1').onclick = () => { $('#rsBox').hidden = false; $('#rsWord').focus(); };
    $('#rs3').onclick = () => { $('#rsBox').hidden = true; };
    $('#rsWord').oninput = (e) => { $('#rs2').disabled = e.target.value.trim() !== 'DELETE'; };
    $('#rs2').onclick = () => {
      if ($('#rsWord').value.trim() !== 'DELETE') return;
      const backup = JSON.stringify(state);
      state.resetAt = Date.now(); state.sessions = {}; state.body = []; state.habits = {}; pending.forEach((v, k) => { if (!/^(settings|meta)\//.test(k)) pending.delete(k); });
      save(true); toast('Logs deleted. Backup text is in the box above.'); render();
      const ta = $('#ioText'); if (ta) ta.value = backup;
    };

    root.appendChild(el(`<section class="card"><h3>About</h3><p class="small muted">Rebuild 100 is a self-contained web app: open it on your phone, add it to the home screen, and it works offline after the first load. Training plan: Upper/Lower 4-day → U/L + Push/Pull/Legs 5-day, with upper-chest and biceps priority and a recomposition nutrition plan.</p></section>`));
  }

  /* ---------- boot ---------- */
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => { activeTab = t.dataset.tab; render(); window.scrollTo(0, 0); });
  try { const h = location.hash.replace('#', ''); if (['today', 'plan', 'progress', 'nutrition', 'guide', 'settings'].includes(h)) activeTab = h; } catch (e) {}
  render();
  connectDb();
})();
