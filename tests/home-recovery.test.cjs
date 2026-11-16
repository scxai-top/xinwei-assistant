const assert = require('node:assert/strict');
const test = require('node:test');
const { homeFixture, homeCard, waitFor } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');

const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
const KEY = 'xinwei-job-v3';

async function stopFixture(f) {
  if (f.api.state.job?.running) await f.api.stop();
  else {
    f.api.state.running = false;
    f.api.state.epoch += 1;
  }
  if (f.api.state.jobPromise) await f.api.state.jobPromise;
  if (f.api.state.syncPromise) await f.api.state.syncPromise;
  f.dom.window.close();
}

async function blockedInspection() {
  const c = coordinator();
  const id = c.addTab(HOME);
  const f = homeFixture([homeCard('弹窗测试课程')], { connect: c.connect(id) });
  const doc = f.window.document;
  doc.querySelector('.btn-next').disabled = true;
  let clicks = 0;
  const entry = doc.querySelector('.item-bg-text p.sle');
  entry.addEventListener('click', () => { clicks += 1; });
  const expire = () => {
    const job = c.storage.session[KEY];
    job.openDeadline = Date.now() - 1;
    if (job.navigationRecovery) job.navigationRecovery.nextRetryAt = Date.now() - 1;
  };
  return { c, id, f, doc, entry, expire, clicks: () => clicks };
}

async function beginInspection(f) {
  await f.api.start();
  await waitFor(() => f.api.state.job?.phase === 'selection' && !f.api.state.jobPromise);
  await f.api.start({ purpose: 'inspect', index: 0, candidateKey: f.api.state.job.candidates[0].key });
}

test('统计弹窗被拦截时实际点击两次重试，耗尽后提示授权，点击继续可再次打开', async () => {
  const { c, id, f, doc, entry, expire, clicks } = await blockedInspection();
  try {
    await beginInspection(f);
    await waitFor(() => clicks() === 1 && !f.api.state.jobPromise);
    const runId = c.storage.session[KEY].runId;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      expire();
      await f.api.syncSharedJob();
      await waitFor(() => clicks() === attempt + 1 && !f.api.state.jobPromise);
      assert.equal(c.storage.session[KEY].openRecovery.attempts, attempt);
      await f.api.syncSharedJob();
      assert.equal(clicks(), attempt + 1, 'Polling must not replay a consumed retry');
    }
    expire();
    await f.api.syncSharedJob();
    assert.equal(clicks(), 3);
    assert.equal(f.api.state.job.phase, 'manual');
    assert.match(doc.getElementById('wb-manual-list').textContent, /允许本站弹出窗口或新标签页/);
    let worker;
    entry.addEventListener('click', () => {
      worker = c.addTab('https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/popup/video/resource?classId=class', id);
    }, { once: true });
    doc.getElementById('wb-start').click();
    await waitFor(() => worker && c.storage.session[KEY].workerTabId === worker);
    assert.equal(clicks(), 4);
    assert.equal(c.storage.session[KEY].runId, runId);
    const result = await c.request(worker, 'popup-worker', 'hello', { title: '弹窗测试课程' });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.job.phase, 'course');
    assert.equal(result.job.openRecovery, undefined);
  } finally { await stopFixture(f); }
});

test('课程页没有 openerTabId 时按同窗口待认领握手接管，等待期间不重复点击', async () => {
  const { c, id, f, entry, expire, clicks } = await blockedInspection();
  let worker;
  entry.addEventListener('click', () => {
    if (!worker) worker = c.addTab(
      'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/popup/video/resource?classId=class',
      undefined,
      { windowId: 1 }
    );
  }, { once: true });
  try {
    await beginInspection(f);
    await waitFor(() => clicks() === 1 && !f.api.state.jobPromise);
    await waitFor(() => c.storage.session[KEY].pendingOpenTabIds?.includes(worker));

    expire();
    await f.api.syncSharedJob();
    assert.equal(clicks(), 1, 'A created course page must suppress another synthetic click');
    assert.equal(c.storage.session[KEY].running, true);
    assert.equal(c.storage.session[KEY].workerTabId, null, 'The page is not owned before its handshake');

    const result = await c.request(worker, 'unlinked-course-page', 'hello', { title: '弹窗测试课程' });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.job.workerTabId, worker);
    assert.ok(result.job.createdTabIds.includes(worker));
    assert.equal(result.job.phase, 'course');
    assert.deepEqual(result.job.pendingOpenTabIds, []);
    assert.equal(result.job.openRecovery, undefined);
  } finally { await stopFixture(f); }
});

for (const scenario of ['missing-event', 'other-opener']) {
  test(`新课程页${scenario === 'missing-event' ? '未收到创建事件' : '带有其他来源标识'}仍经核对接管，旧页不接管`, async () => {
    const { c, f, entry, expire, clicks } = await blockedInspection();
    const url = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/popup/video/resource?classId=class';
    const oldPage = c.addTab(url);
    let worker;
    entry.addEventListener('click', () => {
      worker = c.addTab(url, scenario === 'other-opener' ? oldPage : undefined,
        { emitCreated: scenario !== 'missing-event' });
    }, { once: true });
    try {
      await beginInspection(f);
      await waitFor(() => worker && clicks() === 1 && !f.api.state.jobPromise);
      let response = await c.request(oldPage, 'existing-page', 'hello', { title: '弹窗测试课程' });
      assert.equal(response.job.workerTabId, null);
      expire();
      await f.api.syncSharedJob();
      assert.equal(clicks(), 1, 'An existing new course page must prevent another click');
      assert.ok(c.storage.session[KEY].pendingOpenTabIds.includes(worker));
      response = await c.request(worker, 'new-page', 'hello', { title: '弹窗测试课程' });
      assert.equal(response.ok, true, response.error);
      assert.equal(response.job.workerTabId, worker);
      assert.equal(response.job.phase, 'course');
    } finally { await stopFixture(f); }
  });
}

test('没有创建事件的新页可主动握手，错误窗口和错误课程均不能接管', async () => {
  const { c, f, clicks } = await blockedInspection();
  const url = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/popup/video/resource?classId=class';
  try {
    await beginInspection(f);
    await waitFor(() => clicks() === 1 && !f.api.state.jobPromise);
    const wrongWindow = c.addTab(url, undefined, { windowId: 2, emitCreated: false });
    const wrongCourse = c.addTab(url, undefined, { emitCreated: false });
    let response = await c.request(wrongWindow, 'wrong-window', 'hello', { title: '弹窗测试课程' });
    assert.equal(response.job.workerTabId, null);
    response = await c.request(wrongCourse, 'wrong-title', 'hello', { title: '其他课程' });
    assert.equal(response.job.workerTabId, null);
    assert.ok(response.job.ignoredOpenTabIds.includes(wrongCourse));
    const worker = c.addTab(url, undefined, { emitCreated: false });
    response = await c.request(worker, 'fresh-page', 'hello', { title: '弹窗测试课程' });
    assert.equal(response.ok, true, response.error);
    assert.equal(response.job.workerTabId, worker);
    assert.equal(response.job.phase, 'course');
  } finally { await stopFixture(f); }
});

test('待认领页必须核对窗口、课程名称；旧页不能接管，新空白页只有限等待', async () => {
  const { c, id, f, expire, clicks } = await blockedInspection();
  const url = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/popup/video/resource?classId=class';
  const oldPage = c.addTab(url);
  try {
    await beginInspection(f);
    await waitFor(() => clicks() === 1 && !f.api.state.jobPromise);
    assert.equal((await c.request(oldPage, 'old', 'hello', { title: '弹窗测试课程' })).job.workerTabId, null);
    const otherWindow = c.addTab(url, undefined, { windowId: 2 });
    let job = (await c.request(otherWindow, 'other-window', 'hello', { title: '弹窗测试课程' })).job;
    assert.equal(job.workerTabId, null);
    assert.equal(job.pendingOpenTabIds.includes(otherWindow), false);
    const wrongCourse = c.addTab(url);
    job = (await c.request(wrongCourse, 'wrong-course', 'hello', { title: '另一个课程' })).job;
    assert.equal(job.workerTabId, null);
    assert.equal(job.pendingOpenTabIds.includes(wrongCourse), false);
    const pending = c.addTab('about:blank');
    await c.request(id, f.api.state.instanceId, 'get');
    for (let wait = 0; wait < 2; wait++) {
      expire();
      await f.api.syncSharedJob();
      assert.equal(clicks(), 1);
      assert.equal(c.storage.session[KEY].running, true);
      assert.ok(c.storage.session[KEY].pendingOpenTabIds.includes(pending));
    }
    expire();
    await f.api.syncSharedJob();
    assert.equal(clicks(), 1);
    assert.equal(c.storage.session[KEY].running, false);
    assert.match(c.storage.session[KEY].reason, /已打开但尚未接回/);
  } finally { await stopFixture(f); }
});

test('统计重试执行器忙时不丢失授权，空闲后只点击一次', async () => {
  const { f, doc, expire, clicks } = await blockedInspection();
  try {
    await beginInspection(f);
    await waitFor(() => clicks() === 1 && !f.api.state.jobPromise);
    f.api.state.jobPromise = Promise.resolve();
    expire();
    await f.api.syncSharedJob();
    assert.equal(clicks(), 1);
    f.api.state.jobPromise = null;
    await f.api.syncSharedJob();
    await waitFor(() => clicks() === 2 && !f.api.state.jobPromise);
    await f.api.syncSharedJob();
    assert.equal(clicks(), 2);
  } finally { await stopFixture(f); }
});

for (const cancel of ['pause', 'late-tab', 'late-unlinked-tab']) {
  test(`统计重试手势期间${cancel === 'pause' ? '用户暂停' : cancel === 'late-tab' ? '原标签迟到' : '无 opener 原标签迟到'}取消最终点击`, async () => {
    const { c, id, f, doc, entry, expire, clicks } = await blockedInspection();
    try {
      await beginInspection(f);
      await waitFor(() => clicks() === 1 && !f.api.state.jobPromise);
      let cancelTask;
      entry.addEventListener('mousedown', () => {
        if (cancel === 'pause') cancelTask = f.api.stop();
        else {
          const worker = c.addTab('https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/popup/video/resource?classId=class',
            cancel === 'late-tab' ? id : undefined);
          cancelTask = c.request(id, f.api.state.instanceId, 'get').then(() => worker);
        }
      }, { once: true });
      expire();
      await f.api.syncSharedJob();
      await waitFor(() => cancelTask && !f.api.state.jobPromise);
      await cancelTask;
      await f.api.syncSharedJob();
      assert.equal(clicks(), 1);
      const job = c.storage.session[KEY];
      if (cancel === 'pause') assert.equal(job.running, false);
      else if (cancel === 'late-tab') assert.ok(Number.isInteger(job.workerTabId));
      else assert.equal(job.pendingOpenTabIds.length, 1);
    } finally { await stopFixture(f); }
  });
}

for (const obstruction of ['empty', 'loading']) {
  test(`课表${obstruction === 'empty' ? '暂时为空' : '加载提示持续'}超时后保留同一任务，页面就绪自动恢复扫描`, async () => {
    const c = coordinator();
    const id = c.addTab(HOME);
    const f = homeFixture(obstruction === 'empty' ? [] : [homeCard('待采集课程')], {
      connect: c.connect(id), directoryLoadTimeout: 400
    });
    const doc = f.window.document;
    doc.querySelector('.btn-next').disabled = true;
    let loading;
    if (obstruction === 'loading') {
      loading = doc.createElement('div');
      loading.className = 'el-loading-mask';
      doc.body.append(loading);
    }
    f.api.CFG.resourceRetryDelay = 100;
    try {
      doc.getElementById('wb-start').click();
      await waitFor(() => f.api.state.logBox.textContent.includes('稍后自动重试'));
      const interrupted = c.storage.session[KEY];
      assert.equal(interrupted.running, true);
      assert.equal(interrupted.phase, 'scan-home');
      assert.equal(interrupted.candidates.length, 0, 'A partial/empty list must not be submitted');
      const runId = interrupted.runId;
      if (loading) loading.remove();
      else doc.querySelector('.cards').innerHTML = homeCard('待采集课程');
      await waitFor(() => c.storage.session[KEY]?.phase === 'selection', 6000);
      const resumed = c.storage.session[KEY];
      assert.equal(resumed.runId, runId);
      assert.equal(resumed.running, false);
      assert.deepEqual(resumed.candidates.map(item => item.title), ['待采集课程']);
      assert.equal(resumed.targetPurpose || '', '');
    } finally { await stopFixture(f); }
  });
}

test('分页页码先变化但卡片未更新：超时重试不采集旧卡或再次翻页，卡片到达后扫描完整列表', async () => {
  const f = homeFixture([homeCard('第一页课程')], { directoryLoadTimeout: 400 });
  const doc = f.window.document;
  const active = doc.querySelector('li.number.is-active');
  const next = doc.querySelector('.btn-next');
  const prev = doc.querySelector('.btn-prev');
  let nextClicks = 0, prevClicks = 0, delayCards = true;
  const display = page => {
    active.textContent = String(page);
    doc.querySelector('.cards').innerHTML = homeCard(page === 1 ? '第一页课程' : '第二页课程');
    next.disabled = page === 2;
    prev.disabled = page === 1;
  };
  next.addEventListener('click', () => {
    nextClicks += 1;
    active.textContent = '2';
    next.disabled = true;
    if (!delayCards) display(2);
  });
  prev.addEventListener('click', () => { prevClicks += 1; display(1); });
  try {
    await f.api.syncSharedJob();
    f.api.state.running = true;
    await assert.rejects(f.api.scanHomeCourses(f.api.state.epoch), error =>
      error instanceof f.api.RecoverableError && /列表尚未加载/.test(error.message));
    assert.equal(f.api.state.running, true);
    assert.equal(nextClicks, 1);
    assert.equal(prevClicks, 0);

    // A second executor round sees the new page number with the old cards.
    // It must preserve the pending transition instead of navigating backwards
    // and accidentally accepting a late response from the first click.
    await assert.rejects(f.api.scanHomeCourses(f.api.state.epoch), error =>
      error instanceof f.api.RecoverableError);
    assert.equal(nextClicks, 1);
    assert.equal(prevClicks, 0);

    delayCards = false;
    display(2);
    const result = await f.api.scanHomeCourses(f.api.state.epoch);
    assert.deepEqual(Array.from(result, item => [item.title, item.page]), [
      ['第一页课程', 1], ['第二页课程', 2]
    ]);
    assert.equal(prevClicks, 1, 'Only a settled page 2 can be followed by a fresh scan from page 1');
    assert.equal(nextClicks, 2);
  } finally { await stopFixture(f); }
});

test('正常分页点击被暂时忽略后，任务等待再尝试并自动采集全部页，不要求第二次开始', async () => {
  const c = coordinator();
  const id = c.addTab(HOME);
  const f = homeFixture([homeCard('第一页课程')], { connect: c.connect(id), directoryLoadTimeout: 400 });
  const doc = f.window.document;
  const next = doc.querySelector('.btn-next');
  const prev = doc.querySelector('.btn-prev');
  const clickedAt = [];
  let recoveryNoticeAt = 0;
  f.api.CFG.resourceRetryDelay = 120;
  const display = page => {
    doc.querySelector('li.number.is-active').textContent = String(page);
    doc.querySelector('.cards').innerHTML = homeCard(page === 1 ? '第一页课程' : '第二页课程');
    next.disabled = page === 2;
    prev.disabled = page === 1;
  };
  next.addEventListener('click', () => {
    clickedAt.push(Date.now());
    if (clickedAt.length > 1) display(2);
  });
  prev.addEventListener('click', () => display(1));
  try {
    doc.getElementById('wb-start').click();
    await waitFor(() => f.api.state.logBox.textContent.includes('稍后自动重试'));
    recoveryNoticeAt = Date.now();
    const runId = c.storage.session[KEY].runId;
    assert.equal(clickedAt.length, 1);
    assert.equal(c.storage.session[KEY].phase, 'scan-home');
    assert.equal(c.storage.session[KEY].running, true);
    await waitFor(() => c.storage.session[KEY]?.phase === 'selection', 9000);
    assert.equal(c.storage.session[KEY].runId, runId);
    assert.deepEqual(c.storage.session[KEY].candidates.map(item => [item.title, item.page]), [
      ['第一页课程', 1], ['第二页课程', 2]
    ]);
    assert.ok(clickedAt[1] - recoveryNoticeAt >= 100, 'The retry must honor the configured recovery wait');
    // Recovery first settles the old page change; a fresh complete scan then
    // visits both pages again. These are three authorized forward clicks.
    assert.equal(clickedAt.length, 3);
  } finally { await stopFixture(f); }
});

test('用户在分页恢复等待中暂停后，迟到卡片与后台同步不会继续翻页或提交扫描结果', async () => {
  const c = coordinator();
  const id = c.addTab(HOME);
  const f = homeFixture([homeCard('第一页课程')], { connect: c.connect(id), directoryLoadTimeout: 400 });
  const doc = f.window.document;
  let pageClicks = 0;
  f.api.CFG.resourceRetryDelay = 800;
  doc.querySelector('.btn-next').addEventListener('click', () => {
    pageClicks += 1;
    doc.querySelector('li.number.is-active').textContent = '2';
  });
  doc.querySelector('.btn-prev').addEventListener('click', () => { pageClicks += 1; });
  try {
    doc.getElementById('wb-start').click();
    await waitFor(() => f.api.state.logBox.textContent.includes('稍后自动重试'));
    assert.equal(pageClicks, 1);
    doc.getElementById('wb-stop').click();
    await waitFor(() => c.storage.session[KEY]?.phase === 'paused');
    if (f.api.state.jobPromise) await f.api.state.jobPromise;
    doc.querySelector('.cards').innerHTML = homeCard('第二页迟到课程');
    doc.querySelector('.btn-next').disabled = true;
    await f.api.syncSharedJob();
    await new Promise(resolve => setTimeout(resolve, 850));
    await f.api.syncSharedJob();
    assert.equal(c.storage.session[KEY].running, false);
    assert.equal(c.storage.session[KEY].phase, 'paused');
    assert.equal(c.storage.session[KEY].candidates.length, 0);
    assert.equal(pageClicks, 1);
  } finally { await stopFixture(f); }
});

test('分页按下期间当前页卡片更新导致取消最终点击，重新识别后同一任务仍能扫描全部页', async () => {
  const c = coordinator();
  const id = c.addTab(HOME);
  const f = homeFixture([homeCard('第一页课程')], { connect: c.connect(id), directoryLoadTimeout: 400 });
  const doc = f.window.document;
  const next = doc.querySelector('.btn-next');
  const prev = doc.querySelector('.btn-prev');
  let changed = false, nextClicks = 0;
  f.api.CFG.resourceRetryDelay = 120;
  const display = page => {
    doc.querySelector('li.number.is-active').textContent = String(page);
    doc.querySelector('.cards').innerHTML = homeCard(page === 1 ? '第一页课程' : '第二页课程');
    next.disabled = page === 2;
    prev.disabled = page === 1;
  };
  next.addEventListener('mousedown', () => {
    if (changed) return;
    changed = true;
    // The website updates ordinary card text while the humanlike click is
    // in progress. The guarded final click must be cancelled, then retried
    // after a fresh stable-page observation rather than waiting forever.
    doc.querySelector('.course-card-item').append('课程状态刚刚更新');
  });
  next.addEventListener('click', () => { nextClicks += 1; display(2); });
  prev.addEventListener('click', () => display(1));
  try {
    doc.getElementById('wb-start').click();
    await waitFor(() => f.api.state.logBox.textContent.includes('稍后自动重试'));
    const runId = c.storage.session[KEY].runId;
    assert.equal(changed, true);
    assert.equal(nextClicks, 0, 'The stale-page final click must not be issued');
    assert.equal(c.storage.session[KEY].running, true);
    assert.equal(c.storage.session[KEY].phase, 'scan-home');
    assert.equal(c.storage.session[KEY].candidates.length, 0);
    await waitFor(() => c.storage.session[KEY]?.phase === 'selection', 6000);
    assert.equal(c.storage.session[KEY].runId, runId);
    assert.equal(c.storage.session[KEY].running, false);
    assert.deepEqual(c.storage.session[KEY].candidates.map(item => [item.title, item.page]), [
      ['第一页课程', 1], ['第二页课程', 2]
    ]);
    assert.equal(nextClicks, 1);
  } finally { await stopFixture(f); }
});
