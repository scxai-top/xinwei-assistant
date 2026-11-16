const test = require('node:test');
const assert = require('node:assert/strict');
const { coordinator } = require('./coordinator.cjs');
const { fixture, homeFixture, homeCardContent, mediaItem, waitFor } = require('./helpers.cjs');
const KEY = 'xinwei-job-v3';
const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';

for (const loseResultResponse of [false, true]) test('public dual-mode UI serial completion; lost result response=' + loseResultResponse, { timeout: 20000 }, async () => {
  const c = coordinator(), home = c.addTab(HOME), docs = new Map(), all = [], opened = [], commands = [];
  let dropped = false;
  const connect = id => window => {
    c.connect(id)(window); const send = window.chrome.runtime.sendMessage;
    window.chrome.runtime.sendMessage = async msg => {
      commands.push(msg.action); const response = await send(msg);
      if (loseResultResponse && !dropped && msg.action === 'course-result' && response.ok) {
        dropped = true; throw new Error('synthetic response transport loss');
      }
      return response;
    };
  };
  const urls = Object.fromEntries(['A', 'B'].map(key => [key,
    `https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/${key}/video/v?classId=class-${key}`]));
  const register = (id, f) => { f.api.CFG.backgroundProbeDelay = 1; docs.set(id, f); all.push(f); return f; };
  function renderHome(id) {
    const f = register(id, homeFixture(['A', 'B'].map(key => homeCardContent(key, '正在上课', 80)), { connect: connect(id) }));
    f.window.document.querySelector('.btn-next').disabled = true;
    f.window.document.querySelectorAll('.item-bg-text p.sle').forEach(el => el.addEventListener('click', () => {
      const key = el.textContent.trim(); opened.push(key);
      const tab = c.addTab(urls[key], id);
      register(tab, fixture([mediaItem('已确认视频', 'video', 'done')], { title: key, url: urls[key], connect: connect(tab) }));
    }));
    return f;
  }
  c.onNavigation.addListener(tab => {
    docs.get(tab.id)?.dom.window.close();
    if (tab.url === HOME) renderHome(tab.id);
  });
  let tick;
  try {
    const f = renderHome(home);
    f.window.document.getElementById('wb-start').click();
    await waitFor(() => c.storage.session[KEY]?.phase === 'selection');
    assert.equal(opened.length, 0, 'default list collection stays semi automatic');
    f.api.state.uiController.render();
    const button = f.window.document.querySelector('[data-outer-action="outer-start"]');
    assert.ok(button); assert.equal(button.disabled, false); button.click();
    tick = setInterval(() => { for (const page of docs.values()) page.api.syncSharedJob(); }, 20);
    await waitFor(() => c.storage.session[KEY]?.outer?.state === 'finished', 12000);
    const job = c.storage.session[KEY];
    assert.deepEqual(opened, ['A', 'B']);
    assert.equal(commands.filter(action => action === 'course-select').length, 2);
    assert.equal(commands.filter(action => action === 'outer-stopped').length, 2);
    assert.equal(job.outer.summary.completed, 2);
    for (const candidate of job.candidates) assert.equal(candidate.timetablePercent, 80);
    for (const page of docs.values()) {
      assert.equal(page.api.state.jobPromise, null);
      assert.equal(page.media?.paused ?? true, true);
    }
  } finally { clearInterval(tick); for (const f of all) f.dom.window.close(); }
});

test('home skip evidence excludes hidden cards/bars, unknown values and 99.99', () => {
  const f = homeFixture([homeCardContent('A', '正在上课', 100)]);
  try {
    const card = f.window.document.querySelector('.course-card-item');
    const bar = card.querySelector('[role="progressbar"]');
    card.getClientRects = bar.getClientRects = () => [{ width: 100, height: 20 }];
    assert.equal(f.api.getHomeCourseCandidate(card, 1, 0).homeEvidence.percent, 100);
    bar.style.display = 'none'; assert.equal(f.api.getHomeCourseCandidate(card, 1, 0).homeEvidence, null);
    bar.style.display = ''; card.style.display = 'none';
    assert.equal(f.api.getHomeCourseCandidate(card, 1, 0).homeEvidence, null);
    card.style.display = ''; bar.setAttribute('aria-valuenow', '99.99');
    assert.equal(f.api.getHomeCourseCandidate(card, 1, 0).homeEvidence.percent, 99.99);
    bar.removeAttribute('aria-valuenow'); assert.equal(f.api.getHomeCourseCandidate(card, 1, 0).homeEvidence, null);
  } finally { f.dom.window.close(); }
});


test('real content scanner traverses nine delayed chapters beyond 180s without outer cancellation', { timeout: 40000 }, async () => {
  const c = coordinator(), home = c.addTab(HOME), all = [], reports = [];
  let course, loaded = 0, tick;
  const f = homeFixture([homeCardContent('缓慢课程', '正在上课', 80)], { connect: c.connect(home) }); all.push(f);
  f.window.document.querySelector('.btn-next').disabled = true;
  f.window.document.querySelector('.item-bg-text p.sle').addEventListener('click', () => {
    const url = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/slow/video/v?classId=class-slow';
    const tab = c.addTab(url, home);
    course = fixture([mediaItem('首章视频', 'video', 'done')], { title: '缓慢课程', url, connect(window) {
      c.connect(tab)(window); const send = window.chrome.runtime.sendMessage;
      window.chrome.runtime.sendMessage = msg => { if (msg.outerExecution) reports.push(msg.outerExecution); return send(msg); };
    }, beforeContent({ window }) {
      const root = window.document.querySelector('.sub-menu-area > ul');
      root.insertAdjacentHTML('beforeend', Array.from({ length: 9 }, (_, i) => `<li class="el-sub-menu" aria-expanded="false"><div class="el-sub-menu__title">章${i}</div><ul></ul></li>`).join(''));
      for (const [i, chapter] of [...root.querySelectorAll('[aria-expanded="false"]')].entries()) {
        chapter.querySelector('.el-sub-menu__title').addEventListener('click', () => {
          setTimeout(async () => {
            c.advanceTime(25000);
            chapter.setAttribute('aria-expanded', 'true');
            chapter.querySelector('ul').innerHTML = mediaItem(`视频${i}`, 'video', 'done');
            loaded++;
            await course.api.syncSharedJob();
          }, 80);
        });
      }
    } }); all.push(course);
  });
  try {
    f.window.document.getElementById('wb-start').click();
    await waitFor(() => c.storage.session[KEY]?.phase === 'selection');
    f.api.state.uiController.render(); f.window.document.querySelector('[data-outer-action="outer-start"]').click();
    tick = setInterval(() => { for (const page of all) page.api.syncSharedJob(); }, 10);
    await waitFor(() => c.storage.session[KEY]?.outer?.state === 'finished', 35000).catch(error => {
      const job = c.storage.session[KEY];
      throw new Error(`${error.message}; loaded=${loaded}, phase=${job?.phase}, outer=${job?.outer?.state}, reason=${job?.reason || ''}`);
    });
    assert.equal(loaded, 9); assert.equal(c.storage.session[KEY].outer.summary.completed, 1);
    assert.equal(c.storage.session[KEY].candidates[0].directory.items.length, 10);
    assert.ok(reports.some(r => r.active && r.scan[1] >= 8), 'owner reports actual expanded chapters on existing get');
    assert.equal(c.storage.session[KEY].outer.entries[0].reentries, 0);
  } finally { clearInterval(tick); for (const page of all) page.dom.window.close(); }
});

test('outer requested home scan reads all ten delayed pages without a whole-scan time cap', { timeout: 20000 }, async () => {
  const c = coordinator(), tab = c.addTab(HOME), reports = [];
  const f = homeFixture([homeCardContent('第1页')], { connect(window) {
    c.connect(tab)(window); const send = window.chrome.runtime.sendMessage;
    window.chrome.runtime.sendMessage = msg => { if (msg.outerExecution) reports.push(msg.outerExecution); return send(msg); };
  } });
  const doc = f.window.document;
  let page = 1, tick;
  try {
    doc.querySelector('.btn-next').disabled = true;
    doc.getElementById('wb-start').click();
    await waitFor(() => c.storage.session[KEY]?.phase === 'selection');
    c.advanceTime(310000); // A stale list uses the original scan-home entry.
    doc.querySelectorAll('li.number')[1].remove();
    const next = doc.querySelector('.btn-next'); next.disabled = false;
    next.addEventListener('click', () => {
      setTimeout(async () => {
        c.advanceTime(25000); page++;
        doc.querySelector('li.number').textContent = String(page);
        doc.querySelector('.cards').innerHTML = homeCardContent(`第${page}页`);
        next.disabled = page === 10;
        await f.api.syncSharedJob();
      }, 80);
    });
    f.api.state.uiController.render(); doc.querySelector('[data-outer-action="outer-start"]').click();
    tick = setInterval(() => f.api.syncSharedJob(), 10);
    await waitFor(() => c.storage.session[KEY]?.outer?.scopeConfirmed === true, 15000);
    const job = c.storage.session[KEY];
    assert.equal(job.outer.entries.length, 10);
    assert.deepEqual(job.candidates.map(c => c.title), Array.from({ length: 10 }, (_, i) => `第${i + 1}页`));
    assert.equal(job.outer.state, 'active');
    assert.ok(reports.some(r => r.active && r.phase === 'scan-home' && r.scan[0] >= 8));
    await f.api.stop();
  } finally { clearInterval(tick); f.dom.window.close(); }
});

test('finished and revoked history never overrides current manual scan/play/pause/failure or later selection', () => {
  for (const outerState of ['finished', 'revoked']) {
    const f = fixture([mediaItem('视频', 'video')]);
    try {
      const key = f.api.currentCourseKey(); f.api.state.tabId = 1;
      const job = f.api.state.job = { runId: 'later', generation: 8, workflow: 'manual', scope: 'all',
        running: true, phase: 'course', operation: 'inspect', targetPurpose: 'inspect', ownerTabId: 1, ownerInstance: f.api.state.instanceId, workerTabId: 1,
        targetIndex: 0, selectedIndex: 0,
        candidates: [{ key: 'A', title: '当前单课', courseKey: key, status: 'inspected', scanState: 'scanning',
          total: 1, remaining: 1, directory: f.api.getDirectorySnapshot(), records: {} }],
        outer: { state: outerState, historyOnly: true, entries: [{ key: 'A', title: '当前单课', state: 'completed' }],
          summary: { completed: 1, skipped: 0, failed: 0 } } };
      for (const [phase, operation, running, expected] of [
        ['course', 'inspect', true, /统计/], ['course', 'play', true, /学习/],
        ['paused', 'play', false, /已暂停/], ['manual', 'play', false, /需要你处理/],
        ['selection', '', false, /等待选择/]
      ]) {
        Object.assign(job, { phase, operation, targetPurpose: operation, running });
        f.api.updateTaskControls(); const model = f.api.state.uiController.render();
        assert.match(model.home.status, expected);
        const card = f.window.document.querySelector('.wb-home-course-info');
        assert.doesNotMatch(card?.textContent || '', /本轮内层确认完成/);
        assert.match(f.window.document.body.textContent, /上轮全自动记录（历史）/);
      }
    } finally { f.dom.window.close(); }
  }
});

test('home UI resumes paused owner in place through real content handshake and shows power setting', { timeout: 15000 }, async () => {
  const c = coordinator(), home = c.addTab(HOME), all = [];
  let owner, opened = 0, tick;
  let f = homeFixture([homeCardContent('A', '正在上课', 80)], { connect: c.connect(home) }); all.push(f);
  f.window.document.querySelector('.btn-next').disabled = true;
  f.window.document.querySelector('.item-bg-text p.sle').addEventListener('click', () => {
    opened++;
    const url = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/A/video/v?classId=class-A';
    const tab = c.addTab(url, home);
    owner = fixture([mediaItem('视频')], { title: 'A', url, duration: 600, connect: c.connect(tab),
      beforeContent({ window }) { window.document.querySelector('li.el-menu-item').classList.add('is-active'); } });
    owner.api.CFG.mediaLoadTimeout = 500;
    all.push(owner);
  });
  try {
    f.window.document.getElementById('wb-start').click();
    await waitFor(() => c.storage.session[KEY]?.phase === 'selection');
    f.api.state.uiController.render(); f.window.document.querySelector('[data-outer-action="outer-start"]').click();
    tick = setInterval(() => { for (const page of all) page.api.syncSharedJob(); }, 20);
    await waitFor(() => owner && !owner.media.paused, 8000);
    await owner.api.stop();
    await waitFor(() => !owner.api.state.jobPromise && !owner.api.state.running);
    // Reloaded home and owner documents retain tab IDs, but receive new instances.
    const ownerId = c.storage.session[KEY].ownerTabId;
    const ownerURL = c.tabs.get(ownerId).url;
    clearInterval(tick);
    await Promise.all(all.map(page => page.api.state.syncPromise));
    f.dom.window.close(); owner.dom.window.close();
    f = homeFixture([homeCardContent('A', '正在上课', 80)], { connect: c.connect(home) }); all.push(f);
    owner = fixture([mediaItem('视频')], { title: 'A', url: ownerURL, duration: 600, connect: c.connect(ownerId),
      beforeContent({ window }) { window.document.querySelector('li.el-menu-item').classList.add('is-active'); } }); all.push(owner);
    tick = setInterval(() => { for (const page of [f, owner]) page.api.syncSharedJob(); }, 20);
    await owner.api.syncSharedJob(); await f.api.syncSharedJob(); f.api.state.uiController.render();
    const paused = structuredClone(c.storage.session[KEY]);
    const buttons = f.window.document.querySelector('.wb-outer-controls .wb-actions');
    assert.equal(buttons.children.length, 2, 'title is outside two-column button row');
    const resume = buttons.querySelector('[data-outer-action="outer-continue"]');
    assert.equal(resume.disabled, false); assert.equal(resume.textContent, '继续运行');
    const power = f.window.document.getElementById('wb-keep-awake');
    assert.equal(power.checked, false); power.click();
    await waitFor(() => f.api.state.power?.enabled === true);
    assert.equal(f.api.state.power.requested, false, 'paused does not hold power');
    const n = c.navigation.length;
    resume.click();
    await waitFor(() => c.storage.session[KEY]?.outer?.state === 'active' && !owner.media.paused, 8000);
    assert.equal(opened, 1); assert.equal(c.reloads.length, 0);
    assert.equal(c.navigation.slice(n).some(x => Object.hasOwn(x, 'url')), false);
    const resumed = c.storage.session[KEY];
    assert.equal(resumed.outer.id, paused.outer.id); assert.equal(resumed.ownerTabId, paused.ownerTabId);
    assert.equal(c.powerCalls.at(-1).action, 'request');
    await owner.api.stop();
    assert.equal(c.powerCalls.at(-1).action, 'release');
  } finally { clearInterval(tick); for (const page of all) page.dom.window.close(); }
});

test('resume rejection stays visible across polling without altering the paused round', async () => {
  const f = homeFixture([]);
  try {
    const job = { runId: 'notice-test', generation: 5, resetEpoch: 0, running: false, phase: 'paused', resumePhase: 'course',
      workflow: 'manual', scope: 'all', ownerTabId: 2, homeTabId: 1, listScannedAt: Date.now(), candidates: [], logs: [],
      outer: { id: 'round', state: 'paused', cursor: 0, entries: [], reason: '监督检查中断' } };
    f.window.chrome.runtime.sendMessage = async msg => msg.action === 'outer-continue'
      ? { ok: false, error: '原学习页已关闭，无法原页继续；本轮记录已保留' }
      : { ok: true, job, tabId: 1 };
    await f.api.jobCommand('get');
    await f.api.start({ outerAction: 'outer-continue' });
    assert.ok(f.api.state.logEntries.some(x => x.eventCode === 'outer-resume-rejected'));
    await f.api.jobCommand('get'); f.api.state.uiController.render();
    const notice = f.window.document.getElementById('wb-ui-notice');
    assert.equal(notice.hidden, false); assert.match(notice.textContent, /原学习页已关闭/);
    assert.equal(f.api.state.job.generation, 5); assert.equal(f.api.state.job.outer.state, 'paused');
  } finally { f.dom.window.close(); }
});


test('new home UI reopens closed owner and the unchanged inner executor starts actual media', { timeout: 20000 }, async () => {
  const c = coordinator(), home = c.addTab(HOME), docs = new Map(), all = [];
  const url = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/A/video/v?classId=class-A';
  let tick, owner;
  function register(id, f) { docs.set(id, f); all.push(f); return f; }
  function renderCourse(id) {
    owner = register(id, fixture([mediaItem('视频')], { title: 'A', url, duration: 600, connect: c.connect(id),
      beforeContent({ window }) { window.document.querySelector('li.el-menu-item').classList.add('is-active'); } }));
    owner.api.CFG.mediaLoadTimeout = 500;
    return owner;
  }
  function renderHome(id) {
    const f = register(id, homeFixture([homeCardContent('A', '正在上课', 80)], { connect: c.connect(id) }));
    f.window.document.querySelector('.btn-next').disabled = true;
    f.window.document.querySelector('.item-bg-text p.sle').addEventListener('click', () => renderCourse(c.addTab(url, id)));
    return f;
  }
  c.onNavigation.addListener(tab => {
    docs.get(tab.id)?.dom.window.close(); docs.delete(tab.id);
    if (tab.url === url) renderCourse(tab.id);
  });
  try {
    const f = renderHome(home);
    f.window.document.getElementById('wb-start').click();
    await waitFor(() => c.storage.session[KEY]?.phase === 'selection');
    f.api.state.uiController.render(); f.window.document.querySelector('[data-outer-action="outer-start"]').click();
    tick = setInterval(() => { for (const page of docs.values()) page.api.syncSharedJob(); }, 20);
    await waitFor(() => owner && !owner.media.paused, 8000);
    await owner.api.stop(); await waitFor(() => !owner.api.state.jobPromise);
    const before = structuredClone(c.storage.session[KEY]);
    owner.dom.window.close(); docs.delete(before.ownerTabId); await c.closeTab(before.ownerTabId);
    f.dom.window.close(); docs.delete(home); await c.closeTab(home);
    const newHomeId = c.addTab(HOME), newHome = renderHome(newHomeId);
    await newHome.api.syncSharedJob(); newHome.api.state.uiController.render();
    const button = newHome.window.document.querySelector('[data-outer-action="outer-continue"]');
    assert.equal(button.disabled, false); assert.match(newHome.window.document.body.textContent, /上次课程：A/);
    owner = null; button.click();
    await waitFor(() => owner && !owner.media.paused && c.storage.session[KEY]?.phase === 'course', 8000);
    const after = c.storage.session[KEY];
    assert.equal(after.outer.id, before.outer.id); assert.equal(after.ownerTabId, newHomeId);
    assert.equal(after.outer.entries[0].reentries, before.outer.entries[0].reentries);
    assert.ok(after.logs.some(x => x.eventCode === 'outer-resume-arrived'));
    assert.equal(c.reloads.length, 0);
    await owner.api.stop();
  } finally { clearInterval(tick); for (const f of all) f.dom.window.close(); }
});
