const assert = require('node:assert/strict');
const test = require('node:test');
const { coordinator } = require('./coordinator.cjs');
const { fixture, mediaItem, waitFor } = require('./helpers.cjs');

const KEY = 'xinwei-job-v3';
const DIAGNOSTICS_KEY = 'xinwei-diagnostics-v1';
const COURSE = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course/video/resource?classId=class';
const auth = job => ({ runId: job.runId, generation: job.generation, resetEpoch: job.resetEpoch || 0 });
async function prepared(options = {}) {
  const c = coordinator();
  const id = c.addTab(COURSE);
  const response = await c.request(id, 'page', 'start', { title: '课程', scope: 'single', ...options });
  assert.equal(response.ok, true);
  return { c, id, job: response.job };
}

test('结构化日志按原ID去重；异常现场单份落盘并在后台和浏览器重启后仍可只读导出', async () => {
  const { c, id, job } = await prepared();
  const payload = { ...auth(job), id: 'page:incident', text: '播放异常，尚未恢复', type: 'err',
    time: Date.now(), resourceKey: 'resource', eventCode: 'error',
    diagnostic: { time: Date.now(), route: 'learn', selectedResourceKey: 'resource',
      media: { currentTime: 12, duration: 60, paused: true, errorCode: 2 },
      recent: [{ type: 'waiting' }], error: { message: 'https://example.test/?token=private-token' } } };
  const first = await c.request(id, 'page', 'log', payload);
  assert.equal(first.ok, true);
  const duplicate = await c.request(id, 'page', 'log', payload);
  assert.equal(duplicate.job.logSequence, first.job.logSequence);
  const logs = duplicate.job.logs.filter(entry => entry.id === payload.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].courseKey, 'course::class');
  assert.equal(logs[0].eventCode, 'error');
  assert.equal(logs[0].source, 'content');
  assert.equal(c.storage.local[DIAGNOSTICS_KEY].incident.media.currentTime, 12);
  assert.ok(!JSON.stringify(c.storage.local[DIAGNOSTICS_KEY]).includes('private-token'));
  assert.equal(duplicate.job.running, job.running);
  assert.equal(duplicate.job.generation, job.generation);
  c.restartWorker();
  c.restartBrowser();
  const before = JSON.stringify(c.storage);
  const exported = await c.request(id, 'reader', 'export-diagnostics');
  assert.equal(exported.ok, true);
  assert.equal(exported.job, undefined);
  assert.equal(exported.diagnostics.incident.media.duration, 60);
  assert.equal(exported.diagnostics.logs.filter(entry => entry.id === payload.id).length, 1);
  assert.equal(JSON.stringify(c.storage), before);
  assert.equal(c.reloads.length, 0);
  assert.equal(c.navigation.length, 0);
});

test('五处原身份拒绝保留条件、文字和状态，证据区分sender与已读取tab；缺失身份明确未知', async () => {
  const snapshot = { version: 1, courseKey: 'course::class', items: [
    { key: 'video', title: '视频', mediaType: 'video', durationSeconds: 60 }
  ] };
  const commands = [
    ['directory-checkpoint', { snapshot }],
    ['resource-checkpoint', { key: 'video', title: '视频', stage: 'ready', routeKey: new URL(COURSE).pathname + new URL(COURSE).hash }],
    ['record', { key: 'video', result: { title: '视频', started: true, ended: false, confirmed: false } }],
    ['course-result', { result: { total: 1, remaining: 1, finalPass: true } }],
    ['record-completions', { entries: [{ key: 'video', sitePercent: null, completionSource: 'page-marker' }] }]
  ];
  for (const [action, payload] of commands) {
    for (const [url, actual] of [
      [COURSE, 'course::class'],
      [COURSE.replace('/course/video/', '/other-course/video/'), 'other-course::class'],
      [COURSE.replace('classId=class', 'classId=other-class'), 'course::other-class'],
      [COURSE.split('?')[0], null]
    ]) {
      const { c, id, job } = await prepared({ singlePass: true });
      const saved = await c.request(id, 'page', 'directory-checkpoint', { ...auth(job), snapshot });
      assert.equal(saved.ok, true);
      // Batch confirmation reads tab.url first; other original branches use sender.url.
      if (action === 'record-completions') c.tabs.get(id).url = url;
      const before = JSON.stringify(c.storage.session[KEY]);
      const response = await c.request(id, 'page', action, { ...auth(job), ...payload }, url);
      if (actual === 'course::class') {
        assert.equal(response.ok, true, `${action}: ${response.error}`);
        assert.equal(response.errorDetails, undefined);
      } else {
        assert.equal(response.ok, false, action);
        assert.equal(response.error, '课程身份已改变');
        assert.equal(response.errorCode, 'TASK_COMMAND_REJECTED');
        assert.deepEqual(JSON.parse(JSON.stringify(response.errorDetails)), {
          action, rule: 'course-identity-match', expectedCourseKey: 'course::class',
          actualCourseKey: actual, actualSource: action === 'record-completions' ? 'tab.url' : 'sender.url',
          actualRoute: actual ? 'learn' : 'learn-unsupported', ...(!actual ? { incomplete: true } : {})
        });
        assert.equal(JSON.stringify(c.storage.session[KEY]), before, '拒绝不修改任务');
        assert.ok(!JSON.stringify(response).includes('https://'));
      }
      assert.equal(c.navigation.length, 0);
      assert.equal(c.reloads.length, 0);
    }
  }
  const { c, id, job } = await prepared({ singlePass: true });
  await c.request(id, 'page', 'directory-checkpoint', { ...auth(job), snapshot });
  const response = await c.request(id, 'page', 'record-completions',
    { ...auth(job), ...commands.at(-1)[1] }, COURSE.replace('classId=class', 'classId=stale'));
  assert.equal(response.errorDetails.actualSource, 'sender.url', 'tab检查通过后，原内部record检查仍可拒绝sender身份');
  assert.equal(response.errorDetails.actualCourseKey, 'course::stale');
  const cancelled = await c.request(id, 'retired', 'directory-checkpoint', { ...auth(job), snapshot });
  assert.equal(cancelled.error, 'TASK_CANCELLED');
  assert.equal(cancelled.errorDetails, undefined);
});

test('真实消息链把目录拒绝详情传入原人工停止现场，重启导出保留命令和身份而不自动恢复', async () => {
  for (const failDiagnostic of [false, true]) {
    const c = coordinator();
    const url = 'https://www.beeline-ai.com/student/#/courseInfo/learn/courseWare/course-1/video/resource-1?classId=class-1';
    const id = c.addTab(url);
    const f = fixture([mediaItem('视频')], { url, connect(window) {
      c.connect(id)(window);
      const send = window.chrome.runtime.sendMessage;
      window.chrome.runtime.sendMessage = message => message.action === 'directory-checkpoint'
        ? c.request(id, message.instanceId, message.action, message, url.replace('classId=class-1', 'classId=stale'))
        : send(message);
    } });
    try {
      f.api.state.jobPromise = Promise.resolve();
      await f.api.jobCommand('start', { title: '测试课程', scope: 'single', singlePass: true });
      if (failDiagnostic) Object.defineProperty(c.storage.local, DIAGNOSTICS_KEY, {
        configurable: true, get: () => undefined, set() { throw new Error('quota'); }
      });
      f.api.state.jobPromise = null;
      await f.api.syncSharedJob();
      await waitFor(() => c.storage.session[KEY]?.phase === 'manual');
      const job = c.storage.session[KEY];
      assert.equal(job.reason, '课程身份已改变');
      assert.equal(job.running, false);
      const incident = job.diagnostic;
      assert.equal(incident.error.code, 'TASK_COMMAND_REJECTED');
      assert.equal(incident.error.action, 'directory-checkpoint');
      assert.equal(incident.error.details.rule, 'course-identity-match');
      assert.equal(incident.error.details.expectedCourseKey, 'course-1::class-1');
      assert.equal(incident.error.details.actualCourseKey, 'course-1::stale');
      assert.equal(incident.error.details.actualSource, 'sender.url');
      const rejected = job.logs.filter(entry => entry.eventCode === 'command-rejected');
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].evidence.action, 'directory-checkpoint');
      assert.equal(job.logs.filter(entry => entry.eventCode === 'directory-scan-started').length, 1);
      assert.equal(job.logs.some(entry => entry.eventCode === 'directory-scan-completed'), false);
      assert.equal(job.logs.some(entry => entry.eventCode === 'recovery-verified'), false);
      assert.equal(c.navigation.length, 0);
      assert.equal(c.reloads.length, 0);
      if (!failDiagnostic) {
        c.restartWorker();
        c.restartBrowser();
        const exported = await c.request(id, 'reader', 'export-diagnostics');
        assert.deepEqual(JSON.parse(JSON.stringify(exported.diagnostics.incident.error)), JSON.parse(JSON.stringify(incident.error)));
        assert.equal(exported.diagnostics.logs.filter(entry => entry.eventCode === 'command-rejected').length, 1);
      }
    } finally { f.window.close(); }
  }
});

test('新增证据白名单、脱敏和长度上限同时覆盖日志、异常现场及本页待保存记录', async () => {
  const { c, id, job } = await prepared();
  const raw = { action: 'directory-checkpoint', rule: 'x'.repeat(1000),
    expectedCourseKey: 'course::class?token=private-token',
    actualCourseKey: 'Bearer private-bearer', actualSource: 'https://example.test/?password=private-password',
    count: Infinity, arbitrary: { cookie: 'private-cookie' } };
  const r = await c.request(id, 'page', 'log', { ...auth(job), id: 'bounded:1', text: '证据',
    eventCode: 'command-rejected', evidence: raw,
    diagnostic: { time: Date.now(), error: { code: 'TASK_COMMAND_REJECTED', action: 'directory-checkpoint', details: raw } }
  });
  assert.equal(r.ok, true);
  const evidence = r.job.logs.at(-1).evidence;
  assert.equal(evidence.rule.length, 240);
  assert.equal(evidence.actualSource, '[url omitted]');
  assert.equal(evidence.incomplete, true);
  assert.equal(evidence.arbitrary, undefined);
  for (const secret of ['private-token', 'private-bearer', 'private-password', 'private-cookie']) {
    assert.ok(!JSON.stringify(r.job).includes(secret));
    assert.ok(!JSON.stringify(c.storage.local[DIAGNOSTICS_KEY]).includes(secret));
  }
  const f = fixture([mediaItem('视频')]);
  try {
    const local = f.api.appendLog('本页日志', 'info', Date.now(), { evidence: raw, resourceKey: '', eventCode: 'directory-scan-started' });
    assert.equal(local.resourceKey, '');
    assert.equal(local.evidence.rule.length, 240);
    assert.equal(local.evidence.arbitrary, undefined);
    assert.equal(local.evidence.count, undefined);
    assert.ok(!JSON.stringify(local).includes('private-'));
    const broken = f.api.appendLog('可选证据异常', 'info', Date.now(), {
      evidence: { get action() { throw new Error('optional evidence'); } }
    });
    assert.equal(broken.evidence.incomplete, true);
    assert.equal(f.api.state.mode, 'idle');
  } finally { f.window.close(); }
});

test('诊断存储失败不改变任务、触发导航或暂停，导出明确提示记录降级', async () => {
  const { c, id, job } = await prepared();
  Object.defineProperty(c.storage.local, DIAGNOSTICS_KEY, {
    configurable: true, get: () => undefined, set() { throw new Error('diagnostic quota'); }
  });
  const r = await c.request(id, 'page', 'log', {
    ...auth(job), id: 'page:failure', text: '仅日志失败', type: 'err'
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.running, job.running);
  assert.equal(r.job.generation, job.generation);
  assert.equal(r.job.phase, job.phase);
  const exported = await c.request(id, 'reader', 'export-diagnostics');
  assert.match(exported.diagnostics.storageWarning, /暂未保存/);
  assert.equal(c.reloads.length, 0);
  assert.equal(c.navigation.length, 0);
});

test('暂停保存现场；退役实例不能覆盖现场；重置清理新增诊断且迟到日志不能重建', async () => {
  const { c, id, job } = await prepared();
  const diagnostic = { time: Date.now(), media: { currentTime: 20, paused: false }, recent: [] };
  const paused = await c.request(id, 'page', 'pause', { ...auth(job), diagnostic });
  assert.equal(paused.ok, true);
  assert.equal(paused.job.running, false);
  assert.equal(c.storage.local[DIAGNOSTICS_KEY].incident.eventCode, 'pause');
  assert.equal(c.storage.local[DIAGNOSTICS_KEY].incident.media.currentTime, 20);
  const invalid = await c.request(id, 'old-page', 'log', {
    ...auth(paused.job), id: 'old-page:1', text: '过期', type: 'err',
    diagnostic: { time: Date.now(), media: { currentTime: 999 } }
  });
  assert.equal(invalid.ok, false);
  assert.equal(c.storage.local[DIAGNOSTICS_KEY].incident.media.currentTime, 20);
  const reset = await c.request(id, 'page', 'reset', auth(paused.job));
  assert.equal(reset.ok, true);
  assert.equal(c.storage.local[DIAGNOSTICS_KEY], null);
  const late = await c.request(id, 'page', 'log', {
    ...auth(job), id: 'page:late', text: '迟到', diagnostic
  });
  assert.equal(late.ok, false);
  assert.equal(c.storage.local[DIAGNOSTICS_KEY], null);
  assert.deepEqual(c.storage.session[KEY].logs, []);
});

test('日志上限仍为300条，导出不经过会触发恢复的任务读取路径', async () => {
  const { c, id, job } = await prepared();
  const current = c.storage.session[KEY];
  current.logs = Array.from({ length: 300 }, (_, index) => ({
    id: `old:${index}`, time: index, type: 'info', text: `旧记录${index}`
  }));
  const r = await c.request(id, 'page', 'log', {
    ...auth(job), id: 'page:latest', text: '最新记录', type: 'info'
  });
  assert.equal(r.job.logs.length, 300);
  assert.equal(r.job.logs[0].id, 'old:1');
  c.storage.session[KEY].phase = 'entry-home';
  c.storage.session[KEY].entryDeadline = Date.now() - 1000;
  const before = JSON.stringify(c.storage.session[KEY]);
  const exported = await c.request(id, 'reader', 'export-diagnostics');
  assert.equal(exported.ok, true);
  assert.equal(JSON.stringify(c.storage.session[KEY]), before);
  assert.equal(c.navigation.length, 0);
});

test('沿用原课末刷新：刷新前保存现场，诊断写入失败也不增加或阻止原刷新', async () => {
  for (const failDiagnostic of [false, true]) {
    let reloadChecked = false;
    const c = coordinator({ beforeReload: async () => {
      reloadChecked = true;
      if (!failDiagnostic) {
        const saved = c.storage.local[DIAGNOSTICS_KEY];
        assert.equal(saved.incident.eventCode, 'course-refresh');
        assert.equal(saved.incident.selectedResourceKey, 'document-A');
        assert.equal(saved.logs.at(-1).eventCode, 'course-refresh');
      }
    } });
    const id = c.addTab(COURSE);
    const started = await c.request(id, 'page', 'start', { title: '课程', scope: 'single', singlePass: true });
    if (failDiagnostic) Object.defineProperty(c.storage.local, DIAGNOSTICS_KEY, {
      configurable: true, get: () => null, set() { throw new Error('diagnostic quota'); }
    });
    const refreshed = await c.request(id, 'page', 'course-refresh', {
      ...auth(started.job), token: 'original-refresh',
      diagnostic: { time: Date.now(), route: 'learn', selectedResourceKey: 'document-A' }
    });
    assert.equal(refreshed.ok, true, refreshed.error);
    assert.equal(reloadChecked, true);
    assert.equal(c.reloads.length, 1);
    assert.equal(refreshed.job.generation, started.job.generation);
    assert.equal(refreshed.job.running, true);
  }
});

test('页面保留原早期诊断并滚动保存最近12条媒体观察；导出不发送播放或任务控制命令', async () => {
  const actions = [];
  const f = fixture([mediaItem('视频')], { chrome: { runtime: {
    sendMessage: async message => {
      actions.push(message.action);
      return message.action === 'export-diagnostics'
        ? { ok: true, diagnostics: { schemaVersion: 1, logs: [], storageWarning: '' } }
        : { ok: true, job: null, tabId: 1 };
    }
  } } });
  try {
    for (let i = 0; i < 70; i++) {
      f.advanceNaturally(i);
      f.media.dispatchEvent(new f.window.Event('waiting'));
    }
    assert.equal(f.api.state.playbackDiagnostics.mediaEvents.length, 60);
    assert.equal(f.api.state.playbackDiagnostics.recent.length, 12);
    assert.equal(f.api.state.playbackDiagnostics.recent.at(-1).currentTime, 69);
    let exportedBlob, downloads = 0;
    f.window.URL.createObjectURL = blob => { exportedBlob = blob; return 'blob:test'; };
    f.window.URL.revokeObjectURL = () => {};
    f.window.HTMLAnchorElement.prototype.click = () => { downloads++; };
    const button = f.window.document.getElementById('wb-export-diagnostics');
    actions.length = 0;
    const paused = f.media.paused;
    button.click();
    await waitFor(() => !button.disabled);
    assert.equal(downloads, 1);
    assert.equal(exportedBlob.type, 'application/json');
    assert.equal(actions.filter(action => action === 'export-diagnostics').length, 1);
    assert.deepEqual(actions.filter(action => !['get', 'export-diagnostics'].includes(action)), []);
    assert.equal(f.media.paused, paused);
    assert.equal(f.media.currentTime, 69);
  } finally { f.window.close(); }
});
