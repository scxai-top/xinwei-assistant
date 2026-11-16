const assert = require('node:assert/strict');
const test = require('node:test');
const { coordinator } = require('./coordinator.cjs');

const COURSE = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course/video/resource?classId=class';
const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
const PROJECT = 'https://www.beeline-ai.com/student/#/courseInfo/course/project/class';
const routeKey = url => { const value = new URL(url); return value.pathname + value.hash; };
const auth = job => ({ runId: job.runId, generation: job.generation, resetEpoch: job.resetEpoch });

async function navigateRecovery() {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const request = async (instance, action, data = {}, documentUrl) => {
    const result = await c.request(id, instance, action, data, documentUrl);
    assert.equal(result.ok, true, result.error);
    return result.job;
  };
  let job = await request('owner', 'start', { title: '课程' });
  job = await request('owner', 'directory-checkpoint', { ...auth(job), snapshot: {
    version: 1, items: [{ key: 'video', title: '原视频', mediaType: 'video', durationSeconds: 60 }]
  } });
  job = await request('owner', 'resource-checkpoint', {
    ...auth(job), key: 'video', title: '原视频', stage: 'ready', routeKey: routeKey(COURSE)
  });
  c.tabs.get(id).url = PROJECT;
  job = await request('owner', 'interruption-attempt', {
    ...auth(job), key: 'video', navigate: true, reason: '误触项目页'
  });
  assert.equal(c.tabs.get(id).url, COURSE);
  assert.equal(job.ownerInstance, null);
  assert.equal(job.interruption.status, 'navigating');
  return { c, id, job, request };
}

async function verifyManualCourseStopsAfterRecovery(kind) {
  const task = await startManualCourseWithWorker();
  const { c, home, worker, request } = task;
  const otherCourse = task.job.candidates[1];
  let job = task.job;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    job = await request(worker, 'worker', 'interruption-attempt', {
      ...auth(job), key: 'video', kind, reason: `播放器环境故障：${kind}`
    });
    assert.equal(job.interruption.attempts, attempt);
    job = await request(worker, 'worker', 'interruption-failed', {
      ...auth(job), episodeId: job.interruption.id,
      kind, reason: `恢复仍未成功：${kind}`
    });
  }

  assert.equal(job.running, false);
  assert.equal(job.phase, 'manual');
  assert.equal(job.resumePhase, 'course');
  assert.equal(job.interruption.status, 'failed');
  assert.equal(job.interruption.attempts, 3);
  assert.equal(job.candidates[0].status, 'inspected');
  assert.notEqual(job.candidates[0].records.video.confirmed, true);
  assert.deepEqual(job.candidates[1], otherCourse);
  assert.equal(job.targetIndex, 0);
  assert.equal(job.selectedIndex, 0);
  const next = await c.request(home, 'home', 'open', {
    ...auth(job), index: 1, purpose: 'inspect'
  });
  assert.equal(next.ok, false, 'failed A does not authorize B');
  assert.equal(c.navigation.some(entry => entry.url), false);
  assert.equal(c.removed.length, 0);
  assert.equal(c.tabs.has(worker), true);
}

async function startManualCourseWithWorker(options) {
  const c = coordinator(options), home = c.addTab(HOME);
  const request = async (tab, instance, action, data = {}, documentUrl) => {
    const result = await c.request(tab, instance, action, data, documentUrl);
    assert.equal(result.ok, true, `${action}: ${result.error}`);
    return result.job;
  };
  let job = await request(home, 'home', 'start', {
    scope: 'all', workflow: 'manual', singlePass: true
  });
  job = await request(home, 'home', 'scan-result', {
    ...auth(job), candidates: [
      { key: 'A', title: '当前课程', page: 1, order: 0 },
      { key: 'B', title: '下一门课程', page: 1, order: 1 }
    ]
  });
  job = await request(home, 'home', 'course-select', {
    ...auth(job), index: 0, candidateKey: 'A', purpose: 'learn'
  });
  job = await request(home, 'home', 'open', {
    ...auth(job), index: 0, purpose: 'inspect'
  });
  const worker = c.addTab(COURSE, home);
  job = await request(worker, 'worker', 'hello', { title: '当前课程' });
  job = await request(worker, 'worker', 'directory-checkpoint', {
    ...auth(job), snapshot: { version: 1, items: [
      { key: 'video', title: '课程视频', mediaType: 'video', durationSeconds: 60 }
    ] }
  });
  job = await request(worker, 'worker', 'course-result', {
    ...auth(job), result: { total: 1, remaining: 1 }
  });
  job = await request(worker, 'worker', 'resource-checkpoint', {
    ...auth(job), key: 'video', title: '课程视频', stage: 'ready', routeKey: routeKey(COURSE)
  });
  job = await request(worker, 'worker', 'record', {
    ...auth(job), key: 'video', result: { title: '课程视频', started: true, attempted: true }
  });
  assert.equal(job.phase, 'course');
  assert.equal(job.targetPurpose, 'play');
  return { c, home, worker, job, request };
}

for (const kind of ['player-error', 'button', 'platform-dialog']) {
  test(`手动单课的${kind}恢复用尽后停止并保留断点，其他课程不变`, () =>
    verifyManualCourseStopsAfterRecovery(kind));
}

test('单课播放页意外关闭后停止并保留断点，不自动重开或选择下一门', async () => {
  const task = await startManualCourseWithWorker();
  const otherCourse = task.job.candidates[1];
  await task.c.closeTab(task.worker);
  const job = await task.request(task.home, 'home', 'get');
  assert.equal(job.running, false);
  assert.equal(job.phase, 'manual');
  assert.equal(job.resumePhase, 'course');
  assert.equal(job.targetIndex, 0);
  assert.equal(job.selectedIndex, 0);
  assert.equal(job.candidates[0].autoClosedTabAttempts, undefined);
  assert.equal(job.candidates[0].records.video.started, true);
  assert.equal(job.candidates[0].directory.items[0].key, 'video');
  assert.deepEqual(job.candidates[1], otherCourse);
  assert.match(job.reason, /页面已关闭/);
  assert.equal(task.c.navigation.some(entry => entry.url), false);
  assert.equal(task.c.reloads.length, 0);
});

test('单课恢复中只收到started记录不能视为恢复成功或调度其他课程', async () => {
  const task = await startManualCourseWithWorker();
  const otherCourse = task.job.candidates[1];
  let job = await task.request(task.worker, 'worker', 'interruption-attempt', {
    ...auth(task.job), key: 'video', kind: 'player-error', reason: '播放器未就绪'
  });
  const episode = job.interruption;
  job = await task.request(task.worker, 'worker', 'record', {
    ...auth(job), key: 'video', result: { title: '课程视频', started: true, attempted: true }
  });
  assert.equal(job.interruption.id, episode.id);
  assert.equal(job.interruption.attempts, 1);
  assert.equal(job.interruption.status, 'attempting');
  assert.notEqual(job.candidates[0].records.video.confirmed, true);
  assert.deepEqual(job.candidates[1], otherCourse);
  assert.equal(job.targetIndex, 0);
  assert.equal(task.c.navigation.some(entry => entry.url), false);
});

test('单课页关闭后后台重启、迟到结果和闹钟不能重新打开本课或推进下一课', async () => {
  const task = await startManualCourseWithWorker();
  await task.c.closeTab(task.worker);
  let job = await task.request(task.home, 'home', 'get');
  const stopped = job;
  task.c.restartWorker();
  job = await task.request(task.home, 'home', 'hello');
  assert.equal(job.running, false);
  assert.equal(job.phase, 'manual');
  const stale = await task.c.request(task.worker, 'worker', 'course-result', {
    ...auth(task.job), result: { total: 1, remaining: 0, finalPass: true }
  }, COURSE);
  assert.equal(stale.ok, false);
  await task.c.fireAlarm('xinwei-network-retry');
  job = await task.request(task.home, 'home', 'get');
  assert.equal(job.running, false);
  assert.equal(job.generation, stopped.generation);
  assert.deepEqual(job.candidates, stopped.candidates);
  assert.equal(task.c.tabs.size, 1);
  assert.equal(task.c.navigation.some(entry => entry.url), false);
  assert.equal(task.c.reloads.length, 0);
});

test('浏览器先显示目标地址时，旧文档未对齐资源不能抢先接回恢复任务', async () => {
  const { request } = await navigateRecovery();
  for (const observed of [
    {},
    { documentRouteKey: routeKey(PROJECT), activeResourceKey: 'video' },
    { documentRouteKey: routeKey(COURSE), activeResourceKey: 'other-video' }
  ]) {
    const waiting = await request('owner', 'hello', { title: '课程', ...observed }, PROJECT);
    assert.equal(waiting.running, true);
    assert.equal(waiting.ownerInstance, null);
    assert.equal(waiting.interruption.status, 'navigating');
    assert.equal(waiting.interruption.attempts, 1);
  }
  const arrived = await request('owner', 'hello', {
    title: '课程', documentRouteKey: routeKey(COURSE), activeResourceKey: 'video'
  }, PROJECT);
  assert.equal(arrived.ownerInstance, 'owner');
  assert.equal(arrived.interruption.status, 'attempting');
  assert.equal(arrived.interruption.attempts, 1);
});

test('导航后的新文档仍可正常接管，旧文档随后消息不能夺回任务', async () => {
  const { request } = await navigateRecovery();
  const arrived = await request('replacement', 'hello', { title: '课程' });
  assert.equal(arrived.ownerInstance, 'replacement');
  assert.equal(arrived.interruption.status, 'attempting');
  const stale = await request('owner', 'hello', {
    title: '课程', documentRouteKey: routeKey(COURSE), activeResourceKey: 'video'
  }, PROJECT);
  assert.equal(stale.ownerInstance, 'replacement');
  assert.equal(stale.interruption.attempts, 1);
});

test('导航接回后再次失败必须消耗下一次预算，不能反复升级同一次恢复', async () => {
  const { c, id, request } = await navigateRecovery();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const owner = `replacement-${attempt}`;
    const arrived = await request(owner, 'hello', { title: '课程' });
    assert.equal(arrived.interruption.attempts, attempt);
    assert.equal(arrived.interruption.navigationAttempt, attempt);
    c.tabs.get(id).url = PROJECT;
    const retried = await request(owner, 'interruption-attempt', {
      ...auth(arrived), key: 'video', episodeId: arrived.interruption.id,
      navigate: true, reason: '导航回来后资源仍不符'
    });
    if (attempt < 3) {
      assert.equal(retried.running, true);
      assert.equal(retried.interruption.attempts, attempt + 1);
    } else {
      assert.equal(retried.running, false);
      assert.equal(retried.phase, 'manual');
      assert.equal(retried.interruption.attempts, 3);
      assert.equal(c.navigation.filter(entry => entry.url).length, 3);
    }
  }
});

test('同次网络故障只刷新一次，等待60秒后暂停，后台重启和迟到闹钟不能追加刷新', async () => {
  const task = await startManualCourseWithWorker();
  const alarmName = 'xinwei-network-retry';
  let job = await task.request(task.worker, 'worker', 'interruption-attempt', {
    ...auth(task.job), key: 'video', kind: 'network', navigate: true, reload: true,
    reason: '课程页面网络加载失败'
  });

  assert.equal(job.interruption.attempts, 1);
  assert.equal(job.interruption.kind, 'network');
  assert.equal(task.c.reloads.length, 1);
  assert.ok(task.c.alarms.has(alarmName));

  task.c.restartWorker();
  task.c.advanceTime(59000);
  await task.c.fireAlarm(alarmName);
  assert.equal(task.c.storage.session['xinwei-job-v3'].running, true);
  assert.equal(task.c.reloads.length, 1);
  task.c.advanceTime(1001);
  await task.c.fireAlarm(alarmName);
  job = task.c.storage.session['xinwei-job-v3'];
  assert.equal(job.running, false);
  assert.equal(job.phase, 'paused');
  assert.match(job.reason, /已尝试一次.*不再自动刷新/);
  assert.equal(job.interruption.attempts, 1);
  assert.equal(task.c.reloads.length, 1);
  assert.equal(job.candidates[0].status, 'inspected');
  assert.equal(job.targetIndex, 0);
  assert.equal(job.interruption.status, 'failed');
  assert.equal(task.c.alarms.has(alarmName), false);
  task.c.advanceTime(120000);
  await task.c.fireAlarm(alarmName);
  assert.equal(task.c.reloads.length, 1);
});

test('浏览器网络错误页只重新打开一次保存资源，不能通过导航绕过一次刷新上限', async () => {
  const task = await startManualCourseWithWorker();
  const currentTab = task.c.tabs.get(task.worker);
  currentTab.pendingUrl = 'chrome-error://chromewebdata/';

  const job = await task.request(task.worker, 'worker', 'interruption-attempt', {
    ...auth(task.job), key: 'video', kind: 'network', navigate: true, reload: true,
    reason: '课程页面网络加载失败'
  });

  assert.equal(job.running, true);
  assert.equal(job.interruption.attempts, 1);
  assert.ok(task.c.alarms.has('xinwei-network-retry'));
  assert.equal(task.c.reloads.length, 0);
  assert.equal(task.c.navigation.at(-1).url, COURSE);
  const navigationCount = task.c.navigation.filter(entry => entry.url).length;
  task.c.tabs.get(task.worker).url = 'chrome-error://chromewebdata/';
  task.c.advanceTime(60001);
  await task.c.fireAlarm('xinwei-network-retry');
  assert.equal(task.c.storage.session['xinwei-job-v3'].phase, 'paused');
  assert.equal(task.c.navigation.filter(entry => entry.url).length, navigationCount);
});

for (const nextAction of ['interruption-failed', 'interruption-attempt', 'course-refresh', 'reload-course']) {
  test(`网络刷新接回后${nextAction}不能更换错误类型或入口再刷新`, async () => {
    const task = await startManualCourseWithWorker();
    let job = await task.request(task.worker, 'worker', 'interruption-attempt', {
      ...auth(task.job), key: 'video', kind: 'network', navigate: true, reload: true,
      reason: '网络连接中断'
    });
    job = await task.request(task.worker, 'worker-new', 'hello', {
      ...auth(job), title: '当前课程', documentRouteKey: routeKey(COURSE), activeResourceKey: 'video'
    });
    assert.equal(job.interruption.status, 'attempting');
    job = await task.request(task.worker, 'worker-new', nextAction, {
      ...auth(job), ...(nextAction === 'course-refresh' ? {} : { key: 'video' }),
      episodeId: job.interruption.id,
      kind: 'directory-load', navigate: true, reload: true, token: 'alternate-refresh',
      routeKey: routeKey(COURSE), reason: '页面仍未就绪'
    });
    assert.equal(job.running, false);
    assert.equal(job.phase, 'paused');
    assert.equal(job.interruption.kind, 'network');
    assert.equal(task.c.reloads.length, 1);
    assert.equal(task.c.navigation.filter(entry => entry.url).length, 0);
    assert.match(job.reason, /不再自动刷新/);
  });
}

test('一次网络刷新被浏览器拒绝后仍消耗额度，不连续重发刷新', async () => {
  let reloadAttempts = 0;
  const task = await startManualCourseWithWorker({
    beforeReload: async () => { reloadAttempts += 1; throw new Error('reload refused'); }
  });
  const c = task.c;
  let job = await task.request(task.worker, 'worker', 'interruption-attempt', {
    ...auth(task.job), key: 'video', kind: 'network', navigate: true, reload: true,
    reason: '网络连接中断'
  });
  c.restartWorker();
  c.advanceTime(60001);
  job = await task.request(task.home, 'home', 'get');
  assert.equal(job.running, false);
  assert.equal(reloadAttempts, 1);
  assert.equal(c.reloads.length, 0);
  assert.notEqual(job.candidates[0].records.video.confirmed, true);
});

test('恢复成功也保留网络刷新时间，新故障不足60秒不刷新，超过间隔才允许一次', async () => {
  for (const elapsed of [8001, 60001]) {
    const task = await startManualCourseWithWorker();
    let job = await task.request(task.worker, 'worker', 'interruption-attempt', {
      ...auth(task.job), key: 'video', kind: 'network', navigate: true, reload: true,
      reason: '第一次网络故障'
    });
    assert.equal(job.logs.at(-1).eventCode, 'recovery-started');
    assert.equal(job.logs.at(-1).resourceKey, 'video');
    assert.equal(job.logs.some(entry => entry.eventCode === 'recovery-verified'), false);
    const refreshAt = job.lastNetworkRefreshAt;
    job = await task.request(task.worker, 'worker-new', 'hello', { title: '当前课程' });
    job = await task.request(task.worker, 'worker-new', 'interruption-position', {
      ...auth(job), episodeId: job.interruption.id, key: 'video',
      routeKey: routeKey(COURSE), position: 0
    });
    task.c.advanceTime(elapsed);
    job = await task.request(task.worker, 'worker-new', 'interruption-success', {
      ...auth(job), episodeId: job.interruption.id, key: 'video', evidence: {
        courseKey: job.candidates[0].courseKey, key: 'video', routeKey: routeKey(COURSE),
        from: 0, to: 8, elapsedMs: 8000
      }
    });
    assert.equal(job.interruption, undefined);
    assert.equal(job.lastNetworkRefreshAt, refreshAt);
    assert.equal(job.logs.at(-1).eventCode, 'recovery-verified');
    assert.equal(job.logs.at(-1).resourceKey, 'video');
    task.c.restartWorker();
    job = await task.request(task.worker, 'worker-new', 'interruption-attempt', {
      ...auth(job), key: 'video', kind: 'network', navigate: true, reload: true,
      reason: '恢复后出现新的网络故障'
    });
    assert.equal(task.c.reloads.length, elapsed < 60000 ? 1 : 2);
    assert.equal(job.running, elapsed >= 60000);
    if (elapsed < 60000) {
      assert.match(job.reason, /不足60秒/);
      assert.equal(job.logs.at(-1).eventCode, 'task-paused');
    }
    else assert.equal(job.interruption.navigationAttempt, 1);
  }
});

test('继续前学习标签落到站点根页时保留断点并记录路由证据，不导航或完成课程', async () => {
  const task = await startManualCourseWithWorker();
  const paused = await task.request(task.worker, 'worker', 'pause', {
    ...auth(task.job), reason: '用户暂停'
  });
  assert.equal(paused.phase, 'paused');
  task.c.tabs.get(task.worker).url = 'https://www.beeline-ai.com/';
  task.c.tabs.get(task.worker).title = '芯位蜜线';

  const resumed = await task.request(task.home, 'home', 'start', {
    ...auth(paused), scope: 'all', workflow: 'manual', singlePass: true
  });

  assert.equal(resumed.running, false);
  assert.equal(resumed.phase, 'paused');
  assert.match(resumed.reason, /继续前路由核对未通过/);
  assert.match(resumed.reason, /当前任务页=site \/|当前任务页=site/);
  assert.match(resumed.reason, /预期资源=课程视频/);
  assert.ok(resumed.logs.some(entry => /继续操作未执行：.*当前任务页=site/.test(entry.text)));
  assert.equal(resumed.candidates[0].status, 'inspected');
  assert.equal(resumed.candidates[0].remaining, 1);
  assert.equal(resumed.candidates[0].records.video.ended, undefined);
  assert.equal(task.c.navigation.some(entry => Object.hasOwn(entry, 'url')), false);
});

test('继续时原任务页显示登录入口信号则转人工处理，不强行打开保存课程', async () => {
  const task = await startManualCourseWithWorker();
  const paused = await task.request(task.worker, 'worker', 'pause', {
    ...auth(task.job), reason: '用户暂停'
  });
  task.c.tabs.get(task.worker).url = 'https://www.beeline-ai.com/';
  task.c.tabs.get(task.worker).title = '芯位蜜线';

  const resumed = await task.request(task.worker, 'worker', 'start', {
    ...auth(paused), scope: 'all', workflow: 'manual', singlePass: true,
    pageBlocked: '当前站点入口显示登录按钮，无法确认已登录'
  });

  assert.equal(resumed.running, false);
  assert.equal(resumed.phase, 'manual');
  assert.match(resumed.reason, /登录按钮/);
  assert.ok(resumed.logs.some(entry => /继续操作未执行：.*登录按钮/.test(entry.text)));
  assert.equal(task.c.navigation.some(entry => Object.hasOwn(entry, 'url')), false);
  assert.equal(resumed.candidates[0].records.video.ended, undefined);
});
