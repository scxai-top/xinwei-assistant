const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { fixture, mediaItem, waitFor, homeFixture } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');

function recoveryFixture(options = {}) {
  const f = fixture([mediaItem('恢复测试')], { duration: 60, confirmationTimeout: 10, ...options });
  const item = f.api.getMenuItems()[0];
  item.classList.add('is-active');
  f.api.state.running = true;
  Object.assign(f.api.CFG, {
    recoveryWaitMin: 0, recoveryWaitMax: 0, identityStableTime: 0,
    gatewayPauseGrace: 10, stallTimeout: 1000, mediaLoadTimeout: 30,
    resourceRetryDelay: 30, backgroundRetryDelay: 1
  });
  let seeking = false;
  Object.defineProperty(f.media, 'seeking', { get: () => seeking });
  const key = f.api.getItemKey(item);
  return {
    ...f, item, key,
    setSeeking(value) { seeking = value; },
    seek(to) {
      seeking = true;
      f.advanceNaturally(to);
      f.media.dispatchEvent(new f.window.Event('seeking'));
      seeking = false;
      f.media.dispatchEvent(new f.window.Event('seeked'));
    },
    async begin(wrapper = false) {
      this.task = (wrapper ? f.api.playItemWithRecovery : f.api.playItemToEnd)(item, 0, f.api.currentCourseKey());
      this.task.catch(() => {});
      await waitFor(() => !f.media.paused && f.api.state.processedItems.get(key)?.playbackAttempt?.after);
      f.media.dispatchEvent(new f.window.Event('playing'));
      f.advanceNaturally(10);
      await new Promise(resolve => setTimeout(resolve, 15));
    },
    finish() {
      item.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
      f.advanceNaturally(60, true);
      f.media.dispatchEvent(new f.window.Event('ended'));
    }
  };
}

function setPausedCourseJob(f) {
  const { state } = f.api;
  state.running = false;
  state.mode = 'paused';
  state.tabId = 1;
  state.job = {
    runId: 'route-recovery-test', generation: 4, resetEpoch: 0,
    running: false, phase: 'paused', resumePhase: 'course',
    workflow: 'manual', scope: 'all', singlePass: true, targetPurpose: 'play',
    operation: 'play', selectedIndex: 0,
    homeTabId: 1, workerTabId: 1, ownerTabId: 1, ownerInstance: state.instanceId,
    targetIndex: 0,
    candidates: [{
      courseKey: f.api.currentCourseKey(), title: '测试课程', status: 'inspected',
      directory: f.api.getDirectorySnapshot(), records: {}
    }]
  };
}

test('站点根页可见登录入口被识别为人工确认边界，仅限根页', () => {
  const root = recoveryFixture({ url: 'https://www.beeline-ai.com/' });
  const course = recoveryFixture();
  try {
    const login = root.window.document.createElement('a');
    login.href = '/login';
    login.textContent = '登录';
    login.getClientRects = () => [{ width: 40, height: 24 }];
    root.window.document.body.append(login);
    assert.match(root.api.getBlockingNotice(), /登录按钮/);

    const courseLogin = course.window.document.createElement('a');
    courseLogin.href = '/login';
    courseLogin.textContent = '登录';
    courseLogin.getClientRects = () => [{ width: 40, height: 24 }];
    course.window.document.body.append(courseLogin);
    assert.equal(course.api.getBlockingNotice(), '');
  } finally {
    root.dom.window.close();
    course.dom.window.close();
  }
});

test('继续命令被后台按路由拒绝时不误报保存失败，真实存储失败仍单独显示', async () => {
  for (const response of [
    { ok: false, error: '继续前路由核对未通过', errorCode: 'TASK_COMMAND_REJECTED' },
    { ok: false, error: '任务状态无法保存', errorCode: 'TASK_STORAGE_FAILURE' }
  ]) {
    const f = recoveryFixture();
    try {
      setPausedCourseJob(f);
      f.window.chrome.runtime.sendMessage = async message => message.action === 'start'
        ? { ...response, tabId: 1 }
        : { ok: true, job: f.api.state.job, tabId: 1 };

      await f.api.start();

      assert.equal(f.api.state.storageFailed, response.errorCode === 'TASK_STORAGE_FAILURE');
      assert.equal(f.api.state.manualNotice, response.error);
      assert.equal(f.window.document.getElementById('wb-status').textContent,
        response.errorCode === 'TASK_STORAGE_FAILURE' ? '需要人工处理' : '任务操作未执行');
      if (response.errorCode === 'TASK_COMMAND_REJECTED') {
        assert.match(f.api.state.logBox.textContent, /任务命令未执行（start）/);
        assert.match(f.api.state.logBox.textContent, /课程=测试课程/);
      }
    } finally { f.dom.window.close(); }
  }
});

test('单课保留网络错误原文与分类，平台提示仍按既有边界停止', async () => {
  const f = recoveryFixture();
  try {
    const notice = f.window.document.createElement('div');
    notice.className = 'el-message--error';
    notice.textContent = '网络连接失败 ERR_CONNECTION_CLOSED';
    notice.getClientRects = () => [{ width: 240, height: 32 }];
    f.window.document.body.appendChild(notice);
    Object.assign(f.api.state, {
      running: true,
      activeGeneration: 0,
      tabId: 1,
      job: { workflow: 'manual', scope: 'all', running: true, generation: 0,
        ownerTabId: 1, ownerInstance: f.api.state.instanceId }
    });

    assert.equal(f.api.getRetryablePlatformSignal(), notice.textContent);
    assert.equal(f.api.isNetworkFailureText(f.api.getRetryablePlatformSignal()), true);
    assert.equal(f.api.hasNetworkFailureEvidence(), true);
    assert.throws(() => f.api.assertRunning(0), error =>
      error.constructor.name === 'TaskCancelled'
    );
    assert.equal(f.api.state.running, false);
    assert.equal(f.api.isNetworkFailureText('网络课程加载完成'), false);
    assert.equal(f.api.isNetworkFailureText('普通课程加载失败'), false);
    assert.equal(f.api.isNetworkFailureText('连接成功'), false);
    assert.equal(f.api.isNetworkFailureText('请求超时'), true);
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally { f.dom.window.close(); }
});

async function networkWaitingFixture() {
  const url = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/resource-1?classId=class-1';
  const c = coordinator(), id = c.addTab(url);
  const f = fixture([mediaItem('网络恢复视频')], { connect: c.connect(id) });
  await new Promise(resolve => setTimeout(resolve, 0));
  if (f.api.state.syncPromise) await f.api.state.syncPromise;
  // Prepare a persisted resource before releasing the real course executor.
  f.api.state.jobPromise = Promise.resolve();
  f.api.getMenuItems()[0].classList.add('is-active');
  await f.api.jobCommand('start', { title: '测试课程', scope: 'single' });
  await f.api.jobCommand('directory-checkpoint', { snapshot: f.api.getDirectorySnapshot() });
  await f.api.jobCommand('resource-checkpoint', {
    key: f.api.getItemKey(f.api.getMenuItems()[0]), title: '网络恢复视频', stage: 'ready',
    routeKey: new URL(url).pathname + new URL(url).hash
  });
  let online = false;
  Object.defineProperty(f.window.navigator, 'onLine', { get: () => online });
  Object.assign(f.api.CFG, {
    networkRetryDelay: 100, networkRecoveryWait: 150,
    recoveryWaitMin: 0, recoveryWaitMax: 0, identityStableTime: 0
  });
  f.api.state.jobPromise = null;
  const startedAt = Date.now();
  await f.api.syncSharedJob();
  await waitFor(() => f.window.document.getElementById('wb-status').textContent === '等待网络恢复');
  return { ...f, c, startedAt, setOnline(value) { online = value; }, async close() {
    // A successful reload has already disposed the old document transport.
    if (!c.reloads.length) await f.api.stop(false);
    await Promise.allSettled([f.api.state.jobPromise, f.api.state.syncPromise]);
    f.dom.window.close();
  } };
}

test('短暂断网先等待复核，自行恢复后继续播放而不刷新', async () => {
  const f = await networkWaitingFixture();
  try {
    assert.equal(f.c.reloads.length, 0);
    assert.equal(f.c.navigation.length, 0);
    f.setOnline(true);
    await waitFor(() => !f.media.paused);
    assert.equal(f.api.state.job.running, true);
    assert.equal(f.c.reloads.length, 0);
    assert.equal(f.c.navigation.length, 0);
  } finally { await f.close(); }
});

test('断网持续存在时等待结束才刷新一次，保留原课程断点', async () => {
  const f = await networkWaitingFixture();
  try {
    assert.equal(f.c.reloads.length, 0);
    await waitFor(() => f.c.reloads.length === 1);
    assert.ok(Date.now() - f.startedAt >= f.api.CFG.networkRetryDelay);
    const job = f.c.storage.session['xinwei-job-v3'];
    assert.equal(job.interruption.kind, 'network');
    assert.equal(job.interruption.navigationAttempt, 1);
    assert.equal(job.targetIndex, 0);
    assert.notEqual(job.candidates[0].records?.[job.interruption.key]?.confirmed, true);
    assert.equal(f.c.navigation.length, 0);
  } finally { await f.close(); }
});

test('用户在网络等待期间暂停，等待到期后不再刷新或启动播放', async () => {
  const f = await networkWaitingFixture();
  try {
    await f.api.stop();
    await Promise.allSettled([f.api.state.jobPromise, f.api.state.syncPromise]);
    await new Promise(resolve => setTimeout(resolve, f.api.CFG.networkRetryDelay + 20));
    assert.equal(f.c.storage.session['xinwei-job-v3'].phase, 'paused');
    assert.equal(f.c.reloads.length, 0);
    assert.equal(f.c.navigation.length, 0);
    assert.equal(f.media.paused, true);
  } finally { await f.close(); }
});

test('播放中的小幅位置校准与向后恢复继续观察，不把seek事件本身当人工停止', async () => {
  const f = recoveryFixture();
  try {
    await f.begin();
    f.seek(10.2);
    await new Promise(resolve => setTimeout(resolve, 15));
    f.seek(8);
    f.advanceNaturally(8.2);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(f.api.state.running, true);
    assert.equal(f.api.state.processedItems.get(f.key).progressGap, undefined);
    f.finish();
    const result = await f.task;
    assert.equal(result.ended, true);
    assert.equal(result.confirmed, true);
    assert.equal(result.playbackAttempt.seekAdjustments.length, 2);
    assert.equal(result.playbackAttempt.seekAdjustments.every(entry => !entry.jumpedForward), true);
  } finally { f.dom.window.close(); }
});

test('自然播放的时间推进不依赖测试时钟或稀疏轮询推断为跳进度', async () => {
  const f = recoveryFixture();
  try {
    await f.begin();
    // A background tab can be sampled infrequently. Without a seek event,
    // normal progression is not classified as a user changing the position.
    f.advanceNaturally(35);
    await new Promise(resolve => setTimeout(resolve, 10));
    f.finish();
    const result = await f.task;
    assert.equal(result.ended, true);
    assert.equal(result.progressGap, null);
  } finally { f.dom.window.close(); }
});

test('后台标签页计时器长时间挂起不会误报播放卡住', async () => {
  const f = recoveryFixture({ duration: 60 });
  let visibility = 'hidden';
  Object.defineProperty(f.window.document, 'visibilityState', {
    configurable: true, get: () => visibility
  });
  try {
    const task = f.api.playItemToEnd(f.item, 0, f.api.currentCourseKey());
    let settled = false;
    task.finally(() => { settled = true; }).catch(() => {});
    await waitFor(() => f.api.state.processedItems.get(f.key)?.playbackAttempt?.after);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(settled, false, '隐藏页面不应因为定时器挂起触发 stalled 恢复');
    f.advanceNaturally(1);
    f.media.dispatchEvent(new f.window.Event('playing'));
    await new Promise(resolve => setTimeout(resolve, 15));
    visibility = 'visible';
    f.item.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
    f.advanceNaturally(60, true);
    f.media.dispatchEvent(new f.window.Event('ended'));
    const result = await task;
    assert.equal(result.ended, true);
  } finally { f.dom.window.close(); }
});

test('明显前跳保存缺口；后来ended和页面完成标记不能抹去缺口', async () => {
  const f = recoveryFixture();
  try {
    await f.begin();
    f.seek(40);
    await assert.rejects(f.task, error => error instanceof f.api.RecoverableError && error.kind === 'progress-gap');
    const record = f.api.state.processedItems.get(f.key);
    assert.ok(record.progressGap.from <= 10.1);
    assert.equal(record.progressGap.to, 40);
    assert.equal(record.ended, false);
    f.finish();
    assert.equal(f.api.state.processedItems.get(f.key).ended, false);
    f.api.state.resourceCheckpoint = null;
    const retry = f.api.playItemToEnd(f.item, 0, f.api.currentCourseKey());
    await assert.rejects(retry, /未确认的播放区间/);
    assert.equal(f.api.state.processedItems.get(f.key).progressGap.to, 40);
  } finally { f.dom.window.close(); }
});

test('网站自行回到缺口前并自然覆盖后才允许清除缺口', async () => {
  const f = recoveryFixture({ duration: 1 });
  try {
    f.api.state.processedItems.set(f.key, {
      title: '恢复测试', started: true, ended: false, confirmed: false,
      progressGap: { from: 0.05, to: 0.1 }
    });
    f.api.CFG.seekTolerance = 0.01;
    const task = f.api.playItemToEnd(f.item, 0, f.api.currentCourseKey());
    task.catch(() => {});
    await waitFor(() => !f.media.paused);
    f.media.dispatchEvent(new f.window.Event('playing'));
    for (let i = 1; i <= 6; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      f.advanceNaturally(i * 0.025);
    }
    f.item.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
    f.advanceNaturally(1, true);
    f.media.dispatchEvent(new f.window.Event('ended'));
    const result = await task;
    assert.equal(result.progressGap, null);
    assert.equal(result.ended, true);
  } finally { f.dom.window.close(); }
});

test('普通网站暂停无需网关证据也能重新点击可见播放按钮并继续', async () => {
  const f = recoveryFixture();
  try {
    const button = f.window.document.querySelector('.vjs-big-play-button');
    let clicks = 0, apiPlays = 0;
    button.addEventListener('click', () => { clicks += 1; });
    f.media.play = () => { apiPlays += 1; throw new Error('不允许调用媒体play'); };
    await f.begin(true);
    f.media.pause();
    f.media.dispatchEvent(new f.window.Event('pause'));
    await waitFor(() => clicks === 2 && !f.media.paused);
    f.media.dispatchEvent(new f.window.Event('playing'));
    f.advanceNaturally(11);
    f.finish();
    const result = await f.task;
    assert.equal(result.confirmed, true);
    assert.equal(result.recovery.attempts, 1);
    assert.equal(apiPlays, 0);
  } finally { f.dom.window.close(); }
});

test('单页普通播放失败最多三次恢复后报错并保留断点，不再刷新或暂缓', async () => {
  const f = recoveryFixture();
  try {
    f.api.CFG.stallTimeout = 10;
    const button = f.window.document.querySelector('.vjs-big-play-button');
    const inert = button.cloneNode(true);
    inert.getClientRects = () => [{ width: 1, height: 1 }];
    button.replaceWith(inert);
    let clicks = 0;
    inert.addEventListener('click', () => { clicks += 1; });
    const task = f.api.playItemWithRecovery(f.item, 0, f.api.currentCourseKey());
    await assert.rejects(task, error => {
      assert.equal(error instanceof f.api.DeferredResource, false);
      assert.match(error.message, /三次|3次|恢复/);
      return true;
    });
    const record = f.api.state.processedItems.get(f.key);
    assert.equal(record.recovery.attempts, 3);
    assert.equal(record.recovery.nextRetryAt, 0);
    assert.equal(record.recovery.reloads || 0, 0);
    assert.equal(record.ended, false);
    assert.equal(record.confirmed, false);
    assert.equal(clicks, 4, 'initial try plus three recovery tries');
    assert.equal(f.api.state.reloadPending, false);
    assert.equal(f.api.state.resourceCheckpoint.key, f.key);
  } finally { f.dom.window.close(); }
});

test('恢复等待期间用户暂停立即取消后续播放点击', async () => {
  const f = recoveryFixture();
  try {
    f.api.CFG.recoveryWaitMin = 200;
    f.api.CFG.recoveryWaitMax = 200;
    let clicks = 0;
    f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { clicks += 1; });
    await f.begin(true);
    f.media.pause();
    f.media.dispatchEvent(new f.window.Event('pause'));
    await waitFor(() => f.api.state.processedItems.get(f.key)?.recovery?.attempts === 1);
    await f.api.stop();
    await assert.rejects(f.task, error => error.constructor.name === 'TaskCancelled');
    assert.equal(clicks, 1);
    assert.equal(f.media.paused, true);
  } finally { f.dom.window.close(); }
});

test('验证码仍会立即停止，不进入普通恢复', async () => {
  const f = recoveryFixture();
  try {
    await f.begin(true);
    const notice = f.window.document.createElement('div');
    notice.textContent = '请完成安全验证';
    f.window.document.body.append(notice);
    f.media.pause();
    f.media.dispatchEvent(new f.window.Event('pause'));
    await assert.rejects(f.task, error => error.constructor.name === 'TaskCancelled');
    assert.equal(f.api.state.mode, 'manual');
    assert.equal(f.api.state.processedItems.get(f.key)?.recovery?.attempts, undefined);
  } finally { f.dom.window.close(); }
});

test('没有用户选课授权时不能从列表自动挑选下一门', async () => {
  const f = homeFixture([]);
  try {
    let commands = 0;
    f.window.chrome.runtime.sendMessage = async () => { commands++; return { ok: true }; };
    f.api.state.job = { workflow: 'manual', phase: 'home', selectedIndex: null,
      candidates: [{ title: '课程 A', status: 'inspected', remaining: 10 },
        { title: '课程 B', status: 'inspected', remaining: 1 }] };
    await assert.rejects(f.api.runHomeJob(f.api.state.epoch), /请先选择一门课程/);
    assert.equal(commands, 0);
  } finally { f.dom.window.close(); }
});

test('短暂后台读取失败会重连；诊断日志失败不会停止任务', async () => {
  let failGet = false, getTries = 0;
  const f = recoveryFixture({ chrome: { runtime: { sendMessage: async message => {
    if (message.action === 'get' && failGet) {
      getTries += 1;
      if (getTries < 3) throw new Error('message port closed');
    }
    if (message.action === 'log') throw new Error('log not saved');
    return { ok: true, job: null, tabId: 1 };
  } } } });
  try {
    failGet = true;
    await f.api.jobCommand('get');
    assert.equal(getTries, 3);
    assert.equal(f.api.state.storageFailed, false);
  } finally { f.dom.window.close(); }
});

async function disconnectedOwner() {
  const c = coordinator();
  const id = c.addTab('https://www.beeline-ai.com/myBank/courseResearch');
  const f = homeFixture([], { connect: c.connect(id) });
  await new Promise(resolve => setTimeout(resolve, 0));
  if (f.api.state.syncPromise) await f.api.state.syncPromise;
  // Keep this check focused on communication, without starting page scanning.
  f.api.state.jobPromise = Promise.resolve();
  const r = await c.request(id, f.api.state.instanceId, 'start', { scope: 'all', workflow: 'manual' });
  f.api.acceptJob(r.job);
  Object.assign(f.api.CFG, { backgroundRetryDelay: 1, backgroundProbeDelay: 0 });
  const transport = f.window.chrome.runtime.sendMessage;
  let unavailable = true;
  const actions = [];
  f.window.chrome.runtime.sendMessage = message => {
    actions.push(message.action);
    return unavailable ? Promise.reject(new Error('message port closed')) : transport(message);
  };
  await f.api.syncSharedJob();
  return { ...f, c, id, actions, restore: () => { unavailable = false; } };
}

test('快速重连耗尽后仍低频探测，原任务经后台新代数授权后可继续', async () => {
  const f = await disconnectedOwner();
  try {
    const before = f.api.state.job;
    assert.equal(f.api.state.storageFailed, true);
    assert.equal(f.actions.includes('manual'), false, 'temporary disconnect is not a user/manual stop');
    assert.equal((await f.c.request(f.id, f.api.state.instanceId, 'get')).job.running, true);
    f.restore();
    await f.api.syncSharedJob();
    assert.equal(f.api.state.storageFailed, false);
    assert.equal(f.api.state.job.runId, before.runId);
    assert.equal(f.api.state.job.generation, before.generation + 1);
    assert.ok(f.api.state.job.generation > f.api.state.localMediaStop.generation);
  } finally { f.dom.window.close(); }
});

test('失联期间用户已暂停，重新连接不能自动续跑', async () => {
  const f = await disconnectedOwner();
  try {
    const job = f.api.state.job;
    await f.c.request(f.id, f.api.state.instanceId, 'pause', {
      runId: job.runId, generation: job.generation
    });
    f.restore();
    await f.api.syncSharedJob();
    assert.equal(f.api.state.storageFailed, false);
    assert.equal(f.api.state.job.running, false);
    assert.equal(f.actions.includes('hello'), false);
  } finally { f.dom.window.close(); }
});

test('后台永不响应时命令有期限，并保留错误类型而非永久悬挂', async () => {
  const f = homeFixture([], { chrome: { runtime: { sendMessage: () => new Promise(() => {}) } } });
  try {
    f.api.CFG.backgroundMessageTimeout = 20;
    await assert.rejects(f.api.jobCommand('get'), error =>
      error.code === 'BACKGROUND_TIMEOUT' && error.action === 'get');
  } finally { f.dom.window.close(); }
});

test('实现仍不写进度、不改倍速、不调用媒体播放API、不合成结束', () => {
  const code = fs.readFileSync('content.js', 'utf8');
  assert.doesNotMatch(code, /\.currentTime\s*=(?!=)/);
  assert.doesNotMatch(code, /\.playbackRate\s*=(?!=)/);
  assert.doesNotMatch(code, /\.play\s*\(/);
  assert.doesNotMatch(code, /dispatchEvent\s*\([^;]*(?:ended|seeked)/);
});

for (const status of [401, 403]) {
  test(`精确网站上报返回${status}保留停止，不能按普通暂停自动点击恢复`, async () => {
    const f = recoveryFixture();
    try {
      const entries = [];
      Object.defineProperty(f.window.performance, 'getEntriesByType', { value: () => entries });
      let clicks = 0;
      f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => { clicks += 1; });
      await f.begin(true);
      const now = Date.now();
      entries.push({
        name: 'https://www.beeline-ai.com/api/learning-service/admin/studentLearning/videoLearnProcessReport',
        responseStatus: status, initiatorType: 'fetch',
        startTime: now - 2 - f.window.performance.timeOrigin,
        responseEnd: now - f.window.performance.timeOrigin
      });
      f.media.pause();
      f.media.dispatchEvent(new f.window.Event('pause'));
      await assert.rejects(f.task, /登录或权限已受限制/);
      assert.equal(clicks, 1);
      assert.equal(f.api.state.processedItems.get(f.key)?.recovery?.attempts, undefined);
    } finally { f.dom.window.close(); }
  });
}

test('同资源媒体节点重建后重新绑定，保留正常播放，不操作旧播放器', async () => {
  const f = recoveryFixture();
  try {
    let pauses = 0;
    const oldPause = f.media.pause;
    f.media.pause = () => { pauses += 1; oldPause(); };
    await f.begin(true);
    const replacement = f.window.document.createElement('video');
    let current = 10, ended = false;
    Object.defineProperties(replacement, {
      readyState: { get: () => 4 }, duration: { get: () => 60 },
      currentTime: { get: () => current }, paused: { get: () => ended }, ended: { get: () => ended },
      currentSrc: { get: () => f.media.currentSrc }, playbackRate: { get: () => 1 }
    });
    replacement.pause = () => { pauses += 1; };
    f.media.replaceWith(replacement);
    await waitFor(() => f.api.state.processedItems.get(f.key)?.recovery?.attempts === 1);
    await waitFor(() => f.api.state.processedItems.get(f.key)?.playbackAttempt?.before?.currentTime === 10);
    current = 11;
    await new Promise(resolve => setTimeout(resolve, 20));
    replacement.dispatchEvent(new f.window.Event('playing'));
    f.item.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
    current = 60; ended = true;
    replacement.dispatchEvent(new f.window.Event('ended'));
    const result = await f.task;
    assert.equal(result.ended, true);
    assert.equal(result.confirmed, true);
    assert.equal(pauses, 0);
  } finally { f.dom.window.close(); }
});

test('播放器重建的长等待不能当作已观看，暂停的新节点前跳仍保留缺口', async () => {
  const f = recoveryFixture();
  try {
    await f.begin(true);
    let offset = 0;
    const originalNow = f.window.Date.now.bind(f.window.Date);
    f.window.Date.now = () => originalNow() + offset;
    f.api.CFG.recoveryWaitMin = 50;
    f.api.CFG.recoveryWaitMax = 50;
    f.api.CFG.mediaLoadTimeout = 20000;
    const player = f.media.parentElement;
    f.media.remove();
    await waitFor(() => f.api.state.processedItems.get(f.key)?.recovery?.attempts === 1);
    offset += 15000;
    const replacement = f.window.document.createElement('video');
    Object.defineProperties(replacement, {
      readyState: { get: () => 4 }, duration: { get: () => 60 },
      currentTime: { get: () => 20 }, paused: { get: () => true }, ended: { get: () => false },
      currentSrc: { get: () => f.media.currentSrc }, playbackRate: { get: () => 1 }
    });
    replacement.pause = () => {};
    player.append(replacement);
    await waitFor(() => f.api.state.processedItems.get(f.key)?.progressGap?.to === 20);
    const record = f.api.state.processedItems.get(f.key);
    assert.ok(record.progressGap.from <= 10.1);
    assert.equal(record.ended, false);
    assert.equal(record.confirmed, false);
    await f.api.stop();
    await assert.rejects(f.task, error => error.constructor.name === 'TaskCancelled');
  } finally { f.dom.window.close(); }
});

test('恢复手势中网站已自行播放时跳过最终点击，避免再次暂停', async () => {
  const f = recoveryFixture();
  try {
    const button = f.window.document.querySelector('.vjs-big-play-button');
    let clicks = 0, presses = 0;
    button.addEventListener('click', () => { clicks += 1; });
    button.addEventListener('mousedown', () => {
      presses += 1;
      if (presses === 2) {
        // This is the fake website restoring normal playback, not extension API use.
        f.media.play();
        f.window.document.querySelector('.video-js').classList.remove('vjs-paused');
        f.media.dispatchEvent(new f.window.Event('playing'));
      }
    });
    await f.begin(true);
    f.media.pause();
    f.media.dispatchEvent(new f.window.Event('pause'));
    await waitFor(() => presses === 2);
    await new Promise(resolve => setTimeout(resolve, 200));
    f.finish();
    await f.task;
    assert.equal(clicks, 1);
  } finally { f.dom.window.close(); }
});

test('暂停消息携带尚未保存的前跳缺口，暂停仍立即生效', async () => {
  const messages = [];
  const f = recoveryFixture({ chrome: { runtime: { sendMessage: async message => {
    messages.push(message);
    return { ok: true, job: null, tabId: 1 };
  } } } });
  try {
    f.api.state.resourceCheckpoint = { key: f.key, routeKey: f.window.location.pathname + f.window.location.hash };
    f.api.state.processedItems.set(f.key, { progressGap: { from: 10, to: 40 } });
    await f.api.jobCommand('pause');
    const pause = messages.find(message => message.action === 'pause');
    assert.deepEqual(JSON.parse(JSON.stringify(pause.gapEvidence)), {
      key: f.key, from: 10, to: 40, round: 0, courseKey: f.api.currentCourseKey()
    });
  } finally { f.dom.window.close(); }
});

for (const completesSeek of [true, false]) {
  test(`seeking等待${completesSeek ? '结束' : '超时'}不计为观看时长，前跳缺口立即保留`, async () => {
    const f = recoveryFixture();
    try {
      await f.begin();
      const realNow = f.window.Date.now;
      let offset = 0;
      f.window.Date.now = () => realNow() + offset;
      f.api.CFG.mediaLoadTimeout = 20000;
      // Start from a normal 10s observation; the website seek jumps to 20s.
      // A long seek wait must not justify this forward jump.
      f.advanceNaturally(20);
      f.setSeeking(true);
      f.media.dispatchEvent(new f.window.Event('seeking'));
      offset = completesSeek ? 10000 : 25000;
      if (completesSeek) {
        f.setSeeking(false);
        f.media.dispatchEvent(new f.window.Event('seeked'));
      }
      await assert.rejects(f.task, error => error instanceof f.api.RecoverableError && error.kind === 'progress-gap');
      const gap = f.api.state.processedItems.get(f.key).progressGap;
      assert.ok(gap.from <= 10.1);
      assert.equal(gap.to, 20);
      assert.equal(f.api.state.processedItems.get(f.key).ended, false);
    } finally { f.dom.window.close(); }
  });
}
