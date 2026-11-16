const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, mediaItem, waitFor } = require('./helpers.cjs');

const group = (title, active = true) => `<li class="el-menu-item-group ${active ? 'group-menu-active' : ''}"><div class="el-menu-item-group__title"><div class="section-area"><div class="section-content"><i class="video-icon"></i><span class="section-title">${title}</span></div><span class="section-status"><i class="unStart-icon"></i></span><div>01 分 00 秒</div></div></div><ul></ul></li>`;

for (const layout of ['old', 'group']) {
  test(`${layout}: selected resource is the scanned leaf; identity survives redraw`, () => {
    const f = fixture([layout === 'old' ? mediaItem('资源甲') : group('资源甲')]);
    try {
      if (layout === 'old') f.api.getMenuItems()[0].classList.add('is-active');
      const item = f.api.getMenuItems()[0];
      assert.equal(f.api.getSelectedResource().item, item);
      assert.equal(f.api.isSelectedResource(item), true);
      const holder = item.closest('li.el-menu-item-group') || item;
      holder.replaceWith(holder.cloneNode(true));
      assert.equal(f.api.isSelectedResource(item), false);
      assert.equal(f.api.getSelectedResource().item, f.api.getMenuItems()[0]);
    } finally { f.dom.window.close(); }
  });
}

test('hidden duplicate directory does not produce ambiguity', () => {
  const f = fixture([group('目标')]);
  try {
    const root = f.window.document.querySelector('.sub-menu-area');
    const duplicate = root.cloneNode(true);
    duplicate.style.display = 'none';
    root.before(duplicate);
    root.getClientRects = () => [{ width: 1, height: 1 }];
    assert.equal(f.api.getSelectedResource().item, root.querySelector('.section-content'));
  } finally { f.dom.window.close(); }
});

test('two active leaves are ambiguous; parent chapter state is not a resource', () => {
  const f = fixture([group('甲资源'), group('乙资源')]);
  try {
    assert.equal(f.api.getSelectedResource().reason, 'ambiguous');
    assert.equal(f.api.getSelectedResource().item, null);
    f.window.document.querySelectorAll('.group-menu-active').forEach(e => e.classList.remove('group-menu-active'));
    f.window.document.querySelector('.el-sub-menu').classList.add('is-active');
    assert.equal(f.api.getSelectedResource().item, null);
  } finally { f.dom.window.close(); }
});

test('a group with multiple resource leaves cannot stand for one selected resource', () => {
  const f = fixture([group('甲资源')]);
  try {
    const row = f.window.document.querySelector('.section-content');
    row.after(row.cloneNode(true));
    assert.equal(f.api.getSelectedResource().item, null);
  } finally { f.dom.window.close(); }
});

test('same titles in different chapters retain separate resource identity', () => {
  const f = fixture([group('同名视频')]);
  try {
    const chapter = f.window.document.querySelector('.el-sub-menu');
    const second = chapter.cloneNode(true);
    second.querySelector('.el-sub-menu__title').textContent = '第二章';
    chapter.after(second);
    chapter.querySelector('.group-menu-active').classList.remove('group-menu-active');
    const rows = f.api.getMenuItems();
    assert.equal(rows.length, 2);
    assert.notEqual(f.api.getItemKey(rows[0]), f.api.getItemKey(rows[1]));
    assert.equal(f.api.getSelectedResource().item, rows[1]);
    assert.equal(f.api.isSelectedResource(rows[0]), false);
  } finally { f.dom.window.close(); }
});

test('player progress belongs only to selected resource; snapshot does not recurse', () => {
  const f = fixture([group('当前视频'), group('其他视频', false)]);
  try {
    f.window.document.querySelector('.video-js').insertAdjacentHTML('beforeend', '<div class="progress-text">已观看 85%</div>');
    f.window.document.querySelector('.progress-text').getClientRects = () => [{ width: 1, height: 1 }];
    const rows = f.api.getMenuItems();
    assert.equal(f.api.parseProgressText(rows[0]), 0.85);
    assert.equal(f.api.parseProgressText(rows[1]), null);
    assert.ok(f.api.getDirectorySnapshot().items.length >= 2);
  } finally { f.dom.window.close(); }
});

for (const kind of ['video', 'audio']) {
  test(`new group layout: ${kind} starts via existing button and pause cancels`, async () => {
    const f = fixture([group('测试媒体').replace('video-icon', `${kind}-icon`)]);
    if (kind === 'audio') {
      const audio = f.window.document.createElement('audio');
      for (const name of ['readyState', 'duration', 'currentTime', 'paused', 'ended', 'currentSrc']) {
        Object.defineProperty(audio, name, Object.getOwnPropertyDescriptor(f.media, name));
      }
      audio.pause = f.media.pause;
      audio.play = f.media.play;
      f.media.replaceWith(audio);
      f.media = audio;
    }
    let task;
    try {
      const item = f.api.getMenuItems()[0];
      f.api.state.running = true;
      f.api.CFG.mediaLoadTimeout = 300;
      task = f.api.playItemToEnd(item, 0, f.api.currentCourseKey());
      task.catch(() => {});
      await waitFor(() => !f.media.paused && f.api.state.processedItems.get(f.api.getItemKey(item))?.playbackAttempt?.after);
      f.advanceNaturally(1);
      f.media.dispatchEvent(new f.window.Event('timeupdate'));
      await f.api.stop(false);
      await assert.rejects(task, /./);
      assert.equal(f.media.paused, true);
      assert.equal(f.api.state.processedItems.get(f.api.getItemKey(item))?.confirmed, false);
    } finally { f.dom.window.close(); }
  });
}

function loadingFixture({ attached = true, ready = 0, active = true } = {}) {
  let site;
  const f = fixture([group('加载测试', active)], {
    beforeContent({ window, media }) {
      const el = window.document.createElement('video');
      let level = ready, paused = true, source = 'https://media.example.test/old', time = 0, clicks = 0;
      Object.defineProperties(el, {
        readyState: { get: () => level }, duration: { get: () => level ? 60 : NaN },
        currentTime: { get: () => time }, currentSrc: { get: () => source },
        paused: { get: () => paused }, ended: { get: () => false }
      });
      el.pause = () => { paused = true; window.document.querySelector('.video-js').classList.add('vjs-paused'); };
      const player = media.parentElement;
      media.remove();
      if (attached) player.append(el);
      window.document.querySelector('.vjs-big-play-button').addEventListener('click', () => {
        clicks++;
        if (level >= 2) paused = false;
      });
      window.document.querySelector('.section-content').addEventListener('click', () => {
        window.document.querySelector('.el-menu-item-group').classList.add('group-menu-active');
      });
      site = {
        el, attach: () => player.append(el), clicks: () => clicks,
        ready: value => { level = value; },
        source: () => { source = 'https://media.example.test/new'; el.dispatchEvent(new window.Event('loadedmetadata')); },
        advance: () => { time += 1; el.dispatchEvent(new window.Event('timeupdate')); },
        startWhenBuffered: () => { level = 4; paused = false; el.dispatchEvent(new window.Event('playing')); }
      };
    }
  });
  f.api.state.running = true;
  Object.assign(f.api.CFG, { mediaLoadTimeout: 1500, gatewayPauseGrace: 1500 });
  return { ...f, site };
}

for (const scenario of ['late-node', 'late-metadata', 'same-node-source', 'late-buffer']) {
  test(`new layout ${scenario}: wait without premature success, then use existing playback path`, async () => {
    const f = loadingFixture({ attached: scenario !== 'late-node', ready: scenario === 'late-buffer' ? 1 : 0,
      active: scenario !== 'same-node-source' });
    let task;
    try {
      const item = f.api.getMenuItems()[0];
      task = f.api.playItemToEnd(item, 0, f.api.currentCourseKey());
      task.catch(() => {});
      if (scenario === 'late-buffer') {
        await waitFor(() => f.site.clicks() === 1);
        assert.equal(f.site.el.paused, true);
        assert.notEqual(f.api.state.processedItems.get(f.api.getItemKey(item))?.confirmed, true);
        f.site.startWhenBuffered();
      } else {
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(f.site.clicks(), 0);
        if (scenario === 'late-node') f.site.attach();
        f.site.ready(4);
        if (scenario === 'same-node-source') f.site.source();
      }
      await waitFor(() => !f.site.el.paused && f.api.state.processedItems.get(f.api.getItemKey(item))?.playbackAttempt?.after);
      f.site.advance();
      assert.equal(f.site.clicks(), 1);
      await f.api.stop(false);
      await assert.rejects(task);
      assert.equal(f.site.el.paused, true);
    } finally { f.dom.window.close(); }
  });
}

test('unrecognized selection timeout reports identity evidence rather than blaming network', async () => {
  const f = fixture([group('未识别视频', false)]);
  try {
    f.api.state.running = true;
    const item = f.api.getMenuItems()[0];
    await assert.rejects(f.api.playItemToEnd(item, 0, f.api.currentCourseKey()), error => {
      assert.match(error.message, /选中资源/);
      assert.equal(error.kind, 'loading');
      assert.equal(error.evidence.reason, 'selection-missing');
      assert.equal(error.evidence.media.readyState, 4);
      assert.equal(error.evidence.expectedResourceKey, f.api.getItemKey(item));
      return true;
    });
    assert.equal(f.media.paused, true);
    assert.ok(f.api.state.playbackDiagnostics.recent.some(e => e.section === 'readiness'));
  } finally { f.dom.window.close(); }
});
