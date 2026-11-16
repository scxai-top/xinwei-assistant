const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { coordinator } = require('./coordinator.cjs');
const { fixture } = require('./helpers.cjs');
const globals = {}; vm.runInNewContext(fs.readFileSync('diagnostic-archive.js', 'utf8'), globals);
const { merge, bytes } = globals.XinweiDiagnosticArchive;
const KEY = 'xinwei-job-v3', DIAG = 'xinwei-diagnostics-v1';
const URL = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/c/video/v?classId=class';
const report = (runId, start, count, type = 'info', attempt = 0) => ({ runId, logs: Array.from({ length: count }, (_, i) => ({
  runId, id: `${runId}:${start + i}`, sequence: start + i, time: start + i, text: '中文长字段😀'.repeat(80),
  phase: 'course', courseKey: 'c', eventCode: 'error', type, attempt,
})), documents: [], records: {}, limits: {}, incident: { time: start, error: { message: '中'.repeat(3000) } } });

test('UTF-8 archive enforces all count and byte bounds, deduplicates replay and separates attempt errors', () => {
  let saved;
  for (let r = 0; r < 5; r++) {
    for (let batch = 0; batch < 6; batch++) {
      const data = report(`r${r}`, batch * 300 + 1, 300);
      saved = merge(saved, data, { id: `r${r}`, state: 'finished', entries: [], cursor: 0 });
      assert.equal(bytes(saved), Buffer.byteLength(JSON.stringify(saved)));
      assert.ok(saved.archive.history.length <= 1000);
      assert.ok(bytes(saved.archive.history) <= 1024 * 1024);
      assert.ok(bytes(saved) <= 2 * 1024 * 1024);
      assert.ok(saved.archive.incidents.length <= 10);
      assert.ok(saved.archive.incidents.every(item => bytes(item) <= 20 * 1024));
      assert.ok(saved.archive.rounds.length <= 3);
      const before = JSON.stringify(saved.archive);
      saved = merge(saved, data, { id: `r${r}`, state: 'finished', entries: [], cursor: 0 });
      assert.equal(JSON.stringify(saved.archive), before);
    }
  }
  assert.ok(saved.archive.clipped.history > 0);
  assert.ok(saved.archive.clipped.incidents > 0);
  assert.ok(saved.archive.clipped.rounds > 0);
  let errors = merge(null, report('errors', 1, 50, 'err', 0));
  assert.equal(errors.archive.history.length, 1); assert.equal(errors.archive.history[0].count, 50);
  errors = merge(errors, report('errors', 51, 50, 'err', 1));
  assert.equal(errors.archive.history.length, 2); assert.equal(errors.archive.history[1].count, 50);
});

test('real checkpoint/log path throttles history writes, keeps job 300/UI 80, and export is read-only', async () => {
  let saves = 0;
  const c = coordinator({ beforeStorageSet(area, values) { if (area === 'local' && values[DIAG]) saves++; } });
  const tab = c.addTab(URL);
  let job = (await c.request(tab, 'page', 'start', { scope: 'single', title: '课程' })).job;
  const auth = () => ({ runId: job.runId, generation: job.generation });
  const startSaves = saves;
  for (let i = 0; i < 330; i++) {
    job = (await c.request(tab, 'page', 'log', { ...auth(), id: `log:${i}`, text: '中'.repeat(400), type: 'info' })).job;
  }
  assert.equal(saves, startSaves);
  assert.equal(job.logs.length, 300);
  assert.equal(job.archive, undefined);
  job = (await c.request(tab, 'page', 'log', { ...auth(), id: 'urgent', text: '故障', type: 'err' })).job;
  assert.equal(saves, startSaves + 1);
  const before = JSON.stringify(c.storage);
  const response = await c.request(tab, 'reader', 'export-diagnostics');
  assert.equal(response.ok, true); assert.equal(JSON.stringify(c.storage), before);
  assert.ok(response.diagnostics.archive.history.length > 0);
  const f = fixture([]);
  try {
    f.api.renderLogEntries(job.logs);
    assert.equal(f.api.state.logBox.querySelectorAll('.wb-log-entry').length, 80);
  } finally { f.dom.window.close(); }
  assert.equal(c.storage.session[KEY].running, true);
});

test('optional archive write failure leaves running executor untouched', async () => {
  const c = coordinator({ beforeStorageSet(area, values) {
    if (area === 'local' && values[DIAG]) throw new Error('diagnostic quota');
  } });
  const tab = c.addTab(URL);
  const response = await c.request(tab, 'page', 'start', { scope: 'single', title: '课程' });
  assert.equal(response.ok, true); assert.equal(response.job.running, true);
  const exported = await c.request(tab, 'reader', 'export-diagnostics');
  assert.match(exported.diagnostics.storageWarning, /诊断/);
});

test('legacy mirror migration preserves prior logs and massive round summaries stay within total budget', () => {
  const legacy = report('old', 1, 3);
  const migrated = merge(legacy, report('new', 1, 2));
  assert.equal(migrated.archive.history.filter(log => log.runId === 'old').length, 3);
  assert.equal(migrated.archive.history.filter(log => log.runId === 'new').length, 2);
  const outer = { id: 'large-round', state: 'finished', entries: Array.from({ length: 1000 }, (_, i) => ({
    key: String(i), title: '中文课程'.repeat(200), state: 'failed', reentries: 1
  })) };
  const sizeBefore = outer.entries.length;
  const bounded = merge(migrated, report('new', 3, 200), outer);
  assert.ok(bytes(bounded) <= 2 * 1024 * 1024);
  assert.equal(outer.entries.length, sizeBefore, 'diagnostic pruning cannot mutate execution results');
  assert.ok(bounded.archive.clipped.rounds > 0);
});
