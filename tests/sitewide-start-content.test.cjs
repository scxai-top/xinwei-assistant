const assert = require('node:assert/strict');
const test = require('node:test');
const { homeFixture, homeCard, fixture, mediaItem, waitFor } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');

const SITE = 'https://www.beeline-ai.com';
const AGENT = `${SITE}/stu/agent`;
const HOME = `${SITE}/myBank/courseResearch`;
const KEY = 'xinwei-job-v3';

test('手动列表读取暂停后继续同一任务，仍等待用户选课', async () => {
  const c = coordinator(), id = c.addTab(HOME);
  const f = homeFixture([], { connect: c.connect(id) });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    if (f.api.state.syncPromise) await f.api.state.syncPromise;
    f.api.state.jobPromise = Promise.resolve();
    let r = await c.request(id, f.api.state.instanceId, 'start', {
      scope: 'all', workflow: 'manual', singlePass: true
    });
    const runId = r.job.runId;
    r = await c.request(id, f.api.state.instanceId, 'pause', {
      runId, generation: r.job.generation
    });
    f.api.acceptJob(r.job);
    const start = f.window.document.getElementById('wb-start');
    assert.equal(start.textContent, '继续');
    start.click();
    await waitFor(() => !f.api.state.startPending && c.storage.session[KEY]?.running);
    assert.equal(c.storage.session[KEY].runId, runId);
    assert.equal(c.storage.session[KEY].workflow, 'manual');
    assert.equal(c.storage.session[KEY].phase, 'scan-home');
  } finally { f.dom.window.close(); }
});

test('加载旧自动任务只停止并保留记录，晚到的自动播放不能恢复旧队列', async () => {
  const c = coordinator();
  const url = `${SITE}/student/#/courseInfo/learn/courseWare/course-1/video/resource-1?classId=class-1`;
  const id = c.addTab(url);
  const started = await c.request(id, 'old-page', 'start', {
    title: '测试课程', scope: 'single', singlePass: true
  });
  const legacy = JSON.parse(JSON.stringify(started.job));
  Object.assign(legacy, { workflow: 'auto', scope: 'all' });
  legacy.candidates[0].records = { old: { title: '原资源', started: true, confirmed: false } };
  c.storage.session[KEY] = legacy;
  c.restartWorker();
  const f = fixture([mediaItem('原资源')], { url, connect: c.connect(id) });
  let clicks = 0;
  f.window.document.querySelector('.sub-menu-area').addEventListener('click', () => clicks++);
  f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => clicks++);
  try {
    await waitFor(() => f.api.state.job?.phase === 'selection' && !f.api.state.syncPromise);
    assert.equal(f.api.state.running, false);
    assert.equal(f.api.state.job.running, false);
    assert.equal(f.api.state.job.candidates[0].records.old.started, true);
    assert.equal(f.api.state.job.candidates[0].records.old.confirmed, false);
    await f.media.play();
    f.media.dispatchEvent(new f.window.Event('play'));
    assert.equal(f.media.paused, true);
    assert.equal(clicks, 0);
    assert.equal(c.navigation.length, 0);
    assert.equal(c.reloads.length, 0);
  } finally { f.dom.window.close(); }
});

test('站内普通页面显示开始，点击后仅转已确认首页，不直接扫描假课程', async () => {
  const c = coordinator();
  const id = c.addTab(`${SITE}/stu/other`);
  const f = homeFixture([homeCard('普通页面里的无关卡片')], {
    url: `${SITE}/stu/other`, connect: c.connect(id)
  });
  let cardClicks = 0;
  try {
    f.window.document.querySelector('.item-bg-text p.sle').addEventListener('click', () => cardClicks++);
    const start = f.window.document.getElementById('wb-start');
    const panel = f.window.document.getElementById('wb-study-ui');
    const assistant = f.window.document.getElementById('wb-assistant-button');
    assert.equal(panel.hidden, true);
    assert.equal(assistant.hidden, false);
    assistant.click();
    assert.equal(panel.hidden, false);
    assert.equal(start.disabled, false);
    start.click();
    await waitFor(() => c.navigation.some(n => n.id === id && n.url === AGENT));
    assert.equal(c.storage.session[KEY].phase, 'go-agent');
    assert.equal(c.storage.session[KEY].scope, 'all');
    assert.equal(cardClicks, 0);
    assert.equal(c.navigation.filter(n => n.url === AGENT).length, 1);
  } finally { f.dom.window.close(); }
});

test('从学习页获取课程列表先回真实首页，不自动选择课程', async () => {
  const c = coordinator();
  const url = `${SITE}/student/#/courseInfo/learn/courseWare/course/video/resource?classId=class`;
  const id = c.addTab(url);
  const f = fixture([], { url, connect: c.connect(id) });
  try {
    const start = f.window.document.getElementById('wb-start');
    assert.equal(start.disabled, false);
    start.click();
    await waitFor(() => c.navigation.some(n => n.id === id && n.url === AGENT));
    assert.equal(c.storage.session[KEY].scope, 'all');
    assert.equal(c.storage.session[KEY].workflow, 'manual');
    assert.equal(c.storage.session[KEY].candidates.length, 0);
  } finally { f.dom.window.close(); }
});

test('站内页面跳到真实首页后，一次开始自动接到课表', async () => {
  const c = coordinator();
  const id = c.addTab(`${SITE}/foo`);
  const first = homeFixture([], { url: `${SITE}/foo`, connect: c.connect(id) });
  let agent;
  try {
    first.window.document.getElementById('wb-start').click();
    await waitFor(() => c.navigation.some(n => n.url === AGENT));
    first.dom.window.close();
    agent = homeFixture([homeCard('待学课程')], { url: AGENT, connect: c.connect(id) });
    agent.window.document.querySelector('.btn-next').disabled = true;
    const sidebar = agent.window.document.createElement('div');
    sidebar.className = 'my-course-container';
    sidebar.innerHTML = '<a class="timetable">查看所有课表</a>';
    agent.window.document.body.append(sidebar);
    const link = sidebar.querySelector('a');
    link.getClientRects = () => [{ width: 10, height: 10 }];
    let clicked = 0;
    link.addEventListener('click', () => {
      clicked++;
      agent.window.history.replaceState({}, '', HOME);
    });
    await agent.api.syncSharedJob();
    await waitFor(() => clicked === 1);
    await agent.api.syncSharedJob();
    // A verified unchanged home can immediately advance to opening. Assert
    // durable scan evidence instead of sampling a transient home phase.
    await waitFor(() => c.storage.session[KEY].phase === 'selection' &&
      c.storage.session[KEY].candidates[0]?.title === '待学课程');
    assert.equal(c.storage.session[KEY].logs.some(entry =>
      entry.text.startsWith('首页扫描完成：1 门正在上的课程')), true);
    assert.equal(c.storage.session[KEY].candidates[0].title, '待学课程');
    assert.equal(c.navigation.filter(n => n.url === AGENT).length, 1);
    assert.equal(clicked, 1);
  } finally { agent?.dom.window.close(); first.dom.window.close(); }
});

test('非芯位网站不显示面板', () => {
  const f = homeFixture([], { url: 'https://example.com/stu/agent' });
  try {
    assert.equal(f.window.document.getElementById('wb-study-ui').hidden, true);
    assert.equal(f.window.document.getElementById('wb-start').disabled, true);
  } finally { f.dom.window.close(); }
});
