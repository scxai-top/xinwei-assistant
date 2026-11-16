const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, mediaItem, waitFor } = require('./helpers.cjs');
const { coordinator } = require('./coordinator.cjs');
const { documentRow, sectionDocument, deferred } = require('./document-fixture.cjs');
const KEY = 'xinwei-job-v3';
const URL = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/resource-1?classId=class-1';
const plain = value => JSON.parse(JSON.stringify(value));
const auth = job => ({ runId: job.runId, generation: job.generation, resetEpoch: job.resetEpoch });
const close = f => { f.api.state.running = false; f.dom.window.close(); };

async function prepared(rows, options = {}) {
  const c = coordinator(options), id = c.addTab(URL), messages = [], clicks = [];
  const f = fixture(rows, { connect(window) {
    c.connect(id)(window);
    const send = window.chrome.runtime.sendMessage;
    window.chrome.runtime.sendMessage = message => {
      messages.push(plain(message));
      return send(message);
    };
  } });
  f.api.state.jobPromise = Promise.resolve();
  const job = await f.api.jobCommand('start', { title: '测试课程', scope: 'single', singlePass: true, targetPercent: 80 });
  f.api.state.activeGeneration = job.generation;
  f.api.state.running = true;
  f.api.state.processedCourseKey = f.api.currentCourseKey();
  f.epoch = f.api.state.epoch;
  Object.assign(f.api.CFG, { documentClickDelayMin: 20, documentClickDelayMax: 20, directoryLoadTimeout: 10000 });
  try { await f.api.waitForDirectory(f.epoch); }
  catch (error) { close(f); throw error; }
  f.window.document.querySelector('.sub-menu-area').addEventListener('click', event => {
    const item = event.target.closest('li.el-menu-item, .section-content');
    if (!item) return;
    clicks.push(f.api.getItemKey(item));
    if (options.select !== false) {
      f.api.getMenuItems().forEach(row => row.classList.remove('is-active'));
      item.classList.add('is-active');
    }
    options.onClick?.(item, f);
  });
  return Object.assign(f, { c, id, messages, clicks });
}

test('synthetic markers: hollow/partial/complete/empty/unknown remain distinct in every observation', async () => {
  const f = fixture(['unStart', 'inProgress', 'done', '', 'alien', 'none'].map((status, i) => documentRow('文档' + i, status)));
  try {
    const before = f.api.getDirectorySnapshot().items;
    assert.equal(before[5].taskItem, null, 'absence before directory readiness is unknown');
    f.api.state.running = true;
    await f.api.waitForDirectory(0);
    const snapshot = f.api.getDirectorySnapshot();
    assert.deepEqual(plain(snapshot.items.map(i => [i.taskItem, i.observedCompleted])),
      [[true, false], [true, false], [true, true], [null, null], [null, null], [false, false]]);
    const summary = f.api.refreshDirectories({ logSummary: false });
    assert.equal(summary.documentItems.length, 5);
    assert.equal(summary.pendingDocumentItems.length, 4);
    for (const row of f.api.getMenuItems()) {
      const observed = f.api.observeDocument(row);
      const saved = snapshot.items.find(item => item.key === f.api.getItemKey(row));
      assert.equal(saved.taskItem, observed.taskItem);
      assert.equal(saved.observedCompleted, observed.observedCompleted);
      assert.equal(f.api.isPageCompletedItem(row), observed.observedCompleted === true);
    }
  } finally { close(f); }
});

test('adjacent resources and a hidden completed duplicate never confirm unfinished A', async () => {
  const f = fixture([`<div class="section-area">${documentRow('文档A')}${documentRow('文档B', 'done')}
    ${documentRow('隐藏副本', 'done', { hidden: true })}</div>`]);
  try {
    const rows = f.api.getMenuItems();
    assert.equal(rows.length, 2);
    assert.equal(f.api.isPageCompletedItem(rows[0]), false);
    assert.equal(f.api.isPageCompletedItem(rows[1]), true);
    assert.equal(f.api.getResourceCompletion(rows[0]).confirmed, false);
  } finally { close(f); }
});

test('single-content section owns its sibling status; multi-content section never borrows a shared status', () => {
  const f = fixture([sectionDocument('单篇文档', 'done'),
    `<div class="section-area"><div class="section-content"><i class="text-icon"></i>文档甲</div>
    <div class="section-content"><i class="text-icon"></i>文档乙</div>
    <span class="section-status status-icon"><i class="done-icon"></i></span></div>`]);
  try {
    const rows = f.api.getMenuItems();
    assert.equal(f.api.isPageCompletedItem(rows[0]), true);
    assert.equal(rows.slice(1).some(f.api.isPageCompletedItem), false);
    assert.equal(rows.slice(1).every(row => f.api.observeDocument(row).taskItem == null), true);
  } finally { close(f); }
});

test('document completion ignores media percentages, 95% bars and vague done-like classes', () => {
  const f = fixture([documentRow('文档A', '')]);
  try {
    const row = f.api.getMenuItems()[0];
    row.querySelector('.lecture-status').innerHTML = '<i class="undone-icon"></i><div class="el-progress-bar__inner" style="width:100%"></div>';
    row.insertAdjacentHTML('beforeend', '<span class="progress-text">已观看 100%</span>');
    assert.equal(f.api.getResourceCompletion(row).confirmed, false);
    assert.equal(f.api.observeDocument(row).taskItem, null);
  } finally { close(f); }
});

test('unknown metadata survives background validation and cannot produce a zero-task result', async () => {
  const f = await prepared([documentRow('未知文档', '')]);
  try {
    const item = f.api.state.job.candidates[0].directory.items[0];
    assert.equal(item.taskItem, null);
    assert.equal(item.documentReason, 'marker-unrecognized');
    const rejected = await f.c.request(f.id, f.api.state.instanceId, 'course-result', {
      ...auth(f.api.state.job), result: { total: 0, remaining: 0, finalPass: true }
    });
    assert.equal(rejected.ok, false);
    const result = await f.api.runSinglePassCourse(f.epoch);
    assert.equal(result.refreshing, true);
    assert.equal(f.clicks.length, 0);
    assert.equal(f.c.reloads.length, 1);
    assert.deepEqual(plain(f.api.state.job.candidates[0].pass.pendingKeys), []);
  } finally { close(f); }
});

test('invalid or contradictory document observation fields are rejected atomically', async () => {
  const f = await prepared([documentRow('文档A')]);
  try {
    const snapshot = plain(f.api.getDirectorySnapshot());
    for (const fields of [{ taskItem: false }, { observedCompleted: true }, { documentReason: 'invented' }]) {
      const changed = plain(snapshot);
      Object.assign(changed.items[0], fields);
      const response = await f.c.request(f.id, f.api.state.instanceId, 'directory-checkpoint',
        { ...auth(f.api.state.job), snapshot: changed });
      assert.equal(response.ok, false);
    }
    assert.equal(f.c.storage.local[KEY].candidates[0].directory.items[0].taskItem, true);
  } finally { close(f); }
});

test('delayed A marker while B is selected is saved under A before C; a slow durable batch blocks C', async () => {
  const gate = deferred(), saving = deferred(), timeline = [];
  let delayed = false;
  const f = await prepared(['A', 'B', 'C'].map(t => documentRow('文档' + t)), {
    async beforeStorageSet(area, values) {
      if (!delayed && area === 'local' && values[KEY]?.candidates[0]?.records?.[timeline.a]?.confirmed) {
        delayed = true; timeline.push('save-A-start'); saving.resolve(); await gate.promise; timeline.push('save-A-end');
      }
    },
    onClick(item, page) {
      const title = item.querySelector('.lecture-title').textContent;
      timeline.push('click-' + title.slice(-1));
      if (title === '文档B') {
        const a = page.api.getMenuItems()[0];
        a.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
        for (let i = 0; i < 30; i++) a.querySelector('.lecture-status').setAttribute('title', String(i));
      }
    }
  });
  try {
    timeline.a = f.api.getItemKey(f.api.getMenuItems()[0]);
    const task = f.api.runSinglePassCourse(f.epoch);
    await saving.promise;
    assert.equal(f.clicks.length, 2);
    assert.equal(f.c.storage.local[KEY].candidates[0].records[timeline.a]?.confirmed, undefined);
    gate.resolve();
    await task;
    assert.ok(timeline.indexOf('save-A-end') < timeline.indexOf('click-C'));
    const candidate = f.c.storage.local[KEY].candidates[0];
    assert.equal(candidate.records[timeline.a].confirmed, true);
    assert.equal(Object.values(candidate.records).filter(r => r.confirmed).length, 1);
    assert.equal(f.messages.filter(m => m.action === 'record-completions').length, 1);
    assert.equal(f.clicks.length, 3);
    assert.equal(f.c.reloads.length, 1);
  } finally { gate.resolve(); close(f); }
});

for (const completes of [false, true]) {
  test(`preview failure remains diagnostic and visits B; platform marker confirms A only when present (${completes})`, async () => {
    const f = await prepared([documentRow('文档A'), documentRow('文档B')], {
      onClick(item) {
        if (!item.textContent.includes('文档A')) return;
        item.insertAdjacentHTML('beforeend', '<span role="alert">文档预览失败</span>');
        if (completes) item.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
      }
    });
    try {
      const key = f.api.getItemKey(f.api.getMenuItems()[0]);
      await f.api.runSinglePassCourse(f.epoch);
      const record = f.c.storage.local[KEY].candidates[0].records[key];
      assert.equal(record.visited, true);
      assert.equal(record.documentAccess.preview, 'failed');
      assert.equal(record.confirmed === true, completes);
      assert.equal(f.clicks.length, 2);
      const preview = f.api.state.job.logs.find(log => log.resourceKey === key && log.eventCode === 'document-preview');
      assert.equal(preview.evidence.preview, 'failed');
      const exported = await f.c.request(f.id, f.api.state.instanceId, 'export-diagnostics');
      assert.equal(JSON.stringify(exported.diagnostics).includes('"preview":"failed"'), true);
    } finally { close(f); }
  });
}

test('slow or unidentified viewer never gates B or fabricates preview success', async () => {
  const f = await prepared([documentRow('文档A'), documentRow('文档B')], {
    onClick(item, page) {
      if (item.textContent.includes('文档A')) page.window.document.querySelector('.video-js')
        .insertAdjacentHTML('afterend', '<div class="synthetic-viewer"><div class="el-loading-mask"></div><iframe></iframe></div>');
    }
  });
  try {
    const result = await f.api.runSinglePassCourse(f.epoch);
    assert.equal(result.refreshing, true);
    assert.equal(f.clicks.length, 2);
    const records = Object.values(f.c.storage.local[KEY].candidates[0].records);
    assert.equal(records.every(r => r.documentAccess.preview === 'unknown' && !r.confirmed), true);
    assert.equal(f.api.CFG.mediaLoadTimeout, 20);
  } finally { close(f); }
});

test('an inert click is attempted once and records unconfirmed response without successful visited', async () => {
  const f = await prepared([documentRow('文档A'), documentRow('文档B')], { select: false });
  try {
    await f.api.runSinglePassCourse(f.epoch);
    assert.equal(f.clicks.length, 2);
    const records = Object.values(f.c.storage.local[KEY].candidates[0].records);
    assert.equal(records.every(r => !r.visited && !r.confirmed && r.documentAccess.response === 'unconfirmed'), true);
    assert.equal(f.messages.filter(m => m.action === 'resource-retry').length, 0);
  } finally { close(f); }
});

test('a complete directory without documents stays on the existing media/pass path', async () => {
  const f = await prepared([mediaItem('已完成媒体', 'video', 'done')]);
  try {
    assert.equal(f.api.refreshDirectories({ logSummary: false }).documentItems.length, 0);
    await f.api.runSinglePassCourse(f.epoch);
    assert.equal(f.messages.some(m => m.action === 'document-visited'), false);
    assert.equal(f.clicks.length, 0);
    assert.equal(f.c.reloads.length, 1);
  } finally { close(f); }
});

test('reference-only documents have no required denominator, click, viewer wait or document error', async () => {
  const f = await prepared([documentRow('参考资料', 'none')]);
  try {
    assert.equal(f.api.state.job.candidates[0].directory.items[0].taskItem, false);
    await f.api.runSinglePassCourse(f.epoch);
    assert.equal(f.messages.some(m => m.action === 'document-visited'), false);
    assert.equal(f.clicks.length, 0);
  } finally { close(f); }
});

test('incomplete chapters cannot be reinterpreted as a full directory with no documents', async () => {
  const f = fixture([mediaItem('媒体', 'video', 'done')]);
  try {
    f.api.state.running = true;
    f.api.CFG.directoryLoadTimeout = 40;
    f.window.document.querySelector('.el-menu').insertAdjacentHTML('beforeend',
      '<li class="el-sub-menu is-opened" aria-expanded="true"><div class="el-sub-menu__title">未加载章节</div><ul></ul></li>');
    await assert.rejects(f.api.waitForDirectory(0), /章节条目尚未加载完成/);
    assert.equal(f.api.readDirectory().complete, false);
  } finally { close(f); }
});

test('directory redraw and late markers are reacquired by key, without confirming the selected neighbor', async () => {
  const f = await prepared([documentRow('文档A', ''), documentRow('文档B')]);
  try {
    const aKey = f.api.getItemKey(f.api.getMenuItems()[0]), bKey = f.api.getItemKey(f.api.getMenuItems()[1]);
    const old = f.api.getMenuItems()[0];
    const list = old.parentElement;
    list.innerHTML = documentRow('文档A', 'done') + documentRow('文档B');
    f.api.getMenuItems()[1].classList.add('is-active');
    await f.api.documentCheckpoint(f.epoch, f.api.currentCourseKey(), true);
    assert.equal(old.isConnected, false);
    assert.equal(f.api.state.job.candidates[0].records[aKey].confirmed, true);
    assert.equal(f.api.state.job.candidates[0].records[bKey]?.confirmed, undefined);
    assert.equal(f.clicks.length, 0);
  } finally { close(f); }
});

for (const action of ['pause', 'reset']) {
  test(`${action} during a slow completion save cancels the executor and rejects late document messages`, async () => {
    const gate = deferred(), saving = deferred();
    let held = false;
    const f = await prepared([documentRow('文档A'), documentRow('文档B')], {
      async beforeStorageSet(area, values) {
        if (!held && area === 'local' && Object.values(values[KEY]?.candidates[0]?.records || {}).some(r => r.confirmed)) {
          held = true; saving.resolve(); await gate.promise;
        }
      },
      onClick(item) { item.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>'; }
    });
    try {
      const old = plain(f.api.state.job), key = f.api.getItemKey(f.api.getMenuItems()[0]);
      const task = f.api.runSinglePassCourse(f.epoch);
      const rejected = assert.rejects(task, error => error.constructor.name === 'TaskCancelled');
      await saving.promise;
      f.api.state.running = false; f.api.state.epoch += 1;
      const stopped = f.c.request(f.id, f.api.state.instanceId, action, auth(old));
      gate.resolve();
      await stopped; await rejected;
      assert.equal(f.clicks.length, 1);
      const late = await f.c.request(f.id, f.api.state.instanceId, 'document-visited', {
        ...auth(old), key, stage: 'result', attemptId: 'old', response: 'selected', preview: 'unknown'
      });
      assert.equal(late.ok, false);
      assert.equal(f.c.reloads.length, 0);
      if (action === 'reset') assert.equal(f.c.storage.local[KEY].candidates.length, 0);
    } finally { gate.resolve(); close(f); }
  });
}

test('A completing after C is selected is confirmed only under A without another access', async () => {
  const f = await prepared(['A', 'B', 'C', 'D'].map(name => documentRow('文档' + name)), {
    onClick(item, page) {
      if (item.textContent.includes('文档C')) page.api.getMenuItems()[0].querySelector('.lecture-status')
        .innerHTML = '<i class="done-icon"></i>';
    }
  });
  try {
    const key = f.api.getItemKey(f.api.getMenuItems()[0]);
    await f.api.runSinglePassCourse(f.epoch);
    const records = f.c.storage.local[KEY].candidates[0].records;
    assert.equal(records[key].confirmed, true);
    assert.equal(Object.values(records).filter(record => record.confirmed).length, 1);
    assert.equal(f.clicks.length, 4);
    assert.equal(new Set(f.clicks).size, 4);
  } finally { close(f); }
});

test('multiple selected resources are ambiguous and cannot manufacture successful access', async () => {
  const f = await prepared([documentRow('文档A'), documentRow('文档B')], {
    select: false, onClick(_item, page) { page.api.getMenuItems().forEach(row => row.classList.add('is-active')); }
  });
  try {
    await f.api.runSinglePassCourse(f.epoch);
    assert.equal(f.clicks.length, 2);
    assert.equal(Object.values(f.c.storage.local[KEY].candidates[0].records).every(record =>
      !record.visited && record.documentAccess.response === 'unconfirmed'), true);
  } finally { close(f); }
});

test('a full-page loading overlay covering the directory keeps the original blocking boundary', async () => {
  const f = await prepared([documentRow('文档A'), documentRow('文档B')], {
    onClick(_item, page) {
      const bounds = { left: 0, top: 0, right: 900, bottom: 800, width: 900, height: 800 };
      const mask = page.window.document.createElement('div');
      mask.className = 'el-loading-mask';
      mask.getBoundingClientRect = () => bounds;
      page.window.document.body.append(mask);
      page.window.document.querySelector('.sub-menu-area').getBoundingClientRect = () => bounds;
    }
  });
  try {
    await assert.rejects(f.api.runSinglePassCourse(f.epoch), /目录正在加载/);
    assert.equal(f.clicks.length, 1);
    assert.equal(f.c.reloads.length, 0);
  } finally { close(f); }
});

test('old visited evidence remains historical; repeated messages are idempotent and stale attempts rejected', async () => {
  const f = await prepared([documentRow('文档A')]);
  try {
    const key = f.api.getItemKey(f.api.getMenuItems()[0]);
    await f.api.jobCommand('document-visited', { key });
    assert.equal(f.api.state.job.candidates[0].records[key].documentAccess, undefined);
    const first = { key, stage: 'attempt', attemptId: 'same-attempt' };
    await f.api.jobCommand('document-visited', first);
    await f.api.jobCommand('document-visited', first);
    const result = { key, stage: 'result', attemptId: 'same-attempt', response: 'selected', preview: 'unknown' };
    await f.api.jobCommand('document-visited', result);
    const revision = f.api.state.job.revision;
    await f.api.jobCommand('document-visited', result);
    assert.equal(f.api.state.job.revision, revision);
    await assert.rejects(f.api.jobCommand('document-visited', { ...first, attemptId: 'stale-different' }), /已有访问尝试/);
    await assert.rejects(f.api.jobCommand('document-visited', { ...result, attemptId: 'stale-different' }), /本次尝试不符/);
    assert.equal(f.api.state.job.candidates[0].records[key].confirmed, undefined);
  } finally { close(f); }
});

test('legacy confirmed evidence is retained but a fresh conflicting marker prevents final completion and UI confirmation', async () => {
  const f = await prepared([documentRow('文档A')]);
  try {
    const key = f.api.getItemKey(f.api.getMenuItems()[0]);
    await f.api.jobCommand('record', { key, result: { title: '文档A', confirmed: true, completionSource: 'page-marker' } });
    await f.api.jobCommand('document-visited', { key });
    await f.api.jobCommand('document-visited', { key });
    assert.equal(f.api.state.job.logs.filter(entry => entry.eventCode === 'document-visited').length, 1,
      'legacy confirmed records must also deduplicate repeated legacy visit messages');
    assert.equal(f.api.state.job.candidates[0].records[key].visited, true);
    assert.equal(f.api.state.job.candidates[0].records[key].documentAccess, undefined);
    await f.api.jobCommand('course-pass', { phase: 'retry', pendingKeys: [] });
    f.api.state.processedItems.set(key, plain(f.api.state.job.candidates[0].records[key]));
    const result = await f.api.runSinglePassCourse(f.epoch);
    assert.equal(result.remaining, 1);
    assert.match(result.failures[0], /历史完成记录/);
    assert.doesNotMatch(result.failures[0], /80%/);
    await f.api.jobCommand('course-result', { result });
    const candidate = f.api.state.job.candidates[0];
    assert.equal(candidate.records[key].confirmed, true);
    assert.equal(candidate.status, 'manual');
    const ui = f.api.state.uiController;
    ui.navigate('course', { course: candidate.courseKey });
    assert.equal(f.window.document.getElementById('wb-body').textContent.includes('历史完成'), true);
    f.api.getMenuItems()[0].querySelector('.lecture-status').remove();
    assert.equal(f.api.observeDocument(f.api.getMenuItems()[0]).taskItem, null);
    assert.equal(f.api.observeDocument(f.api.getMenuItems()[0]).documentReason, 'marker-conflict');
  } finally { close(f); }
});

test('65 completed documents keep 32-entry batches and repeat observations cause no writes', async () => {
  const f = await prepared(Array.from({ length: 65 }, (_, i) => documentRow('文档' + i, 'done')));
  try {
    await f.api.documentCheckpoint(f.epoch, f.api.currentCourseKey(), true);
    assert.deepEqual(f.messages.filter(m => m.action === 'record-completions').map(m => m.entries.length), [32, 32, 1]);
    const revision = f.api.state.job.revision;
    await f.api.documentCheckpoint(f.epoch, f.api.currentCourseKey(), true);
    assert.equal(f.api.state.job.revision, revision);
    assert.equal(f.clicks.length, 0);
  } finally { close(f); }
});

test('observer coalesces changes without issuing clicks, messages or writes on its own', async () => {
  const f = await prepared([documentRow('文档A')]);
  try {
    const row = f.api.getMenuItems()[0];
    const commands = () => f.messages.filter(m => !['get', 'hello', 'log'].includes(m.action));
    const actions = commands().length;
    row.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
    for (let i = 0; i < 100; i++) row.setAttribute('title', String(i));
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(commands().length, actions);
    assert.equal(f.c.storage.local[KEY].candidates[0].directory.items[0].observedCompleted, false);
    assert.equal(Object.keys(f.c.storage.local[KEY].candidates[0].records).length, 0);
    assert.equal(f.clicks.length, 0);
    await f.api.documentCheckpoint(f.epoch, f.api.currentCourseKey());
    const confirmedRevision = f.api.state.job.revision;
    await f.api.documentCheckpoint(f.epoch, f.api.currentCourseKey());
    assert.equal(f.api.state.job.revision, confirmedRevision);
    assert.equal(f.messages.filter(m => m.action === 'record-completions').length, 1);
  } finally { close(f); }
});

test('an unknown document stays visible as pending and hides the completion denominator in the UI', async () => {
  const f = await prepared([documentRow('文档待核对', ''), documentRow('参考资料', 'none')]);
  try {
    const ui = f.api.state.uiController, candidate = f.api.state.job.candidates[0];
    const model = ui.render();
    assert.equal(model.overview.mediaTotal, null);
    ui.navigate('course', { course: candidate.courseKey });
    const page = f.window.document.querySelector('[data-view="course"]');
    assert.match(page.textContent, /任务标记待核对/);
    assert.match(page.textContent, /文档待核对 1/);
    assert.match(page.textContent, /总数统计中/);
    const exported = await f.c.request(f.id, f.api.state.instanceId, 'export-diagnostics');
    assert.equal(exported.diagnostics.documents[0].taskItem, null);
    assert.equal(exported.diagnostics.documents[1].taskItem, false);
    const scan = f.api.state.logEntries.find(entry => entry.eventCode === 'directory-scan-completed' &&
      entry.evidence?.unknownDocumentCount === 1);
    assert.equal(scan.evidence.documentCount, 0);
    f.api.getMenuItems()[0].querySelector('.lecture-status').remove();
    const updated = ui.render();
    assert.equal(updated.overview.mediaTotal, 0, 'a resolved reference no longer inflates the saved denominator');
    assert.equal(updated.overview.mediaConfirmed, 0);
  } finally { close(f); }
});

test('replacing the directory root reuses keys only after bounded full-directory validation', async () => {
  const f = await prepared([documentRow('文档A', ''), documentRow('文档B')]);
  try {
    const oldRoot = f.window.document.querySelector('.sub-menu-area');
    const key = f.api.getItemKey(f.api.getMenuItems()[0]);
    oldRoot.outerHTML = oldRoot.outerHTML;
    assert.equal(f.api.readDirectory().complete, false);
    f.api.getMenuItems()[0].querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
    await f.api.documentCheckpoint(f.epoch, f.api.currentCourseKey(), true);
    assert.equal(f.api.readDirectory().complete, true);
    assert.equal(f.api.state.job.candidates[0].records[key].confirmed, true);
    assert.equal(f.clicks.length, 0);
  } finally { close(f); }
});

test('course identity changes during a document wait cancel later clicks and cannot write access to the new course', async () => {
  const f = await prepared([documentRow('文档A'), documentRow('文档B')], {
    onClick(_item, page) {
      page.window.location.hash = page.window.location.hash.replace('course-1', 'course-2');
    }
  });
  try {
    await assert.rejects(f.api.runSinglePassCourse(f.epoch), /课程身份已改变/);
    assert.equal(f.clicks.length, 1);
    assert.equal(Object.values(f.c.storage.local[KEY].candidates[0].records).some(r => r.visited), false);
    assert.equal(f.c.reloads.length, 0);
  } finally { close(f); }
});

test('global verification remains blocking even when a document preview has failed', async () => {
  const f = await prepared([documentRow('文档A'), documentRow('文档B')], {
    onClick(item, page) {
      item.insertAdjacentHTML('beforeend', '<span role="alert">文档预览失败</span>');
      const blocked = page.window.document.createElement('div');
      blocked.className = 'el-message-box__wrapper';
      blocked.textContent = '请先登录';
      blocked.getClientRects = () => [{ width: 1, height: 1 }];
      page.window.document.body.append(blocked);
    }
  });
  try {
    await assert.rejects(f.api.runSinglePassCourse(f.epoch), error => error.constructor.name === 'TaskCancelled');
    await f.api.jobCommand('get');
    assert.equal(f.clicks.length, 1);
    assert.equal(f.c.reloads.length, 0);
  } finally { close(f); }
});

for (const mixed of [false, true]) {
  test(`the existing single course refresh confirms a delayed final document without document retries (${mixed ? 'mixed' : 'document only'})`, async () => {
    const f = await prepared([...(mixed ? [mediaItem('媒体已完成', 'video', 'done')] : []), documentRow('最后文档')]);
    let next;
    try {
      const key = f.api.getItemKey(f.api.getMenuItems().at(-1));
      await f.api.runSinglePassCourse(f.epoch);
      assert.equal(f.c.storage.local[KEY].candidates[0].records[key].confirmed, undefined);
      assert.equal(f.c.reloads.length, 1);
      const nextMessages = [];
      next = fixture([...(mixed ? [mediaItem('媒体已完成', 'video', 'done')] : []), documentRow('最后文档', 'done')], {
        connect(window) {
          f.c.connect(f.id)(window);
          const send = window.chrome.runtime.sendMessage;
          window.chrome.runtime.sendMessage = msg => { nextMessages.push(plain(msg)); return send(msg); };
        }
      });
      next.api.state.jobPromise = Promise.resolve();
      const job = await next.api.jobCommand('hello', { title: '测试课程' });
      assert.equal(job.ownerInstance, next.api.state.instanceId);
      next.api.state.running = true;
      next.api.state.activeGeneration = job.generation;
      next.api.state.processedCourseKey = next.api.currentCourseKey();
      next.api.state.processedItems = new next.window.Map(Object.entries(job.candidates[0].records));
      const result = await next.api.runSinglePassCourse(next.api.state.epoch);
      assert.equal(result.remaining, 0);
      assert.equal(result.total, mixed ? 2 : 1);
      assert.equal(result.finalPass, true);
      await next.api.jobCommand('course-result', { result });
      assert.equal(next.api.state.job.candidates[0].status, 'completed');
      assert.equal(f.c.reloads.length, 1);
      assert.equal(nextMessages.some(m => ['document-visited', 'resource-retry'].includes(m.action)), false);
      const old = await f.c.request(f.id, f.api.state.instanceId, 'document-visited', {
        ...auth(f.api.state.job), key, stage: 'result', attemptId: 'late', response: 'selected', preview: 'unknown'
      });
      assert.equal(old.ok, false);
    } finally { close(f); if (next) close(next); }
  });
}

test('unconfirmed documents finish with document-specific reasons and never join media retry fields', async () => {
  const f = await prepared([documentRow('文档A')]);
  try {
    const key = f.api.getItemKey(f.api.getMenuItems()[0]);
    await f.api.jobCommand('document-visited', { key });
    f.api.state.processedItems.set(key, plain(f.api.state.job.candidates[0].records[key]));
    await f.api.jobCommand('course-pass', { phase: 'retry', pendingKeys: [] });
    const result = await f.api.runSinglePassCourse(f.epoch);
    assert.equal(result.remaining, 1);
    assert.match(result.failures[0], /已访问，平台尚无完整完成标记/);
    assert.doesNotMatch(result.failures[0], /80%/);
    await assert.rejects(f.api.jobCommand('course-pass', { phase: 'retry', pendingKeys: [key] }), /待核对音视频/);
    await assert.rejects(f.api.jobCommand('resource-retry', { key, phase: 'final', token: 'invalid-document-retry' }), /音视频重试目标/);
    assert.equal(f.clicks.length, 0);
    assert.equal(f.c.reloads.length, 0);
  } finally { close(f); }
});

test('diagnostic storage failure does not block document visits or change platform completion', async () => {
  const f = await prepared([documentRow('文档A'), documentRow('文档B')], {
    beforeStorageSet(_area, values) {
      if (Object.hasOwn(values, 'xinwei-diagnostics-v1') && values['xinwei-diagnostics-v1']) throw new Error('synthetic diagnostics failure');
    },
    onClick(item) { item.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>'; }
  });
  try {
    const result = await f.api.runSinglePassCourse(f.epoch);
    assert.equal(result.refreshing, true);
    assert.equal(f.clicks.length, 2);
    assert.equal(Object.values(f.c.storage.local[KEY].candidates[0].records).every(r => r.confirmed), true);
    const report = await f.c.request(f.id, f.api.state.instanceId, 'export-diagnostics');
    assert.match(report.diagnostics.storageWarning, /诊断/);
    assert.equal(Object.values(report.diagnostics.records).every(r => r.documentAccess.response === 'selected'), true);
  } finally { close(f); }
});

test('a slow attempt save is awaited and a marker arriving during it skips the obsolete click', async () => {
  const gate = deferred(), saving = deferred();
  let held = false;
  const f = await prepared([documentRow('文档A')], {
    async beforeStorageSet(area, values) {
      if (!held && area === 'local' && Object.values(values[KEY]?.candidates[0]?.records || {}).some(r => r.documentAccess)) {
        held = true; saving.resolve(); await gate.promise;
      }
    }
  });
  try {
    const row = f.api.getMenuItems()[0], key = f.api.getItemKey(row);
    const task = f.api.runSinglePassCourse(f.epoch);
    await saving.promise;
    assert.equal(f.clicks.length, 0);
    row.querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
    gate.resolve();
    await task;
    assert.equal(f.clicks.length, 0);
    const record = f.c.storage.local[KEY].candidates[0].records[key];
    assert.equal(record.confirmed, true);
    assert.equal(record.visited, undefined);
  } finally { gate.resolve(); close(f); }
});

test('a status container going temporarily empty keeps task uncertainty and still saves this attempt result', async () => {
  const f = await prepared([documentRow('文档A'), documentRow('文档B')], {
    onClick(item) {
      if (item.textContent.includes('文档A')) item.querySelector('.lecture-status').replaceChildren();
    }
  });
  try {
    const key = f.api.getItemKey(f.api.getMenuItems()[0]);
    await f.api.runSinglePassCourse(f.epoch);
    const candidate = f.c.storage.local[KEY].candidates[0];
    assert.equal(f.clicks.length, 2);
    assert.equal(candidate.records[key].visited, true);
    assert.equal(candidate.records[key].confirmed, undefined);
    assert.equal(candidate.directory.items[0].taskItem, null);
    assert.equal(candidate.directory.items[0].documentReason, 'marker-conflict');
    f.api.getMenuItems()[0].querySelector('.lecture-status').remove();
    assert.equal(f.api.observeDocument(f.api.getMenuItems()[0]).taskItem, null,
      'repeated reads must not silently downgrade earlier task evidence to reference material');
  } finally { close(f); }
});

for (const action of ['pause', 'reset']) {
  test(`${action} during document response waiting prevents later clicks and ignores a late DOM completion`, async () => {
    const clicked = deferred();
    const f = await prepared([documentRow('文档A'), documentRow('文档B')], {
      onClick() { clicked.resolve(); }
    });
    try {
      Object.assign(f.api.CFG, { documentClickDelayMin: 500, documentClickDelayMax: 500 });
      const task = f.api.runSinglePassCourse(f.epoch);
      const rejected = assert.rejects(task, error => error.constructor.name === 'TaskCancelled');
      await clicked.promise;
      if (action === 'pause') await f.api.stop(false);
      else await f.api.resetPlugin({ confirmed: true });
      await rejected;
      f.api.getMenuItems()[0].querySelector('.lecture-status').innerHTML = '<i class="done-icon"></i>';
      await new Promise(resolve => setTimeout(resolve, 15));
      await f.api.jobCommand('get');
      assert.equal(f.clicks.length, 1);
      assert.equal(f.c.reloads.length, 0);
      assert.equal(f.c.storage.local[KEY].candidates.some(c => Object.values(c.records || {}).some(r => r.confirmed)), false);
      assert.equal(f.api.state.running, false);
    } finally { close(f); }
  });
}
