const test = require('node:test');
const assert = require('node:assert/strict');
const { coordinator } = require('./coordinator.cjs');
const { homeFixture, homeCardContent, waitFor } = require('./helpers.cjs');
const ROOT = 'https://www.beeline-ai.com/';
const AGENT = 'https://www.beeline-ai.com/stu/agent';
const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
const KEY = 'xinwei-job-v3';
const auth = job => ({ runId: job.runId, generation: job.generation, resetEpoch: job.resetEpoch || 0 });
async function startFromFinished(outer = false) {
  const c = coordinator(), id = c.addTab(HOME);
  let r = await c.request(id, 'old-list', 'start', { scope: 'all', workflow: 'manual' });
  r = await c.request(id, 'old-list', 'scan-result', { ...auth(r.job), candidates: [
    { key: 'old', title: '已有课程', page: 1, order: 0, timetablePercent: 80 }
  ] });
  assert.equal(r.job.phase, 'selection');
  c.tabs.get(id).url = ROOT;
  if (outer) c.advanceTime(310000);
  r = await c.request(id, 'root-page', outer ? 'outer-start' : 'start', { ...auth(r.job), scope: 'all', workflow: 'manual', restart: true });
  assert.equal(r.ok, true); assert.equal(r.job.phase, 'go-agent');
  // Navigation has been issued but the departing document is still observable.
  c.tabs.get(id).url = ROOT; c.tabs.get(id).pendingUrl = AGENT;
  return { c, id, job: r.job };
}

test('Edge reproduction: departing root hello during own go-agent navigation does not pause list reload', async () => {
  const f = await startFromFinished();
  const before = f.job;
  for (let i = 0; i < 3; i++) {
    const r = await f.c.request(f.id, 'root-page', 'hello', auth(before), ROOT);
    assert.equal(r.ok, true); assert.equal(r.job.phase, 'go-agent'); assert.equal(r.job.running, true);
    assert.equal(r.job.ownerInstance, null); assert.equal(r.job.generation, before.generation);
    assert.equal(r.job.agentDeadline, before.agentDeadline);
  }
  assert.equal(f.c.navigation.length, 1);
  f.c.tabs.get(f.id).url = AGENT; delete f.c.tabs.get(f.id).pendingUrl;
  const r = await f.c.request(f.id, 'agent-page', 'hello', auth(before), AGENT);
  assert.equal(r.job.phase, 'entry-home'); assert.equal(r.job.running, true);
  assert.equal(r.job.ownerInstance, 'agent-page'); assert.equal(r.job.generation, before.generation + 1);
  assert.equal(r.job.logs.some(l => l.eventCode === 'task-paused'), false);
});

test('entry handoff still rejects departing DOM claiming destination and requires explicit continue on genuine root refresh', async () => {
  const f = await startFromFinished();
  f.c.tabs.get(f.id).url = AGENT; delete f.c.tabs.get(f.id).pendingUrl;
  let r = await f.c.request(f.id, 'root-page', 'hello', auth(f.job), AGENT);
  assert.equal(r.job.phase, 'go-agent'); assert.equal(r.job.ownerInstance, null);
  f.c.tabs.get(f.id).url = ROOT;
  r = await f.c.request(f.id, 'actually-refreshed-root', 'hello', auth(f.job), ROOT);
  assert.equal(r.job.phase, 'paused'); assert.equal(r.job.running, false); assert.match(r.job.reason, /刷新/);
  f.c.tabs.get(f.id).url = AGENT;
  const late = await f.c.request(f.id, 'agent-page', 'hello', auth(f.job), AGENT);
  assert.equal(late.job.phase, 'paused'); assert.equal(f.c.navigation.length, 1);
});

test('pause during entry handoff beats departing hello and arriving document without a second navigation', async () => {
  const f = await startFromFinished();
  let r = await f.c.request(f.id, 'root-page', 'pause', auth(f.job), ROOT);
  assert.equal(r.job.phase, 'paused');
  const generation = r.job.generation;
  r = await f.c.request(f.id, 'root-page', 'hello', auth(f.job), ROOT);
  f.c.tabs.get(f.id).url = AGENT; delete f.c.tabs.get(f.id).pendingUrl;
  r = await f.c.request(f.id, 'agent-page', 'hello', auth(f.job), AGENT);
  assert.equal(r.job.phase, 'paused'); assert.equal(r.job.generation, generation);
  assert.equal(r.job.running, false); assert.equal(f.c.navigation.length, 1);
});

test('root reload survives departing hello, then original agent control scans six courses and waits', { timeout: 15000 }, async () => {
  const f = await startFromFinished();
  const r = await f.c.request(f.id, 'root-page', 'hello', auth(f.job), ROOT);
  assert.equal(r.job.phase, 'go-agent');
  f.c.tabs.get(f.id).url = AGENT; delete f.c.tabs.get(f.id).pendingUrl;
  const page = homeFixture(Array.from({ length: 6 }, (_, i) => homeCardContent(`课程${i + 1}`)), {
    url: AGENT, connect: f.c.connect(f.id)
  });
  let clicks = 0, courseClicks = 0;
  try {
    const doc = page.window.document;
    doc.querySelector('.btn-next').disabled = true;
    const sidebar = doc.createElement('div'); sidebar.className = 'my-course-container';
    sidebar.innerHTML = '<a class="timetable">查看所有课表</a>'; doc.body.append(sidebar);
    const entry = sidebar.querySelector('a'); entry.getClientRects = () => [{ width: 10, height: 10 }];
    entry.addEventListener('click', () => { clicks++; page.window.history.replaceState({}, '', HOME); });
    doc.querySelectorAll('.item-bg-text p.sle').forEach(el => el.addEventListener('click', () => courseClicks++));
    await page.api.syncSharedJob(); await waitFor(() => clicks === 1);
    await page.api.syncSharedJob();
    await waitFor(() => f.c.storage.session[KEY]?.phase === 'selection', 8000);
    const job = f.c.storage.session[KEY];
    assert.equal(job.candidates.length, 6); assert.equal(job.running, false);
    assert.equal(clicks, 1); assert.equal(courseClicks, 0); assert.equal(f.c.navigation.length, 1);
    assert.equal(job.logs.some(l => l.eventCode === 'task-paused'), false);
  } finally { page.dom.window.close(); }
});


test('outer-authorized stale-list entry waits for its departure but retains the hard navigation deadline', async () => {
  const f = await startFromFinished(true);
  const deadline = f.job.outer.stage.deadline;
  for (let i = 0; i < 7; i++) {
    f.c.advanceTime(25000);
    const r = await f.c.request(f.id, 'root-page', 'hello', auth(f.job), ROOT);
    assert.equal(r.ok, true); f.job = r.job;
    assert.equal(f.job.outer.state, 'active'); assert.equal(f.job.phase, 'go-agent');
    assert.equal(f.job.outer.stage.deadline, deadline);
    // Keep modelling a pending navigation at the original document.
    f.c.tabs.get(f.id).url = ROOT; f.c.tabs.get(f.id).pendingUrl = AGENT;
  }
  f.c.advanceTime(6000);
  const r = await f.c.request(f.id, 'root-page', 'hello', auth(f.job), ROOT);
  assert.equal(r.job.outer.state, 'paused'); assert.equal(r.job.running, false);
  assert.equal(r.job.outer.scopeConfirmed, false); assert.equal(r.job.outer.entries.length, 0);
  assert.match(r.job.reason, /超时|失联/);
});
