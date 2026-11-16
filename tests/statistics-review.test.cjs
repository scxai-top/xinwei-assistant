const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, mediaItem, homeFixture } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');
const { documentRow } = require('./document-fixture.cjs');
// Synthetic resource rows and history, never a captured platform DOM or progress write.
const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
const URL = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/resource-1?classId=class-1';
const plain = value => JSON.parse(JSON.stringify(value));
const close = f => { f.api.state.running = false; f.window.close(); };
const title = row => row.querySelector('.lecture-title')?.textContent || row.textContent.trim();
function progress(f, row, percent) {
  const node = f.window.document.createElement('span');
  node.className = 'progress-text';
  node.textContent = `已观看 ${percent}%`;
  node.getClientRects = () => [{ width: 90, height: 20 }];
  row.append(node);
  return node;
}
function scanLog(f) {
  return f.api.state.logEntries.findLast(entry => entry.eventCode === 'directory-scan-completed' &&
    entry.evidence?.platformConfirmedCount != null);
}
async function inspection(rows) {
  const c = coordinator(), home = c.addTab(HOME);
  const command = async (id, instance, action, payload = {}) => {
    const response = await c.request(id, instance, action, payload);
    assert.equal(response.ok, true, response.error);
    return response.job;
  };
  let job = await command(home, 'home', 'start', { workflow: 'manual', scope: 'all', singlePass: true });
  const auth = () => ({ runId: job.runId, generation: job.generation, resetEpoch: job.resetEpoch });
  job = await command(home, 'home', 'scan-result', { ...auth(), candidates: [
    { key: '测试课程', title: '测试课程', page: 1, order: 0, status: 'uninspected', records: {} }
  ] });
  job = await command(home, 'home', 'course-select', { ...auth(), index: 0, candidateKey: '测试课程', purpose: 'inspect' });
  job = await command(home, 'home', 'open', { ...auth(), index: 0, purpose: 'inspect' });
  const id = c.addTab(URL, home), messages = [];
  const f = fixture(rows, { connect(window) {
    c.connect(id)(window);
    const send = window.chrome.runtime.sendMessage;
    window.chrome.runtime.sendMessage = message => { messages.push(plain(message)); return send(message); };
  } });
  f.api.state.jobPromise = Promise.resolve();
  await f.api.jobCommand('hello', { title: '测试课程' });
  f.api.CFG.directoryLoadTimeout = 10000;
  const activate = () => {
    f.api.state.activeGeneration = f.api.state.job.generation;
    f.api.state.running = true;
    return f.api.state.epoch;
  };
  const scan = () => f.api.runCurrentCourseJob(activate());
  return Object.assign(f, { c, id, messages, activate, scan });
}
async function seedStartedMedia(f, count) {
  // Use the existing protocol to retain historical started/not-ended records.
  const candidate = f.api.state.job.candidates[0];
  await f.api.jobCommand('course-select', { index: 0, candidateKey: candidate.courseKey, purpose: 'play' });
  for (const item of candidate.directory.items.filter(item => ['video', 'audio', 'media'].includes(item.mediaType)).slice(0, count)) {
    await f.api.jobCommand('record', { key: item.key, result: {
      title: item.title, started: true, ended: false, confirmed: true,
      targetReached: true, effectiveTarget: 80, completionSource: 'page-marker', sitePercent: null
    } });
  }
  await f.api.jobCommand('pause');
}
async function rescan(f, purpose = 'inspect') {
  const candidate = f.api.state.job.candidates[0];
  await f.api.jobCommand('course-select', { index: 0, candidateKey: candidate.courseKey, purpose });
  await f.scan();
}

test('statistics: mixed classification excludes assignments/exams/headings and reference answers, retains explicit review media and unknown docs', async () => {
  const rows = [mediaItem('考试复习视频', 'video', 'done', '02:00'),
    mediaItem('短音频', 'audio', 'unStart', '00:30'), mediaItem('无图标听力', 'play', '', '01:00'),
    documentRow('必做讲义', 'done'), documentRow('必做资料'),
    documentRow('单元测验题答案', 'none'), documentRow('作业答案.pdf', ''),
    documentRow('课程作业'), documentRow('单元考试'), documentRow('单元测验'),
    '<li class="el-menu-item"><span class="lecture-title">课程测试 01:00</span></li>',
    '<li class="el-menu-item"><span class="lecture-title">第一周 章节标题</span></li>'];
  const f = await inspection(rows);
  try {
    await f.scan();
    const candidate = f.api.state.job.candidates[0], summary = f.api.refreshDirectories({ logSummary: false });
    assert.deepEqual(plain(summary.videoItems.map(title)), ['短音频', '无图标听力', '考试复习视频']);
    assert.deepEqual(plain(summary.documentItems.map(title)), ['必做讲义', '必做资料', '作业答案.pdf']);
    assert.equal(candidate.directory.items.filter(item => item.mediaType === 'other').length, 5);
    assert.equal(candidate.total, 6);
    assert.equal(candidate.remaining, 4);
    assert.equal(candidate.records[candidate.directory.items.find(i => i.title === '单元测验题答案').key], undefined);
    const evidence = scanLog(f).evidence;
    assert.equal(evidence.platformConfirmedCount, 2);
    assert.equal(evidence.platformPendingCount, 4);
    assert.equal(evidence.pendingMediaCount, 2);
    assert.equal(evidence.unknownDocumentCount, 1);
    assert.equal(evidence.referenceDocumentCount, 1);
    assert.equal(evidence.otherCount, 5);
    assert.match(scanLog(f).text, /平台已确认 2 项.*待确认 4 项/);
    assert.doesNotMatch(scanLog(f).text, /平台已确认 2\/6/);
    const ui = f.api.state.uiController, model = ui.render();
    assert.equal(model.overview.mediaTotal, null);
    ui.navigate('courses');
    assert.match(f.window.document.querySelector('.wb-view[data-view="courses"] [data-course="0"]').textContent, /任务.*待核对/);
    ui.navigate('course', { course: candidate.courseKey });
    assert.match(f.window.document.querySelector('[data-view="course"]').textContent, /其他资源 · 6 项/);
    assert.equal(f.c.reloads.length, 0);
    assert.equal(f.c.navigation.length, 0);
  } finally { close(f); }
});

test('statistics: visible site progress and done markers share platform counts while the old execution queue is unchanged', async () => {
  const f = await inspection([mediaItem('进度完成视频', 'video', '', '03:00'),
    mediaItem('已确认音频', 'audio', 'done', '00:20'), mediaItem('待确认视频', 'video', '', '01:00')]);
  try {
    const rows = f.api.getMenuItems();
    progress(f, rows[0], 80);
    await f.scan();
    const candidate = f.api.state.job.candidates[0];
    assert.equal(candidate.remaining, 2, 'legacy marker-only candidate queue remains intact');
    assert.equal(candidate.total, 3);
    assert.equal(candidate.records[f.api.getItemKey(rows[0])].confirmed, true);
    const log = scanLog(f);
    assert.equal(log.evidence.platformConfirmedCount, 2);
    assert.equal(log.evidence.platformPendingCount, 1);
    assert.equal(log.evidence.pendingMediaCount, 2);
    assert.match(log.text, /平台已确认 2\/3 项.*待确认 1 项.*执行待处理.*2/);
    assert.equal(f.window.document.getElementById('wb-confirmed').textContent, '2');
    assert.equal(f.api.isPageCompletedItem(rows[0]), false);
    assert.equal(f.api.getResourceCompletion(rows[0]).confirmed, true);
    const summary = f.api.refreshDirectories({ logSummary: false });
    assert.deepEqual(plain(summary.pendingItems.map(title)), ['待确认视频', '进度完成视频']);
    const finalLog = f.api.state.job.logs.at(-1);
    assert.match(finalLog.text, /平台已确认 2\/3 项.*待确认 1 项.*执行待处理 2\/3 项/);
    assert.equal(finalLog.evidence.platformConfirmedCount, 2);
    assert.equal(finalLog.evidence.platformPendingCount, 1);
    assert.equal(finalLog.evidence.pendingMediaCount, 2);
    const ui = f.api.state.uiController, model = ui.render();
    assert.equal(model.overview.courseProgress[0].confirmed, 2);
    ui.navigate('courses');
    assert.match(f.window.document.querySelector('.wb-view[data-view="courses"] [data-course="0"]').textContent, /平台待确认 1 项/);
    ui.navigate('course', { course: candidate.courseKey });
    assert.match(f.window.document.querySelector('[data-resource="0"]').textContent, /平台已确认/);
    assert.equal(f.media.paused, true);
  } finally { close(f); }
});

test('statistics: synthetic replay of 46 media and historical records displays 44 confirmed / 2 pending, keeps execution remaining 44', async () => {
  const f = await inspection(Array.from({ length: 46 }, (_, i) =>
    mediaItem('教学视频' + i, i % 2 ? 'audio' : 'video', i < 44 ? 'done' : 'unStart')));
  try {
    await f.scan();
    await seedStartedMedia(f, 42);
    await rescan(f);
    const candidate = f.api.state.job.candidates[0], log = scanLog(f);
    assert.equal(candidate.remaining, 44);
    assert.equal(candidate.total, 46);
    assert.equal(candidate.status, 'inspected');
    assert.equal(candidate.scanState, 'ready');
    assert.equal(log.evidence.platformConfirmedCount, 44);
    assert.equal(log.evidence.platformPendingCount, 2);
    assert.equal(log.evidence.pendingMediaCount, 44);
    assert.match(f.api.state.job.logs.at(-1).text, /平台已确认 44\/46 项.*待确认 2 项.*执行待处理 44\/46 项/);
    const ui = f.api.state.uiController, live = ui.render(), other = homeFixture([]);
    try {
      other.api.state.job = plain(f.api.state.job);
      const remote = other.api.state.uiController.render();
      assert.equal(live.overview.courseProgress[0].confirmed, 44);
      assert.equal(remote.overview.courseProgress[0].confirmed, 44);
      ui.navigate('courses');
      assert.match(f.window.document.querySelector('.wb-view[data-view="courses"] [data-course="0"]').textContent, /平台待确认 2 项/);
    } finally { close(other); }
    const exported = await f.c.request(f.id, 'reader', 'export-diagnostics');
    assert.equal(exported.ok, true);
    const event = exported.diagnostics.logs.findLast(entry => entry.eventCode === 'directory-scan-completed');
    assert.equal(event.evidence.platformConfirmedCount, 44);
    assert.equal(event.evidence.pendingMediaCount, 44);
    assert.equal(f.messages.filter(message => ['resource-retry', 'course-refresh'].includes(message.action)).length, 0);
  } finally { close(f); }
});

test('statistics: all platform-confirmed resources with unfinished history retain scan-to-play authorization and single-pass skip behavior', async () => {
  const f = await inspection([mediaItem('已确认视频', 'video', 'done'), mediaItem('已确认音频', 'audio', 'done')]);
  try {
    await f.scan();
    await seedStartedMedia(f, 2);
    await rescan(f, 'learn');
    const job = f.api.state.job, candidate = job.candidates[0];
    assert.equal(job.running, true, 'old remaining still authorizes the previously requested learn handoff');
    assert.equal(job.operation, 'play');
    assert.equal(candidate.remaining, 2);
    assert.equal(scanLog(f).evidence.platformConfirmedCount, 2);
    assert.equal(scanLog(f).evidence.platformPendingCount, 0);
    assert.equal(scanLog(f).evidence.pendingMediaCount, 2);
    const ui = f.api.state.uiController, model = ui.render();
    assert.equal(model.overview.courseConfirmed, 1);
    assert.equal(model.overview.coursePending, 0);
    ui.navigate('courses');
    f.window.document.querySelector('[data-course-filter="pending"]').click();
    assert.equal(f.window.document.querySelector('.wb-view[data-view="courses"] [data-course="0"]'), null);
    f.window.document.querySelector('[data-course-filter="complete"]').click();
    assert.match(f.window.document.querySelector('.wb-view[data-view="courses"] [data-course="0"]').textContent, /正在学习/);
    let clicks = 0;
    f.window.document.querySelector('.sub-menu-area').addEventListener('click', () => clicks++);
    f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => clicks++);
    const result = await f.api.runSinglePassCourse(f.activate());
    assert.equal(result.refreshing, true);
    assert.equal(clicks, 0, 'single-pass engine still skips confirmed media despite diagnostic execution candidates');
    assert.equal(f.c.reloads.length, 1, 'only the original end-of-course refresh');
    assert.equal(f.media.paused, true);
  } finally { close(f); }
});

test('statistics: required completed/pending documents are platform tasks, references are excluded and unknowns do not declare zero work', async () => {
  const f = await inspection([documentRow('必做已完成', 'done'), documentRow('必做待确认'),
    documentRow('参考答案', 'none'), documentRow('任务待核对', '')]);
  try {
    await f.scan();
    const candidate = f.api.state.job.candidates[0], log = scanLog(f);
    assert.equal(candidate.total, 3);
    assert.equal(candidate.remaining, 2);
    assert.equal(log.evidence.platformConfirmedCount, 1);
    assert.equal(log.evidence.platformPendingCount, 2);
    assert.equal(log.evidence.pendingMediaCount, 0);
    assert.equal(log.evidence.pendingDocumentCount, 1);
    assert.equal(log.evidence.unknownDocumentCount, 1);
    assert.equal(log.evidence.referenceDocumentCount, 1);
    assert.match(f.api.state.job.logs.at(-1).text, /平台已确认 1 项.*待确认 2 项.*文档任务标记待核对/);
    assert.doesNotMatch(f.api.state.job.logs.at(-1).text, /平台已确认 1\/3/);
    const ui = f.api.state.uiController;
    assert.equal(ui.render().overview.mediaTotal, null);
    ui.navigate('courses');
    f.window.document.querySelector('[data-course-filter="pending"]').click();
    assert.ok(f.window.document.querySelector('.wb-view[data-view="courses"] [data-course="0"]'));
    assert.equal(f.media.paused, true);
  } finally { close(f); }
});

test('statistics: reference-only and other-only directories never acquire tasks or playback authorization', async () => {
  const f = await inspection([documentRow('单元测验题答案', 'none'), documentRow('课程作业'), documentRow('单元考试'),
    '<li class="el-menu-item"><span class="lecture-title">第二章 章节标题</span></li>']);
  try {
    await f.scan();
    const candidate = f.api.state.job.candidates[0];
    assert.equal(candidate.total, 0);
    assert.equal(candidate.remaining, 0);
    assert.equal(candidate.directory.items.length, 4);
    const log = scanLog(f);
    assert.equal(log.evidence.platformConfirmedCount, 0);
    assert.equal(log.evidence.platformPendingCount, 0);
    assert.equal(log.evidence.referenceDocumentCount, 1);
    assert.equal(log.evidence.otherCount, 3);
    assert.doesNotMatch(f.api.state.job.logs.at(-1).text, /100%/);
    assert.equal(f.api.state.job.running, false);
  } finally { close(f); }
});

test('statistics: a historical document confirmation conflicting with current marker remains pending in platform logs and UI', async () => {
  const f = await inspection([documentRow('历史必做文档', 'done')]);
  try {
    await f.scan();
    f.api.getMenuItems()[0].querySelector('.lecture-status').innerHTML = '<i class="unStart-icon"></i>';
    await rescan(f);
    const candidate = f.api.state.job.candidates[0];
    assert.equal(Object.values(candidate.records)[0].confirmed, true, 'retain historical evidence');
    assert.equal(candidate.remaining, 1);
    assert.equal(scanLog(f).evidence.platformConfirmedCount, 0);
    assert.equal(scanLog(f).evidence.platformPendingCount, 1);
    assert.equal(f.api.state.uiController.render().overview.courseProgress[0].confirmed, 0);
  } finally { close(f); }
});

test('statistics: log evidence whitelist carries bounded numeric statistics through local export and background rejection of unrelated fields', async () => {
  const f = await inspection([mediaItem('视频', 'video', 'done')]);
  try {
    await f.scan();
    const candidate = f.api.state.job.candidates[0];
    await f.api.jobCommand('course-select', { index: 0, candidateKey: candidate.courseKey, purpose: 'inspect' });
    const values = { platformConfirmedCount: 1, platformPendingCount: 0, referenceDocumentCount: 0, otherCount: 0,
      arbitrary: { token: 'secret' } };
    const entry = f.api.appendLog('统计证据', 'info', Date.now(), { evidence: values });
    for (const key of ['platformConfirmedCount', 'platformPendingCount', 'referenceDocumentCount', 'otherCount']) {
      assert.equal(entry.evidence[key], values[key]);
    }
    assert.equal(entry.evidence.arbitrary, undefined);
    await f.api.jobCommand('log', { ...entry, eventCode: 'directory-statistics-test' });
    const exported = await f.c.request(f.id, 'reader', 'export-diagnostics');
    const saved = exported.diagnostics.logs.find(entry => entry.eventCode === 'directory-statistics-test');
    assert.equal(saved.evidence.platformConfirmedCount, 1);
    assert.equal(saved.evidence.platformPendingCount, 0);
    assert.equal(saved.evidence.arbitrary, undefined);
    const invalid = f.api.appendLog('非有限统计', 'info', Date.now(), {
      evidence: { platformPendingCount: Infinity, otherCount: NaN }
    });
    assert.equal(invalid.evidence.platformPendingCount, undefined);
    assert.equal(invalid.evidence.incomplete, true);
  } finally { close(f); }
});

test('statistics: current visible site-progress agrees with resource detail without modifying saved cross-tab scan totals', async () => {
  const f = await inspection([mediaItem('视频', 'video', '', '01:00')]);
  try {
    await f.scan();
    const row = f.api.getMenuItems()[0], ui = f.api.state.uiController;
    progress(f, row, 88);
    const candidate = f.api.state.job.candidates[0], model = ui.render();
    assert.equal(model.overview.courseProgress[0].confirmed, 0, 'manual aggregate remains the committed scan evidence');
    assert.equal(model.courses[0].directory.items[0].observedCompleted, true, 'current detail uses the current full platform rule');
    assert.equal(candidate.records[f.api.getItemKey(row)].confirmed, false);
    ui.navigate('course', { course: candidate.courseKey });
    assert.match(f.window.document.querySelector('[data-resource="0"]').textContent, /平台已确认/);
    assert.equal(candidate.remaining, 1);
  } finally { close(f); }
});
