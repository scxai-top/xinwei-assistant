const assert = require('node:assert/strict');
const test = require('node:test');
const { homeFixture, homeCard, homeCardContent, waitFor } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');

test('首页只采集正在上的课程，已结课课程不进入待选列表', () => {
  const f = homeFixture([
    homeCard('课程 A', '正在上课'),
    homeCard('课程 B', '已结课')
  ]);
  try {
    const cards = f.api.getHomeCourseCards();
    const candidates = cards.map((card, index) => f.api.getHomeCourseCandidate(card, 1, index)).filter(Boolean);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].title, '课程 A');
    assert.equal(candidates[0].key, '课程 A');
  } finally { f.dom.window.close(); }
});

test('课表显示进度只作为参考，不代替用户选择及本课目录核对', () => {
  const f = homeFixture([
    homeCardContent('已完成课程', '正在上课', 100),
    homeCardContent('未完成课程', '正在上课', 99)
  ]);
  try {
    const candidates = f.api.getHomeCourseCards()
      .map((card, index) => f.api.getHomeCourseCandidate(card, 1, index));
    assert.deepEqual(Array.from(candidates, candidate => candidate.timetablePercent), [100, 99]);
  } finally { f.dom.window.close(); }
});

test('采集分页课程卡片，忽略隐藏且不随分页更新的课程摘要条目', () => {
  const html = `<div class="left-img-course-item" style="display:none">
      <div class="card-item"><div class="course-name"><p>隐藏摘要课程</p></div>
        <div class="right-course-info"><p class="name">隐藏摘要课程</p><div class="class-name">旧摘要班</div>
          <div class="course-status">正在上课</div></div></div>
    </div>
    <div class="course-page">
      ${homeCardContent('课程 A')}
      ${homeCardContent('课程 B', '已结课')}
    </div>`;
  const f = homeFixture([]);
  try {
    f.window.document.querySelector('.cards').innerHTML = html;
    const cards = f.api.getHomeCourseCards();
    const candidates = cards.map((card, index) => f.api.getHomeCourseCandidate(card, 1, index)).filter(Boolean);
    assert.equal(cards.length, 2);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].title, '课程 A');
    assert.equal(candidates[0].key, '课程 A');
  } finally { f.dom.window.close(); }
});

test('扫描课表保留100%课程供用户选择，不把课表进度直接当成本课复核', async () => {
  const f = homeFixture([homeCardContent('已完成课程', '正在上课', 100)]);
  try {
    f.window.document.querySelector('.btn-next').disabled = true;
    f.api.state.running = true;
    const courses = await f.api.scanHomeCourses(f.api.state.epoch);
    assert.equal(courses.length, 1);
    assert.equal(courses[0].timetablePercent, 100);
    assert.equal(courses[0].status, 'uninspected');
    assert.equal(courses[0].remaining, null);
    assert.equal(courses[0].completionEvidence, undefined);
  } finally { f.dom.window.close(); }
});

test('任务存在扩展后台，不使用网站 localStorage 或 sessionStorage', async () => {
  const c = coordinator();
  const id = c.addTab('https://www.beeline-ai.com/myBank/courseResearch');
  const result = await c.request(id, 'home', 'start');
  assert.equal(result.ok, true);
  const saved = JSON.stringify(c.storage);
  assert.match(saved, /scan-home/);
  assert.doesNotMatch(saved, /password|currentTime|token/);
  const fs = require('node:fs');
  assert.doesNotMatch(fs.readFileSync('content.js', 'utf8'), /localStorage|sessionStorage\.get/);
});

test('分页扫描读取更新中的课程卡片，而不是隐藏且保持不变的摘要', async () => {
  const f = homeFixture([homeCard('第1页')]);
  try {
    let page = 1;
    const doc = f.window.document;
    doc.querySelector('.cards').innerHTML = `<div class="left-img-course-item" style="display:none">
      <div class="card-item"><div class="course-name"><p>隐藏摘要课程</p></div>
        <div class="right-course-info"><p class="name">隐藏摘要课程</p><div class="class-name">摘要班</div>
          <div class="course-status">正在上课</div></div></div>
      </div><div class="course-page">${homeCardContent('第1页')}</div>`;
    // Only page 1 is visible. Page 2/3 cannot be reached by numeric buttons.
    doc.querySelectorAll('li.number')[1].remove();
    const next = doc.querySelector('.btn-next');
    next.addEventListener('click', () => {
      page += 1;
      doc.querySelector('li.number').textContent = String(page);
      setTimeout(() => {
        doc.querySelector('.course-page').innerHTML = homeCardContent(`第${page}页`);
        next.disabled = page === 3;
      }, 400);
    });
    f.api.state.running = true;
    const courses = await f.api.scanHomeCourses(f.api.state.epoch);
    assert.equal(courses.map(c => c.title).join(','), '第1页,第2页,第3页');
  } finally { f.dom.window.close(); }
});

test('重复课程名称不能静默去重，避免错选课程', async () => {
  const f = homeFixture([homeCard('重复'), homeCard('重复')]);
  try {
    f.api.state.running = true;
    await assert.rejects(f.api.scanHomeCourses(f.api.state.epoch), /课程名称重复/);
  } finally { f.dom.window.close(); }
});

test('旧全课任务缺少入口时停止并保留记录，不自行重新点击课程', async () => {
  const c = coordinator();
  const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
  const KEY = 'xinwei-job-v3';
  const home = c.addTab(HOME);
  c.storage.session[KEY] = {
    version: 3, runId: 'legacy-queue', generation: 4, revision: 1, resetEpoch: 0,
    scope: 'all', running: true, phase: 'home', homeTabId: home, ownerTabId: home,
    ownerInstance: 'old-home', workerTabId: null, targetIndex: null,
    candidates: [{ title: '课程', key: '课程', page: 1, status: 'inspected', remaining: 1,
      records: { unfinished: { title: '尚未结束视频', started: true, ended: false } } }], logs: []
  };
  const h = homeFixture([homeCard('课程')], { connect: c.connect(home) });
  try {
    let clicks = 0;
    h.window.document.querySelector('.item-bg-text p.sle').addEventListener('click', () => clicks++);
    await h.api.syncSharedJob();
    const job = h.api.state.job;
    assert.equal(job.running, false);
    assert.equal(job.workflow, 'manual');
    assert.equal(job.phase, 'selection');
    assert.equal(job.runId, 'legacy-queue');
    assert.equal(job.candidates[0].records.unfinished.started, true);
    assert.equal(job.candidates[0].records.unfinished.ended, false);
    assert.equal(clicks, 0);
    assert.equal(c.navigation.some(n => n.url), false);
  } finally { h.dom.window.close(); }
});

test('旧全课开始命令现在只读取列表，读取结束不点击任何课程', async () => {
  const c = coordinator();
  const home = c.addTab('https://www.beeline-ai.com/myBank/courseResearch');
  const h = homeFixture([homeCard('课程 A'), homeCard('课程 B')], { connect: c.connect(home) });
  try {
    h.window.document.querySelector('.btn-next').disabled = true;
    let clicks = 0;
    h.window.document.querySelector('.cards').addEventListener('click', () => clicks++);
    await h.api.jobCommand('start', { scope: 'all', singlePass: true });
    await h.api.syncSharedJob();
    await waitFor(() => h.api.state.job?.phase === 'selection');
    assert.equal(h.api.state.job.running, false);
    assert.equal(h.api.state.job.workflow, 'manual');
    assert.deepEqual(Array.from(h.api.state.job.candidates, course => course.title), ['课程 A', '课程 B']);
    assert.equal(clicks, 0);
    assert.equal(c.navigation.filter(n => n.url).length, 0);
    assert.equal(c.tabs.size, 1);
  } finally { h.dom.window.close(); }
});
