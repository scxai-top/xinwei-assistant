const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, mediaItem } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');
const { documentRow } = require('./document-fixture.cjs');
const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
const URL = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/resource-1?classId=class-1';
const KEY = 'xinwei-job-v3';
const plain = value => JSON.parse(JSON.stringify(value));
const auth = job => ({ runId: job.runId, generation: job.generation, resetEpoch: job.resetEpoch });
const close = f => { f.api.state.running = false; f.window.close(); };

// Synthetic counterexamples to the two classifiers, not a captured Edge DOM.
async function ready(rows) {
  const f = fixture(rows);
  f.api.state.running = true;
  try { await f.api.waitForDirectory(f.api.state.epoch); }
  catch (error) { close(f); throw error; }
  return f;
}

async function request(c, id, instance, action, payload = {}) {
  const response = await c.request(id, instance, action, payload);
  assert.equal(response.ok, true, action + ': ' + response.error);
  return response.job;
}

async function inspection() {
  const c = coordinator(), home = c.addTab(HOME);
  let job = await request(c, home, 'home', 'start', { workflow: 'manual', scope: 'all', singlePass: true });
  job = await request(c, home, 'home', 'scan-result', { ...auth(job), candidates: [
    { key: '测试课程', title: '测试课程', page: 1, order: 0, status: 'uninspected', records: {} }
  ] });
  job = await request(c, home, 'home', 'course-select', {
    ...auth(job), index: 0, candidateKey: '测试课程', purpose: 'inspect'
  });
  job = await request(c, home, 'home', 'open', { ...auth(job), index: 0, purpose: 'inspect' });
  const id = c.addTab(URL, home);
  return { c, id, job };
}

test('review-fix: an explicit document icon keeps its own observation despite duration-shaped row text', async () => {
  const f = await ready([`<div class="section-area">
    ${mediaItem('相邻视频', 'video', 'done', '14:28')}
    ${mediaItem('教学课件 01:20', 'text', 'unStart', '14:28')}
  </div>`]);
  try {
    const rows = f.api.getMenuItems();
    const document = rows.find(row => row.querySelector('.text-icon'));
    assert.equal(f.api.isDocumentItem(document), true);
    assert.equal(f.api.isVideoItem(document), false);
    const snapshot = f.api.getDirectorySnapshot().items.find(item => item.title === '教学课件 01:20');
    assert.equal(snapshot.mediaType, 'document');
    assert.equal(snapshot.taskItem, true);
    assert.equal(snapshot.observedCompleted, false);
    assert.equal(snapshot.durationSeconds, null);
    const summary = f.api.refreshDirectories({ logSummary: false });
    assert.equal(summary.videoItems.length, 1);
    assert.equal(summary.documentItems.length, 1);
  } finally { close(f); }
});

test('review-fix: a neighboring video duration is never exported as document duration', async () => {
  const f = await ready([`<div class="section-area">
    <div class="section-content"><i class="video-icon"></i>相邻视频 <span>14:28</span></div>
    <div class="section-content"><i class="text-icon"></i>教学课件</div>
  </div>`]);
  try {
    const items = f.api.getDirectorySnapshot().items;
    assert.equal(items.find(item => item.mediaType === 'document').durationSeconds, null);
    assert.equal(items.find(item => item.mediaType === 'video').durationSeconds, 868);
    assert.equal(items.find(item => item.mediaType === 'document').taskItem, false);
  } finally { close(f); }
});

test('review-fix: answer references and unknown answer markers use the same document classification everywhere', async () => {
  const titles = ['答案', '第1 章 单元测验题答案', '课程作业答案.pdf', '期末考试答案'];
  const f = await ready([...titles.map(title => documentRow(title, 'none')),
    documentRow('第2章 单元测验题答案', '')]);
  try {
    const items = f.api.getDirectorySnapshot().items;
    assert.equal(items.length, 5);
    assert.equal(items.every(item => item.mediaType === 'document'), true);
    assert.deepEqual(plain(items.map(item => item.taskItem)), [false, false, false, false, null]);
    assert.equal(items.at(-1).observedCompleted, null);
    const summary = f.api.refreshDirectories({ logSummary: false });
    assert.equal(summary.videoItems.length, 0);
    assert.equal(summary.documentItems.length, 1);
    assert.equal(summary.pendingDocumentItems.length, 1);
  } finally { close(f); }
});

test('review-fix: real assignment, exam and quiz rows stay excluded in both snapshot and summary', async () => {
  const f = await ready(['课程作业', '单元考试', '单元测验'].map(title => documentRow(title)));
  try {
    const summary = f.api.refreshDirectories({ logSummary: false });
    assert.equal(summary.videoItems.length, 0);
    assert.equal(summary.documentItems.length, 0);
    const items = f.api.getDirectorySnapshot().items;
    assert.equal(items.length, 3);
    assert.equal(items.every(item => item.mediaType === 'other'), true);
    assert.equal(items.every(item => item.taskItem === undefined), true);
  } finally { close(f); }
});

test('review-fix: a supported non-i text icon cannot classify one row as both media and document', async () => {
  const f = await ready([mediaItem('课件', 'text', 'unStart', '01:20').replace('<i class="text-icon"></i>', '<span class="text-icon"></span>'),
    mediaItem('考试复习视频', 'video', 'unStart', '02:00')]);
  try {
    const summary = f.api.refreshDirectories({ logSummary: false });
    assert.equal(summary.documentItems.length, 1);
    assert.equal(summary.videoItems.length, 1);
    assert.equal(summary.videoItems[0].querySelector('.lecture-title').textContent, '考试复习视频');
    assert.deepEqual(plain(f.api.getDirectorySnapshot().items.map(item => item.mediaType)), ['document', 'video']);
  } finally { close(f); }
});

test('review-fix: explicit media icons retain media classification when a duration is temporarily absent', async () => {
  const f = await ready([mediaItem('课件讲解', 'video', 'unStart', ''),
    mediaItem('课件录音', 'audio', 'unStart', ''), documentRow('课件资料', 'none')]);
  try {
    const summary = f.api.refreshDirectories({ logSummary: false });
    assert.equal(summary.videoItems.length, 2);
    assert.equal(summary.documentItems.length, 0);
    assert.deepEqual(plain(f.api.getDirectorySnapshot().items.map(item => item.mediaType)), ['video', 'audio', 'document']);
  } finally { close(f); }
});

test('review-fix: a synthetic 147-row manual scan commits matching task totals without resource or playback clicks', async () => {
  const { c, id } = await inspection();
  const rows = [
    ...Array.from({ length: 46 }, (_, i) => mediaItem('教学视频' + i, 'video', i < 2 ? 'done' : 'unStart')),
    ...Array.from({ length: 53 }, (_, i) => mediaItem(
      i < 7 ? `第${i}章 单元测验题答案` : `教学课件${i}`, 'text', i === 51 ? '' : i === 52 ? 'unStart' : null, '01:20')),
    ...Array.from({ length: 48 }, (_, i) => documentRow('课程作业' + i))
  ];
  // mediaItem deliberately renders an empty status when status=null; references
  // have no status container at all, as in the established document fixture.
  for (let i = 46; i < 97; i++) rows[i] = rows[i].replace(/<span class="lecture-status">[\s\S]*?<\/span>/, '');
  const f = fixture(rows, { connect: c.connect(id) });
  let resourceClicks = 0, playbackClicks = 0;
  f.window.document.querySelector('.sub-menu-area').addEventListener('click', event => {
    if (event.target.closest('li.el-menu-item')) resourceClicks++;
  });
  f.window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => playbackClicks++);
  try {
    f.api.state.jobPromise = Promise.resolve();
    await f.api.jobCommand('hello', { title: '测试课程' });
    f.api.state.activeGeneration = f.api.state.job.generation;
    f.api.state.running = true;
    f.api.CFG.directoryLoadTimeout = 10000;
    await f.api.runCurrentCourseJob(f.api.state.epoch);
    const job = c.storage.session[KEY], candidate = job.candidates[0];
    assert.equal(job.phase, 'selection');
    assert.equal(job.running, false);
    assert.equal(candidate.scanDraft, undefined);
    assert.equal(candidate.directory.items.length, 147);
    assert.equal(candidate.directory.items.filter(item => ['video', 'audio', 'media'].includes(item.mediaType)).length, 46);
    assert.equal(candidate.directory.items.filter(item => item.mediaType === 'document').length, 53);
    assert.equal(candidate.directory.items.filter(item => item.mediaType === 'other').length, 48);
    assert.equal(candidate.total, 48, '46 media + one task document + one unknown document');
    assert.equal(candidate.remaining, 46);
    assert.equal(candidate.directory.items.filter(item => item.taskItem === false).length, 51);
    assert.equal(candidate.directory.items.filter(item => item.taskItem === null).length, 1);
    assert.equal(resourceClicks, 0);
    assert.equal(playbackClicks, 0);
    assert.equal(f.media.paused, true);
    assert.equal(c.reloads.length, 0);
    assert.equal(c.navigation.length, 0);
  } finally { close(f); }
});

test('review-fix: rejected scan exports bounded actual draft counts separately from committed history after restart', async () => {
  const f = await inspection();
  let job = await request(f.c, f.id, 'page', 'hello', { title: '测试课程' });
  const old = { version: 1, courseKey: 'course-1::class-1', items: [
    { key: 'old-reference', title: '旧参考资料', mediaType: 'document', durationSeconds: null, taskItem: false, observedCompleted: false, documentReason: 'no-task-marker' }
  ] };
  job = await request(f.c, f.id, 'page', 'directory-checkpoint', { ...auth(job), snapshot: old });
  job = await request(f.c, f.id, 'page', 'course-result', { ...auth(job), result: { total: 0, remaining: 0 } });
  job = await request(f.c, f.id, 'page', 'course-select', {
    ...auth(job), index: 0, candidateKey: 'course-1::class-1', purpose: 'inspect'
  });
  const draft = { version: 1, courseKey: old.courseKey, items: Array.from({ length: 321 }, (_, i) => ({
    key: i === 0 ? 'answer?token=private-token' : 'doc-' + i,
    title: '单元测验题答案' + i + 'x'.repeat(200), mediaType: 'document', durationSeconds: null,
    taskItem: null, observedCompleted: null, documentReason: 'marker-unrecognized',
    ignoredSecret: 'private-cookie'
  })) };
  job = await request(f.c, f.id, 'page', 'directory-checkpoint', { ...auth(job), snapshot: draft });
  const before = JSON.stringify(f.c.storage.session[KEY]);
  const rejected = await f.c.request(f.id, 'page', 'course-result', { ...auth(job), result: { total: 0, remaining: 0 } });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /课程结果与已保存的完整目录不符/);
  assert.equal(JSON.stringify(f.c.storage.session[KEY]), before, 'strict rejection does not modify the job');
  assert.deepEqual(plain(rejected.errorDetails), {
    action: 'course-result', rule: 'directory-task-count-match', count: 321,
    expectedTotal: 321, reportedTotal: 0, reportedRemaining: 0
  });
  job = await request(f.c, f.id, 'page', 'manual', { ...auth(job), reason: rejected.error,
    diagnostic: { time: Date.now(), error: {
      code: rejected.errorCode, action: 'course-result', message: rejected.error, details: rejected.errorDetails
    } }
  });
  assert.deepEqual(job.candidates[0].directory, old);
  f.c.restartWorker();
  f.c.restartBrowser();
  const stored = JSON.stringify(f.c.storage);
  const exported = await f.c.request(f.id, 'reader', 'export-diagnostics');
  assert.equal(exported.ok, true);
  const report = exported.diagnostics;
  assert.equal(report.documents.length, 1);
  assert.equal(report.documents[0].key, 'old-reference');
  assert.equal(report.scanDraft.itemCount, 321);
  assert.equal(report.scanDraft.taskCount, 321);
  assert.equal(report.scanDraft.documentCount, 321);
  assert.equal(report.scanDraft.unknownDocumentCount, 321);
  assert.equal(report.scanDraft.referenceDocumentCount, 0);
  assert.equal(report.scanDraft.mediaCount, 0);
  assert.equal(report.scanDraft.items.length, 300);
  assert.equal(report.scanDraft.truncated, true);
  assert.equal(report.scanDraft.items[0].title.length, 160);
  assert.equal(report.scanDraft.items[0].taskItem, null);
  assert.equal(report.incident.error.details.expectedTotal, 321);
  assert.equal(report.logs.at(-1).evidence.reportedTotal, 0);
  assert.equal(report.scanDraft.items[0].ignoredSecret, undefined);
  assert.ok(!JSON.stringify(report).includes('private-token'));
  assert.ok(!JSON.stringify(report).includes('private-cookie'));
  assert.equal(JSON.stringify(f.c.storage), stored, 'export remains read-only');
  assert.equal(f.c.navigation.length, 0);
  assert.equal(f.c.reloads.length, 0);
});

test('review-fix: numeric count rejection evidence survives content sanitization and local pending export', async () => {
  const { c, id } = await inspection();
  const f = fixture([documentRow('单元测验题答案', '')], { connect: c.connect(id) });
  try {
    f.api.state.jobPromise = Promise.resolve();
    await f.api.jobCommand('hello', { title: '测试课程' });
    await f.api.jobCommand('directory-checkpoint', { snapshot: f.api.getDirectorySnapshot() });
    await assert.rejects(f.api.jobCommand('course-result', { result: { total: 0, remaining: 0 } }), error => {
      assert.equal(error.details.expectedTotal, 1);
      assert.equal(error.details.reportedTotal, 0);
      const entry = f.api.appendLog('拒绝证据', 'err', Date.now(), { evidence: error.details });
      assert.equal(entry.evidence.expectedTotal, 1);
      assert.equal(entry.evidence.reportedRemaining, 0);
      return true;
    });
  } finally { close(f); }
});
