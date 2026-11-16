const assert = require('node:assert/strict');
const test = require('node:test');
const { coordinator } = require('./coordinator.cjs');

const AGENT = 'https://www.beeline-ai.com/stu/agent';
const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
const OTHER = 'https://www.beeline-ai.com/student/#/profile';
const LEARN = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course/video/res?classId=class';
const auth = job => ({ runId: job.runId, generation: job.generation });
const urlNavigations = coordinator => coordinator.navigation.filter(entry => entry.url);
const KEY = 'xinwei-job-v3';
const plain = value => JSON.parse(JSON.stringify(value));

for (const url of [HOME, LEARN, OTHER]) {
test(`已移除的全课启动命令不能创建任务或导航：${url}`, async () => {
  const c = coordinator();
  const id = c.addTab(url);
  const result = await c.request(id, 'home', 'start', {
    scope: 'all', workflow: 'auto', singlePass: true, restart: true
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'TASK_COMMAND_REJECTED');
  assert.match(result.error, /一键全课.*移除/);
  assert.notEqual(c.storage.session[KEY]?.running, true);
  assert.equal(urlNavigations(c).length, 0);
  assert.equal(c.reloads.length, 0);
});
}

test('未指定模式的全课启动只获取手动课程列表，不跳过或打开任何课程', async () => {
  const c = coordinator(), id = c.addTab(HOME);
  let result = await c.request(id, 'home', 'start', { scope: 'all', singlePass: true });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.job.workflow, 'manual');
  assert.equal(result.job.operation, 'list');
  assert.equal(result.job.phase, 'scan-home');
  result = await c.request(id, 'home', 'scan-result', {
    ...auth(result.job), candidates: [
      { key: 'A', title: '课程 A', page: 1, order: 0, timetablePercent: 100 },
      { key: 'B', title: '课程 B', page: 1, order: 1, timetablePercent: 38 }
    ]
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.job.phase, 'selection');
  assert.equal(result.job.running, false);
  assert.equal(result.job.selectedIndex, null);
  assert.equal(result.job.candidates[0].status, 'uninspected');
  assert.equal(result.job.candidates[1].remaining, null);
  const opened = await c.request(id, 'home', 'open', {
    ...auth(result.job), index: 1, purpose: 'inspect'
  });
  assert.equal(opened.ok, false, 'list discovery does not authorize a course');
  assert.equal(urlNavigations(c).length, 0);
  assert.equal(c.removed.length, 0);
});

test('后台重连仅为原页面原代数重新授权，不越过用户暂停或接受旧消息', async () => {
  const c = coordinator(), id = c.addTab(HOME);
  let r = await c.request(id, 'home', 'start', { scope: 'all', workflow: 'manual' });
  const original = r.job;
  r = await c.request(id, 'home', 'hello', {
    ...auth(original), reconnect: true, documentRouteKey: '/myBank/courseResearch'
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.generation, original.generation + 1);
  assert.equal(r.job.runId, original.runId);
  assert.equal(r.job.running, true);
  const repeated = await c.request(id, 'home', 'hello', {
    ...auth(original), reconnect: true, documentRouteKey: '/myBank/courseResearch'
  });
  assert.equal(repeated.error, 'TASK_CANCELLED');
  const paused = await c.request(id, 'home', 'pause', auth(r.job));
  r = await c.request(id, 'home', 'hello', {
    ...auth(paused.job), reconnect: true, documentRouteKey: '/myBank/courseResearch'
  });
  assert.equal(r.job.running, false);
  assert.equal(r.job.generation, paused.job.generation);
});

test('重连页面与真实标签路由不符时不能重新授权', async () => {
  const c = coordinator(), id = c.addTab(HOME);
  let r = await c.request(id, 'home', 'start', { scope: 'all', workflow: 'manual' });
  const generation = r.job.generation;
  r = await c.request(id, 'home', 'hello', {
    ...auth(r.job), reconnect: true, documentRouteKey: '/stu/agent'
  });
  assert.equal(r.job.generation, generation);
});

test('页面通知不返回时不会无限堵住后台串行队列', async () => {
  const c = coordinator(), id = c.addTab(HOME);
  // Attach a real mock content listener that explicitly keeps its port open.
  const window = { location: { href: HOME } };
  c.connect(id)(window);
  window.chrome.runtime.onMessage.addListener(() => true);
  const started = Date.now();
  const r = await c.request(id, 'home', 'start', { scope: 'all', workflow: 'manual' });
  assert.equal(r.ok, true);
  assert.ok(Date.now() - started < 4000);
  assert.equal((await c.request(id, 'home', 'get')).ok, true);
});

test('后台错误响应区分路由/命令拒绝与任务存储故障', async () => {
  const c = coordinator();
  const invalidPage = c.addTab(OTHER);
  const rejected = await c.request(invalidPage, 'page', 'start');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.errorCode, 'TASK_COMMAND_REJECTED');

  const home = c.addTab(HOME);
  const started = await c.request(home, 'home', 'start', {
    scope: 'all', workflow: 'manual', singlePass: true
  });
  assert.equal(started.ok, true, started.error);
  c.failStorage();
  const storageFailure = await c.request(home, 'home', 'get');
  assert.equal(storageFailure.ok, false);
  assert.equal(storageFailure.errorCode, 'TASK_STORAGE_FAILURE');
});

async function manualInspection(purpose = 'learn') {
  const c = coordinator(), home = c.addTab(HOME);
  const request = async (tab, instance, action, payload = {}) => {
    const response = await c.request(tab, instance, action, payload);
    assert.equal(response.ok, true, `${action}: ${response.error}`);
    return response.job;
  };
  let job = await request(home, 'home', 'start', { scope: 'all', workflow: 'manual', singlePass: true });
  job = await request(home, 'home', 'scan-result', { ...auth(job), candidates: [
    { key: 'A', title: '课程 A', page: 1, order: 0, status: 'uninspected', total: null, remaining: null },
    { key: 'B', title: '课程 B', page: 1, order: 1, status: 'uninspected', total: null, remaining: null }
  ] });
  job = await request(home, 'home', 'course-select', {
    ...auth(job), index: 0, candidateKey: 'A', purpose
  });
  job = await request(home, 'home', 'open', { ...auth(job), index: 0, purpose: 'inspect' });
  const worker = c.addTab(LEARN, home);
  job = await request(worker, 'worker', 'hello', { title: '课程 A' });
  job = await request(worker, 'worker', 'directory-checkpoint', { ...auth(job), snapshot: {
    version: 1, items: [
      { key: 'doc', title: '计任务文档', mediaType: 'document', taskItem: true, durationSeconds: null }
    ]
  } });
  return { c, home, worker, job, request };
}

test('手动选择的课程不能借旧跳过命令推进跨课队列', async () => {
  const f = await manualInspection();
  const before = f.job.candidates;
  const skipped = await f.c.request(f.worker, 'worker', 'course-skip', {
    ...auth(f.job), index: 0, title: '课程 A',
    progressPercent: 100, source: 'course-header-progress'
  });
  assert.equal(skipped.ok, false);
  assert.deepEqual(plain(f.c.storage.session[KEY].candidates), plain(before));
  assert.equal(urlNavigations(f.c).length, 0);
});

for (const complete of [true, false]) {
test(`手动授权的本课末轮结束后停止在选课，其他课程不变（完成=${complete}）`, async () => {
  const f = await manualInspection();
  const otherCourse = f.job.candidates[1];
  f.job = await f.request(f.worker, 'worker', 'course-result', {
    ...auth(f.job), result: { total: 1, remaining: 1, unconfirmed: ['计任务文档'] }
  });
  assert.equal(f.job.phase, 'course');
  assert.equal(f.job.operation, 'play');
  assert.equal(f.job.targetPurpose, 'play');
  assert.equal(f.job.ownerTabId, f.worker);
  const premature = await f.c.request(f.worker, 'worker', 'course-result', {
    ...auth(f.job), result: { total: 1, remaining: 1 }
  });
  assert.equal(premature.ok, false, 'cannot return before final verification');
  if (complete) {
    f.job = await f.request(f.worker, 'worker', 'record-completions', {
      ...auth(f.job), entries: [{ key: 'doc', sitePercent: null, completionSource: 'page-marker' }]
    });
  }
  f.job = await f.request(f.worker, 'worker', 'course-result', {
    ...auth(f.job), result: {
      total: 1, remaining: complete ? 0 : 1, finalPass: true,
      unconfirmed: complete ? [] : ['计任务文档']
    }
  });
  assert.equal(f.job.phase, 'selection');
  assert.equal(f.job.running, false);
  assert.equal(f.job.selectedIndex, null);
  assert.equal(f.job.candidates[0].status, complete ? 'completed' : 'manual');
  assert.deepEqual(f.job.candidates[1], otherCourse);
  assert.equal(f.c.tabs.has(f.worker), true);
  assert.equal(f.c.tabs.get(f.home).url, HOME);
  assert.equal(f.c.removed.length, 0);
  assert.equal(urlNavigations(f.c).length, 0);
  const next = await f.c.request(f.home, 'home', 'open', {
    ...auth(f.job), index: 1, purpose: 'inspect'
  });
  assert.equal(next.ok, false, 'finishing A does not authorize B');
});
}

test('单独扫描本课结束后等待用户，不顺带授权播放或其他课程', async () => {
  const f = await manualInspection('inspect');
  const otherCourse = f.job.candidates[1];
  f.job = await f.request(f.worker, 'worker', 'course-result', {
    ...auth(f.job), result: { total: 1, remaining: 1 }
  });
  assert.equal(f.job.phase, 'selection');
  assert.equal(f.job.running, false);
  assert.equal(f.job.operation, '');
  assert.equal(f.job.candidates[0].status, 'inspected');
  assert.equal(f.job.candidates[0].scanState, 'ready');
  assert.deepEqual(f.job.candidates[1], otherCourse);
  assert.equal(f.c.reloads.length, 0);
  assert.equal(urlNavigations(f.c).length, 0);
});

test('手动选课扫描转学习时收到用户暂停，交接不能越过暂停继续执行', async () => {
  const f = await manualInspection(), receiver = { location: { href: LEARN } };
  f.c.connect(f.worker)(receiver);
  let stop;
  receiver.chrome.runtime.onMessage.addListener(message => {
    if (!stop && message.job?.running && message.job.targetPurpose === 'play') {
      stop = f.c.request(f.worker, 'worker', 'pause', auth(f.job));
    }
  });
  const result = await f.request(f.worker, 'worker', 'course-result', {
    ...auth(f.job), result: { total: 1, remaining: 1 }
  });
  assert.ok(stop);
  await stop;
  assert.equal(result.running, false);
  assert.equal(result.phase, 'paused');
  assert.equal(f.c.tabs.has(f.worker), true);
  assert.equal(urlNavigations(f.c).length, 0);
});

for (const area of ['session', 'local']) {
for (const workflow of ['auto', undefined]) {
for (const running of [true, false]) {
test(`旧全课任务迁移后不复活且保留记录（${area}，模式=${workflow || 'legacy'}，运行=${running}）`, async () => {
  const f = await manualInspection();
  let job = await f.request(f.worker, 'worker', 'course-result', {
    ...auth(f.job), result: { total: 1, remaining: 1 }
  });
  job = await f.request(f.worker, 'worker', 'document-visited', { ...auth(job), key: 'doc' });
  // This models a checkpoint written by 1.3.8, not a new playback authorization.
  const legacy = plain(job);
  if (workflow) legacy.workflow = workflow;
  else delete legacy.workflow;
  legacy.running = running;
  legacy.phase = running ? 'course' : 'paused';
  legacy.resumePhase = 'course';
  legacy.expectedRefresh = { token: 'old-refresh', tabId: f.worker, generation: legacy.generation };
  legacy.ownerHandoff = { tabId: f.worker, instanceId: 'departing' };
  legacy.agentDeadline = Date.now() + 45000;
  legacy.entryDeadline = Date.now() + 45000;
  legacy.openDeadline = Date.now() + 45000;
  legacy.returnDeadline = Date.now() + 45000;
  legacy.returningTabId = f.worker;
  legacy.interruption = { id: 'old-recovery', status: 'navigating', attempts: 1 };
  legacy.recoveryRecords = { saved: { video: { title: '未完成视频', attempted: true } } };
  f.c.storage[area][KEY] = legacy;
  if (area === 'local') f.c.restartBrowser();
  f.c.restartWorker();

  const first = await f.request(f.home, 'home', 'get');
  assert.equal(first.running, false);
  assert.equal(first.workflow, 'manual');
  assert.equal(first.phase, 'selection');
  assert.equal(first.operation, '');
  assert.equal(first.selectedIndex, null);
  assert.equal(first.targetIndex, null);
  assert.equal(first.generation, legacy.generation + 1);
  assert.equal(first.ownerInstance, null);
  assert.deepEqual(first.candidates, legacy.candidates);
  assert.deepEqual(first.recoveryRecords, legacy.recoveryRecords);
  assert.deepEqual(plain(first.logs.slice(0, legacy.logs.length)), legacy.logs);
  for (const key of ['resumePhase', 'expectedRefresh', 'ownerHandoff', 'agentDeadline',
    'entryDeadline', 'openDeadline', 'returnDeadline', 'returningTabId', 'interruption']) {
    assert.equal(first[key], undefined, key + ' must not authorize stale work');
  }
  const reconnect = await f.request(f.worker, 'worker', 'hello', {
    ...auth(legacy), reconnect: true, title: '课程 A',
    documentRouteKey: '/student/#/courseInfo/learn/courseWare/course/video/res?classId=class'
  });
  assert.equal(reconnect.running, false);
  assert.equal(reconnect.phase, 'selection');
  assert.equal(reconnect.generation, first.generation);
  const staleContinue = await f.c.request(f.worker, 'worker', 'start', {
    ...auth(legacy), scope: 'all'
  });
  assert.equal(staleContinue.error, 'TASK_CANCELLED');
  const staleResult = await f.c.request(f.worker, 'worker', 'course-result', {
    ...auth(legacy), result: { total: 1, remaining: 0, finalPass: true }
  });
  assert.equal(staleResult.ok, false);
  await f.c.fireAlarm('xinwei-network-retry');
  const latest = await f.request(f.home, 'home', 'get');
  assert.equal(latest.running, false);
  assert.equal(latest.generation, first.generation, 'migration is idempotent');
  assert.deepEqual(latest.candidates, legacy.candidates);
  assert.equal(f.c.storage.local[KEY].workflow, 'manual');
  assert.equal(urlNavigations(f.c).length, 0);
  assert.equal(f.c.reloads.length, 0);
  assert.equal(f.c.removed.length, 0);
});
}
}
}

test('旧的无模式单课任务仍可保留当前课程断点并手动继续', async () => {
  const c = coordinator(), id = c.addTab(LEARN);
  let result = await c.request(id, 'worker', 'start', { title: '当前课程', scope: 'single', singlePass: true });
  assert.equal(result.ok, true, result.error);
  const original = result.job;
  assert.equal(original.scope, 'single');
  assert.equal(original.phase, 'course');
  c.restartWorker();
  result = await c.request(id, 'worker', 'get');
  assert.equal(result.job.runId, original.runId);
  assert.equal(result.job.generation, original.generation);
  assert.equal(result.job.running, true);
  result = await c.request(id, 'worker', 'pause', auth(result.job));
  assert.equal(result.job.phase, 'paused');
  result = await c.request(id, 'worker', 'start', { ...auth(result.job), scope: 'single' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.job.runId, original.runId);
  assert.equal(result.job.running, true);
  assert.equal(result.job.phase, 'course');
  assert.equal(result.job.candidates.length, 1);
  assert.equal(urlNavigations(c).length, 0);
});

test('网站其他页面的一次开始仅导航原标签至真实首页，新文档接管后等待课表入口', async () => {
  const c = coordinator();
  const id = c.addTab(OTHER);
  const otherTab = c.addTab(AGENT);
  let r = await c.request(id, 'departing', 'start', { scope: 'all' });
  assert.equal(r.ok, true);
  assert.equal(r.job.workflow, 'manual');
  assert.equal(r.job.operation, 'list');
  assert.equal(r.job.phase, 'go-agent');
  assert.equal(r.job.scope, 'all');
  assert.equal(r.job.homeTabId, id);
  assert.equal(r.job.ownerTabId, id);
  assert.equal(r.job.candidates.length, 0);
  assert.equal(urlNavigations(c).length, 1);
  assert.deepEqual(urlNavigations(c)[0], { id, url: AGENT, active: true });

  // The browser can show the destination URL before its old page unloads.
  r = await c.request(id, 'departing', 'hello', auth(r.job), OTHER);
  assert.equal(r.job.phase, 'go-agent');
  r = await c.request(otherTab, 'foreign-task', 'hello', {}, AGENT);
  assert.equal(r.job.phase, 'go-agent');
  r = await c.request(otherTab, 'foreign-task', 'start', { scope: 'all' }, AGENT);
  assert.equal(r.job.homeTabId, id);
  assert.equal(urlNavigations(c).length, 1);

  r = await c.request(id, 'agent-new', 'hello', {}, AGENT);
  assert.equal(r.job.phase, 'entry-home');
  assert.equal(r.job.ownerInstance, 'agent-new');
  assert.equal(r.job.homeInstance, 'agent-new');
  assert.equal(r.job.agentDeadline, undefined);
  assert.equal(r.job.agentDepartureInstance, undefined);
  assert.equal(r.job.entryClicked, false);
  assert.ok(r.job.entryDeadline > Date.now());
  assert.equal(urlNavigations(c).length, 1);
});

test('学习页获取课程列表无需课程标题，经首页正常入口扫描后等待手动选课', async () => {
  const c = coordinator();
  const id = c.addTab(LEARN);
  let r = await c.request(id, 'learn-old', 'start', { scope: 'all' });
  assert.equal(r.ok, true);
  assert.equal(r.job.phase, 'go-agent');
  assert.equal(r.job.candidates.length, 0);
  assert.equal(c.tabs.get(id).url, AGENT);
  r = await c.request(id, 'agent-new', 'hello', {}, AGENT);
  assert.equal(r.job.phase, 'entry-home');
  r = await c.request(id, 'agent-new', 'entry-open', auth(r.job), AGENT);
  assert.equal(r.job.entryClicked, true);
  c.tabs.get(id).url = HOME;
  r = await c.request(id, 'agent-new', 'hello', auth(r.job), AGENT);
  assert.equal(r.job.phase, 'scan-home');
  assert.equal(r.job.scope, 'all');
  assert.equal(r.job.workflow, 'manual');
  assert.equal(urlNavigations(c).length, 1);
  r = await c.request(id, 'agent-new', 'scan-result', {
    ...auth(r.job), candidates: [{ key: 'A', title: '课程 A', page: 1, order: 0 }]
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.job.phase, 'selection');
  assert.equal(r.job.running, false);
  assert.equal(urlNavigations(c).length, 1);
});

test('伪装旧站点文档无法从已离站的实际标签启动或重置', async () => {
  const c = coordinator();
  const id = c.addTab(OTHER);
  c.tabs.get(id).url = 'https://example.com/';
  const start = await c.request(id, 'old', 'start', { scope: 'all' }, OTHER);
  assert.equal(start.ok, false);
  assert.match(start.error, /离开网站/);
  const reset = await c.request(id, 'old', 'reset', {}, OTHER);
  assert.equal(reset.ok, false);
  assert.match(reset.error, /网站页面/);
  assert.equal(urlNavigations(c).length, 0);
});

test('开始任务落盘广播期间暂停，不能再导航到首页', async () => {
  const c = coordinator();
  const id = c.addTab(OTHER);
  const page = { location: { href: OTHER } };
  c.connect(id)(page);
  let cancellation;
  page.chrome.runtime.onMessage.addListener(message => {
    if (message.job.phase === 'go-agent' && message.job.running && !cancellation) {
      cancellation = c.request(id, 'old', 'pause', {
        reason: '用户暂停', instanceId: 'old', resetEpoch: 0
      }, OTHER);
    }
  });
  const started = await c.request(id, 'old', 'start', { scope: 'all' }, OTHER);
  assert.ok(cancellation);
  await cancellation;
  const latest = await c.request(id, 'old', 'get', {}, OTHER);
  assert.equal(latest.job.running, false);
  assert.equal(latest.job.phase, 'paused');
  assert.equal(latest.job.resumePhase, 'go-agent');
  assert.equal(urlNavigations(c).length, 0);
});

test('导航交接期间页面刷新先暂停，到达真实首页后仍须用户继续', async () => {
  const c = coordinator();
  const id = c.addTab(OTHER);
  let r = await c.request(id, 'old', 'start', { scope: 'all' });
  const originalDeadline = r.job.agentDeadline;
  // Manual mode fences a replacement document until an explicit Continue.
  c.tabs.get(id).url = OTHER;
  c.restartWorker();
  r = await c.request(id, 'refreshed-old', 'hello', {}, OTHER);
  assert.equal(r.job.phase, 'paused');
  assert.equal(r.job.running, false);
  assert.equal(r.job.resumePhase, 'go-agent');
  assert.equal(r.job.ownerInstance, 'refreshed-old');
  assert.equal(r.job.agentDeadline, originalDeadline);
  assert.equal(urlNavigations(c).length, 1);
  c.tabs.get(id).url = AGENT;
  r = await c.request(id, 'refreshed-old', 'hello', auth(r.job), OTHER);
  assert.equal(r.job.phase, 'paused');
  r = await c.request(id, 'agent-new', 'hello', auth(r.job), AGENT);
  assert.equal(r.job.phase, 'paused');
  assert.equal(r.job.running, false);
  assert.equal(urlNavigations(c).length, 1);
  r = await c.request(id, 'agent-new', 'start', { ...auth(r.job), scope: 'all' }, AGENT);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.job.phase, 'entry-home');
  assert.equal(urlNavigations(c).length, 1);
});

test('旧实例最初加载首页后同文档切到学习页，不能借导航中显示的首页网址误接管', async () => {
  const c = coordinator();
  const id = c.addTab(LEARN);
  // A SPA can keep the original sender URL after changing the live tab URL.
  let r = await c.request(id, 'departing', 'start', { scope: 'all' }, AGENT);
  assert.equal(r.job.phase, 'go-agent');
  assert.equal(c.tabs.get(id).url, AGENT);
  r = await c.request(id, 'departing', 'hello', auth(r.job), AGENT);
  assert.equal(r.job.phase, 'go-agent');
  assert.equal(r.job.ownerInstance, null);
  r = await c.request(id, 'arrived', 'hello', auth(r.job), AGENT);
  assert.equal(r.job.phase, 'entry-home');
  assert.equal(r.job.ownerInstance, 'arrived');
  assert.equal(urlNavigations(c).length, 1);
});

test('首页导航阶段暂停后从站内其他页继续，仅重试一次并保留原任务', async () => {
  const c = coordinator();
  const id = c.addTab(OTHER);
  let r = await c.request(id, 'old', 'start', { scope: 'all' });
  const runId = r.job.runId;
  c.tabs.get(id).url = OTHER;
  r = await c.request(id, 'old', 'pause', auth(r.job), OTHER);
  assert.equal(r.job.resumePhase, 'go-agent');
  r = await c.request(id, 'old', 'start', { ...auth(r.job), scope: 'all' }, OTHER);
  assert.equal(r.ok, true);
  assert.equal(r.job.runId, runId);
  assert.equal(r.job.phase, 'go-agent');
  assert.equal(urlNavigations(c).length, 2);
  r = await c.request(id, 'agent-new', 'hello', {}, AGENT);
  assert.equal(r.job.phase, 'entry-home');
  assert.equal(r.job.runId, runId);
  assert.equal(urlNavigations(c).length, 2);
});

test('到达首页前暂停，从首页点继续承接同一任务，不再导航或清空记录', async () => {
  const c = coordinator();
  const id = c.addTab(OTHER);
  let r = await c.request(id, 'old', 'start', { scope: 'all' });
  const runId = r.job.runId;
  r = await c.request(id, 'old', 'pause', auth(r.job), OTHER);
  assert.equal(r.job.resumePhase, 'go-agent');
  r = await c.request(id, 'agent-new', 'start', { ...auth(r.job), scope: 'all' }, AGENT);
  assert.equal(r.ok, true);
  assert.equal(r.job.runId, runId);
  assert.equal(r.job.phase, 'entry-home');
  assert.equal(r.job.ownerInstance, 'agent-new');
  assert.equal(r.job.entryClicked, false);
  assert.equal(r.job.agentDepartureInstance, undefined);
  assert.equal(urlNavigations(c).length, 1);
});

test('首页导航超时保持任务等待接管；站内其他页的重置进入停止核对流程', async () => {
  const c = coordinator();
  const id = c.addTab(OTHER);
  let r = await c.request(id, 'old', 'start', { scope: 'all' });
  c.storage.session['xinwei-job-v3'].agentDeadline = Date.now() - 1;
  r = await c.request(id, 'old', 'get', {}, OTHER);
  assert.equal(r.job.running, true);
  assert.equal(r.job.phase, 'go-agent');
  assert.equal(r.job.navigationRecovery.attempts, 1);
  assert.equal(urlNavigations(c).length, 1);
  c.tabs.get(id).url = OTHER;
  r = await c.request(id, 'old', 'reset', { resetEpoch: r.job.resetEpoch }, OTHER);
  // The tab exists but has no receiving content script. Production reset now
  // reloads that stale document, then persists an idle empty marker.
  assert.equal(r.ok, true);
  assert.equal(r.job.reason, undefined);
  assert.equal(r.job.phase, 'idle');
  assert.equal(r.job.candidates.length, 0);
  assert.equal(r.job.logs.length, 0);
});

test('暂停后迟到的旧代数继续或重新开始都不能越过新暂停', async () => {
  const c = coordinator();
  const id = c.addTab(OTHER);
  let r = await c.request(id, 'old', 'start', { scope: 'all' });
  const beforePause = r.job;
  c.tabs.get(id).url = OTHER;
  r = await c.request(id, 'old', 'pause', auth(beforePause), OTHER);
  assert.equal(r.job.phase, 'paused');
  assert.ok(r.job.generation > beforePause.generation);
  const staleContinue = await c.request(id, 'old', 'start', { ...auth(beforePause), scope: 'all' }, OTHER);
  assert.equal(staleContinue.error, 'TASK_CANCELLED');
  const staleRestart = await c.request(id, 'old', 'start', {
    ...auth(beforePause), scope: 'all', restart: true
  }, OTHER);
  assert.equal(staleRestart.error, 'TASK_CANCELLED');
  const current = await c.request(id, 'old', 'get', {}, OTHER);
  assert.equal(current.job.phase, 'paused');
  assert.equal(urlNavigations(c).length, 1);
  const resumed = await c.request(id, 'old', 'start', { ...auth(current.job), scope: 'all' }, OTHER);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.job.runId, beforePause.runId);
  assert.equal(resumed.job.running, true);
  assert.equal(urlNavigations(c).length, 2);
});
