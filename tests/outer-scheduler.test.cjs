const test = require('node:test');
const assert = require('node:assert/strict');
const { coordinator } = require('./coordinator.cjs');
const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
const KEY = 'xinwei-job-v3';
const auth = job => ({ runId: job.runId, generation: job.generation, resetEpoch: job.resetEpoch || 0 });
const courseURL = key => `https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/${key}/video/v?classId=class-${key}`;
const entries = () => ['A', 'B', 'C'].map((key, order) => ({ key, title: key, order, page: 1, timetablePercent: 80 }));
async function send(f, action, payload = {}) {
  const response = await f.c.request(f.tab, f.instance, action, { ...auth(f.job), ...payload });
  assert.equal(response.ok, true, `${action}: ${response.error}`);
  f.job = response.job; return f.job;
}
async function setup(candidates = entries(), options) {
  const c = coordinator(options), tab = c.addTab(HOME);
  const f = { c, tab, instance: 'home', job: {} };
  await send(f, 'start', { scope: 'all', workflow: 'manual', singlePass: true });
  await send(f, 'scan-result', { candidates });
  await send(f, 'outer-start');
  return f;
}
async function dispatch(f) {
  const { outer } = f.job, d = outer.dispatch;
  const index = f.job.candidates.findIndex(c => c.key === d.key);
  await send(f, 'course-select', { index, candidateKey: f.job.candidates[index].courseKey || d.key,
    purpose: 'learn', roundId: outer.id, dispatchToken: d.token });
  return f;
}
async function enter(f) {
  if (f.job.returningTabId != null) {
    f.instance += '-return';
    await send(f, 'hello');
  }
  await send(f, 'open', { index: f.job.selectedIndex, purpose: 'inspect' });
  const candidate = f.job.candidates[f.job.targetIndex];
  f.tab = f.c.addTab(courseURL(candidate.key), f.tab);
  f.instance = `worker-${f.tab}`;
  await send(f, 'hello', { title: candidate.title });
}
async function scan(f, items) {
  const candidate = f.job.candidates[f.job.targetIndex];
  await send(f, 'directory-checkpoint', { snapshot: { version: 1, courseKey: candidate.courseKey, items } });
}
const video = done => ({ key: 'v', title: 'video', mediaType: 'video', durationSeconds: 60, observedCompleted: done });
async function result(f, total, remaining, extra = {}) {
  await send(f, 'course-result', { result: { total, remaining, ...extra } });
}
async function stopped(f) {
  await send(f, 'outer-stopped', { roundId: f.job.outer.id, token: f.job.outer.awaitingStop.token, stopped: true });
}
async function fail(f) {
  await scan(f, [video(false)]);
  await result(f, 1, 1);
  assert.equal(f.job.operation, 'play');
  await result(f, 1, 1, { finalPass: true });
  assert.equal(f.job.outer.entries[f.job.outer.cursor].latestResult.code, 'course-failed');
}

test('fixed queue skips only visible exact 100, waits for stopped executor and never revisits homework progress', async () => {
  const list = entries(); list[0].timetablePercent = 100;
  list[0].homeEvidence = { source: 'visible-home-progress', percent: 100, time: Date.now() };
  const f = await setup(list);
  assert.equal(f.job.workflow, 'manual');
  assert.equal(f.job.outer.entries[0].state, 'skipped');
  assert.equal(f.job.outer.dispatch.key, 'B');
  await dispatch(f); await enter(f); await scan(f, [video(true), { key: 'homework', title: '作业', mediaType: 'other', durationSeconds: null }]);
  const old = auth(f.job);
  await result(f, 1, 0);
  assert.equal(f.job.outer.entries[1].state, 'completed');
  assert.equal(f.job.candidates[1].timetablePercent, 80);
  assert.equal(f.job.outer.dispatch, undefined);
  const duplicate = await f.c.request(f.tab, f.instance, 'course-result', { ...old, result: { total: 1, remaining: 0 } });
  assert.equal(duplicate.ok, false);
  await stopped(f);
  const dispatchToken = f.job.outer.dispatch.token;
  assert.equal(f.job.outer.dispatch.key, 'C');
  await send(f, 'get'); assert.equal(f.job.outer.dispatch.token, dispatchToken);
  await dispatch(f); await enter(f); await scan(f, [{ key: 'exam', title: '考试', mediaType: 'other', durationSeconds: null }]);
  await result(f, 0, 0); await stopped(f);
  assert.equal(f.job.outer.state, 'finished');
  assert.deepEqual(JSON.parse(JSON.stringify(f.job.outer.summary)), { completed: 1, skipped: 2, failed: 0 });
  assert.equal(f.job.outer.dispatch, undefined);
  assert.equal(f.job.running, false);
});

test('once-only reentry is saved before returning HOME; second failure advances without a new round', async () => {
  let persistedBeforeHome = false, f;
  f = await setup(entries(), { beforeStorageSet(area, values) {
    if (area === 'local' && values[KEY]?.outer?.entries[0]?.reentries === 1) persistedBeforeHome = true;
  } });
  await dispatch(f); await enter(f); await fail(f);
  const round = f.job.outer.id;
  assert.equal(f.c.navigation.filter(n => n.url === HOME).length, 0);
  await stopped(f); assert.equal(f.job.outer.entries[0].reentries, 1);
  await dispatch(f);
  assert.equal(persistedBeforeHome, true);
  assert.equal(f.c.navigation.at(-1).url, HOME);
  assert.equal(f.job.candidates[0].learnUrl, undefined);
  assert.equal(f.job.candidates[0].courseKey, 'A::class-A');
  await enter(f); await fail(f); await stopped(f);
  assert.equal(f.job.outer.entries[0].state, 'failed');
  assert.equal(f.job.outer.entries[0].reentries, 1);
  assert.equal(f.job.outer.dispatch.key, 'B');
  assert.equal(f.job.outer.id, round);
});

test('reentry succeeds with current platform confirmation; first failure and allowance survive', async () => {
  const f = await setup(entries().slice(0, 1));
  await dispatch(f); await enter(f); await fail(f); await stopped(f); await dispatch(f); await enter(f);
  await scan(f, [video(true)]); await result(f, 1, 0); await stopped(f);
  const entry = f.job.outer.entries[0];
  assert.equal(entry.state, 'completed'); assert.equal(entry.reentries, 1);
  assert.equal(entry.firstFailure.code, 'course-failed'); assert.equal(f.job.outer.state, 'finished');
});

test('pause between result and ack denies late ack, continue keeps result and consumes it once', async () => {
  const f = await setup(); await dispatch(f); await enter(f); await scan(f, [video(true)]); await result(f, 1, 0);
  const token = f.job.outer.awaitingStop.token, before = auth(f.job);
  await send(f, 'pause');
  assert.equal(f.job.outer.state, 'paused');
  assert.equal((await f.c.request(f.tab, f.instance, 'outer-stopped', { ...before,
    roundId: f.job.outer.id, token, stopped: true })).ok, false);
  await send(f, 'outer-continue', { roundId: f.job.outer.id, stopped: true });
  await stopped(f);
  assert.equal(f.job.outer.dispatch.key, 'B');
  assert.equal(f.job.outer.entries[0].state, 'completed');
});

test('browser restart and extension update preserve allowance but require explicit continue', async () => {
  for (const restart of ['restartBrowser', 'updateExtension']) {
    const f = await setup(); await dispatch(f); await enter(f); await fail(f); await stopped(f);
    const token = f.job.outer.dispatch.token, roundId = f.job.outer.id;
    f.c[restart](); await send(f, 'get');
    assert.equal(f.job.outer.state, 'paused', restart);
    assert.equal(f.job.outer.entries[0].reentries, 1);
    assert.equal(f.job.outer.dispatch.token, token);
    const n = f.c.navigation.length;
    await send(f, 'get'); assert.equal(f.c.navigation.length, n);
    await send(f, 'outer-continue', { roundId, stopped: true });
    assert.equal(f.job.outer.state, 'active');
    assert.equal(f.job.outer.dispatch.token, token);
  }
});

test('stage budget cannot renew on ordinary get/log/retry and timeout never starts another course', async () => {
  const f = await setup(); await dispatch(f);
  const deadline = f.job.outer.stage.deadline;
  for (let i = 0; i < 7; i++) {
    f.c.advanceTime(25000); await send(f, 'get');
    assert.equal(f.job.outer.stage.deadline, deadline);
  }
  f.c.advanceTime(6000); await send(f, 'get');
  assert.equal(f.job.outer.state, 'paused'); assert.match(f.job.reason, /超时|失联/);
  assert.equal(f.job.outer.entries[0].state, 'running');
  assert.equal(f.job.outer.entries[1].state, 'pending');
  assert.equal(f.job.outer.dispatch, undefined);
});

test('sleep pauses instead of spending reentry or counting a course failed', async () => {
  const f = await setup(); await dispatch(f); await send(f, 'get');
  f.c.advanceTime(600000); await send(f, 'get');
  assert.equal(f.job.outer.state, 'paused'); assert.match(f.job.reason, /休眠/);
  assert.equal(f.job.outer.entries[0].reentries, 0);
});

test('unknown document and blank directory cannot become no-task terminal results', async () => {
  const f = await setup(); await dispatch(f); await enter(f);
  await scan(f, [{ key: 'd', title: '未知文档', mediaType: 'document', durationSeconds: null, taskItem: null, observedCompleted: null }]);
  await result(f, 1, 0);
  assert.equal(f.job.operation, 'play'); assert.equal(f.job.outer.entries[0].state, 'running');
  await result(f, 1, 0, { finalPass: true });
  assert.equal(f.job.outer.entries[0].latestResult.code, 'course-failed');
  const g = await setup(); await dispatch(g); await enter(g); await scan(g, []); await result(g, 0, 0);
  assert.equal(g.job.outer.state, 'paused'); assert.notEqual(g.job.outer.entries[0].state, 'skipped');
});

test('a completed-looking scan with pending platform media does not allow next course', async () => {
  const f = await setup(); await dispatch(f); await enter(f); await scan(f, [video(false)]); await result(f, 1, 0);
  assert.equal(f.job.outer.state, 'paused'); assert.equal(f.job.outer.dispatch, undefined);
  assert.equal(f.job.candidates[0].latestResult.code, 'directory-scanned');
});

test('list refresh, direct course selection and old auto workflow cannot bypass queue authorization', async () => {
  const f = await setup();
  for (const [action, payload] of [['start', { scope: 'all', workflow: 'manual', restart: true }],
    ['start', { workflow: 'auto' }], ['course-select', { index: 1, candidateKey: 'B', purpose: 'learn' }]]) {
    assert.equal((await f.c.request(f.tab, f.instance, action, { ...auth(f.job), ...payload })).ok, false);
  }
  await send(f, 'outer-manual', { roundId: f.job.outer.id });
  assert.equal(f.job.outer.state, 'revoked'); assert.equal(f.job.outer.dispatch, undefined);
  await send(f, 'course-select', { index: 1, candidateKey: 'B', purpose: 'learn' });
  assert.equal(f.job.selectedIndex, 1);
});

test('login block and critical persistence failure pause instead of reentry', async () => {
  const f = await setup(); await dispatch(f); await enter(f);
  await send(f, 'get', { pageBlocked: '验证码' });
  assert.equal(f.job.outer.state, 'paused'); assert.equal(f.job.outer.entries[0].reentries, 0);
  const g = await setup(); g.c.failStorage();
  const response = await g.c.request(g.tab, g.instance, 'course-select', { ...auth(g.job),
    index: 0, candidateKey: 'A', purpose: 'learn', roundId: g.job.outer.id, dispatchToken: g.job.outer.dispatch.token });
  assert.equal(response.ok, false); assert.equal(g.c.navigation.length, 0);
});

module.exports = { setup, send, dispatch, enter, scan, result, stopped, video, fail };

test('explicit continue during inner playback preserves attempt and reentry allowance', async () => {
  const f = await setup(); await dispatch(f); await enter(f); await scan(f, [video(false)]); await result(f, 1, 1);
  const generation = f.job.generation;
  await send(f, 'pause'); await send(f, 'outer-continue', { roundId: f.job.outer.id, stopped: true });
  assert.equal(f.job.outer.state, 'active'); assert.equal(f.job.running, true);
  assert.equal(f.job.phase, 'course'); assert.equal(f.job.operation, 'play');
  assert.equal(f.job.outer.entries[0].reentries, 0); assert.ok(f.job.generation > generation);
  assert.equal(f.job.outer.dispatch, undefined);
});

test('exhausted inner local recovery reports failure and waits for stopped acknowledgement before reentry', async () => {
  const f = await setup(); await dispatch(f); await enter(f); await scan(f, [video(false)]); await result(f, 1, 1);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await send(f, 'interruption-attempt', { key: 'v', kind: 'directory-load', reason: 'synthetic directory failure' });
    assert.equal(f.job.interruption.attempts, attempt);
    await send(f, 'interruption-failed', { episodeId: f.job.interruption.id, kind: 'directory-load' });
  }
  assert.equal(f.job.running, false); assert.equal(f.job.phase, 'manual');
  assert.equal(f.job.outer.state, 'active'); assert.equal(f.job.outer.dispatch, undefined);
  assert.equal(f.job.outer.awaitingStop.localFailure, true);
  assert.equal(f.job.outer.entries[0].latestResult.code, 'course-failed');
  await stopped(f); assert.equal(f.job.outer.entries[0].reentries, 1);
  assert.equal(f.job.outer.dispatch.key, 'A');
});

test('long media with actual advancing observations has no total course time budget', async () => {
  const f = await setup(); await dispatch(f); await enter(f); await scan(f, [video(false)]); await result(f, 1, 1);
  const routeKey = new URL(courseURL('A')).pathname + new URL(courseURL('A')).hash;
  await send(f, 'resource-checkpoint', { key: 'v', title: 'video', stage: 'ready', routeKey });
  const start = Date.now();
  for (let i = 1; i <= 16; i++) {
    f.c.advanceTime(25000);
    await send(f, 'media-observation', { key: 'v', routeKey, position: i * 25, time: start + i * 25000 });
    await send(f, 'get');
    assert.equal(f.job.outer.state, 'active'); assert.equal(f.job.running, true);
  }
  assert.equal(f.job.outer.entries[0].reentries, 0);
});

test('owner refresh during dispatch pauses, and stale list auto-start uses original list entry', async () => {
  const f = await setup(); f.instance = 'refreshed'; await send(f, 'get');
  assert.equal(f.job.outer.state, 'paused'); assert.match(f.job.reason, /刷新/);
  const c = coordinator(), tab = c.addTab(HOME), g = { c, tab, instance: 'home', job: {} };
  await send(g, 'start', { scope: 'all', workflow: 'manual', singlePass: true });
  await send(g, 'scan-result', { candidates: entries() });
  c.advanceTime(6 * 60000); await send(g, 'outer-start');
  assert.equal(g.job.phase, 'scan-home'); assert.equal(g.job.outer.scopeConfirmed, false);
  await send(g, 'scan-result', { candidates: entries().slice(0, 1) });
  assert.equal(g.job.outer.entries.length, 1); assert.equal(g.job.outer.scopeConfirmed, true);
});

test('duplicate dispatch, shifted identity, and pause racing dispatch persistence cannot start another executor', async () => {
  let armed = false, pauseRequest, f;
  f = await setup(entries(), { beforeStorageSet(area, values) {
    const job = values[KEY];
    if (armed && area === 'local' && job?.outer?.entries[0].state === 'running') {
      armed = false;
      pauseRequest = f.c.request(f.tab, f.instance, 'pause', auth(f.job));
    }
  } });
  const outer = f.job.outer, d = outer.dispatch;
  const bad = await f.c.request(f.tab, f.instance, 'course-select', { ...auth(f.job), index: 1, candidateKey: 'B',
    purpose: 'learn', roundId: outer.id, dispatchToken: d.token });
  assert.equal(bad.ok, false);
  armed = true; await dispatch(f); await pauseRequest;
  await send(f, 'get');
  assert.equal(f.job.outer.state, 'paused'); assert.equal(f.job.running, false);
  assert.equal(f.c.navigation.length, 0);
  const duplicate = await f.c.request(f.tab, f.instance, 'course-select', { ...auth(f.job), index: 0, candidateKey: 'A',
    purpose: 'learn', roundId: outer.id, dispatchToken: d.token });
  assert.equal(duplicate.ok, false);
});

test('safe reentry navigation failure is terminal only after current home executor stops, then advances', async () => {
  const f = await setup(); await dispatch(f); await enter(f); await fail(f); await stopped(f); await dispatch(f);
  f.instance += '-home'; await send(f, 'hello');
  assert.equal(f.job.phase, 'home');
  for (let i = 0; i < 8; i++) { f.c.advanceTime(25000); await send(f, 'get'); }
  assert.equal(f.job.running, false);
  assert.equal(f.job.outer.awaitingStop.allowedRoute, 'home');
  assert.equal(f.job.outer.dispatch, undefined);
  await stopped(f);
  assert.equal(f.job.outer.entries[0].state, 'failed');
  assert.equal(f.job.outer.entries[0].reentries, 1);
  assert.equal(f.job.outer.dispatch.key, 'B');
});

test('single deadline alarm revokes authority when every content page stops polling', async () => {
  const f = await setup(); await dispatch(f);
  assert.ok(f.c.alarms.has('xinwei-outer-deadline'));
  f.c.advanceTime(190000);
  await f.c.fireAlarm('xinwei-outer-deadline');
  f.job = f.c.storage.session[KEY];
  assert.equal(f.job.outer.state, 'paused');
  assert.equal(f.job.running, false);
  assert.equal(f.job.outer.entries[0].reentries, 0);
  assert.equal(f.c.navigation.length, 0);
});

test('execution candidate counts and platform pending counts remain separate in the same saved result/log', async () => {
  const f = await setup(); await dispatch(f); await enter(f);
  await scan(f, [video(false), { ...video(false), key: 'v2', title: 'second' }]);
  await result(f, 2, 1);
  const resultState = f.job.candidates[0].latestResult;
  assert.equal(resultState.code, 'directory-scanned');
  assert.equal(resultState.pending, 1); assert.equal(resultState.platformPending, 2);
  const event = f.job.logs.find(log => log.eventCode === 'directory-scanned');
  assert.equal(JSON.stringify(event.result), JSON.stringify(resultState));
  assert.equal(event.evidence.reportedRemaining, 1); assert.equal(event.evidence.platformPendingCount, 2);
});


test('normal worker reinstantiation keeps authority, dispatch identity and spent reentry allowance', async () => {
  const f = await setup(); await dispatch(f); await enter(f); await fail(f); await stopped(f);
  const before = JSON.parse(JSON.stringify(f.job));
  await send(f, 'get'); f.c.advanceTime(35000); f.c.restartWorker(); await send(f, 'get');
  assert.equal(f.job.outer.state, 'active');
  assert.deepEqual(f.job.outer.dispatch, before.outer.dispatch);
  assert.equal(f.job.generation, before.generation);
  assert.equal(f.job.ownerInstance, before.ownerInstance);
  assert.equal(f.job.outer.entries[0].reentries, 1);
  await send(f, 'pause'); const generation = f.job.generation;
  f.c.restartWorker(); await send(f, 'get');
  assert.equal(f.job.outer.state, 'paused'); assert.equal(f.job.generation, generation);
  assert.equal((await f.c.request(f.tab, f.instance, 'course-select', { ...auth(before),
    index: 0, candidateKey: 'A::class-A', purpose: 'learn', roundId: before.outer.id,
    dispatchToken: before.outer.dispatch.token })).ok, false);
});

test('scan progress exceeds navigation budget; frozen or stopped executor cannot renew it by get/log', async () => {
  for (const stoppedExecutor of [false, true]) {
    const f = await setup(); await dispatch(f); await enter(f);
    const report = count => ({ outerExecution: { phase: 'course', active: true, scan: [12, count, count, count] } });
    for (let i = 1; i <= 10; i++) {
      f.c.advanceTime(25000); await send(f, 'get', report(i));
      if (i === 5) f.c.restartWorker();
      assert.equal(f.job.outer.state, 'active');
    }
    const moves = f.c.navigation.length;
    for (let i = 0; i < 9; i++) {
      f.c.advanceTime(25000);
      await send(f, 'get', stoppedExecutor ? { outerExecution: { phase: 'course', active: false, scan: [12, 10, 10, 10] } } : report(10));
    }
    assert.equal(f.job.outer.state, 'paused'); assert.equal(f.job.running, false);
    assert.equal(f.job.outer.entries[0].reentries, 0);
    assert.equal(f.job.outer.entries[1].state, 'pending');
    assert.equal(f.c.navigation.length, moves);
  }
});

test('owner evidence cannot be replaced by stale generation or another page; worker alarm retains expiry', async () => {
  const f = await setup(); await dispatch(f); await enter(f);
  const report = n => ({ outerExecution: { phase: 'course', active: true, scan: [20, n, n, n] } });
  await send(f, 'get', report(1));
  for (let i = 0; i < 7; i++) {
    f.c.advanceTime(25000);
    await f.c.request(f.tab, 'unrelated-instance', 'get', { ...auth(f.job), ...report(i + 2) });
    await f.c.request(f.tab, f.instance, 'get', { ...auth(f.job), generation: f.job.generation - 1, ...report(i + 2) });
    f.c.restartWorker();
  }
  f.c.advanceTime(10000); await f.c.fireAlarm('xinwei-outer-deadline');
  f.job = f.c.storage.session[KEY];
  assert.equal(f.job.outer.state, 'paused'); assert.equal(f.job.running, false);
  assert.equal(f.job.outer.entries[0].reentries, 0);
});

test('ordinary worker restarts cannot extend navigation budget or hide sleep', async () => {
  const f = await setup(); await dispatch(f); await send(f, 'get');
  const deadline = f.job.outer.stage.deadline;
  for (let i = 0; i < 8; i++) {
    f.c.advanceTime(25000); f.c.restartWorker(); await send(f, 'get');
    assert.equal(f.job.outer.stage.deadline, deadline);
  }
  assert.equal(f.job.outer.state, 'paused');
  const g = await setup(); await dispatch(g); await enter(g); await send(g, 'get');
  g.c.advanceTime(600000); g.c.restartWorker(); await send(g, 'get');
  assert.equal(g.job.outer.state, 'paused'); assert.match(g.job.reason, /休眠/);
});

test('manual selection after a completed round preserves history without reusing its current status', async () => {
  const f = await setup(entries().slice(0, 1)); await dispatch(f); await enter(f);
  await scan(f, [video(true)]); await result(f, 1, 0); await stopped(f);
  const summary = f.job.outer.summary, resultBefore = f.job.outer.entries[0].latestResult;
  await send(f, 'course-select', { index: 0, candidateKey: f.job.candidates[0].courseKey, purpose: 'learn' });
  assert.equal(f.job.running, true); assert.equal(f.job.outer.historyOnly, true);
  assert.equal(JSON.stringify(f.job.outer.summary), JSON.stringify(summary));
  assert.equal(JSON.stringify(f.job.outer.entries[0].latestResult), JSON.stringify(resultBefore));
  await send(f, 'pause'); assert.equal(f.job.outer.state, 'finished');
  assert.equal(f.job.outer.historyOnly, true);
});

test('scan polls without execution evidence are bounded and do not authorize reentry', async () => {
  const f = await setup(); await dispatch(f); await enter(f); await send(f, 'get');
  for (let i = 0; i < 8; i++) { f.c.advanceTime(25000); await send(f, 'get'); }
  assert.equal(f.job.outer.state, 'paused'); assert.equal(f.job.running, false);
  assert.equal(f.job.outer.entries[0].reentries, 0); assert.equal(f.job.outer.dispatch, undefined);
});

test('session supervision persistence failure pauses the outer envelope without granting reentry', async () => {
  let failing = false;
  const f = await setup(undefined, { beforeStorageSet(area, values) {
    if (failing && area === 'session' && Object.hasOwn(values, 'xinwei-outer-watch-v1')) throw new Error('watch write failed');
  } });
  await dispatch(f); await enter(f); failing = true;
  await send(f, 'get');
  assert.equal(f.job.outer.state, 'paused'); assert.equal(f.job.running, false);
  assert.equal(f.job.outer.entries[0].reentries, 0); assert.match(f.job.reason, /监督状态保存失败/);
});


test('power opt-in requests system only while working; pause/resume/off/restart release correctly', async () => {
  const f = await setup();
  assert.equal(f.c.powerCalls.some(x => x.action === 'request'), false);
  await send(f, 'set-keep-awake', { enabled: true });
  assert.deepEqual(f.c.powerCalls.at(-1), { action: 'request', level: 'system' });
  const n = f.c.powerCalls.length;
  await send(f, 'get'); await send(f, 'get');
  assert.equal(f.c.powerCalls.length, n, 'no API churn on polling');
  await send(f, 'pause'); assert.equal(f.c.powerCalls.at(-1).action, 'release');
  await send(f, 'outer-continue', { roundId: f.job.outer.id, stopped: true });
  assert.equal(f.c.powerCalls.at(-1).action, 'request');
  await send(f, 'set-keep-awake', { enabled: false });
  assert.equal(f.c.powerCalls.at(-1).action, 'release');
  await send(f, 'set-keep-awake', { enabled: true });
  f.c.restartWorker(); await send(f, 'get');
  assert.equal(f.c.powerCalls.at(-1).action, 'request');
  f.c.restartBrowser(); await send(f, 'get');
  assert.equal(f.job.outer.state, 'paused');
  assert.equal(f.c.powerCalls.at(-1).action, 'release');
});

test('power releases on terminal queue and storage failure; API failure does not stop learning', async () => {
  const f = await setup(entries().slice(0, 1));
  await send(f, 'set-keep-awake', { enabled: true });
  await dispatch(f); await enter(f); await scan(f, [video(true)]); await result(f, 1, 0); await stopped(f);
  assert.equal(f.job.outer.state, 'finished'); assert.equal(f.c.powerCalls.at(-1).action, 'release');
  const g = await setup(); await send(g, 'set-keep-awake', { enabled: true });
  g.c.failStorage(); const response = await g.c.request(g.tab, g.instance, 'get', auth(g.job));
  assert.equal(response.ok, false); assert.equal(g.c.powerCalls.at(-1).action, 'release');
  const h = await setup(undefined, { failPower: true });
  const status = await h.c.request(h.tab, h.instance, 'set-keep-awake', { ...auth(h.job), enabled: true });
  assert.equal(status.ok, true); assert.equal(status.job.outer.state, 'active');
  assert.equal(status.power.requested, false); assert.match(status.power.error, /power unavailable/);
});

function ownerProbe(f, override = {}) {
  const w = {}; f.c.connect(f.tab)(w);
  w.chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.action !== 'outer-resume-check') return;
    reply({ token: msg.token, ...auth(f.job), instanceId: f.instance,
      courseKey: f.job.candidates[f.job.targetIndex].courseKey, title: f.job.candidates[f.job.targetIndex].title,
      documentRouteKey: new URL(f.c.tabs.get(f.tab).url).pathname + new URL(f.c.tabs.get(f.tab).url).hash, stopped: true, ...override });
  });
}

test('home Continue resumes the original course without navigation, new round, or cleared records', async () => {
  const f = await setup(); const home = f.tab, homeInstance = f.instance;
  await dispatch(f); await enter(f); await scan(f, [video(false)]); await result(f, 1, 1);
  await send(f, 'pause'); ownerProbe(f);
  const old = structuredClone(f.job), n = f.c.navigation.length;
  const response = await f.c.request(home, homeInstance, 'outer-continue', { ...auth(f.job), roundId: f.job.outer.id });
  assert.equal(response.ok, true, response.error);
  const job = response.job;
  assert.equal(job.running, true); assert.equal(job.phase, 'course');
  assert.equal(job.ownerTabId, old.ownerTabId); assert.equal(job.ownerInstance, old.ownerInstance);
  assert.equal(job.outer.id, old.outer.id); assert.equal(job.outer.cursor, old.outer.cursor);
  assert.equal(job.outer.entries[0].reentries, old.outer.entries[0].reentries);
  assert.deepEqual(job.candidates[0].records, old.candidates[0].records);
  assert.equal(f.c.navigation.slice(n).some(entry => Object.hasOwn(entry, 'url')), false);
  assert.equal(f.c.navigation.at(-1).id, old.ownerTabId); assert.equal(f.c.reloads.length, 0);
});

test('cross-page resume rejects active executor, blocking notice and stale identity', async () => {
  for (const override of [{ stopped: false }, { pageBlocked: '请先登录' }, { instanceId: '' }, { title: 'wrong' }, { documentRouteKey: '/wrong' }, { generation: -1 }, { courseKey: 'wrong' }]) {
    const f = await setup(); const home = f.tab;
    await dispatch(f); await enter(f); await send(f, 'pause'); ownerProbe(f, override);
    const n = f.c.navigation.length;
    const r = await f.c.request(home, 'home', 'outer-continue', { ...auth(f.job), roundId: f.job.outer.id });
    assert.equal(r.ok, false); assert.equal(f.c.storage.session[KEY].outer.state, 'paused');
    assert.ok(f.c.storage.session[KEY].logs.some(x => x.eventCode === 'outer-resume-rejected'));
    assert.equal(f.c.navigation.length, n);
  }
  const f = await setup(); const home = f.tab;
  await dispatch(f); await enter(f); await send(f, 'pause'); await f.c.closeTab(f.tab);
  const r = await f.c.request(home, 'home', 'outer-continue', { ...auth(f.job), roundId: f.job.outer.id });
  assert.equal(r.ok, true, r.error); assert.equal(r.job.phase, 'opening');
  assert.equal(r.job.resumeEntry.via, 'saved-url');
});

test('background progress continues without display state, but a supervision gap still requires manual resume', async () => {
  const f = await setup(); await dispatch(f); await enter(f);
  for (let i = 0; i < 12; i++) {
    f.c.advanceTime(30000);
    await send(f, 'get', { outerExecution: { phase: 'course', active: true, scan: [i + 1, i + 1, i + 1, i + 1] } });
    assert.equal(f.job.outer.state, 'active');
  }
  f.c.advanceTime(90000); await send(f, 'get');
  assert.equal(f.job.outer.state, 'paused');
  const entry = f.job.logs.findLast(x => x.eventCode === 'outer-supervision-gap');
  assert.ok(entry.evidence.elapsedMs >= 90000);
  await send(f, 'get'); assert.equal(f.job.outer.state, 'paused');
});

test('pause arriving during owner resume proof cancels resume without issuing navigation', async () => {
  const f = await setup(); const home = f.tab;
  await dispatch(f); await enter(f); await send(f, 'pause');
  const w = {}; f.c.connect(f.tab)(w);
  let answer;
  w.chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.action !== 'outer-resume-check') return;
    answer = () => reply({ token: msg.token, ...auth(f.job), instanceId: f.instance,
      courseKey: f.job.candidates[0].courseKey, title: f.job.candidates[0].title,
      documentRouteKey: new URL(f.c.tabs.get(f.tab).url).pathname + new URL(f.c.tabs.get(f.tab).url).hash, stopped: true });
    return true;
  });
  const n = f.c.navigation.length;
  const resume = f.c.request(home, 'home', 'outer-continue', { ...auth(f.job), roundId: f.job.outer.id });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(answer);
  const pause = f.c.request(f.tab, f.instance, 'pause', auth(f.job));
  answer();
  const [r, p] = await Promise.all([resume, pause]);
  assert.equal(r.ok, false); assert.equal(p.ok, true); assert.equal(p.job.running, false);
  assert.equal(p.job.outer.state, 'paused'); assert.equal(f.c.navigation.length, n);
});

async function pausedPlaying() {
  const f = await setup(); f.home = f.tab;
  await dispatch(f); await enter(f); await scan(f, [video(false)]); await result(f, 1, 1);
  await send(f, 'pause');
  return f;
}
function routeKey(url) { const u = new URL(url); return u.pathname + u.hash; }
async function homeContinue(f, tab = f.home, instance = 'home') {
  return f.c.request(tab, instance, 'outer-continue', { ...auth(f.job), roundId: f.job.outer.id, stopped: true });
}

test('closed owner resumes on a newly opened home, preserves attempt state and rejects late old messages', async () => {
  const f = await pausedPlaying();
  const saved = f.c.storage.session[KEY];
  saved.candidates[0].records = { v: { ended: false, confirmed: false, recovery: { attempts: 2, reloads: 1 } } };
  saved.candidates[0].currentResource = { key: 'v', title: 'video', stage: 'ready', routeKey: routeKey(courseURL('A')) };
  saved.outer.entries[0].reentries = 1;
  f.job = structuredClone(saved);
  const before = structuredClone(saved), oldOwner = f.tab;
  await f.c.closeTab(f.tab); await f.c.closeTab(f.home);
  const home = f.c.addTab(HOME);
  const r = await homeContinue(f, home, 'new-home');
  assert.equal(r.ok, true, r.error);
  f.job = r.job;
  assert.equal(r.job.outer.id, before.outer.id);
  assert.equal(r.job.outer.entries[0].reentries, 1);
  assert.deepEqual(r.job.candidates[0].records, before.candidates[0].records);
  assert.equal(r.job.ownerTabId, home); assert.equal(r.job.running, true);
  assert.equal(f.c.navigation.at(-1).url, courseURL('A'));
  const stale = await f.c.request(oldOwner, f.instance, 'course-result', { ...auth(before), result: { total: 1, remaining: 0 } });
  assert.equal(stale.ok, false);
  // Old DOM seeing the new URL is not proof of arrival.
  const early = await f.c.request(home, 'new-home', 'hello', { ...auth(f.job), title: 'A', documentRouteKey: routeKey(courseURL('A')) });
  assert.equal(early.job.phase, 'opening');
  const arrived = await f.c.request(home, 'reopened-course', 'hello', { ...auth(f.job), title: 'A', documentRouteKey: routeKey(courseURL('A')) });
  assert.equal(arrived.ok, true, arrived.error); assert.equal(arrived.job.phase, 'course');
  assert.equal(arrived.job.targetPurpose, 'play'); assert.equal(arrived.job.operation, 'play');
  assert.equal(arrived.job.resumeEntry, undefined);
  assert.deepEqual(arrived.job.candidates[0].currentResource, before.candidates[0].currentResource);
  assert.deepEqual(arrived.job.candidates[0].records, before.candidates[0].records);
});

test('missing saved URL uses existing card opening then restores play without rescanning a fresh attempt', async () => {
  const f = await pausedPlaying();
  delete f.c.storage.session[KEY].candidates[0].learnUrl;
  await f.c.closeTab(f.tab);
  const r = await homeContinue(f); assert.equal(r.ok, true, r.error);
  f.job = r.job; f.tab = f.home; f.instance = 'home';
  assert.equal(f.job.phase, 'home'); assert.equal(f.job.resumeEntry.via, 'course-card');
  assert.equal(f.job.operation, 'inspect');
  await send(f, 'open', { index: 0, purpose: 'inspect' });
  f.tab = f.c.addTab(courseURL('A'), f.home); f.instance = 'new-course';
  await send(f, 'hello', { title: 'A', documentRouteKey: routeKey(courseURL('A')) });
  assert.equal(f.job.phase, 'course'); assert.equal(f.job.operation, 'play'); assert.equal(f.job.targetPurpose, 'play');
  assert.equal(f.job.resumeEntry, undefined);
});

test('reopen remains bounded, pause cancels late arrival, repeated click does not navigate twice', async () => {
  for (const stop of ['timeout', 'pause']) {
    const f = await pausedPlaying(); await f.c.closeTab(f.tab);
    const old = structuredClone(f.job);
    const r = await homeContinue(f); assert.equal(r.ok, true, r.error);
    f.job = r.job; f.tab = f.home; f.instance = 'home';
    const n = f.c.navigation.length;
    const duplicate = await f.c.request(f.home, 'home', 'outer-continue', { ...auth(old), roundId: old.outer.id });
    assert.equal(duplicate.ok, false); assert.equal(f.c.navigation.length, n);
    if (stop === 'timeout') { f.c.advanceTime(46000); await send(f, 'get'); }
    else await send(f, 'pause');
    assert.equal(f.job.running, false); assert.equal(f.job.resumePhase, 'course');
    assert.equal(f.job.operation, 'play'); assert.equal(f.job.resumeEntry, undefined);
    const late = await f.c.request(f.home, 'late-course', 'hello', { ...auth(r.job), title: 'A', documentRouteKey: routeKey(courseURL('A')) });
    assert.equal(late.job.running, false); assert.equal(f.c.navigation.length, n);
  }
});

test('closed page after completed result resumes settlement from home without reopening completed course', async () => {
  const f = await setup(); const home = f.tab;
  await dispatch(f); await enter(f); await scan(f, [video(true)]); await result(f, 1, 0); await send(f, 'pause');
  const round = f.job.outer.id;
  await f.c.closeTab(f.tab);
  f.home = home;
  const n = f.c.navigation.length;
  const r = await homeContinue(f); assert.equal(r.ok, true, r.error);
  f.job = r.job; f.tab = home; f.instance = 'home';
  assert.equal(f.job.phase, 'selection'); assert.equal(f.job.outer.awaitingStop.allowedRoute, 'home');
  await stopped(f);
  assert.equal(f.job.outer.id, round); assert.equal(f.job.outer.dispatch.key, 'B');
  assert.equal(f.job.outer.entries[0].state, 'completed'); assert.equal(f.c.navigation.length, n);
});

test('owner navigated back to home resumes in same tab; different class cannot take over', async () => {
  const f = await pausedPlaying();
  f.c.tabs.get(f.tab).url = HOME;
  const r = await homeContinue(f, f.tab, f.instance);
  assert.equal(r.ok, true, r.error); f.job = r.job;
  f.c.tabs.get(f.tab).url = courseURL('B'); f.instance = 'wrong-class-page';
  await send(f, 'hello', { title: 'A', documentRouteKey: routeKey(courseURL('B')) });
  assert.equal(f.job.running, false); assert.match(f.job.reason, /教学班不符/);
  assert.equal(f.job.candidates[0].courseKey, 'A::class-A');
});

test('saved entry redirect to timetable falls back once without changing round or granting resource work', async () => {
  const f = await pausedPlaying(); await f.c.closeTab(f.tab);
  const r = await homeContinue(f); assert.equal(r.ok, true, r.error);
  f.job = r.job; f.tab = f.home; f.instance = 'redirected-home';
  f.c.tabs.get(f.tab).url = HOME;
  await send(f, 'hello', { documentRouteKey: routeKey(HOME) });
  assert.equal(f.job.phase, 'home'); assert.equal(f.job.resumeEntry.via, 'course-card');
  assert.equal(f.job.running, true); assert.equal(f.job.operation, 'inspect');
  const deadline = f.job.resumeEntry.deadline;
  await send(f, 'hello', { documentRouteKey: routeKey(HOME) });
  assert.equal(f.job.resumeEntry.deadline, deadline);
  await send(f, 'pause');
  assert.equal(f.job.operation, 'play'); assert.equal(f.job.resumePhase, 'course');
});

test('login at new home rejects reopen; delayed old document cannot commit arrival after user pause', async () => {
  const f = await pausedPlaying(); await f.c.closeTab(f.tab);
  const n = f.c.navigation.length;
  const r = await f.c.request(f.home, 'home', 'outer-continue', { ...auth(f.job), roundId: f.job.outer.id, stopped: true, pageBlocked: '请先登录' });
  assert.equal(r.ok, false); assert.equal(f.c.navigation.length, n);
  assert.equal(f.c.storage.session[KEY].outer.state, 'paused');
});


test('card recovery can return to checkpoint within the same SPA only after selected-resource proof', async () => {
  const f = await pausedPlaying();
  const checkpointURL = courseURL('A').replace('/video/v?', '/video/checkpoint?');
  delete f.c.storage.session[KEY].candidates[0].learnUrl;
  f.c.storage.session[KEY].candidates[0].currentResource = { key: 'saved-video', title: 'saved', stage: 'ready', routeKey: routeKey(checkpointURL) };
  await f.c.closeTab(f.tab);
  const r = await homeContinue(f); assert.equal(r.ok, true, r.error);
  f.job = r.job; f.tab = f.home; f.instance = 'home';
  await send(f, 'open', { index: 0, purpose: 'inspect' });
  f.tab = f.c.addTab(courseURL('A'), f.home); f.instance = 'same-spa';
  await send(f, 'hello', { title: 'A', documentRouteKey: routeKey(courseURL('A')) });
  assert.equal(f.job.phase, 'opening'); assert.equal(f.c.navigation.at(-1).url, checkpointURL);
  await send(f, 'hello', { title: 'A', documentRouteKey: routeKey(checkpointURL), activeResourceKey: 'old-video' });
  assert.equal(f.job.phase, 'opening');
  await send(f, 'hello', { title: 'A', documentRouteKey: routeKey(checkpointURL), activeResourceKey: 'saved-video' });
  assert.equal(f.job.phase, 'course'); assert.equal(f.job.operation, 'play');
});
