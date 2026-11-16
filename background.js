/* Only coordinates extension tasks and tabs. It never calls learning APIs.
 * Updated 2026-10-13: confirmed full reset and fresh homepage collection. */
(() => {
  'use strict';
  if (!globalThis.XinweiRoutes) importScripts('route-utils.js');
  if (!globalThis.XinweiDiagnosticArchive) importScripts('diagnostic-archive.js');
  const diagnosticArchive = globalThis.XinweiDiagnosticArchive;
  const routeParser = globalThis.XinweiRoutes;
  const CHANNEL = 'xinwei-job';
  const KEY = 'xinwei-job-v3';
  const OBS_KEY = 'xinwei-media-observation-v1';
  const OUTER_WATCH_KEY = 'xinwei-outer-watch-v1';
  const DIAGNOSTICS_KEY = 'xinwei-diagnostics-v1';
  const POWER_KEY = 'wb-keep-awake';
  let powerEnabled;
  let powerRequested = null;
  let powerError = '';
  const powerStatus = () => ({ enabled: powerEnabled === true, requested: powerRequested === true, error: powerError });
  async function syncPower(job) {
    try {
      if (powerEnabled === undefined) powerEnabled = (await chrome.storage.local.get(POWER_KEY))[POWER_KEY] === true;
      const wanted = powerEnabled && Boolean(job?.running || job?.outer?.state === 'active') &&
        !['paused', 'manual', 'interrupted', 'resetting', 'idle', 'finished'].includes(job?.phase) && !pendingStop(job);
      if (wanted === powerRequested || wanted && powerError) return;
      if (wanted) {
        if (!chrome.power?.requestKeepAwake) throw new Error('浏览器不支持防休眠，请检查扩展权限');
        await chrome.power.requestKeepAwake('system');
      } else await chrome.power?.releaseKeepAwake?.();
      powerRequested = wanted;
      powerError = '';
    } catch (error) {
      await releasePower();
      powerError = String(error.message || '防休眠请求失败').slice(0, 160);
    }
  }
  async function releasePower() {
    try { await chrome.power?.releaseKeepAwake?.(); } catch { /* Best effort on storage/API failure. */ }
    powerRequested = false;
  }
  const HOME = 'https://www.beeline-ai.com/myBank/courseResearch';
  const AGENT = 'https://www.beeline-ai.com/stu/agent';
  const isNetworkErrorPage = url => /^chrome-error:\/\//i.test(String(url || ''));
  const NETWORK_RETRY_ALARM = 'xinwei-network-retry';
  const NETWORK_RETRY_TIMEOUT = 60000;
  let queue = Promise.resolve();
  let emergencyJob = null;
  let lastKnownJob = null;
  let cancellationFence = null;
  let pendingCancellations = [];
  let diagnosticSavedAt = 0, diagnosticRunId = '', diagnosticSampleAt = 0;
  let diagnosticStorageWarning = '';
  const resetEpoch = job => Number.isSafeInteger(job?.resetEpoch) && job.resetEpoch >= 0 ? job.resetEpoch : 0;

  const serial = task => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };
  const copy = value => JSON.parse(JSON.stringify(value));
  // Flat, bounded evidence only. It never supplies task/resume authority.
  function diagnosticEvidence(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    try {
      const result = {};
      for (const key of ['action', 'rule', 'expectedCourseKey', 'actualCourseKey', 'actualSource', 'actualRoute', 'kind', 'response', 'preview']) {
        if (!Object.hasOwn(raw, key)) continue;
        if (raw[key] == null) { result[key] = null; continue; }
        if (typeof raw[key] !== 'string') { result.incomplete = true; continue; }
        const text = redactDiagnostic(raw[key]).replace(/\bhttps?:\/\/\S+/gi, '[url omitted]');
        result[key] = text.slice(0, 240);
        if (text.length > 240) result.incomplete = true;
      }
      for (const key of ['count', 'videoCount', 'documentCount', 'unknownDocumentCount', 'pendingMediaCount', 'pendingDocumentCount',
        'platformConfirmedCount', 'platformPendingCount', 'referenceDocumentCount', 'otherCount',
        'expectedTotal', 'reportedTotal', 'reportedRemaining',
        'durationMs', 'targetPercent', 'currentTime', 'duration', 'attempts', 'from', 'to', 'elapsedMs']) {
        if (!Object.hasOwn(raw, key)) continue;
        if (Number.isFinite(raw[key])) result[key] = raw[key];
        else result.incomplete = true;
      }
      if (raw.incomplete === true) result.incomplete = true;
      return result;
    } catch { return { incomplete: true }; }
  }
  function courseIdentityError(msg, candidate, observed, source) {
    const error = new Error('课程身份已改变');
    // Keep the original failure even if optional evidence cannot be collected.
    try {
      const actual = courseKey(observed);
      error.details = diagnosticEvidence({ action: msg.action, rule: 'course-identity-match',
        expectedCourseKey: candidate.courseKey || null, actualCourseKey: actual || null,
        actualSource: source, actualRoute: route(observed),
        incomplete: !candidate.courseKey || !actual });
    } catch { error.details = { incomplete: true }; }
    return error;
  }
  const addLog = (job, text, type = 'info', metadata = {}) => {
    if (metadata.id && job.logs?.some(entry => entry.id === String(metadata.id).slice(0, 180))) return false;
    const time = Number.isFinite(metadata.time) ? metadata.time : Date.now();
    const sequence = (Number.isSafeInteger(job.logSequence) ? job.logSequence : 0) + 1;
    job.logSequence = sequence;
    const id = typeof metadata.id === 'string' && metadata.id
      ? metadata.id : `background:${time}:${sequence}`;
    const candidate = job.candidates?.[job.targetIndex];
    job.logs = [...(job.logs || []), {
      time, text: String(text).slice(0, 400),
      type, id: String(id).slice(0, 180), schemaVersion: 1, sequence,
      runId: job.runId, generation: job.generation, resetEpoch: resetEpoch(job),
      ...(job.outer ? { roundId: job.outer.id, attempt: job.outer.entries[job.outer.cursor]?.reentries ?? 0 } : {}),
      phase: job.phase, courseKey: candidate?.courseKey || '',
      resourceKey: String(metadata.resourceKey ?? candidate?.currentResource?.key ?? '').slice(0, 1000),
      source: metadata.source === 'content' ? 'content' : 'background',
      eventCode: String(metadata.eventCode || 'message').slice(0, 60),
      ...(metadata.evidence ? { evidence: diagnosticEvidence(metadata.evidence) } : {})
    }].slice(-300);
    return true;
  };
  function redactDiagnostic(value) {
    return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string'
      ? item.replace(/([?&](?:access_token|token|authorization|password|secret|sessionid)=)[^&#\s]*/gi, '$1[redacted]')
        .replace(/\bBearer\s+[\w.+/=-]+/gi, 'Bearer [redacted]')
      : item));
  }
  function diagnosticScanDraft(snapshot) {
    const items = snapshot.items || [];
    const documents = items.filter(item => item.mediaType === 'document');
    return {
      courseKey: String(snapshot.courseKey || '').slice(0, 1000),
      itemCount: items.length, taskCount: items.filter(isCourseTaskItem).length,
      mediaCount: items.filter(item => ['video', 'audio', 'media'].includes(item.mediaType)).length,
      documentCount: documents.length,
      requiredDocumentCount: documents.filter(item => item.taskItem === true).length,
      unknownDocumentCount: documents.filter(item => item.taskItem == null).length,
      referenceDocumentCount: documents.filter(item => item.taskItem === false).length,
      otherCount: items.filter(item => item.mediaType === 'other').length,
      truncated: items.length > 300,
      items: items.slice(0, 300).map(item => ({
        key: String(item.key).slice(0, 1000), title: String(item.title).slice(0, 160),
        mediaType: item.mediaType, durationSeconds: item.durationSeconds,
        ...(item.mediaType === 'document' ? {
          taskItem: item.taskItem ?? null, observedCompleted: item.observedCompleted ?? null,
          documentReason: String(item.documentReason || 'legacy-unknown').slice(0, 60)
        } : {})
      }))
    };
  }
  function diagnosticReport(job) {
    const candidate = job?.candidates?.[job.targetIndex];
    return redactDiagnostic({
      schemaVersion: 1, capturedAt: Date.now(),
      extensionVersion: chrome.runtime.getManifest?.().version || '1.0.0',
      runId: String(job?.runId || '').slice(0, 120), generation: job?.generation ?? null, resetEpoch: resetEpoch(job),
      phase: String(job?.phase || 'idle').slice(0, 60), running: Boolean(job?.running), reason: String(job?.reason || '').slice(0, 400),
      courseKey: String(candidate?.courseKey || '').slice(0, 1000), courseTitle: String(candidate?.title || '').slice(0, 160),
      resourceKey: String(candidate?.currentResource?.key || '').slice(0, 1000),
      records: Object.fromEntries(Object.entries(candidate?.records || {}).slice(-300).map(([key, record]) =>
        [key, Object.fromEntries(['title', 'visited', 'started', 'ended', 'targetReached', 'confirmed',
          'effectiveTarget', 'error', 'recoveryAttempts', 'finalAttempts', 'documentAccess'].filter(field =>
          record[field] !== undefined).map(field => [field, field === 'documentAccess' ? {
            attemptId: String(record.documentAccess?.attemptId || '').slice(0, 120),
            generation: Number.isSafeInteger(record.documentAccess?.generation) ? record.documentAccess.generation : null,
            response: ['selected', 'unconfirmed'].includes(record.documentAccess?.response) ? record.documentAccess.response : null,
            preview: ['failed', 'unknown'].includes(record.documentAccess?.preview) ? record.documentAccess.preview : null
          } : ['title', 'error'].includes(field) ? String(record[field]).slice(0, field === 'title' ? 160 : 400) : record[field]]))])),
      documents: (candidate?.directory?.items || []).filter(item => item.mediaType === 'document').slice(-300)
        .map(item => ({ key: item.key, taskItem: item.taskItem ?? null,
          observedCompleted: item.observedCompleted ?? null, documentReason: item.documentReason || 'legacy-unknown' })),
      ...(candidate?.scanDraft ? { scanDraft: diagnosticScanDraft(candidate.scanDraft) } : {}),
      logs: (job?.logs || []).slice(-300).map(entry => ({ ...entry, text: String(entry.text).slice(0, 400) })),
      incident: job?.diagnostic || null,
      limits: { logs: 300, records: 300, retainedRuns: 1, scanDraftItems: 300 }
    });
  }
  async function saveDiagnostics(job, force = false) {
    const clear = ['idle', 'resetting'].includes(job.phase);
    if (!clear && !force && diagnosticRunId === job.runId &&
      diagnosticSampleAt === (job.diagnostic?.time || 0) && Date.now() - diagnosticSavedAt < 10000) return;
    try {
      // Serialized with the checkpoint queue; history is never broadcast with job.
      const prior = clear ? null : (await chrome.storage.local.get(DIAGNOSTICS_KEY))[DIAGNOSTICS_KEY];
      const report = clear ? null : diagnosticArchive.merge(prior, diagnosticReport(job), job.outer ? redactDiagnostic(job.outer) : undefined);
      await chrome.storage.local.set({ [DIAGNOSTICS_KEY]: report });
      diagnosticSavedAt = Date.now();
      diagnosticRunId = job.runId;
      diagnosticSampleAt = job.diagnostic?.time || 0;
      diagnosticStorageWarning = '';
    } catch {
      const warning = '诊断快照暂未保存；可导出当前会话记录，重启后可能缺少最近日志。';
      if (diagnosticStorageWarning !== warning) console.warn(warning);
      diagnosticStorageWarning = warning;
    }
  }
  function captureDiagnostic(job, msg, tabId) {
    if (!msg.diagnostic || job?.ownerTabId !== tabId || job.ownerInstance !== msg.instanceId ||
      job.runId !== msg.runId || job.generation !== msg.generation) return;
    try {
      const raw = msg.diagnostic;
      const snapshot = Object.fromEntries(['time', 'route', 'selectedResourceKey', 'localRunning',
        'media', 'error', 'entry', 'handshake', 'recent'].filter(key => raw[key] !== undefined)
        .map(key => [key, raw[key]]));
      if (snapshot.error?.details) snapshot.error = {
        ...snapshot.error, details: diagnosticEvidence(snapshot.error.details)
      };
      const encoded = JSON.stringify(snapshot);
      if (diagnosticArchive.bytes(snapshot) <= 20000) job.diagnostic = redactDiagnostic({ ...JSON.parse(encoded), eventCode: msg.action,
        ...(job.outer ? { outerRoundId: job.outer.id, outerAttempt: job.outer.entries[job.outer.cursor]?.reentries ?? 0 } : {}) });
    } catch { /* Optional evidence must never reject a business command. */ }
  }
  function clearNetworkRetryAlarm() {
    try { chrome.alarms?.clear?.(NETWORK_RETRY_ALARM)?.catch?.(() => {}); } catch {}
  }
  function scheduleNetworkRetryAlarm(deadline) {
    try {
      chrome.alarms?.create?.(NETWORK_RETRY_ALARM, {
        when: Math.max(Number(deadline) || 0, Date.now() + NETWORK_RETRY_TIMEOUT)
      });
    } catch {}
  }
  const taskTabIds = job => [job.homeTabId, job.workerTabId, job.returningTabId].filter(Number.isInteger);
  const INSPECTION_OPEN_RETRY_LIMIT = 2;
  const INSPECTION_OPEN_RETRY_DELAY = 30000;
  const INSPECTION_PENDING_TAB_WAIT_LIMIT = 2;
  async function prepareInspectionOpen(job) {
    const openingTab = await chrome.tabs.get(job.homeTabId);
    const existing = await chrome.tabs.query({ windowId: openingTab.windowId });
    if (!canOperate(job)) throw new Error('TASK_CANCELLED');
    job.openWindowId = openingTab.windowId;
    job.openExistingTabIds = existing.map(tab => tab.id);
    job.ignoredOpenTabIds = [];
    job.openIssuedAt = Date.now();
  }

  async function findUnclaimedInspectionTabs(job) {
    if (!Array.isArray(job.openExistingTabIds)) return;
    const candidate = job.candidates[job.targetIndex];
    const tabs = await chrome.tabs.query({ windowId: job.openWindowId });
    if (!canOperate(job)) return;
    for (const tab of tabs) {
      const url = tab.pendingUrl || tab.url || '';
      if (job.openExistingTabIds.includes(tab.id) || job.ignoredOpenTabIds?.includes(tab.id) ||
          !['learn', 'learn-unsupported'].includes(route({ url })) ||
          (candidate.courseKey && courseKey({ url }) !== candidate.courseKey)) continue;
      job.pendingOpenTabIds = [...new Set([...(job.pendingOpenTabIds || []), tab.id])];
    }
  }
  const isStartCancellation = (job, msg, tabId) => msg.action === 'pause' &&
    !isRetiredInstance(job, tabId, msg.instanceId) &&
    job.startRequest?.tabId === tabId && job.startRequest.instanceId === msg.instanceId &&
    job.startRequest.runId === (msg.runId || null) &&
    job.startRequest.generation === (msg.generation ?? null) && resetEpoch(job) === resetEpoch(msg);
  const pendingStop = job => pendingCancellations.find(({ msg, tabId, pageBlocked }) =>
    pageBlocked ? (job.ownerTabId === tabId && resetEpoch(msg) === resetEpoch(job) &&
      (!msg.runId || msg.runId === job.runId) && !isRetiredInstance(job, tabId, msg.instanceId)) :
    (msg.action === 'reset' && msg.resetEpoch === resetEpoch(job)) ||
    isStartCancellation(job, msg, tabId) ||
    (taskTabIds(job).includes(tabId) && msg.runId === job.runId &&
      (msg.action === 'pause' || msg.generation === job.generation)));
  const canOperate = job => {
    const supportedWorkflow = job?.workflow === 'manual' ||
      (job?.workflow !== 'auto' && job?.scope === 'single');
    if (!supportedWorkflow || !job?.running || (cancellationFence?.runId === job.runId &&
      cancellationFence.generation === job.generation)) return false;
    return !pendingStop(job);
  };
  const uniqueTexts = values => [...new Set(values.filter(value => typeof value === 'string' && value))];
  const isCourseTaskItem = item => ['video', 'audio', 'media'].includes(item?.mediaType) ||
    (item?.mediaType === 'document' && item.taskItem !== false);
  const documentReasons = ['resource-unavailable', 'marker-conflict', 'status-loading',
    'marker-unrecognized', 'directory-not-ready', 'complete-marker', 'pending-marker', 'no-task-marker'];
  const taskConfirmed = (item, record) => item.mediaType === 'document'
    ? item.taskItem === true && (!item.documentReason || item.observedCompleted === true) && record?.confirmed === true
    : record?.confirmed === true;
  const outstandingRecords = (candidate, singlePass = false) => Object.values(candidate.records || {}).filter(record =>
    singlePass ? record.confirmed !== true && Boolean(record.started || record.attempted ||
      record.targetReached || record.deferred || record.ended || record.error || record.progressGap) :
      ((record.started || record.attempted) && !record.ended) ||
      (record.ended && !record.confirmed) || (record.error && !record.ended) || record.progressGap);
  const validTargetPercent = value => Number.isInteger(value) && value >= 80 && value <= 100;
  const isRetiredInstance = (job, tabId, instanceId) => (job.retiredInstances || []).some(entry =>
    entry.tabId === tabId && entry.instanceId === instanceId);

  function retireInstance(job, tabId, instanceId) {
    if (!Number.isInteger(tabId) || typeof instanceId !== 'string' || !instanceId ||
      isRetiredInstance(job, tabId, instanceId)) return;
    job.retiredInstances = [...(job.retiredInstances || []), { tabId, instanceId }];
  }

  function bindHomeInstance(job, instanceId) {
    if (instanceId && job.homeInstance && job.homeInstance !== instanceId) {
      retireInstance(job, job.homeTabId, job.homeInstance);
    }
    job.homeInstance = instanceId;
  }

  function bindOwnerInstance(job, tabId, instanceId) {
    if (instanceId) {
      if (job.ownerTabId === tabId && job.ownerInstance && job.ownerInstance !== instanceId) {
        retireInstance(job, tabId, job.ownerInstance);
      }
      if (job.ownerHandoff?.tabId === tabId && job.ownerHandoff.instanceId !== instanceId) {
        retireInstance(job, tabId, job.ownerHandoff.instanceId);
      }
      delete job.ownerHandoff;
    } else if (job.ownerTabId === tabId && job.ownerInstance) {
      // Retire the departing document only when its replacement has actually arrived.
      // Before navigation, the existing page must still be able to pause and continue.
      job.ownerHandoff = { tabId, instanceId: job.ownerInstance };
    } else if (job.ownerTabId !== tabId) delete job.ownerHandoff;
    job.ownerTabId = tabId;
    job.ownerInstance = instanceId;
  }

  function validateDirectorySnapshot(raw, key) {
    if (!raw || raw.version !== 1 || !Array.isArray(raw.items) ||
      (raw.courseKey != null && raw.courseKey !== key) ||
      (raw.signature != null && typeof raw.signature !== 'string')) {
      throw new Error('课程目录检查点无法确认');
    }
    const keys = new Set();
    const items = raw.items.map(item => {
      if (!item || typeof item.key !== 'string' || !item.key.trim() ||
        typeof item.title !== 'string' || !item.title.trim() ||
        !['video', 'audio', 'media', 'document', 'other'].includes(item.mediaType) ||
        (item.taskItem != null && typeof item.taskItem !== 'boolean') ||
        (item.documentReason != null && (!documentReasons.includes(item.documentReason) ||
          item.mediaType !== 'document')) ||
        !(item.durationSeconds === null ||
          (typeof item.durationSeconds === 'number' && Number.isFinite(item.durationSeconds) &&
            item.durationSeconds >= 0)) || keys.has(item.key)) {
        throw new Error('课程目录条目无法确认');
      }
      if (item.mediaType === 'document' && item.documentReason) {
        const expectedTask = item.documentReason === 'no-task-marker' ? false :
          ['complete-marker', 'pending-marker'].includes(item.documentReason) ? true : null;
        const expectedComplete = expectedTask == null ? null : item.documentReason === 'complete-marker';
        if (item.taskItem !== expectedTask || item.observedCompleted !== expectedComplete) {
          throw new Error('文档观察字段不一致');
        }
      }
      keys.add(item.key);
      return { key: item.key, title: item.title, mediaType: item.mediaType,
        durationSeconds: item.durationSeconds,
        ...(item.mediaType === 'document' ? {
          taskItem: typeof item.taskItem === 'boolean' ? item.taskItem : null,
          ...(item.documentReason ? { documentReason: item.documentReason, observedCompleted:
            typeof item.observedCompleted === 'boolean' ? item.observedCompleted : null } : {})
        } : {}),
        ...(typeof item.chapterTitle === 'string' ? { chapterTitle: item.chapterTitle.slice(0, 160) } : {}),
        ...(typeof item.observedCompleted === 'boolean' ? { observedCompleted: item.observedCompleted } : {}) };
    });
    const snapshot = { version: 1, courseKey: key, items };
    if (raw.signature != null) snapshot.signature = raw.signature;
    return snapshot;
  }

  async function takeOverRefreshedOwner(job, msg, sender) {
    const previousGeneration = job.generation;
    if (!canOperate(job)) return job;
    // User refreshes require explicit Continue; the executor's own bounded
    // verification reload is the only continuation authorized in advance.
    const expected = job.expectedRefresh;
    const authorizedRefresh = expected && expected.tabId === sender.tab.id &&
      expected.courseKey === courseKey(sender) && expected.generation === job.generation &&
      expected.expiresAt >= Date.now();
    if (job.workflow === 'manual' && !authorizedRefresh) {
      bindOwnerInstance(job, sender.tab.id, msg.instanceId);
      if (route(sender) === 'home') bindHomeInstance(job, msg.instanceId);
      return save(pause(job, '页面已刷新，记录已保留；请点击继续或重新扫描本课。'));
    }
    delete job.expectedRefresh;
    bindOwnerInstance(job, sender.tab.id, msg.instanceId);
    if (['agent', 'home'].includes(route(sender))) bindHomeInstance(job, msg.instanceId);
    job.generation += 1;
    addLog(job, '页面刷新后已接回原任务；保留课程统计和断点，正在核对当前页面');
    return saveOwnerHandoff(job, previousGeneration);
  }

  async function saveOwnerHandoff(job, previousGeneration) {
    await save(job);
    // A cancellation can arrive while this new generation is being saved/broadcast.
    // Check both generations so an already requested pause cannot be skipped by takeover.
    if (!canOperate(job) || !canOperate({ ...job, generation: previousGeneration })) {
      const cancellation = pendingStop(job) || pendingStop({ ...job, generation: previousGeneration });
      return save(pauseForCancellation(job, cancellation));
    }
    return job;
  }

  function retryRecords(records) {
    return Object.fromEntries(Object.entries(records || {}).map(([key, record]) => {
      const next = copy(record);
      if (!next.ended) {
        // Older versions saved failed attempts without a started/attempted marker.
        if (next.error) next.attempted = true;
        delete next.error;
      }
      return [key, next];
    }));
  }

  function recoveryRecords(job) {
    const result = copy(job?.recoveryRecords || {});
    for (const candidate of job?.candidates || []) {
      if (!candidate.courseKey) continue;
      const records = Object.fromEntries(Object.entries(candidate.records || {}).filter(([, record]) =>
        ((record.started || record.attempted) && !record.ended) ||
        (record.ended && !record.confirmed) || (record.error && !record.ended)));
      if (Object.keys(records).length) result[candidate.courseKey] = records;
      else delete result[candidate.courseKey];
    }
    return result;
  }

  function resetAttempt(candidate) {
    candidate.records = retryRecords(candidate.records);
    candidate.failures = [];
    candidate.unconfirmed = [];
    candidate.unfinished = [];
  }

  const recoveryRound = candidate => Number.isSafeInteger(candidate.retryRounds) && candidate.retryRounds >= 0
    ? candidate.retryRounds : 0;
  const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;

  function recordRecovery(candidate, previous, incoming) {
    const round = recoveryRound(candidate);
    const saved = previous?.round === round ? previous : {};
    const proposed = incoming && typeof incoming === 'object' && !Array.isArray(incoming) &&
      (incoming.round == null || incoming.round === round) ? incoming : {};
    return {
      ...saved, ...proposed,
      attempts: Math.max(nonnegativeInteger(saved.attempts) ? saved.attempts : 0,
        nonnegativeInteger(proposed.attempts) ? proposed.attempts : 0),
      // Only reload-course spends this budget. A stale content record cannot
      // reset it, and a content-provided round cannot create a fresh budget.
      reloads: nonnegativeInteger(saved.reloads) ? saved.reloads : 0,
      // Only the background's actual reload result may set this marker.
      // It survives stale content records, but a new retry round clears it.
      reloadFailed: saved.reloadFailed === true,
      nextRetryAt: Number.isFinite(proposed.nextRetryAt) && proposed.nextRetryAt >= 0
        ? proposed.nextRetryAt : Number.isFinite(saved.nextRetryAt) ? saved.nextRetryAt : 0,
      lastReason: String(proposed.lastReason ?? saved.lastReason ?? '').slice(0, 400),
      round
    };
  }

  function prepareRetry(candidate) {
    resetAttempt(candidate);
    for (const record of Object.values(candidate.records || {})) {
      if (!record.ended) record.recovery = recordRecovery(candidate, null, null);
    }
    candidate.status = 'inspected';
    delete candidate.retryAt;
  }

  function scheduleCourseRetry(candidate) {
    candidate.status = 'retry';
    candidate.retryRounds = recoveryRound(candidate) + 1;
    candidate.retryAt = Date.now() + Math.min(300000, 30000 * 2 ** Math.min(candidate.retryRounds - 1, 4));
  }

  function preserveStopGap(job, msg, tabId) {
    const evidence = msg.gapEvidence;
    const candidate = job.candidates?.[job.targetIndex];
    const resource = candidate?.currentResource;
    if (!evidence || !candidate || !resource || job.runId !== msg.runId ||
      resetEpoch(job) !== resetEpoch(msg) || tabId !== job.ownerTabId ||
      msg.instanceId !== job.ownerInstance || evidence.key !== resource.key ||
      (evidence.courseKey != null && evidence.courseKey !== candidate.courseKey) ||
      (evidence.round != null && evidence.round !== recoveryRound(candidate)) ||
      !Number.isFinite(evidence.from) || !Number.isFinite(evidence.to) ||
      evidence.from < 0 || evidence.to <= evidence.from) return;
    const record = candidate.records?.[resource.key];
    if (!record) return;
    const prior = record.progressGap;
    record.progressGap = {
      from: Number.isFinite(prior?.from) ? Math.min(prior.from, evidence.from) : evidence.from,
      to: Number.isFinite(prior?.to) ? Math.max(prior.to, evidence.to) : evidence.to
    };
    // Stopping may conservatively add an unwatched range; it never supplies
    // playback authority or a successful completion assertion.
    record.ended = false;
  }

  function pauseForCancellation(job, cancellation) {
    if (cancellation) preserveStopGap(job, cancellation.msg, cancellation.tabId);
    return pause(job, cancellation?.msg.action === 'reset' ? '正在重置插件'
      : cancellation?.msg.reason || '', cancellation?.msg.action === 'manual');
  }

  function fenceCancellation(msg, sender) {
    if (!isSite(sender)) return null;
    const blocked = pageBlockingReason(msg);
    if (blocked) {
      // A freshly reported verification/login prompt must cancel an already
      // persisted navigation before its queued message handler gets a turn.
      const pending = { pageBlocked: true, tabId: sender.tab.id,
        msg: { action: 'manual', runId: msg.runId, generation: msg.generation,
          instanceId: msg.instanceId, resetEpoch: resetEpoch(msg), reason: blocked } };
      pendingCancellations.push(pending);
      return pending;
    }
    if (!['pause', 'manual', 'reset'].includes(msg.action)) return null;
    if (msg.action === 'reset') {
      const pending = { msg: { action: 'reset', resetEpoch: resetEpoch(msg) }, tabId: sender.tab.id };
      pendingCancellations.push(pending);
      if (lastKnownJob && resetEpoch(lastKnownJob) === resetEpoch(msg)) {
        cancellationFence = { runId: lastKnownJob.runId, generation: lastKnownJob.generation };
      }
      return pending;
    }
    // A newly restarted service worker may still be reading its first checkpoint.
    // Validate such messages against the loaded job before allowing browser actions.
    const pending = msg.runId || msg.action === 'pause' ? {
      msg: { action: msg.action, runId: msg.runId, generation: msg.generation,
        instanceId: msg.instanceId, resetEpoch: resetEpoch(msg),
        reason: String(msg.reason || ''), gapEvidence: msg.gapEvidence }, tabId: sender.tab.id
    } : null;
    if (pending) pendingCancellations.push(pending);
    const job = lastKnownJob;
    if (!job?.running ||
      resetEpoch(job) !== resetEpoch(msg) ||
      !taskTabIds(job).includes(sender.tab.id) ||
      (msg.runId && msg.runId !== job.runId && !isStartCancellation(job, msg, sender.tab.id)) ||
      (msg.action === 'manual' && msg.generation !== job.generation)) return pending;
    // A pause message must cancel browser actions before its serialized handler runs.
    cancellationFence = { runId: job.runId, generation: job.generation };
    return pending;
  }

  async function migrateRemovedCourseQueue(job) {
    if (!job || (job.workflow !== 'auto' &&
      (job.scope !== 'all' || job.workflow === 'manual'))) return job;
    const previousTabIds = new Set([...taskTabIds(job), job.ownerTabId].filter(Number.isInteger));
    job.resetHoldTabIds = [...new Set([...(job.resetHoldTabIds || []), ...previousTabIds])];
    clearNetworkRetryAlarm();
    job.manualSelectionMigration = {
      time: Date.now(), workflow: job.workflow || '', phase: job.phase,
      generation: job.generation, targetIndex: job.targetIndex,
      ...(job.reason ? { reason: job.reason } : {}),
      ...(job.interruption ? { interruption: copy(job.interruption) } : {})
    };
    job.running = false;
    job.workflow = 'manual';
    job.scope = 'all';
    job.singlePass = true;
    job.targetPercent = validTargetPercent(job.targetPercent) ? job.targetPercent : 100;
    job.phase = 'selection';
    job.generation = (Number.isSafeInteger(job.generation) ? job.generation : 0) + 1;
    job.operation = '';
    job.selectedIndex = null;
    job.targetIndex = null;
    job.targetPurpose = '';
    job.homeInstance = null;
    job.ownerInstance = null;
    for (const key of ['startRequest', 'resumePhase', 'ownerHandoff', 'expectedRefresh',
      'learnAfterScan', 'interruption', 'reason', 'entryClicked', 'entryAttempted',
      'entryDeadline', 'agentDeadline', 'agentDepartureUrl', 'agentDepartureInstance',
      'returningTabId', 'returnDeadline', 'returnCourseKey', 'navigationRecovery',
      'openRecovery', 'openDeadline', 'openIssuedAt', 'openWindowId', 'openExistingTabIds',
      'ignoredOpenTabIds', 'pendingOpenTabIds', 'pendingOpenTabWaits']) delete job[key];
    addLog(job, '一键全课模式已移除，旧任务已停止；已保留课程目录和学习记录，请手动选择一门课程。', 'warn');
    await save(job);
    const notified = new Set(taskTabIds(job));
    await Promise.all([...previousTabIds].filter(id => !notified.has(id)).map(id =>
      notifyTab(id, { channel: CHANNEL, job, tabId: id, power: powerStatus() })));
    return job;
  }

  async function read() {
    if (emergencyJob) return copy(emergencyJob);
    let session, saved, observation;
    try {
      [session, saved, observation] = await Promise.all([
        chrome.storage.session.get(KEY).then(value => value[KEY]),
        chrome.storage.local.get(KEY).then(value => value[KEY]),
        chrome.storage.session.get(OBS_KEY).then(value => value[OBS_KEY])
      ]);
    } catch {
      await releasePower();
      if (lastKnownJob) {
        if (['idle', 'resetting'].includes(lastKnownJob.phase)) {
          emergencyJob = { ...copy(lastKnownJob), running: false, phase: 'resetting',
            reason: '无法核对重置状态，已保持停止；请重试重置。' };
        } else {
          emergencyJob = pause(copy(lastKnownJob), '无法读取任务状态，已停止。请检查扩展后重新开始。', true);
        }
        await broadcast(emergencyJob);
      }
      const failure = new Error('无法读取任务状态，已停止。请检查扩展后重新开始。');
      failure.code = 'TASK_STORAGE_FAILURE';
      throw failure;
    }
    // A reset written to disk must beat an older live checkpoint even if
    // the session write failed before the service worker was restarted.
    const liveSession = session && resetEpoch(session) >= resetEpoch(saved);
    const job = liveSession ? session : saved;
    const firstOuterRead = !outerBootChecked;
    outerBootChecked = true;
    if (!job) return null;
    if (firstOuterRead && liveSession && job.outer?.state === 'active') {
      try { outerWatch = (await chrome.storage.session.get(OUTER_WATCH_KEY))[OUTER_WATCH_KEY] || null; }
      catch { return save(pause(job, '无法核对外围监督状态，请确认页面后继续。', true)); }
    }
    if (job.outer?.state === 'active' && !liveSession) {
      job.resumePhase = job.running ? job.phase : job.resumePhase || job.phase;
      return save(pause(job, '浏览器或扩展已重启；本轮结果和重进次数已保留，请明确继续。'));
    }
    mergeObservation(job, observation);
    if (job.workflow === 'auto' || (job.scope === 'all' && job.workflow !== 'manual')) {
      return migrateRemovedCourseQueue(job);
    }
    if (!liveSession) {
      // Disk checkpoints never authorize an automatic browser restart.
      job.running = false;
      if (!['finished', 'idle', 'resetting', 'selection'].includes(job.phase)) {
        job.phase = 'interrupted';
        job.reason = '浏览器或扩展已重启。请回到首页点击开始，重新核对课程。';
      }
    }
    lastKnownJob = copy(job);
    return job;
  }

  function mergeObservation(job, observation) {
    const candidate = job?.candidates?.[job.targetIndex];
    const resource = candidate?.currentResource;
    const sample = observation?.sample;
    if (observation?.runId !== job?.runId || observation?.courseKey !== candidate?.courseKey ||
      observation?.key !== resource?.key || observation?.routeKey !== resource?.routeKey ||
      !sample || !Number.isFinite(sample.position) || !Number.isFinite(sample.time) ||
      sample.position < 0) return;
    if (!resource.positionSample || sample.time > resource.positionSample.time) {
      resource.positionSample = copy(sample);
    }
  }

  async function notifyTab(id, message) {
    let timer;
    try {
      await Promise.race([
        chrome.tabs.sendMessage(id, message),
        new Promise(resolve => { timer = setTimeout(resolve, 2000); })
      ]);
    } catch {
      // Notifications are advisory. A discarded page must not hold every
      // subsequent command in the shared serial queue.
    } finally { clearTimeout(timer); }
  }

  async function broadcast(job) {
    const ids = new Set([...taskTabIds(job), ...(job.resetHoldTabIds || [])]);
    await Promise.all([...ids].map(id =>
      notifyTab(id, { channel: CHANNEL, job, tabId: id, power: powerStatus() })));
  }

  async function save(job) {
    outerTrack(job);
    job.revision = (job.revision || 0) + 1;
    job.updatedAt = Date.now();
    try {
      const checkpoint = copy(job);
      checkpoint.running = false;
      if (['idle', 'resetting'].includes(job.phase)) {
        const writes = await Promise.allSettled([
          chrome.storage.local.set({ [KEY]: checkpoint, [DIAGNOSTICS_KEY]: null }),
          chrome.storage.session.set({ [KEY]: job, [OBS_KEY]: null })
        ]);
        if (writes.some(result => result.status === 'rejected')) throw new Error('reset storage failed');
      } else {
        await chrome.storage.local.set({ [KEY]: checkpoint });
        await chrome.storage.session.set({ [KEY]: job });
      }
      emergencyJob = null;
      lastKnownJob = copy(job);
    } catch {
      await releasePower();
      const resetting = ['idle', 'resetting'].includes(job.phase);
      if (job.outer?.state === 'active') { job.outer.state = 'paused'; job.outer.reason = '关键状态保存失败'; job.outer.pausedAt = Date.now(); }
      job.running = false;
      job.resumePhase = job.phase;
      job.phase = resetting ? 'resetting' : 'manual';
      job.generation += 1;
      job.reason = resetting ? '重置未能完整保存，已保持停止；请重试重置。'
        : '任务状态无法保存，已停止。请检查扩展后重新开始。';
      emergencyJob = copy(job);
      await broadcast(job);
      const failure = new Error(job.reason);
      failure.code = 'TASK_STORAGE_FAILURE';
      throw failure;
    }
    // A pause can arrive while Start's new job is being persisted, before
    // its new runId is known by the initiating page. Cancel before broadcast
    // or navigation can authorize another document to execute.
    const cancellation = (job.running || job.outer?.state === 'active') && pendingStop(job);
    if (cancellation) {
      return save(pauseForCancellation(job, cancellation));
    }
    await saveDiagnostics(job, !job.running ||
      ['course-refresh', 'reload-course'].includes(job.logs?.at(-1)?.eventCode) ||
      job.diagnostic?.eventCode === 'interruption-attempt');
    scheduleOuterCheck(job);
    await syncPower(job);
    await broadcast(job);
    return job;
  }

  async function saveLog(job) {
    const prior = copy(lastKnownJob || job);
    job.revision = (job.revision || 0) + 1;
    job.updatedAt = Date.now();
    try {
      // Diagnostic text must not turn a working media task into a permanent
      // stop. Critical checkpoints still use save() and require both stores.
      await chrome.storage.session.set({ [KEY]: job });
    } catch {
      await saveDiagnostics(job, true);
      diagnosticStorageWarning = '会话日志暂未保存；诊断导出可能缺少最近记录。';
      return prior;
    }
    lastKnownJob = copy(job);
    const cancellation = pendingStop(job);
    if (cancellation) return save(pauseForCancellation(job, cancellation));
    await saveDiagnostics(job, job.logs?.at(-1)?.type === 'err');
    await broadcast(job);
    return job;
  }

  async function saveObservation(job, candidate, resource, observed) {
    // Position samples are advisory continuity evidence.  They arrive every
    // few seconds during natural playback, so keep them in a small session
    // record instead of rewriting the full task checkpoint on every sample.
    // A failure to write this hint never authorizes progress; the next
    // interruption is handled conservatively from the last durable record.
    const observation = {
      runId: job.runId,
      courseKey: candidate.courseKey,
      key: resource.key,
      routeKey: resource.routeKey,
      sample: copy(observed)
    };
    try {
      await chrome.storage.session.set({ [OBS_KEY]: observation });
    } catch {
      // Keep the in-memory sample for the current document.  Do not turn a
      // transient diagnostic storage failure into a false task stop.
    }
    resource.positionSample = copy(observed);
    lastKnownJob = copy(job);
    return job;
  }

  function restoreResumeEntry(job) {
    if (!job.resumeEntry) return;
    job.operation = job.resumeEntry.operation;
    job.targetPurpose = job.resumeEntry.purpose;
    delete job.resumeEntry;
  }

  function pause(job, reason = '', manual = false, metadata = {}) {
    // A cancelled page handoff remains the same course attempt, not a new scan.
    if (job.resumeEntry) { restoreResumeEntry(job); job.phase = 'course'; }
    if (job.outer?.state === 'active') {
      job.outer.state = 'paused'; job.outer.reason = reason || '用户暂停'; job.outer.pausedAt = Date.now();
    }
    clearNetworkRetryAlarm();
    if (job.running) job.resumePhase = job.phase;
    job.running = false;
    job.phase = manual ? 'manual' : 'paused';
    delete job.expectedRefresh;
    job.generation += 1;
    job.reason = reason;
    if (job.workflow === 'manual' && job.operation === 'inspect') {
      const candidate = job.candidates?.[job.targetIndex ?? job.selectedIndex];
      if (candidate) { candidate.scanState = manual ? 'error' : 'paused'; candidate.scanError = reason || '扫描已暂停'; }
    }
    addLog(job, reason || '已暂停：停止播放和后续自动操作', manual ? 'err' : 'info',
      { eventCode: manual ? 'task-blocked' : 'task-paused', ...metadata });
    return job;
  }

  function isSite(sender) {
    if (!sender.tab || sender.frameId !== 0) return false;
    try { return new URL(sender.url).origin === 'https://www.beeline-ai.com'; } catch { return false; }
  }

  function route(sender) {
    const type = routeParser.parse(sender?.url).type;
    return type === 'site' ? 'other' : type;
  }

  function courseKey(sender) {
    return routeParser.parse(sender?.url).courseKey;
  }

  function routeDiagnostic(raw) {
    try {
      const url = new URL(raw);
      const page = routeParser.parse(url.href);
      const hashPath = url.hash.replace(/^#/, '').split('?')[0];
      const path = `${url.pathname}${hashPath ? `#${hashPath}` : ''}`;
      return `${page.type}${page.routeFamily ? `/${page.routeFamily}` : ''} ${path}`.slice(0, 180);
    } catch {
      return '无法读取页面路由';
    }
  }

  function interruptionDiagnostic(tab, candidate, resource, msg) {
    const expectedRoute = resource?.routeKey
      ? routeDiagnostic(new URL(resource.routeKey, routeParser.SITE_ORIGIN).href)
      : '未保存';
    const pendingRoute = tab?.pendingUrl ? routeDiagnostic(tab.pendingUrl) : '无';
    return [
      `当前页=${routeDiagnostic(tab?.url)}`,
      `待跳页=${pendingRoute}`,
      `页面标题=${String(tab?.title || '无标题').slice(0, 80)}`,
      `预期课程=${String(candidate?.title || candidate?.courseKey || '未知').slice(0, 100)}`,
      `预期资源=${String(resource?.title || msg?.key || '未知').slice(0, 100)}`,
      `预期路由=${expectedRoute}`,
      `故障=${String(msg?.kind || 'unknown').slice(0, 40)}: ${String(msg?.reason || '').slice(0, 160)}`
    ].join('；');
  }

  function normalizeRouteForComparison(routeKey) {
    const queryAt = routeKey.indexOf('?');
    if (queryAt < 0) return routeKey;
    const parameters = routeKey.slice(queryAt + 1).split('&')
      .map((raw, index) => ({ raw, index, key: raw.split('=')[0] }));
    if (parameters.some(({ key }) => /[%+]/.test(key))) return routeKey;
    parameters.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index);
    // Keep paths, raw values and repeated-key order; only compare independent-key order.
    return `${routeKey.slice(0, queryAt + 1)}${parameters.map(item => item.raw).join('&')}`;
  }

  const routeEquals = (first, second) =>
    normalizeRouteForComparison(first) === normalizeRouteForComparison(second);

  function sameResourceUrl(actual, expected) {
    try {
      const current = new URL(actual), target = new URL(expected);
      return !current.username && !current.password && current.origin === target.origin &&
        current.search === target.search &&
        routeEquals(`${current.pathname}${current.hash}`, `${target.pathname}${target.hash}`);
    } catch { return false; }
  }

  function pageBlockingReason(msg) {
    if (msg.pageBlocked === true) return '当前页面有登录、验证或平台限制，需要人工处理';
    return typeof msg.pageBlocked === 'string' ? msg.pageBlocked.trim().slice(0, 400) : '';
  }

  function recoverableTaskPage(tab) {
    try {
      const url = new URL(tab.url);
      if (url.origin !== 'https://www.beeline-ai.com' || url.username || url.password) return false;
      const page = routeParser.parse(url.href);
      return ['agent', 'home'].includes(page.type) ||
        (url.pathname.startsWith('/student/') && ['courseInfo', 'shortCourse'].includes(page.routeFamily));
    } catch { return false; }
  }

  function interruptionStop(job, reason) {
    if (job.interruption) {
      job.interruption.status = 'failed';
      delete job.interruption.deadline;
    }
    return pause(job, reason || '连续三次恢复仍未成功，已停止任务并保留断点，请检查页面后继续。', true);
  }

  function pauseAfterNetworkRecovery(job, reason = '') {
    if (job.interruption) {
      job.interruption.status = 'failed';
      delete job.interruption.deadline;
    }
    const message = reason ||
      '网络恢复已尝试一次，页面仍未就绪，不再自动刷新；已暂停并保留断点，请检查网络和登录状态后点击继续。';
    return save(pause(job, message));
  }

  async function attemptInterruption(job, msg, sender, currentTab) {
    if (!canOperate(job)) return job;
    if (msg.reload === true && msg.navigate !== true) {
      throw new Error('恢复刷新必须先核对原音视频入口');
    }
    const candidate = job.candidates?.[job.targetIndex];
    if (job.phase !== 'course' || job.targetPurpose !== 'play' || !candidate?.courseKey) {
      throw new Error('当前课程恢复目标无法确认');
    }
    let episode = job.interruption;
    const networkRecovery = msg.kind === 'network' || episode?.kind === 'network';
    const tabId = job.ownerTabId;
    currentTab ||= await chrome.tabs.get(tabId);
    if (!canOperate(job)) return job;
    const resource = candidate.currentResource;
    const diagnostic = interruptionDiagnostic(currentTab, candidate, resource, msg);
    const blocked = pageBlockingReason(msg);
    if (blocked) {
      const reason = `${blocked}；${diagnostic}`;
      addLog(job, `恢复被页面人工处理要求阻止：${diagnostic}`, 'err');
      return save(interruptionStop(job, reason));
    }
    const networkErrorPage = networkRecovery && isNetworkErrorPage(currentTab.url);
    const pendingNetworkErrorPage = networkRecovery && isNetworkErrorPage(currentTab.pendingUrl);
    if ((!recoverableTaskPage(currentTab) && !networkErrorPage) ||
      (currentTab.pendingUrl && !recoverableTaskPage({ url: currentTab.pendingUrl }) &&
        !pendingNetworkErrorPage)) {
      const reason = `当前页面不在已确认的课程入口范围，已保留断点；请检查登录或平台提示。${diagnostic}`;
      addLog(job, `恢复路由核对失败：${diagnostic}`, 'err');
      return save(interruptionStop(job, reason));
    }
    let destination;
    if (msg.navigate === true) {
      try { destination = verifiedResourceUrl(candidate); }
      catch (error) { return save(interruptionStop(job, error.message)); }
      const openingRouteConfirmed = networkRecovery && resource?.stage === 'opening' &&
        Boolean(resource.routeKey) && msg.activeResourceKey === resource.key &&
        routeEquals(msg.documentRouteKey || '', resource.routeKey);
      if (msg.reload === true && (
        (!(resource?.stage === 'ready' || openingRouteConfirmed) || !resource.routeKey) ||
        (!networkErrorPage && !sameResourceUrl(currentTab.url, destination)) ||
        (currentTab.pendingUrl && !pendingNetworkErrorPage &&
          !sameResourceUrl(currentTab.pendingUrl, destination)))) {
        throw new Error('当前页面尚未回到已保存的精确音视频入口，不能刷新恢复');
      }
    }
    if (episode && (episode.courseKey !== candidate.courseKey ||
      (msg.episodeId && msg.episodeId !== episode.id))) throw new Error('TASK_CANCELLED');
    if (!episode && msg.episodeId) throw new Error('TASK_CANCELLED');
    if (msg.key && (episode?.key || resource?.key) && msg.key !== (episode?.key || resource?.key)) {
      throw new Error('保存的恢复资源与当前任务不符');
    }
    if (msg.key && !episode?.key && !resource?.key &&
      !candidate.directory?.items?.some(item => item.key === msg.key &&
        ['video', 'audio', 'media'].includes(item.mediaType))) {
      throw new Error('恢复目标不在已保存的课程目录中');
    }
    if (episode?.status === 'navigating' && episode.deadline > Date.now()) return job;
    if (episode?.status === 'attempting' && msg.navigate !== true) return job;
    // A network recovery may arrive later as a directory/player error. Keep
    // its one-navigation budget across message types and worker restarts.
    if (networkRecovery && msg.navigate === true && episode?.navigationAttempt > 0) {
      return pauseAfterNetworkRecovery(job);
    }
    if (networkRecovery && msg.navigate === true &&
      Number.isFinite(job.lastNetworkRefreshAt) &&
      Date.now() - job.lastNetworkRefreshAt < NETWORK_RETRY_TIMEOUT) {
      return pauseAfterNetworkRecovery(job,
        '距上次网络恢复刷新不足60秒，不再连续刷新；已暂停并保留断点，请检查网络后继续。');
    }
    if (!episode) {
      episode = job.interruption = {
        id: crypto.randomUUID(), courseKey: candidate.courseKey,
        key: resource?.key || msg.key || '', title: resource?.title || candidate.title,
        attempts: 0, status: 'failed', startedAt: Date.now(),
        kind: typeof msg.kind === 'string' ? msg.kind.slice(0, 40) : 'playback',
        ...(resource?.positionSample ? { positionSample: copy(resource.positionSample) } : {})
      };
    }
    if (!episode.key && msg.key) {
      const known = candidate.directory?.items?.find(item => item.key === msg.key &&
        ['video', 'audio', 'media'].includes(item.mediaType));
      if (!known) throw new Error('恢复目标不在已保存的课程目录中');
      episode.key = msg.key;
      episode.title = known.title;
    }
    if (msg.positionSample && resource?.stage === 'ready' && resource.routeKey &&
      !episode.gapDetected) {
      try {
        const sample = validateMediaObservation({
          ...msg.positionSample, key: resource.key, routeKey: resource.routeKey
        }, resource);
        if (!episode.positionSample || sample.time >= episode.positionSample.time) {
          episode.positionSample = sample;
        }
      } catch {
        // An out-of-date page sample grants no continuity credit. Keep the
        // most recent owned checkpoint, or start from the conservative origin.
      }
    }
    // Moving from a local playback retry to the saved learning entry is part
    // of the same attempt. Only a reported failure (or a navigation timeout)
    // spends the next attempt.
    const escalatingAttempt = episode.status === 'attempting' && msg.navigate === true &&
      episode.navigationAttempt !== episode.attempts;
    if (!escalatingAttempt) {
      if (episode.attempts >= 3) {
        if (episode.kind === 'network' || msg.kind === 'network') {
          return pauseAfterNetworkRecovery(job);
        }
        return save(outerLocalFailure(job));
      }
      episode.attempts += 1;
    }
    episode.status = msg.navigate === true ? 'navigating' : 'attempting';
    if (msg.navigate === true) {
      episode.navigationAttempt = episode.attempts;
      episode.requiresContinuityCheck = true;
      episode.continuityChecked = false;
      episode.navigationMode = msg.reload === true ? 'reload' : 'navigate';
      episode.requireNewDocument = msg.reload === true;
    }
    episode.reason = String(msg.reason || episode.reason || '播放暂时中断').slice(0, 400);
    if (networkRecovery) episode.kind = 'network';
    else if (typeof msg.kind === 'string') episode.kind = msg.kind.slice(0, 40);
    if (msg.navigate === true && !episode.positionSample && resource?.positionSample) {
      episode.positionSample = copy(resource.positionSample);
    }
    addLog(job, networkRecovery && msg.navigate === true
      ? `网络恢复：仅尝试一次重新载入，最多等待60秒，不自动重复刷新；${episode.reason}`
      : `正在恢复（${episode.attempts}/3）：${episode.reason}`, 'warn',
      { eventCode: 'recovery-started', resourceKey: resource?.key || '',
        evidence: { attempts: episode.attempts, kind: episode.kind } });
    if (!msg.navigate) {
      delete episode.deadline;
      return save(job);
    }
    episode.deadline = Date.now() + (networkRecovery ? NETWORK_RETRY_TIMEOUT : 15000);
    if (networkRecovery) {
      episode.navigationRequestedAt = Date.now();
      job.lastNetworkRefreshAt = episode.navigationRequestedAt;
    }
    episode.departureInstance = job.ownerInstance || job.ownerHandoff?.instanceId || null;
    const previousGeneration = job.generation;
    bindOwnerInstance(job, tabId, null);
    job.generation += 1;
    await saveOwnerHandoff(job, previousGeneration);
    if (!canOperate(job)) return job;
    // The saved checkpoint authorizes one normal document navigation. A pause,
    // redirect or verification page discovered during persistence cancels it.
    let latest;
    try { latest = await chrome.tabs.get(tabId); }
    catch { return save(interruptionStop(job, '任务页面已关闭，已保留断点；请重新打开网站。')); }
    if (!canOperate(job)) return job;
    const latestNetworkErrorPage = networkRecovery && isNetworkErrorPage(latest.url);
    const latestPendingNetworkErrorPage = networkRecovery && isNetworkErrorPage(latest.pendingUrl);
    if ((!recoverableTaskPage(latest) && !latestNetworkErrorPage) ||
      (latest.pendingUrl && !recoverableTaskPage({ url: latest.pendingUrl }) &&
        !latestPendingNetworkErrorPage)) {
      const latestDiagnostic = interruptionDiagnostic(latest, candidate, resource, msg);
      const reason = `课程页面出现未确认跳转，已保留断点；请检查登录或平台提示。${latestDiagnostic}`;
      addLog(job, `导航执行前二次路由核对失败：${latestDiagnostic}`, 'err');
      return save(interruptionStop(job, reason));
    }
    if (latest.url !== currentTab.url) {
      addLog(job, `恢复期间页面地址发生变化，取消本次导航；${interruptionDiagnostic(latest, candidate, resource, msg)}`, 'warn');
      return save(job);
    }
    if (msg.reload === true && ((!latestNetworkErrorPage && !sameResourceUrl(latest.url, destination)) ||
      (latest.pendingUrl && !latestPendingNetworkErrorPage &&
        !sameResourceUrl(latest.pendingUrl, destination)))) return job;
    if (networkRecovery) scheduleNetworkRetryAlarm(episode.deadline);
    if (job.workflow === 'manual') {
      job.expectedRefresh = {
        token: String(Date.now()), tabId, courseKey: candidate.courseKey,
        generation: job.generation, expiresAt: Date.now() + 45000
      };
      await save(job);
      if (!canOperate(job)) return job;
    }
    try {
      if (msg.reload === true && (networkErrorPage || pendingNetworkErrorPage ||
        latestNetworkErrorPage || latestPendingNetworkErrorPage)) {
        await chrome.tabs.update(tabId, { url: destination });
      } else if (msg.reload === true) await chrome.tabs.reload(tabId);
      else await chrome.tabs.update(tabId, { url: destination });
    }
    catch {
      // Keep the spent attempt and deadline across refresh/service-worker restart.
      // Network timeouts only pause; an issued refresh is never auto-repeated.
    }
    return job;
  }

  function verifiedLearnUrl(candidate) {
    try {
      const url = new URL(candidate.learnUrl);
      const page = { url: url.href };
      if (url.origin === 'https://www.beeline-ai.com' && !url.username && !url.password &&
        url.pathname.startsWith('/student/') && route(page) === 'learn' &&
        candidate.courseKey && courseKey(page) === candidate.courseKey) return url.href;
    } catch {}
    throw new Error('课程入口尚未核对，请回到首页重新统计课程');
  }

  function verifiedResourceUrl(candidate) {
    const entry = verifiedLearnUrl(candidate);
    const routeKey = candidate.currentResource?.routeKey;
    if (!routeKey) return entry;
    try {
      const url = new URL(routeKey, entry);
      const page = { url: url.href };
      if (url.origin === 'https://www.beeline-ai.com' && !url.username && !url.password &&
        url.pathname.startsWith('/student/') && route(page) === 'learn' &&
        courseKey(page) === candidate.courseKey &&
        routeEquals(`${url.pathname}${url.hash}`, routeKey)) return url.href;
    } catch {}
    throw new Error('原音视频入口与已保存的课程不符，已保留断点');
  }

  function validateMediaObservation(raw, resource) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      typeof raw.key !== 'string' || raw.key !== resource?.key ||
      typeof raw.routeKey !== 'string' || !resource?.routeKey ||
      !routeEquals(raw.routeKey, resource.routeKey) ||
      !Number.isFinite(raw.position) || raw.position < 0 ||
      !Number.isFinite(raw.time)) throw new Error('播放位置观察无法确认');
    const now = Date.now();
    // A sample is useful only while the owned document is still live. It is
    // never allowed to be backdated to manufacture time watched during a
    // navigation or a suspended browser.
    if (raw.time < now - 60000 || raw.time > now + 2000) {
      throw new Error('播放位置观察已过期');
    }
    const allowance = raw.allowance == null ? 2 : Number(raw.allowance);
    if (!Number.isFinite(allowance) || allowance < 0 || allowance > 5) {
      throw new Error('播放位置观察范围无法确认');
    }
    return { position: Number(raw.position), time: Number(raw.time),
      allowance: Number(allowance), key: raw.key, routeKey: raw.routeKey };
  }

  function requireOwner(job, msg, sender, phases) {
    if (!canOperate(job) || msg.runId !== job.runId ||
      msg.generation !== job.generation || sender.tab.id !== job.ownerTabId ||
      msg.instanceId !== job.ownerInstance || !phases.includes(job.phase)) {
      throw new Error('TASK_CANCELLED');
    }
  }

  async function expireOpening(job) {
    if (!canOperate(job)) return job;
    if (job.resumeEntry && Date.now() > job.resumeEntry.deadline) {
      return save(pause(job, '重新进入上次课程超时；断点已保留，请检查页面后手动继续。', false,
        { eventCode: 'outer-resume-entry-timeout' }));
    }
    if (job.phase === 'course' && job.interruption?.status === 'navigating' &&
      Date.now() >= job.interruption.deadline) {
      if (job.interruption.kind === 'network') return pauseAfterNetworkRecovery(job);
      let currentTab;
      try { currentTab = await chrome.tabs.get(job.ownerTabId); }
      catch { return save(interruptionStop(job, '任务页面已关闭，已保留断点；请重新打开网站。')); }
      if (!canOperate(job)) return job;
      const candidate = job.candidates?.[job.targetIndex];
      let reload = job.interruption.navigationMode === 'reload';
      // If the user moved again while a reload was pending, first return by
      // the ordinary verified navigation path; never refresh that other page.
      if (reload) {
        try { reload = sameResourceUrl(currentTab.url, verifiedResourceUrl(candidate)) &&
          (!currentTab.pendingUrl || sameResourceUrl(currentTab.pendingUrl, verifiedResourceUrl(candidate))); }
        catch { reload = false; }
      }
      return attemptInterruption(job, {
        episodeId: job.interruption.id, navigate: true,
        reload,
        reason: reload
          ? '学习页面刷新尚未接回，正在重新载入原音视频页面'
          : '学习入口尚未接回，正在重新打开已保存的课程'
      }, null, currentTab);
    }
    const deadline = job.phase === 'go-agent' ? 'agentDeadline'
      : job.phase === 'entry-home' ? 'entryDeadline'
        : job.phase === 'opening' ? 'openDeadline'
          : job.returnDeadline ? 'returnDeadline' : null;
    if (!deadline || !(Date.now() > job[deadline])) return job;
    const target = job.candidates[job.targetIndex];
    const key = `${deadline}:${job.targetIndex ?? ''}:${job.workerTabId ?? ''}`;
    const previous = job.navigationRecovery?.key === key ? job.navigationRecovery : {};
    if (Number(previous.nextRetryAt) > Date.now()) return job;
    const attempts = (Number(previous.attempts) || 0) + 1;
    const delay = attempts <= 3 ? 45000 : 300000;
    if (deadline === 'returnDeadline' && Number.isInteger(job.returningTabId) &&
      job.returningTabId !== job.homeTabId) {
      return save(pause(job, '旧跨课返回任务已停止；学习页和记录已保留，请手动选择课程。', true));
    }
    const tabId = job.phase === 'opening' && job.workerTabId != null ? job.workerTabId : job.homeTabId;
    let tab;
    try { tab = await chrome.tabs.get(tabId); }
    catch {
      if (canOperate(job)) return save(pause(job, '任务页面已关闭，已保留断点；请在网站页面重新开始。', true));
      return job;
    }
    if (!canOperate(job)) return job;
    let current;
    try { current = new URL(tab.url); } catch {}
    if (!current || current.origin !== 'https://www.beeline-ai.com') {
      return save(pause(job, '任务页面已离开本站，已保留断点；请检查登录状态后继续。', true));
    }
    const page = route({ url: current.href });
    const currentCourse = courseKey({ url: current.href });
    let destination = null;
    let retryEntry = false;
    let notice = '页面加载较慢，正在等待当前任务页面接回';
    if (deadline === 'agentDeadline') {
      if (page !== 'agent' && page !== 'home') {
        if (job.agentDepartureUrl !== current.href) {
          return save(pause(job, '首页跳转进入了未确认页面，已保留任务；请检查登录或平台提示。', true));
        }
        destination = AGENT;
      }
    } else if (deadline === 'entryDeadline') {
      if (page === 'agent') {
        retryEntry = true;
        notice = '课表尚未打开，正在重新识别首页的正常入口';
      } else if (page !== 'home') {
        return save(pause(job, '课表入口进入了未确认页面，已保留任务；请检查登录或平台提示。', true));
      }
    } else if (deadline === 'returnDeadline') {
      if (page !== 'home') {
        if (page !== 'learn' || !job.returnCourseKey || currentCourse !== job.returnCourseKey) {
          return save(pause(job, '返回课表时出现未确认页面，已保留任务；请检查登录或平台提示。', true));
        }
        destination = HOME;
      }
    } else if (job.targetPurpose === 'play') {
      const expected = verifiedLearnUrl(target);
      if (page === 'learn' && currentCourse === target.courseKey) {
        // Being at the destination URL is not a document handshake. Leave
        // ownership untouched until the new page sends its verified hello.
      } else if (page === 'home') destination = expected;
      else return save(pause(job, '课程跳转进入了未确认页面，已保留任务；请检查登录或平台提示。', true));
    } else {
      // Only a never-created inspection tab is a popup-blocking case. A tab
      // that existed and was later closed is handled by tabs.onRemoved.
      if (job.workerTabId == null) {
        if (page !== 'home') {
          return save(pause(job, '课程统计页打开前首页已离开本站，已保留任务；请回到课表后继续。', true));
        }
        await findUnclaimedInspectionTabs(job);
        if (!canOperate(job)) return job;
        const pendingTabs = [];
        for (const id of job.pendingOpenTabIds || []) {
          try {
            const pending = await chrome.tabs.get(id);
            const pendingUrl = pending.pendingUrl || pending.url || '';
            if (pending.windowId === job.openWindowId &&
              (['learn', 'learn-unsupported'].includes(route({ url: pendingUrl })) ||
                !pendingUrl || pendingUrl === 'about:blank')) {
              pendingTabs.push(id);
            }
          } catch { /* A closed candidate cannot receive the pending handshake. */ }
        }
        job.pendingOpenTabIds = pendingTabs;
        if (pendingTabs.length) {
          const waits = Number(job.pendingOpenTabWaits) || 0;
          if (waits >= INSPECTION_PENDING_TAB_WAIT_LIMIT) {
            return save(pause(job,
              '课程页已打开但尚未接回任务；请切换到刚打开的本课程页面，等页面加载后再继续。已保留扫描记录，未重复打开课程。',
              true));
          }
          job.pendingOpenTabWaits = waits + 1;
          job.openDeadline = Date.now() + INSPECTION_OPEN_RETRY_DELAY;
          job.navigationRecovery = {
            key, attempts: Number(previous.attempts) || 0,
            nextRetryAt: job.openDeadline
          };
          addLog(job, '已发现刚打开的课程页，等待页面加载并核对课程身份；暂不重复点击');
          await save(job);
          return job;
        }
        const recovery = job.openRecovery?.key === key ? job.openRecovery : { attempts: 0 };
        if (recovery.attempts < INSPECTION_OPEN_RETRY_LIMIT) {
          const attempts = recovery.attempts + 1;
          const nextRetryAt = Date.now() + INSPECTION_OPEN_RETRY_DELAY;
          job.openRecovery = {
            key, attempts, nextRetryAt,
            token: `${job.runId}:${job.targetIndex}:${attempts}:${Date.now()}`
          };
          job.navigationRecovery = { key, attempts, nextRetryAt };
          job.openDeadline = nextRetryAt;
          addLog(job, `课程统计页尚未打开，正在第 ${attempts} 次重试；等待新页面最多 ${INSPECTION_OPEN_RETRY_DELAY / 1000} 秒`);
          await save(job);
          return job;
        }
        return save(outerNavigationFailure(job,
          '课程统计页未能打开；请检查地址栏拦截提示，允许本站弹出窗口或新标签页后点击“继续”；无拦截提示时请检查网络或课程入口。'));
      }
      notice = '正在等待课程统计页加载并确认课程身份';
      if (job.workerTabId != null && page !== 'learn') {
        return save(pause(job, '课程统计页进入了未确认页面，请检查登录或平台提示。', true));
      }
    }
    job.navigationRecovery = { key, attempts, nextRetryAt: Date.now() + delay };
    job[deadline] = job.navigationRecovery.nextRetryAt;
    const previousGeneration = job.generation;
    if (retryEntry) {
      job.entryClicked = false;
      job.generation += 1;
    }
    if (attempts === 1 || attempts === 4) addLog(job, attempts > 3 ? `${notice}；保持任务，稍后自动再试` : notice);
    if (retryEntry) await saveOwnerHandoff(job, previousGeneration);
    else await save(job);
    if (!destination || !canOperate(job)) return job;
    // Saving can race a user pause or a platform redirect. Never pull an
    // unknown page back merely because an earlier URL was recoverable.
    let latest;
    try { latest = await chrome.tabs.get(tabId); } catch { return job; }
    if (!canOperate(job) || latest.url !== tab.url) return job;
    try { await chrome.tabs.update(tabId, { url: destination }); }
    catch { /* Keep this persisted deadline; the next bounded attempt retries. */ }
    return job;
  }

  async function navigateToCourse(job) {
    const url = verifiedLearnUrl(job.candidates[job.targetIndex]);
    if (!canOperate(job)) return job;
    try {
      // A normal navigation to a site-observed URL; playback permission remains the browser's decision.
      await chrome.tabs.update(job.homeTabId, { url, active: true });
    } catch {
      // The opening deadline retains the verified target and performs a
      // bounded retry instead of turning one navigation failure into a stop.
    }
    return job;
  }

  async function finish(job) {
    job.running = false;
    job.phase = 'finished';
    job.generation += 1;
    const pending = job.candidates.filter(c => c.status === 'manual').length;
    addLog(job, pending
      ? `自动任务结束：${pending} 门课有音视频或计任务文档待确认，请查看人工提醒。`
      : '所有已扫描课程的音视频与计任务文档均有页面完成标记。');
    addLog(job, '作业、考试和无任务状态圆圈的参考资料未处理。');
    return save(job);
  }

  function advanceCompletedInspections(job) {
    while (job.inspectIndex < job.candidates.length &&
      job.candidates[job.inspectIndex]?.status === 'completed') {
      job.inspectIndex += 1;
    }
  }

  async function resetTask(previous, sender) {
    const currentTab = await chrome.tabs.get(sender.tab.id);
    if (!isSite({ ...sender, url: currentTab.url })) throw new Error('请在网站页面重置插件');
    const holdIds = [...new Set([
      ...taskTabIds(previous || {}), ...(previous?.resetHoldTabIds || []),
      ...(previous?.createdTabIds || []), sender.tab.id
    ])];
    // This marker contains no old courses, playback records or logs. It only
    // prevents old documents and delayed replies from reviving erased work.
    const empty = {
      version: 3, runId: crypto.randomUUID(), generation: 1, revision: 0,
      resetEpoch: resetEpoch(previous) + 1, running: false, phase: 'resetting',
      candidates: [], logs: [], resetHoldTabIds: holdIds
    };
    if (previous?.phase === 'opening' || previous?.resumePhase === 'opening') {
      empty.resetOpeningParentId = previous.homeTabId;
      empty.resetOpeningUntil = Date.now() + 5000;
    }
    let saved = true;
    try { await save(empty); } catch { saved = false; }
    let tabs;
    try { tabs = await chrome.tabs.query({ url: 'https://www.beeline-ai.com/*' }); }
    catch {
      empty.reason = '已停止重置操作，但无法核对原任务页面；请刷新任务页后重试重置。';
      emergencyJob = copy(empty);
      throw new Error(empty.reason);
    }
    const present = new Set(tabs.map(tab => tab.id));
    if (previous?.phase === 'opening' || previous?.resumePhase === 'opening') {
      // A click may already have opened its page before onCreated's queued
      // handler ran. Include that page in the reset stop acknowledgement.
      for (const tab of tabs) {
        if (tab.openerTabId === previous.homeTabId && !holdIds.includes(tab.id)) holdIds.push(tab.id);
      }
    }
    empty.resetHoldTabIds = holdIds.filter(id => present.has(id));
    const required = new Set(empty.resetHoldTabIds);
    const reloaded = [];
    const outcomes = await Promise.all(tabs.map(async tab => {
      let timer;
      try {
        const result = await Promise.race([
          chrome.tabs.sendMessage(tab.id, { channel: CHANNEL, job: empty, tabId: tab.id, reset: true }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 5000); })
        ]);
        if (!required.has(tab.id) || (result?.resetEpoch === empty.resetEpoch && result.stopped === true)) return true;
        // The old document answered but could not pause its media (for
        // example while its player is suspended). A reset must still stop the
        // page, so use the same reload fallback as a missing listener.
        await chrome.tabs.reload(tab.id);
        reloaded.push(tab.id);
        return true;
      } catch {
        if (!required.has(tab.id)) return true;
        // A stale, discarded, or extension-reloaded document may no longer
        // have a content listener. Reset is already persisted before this
        // point; reloading the task page is the safe stop acknowledgement and
        // lets the new document observe the empty reset marker on startup.
        try {
          await chrome.tabs.get(tab.id);
          await chrome.tabs.reload(tab.id);
          reloaded.push(tab.id);
          return true;
        } catch {
          // A tab closed during delivery has no media left to stop.
          try { await chrome.tabs.get(tab.id); return false; } catch { return true; }
        }
      } finally { clearTimeout(timer); }
    }));
    if (saved && outcomes.every(Boolean)) {
      empty.phase = 'idle';
      delete empty.reason;
    } else {
      empty.reason = saved
        ? '原任务页面尚未全部确认停止。请刷新仍打开的任务页，再点击重置；旧任务记录已清除。'
        : '本地记录清理尚未完整保存，已保持停止；请重试重置。';
    }
    if (reloaded.length) {
      // Reloading a task tab stops its old media and the empty marker prevents
      // the replacement document from reviving the erased run. Keep the
      // marker in resetHoldTabIds until the tab reports its new document.
      empty.reason = '';
      empty.phase = 'idle';
      delete empty.reason;
    }
    await save(empty);
    // All site panels see the new empty state, while only task pages pause
    // their media. Repeated messages for this epoch never clear a newer run.
    await Promise.all(tabs.map(tab => notifyTab(tab.id,
      { channel: CHANNEL, job: empty, tabId: tab.id, reset: true })));
    return empty;
  }

  async function goHomeToScan(job) {
    const source = await chrome.tabs.get(job.homeTabId);
    job.returnCourseKey = courseKey({ url: source.url });
    bindHomeInstance(job, null);
    bindOwnerInstance(job, job.homeTabId, null);
    job.returningTabId = job.homeTabId;
    job.returnDeadline = Date.now() + 45000;
    await save(job);
    if (!canOperate(job)) return job;
    try { await chrome.tabs.update(job.homeTabId, { url: HOME, active: true }); }
    catch {
      // The persisted return deadline will retry the same known destination.
    }
    return job;
  }

  async function goAgentToStart(job, departingInstance) {
    const source = await chrome.tabs.get(job.homeTabId);
    if (!canOperate(job)) return job;
    job.agentDepartureUrl = source.url;
    job.agentDepartureInstance = departingInstance;
    bindHomeInstance(job, null);
    bindOwnerInstance(job, job.homeTabId, null);
    job.agentDeadline = Date.now() + 45000;
    await save(job);
    if (!canOperate(job)) return job;
    try { await chrome.tabs.update(job.homeTabId, { url: AGENT, active: true }); }
    catch {
      // The persisted entry deadline will retry this observed departure page.
    }
    return job;
  }

  function applyResourceRecord(job, msg, sender) {
    requireOwner(job, msg, sender, ['course']);
    const candidate = job.candidates[job.targetIndex];
    if (courseKey(sender) !== candidate.courseKey) throw courseIdentityError(msg, candidate, sender, 'sender.url');
    if (typeof msg.key !== 'string' || !msg.key.trim() || !msg.result ||
      typeof msg.result !== 'object' || Array.isArray(msg.result) ||
      ['started', 'attempted', 'ended', 'confirmed'].some(field =>
        msg.result[field] != null && typeof msg.result[field] !== 'boolean')) {
      throw new Error('音视频记录无法确认');
    }
    const directoryItem = candidate.directory?.items?.find(item => item.key === msg.key);
    const documentRecord = directoryItem?.mediaType === 'document' && directoryItem.taskItem === true;
    const mediaRecord = ['video', 'audio', 'media'].includes(directoryItem?.mediaType);
    if (job.singlePass && documentRecord && (
      msg.result.confirmed !== true || msg.result.completionSource !== 'page-marker' ||
      (msg.result.sitePercent != null) || msg.result.ended === true ||
      msg.result.targetReached === true || msg.result.deferred === true
    )) throw new Error('文档只接受平台完成标记，不接受访问记录或播放进度');
    if (job.singlePass && (
      ['targetReached', 'deferred'].some(field =>
        msg.result[field] != null && typeof msg.result[field] !== 'boolean') ||
      (msg.result.effectiveTarget != null && !validTargetPercent(msg.result.effectiveTarget)) ||
      (msg.result.sitePercent != null && (!Number.isFinite(msg.result.sitePercent) ||
        msg.result.sitePercent < 0 || msg.result.sitePercent > 100)) ||
      (msg.result.completionSource != null &&
        !['page-marker', 'site-progress'].includes(msg.result.completionSource)) ||
      (msg.result.confirmed === true && candidate.records?.[msg.key]?.confirmed !== true &&
        !(msg.result.completionSource === 'page-marker' ||
          (msg.result.completionSource === 'site-progress' && msg.result.sitePercent >= 80))) ||
      !mediaRecord && !documentRecord)) {
      throw new Error('音视频观看目标或平台状态无法确认');
    }
    candidate.records ||= {};
    const previous = candidate.records[msg.key];
    const next = { ...previous, ...msg.result };
    if (job.singlePass && mediaRecord) {
      next.effectiveTarget = previous?.effectiveTarget === 100 &&
        ((previous.recoveryAttempts || 0) + (previous.finalAttempts || 0) > 0)
        ? 100 : msg.result.effectiveTarget ?? previous?.effectiveTarget ?? job.targetPercent ?? 100;
      // Retry budgets belong to background checkpoints, not content records.
      for (const field of ['recoveryAttempts', 'finalAttempts', 'retryTokens']) {
        if (previous?.[field] == null) delete next[field];
        else next[field] = previous[field];
      }
    }
    if (previous?.recovery || msg.result.recovery) {
      next.recovery = recordRecovery(candidate, previous?.recovery, msg.result.recovery);
    }
    if (previous?.ended === true) {
      next.ended = true;
      if (previous.playbackAttempt) {
        if (msg.result.ended !== true) next.playbackAttempt = previous.playbackAttempt;
        else {
          next.playbackAttempt = { ...previous.playbackAttempt, ...msg.result.playbackAttempt };
          if (previous.playbackAttempt.finished) {
            next.playbackAttempt.finished = previous.playbackAttempt.finished;
          }
          const endEvents = (previous.playbackAttempt.events || []).filter(event => event.type === 'ended');
          if (endEvents.length && !next.playbackAttempt.events?.some(event => event.type === 'ended')) {
            next.playbackAttempt.events = [...(next.playbackAttempt.events || []), ...endEvents];
          }
        }
      }
    }
    if (previous?.confirmed === true) next.confirmed = true;
    if (previous?.started === true) next.started = true;
    if (previous?.attempted === true) next.attempted = true;
    if (next.ended === true && next.progressGap) throw new Error('仍有未观看的进度区间，不能确认播放结束');
    if (next.ended === true || (job.singlePass && next.confirmed === true)) delete next.error;
    candidate.records[msg.key] = next;
    const released = next.ended === true ||
      (job.singlePass && (next.targetReached === true || next.deferred === true || next.confirmed === true));
    if (candidate.currentResource?.key === msg.key && released) delete candidate.currentResource;
    if (job.singlePass && released && job.interruption?.courseKey === candidate.courseKey &&
      job.interruption.key === msg.key) delete job.interruption;
  }

  function awaitSelection(job, message, metadata = {}) {
    job.running = false;
    job.phase = 'selection';
    job.generation += 1;
    delete job.expectedRefresh;
    job.lastOperation = job.operation;
    job.operation = '';
    delete job.learnAfterScan;
    job.selectedIndex = null;
    delete job.resumePhase;
    delete job.interruption;
    delete job.reason;
    addLog(job, message, 'info', metadata);
    return job;
  }

  async function selectCourse(job, msg, sender) {
    if (!job || job.workflow !== 'manual' || job.running ||
        job.phase === 'resetting' || msg.runId !== job.runId ||
        msg.generation !== job.generation || isRetiredInstance(job, sender.tab.id, msg.instanceId)) {
      throw new Error('TASK_CANCELLED');
    }
    const outer = job.outer;
    const outerDispatch = outer?.state === 'active' && outer.dispatch;
    if (outer && ['active', 'paused'].includes(outer.state) && (!outerDispatch ||
      msg.roundId !== outer.id || msg.dispatchToken !== outerDispatch.token ||
      sender.tab.id !== job.ownerTabId || msg.instanceId !== job.ownerInstance ||
      pendingStop(job))) throw new Error('TASK_CANCELLED');
    const candidate = Number.isInteger(msg.index) && job.candidates[msg.index];
    if (!candidate || msg.candidateKey !== (candidate.courseKey || candidate.key) ||
        !['inspect', 'play', 'learn'].includes(msg.purpose)) throw new Error('课程选择已变化，请重新选择');
    if (msg.purpose === 'play' && (!Number.isFinite(candidate.scannedAt) ||
        !candidate.directory || candidate.scanState !== 'ready')) {
      throw new Error('请先完整扫描这门课的目录');
    }
    const current = await chrome.tabs.get(sender.tab.id);
    if (!isSite({ ...sender, url: current.url }) ||
        (pageBlockingReason(msg))) throw new Error('请先核对网站页面');
    if (outerDispatch) {
      const entry = outer.entries[outer.cursor];
      if (candidate.key !== entry.key || outerTerminal(entry) || msg.purpose !== 'learn' ||
        outerDispatch.attempt !== entry.reentries) throw new Error('TASK_CANCELLED');
      delete outer.dispatch;
      entry.state = 'running'; entry.dispatchedAt = Date.now();
      // The card must be revisited, even when a previous attempt cached a URL.
      // Retain the course identity so the normal hello rejects another class.
      if (entry.reentries > 0) delete candidate.learnUrl;
    }
    if (outer && !outerDispatch) outer.historyOnly = true;
    // Every explicit operation gets a new generation. Late scan/play writes
    // from any previous operation can no longer authorize navigation.
    job.generation += 1;
    job.running = true;
    job.learnAfterScan = msg.purpose === 'learn';
    job.operation = job.learnAfterScan ? 'inspect' : msg.purpose;
    job.selectedIndex = msg.index;
    job.targetIndex = msg.index;
    job.targetPurpose = job.operation;
    job.homeTabId = sender.tab.id;
    job.homeInstance = msg.instanceId;
    job.workerTabId = null;
    job.ownerTabId = sender.tab.id;
    job.ownerInstance = msg.instanceId;
    job.singlePass = true;
    if (validTargetPercent(msg.targetPercent)) job.targetPercent = msg.targetPercent;
    for (const key of ['reason', 'resumePhase', 'returningTabId', 'returnDeadline',
      'navigationRecovery', 'openRecovery', 'interruption', 'expectedRefresh',
      'openIssuedAt', 'openWindowId', 'openExistingTabIds', 'ignoredOpenTabIds',
      'pendingOpenTabIds', 'pendingOpenTabWaits']) delete job[key];
    delete candidate.scanDraft;
    if (job.operation === 'inspect') {
      candidate.scanState = 'scanning';
      delete candidate.scanError;
    } else {
      for (const key of ['pass', 'finalPass', 'lastRefresh', 'refreshTokens', 'currentResource', 'retryAt']) delete candidate[key];
      // A new user-requested pass retries unconfirmed items with a fresh
      // attempt budget while keeping historical evidence for reference.
      candidate.previousRecords = copy(candidate.records || {});
      candidate.records = Object.fromEntries(Object.entries(candidate.records || {})
        .filter(([, record]) => record.confirmed === true));
      candidate.failures = []; candidate.unconfirmed = []; candidate.unfinished = [];
      candidate.status = 'inspected';
    }
    if (candidate.learnUrl) {
      verifiedLearnUrl(candidate);
      job.workerTabId = sender.tab.id;
      if (route(current) === 'learn' && courseKey(current) === candidate.courseKey) {
        job.phase = 'course';
        addLog(job, job.operation === 'inspect' ? `核对本课目录：${candidate.title}` : `仅学习本课：${candidate.title}`);
        return save(job);
      }
      job.phase = 'opening';
      job.openDeadline = Date.now() + 45000;
      bindOwnerInstance(job, sender.tab.id, null);
      await save(job);
      return navigateToCourse(job);
    }
    job.phase = 'home';
    addLog(job, `等待打开用户选择的课程：${candidate.title}`);
    if (route(current) !== 'home') return goHomeToScan(job);
    return save(job);
  }

  // Per-round authority is an envelope around the manual single-course workflow.
  // No resource actions or completion rules belong here.
  const OUTER_BUDGET = 180000;
  const OUTER_LIST_AGE = 5 * 60000;
  const outerTerminal = entry => ['completed', 'skipped', 'failed'].includes(entry?.state);
  let outerBootChecked = false;
  let outerWatch = null;
  const OUTER_ALARM = 'xinwei-outer-deadline';
  let outerAlarmStamp = '';
  function scheduleOuterCheck(job, afterProgress = false) {
    const outer = job?.outer;
    if (outer?.state !== 'active' || !outer.stage) {
      if (outerAlarmStamp) {
        try { chrome.alarms?.clear?.(OUTER_ALARM)?.catch?.(() => {}); } catch {}
        outerAlarmStamp = '';
      }
      return;
    }
    const stamp = `${outer.id}:${outer.stage.name}:${outer.stage.startedAt}`;
    if (!afterProgress && stamp === outerAlarmStamp) return;
    outerAlarmStamp = stamp;
    try {
      chrome.alarms?.create?.(OUTER_ALARM, { when: afterProgress
        ? Math.max(Date.now() + 1000, (outerWatch?.progressAt || Date.now()) + OUTER_BUDGET)
        : outer.stage.deadline });
    } catch { /* Existing page synchronization still checks the same deadline. */ }
  }
  function outerStage(job, name) {
    const outer = job.outer;
    if (!outer || outer.state !== 'active' || outer.stage?.name === name) return;
    outer.stage = { name, startedAt: Date.now(), deadline: Date.now() + OUTER_BUDGET };
  }
  function outerTrack(job) {
    const outer = job.outer;
    if (!outer || outer.state !== 'active') return;
    if (['paused', 'manual', 'interrupted', 'resetting', 'idle'].includes(job.phase) &&
      !(job.phase === 'manual' && outer.awaitingStop?.localFailure)) {
      outer.state = 'paused'; outer.reason = job.reason || '已暂停';
      outer.pausedAt = Date.now();
      return;
    }
    outerStage(job, outer.awaitingStop ? 'stopping' : outer.dispatch ? 'dispatch' :
      job.returningTabId != null ? 'return' : job.phase === 'course'
        ? job.operation === 'inspect' ? 'scan' : 'running' : job.phase);
  }
  function outerResult(job, candidate, code, total, pending) {
    const outer = job.outer, entry = outer?.entries?.[outer.cursor];
    const platformPending = total != null && candidate.directory?.courseKey === candidate.courseKey
      ? candidate.directory.items.filter(isCourseTaskItem).filter(item => !taskConfirmed(item, candidate.records?.[item.key])).length : null;
    const result = { code, time: Date.now(), runId: job.runId, generation: job.generation,
      resetEpoch: resetEpoch(job), courseKey: candidate.courseKey, candidateKey: candidate.key,
      total, pending, platformPending, ...(outer && entry ? { roundId: outer.id, attempt: entry.reentries } : {}) };
    candidate.latestResult = result;
    addLog(job, `课程结果：${candidate.title} · ${code}`, code === 'course-failed' ? 'err' : pending ? 'warn' : 'ok',
      { eventCode: code, resourceKey: '', evidence: { count: total, reportedRemaining: pending, platformPendingCount: platformPending } });
    // The log and latest state are constructed from the same validated result.
    job.logs[job.logs.length - 1].result = copy(result);
    if (!outer || outer.state !== 'active' || !entry || entry.key !== candidate.key || outerTerminal(entry)) return;
    entry.courseKey = candidate.courseKey;
    entry.latestResult = result;
    if (code === 'course-completed' || code === 'course-no-tasks') {
      entry.state = code === 'course-completed' ? 'completed' : 'skipped';
      entry.reason = code;
    } else if (code !== 'course-failed') return;
    outer.awaitingStop = { token: crypto.randomUUID(), tabId: job.ownerTabId,
      instanceId: job.ownerInstance, resultGeneration: job.generation };
    outerStage(job, 'stopping');
  }
  function outerPrepare(job) {
    const outer = job.outer;
    if (outer.state !== 'active' || !outer.scopeConfirmed || job.running || outer.awaitingStop || outer.dispatch) return;
    while (outer.cursor < outer.entries.length && outerTerminal(outer.entries[outer.cursor])) outer.cursor++;
    if (outer.cursor === outer.entries.length) {
      outer.state = 'finished'; outer.finishedAt = Date.now(); delete outer.stage;
      outer.summary = Object.fromEntries(['completed', 'skipped', 'failed'].map(state =>
        [state, outer.entries.filter(entry => entry.state === state).length]));
      addLog(job, '本轮处理结束；作业考试需自行处理，失败课程不自动补跑', 'info', { eventCode: 'outer-finished' });
      return;
    }
    const entry = outer.entries[outer.cursor];
    outer.dispatch = { token: crypto.randomUUID(), key: entry.key, attempt: entry.reentries };
    outerStage(job, 'dispatch');
  }
  function outerCreate(job) {
    if (!Number.isFinite(job.listScannedAt) || !Array.isArray(job.candidates) || !job.candidates.length) {
      throw new Error('课表范围为空或未确认，请先获取课程列表');
    }
    const keys = job.candidates.map(c => c.key);
    if (keys.some(key => typeof key !== 'string' || !key) || new Set(keys).size !== keys.length) {
      throw new Error('课程身份不能唯一确认，请重新获取课程列表');
    }
    job.outer = { version: 1, id: job.outer?.scopeConfirmed === false ? job.outer.id : crypto.randomUUID(), state: 'active', createdAt: Date.now(),
      listScannedAt: job.listScannedAt, scopeConfirmed: true, cursor: 0,
      entries: job.candidates.map(candidate => {
        const evidence = candidate.homeEvidence;
        const skip = candidate.timetablePercent === 100 && evidence?.percent === 100 &&
          evidence.source === 'visible-home-progress' && evidence.time >= job.listScannedAt - OUTER_LIST_AGE;
        return { key: candidate.key, title: candidate.title, reentries: 0,
          state: skip ? 'skipped' : 'pending', ...(skip ? { reason: 'home-100', evidence: copy(evidence) } : {}) };
      }) };
    outerPrepare(job);
  }
  function outerLocalFailure(job, reason) {
    const active = job.outer?.state === 'active';
    interruptionStop(job, reason);
    if (active) {
      job.outer.state = 'active';
      outerResult(job, job.candidates[job.targetIndex], 'course-failed', null, null);
      job.outer.awaitingStop.localFailure = true;
    }
    return job;
  }
  function outerNavigationFailure(job, reason) {
    const active = job.outer?.state === 'active' && job.outer.entries[job.outer.cursor]?.reentries === 1;
    pause(job, reason, true);
    if (active) {
      job.outer.state = 'active';
      outerResult(job, job.candidates[job.targetIndex], 'course-failed', null, null);
      job.outer.awaitingStop.localFailure = true;
      job.outer.awaitingStop.allowedRoute = 'home';
    }
    return job;
  }
  async function outerSupervise(job, msg, sender) {
    const outer = job?.outer;
    if (outer?.state !== 'active') return job;
    outerTrack(job);
    if (outer.state !== 'active') return save(job);
    const now = Date.now(), watchKey = `${outer.id}:${outer.cursor}:${outer.entries[outer.cursor]?.reentries}:${outer.stage?.startedAt}:${job.generation}`;
    if (!outerWatch || outerWatch.key !== watchKey) outerWatch = { key: watchKey, checkedAt: now, progressAt: now };
    // A sleeping browser does not spend navigation/reentry permission on wake.
    if (now - outerWatch.checkedAt > 60000) {
      const previousCheck = outerWatch.checkedAt;
      outerWatch.checkedAt = now;
      return save(pause(job, '监督检查中断，无法确认持续运行（可能休眠）；请手动继续，将在原课程页核对目录。', false,
        { eventCode: 'outer-supervision-gap', evidence: { elapsedMs: now - previousCheck } }));
    }
    outerWatch.checkedAt = now;
    const scanning = ['scan', 'scan-home'].includes(outer.stage?.name);
    if (scanning || outer.stage?.name === 'running') {
      const candidate = job.candidates[job.targetIndex];
      // Only existing execution evidence counts; polling/log timestamps do not.
      const evidence = JSON.stringify([candidate?.currentResource?.key,
        candidate?.currentResource?.positionSample?.position,
        Object.entries(candidate?.records || {}).map(([key, r]) => [key, r.confirmed, r.ended,
          r.documentAccess?.attemptId, r.documentAccess?.response, r.recoveryAttempts, r.finalAttempts]),
        candidate?.pass, candidate?.finalPass,
        job.interruption?.id, job.interruption?.attempts]);
      let progress = evidence;
      {
        // A scan is owned inner work, not navigation. Read-only observations
        // travel on the existing owner sync; polling alone never renews progress.
        const owner = msg && sender?.tab?.id === job.ownerTabId && msg.instanceId === job.ownerInstance &&
          msg.runId === job.runId && msg.generation === job.generation && resetEpoch(msg) === resetEpoch(job) &&
          !isRetiredInstance(job, sender.tab.id, msg.instanceId);
        const observation = owner && msg.outerExecution;
        if (observation && observation.phase === job.phase && typeof observation.active === 'boolean' &&
          Array.isArray(observation.scan) && observation.scan.length === 4 &&
          observation.scan.every(n => Number.isSafeInteger(n) && n >= 0)) {
          outerWatch.scan = observation.active ? observation.scan : null;
          outerWatch.scanSeenAt = now;
        }
        progress = JSON.stringify(scanning ? outerWatch.scan || null : [evidence, outerWatch.scan || null]);
      }
      if (outerWatch.evidence !== progress) { outerWatch.evidence = progress; outerWatch.progressAt = now; }
      // Persist only bounded supervision evidence in session, so routine MV3
      // suspension cannot renew the deadline or discard the progress boundary.
      try { await chrome.storage.session.set({ [OUTER_WATCH_KEY]: outerWatch }); }
      catch { return save(pause(job, '外围监督状态保存失败，请确认页面后继续。', true)); }
      if (now - outerWatch.progressAt < OUTER_BUDGET &&
        (!scanning || !outerWatch.scanSeenAt || now - outerWatch.scanSeenAt < OUTER_BUDGET)) return job;
    } else if (now < outer.stage?.deadline) {
      try { await chrome.storage.session.set({ [OUTER_WATCH_KEY]: outerWatch }); }
      catch { return save(pause(job, '外围监督状态保存失败，请确认页面后继续。', true)); }
      return job;
    }
    if (outer.entries[outer.cursor]?.reentries === 1 && ['home', 'opening'].includes(job.phase) &&
      job.ownerInstance && job.workerTabId == null && !job.pendingOpenTabIds?.length && job.returningTabId == null) {
      let current;
      try { current = await chrome.tabs.get(job.ownerTabId); } catch { /* Pause below. */ }
      if (route(current) === 'home' && !current.pendingUrl) {
        return save(outerNavigationFailure(job, '本课重进超时，等待执行器停止后保留待处理并继续下一门。'));
      }
    }
    // Unknown executor state is never a licence to navigate or mark completion.
    return save(pause(job, '全自动交接超时或监督失联；已撤销后续派发，请确认执行器停止后继续。', true));
  }
  function adoptResumeHome(job, msg, sender) {
    if (job.homeTabId !== sender.tab.id) {
      retireInstance(job, job.homeTabId, job.homeInstance);
      job.homeTabId = sender.tab.id;
      job.homeInstance = null;
    }
    bindHomeInstance(job, msg.instanceId);
  }

  async function resumeOnOwner(job, msg, sender) {
    if (job.outer?.state !== 'paused' || job.running ||
      msg.roundId !== job.outer.id || resetEpoch(msg) !== resetEpoch(job) || !msg.instanceId) {
      throw new Error('任务状态已变化；本轮记录已保留');
    }
    const home = await chrome.tabs.get(sender.tab.id);
    if (home.pendingUrl || route(home) !== 'home') throw new Error('请在课表或原学习页继续');
    if (pageBlockingReason(msg)) throw new Error(pageBlockingReason(msg));
    const cancelled = () => pendingStop(job) || pendingCancellations.some(c =>
      c.tabId === sender.tab.id && c.msg.runId === job.runId &&
      resetEpoch(c.msg) === resetEpoch(job) && ['pause', 'manual', 'reset'].includes(c.msg.action));
    let target;
    try { target = await chrome.tabs.get(job.ownerTabId); } catch { /* Closed pages have no executor. */ }
    if (target?.pendingUrl) throw new Error('原学习页正在跳转，请稍后继续');
    const candidate = job.candidates[job.targetIndex];
    const sameCourse = target && route(target) === 'learn' && courseKey(target) === candidate?.courseKey;
    // A surviving site document must prove it has stopped, even if its route changed.
    if (target && isSite({ ...sender, url: target.url }) &&
      !(target.id === sender.tab.id && msg.stopped === true)) {
      let answer, timer;
      const token = crypto.randomUUID();
      try {
        answer = await Promise.race([
          chrome.tabs.sendMessage(target.id, { channel: CHANNEL, action: 'outer-resume-check', token, job, tabId: target.id }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('原页面暂未响应，请打开该标签页后重试')), 3000); })
        ]);
      } catch (error) { throw new Error(`无法确认原学习页：${error.message}`); }
      finally { clearTimeout(timer); }
      if (cancelled()) throw new Error('TASK_CANCELLED');
      const current = await chrome.tabs.get(target.id);
      if (current.pendingUrl || current.url !== target.url || !answer || answer.token !== token ||
        answer.runId !== job.runId || answer.generation !== job.generation || answer.resetEpoch !== resetEpoch(job) ||
        typeof answer.instanceId !== 'string' || !answer.instanceId ||
        isRetiredInstance(job, target.id, answer.instanceId) ||
        !routeEquals(answer.documentRouteKey || '', `${new URL(current.url).pathname}${new URL(current.url).hash}`) ||
        (sameCourse && (answer.courseKey !== candidate.courseKey || answer.title !== candidate.title))) {
        throw new Error('原学习页身份尚未确认，请在原页面检查后重试');
      }
      if (answer.pageBlocked) throw new Error(answer.pageBlocked);
      if (answer.stopped !== true) throw new Error('原学习页尚未停止，请稍后重试继续运行');
      if (sameCourse && !job.outer.awaitingStop && !job.outer.dispatch && job.resumePhase === 'course') {
        adoptResumeHome(job, msg, sender);
        bindOwnerInstance(job, target.id, answer.instanceId);
        addLog(job, '已在原学习页确认停止，继续本轮并重新核对目录', 'info', { eventCode: 'outer-resume-owner' });
        return outerCommand(job, { ...msg, instanceId: answer.instanceId, stopped: true },
          { ...sender, tab: current, url: current.url });
      }
    }
    if (cancelled()) throw new Error('TASK_CANCELLED');
    // A settled result belongs to this round. Rebind its stop acknowledgement,
    // rather than reopening an already completed course.
    const settling = job.outer.awaitingStop || job.outer.dispatch || job.resumePhase === 'selection';
    if (!settling && (!candidate?.courseKey || !['course', 'opening', 'home'].includes(job.resumePhase))) {
      throw new Error('上次课程身份尚未保存，无法自动找回；已有记录已保留');
    }
    let destination;
    if (!settling) {
      try { destination = verifiedResourceUrl(candidate); } catch { /* Locate the saved card, then verify the actual course ID. */ }
    }
    if (job.ownerTabId !== sender.tab.id || job.ownerInstance !== msg.instanceId) {
      retireInstance(job, job.ownerTabId, job.ownerInstance);
    }
    adoptResumeHome(job, msg, sender);
    bindOwnerInstance(job, sender.tab.id, msg.instanceId);
    job.workerTabId = null;
    for (const key of ['returningTabId', 'returnDeadline', 'navigationRecovery', 'openRecovery',
      'openIssuedAt', 'openWindowId', 'openExistingTabIds', 'ignoredOpenTabIds', 'pendingOpenTabIds', 'pendingOpenTabWaits']) delete job[key];
    if (settling) {
      if (job.outer.awaitingStop) {
        job.outer.awaitingStop.tabId = sender.tab.id;
        job.outer.awaitingStop.allowedRoute = 'home';
      }
      addLog(job, '已从课表接续本轮交接，保留已确认课程结果', 'info', { eventCode: 'outer-resume-queue' });
      job.generation += 1;
      return outerCommand(job, { ...msg, generation: job.generation, stopped: true }, sender);
    }
    job.resumeEntry = { operation: job.operation, purpose: job.targetPurpose,
      departureInstance: msg.instanceId, deadline: Date.now() + 45000, via: destination ? 'saved-url' : 'course-card' };
    job.generation += 1;
    job.running = true;
    job.outer.state = 'active'; delete job.outer.reason; delete job.outer.stage;
    delete job.reason;
    outerWatch = null;
    await chrome.storage.session.set({ [OUTER_WATCH_KEY]: null });
    if (destination) {
      job.phase = 'opening'; job.workerTabId = sender.tab.id;
      job.openDeadline = job.resumeEntry.deadline;
      bindOwnerInstance(job, sender.tab.id, null);
    } else {
      // Reuse the existing card locator/opening handshake only. Restore the
      // original execution purpose before any directory/resource work starts.
      job.phase = 'home'; job.operation = 'inspect'; job.targetPurpose = 'inspect';
    }
    addLog(job, `正在找回上次课程：${candidate.title}（${destination ? '已保存入口' : '课表入口'}）`, 'info',
      { eventCode: 'outer-resume-reopen' });
    await save(job);
    if (destination && canOperate(job)) {
      const current = await chrome.tabs.get(sender.tab.id);
      if (current.pendingUrl || current.url !== home.url) return save(pause(job, '课表页面已变化，已取消重新进入；断点已保留。'));
      try { await chrome.tabs.update(sender.tab.id, { url: destination, active: true }); }
      catch { return save(pause(job, '无法打开上次课程；断点已保留，请检查页面后继续。')); }
    }
    return job;
  }

  async function outerCommand(job, msg, sender) {
    if (!job || job.workflow !== 'manual' || msg.runId !== job.runId || msg.generation !== job.generation ||
      isRetiredInstance(job, sender.tab.id, msg.instanceId)) throw new Error('TASK_CANCELLED');
    const outer = job.outer;
    if (msg.action === 'outer-start') {
      if (job.running || outer && ['active', 'paused'].includes(outer.state)) throw new Error('请先停止或继续当前轮次');
      if (job.phase !== 'selection' && job.selectedIndex != null &&
        (sender.tab.id !== job.ownerTabId || msg.stopped !== true)) {
        throw new Error('请在原任务页面确认执行器停止后开始全自动');
      }
      if (!job.listScannedAt || Date.now() - job.listScannedAt > OUTER_LIST_AGE || job.outer) {
        return handle({ ...msg, action: 'start', scope: 'all', workflow: 'manual', singlePass: true,
          restart: true, outerRequested: true }, sender, true);
      }
      const current = await chrome.tabs.get(sender.tab.id);
      if (!isSite({ ...sender, url: current.url }) || pageBlockingReason(msg)) throw new Error('请先核对网站页面');
      job.ownerTabId = sender.tab.id; job.ownerInstance = msg.instanceId;
      job.homeTabId = sender.tab.id; job.homeInstance = msg.instanceId;
      outerCreate(job);
      addLog(job, '全自动本轮已授权，按固定列表顺序处理', 'info', { eventCode: 'outer-started' });
      return save(job);
    }
    if (msg.action === 'outer-continue' && (sender.tab.id !== job.ownerTabId ||
      route(await chrome.tabs.get(sender.tab.id)) === 'home')) {
      // Once rebound for queue settlement, avoid re-entering the home handoff.
      if (!(sender.tab.id === job.ownerTabId && msg.stopped === true &&
        (job.outer?.awaitingStop?.allowedRoute === 'home' || job.outer?.dispatch || job.resumePhase === 'selection'))) {
        return resumeOnOwner(job, msg, sender);
      }
    }
    if (!outer || msg.roundId !== outer.id || (msg.action === 'outer-manual'
      ? !taskTabIds(job).includes(sender.tab.id) : sender.tab.id !== job.ownerTabId)) throw new Error('TASK_CANCELLED');
    if (msg.action === 'outer-manual') {
      outer.state = 'revoked'; delete outer.dispatch;
      return save(pause(job, '已切换半自动；后续队列授权已撤销。'));
    }
    if (msg.action === 'outer-continue') {
      if (pageBlockingReason(msg)) throw new Error(pageBlockingReason(msg));
      if (outer.state !== 'paused' || job.running || msg.stopped !== true) throw new Error('请先确认原执行器停止');
      // Existing Continue resumes the selected inner attempt; it never selects
      // that course again or clears an outer reentry allowance.
      const elapsed = Date.now() - (outer.pausedAt || Date.now());
      if (outer.stage) {
        outer.stage.startedAt += elapsed; outer.stage.deadline += elapsed;
        if (outer.stage.deadline <= Date.now()) {
          outer.stage.startedAt = Date.now(); outer.stage.deadline = Date.now() + OUTER_BUDGET;
          outer.explicitContinuations = (outer.explicitContinuations || 0) + 1;
        }
      }
      outer.state = 'active'; delete outer.reason;
      outerWatch = null;
      await chrome.storage.session.set({ [OUTER_WATCH_KEY]: null });
      if (outer.awaitingStop || outer.dispatch || job.resumePhase === 'selection' || job.phase === 'selection') {
        bindOwnerInstance(job, sender.tab.id, msg.instanceId);
        if (outer.awaitingStop) outer.awaitingStop.instanceId = msg.instanceId;
        job.phase = 'selection'; delete job.reason;
        outerPrepare(job);
        return save(job);
      }
      // interrupted disk checkpoints retain their original resumePhase.
      job.phase = 'paused'; outer.state = 'paused';
      await save(job);
      return handle({ ...msg, action: 'start', workflow: 'manual', scope: 'all', restart: false }, sender, true);
    }
    if (msg.action === 'outer-stopped') {
      if (outer.state !== 'active' || job.running || job.ownerInstance !== msg.instanceId || msg.stopped !== true ||
        !outer.awaitingStop || msg.token !== outer.awaitingStop.token) throw new Error('TASK_CANCELLED');
      const entry = outer.entries[outer.cursor];
      if (!entry.latestResult || entry.latestResult.roundId !== outer.id || entry.latestResult.attempt !== entry.reentries) {
        throw new Error('本轮结果尚未确认');
      }
      const current = await chrome.tabs.get(sender.tab.id);
      const pageMatches = outer.awaitingStop.allowedRoute === 'home'
        ? route(current) === 'home' && !current.pendingUrl
        : route(current) === 'learn' && courseKey(current) === entry.courseKey;
      if (!pageMatches || pageBlockingReason(msg)) {
        return save(pause(job, '停止后页面身份无法确认，请核对课程与登录状态。', true));
      }
      delete outer.awaitingStop;
      job.phase = 'selection'; delete job.resumePhase; delete job.reason;
      if (entry.latestResult.code === 'course-failed') {
        if (entry.reentries === 0) {
          entry.reentries = 1; entry.firstFailure = copy(entry.latestResult); entry.state = 'pending';
          addLog(job, '已确认执行器停止，保存本课唯一一次返回课表重进额度', 'warn', { eventCode: 'outer-reentry' });
        } else { entry.state = 'failed'; entry.reason = 'reentry-failed'; }
      }
      outerPrepare(job);
      return save(job);
    }
    throw new Error('外围命令未识别');
  }

  async function handle(msg, sender, outerResume = false) {
    if (!isSite(sender)) throw new Error('页面来源无法确认');
    if (msg.action === 'export-diagnostics') {
      // Read raw snapshots only: exporting must not expire, resume or otherwise operate a task.
      const [live, disk, saved] = await Promise.all([
        chrome.storage.session.get(KEY), chrome.storage.local.get(KEY),
        chrome.storage.local.get(DIAGNOSTICS_KEY)
      ]);
      const job = live[KEY] && resetEpoch(live[KEY]) >= resetEpoch(disk[KEY]) ? live[KEY] : disk[KEY];
      const report = job ? diagnosticReport(job) : saved[DIAGNOSTICS_KEY] || diagnosticReport(null);
      const prior = saved[DIAGNOSTICS_KEY];
      if (job && !['idle', 'resetting'].includes(job.phase) && prior?.runId === job.runId &&
        prior.resetEpoch === resetEpoch(job)) {
        const entries = [...(prior.logs || []), ...report.logs];
        const ids = new Set();
        report.logs = entries.filter(entry => !entry.id || (!ids.has(entry.id) && ids.add(entry.id)))
          .sort((a, b) => a.time - b.time || (a.sequence || 0) - (b.sequence || 0)).slice(-300);
        if ((prior.incident?.time || 0) > (report.incident?.time || 0)) report.incident = prior.incident;
        report.savedAt = prior.capturedAt;
      }
      const exported = job && !['idle', 'resetting'].includes(job.phase)
        ? diagnosticArchive.merge(prior, report, job.outer ? redactDiagnostic(job.outer) : undefined) : report;
      return { ...exported, storageWarning: diagnosticStorageWarning };
    }
    let job = await read();
    if (!outerResume) job = await outerSupervise(job, msg, sender);
    if (msg.action === 'start' && msg.workflow === 'auto') {
      throw new Error('一键全课模式已移除，请获取课程列表后手动选择一门课程。');
    }
    if ((job?.running || job?.outer?.state === 'active') && sender.tab.id === job.ownerTabId && pageBlockingReason(msg) &&
      (!msg.runId || msg.runId === job.runId) &&
      !isRetiredInstance(job, sender.tab.id, msg.instanceId)) {
      return save(interruptionStop(job, pageBlockingReason(msg)));
    }
    job = await expireOpening(job);
    const tabId = sender.tab.id;
    if (msg.action === 'get' && job?.outer?.state === 'active' && !job.running &&
      job.ownerTabId === tabId && job.ownerInstance && job.ownerInstance !== msg.instanceId &&
      !isRetiredInstance(job, tabId, msg.instanceId)) {
      bindOwnerInstance(job, tabId, msg.instanceId);
      return save(pause(job, '页面已刷新；本轮结果已保留，请明确继续。'));
    }
    await syncPower(job);
    if (msg.action === 'set-keep-awake') {
      if (typeof msg.enabled !== 'boolean') throw new Error('防休眠设置无效');
      await chrome.storage.local.set({ [POWER_KEY]: msg.enabled });
      powerEnabled = msg.enabled;
      powerError = '';
      await syncPower(job);
      if (job) {
        addLog(job, msg.enabled ? '已开启运行时防止自动休眠' : '已关闭运行时防止自动休眠', 'info', { eventCode: 'power-setting' });
        return saveLog(job);
      }
      return job;
    }
    if (msg.action === 'get') return job;
    if (msg.action === 'focus-task') {
      if (!job || msg.runId !== job.runId || msg.generation !== job.generation ||
          resetEpoch(msg) !== resetEpoch(job)) throw new Error('任务已变化，请重试');
      const targetId = job.ownerTabId;
      if (!Number.isInteger(targetId)) throw new Error('学习标签页已关闭');
      const target = await chrome.tabs.get(targetId);
      if (!isSite({ ...sender, url: target.url })) throw new Error('学习标签页已离开网站');
      await chrome.tabs.update(targetId, { active: true });
      if (Number.isInteger(target.windowId)) await chrome.windows.update(target.windowId, { focused: true });
      return job;
    }
    if (resetEpoch(msg) !== resetEpoch(job)) throw new Error('TASK_CANCELLED');
    captureDiagnostic(job, msg, tabId);
    if (msg.action === 'reset') return resetTask(job, sender);
    if (msg.action.startsWith('outer-')) {
      try { return await outerCommand(job, msg, sender); }
      catch (error) {
        if (msg.action === 'outer-continue' && job?.outer?.state === 'paused' &&
          msg.runId === job.runId && msg.generation === job.generation && msg.roundId === job.outer.id &&
          error.message !== 'TASK_CANCELLED') {
          addLog(job, `继续未执行：${error.message}`, 'warn', { eventCode: 'outer-resume-rejected' });
          await saveLog(job);
        }
        throw error;
      }
    }
    if (msg.action === 'course-select') return selectCourse(job, msg, sender);
    if (msg.action === 'hello') {
      if (job?.resumeEntry && job.ownerTabId === tabId && !job.resumeEntry.observedHello) {
        job.resumeEntry.observedHello = true;
        addLog(job, `找回页面首次响应：标题=${String(msg.title || '尚未加载').slice(0, 80)}，路由=${route(sender)}，新文档=${msg.instanceId !== job.resumeEntry.departureInstance}`, 'info',
          { eventCode: 'outer-resume-page-observed' });
        await save(job);
      }
      if (!job || !canOperate(job) || (msg.runId && msg.runId !== job.runId) ||
        typeof msg.instanceId !== 'string' || !msg.instanceId ||
        isRetiredInstance(job, tabId, msg.instanceId)) return job;
      if (msg.reconnect === true) {
        requireOwner(job, msg, sender, ['entry-home', 'scan-home', 'home', 'course']);
        const currentTab = await chrome.tabs.get(tabId);
        const current = { ...sender, url: currentTab.url };
        const liveRouteKey = `${new URL(currentTab.url).pathname}${new URL(currentTab.url).hash}`;
        const candidate = job.candidates[job.targetIndex];
        const pageMatches = job.phase === 'course'
          ? route(current) === 'learn' && courseKey(current) === candidate?.courseKey &&
            msg.title === candidate?.title &&
            (!candidate.currentResource?.routeKey ||
              routeEquals(liveRouteKey, candidate.currentResource.routeKey))
          : route(current) === (job.phase === 'entry-home' ? 'agent' : 'home');
        if (!isSite(current) || currentTab.pendingUrl ||
          !routeEquals(msg.documentRouteKey || '', liveRouteKey) || !canOperate(job)) return job;
        if (job.phase === 'course' && !msg.title) return job;
        if (!pageMatches) {
          if (job.phase === 'course' && job.targetPurpose === 'play') {
            return attemptInterruption(job, { ...msg, navigate: true,
              reason: '后台重连后页面已变化，正在返回原课程' }, sender, currentTab);
          }
          return job;
        }
        const previousGeneration = job.generation;
        job.generation += 1;
        addLog(job, '扩展后台已重新连接，已核对原页面，继续同一任务');
        return saveOwnerHandoff(job, previousGeneration);
      }
      if (Number.isInteger(job.returningTabId) && job.returningTabId !== job.homeTabId) {
        return save(pause(job, '旧跨课返回任务已停止；学习页和记录已保留，请手动选择课程。', true));
      }
      if (job.resumeEntry?.via === 'saved-url' && tabId === job.ownerTabId && route(sender) === 'home' &&
        msg.instanceId !== job.resumeEntry.departureInstance) {
        const actual = await chrome.tabs.get(tabId);
        if (actual.pendingUrl || route(actual) !== 'home' || !routeEquals(msg.documentRouteKey || '',
          `${new URL(actual.url).pathname}${new URL(actual.url).hash}`)) return job;
        if (pageBlockingReason(msg)) return save(pause(job, pageBlockingReason(msg), true));
        job.resumeEntry.via = 'course-card';
        job.resumeEntry.departureInstance = msg.instanceId;
        job.phase = 'home'; job.operation = 'inspect'; job.targetPurpose = 'inspect';
        job.workerTabId = null;
        bindHomeInstance(job, msg.instanceId); bindOwnerInstance(job, tabId, msg.instanceId);
        addLog(job, '保存入口已返回课表，重新定位原课程并核对教学班', 'info', { eventCode: 'outer-resume-card-fallback' });
        return save(job);
      }
      if (job.phase === 'course' && tabId === job.ownerTabId) {
        const currentTab = await chrome.tabs.get(tabId);
        if (!canOperate(job)) return job;
        const blocked = pageBlockingReason(msg);
        if (blocked) return save(interruptionStop(job, blocked));
        const current = { ...sender, url: currentTab.url };
        const candidate = job.candidates[job.targetIndex];
        const liveRouteKey = `${new URL(currentTab.url).pathname}${new URL(currentTab.url).hash}`;
        const routeMismatch = candidate.currentResource?.stage === 'ready' &&
          !routeEquals(liveRouteKey, candidate.currentResource.routeKey);
        if (!isSite(current) || route(current) !== 'learn' || courseKey(current) !== candidate.courseKey || routeMismatch) {
          if (job.targetPurpose === 'play') return attemptInterruption(job,
            { ...msg, navigate: true, reason: '页面发生变化，正在返回原课程' }, sender, currentTab);
          return save(pause(job, '当前课程或教学班与保存的任务不符，已停止。', true));
        }
        // The browser can expose the destination before its old DOM unloads.
        // A surviving SPA document may reconnect only after its own route and
        // selected resource agree with the saved task, not from the tab URL alone.
        if (job.interruption?.status === 'navigating' &&
          msg.instanceId === job.interruption.departureInstance) {
          if (job.interruption.requireNewDocument) return job;
          const resource = candidate.currentResource;
          if (typeof msg.documentRouteKey !== 'string' ||
            !routeEquals(msg.documentRouteKey, liveRouteKey) ||
            (resource?.key && msg.activeResourceKey !== resource.key)) return job;
        }
        if (!msg.title) return job;
        if (msg.title !== candidate.title) {
          if (job.targetPurpose === 'play') return attemptInterruption(job,
            { ...msg, navigate: true, reason: '课程名称尚未对齐，正在重新核对原课程' }, sender, currentTab);
          return save(pause(job, '当前课程名称与保存的任务不符，已停止。', true));
        }
        const arrivedAfterInterruption = job.interruption?.status === 'navigating';
        if (arrivedAfterInterruption) {
          clearNetworkRetryAlarm();
          job.interruption.status = 'attempting';
          delete job.interruption.deadline;
          delete job.interruption.departureInstance;
          delete job.interruption.requireNewDocument;
        }
        if (job.ownerInstance && job.ownerInstance !== msg.instanceId) {
          return takeOverRefreshedOwner(job, msg, current);
        }
        if (!job.ownerInstance) {
          bindOwnerInstance(job, tabId, msg.instanceId);
          return save(job);
        }
        return arrivedAfterInterruption ? save(job) : job;
      }
      if (job.phase === 'go-agent') {
        if (tabId !== job.homeTabId || tabId !== job.ownerTabId) return job;
        // A SPA can retain an old sender URL. Only the browser's current tab
        // URL can confirm arrival at the site's observed homepage.
        const currentTab = await chrome.tabs.get(tabId);
        if (!canOperate(job)) return job;
        const currentPage = isSite({ ...sender, url: currentTab.url })
          ? route({ url: currentTab.url }) : 'other';
        if (currentPage === 'agent' || currentPage === 'home') {
          // tabs.update can expose the destination URL before the old page
          // unloads. It performs a document navigation for this path change:
          // only a new document whose own URL is the destination may claim it.
          if (msg.instanceId === job.agentDepartureInstance ||
            !['agent', 'home'].includes(route(sender))) return job;
          const previousGeneration = job.generation;
          bindHomeInstance(job, msg.instanceId);
          bindOwnerInstance(job, tabId, msg.instanceId);
          job.phase = currentPage === 'agent' ? 'entry-home' : 'scan-home';
          if (currentPage === 'agent') {
            job.entryClicked = false;
            job.entryDeadline = Date.now() + 45000;
          }
          delete job.agentDeadline;
          delete job.agentDepartureInstance;
          delete job.agentDepartureUrl;
          delete job.navigationRecovery;
          job.generation += 1;
          addLog(job, currentPage === 'agent'
            ? '已进入网站首页，正在打开全部课表'
            : '已进入全部课表，开始核对正在上的课程');
          return saveOwnerHandoff(job, previousGeneration);
        }
        // goAgentToStart deliberately clears ownership before tabs.update.
        // Its departing document can still send hello while the tab exposes
        // the source URL. This is the pending handoff, not a user refresh.
        if (!job.ownerInstance && msg.instanceId === job.agentDepartureInstance &&
          currentTab.url === job.agentDepartureUrl && sender.url === job.agentDepartureUrl) return job;
        // A different source document still requires explicit Continue.
        if (job.ownerInstance !== msg.instanceId) return takeOverRefreshedOwner(job, msg, sender);
        return job;
      }
      if (job.phase === 'entry-home') {
        if (tabId !== job.homeTabId || tabId !== job.ownerTabId) return job;
        // Vue navigation can keep the content instance and its original sender
        // document URL. Confirm arrival against this task tab's live URL.
        const currentTab = await chrome.tabs.get(tabId);
        if (!canOperate(job)) return job;
        const currentPage = isSite({ ...sender, url: currentTab.url })
          ? route({ url: currentTab.url }) : 'other';
        if (currentPage === 'home' && (job.entryClicked === true || job.entryAttempted === true)) {
          const previousGeneration = job.generation;
          bindHomeInstance(job, msg.instanceId);
          bindOwnerInstance(job, tabId, msg.instanceId);
          job.phase = 'scan-home';
          delete job.entryClicked;
          delete job.entryAttempted;
          delete job.entryDeadline;
          delete job.navigationRecovery;
          job.generation += 1;
          addLog(job, '已进入全部课表，开始核对正在上的课程');
          return saveOwnerHandoff(job, previousGeneration);
        }
        if (currentPage === 'agent') {
          if (job.ownerInstance !== msg.instanceId) return takeOverRefreshedOwner(job, msg, sender);
          return job;
        }
        return save(pause(job, '当前页面与课表入口任务不符，已停止，请核对页面。', true));
      }
      let changed = false;
      if (job.returningTabId === job.homeTabId) {
        if (tabId !== job.homeTabId || route(sender) !== 'home') return job;
        bindHomeInstance(job, msg.instanceId);
        bindOwnerInstance(job, tabId, msg.instanceId);
        delete job.returningTabId;
        delete job.returnDeadline;
        delete job.returnCourseKey;
        delete job.navigationRecovery;
        changed = true;
      }
      if (job.phase === 'opening' && job.workerTabId === job.homeTabId &&
        tabId === job.homeTabId && !['learn', 'learn-unsupported'].includes(route(sender))) return job;
      if (tabId === job.homeTabId && route(sender) === 'home') {
        if (job.ownerTabId === tabId && job.ownerInstance && job.ownerInstance !== msg.instanceId) {
          if (!['scan-home', 'home'].includes(job.phase)) {
            return save(pause(job, '当前页面与原任务不符，已停止，请核对页面。', true));
          }
          return takeOverRefreshedOwner(job, msg, sender);
        }
        if (job.homeInstance !== msg.instanceId) { bindHomeInstance(job, msg.instanceId); changed = true; }
        if (job.ownerTabId === tabId && !job.ownerInstance) {
          bindOwnerInstance(job, tabId, msg.instanceId);
          changed = true;
        }
      }
      const unclaimedInspectionTab = job.phase === 'opening' && job.targetPurpose === 'inspect' &&
        job.workerTabId == null && Array.isArray(job.openExistingTabIds) &&
        !job.openExistingTabIds.includes(tabId) && !job.ignoredOpenTabIds?.includes(tabId) &&
        Date.now() <= job.openDeadline;
      const pendingOpenTab = job.phase === 'opening' && job.targetPurpose === 'inspect' &&
        (job.pendingOpenTabIds?.includes(tabId) || unclaimedInspectionTab);
      if (pendingOpenTab) {
        const actual = await chrome.tabs.get(tabId);
        if (!canOperate(job)) return job;
        if (actual.windowId !== job.openWindowId) return job;
      }
      const inOpeningTab = job.phase === 'opening' &&
        (tabId === job.workerTabId || (tabId === job.homeTabId && job.workerTabId == null) || pendingOpenTab);
      if (inOpeningTab && route(sender) === 'learn-unsupported') {
        const info = routeParser.parse(sender.url);
        return save(pause(job,
          `已打开疑似课程页，但页面路由无法安全识别（${info.reason || '当前课程页格式暂不支持'}）。请更新插件后重新加载课程页。`, true));
      }
      if (inOpeningTab && route(sender) === 'learn' && job.resumeEntry) {
        const actual = await chrome.tabs.get(tabId);
        if (actual.pendingUrl || (msg.instanceId === job.resumeEntry.departureInstance &&
          !(job.resumeEntry.resourceNavigation &&
            msg.activeResourceKey === job.candidates[job.targetIndex]?.currentResource?.key)) ||
          !routeEquals(msg.documentRouteKey || '', `${new URL(actual.url).pathname}${new URL(actual.url).hash}`) ||
          courseKey(actual) !== courseKey(sender)) return job;
        if (pageBlockingReason(msg)) return save(pause(job, pageBlockingReason(msg), true));
        const candidate = job.candidates[job.targetIndex];
        if (courseKey(actual) !== candidate.courseKey) {
          return save(pause(job, '重新进入的课程或教学班不符；断点已保留，请核对课表。', true));
        }
      }
      if (inOpeningTab && route(sender) === 'learn') {
        const candidate = job.candidates[job.targetIndex];
        const key = courseKey(sender);
        if (!msg.title || !key) return job; // page is still loading
        if (pendingOpenTab && (msg.title !== candidate.title ||
          (candidate.courseKey && candidate.courseKey !== key))) {
          job.pendingOpenTabIds = (job.pendingOpenTabIds || []).filter(id => id !== tabId);
          job.ignoredOpenTabIds = [...new Set([...(job.ignoredOpenTabIds || []), tabId])];
          return save(job);
        }
        if (pendingOpenTab) {
          const actual = await chrome.tabs.get(tabId);
          if (!canOperate(job)) return job;
          if (actual.windowId !== job.openWindowId || courseKey({ url: actual.url }) !== key ||
            (job.workerTabId != null && job.workerTabId !== tabId)) return job;
        }
        if (candidate.courseKey && candidate.courseKey !== key) {
          return save(pause(job, '打开的课程或教学班与任务不符，已停止，请核对页面。', true));
        }
        if (msg.title !== candidate.title) return job;
        candidate.courseKey = key;
        candidate.learnUrl = sender.url;
        if (!job.resumeEntry && job.recoveryRecords?.[key]) {
          candidate.records = retryRecords(job.recoveryRecords[key]);
          delete job.recoveryRecords[key];
        }
        job.workerTabId = tabId;
        if (pendingOpenTab) {
          job.createdTabIds.push(tabId);
          job.pendingOpenTabIds = job.pendingOpenTabIds.filter(id => id !== tabId);
          delete job.pendingOpenTabWaits;
        }
        if (job.resumeEntry) {
          // A card can open the course's default resource. Return to the saved
          // resource route before handing off to the unchanged inner executor.
          const destination = verifiedResourceUrl(candidate);
          if (!routeEquals(`${new URL(destination).pathname}${new URL(destination).hash}`,
            msg.documentRouteKey || '')) {
            job.workerTabId = tabId;
            bindOwnerInstance(job, tabId, null);
            job.resumeEntry.departureInstance = msg.instanceId;
            job.resumeEntry.resourceNavigation = true;
            await save(job);
            if (canOperate(job)) await chrome.tabs.update(tabId, { url: destination, active: true });
            return job;
          }
          restoreResumeEntry(job);
          if (job.interruption?.status === 'navigating') {
            job.interruption.status = 'attempting';
            delete job.interruption.deadline;
            delete job.interruption.departureInstance;
            delete job.interruption.requireNewDocument;
          }
          addLog(job, '已找回原课程，交由内层重新核对目录；播放成功仍以实际推进为准', 'info',
            { eventCode: 'outer-resume-arrived' });
        }
        bindOwnerInstance(job, tabId, msg.instanceId);
        job.phase = 'course';
        delete job.navigationRecovery;
        delete job.openRecovery;
        delete job.openIssuedAt;
        delete job.openWindowId;
        delete job.openExistingTabIds;
        delete job.ignoredOpenTabIds;
        changed = true;
        addLog(job, `已打开课程：${candidate.title}；${job.targetPurpose === 'inspect' ? '统计音视频，不启动播放' : '开始正常播放'}`);
      } else if (tabId === job.ownerTabId && job.phase === 'course') {
        const candidate = job.candidates[job.targetIndex];
        if (route(sender) !== 'learn' || courseKey(sender) !== candidate.courseKey) {
          return save(pause(job, '当前课程或教学班与保存的任务不符，已停止。', true));
        }
        if (!msg.title) return job; // A refreshed document may still be loading the course title.
        if (msg.title !== candidate.title) {
          return save(pause(job, '当前课程名称与保存的任务不符，已停止。', true));
        }
        if (job.ownerInstance && job.ownerInstance !== msg.instanceId) {
          return takeOverRefreshedOwner(job, msg, sender);
        }
        if (!job.ownerInstance) {
          bindOwnerInstance(job, tabId, msg.instanceId);
          changed = true;
        }
      } else if (tabId === job.ownerTabId && job.ownerInstance &&
        job.ownerInstance !== msg.instanceId) {
        return save(pause(job, '任务页面已重新加载，已暂停。点击继续前将重新核对目录。', true));
      }
      return changed ? save(job) : job;
    }
    if (msg.action === 'pause' || msg.action === 'manual') {
      if (!job || ['finished', 'idle', 'resetting'].includes(job.phase)) return job;
      if (!taskTabIds(job).includes(tabId)) throw new Error('任务在另一个页面，请到任务页面暂停');
      // An old document must not pause a replacement task.
      if (msg.runId && msg.runId !== job.runId && !isStartCancellation(job, msg, tabId)) return job;
      if (msg.action === 'manual' && msg.generation !== job.generation) return job;
      preserveStopGap(job, msg, tabId);
      const failure = msg.diagnostic?.error;
      return save(pause(job, String(msg.reason || ''), msg.action === 'manual',
        msg.action === 'manual' && failure?.code === 'TASK_COMMAND_REJECTED'
          ? { eventCode: 'command-rejected', resourceKey: failure.action === 'directory-checkpoint' ? '' : undefined,
            evidence: { ...diagnosticEvidence(failure.details), action: failure.action } }
          : {}));
    }
    if (msg.action === 'start') {
      if (job?.outer && ['active', 'paused'].includes(job.outer.state) && !outerResume) {
        throw new Error('全自动本轮尚未结束，请整体继续或切换半自动');
      }
      if (job?.phase === 'resetting') throw new Error(job.reason || '重置还未确认完成，请重试重置');
      if (msg.singlePass != null && typeof msg.singlePass !== 'boolean') {
        throw new Error('课程任务模式无法确认');
      }
      if (msg.targetPercent != null && !validTargetPercent(msg.targetPercent)) {
        throw new Error('观看目标必须为80到100之间的整数');
      }
      if (job && isRetiredInstance(job, tabId, msg.instanceId)) return job;
      if (job && msg.runId && (msg.runId !== job.runId || msg.generation !== job.generation)) {
        throw new Error('TASK_CANCELLED');
      }
      const currentTab = await chrome.tabs.get(tabId);
      if (!isSite({ ...sender, url: currentTab.url })) throw new Error('当前标签已离开网站，请在网站页面重新开始');
      const page = route({ url: currentTab.url });
      const requestedAll = msg.scope === 'all';
      const restart = msg.restart === true || (page === 'agent' &&
        ['paused', 'manual'].includes(job?.phase) && job.ownerTabId === tabId &&
        !['entry-home', 'go-agent'].includes(job.resumePhase));
      if (restart && !requestedAll && !['agent', 'home'].includes(page)) throw new Error('请在首页或课表重新开始');
      if (job?.running) return job;
      const resetFromHome = job?.phase === 'idle';
      const currentResetEpoch = resetEpoch(job);
      const resetHoldTabIds = job?.resetHoldTabIds || [];
      const recovered = recoveryRecords(job);
      if (!restart && (!msg.workflow || job?.workflow === msg.workflow) && job && ['paused', 'manual'].includes(job.phase) &&
        taskTabIds(job).includes(tabId)) {
        let ownerExists = true;
        await chrome.tabs.get(job.ownerTabId).catch(() => { ownerExists = false; });
        if (!ownerExists) {
          if (!requestedAll && !['agent', 'home'].includes(page)) throw new Error('任务页面已关闭，请回到首页重新开始');
          job = null;
        }
      }
      if (!restart && (!msg.workflow || job?.workflow === msg.workflow) && job && ['paused', 'manual'].includes(job.phase) &&
        taskTabIds(job).includes(tabId)) {
        const continuingManualStop = job.phase === 'manual';
        if (outerResume && job.outer?.id === msg.roundId) { job.outer.state = 'active'; delete job.outer.reason; }
        if (msg.singlePass === true) job.singlePass = true;
        if (job.singlePass) {
          job.targetPercent = msg.targetPercent ?? job.targetPercent ?? 100;
        }
        const resume = job.resumePhase;
        let needsCourseNavigation = false;
        // Opening is retried from the homepage, never by adopting a similarly named old tab.
        if (resume === 'go-agent') {
          if (tabId !== job.homeTabId) throw new Error('请回到原任务标签页继续');
          job.phase = page === 'agent' ? 'entry-home' : page === 'home' ? 'scan-home' : 'go-agent';
          job.ownerTabId = job.homeTabId;
          if (job.phase === 'entry-home') {
            job.entryClicked = false;
            job.entryDeadline = Date.now() + 45000;
            delete job.agentDeadline;
            delete job.agentDepartureInstance;
          } else if (job.phase === 'scan-home') {
            delete job.agentDeadline;
            delete job.agentDepartureInstance;
          }
        } else if (resume === 'entry-home') {
          if (tabId !== job.homeTabId || !['agent', 'home'].includes(page)) {
            throw new Error('请回到原首页或课表继续');
          }
          job.phase = page === 'agent' ? 'entry-home' : 'scan-home';
          job.ownerTabId = job.homeTabId;
          if (page === 'agent') {
            job.entryClicked = false;
            job.entryDeadline = Date.now() + 45000;
          } else {
            delete job.entryClicked;
            delete job.entryDeadline;
          }
        } else if (resume === 'opening') {
          if (job.workerTabId != null) {
            await chrome.tabs.get(job.workerTabId).catch(() => { job.workerTabId = null; });
          }
          if (job.workerTabId === job.homeTabId && job.targetPurpose === 'play') {
            const candidate = job.candidates[job.targetIndex];
            verifiedLearnUrl(candidate);
            const currentTab = await chrome.tabs.get(job.homeTabId);
            const current = { url: currentTab.url };
            if (route(current) === 'home') needsCourseNavigation = true;
            else if (route(current) !== 'learn' || courseKey(current) !== candidate.courseKey) {
              throw new Error('当前课程或教学班与任务不符，请回到首页重新开始');
            }
            job.phase = 'opening';
            job.ownerTabId = job.homeTabId;
          } else if (job.workerTabId != null) job.phase = 'opening';
          else if (job.targetPurpose === 'inspect') {
            job.phase = 'opening';
            job.ownerTabId = job.homeTabId;
            job.openDeadline = Date.now() + 45000;
            job.openRecovery = {
              key: `openDeadline:${job.targetIndex ?? ''}:`,
              attempts: Number(job.openRecovery?.attempts) || 0,
              nextRetryAt: Date.now(),
              token: `${job.runId}:${job.targetIndex}:continue:${Date.now()}`
            };
          } else {
            job.phase = 'home';
            job.ownerTabId = job.homeTabId;
            job.targetIndex = null;
          }
        } else job.phase = resume;
        if (job.phase === 'course') {
          let worker;
          try { worker = await chrome.tabs.get(job.ownerTabId); } catch {}
          const candidate = job.candidates?.[job.targetIndex];
          const resource = candidate?.currentResource;
          const currentRoute = routeDiagnostic(worker?.url);
          const expectedCourse = candidate
            ? `${candidate.title || candidate.courseKey} (${candidate.courseKey || '课程身份未保存'})`
            : '课程身份未保存';
          const details = [
            `当前任务页=${currentRoute}`,
            `页面标题=${String(worker?.title || '无标题').slice(0, 80)}`,
            `预期课程=${String(expectedCourse).slice(0, 120)}`,
            `预期资源=${String(resource?.title || '未保存').slice(0, 100)}`,
            `预期路由=${resource?.routeKey ? routeDiagnostic(new URL(resource.routeKey, routeParser.SITE_ORIGIN).href) : '未保存'}`
          ].join('；');
          const blocked = tabId === job.ownerTabId ? pageBlockingReason(msg) : '';
          const validWorker = worker?.url && route({ url: worker.url }) === 'learn' &&
            courseKey({ url: worker.url }) === candidate?.courseKey;
          if (!validWorker || blocked) {
            const reason = blocked
              ? `${blocked}；继续前路由核对未通过，原课程断点已保留。${details}`
              : `继续前路由核对未通过，原课程断点已保留；请先确认学习页和登录状态。${details}`;
            addLog(job, `继续操作未执行：${details}${blocked ? `；页面提示=${blocked}` : ''}`, 'err');
            return save(pause(job, reason, Boolean(blocked)));
          }
          if (!job.singlePass) resetAttempt(job.candidates[job.targetIndex]);
        } else await chrome.tabs.get(job.ownerTabId);
        job.running = true;
        // An explicit Continue after a manual stop starts a fresh recovery
        // episode. A user Pause/Continue preserves the current failure budget.
        if (continuingManualStop) delete job.interruption;
        job.generation += 1;
        bindOwnerInstance(job, job.ownerTabId,
          job.phase === 'opening' && job.workerTabId === job.homeTabId
            ? null : job.ownerTabId === tabId ? msg.instanceId : null);
        if (tabId === job.homeTabId && ['agent', 'home'].includes(page)) bindHomeInstance(job, msg.instanceId);
        if (job.phase === 'opening') job.openDeadline = Date.now() + 45000;
        delete job.reason;
        addLog(job, '继续自动任务；先核对当前页面和目录');
        if (Number.isInteger(job.returningTabId)) {
          const currentTab = await chrome.tabs.get(job.homeTabId);
          if (job.returningTabId === job.homeTabId && route({ url: currentTab.url }) === 'home') {
            if (tabId !== job.homeTabId || route(sender) !== 'home') {
              bindOwnerInstance(job, job.ownerTabId, null);
              bindHomeInstance(job, null);
              job.returnDeadline = Date.now() + 45000;
              return save(job);
            }
            delete job.returningTabId;
            delete job.returnDeadline;
            bindOwnerInstance(job, job.ownerTabId, msg.instanceId);
            return save(job);
          }
          if (job.phase === 'scan-home' || (job.outer?.state === 'active' && job.phase === 'home')) return goHomeToScan(job);
          return save(pause(job, '旧跨课返回任务已停止；学习页和记录已保留，请手动选择课程。', true));
        }
        await save(job);
        if (job.phase === 'go-agent') return goAgentToStart(job, msg.instanceId);
        if (needsCourseNavigation) return navigateToCourse(job);
        if (canOperate(job)) await chrome.tabs.update(job.ownerTabId, { active: true });
        return job;
      }
      if (!requestedAll && !['agent', 'home', 'learn'].includes(page)) {
        throw new Error('请先进入首页、课表或课程学习页');
      }
      const key = courseKey({ url: currentTab.url });
      if (!requestedAll && !resetFromHome && page === 'learn' && (!key || !msg.title)) {
        throw new Error('当前课程身份未识别');
      }
      const manualWorkflow = msg.workflow === 'manual' || requestedAll ||
        ['agent', 'home'].includes(page) || resetFromHome;
      const cachedCourses = manualWorkflow ? copy(job?.candidates || []) : [];
      const allCourses = manualWorkflow;
      const enteringHome = page === 'agent';
      const navigateToAgent = requestedAll && !['agent', 'home'].includes(page);
      const navigateFromLearn = !requestedAll && resetFromHome && page === 'learn';
      job = {
        version: 3, runId: crypto.randomUUID(), generation: 1, revision: 0,
        resetEpoch: currentResetEpoch, resetHoldTabIds,
        startRequest: { runId: msg.runId || null, generation: msg.generation ?? null,
          instanceId: msg.instanceId, tabId },
        running: true, scope: allCourses ? 'all' : 'single',
        ...(manualWorkflow ? { workflow: 'manual', operation: 'list', selectedIndex: null, cachedCourses } : {}),
        ...(msg.singlePass === true
          ? { singlePass: true, targetPercent: msg.targetPercent ?? 100 } : {}),
        phase: navigateToAgent ? 'go-agent' : enteringHome ? 'entry-home' : allCourses ? 'scan-home' : 'course',
        ...(enteringHome ? { entryClicked: false, entryDeadline: Date.now() + 45000 } : {}),
        homeTabId: tabId, homeInstance: navigateFromLearn || navigateToAgent ? null : msg.instanceId,
        ownerTabId: tabId, ownerInstance: navigateFromLearn || navigateToAgent ? null : msg.instanceId,
        workerTabId: allCourses ? null : tabId, createdTabIds: [],
        retiredInstances: [],
        candidates: allCourses ? [] : [{
          title: msg.title, key, courseKey: key, learnUrl: currentTab.url,
          status: 'inspected', records: retryRecords(recovered[key])
        }],
        recoveryRecords: recovered,
        inspectIndex: allCourses ? 0 : 1,
        targetIndex: allCourses ? null : 0, targetPurpose: allCourses ? '' : 'play',
        logs: [], startedAt: Date.now()
      };
      if (msg.outerRequested === true) {
        job.outer = { version: 1, id: crypto.randomUUID(), state: 'active', createdAt: Date.now(),
          scopeConfirmed: false, entries: [], cursor: 0 };
      }
      if (!allCourses) delete job.recoveryRecords[key];
      if (restart) addLog(job, '重新开始：重新扫描首页，保留同一课程和教学班的未完成音视频记录。');
      if (navigateToAgent) addLog(job, '开始：正在进入网站首页');
      if (enteringHome) addLog(job, '开始：正在进入全部课表');
      addLog(job, allCourses
        ? '获取课程列表：完成后等待用户选择，不进入课程。'
        : '开始：只处理当前课程的音视频。');
      if (navigateFromLearn) return goHomeToScan(job);
      if (navigateToAgent) return goAgentToStart(job, msg.instanceId);
      return save(job);
    }
    if (msg.action === 'entry-open') {
      requireOwner(job, msg, sender, ['entry-home']);
      const currentTab = await chrome.tabs.get(tabId);
      if (!canOperate(job) || !isSite({ ...sender, url: currentTab.url }) ||
        route({ url: currentTab.url }) !== 'agent' || job.entryClicked) {
        throw new Error('TASK_CANCELLED');
      }
      job.entryClicked = true;
      job.entryAttempted = true;
      return save(job);
    }
    if (msg.action === 'scan-result') {
      requireOwner(job, msg, sender, ['scan-home']);
      if (job.workflow !== 'manual') throw new Error('课程列表仅供手动选择课程，请重新获取课程列表。');
      job.candidates = msg.candidates.map(candidate => {
        const next = {
          ...candidate, status: 'uninspected', remaining: null, records: {}
        };
        // A title on the homepage is not evidence of a course or teaching-class ID.
        delete next.courseKey;
        delete next.learnUrl;
        delete next.directory;
        delete next.currentResource;
        return next;
      });
      job.inspectIndex = job.candidates.findIndex(candidate => candidate.status !== 'completed');
      if (job.inspectIndex < 0) job.inspectIndex = job.candidates.length;
      job.phase = 'home';
      addLog(job, `首页扫描完成：${job.candidates.length} 门正在上的课程，等待用户选择。`);
      if (job.workflow === 'manual') {
        const cached = new Map((job.cachedCourses || []).map(c => [c.key, c]));
        job.candidates = job.candidates.map(candidate => {
          const old = cached.get(candidate.key);
          // The homepage exposes titles, not course IDs. Keep results as
          // reference, but re-enter via the card to verify identity again.
          if (!old) return candidate;
          const next = { ...old, ...candidate, records: old.records || {},
            directory: old.directory, total: old.total, remaining: old.remaining,
            scannedAt: old.scannedAt, scanState: old.scannedAt ? 'stale' : 'uninspected',
            status: old.status };
          delete next.courseKey; delete next.learnUrl; delete next.scanDraft;
          return next;
        });
        delete job.cachedCourses;
        job.listScannedAt = Date.now();
        awaitSelection(job, '课程列表已获取，请选择一门课扫描目录。');
        if (job.outer?.state === 'active' && !job.outer.scopeConfirmed) outerCreate(job);
        return save(job);
      }
      return save(job);
    }
    if (msg.action === 'open') {
      requireOwner(job, msg, sender, ['home', 'course']);
      const candidate = job.candidates[msg.index];
      if (!candidate) throw new Error('课程选择失效，请重新扫描');
      if (!['inspect', 'play'].includes(msg.purpose)) throw new Error('课程操作类型无法确认');
      if (job.workflow === 'manual' && (msg.index !== job.selectedIndex || msg.purpose !== job.operation)) {
        throw new Error('未授权此课程操作，请先选择课程');
      }
      if (job.singlePass && msg.purpose === 'play' && candidate.finalPass === true) {
        throw new Error('此课程本轮已处理，未完成项已保留提醒');
      }
      const singleRetry = job.scope === 'single' && job.phase === 'course' &&
        msg.index === job.targetIndex && candidate.status === 'retry' && msg.purpose === 'play';
      if (job.workflow !== 'manual' && !singleRetry) {
        throw new Error('单课任务只能重试当前课程，请手动选择其他课程。');
      }
      if (job.phase === 'course' && !singleRetry) throw new Error('TASK_CANCELLED');
      if (candidate.status === 'retry') {
        if (msg.purpose !== 'play' || !Number.isFinite(candidate.retryAt) || Date.now() < candidate.retryAt) {
          throw new Error('课程仍在等待自动重试');
        }
        if (singleRetry) {
          const currentTab = await chrome.tabs.get(tabId);
          requireOwner(job, msg, sender, ['course']);
          const currentPage = { ...sender, url: currentTab.url };
          if (!isSite(currentPage) || route(currentPage) !== 'learn' ||
            courseKey(currentPage) !== candidate.courseKey) throw new Error('当前课程或教学班已改变，不能重试');
          prepareRetry(candidate);
          const previousGeneration = job.generation;
          job.generation += 1;
          addLog(job, `正在重试未完成的音视频：${candidate.title}`);
          return saveOwnerHandoff(job, previousGeneration);
        }
        prepareRetry(candidate);
      }
      if (msg.purpose === 'play') verifiedLearnUrl(candidate);
      job.targetIndex = msg.index;
      job.targetPurpose = msg.purpose;
      job.phase = 'opening';
      delete job.navigationRecovery;
      delete job.openRecovery;
      job.openDeadline = Date.now() + 45000;
      job.pendingOpenTabIds = [];
      delete job.pendingOpenTabWaits;
      if (msg.purpose === 'inspect') await prepareInspectionOpen(job);
      job.workerTabId = msg.purpose === 'play' ? job.homeTabId : null;
      bindOwnerInstance(job, job.ownerTabId, msg.purpose === 'play' ? null : msg.instanceId);
      addLog(job, msg.purpose === 'inspect'
        ? `正在统计：${candidate.title}`
        : `按课表顺序处理课程：${candidate.title}（${candidate.remaining} 项待确认）`);
      await save(job);
      if (msg.purpose === 'play') return navigateToCourse(job);
      return job;
    }
    if (msg.action === 'open-attempt') {
      requireOwner(job, msg, sender, ['opening']);
      if (job.targetPurpose !== 'inspect' || job.workerTabId != null ||
        job.pendingOpenTabIds?.length) throw new Error('TASK_CANCELLED');
      const openingTab = await chrome.tabs.get(job.homeTabId);
      if (!canOperate(job) || route({ url: openingTab.url }) !== 'home') throw new Error('TASK_CANCELLED');
      await findUnclaimedInspectionTabs(job);
      if (!canOperate(job)) throw new Error('TASK_CANCELLED');
      if (job.pendingOpenTabIds?.length) {
        await save(job);
        throw new Error('TASK_CANCELLED');
      }
      job.openIssuedAt = Date.now();
      job.openWindowId = openingTab.windowId;
      job.openDeadline = Date.now() + 45000;
      job.pendingOpenTabWaits = 0;
      return save(job);
    }
    if (msg.action === 'interruption-attempt') {
      requireOwner(job, msg, sender, ['course']);
      return attemptInterruption(job, msg, sender);
    }
    if (msg.action === 'interruption-failed') {
      requireOwner(job, msg, sender, ['course']);
      const episode = job.interruption;
      if (!episode || msg.episodeId !== episode.id) throw new Error('TASK_CANCELLED');
      const blocked = pageBlockingReason(msg);
      if (blocked) return save(interruptionStop(job, blocked));
      clearNetworkRetryAlarm();
      episode.reason = String(msg.reason || episode.reason || '本次恢复未成功').slice(0, 400);
      if (episode.kind !== 'network' && typeof msg.kind === 'string') episode.kind = msg.kind.slice(0, 40);
      episode.status = 'failed';
      delete episode.deadline;
      if (episode.kind === 'network' && episode.navigationAttempt > 0) {
        return pauseAfterNetworkRecovery(job);
      }
      if (episode.attempts >= 3) {
        if (episode.kind === 'network') return pauseAfterNetworkRecovery(job);
        return save(outerLocalFailure(job, `连续三次恢复仍未成功，已停止任务并保留断点：${episode.reason}`));
      }
      return save(job);
    }
    if (msg.action === 'interruption-gap') {
      requireOwner(job, msg, sender, ['course']);
      const episode = job.interruption;
      if (!episode || msg.episodeId !== episode.id) throw new Error('TASK_CANCELLED');
      const candidate = job.candidates[job.targetIndex];
      const key = episode.key || candidate.currentResource?.key;
      if (!key || msg.key !== key) throw new Error('恢复资源与当前任务不符');
      const evidence = msg.gapEvidence;
      const resource = candidate.currentResource;
      const sample = episode.positionSample || resource?.positionSample;
      if (!resource || resource.key !== key || resource.stage !== 'ready' ||
        !evidence || evidence.courseKey !== candidate.courseKey || evidence.key !== key ||
        typeof evidence.routeKey !== 'string' || !routeEquals(evidence.routeKey, resource.routeKey) ||
        !Number.isFinite(evidence.from) || !Number.isFinite(evidence.to) ||
        evidence.to <= evidence.from || (sample && Math.abs(evidence.from - sample.position) > 0.01)) {
        throw new Error('未观看区间证据无法确认');
      }
      const currentTab = await chrome.tabs.get(tabId);
      requireOwner(job, msg, sender, ['course']);
      const page = { ...sender, url: currentTab.url };
      const liveUrl = new URL(currentTab.url);
      if (!isSite(page) || route(page) !== 'learn' || courseKey(page) !== candidate.courseKey ||
        !routeEquals(`${liveUrl.pathname}${liveUrl.hash}`, resource.routeKey)) {
        throw new Error('未观看区间页面无法确认');
      }
      preserveStopGap(job, { ...msg, gapEvidence: msg.gapEvidence }, tabId);
      const record = candidate.records?.[key];
      if (!record?.progressGap) throw new Error('未能保存恢复后的未观看区间');
      addLog(job, `恢复后发现未观看区间：${Math.floor(record.progressGap.from)}-${Math.ceil(record.progressGap.to)} 秒，继续从区间起点核对`, 'warn');
      return save(job);
    }
    if (msg.action === 'interruption-success') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      const episode = job.interruption;
      if (!episode || msg.episodeId !== episode.id || episode.courseKey !== candidate.courseKey) {
        throw new Error('TASK_CANCELLED');
      }
      const blocked = pageBlockingReason(msg);
      if (blocked) return save(interruptionStop(job, blocked));
      clearNetworkRetryAlarm();
      const currentTab = await chrome.tabs.get(tabId);
      requireOwner(job, msg, sender, ['course']);
      const current = { ...sender, url: currentTab.url };
      if (!isSite(current) || route(current) !== 'learn' || courseKey(current) !== candidate.courseKey) {
        throw new Error('恢复后的课程或教学班尚未确认');
      }
      const resource = candidate.currentResource;
      const key = episode.key || resource?.key;
      const record = candidate.records?.[key];
      const item = candidate.directory?.items?.find(entry => entry.key === key &&
        ['video', 'audio', 'media'].includes(entry.mediaType));
      if (!key || msg.key !== key || !item || record?.progressGap) {
        throw new Error('恢复后的音视频目标或未观看区间尚未确认');
      }
      if (msg.pageConfirmed === true && !(record?.ended === true && record.confirmed === true)) {
        throw new Error('页面标记不能代替自然播放结束及平台完成确认');
      }
      if (!(record?.ended === true && record.confirmed === true)) {
        if (episode.requiresContinuityCheck === true && !episode.continuityChecked) {
          throw new Error('恢复后的播放位置尚未核对');
        }
        const evidence = msg.evidence;
        const url = new URL(currentTab.url);
        if (!resource || resource.key !== key || resource.stage !== 'ready' || !resource.routeKey ||
          !evidence || evidence.courseKey !== candidate.courseKey || evidence.key !== key ||
          typeof evidence.routeKey !== 'string' || !routeEquals(evidence.routeKey, resource.routeKey) ||
          !routeEquals(`${url.pathname}${url.hash}`, resource.routeKey) ||
          !Number.isFinite(evidence.from) || evidence.from < 0 ||
          !Number.isFinite(evidence.to) || !Number.isFinite(evidence.elapsedMs) ||
          evidence.elapsedMs < 8000 || evidence.to - evidence.from < 5 ||
          evidence.to - evidence.from > evidence.elapsedMs / 1000 + 2) {
          throw new Error('恢复后尚未持续正常播放，保留本次重试次数');
        }
      }
      delete job.interruption;
      addLog(job, msg.pageConfirmed === true
        ? '已核对原音视频的自然结束和平台确认，本次恢复次数已清零'
        : '已恢复正常播放，本次恢复次数已清零', 'ok',
        { eventCode: 'recovery-verified', resourceKey: key });
      return save(job);
    }
    if (msg.action === 'directory-checkpoint') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      if (courseKey(sender) !== candidate.courseKey) throw courseIdentityError(msg, candidate, sender, 'sender.url');
      const snapshot = validateDirectorySnapshot(msg.snapshot, candidate.courseKey);
      const fresh = new Map(snapshot.items.map(item => [item.key, item]));
      if (!(job.workflow === 'manual' && job.operation === 'inspect') && candidate.directory?.items?.some(item => {
        const found = fresh.get(item.key);
        return !found || found.title !== item.title || found.mediaType !== item.mediaType;
      })) throw new Error('课程目录缺少已保存的条目，已停止；请确认目录完整后继续');
      if (job.workflow === 'manual' && job.operation === 'inspect') candidate.scanDraft = snapshot;
      else {
        const changed = snapshot.items.filter(item => item.mediaType === 'document' &&
          candidate.directory?.items?.some(old => old.key === item.key && old.documentReason !== item.documentReason));
        if (changed.length) addLog(job, `文档任务标记变化，已重新核对 ${changed.length} 项`, 'info',
          { eventCode: 'document-state-observed', resourceKey: '', evidence: { count: changed.length } });
        candidate.directory = snapshot;
      }
      return save(job);
    }
    if (msg.action === 'course-pass') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      if (!job.singlePass || courseKey(sender) !== candidate.courseKey ||
        !['play', 'verify', 'retry'].includes(msg.phase)) {
        throw new Error('课程核对阶段无法确认');
      }
      const pendingKeys = msg.pendingKeys ?? candidate.pass?.pendingKeys ?? [];
      const mediaKeys = new Set((candidate.directory?.items || [])
        .filter(item => ['video', 'audio', 'media'].includes(item.mediaType)).map(item => item.key));
      if (!Array.isArray(pendingKeys) || pendingKeys.some(key =>
        typeof key !== 'string' || !mediaKeys.has(key))) {
        throw new Error('待核对音视频不在已保存的课程目录中');
      }
      candidate.pass = { phase: msg.phase, pendingKeys: [...new Set(pendingKeys)] };
      return save(job);
    }
    if (msg.action === 'document-visited') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      const item = candidate.directory?.items?.find(entry =>
        entry.key === msg.key && entry.mediaType === 'document' &&
        (entry.taskItem === true || msg.stage === 'result' && entry.taskItem == null));
      if (!job.singlePass || courseKey(sender) !== candidate.courseKey || !item) {
        throw new Error('文档访问记录不在已保存的课程目录中');
      }
      candidate.records ||= {};
      const previous = candidate.records[msg.key] || {};
      if (msg.stage != null) {
        if (!['attempt', 'result'].includes(msg.stage) || typeof msg.attemptId !== 'string' ||
          !msg.attemptId.trim() || msg.attemptId.length > 120) throw new Error('文档访问尝试无法确认');
        const currentTab = await chrome.tabs.get(tabId);
        requireOwner(job, msg, sender, ['course']);
        if (courseKey({ url: currentTab.url }) !== candidate.courseKey || route({ url: currentTab.url }) !== 'learn') {
          throw new Error('文档访问时当前课程身份已改变');
        }
        const priorAccess = previous.documentAccess;
        if (msg.stage === 'attempt') {
          if (priorAccess?.attemptId === msg.attemptId) return job;
          if (priorAccess?.generation === job.generation) throw new Error('本轮文档已有访问尝试，不重复点击');
          delete candidate.currentResource;
          candidate.records[msg.key] = { ...previous, title: item.title, documentAccess: {
            attemptId: msg.attemptId, generation: job.generation
          } };
          addLog(job, `正在尝试访问文档：${item.title}`, 'info',
            { eventCode: 'document-access-attempt', resourceKey: msg.key });
        } else {
          if (priorAccess?.attemptId !== msg.attemptId || priorAccess.generation !== job.generation ||
            !['selected', 'unconfirmed'].includes(msg.response) || !['failed', 'unknown'].includes(msg.preview)) {
            throw new Error('文档访问响应与本次尝试不符');
          }
          if (priorAccess.response) return job;
          candidate.records[msg.key] = { ...previous, title: item.title,
            ...(msg.response === 'selected' ? { visited: true } : {}),
            documentAccess: { ...priorAccess, response: msg.response, preview: msg.preview } };
          addLog(job, msg.response === 'selected'
            ? `已核实文档目标访问，完成仍以平台标记为准：${item.title}`
            : `文档点击结果未确认，留待课末核对：${item.title}`, 'info',
          { eventCode: msg.response === 'selected' ? 'document-visited' : 'document-access-unconfirmed',
            resourceKey: msg.key, evidence: { response: msg.response, preview: msg.preview } });
          addLog(job, `文档预览${msg.preview === 'failed' ? '失败' : '结果未知'}：${item.title}`, 'info',
            { eventCode: 'document-preview', resourceKey: msg.key,
              evidence: { preview: msg.preview } });
        }
        return save(job);
      }
      candidate.records[msg.key] = { ...previous, title: item.title, visited: true };
      if (!previous.visited) addLog(job, `已访问文档，完成状态仍以平台标记为准：${item.title}`, 'info',
        { eventCode: 'document-visited', resourceKey: msg.key });
      return save(job);
    }
    if (msg.action === 'resource-retry') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      const item = candidate.directory?.items?.find(entry => entry.key === msg.key &&
        ['video', 'audio', 'media'].includes(entry.mediaType));
      if (!job.singlePass || courseKey(sender) !== candidate.courseKey || !item ||
        !['recovery', 'final'].includes(msg.phase) ||
        typeof msg.token !== 'string' || !msg.token.trim() || msg.token.length > 200) {
        throw new Error('音视频重试目标无法确认');
      }
      if (candidate.records?.[msg.key]?.confirmed === true) {
        throw new Error('此音视频已核对为完成，不能重试');
      }
      candidate.records ||= {};
      const previousRecord = candidate.records[msg.key] ? copy(candidate.records[msg.key]) : null;
      const previousInterruption = job.interruption ? copy(job.interruption) : null;
      const record = candidate.records[msg.key] ||= { title: item.title, attempted: true };
      const tokens = record.retryTokens?.[msg.phase] || [];
      if (tokens.includes(msg.token)) return job;
      const field = msg.phase === 'recovery' ? 'recoveryAttempts' : 'finalAttempts';
      const attempts = nonnegativeInteger(record[field]) ? record[field] : 0;
      if (attempts >= 3) throw new Error('此项音视频的本轮三次重试已用完');
      record[field] = attempts + 1;
      record.retryTokens = { ...record.retryTokens, [msg.phase]: [...tokens, msg.token] };
      record.ended = false;
      record.effectiveTarget = 100;
      record.targetReached = false;
      record.deferred = false;
      delete record.error;
      record.lastRetryReason = String(msg.reason || '音视频尚未确认完成').slice(0, 400);
      if (job.interruption?.courseKey === candidate.courseKey && job.interruption.key === msg.key) {
        delete job.interruption;
      }
      await save(job);
      if (!canOperate(job)) {
        if (previousRecord) candidate.records[msg.key] = previousRecord;
        else delete candidate.records[msg.key];
        if (previousInterruption) job.interruption = previousInterruption;
        await save(job);
        return job;
      }
      addLog(job, `重试（${record[field]}/3）：${candidate.title} / ${item.title}`);
      return save(job);
    }
    if (msg.action === 'course-refresh') {
      requireOwner(job, msg, sender, ['course']);
      if (job.interruption?.kind === 'network' && job.interruption.navigationAttempt > 0) {
        return pauseAfterNetworkRecovery(job);
      }
      const candidate = job.candidates[job.targetIndex];
      const expectedAttempt = candidate.lastRefresh?.failed
        ? (candidate.lastRefresh.attempt || 1) + 1 : 1;
      const attempt = msg.attempt ?? expectedAttempt;
      if (!job.singlePass || typeof msg.token !== 'string' || !msg.token.trim() ||
        msg.token.length > 200 || !Number.isInteger(attempt) || attempt !== expectedAttempt ||
        attempt > 2 || (msg.key != null && !candidate.directory?.items?.some(item =>
          item.key === msg.key && ['video', 'audio', 'media'].includes(item.mediaType)))) {
        throw new Error('课程刷新检查点无法确认');
      }
      if (candidate.refreshTokens?.includes(msg.token)) return job;
      if (msg.key != null) {
        const tokens = candidate.records?.[msg.key]?.retryTokens;
        if (![...(tokens?.recovery || []), ...(tokens?.final || [])].includes(msg.token)) {
          throw new Error('本次刷新尚未保存音视频重试次数');
        }
      }
      const validTab = tab => {
        const currentPage = { url: tab.url };
        return isSite({ ...sender, url: tab.url }) && route(currentPage) === 'learn' &&
          courseKey(currentPage) === candidate.courseKey &&
          (!candidate.currentResource?.routeKey || routeEquals(
            `${new URL(tab.url).pathname}${new URL(tab.url).hash}`, candidate.currentResource.routeKey));
      };
      const currentTab = await chrome.tabs.get(tabId);
      requireOwner(job, msg, sender, ['course']);
      if (!validTab(currentTab)) throw new Error('当前课程或资源已改变，未刷新');
      const previousRefreshTokens = [...(candidate.refreshTokens || [])];
      const previousLastRefresh = candidate.lastRefresh ? copy(candidate.lastRefresh) : null;
      candidate.refreshTokens = [...previousRefreshTokens, msg.token];
      candidate.lastRefresh = {
        token: msg.token, key: msg.key || '', attempt, phase: candidate.pass?.phase || 'play',
        reason: String(msg.reason || '刷新后核对网站显示状态').slice(0, 400)
      };
      if (job.workflow === 'manual') job.expectedRefresh = { token: msg.token, tabId,
        courseKey: candidate.courseKey, generation: job.generation, expiresAt: Date.now() + 45000 };
      addLog(job, '正在刷新课程页面，已保留当前核对阶段和重试次数', 'info',
        { eventCode: 'course-refresh' });
      await save(job);
      if (!canOperate(job)) {
        candidate.refreshTokens = previousRefreshTokens;
        if (previousLastRefresh) candidate.lastRefresh = previousLastRefresh;
        else delete candidate.lastRefresh;
        await save(job);
        return job;
      }
      const latestTab = await chrome.tabs.get(tabId);
      if (!canOperate(job)) return job;
      requireOwner(job, msg, sender, ['course']);
      if (!validTab(latestTab)) throw new Error('当前课程或资源已改变，未刷新');
      try { await chrome.tabs.reload(tabId); }
      catch {
        requireOwner(job, msg, sender, ['course']);
        delete job.expectedRefresh;
        candidate.lastRefresh.failed = true;
        addLog(job, '课程页面暂时无法刷新，已保留具体音视频和重试次数', 'err');
        await save(job);
      }
      return job;
    }
    if (msg.action === 'resource-checkpoint') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      if (courseKey(sender) !== candidate.courseKey) throw courseIdentityError(msg, candidate, sender, 'sender.url');
      if (typeof msg.key !== 'string' || !msg.key.trim() ||
        typeof msg.title !== 'string' || !msg.title.trim() ||
        !['opening', 'ready'].includes(msg.stage) || typeof msg.routeKey !== 'string') {
        throw new Error('音视频断点数据格式无法确认');
      }
      const matching = candidate.directory?.items?.filter(item =>
        item.key === msg.key && item.title === msg.title &&
        ['video', 'audio', 'media'].includes(item.mediaType)) || [];
      if (matching.length !== 1 || (!job.singlePass && candidate.records?.[msg.key]?.ended)) {
        throw new Error('音视频断点目标在当前目录无法确认');
      }
      let currentTab;
      try {
        // The sender document URL can retain its entry route while a SPA changes hash.
        // Read the task tab's observed browser URL; this does not navigate or call the site.
        currentTab = await chrome.tabs.get(sender.tab.id);
      } catch {
        requireOwner(job, msg, sender, ['course']);
        throw new Error('当前任务标签页无法读取，音视频断点未保存');
      }
      requireOwner(job, msg, sender, ['course']);
      let url;
      try { url = new URL(currentTab.url); }
      catch { throw new Error('当前任务标签页网址无法确认，音视频断点未保存'); }
      const currentPage = { url: url.href };
      if (url.origin !== 'https://www.beeline-ai.com' || url.username || url.password ||
        !url.pathname.startsWith('/student/') || route(currentPage) !== 'learn' ||
        courseKey(currentPage) !== candidate.courseKey) {
        throw new Error('当前任务标签页课程或教学班已改变，音视频断点未保存');
      }
      const routeKey = `${url.pathname}${url.hash}`;
      const priorRoute = candidate.currentResource?.key === msg.key
        ? candidate.currentResource.routeKey : '';
      const validRoute = msg.stage === 'opening'
        ? priorRoute ? routeEquals(msg.routeKey, priorRoute) : msg.routeKey === '' || routeEquals(msg.routeKey, routeKey)
        : routeEquals(msg.routeKey, routeKey) && (!priorRoute || routeEquals(msg.routeKey, priorRoute));
      if (!validRoute) throw new Error('音视频断点路由与当前资源不符，断点未保存');
      if (msg.stage === 'opening') {
        candidate.records ||= {};
        const previous = candidate.records[msg.key];
        candidate.records[msg.key] = {
          ...previous, title: msg.title, attempted: true,
          ended: Boolean(job.singlePass && previous?.ended === true),
          confirmed: previous?.confirmed === true
        };
      }
      candidate.currentResource = {
        key: msg.key, title: msg.title, stage: msg.stage, routeKey: msg.routeKey,
        ...(candidate.currentResource?.key === msg.key &&
          candidate.currentResource.positionSample && msg.stage === 'ready'
          ? { positionSample: candidate.currentResource.positionSample } : {})
      };
      if (job.interruption && !job.interruption.key && job.interruption.courseKey === candidate.courseKey) {
        job.interruption.key = msg.key;
        job.interruption.title = msg.title;
      }
      return save(job);
    }
    if (msg.action === 'media-observation') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      const resource = candidate.currentResource;
      if (candidate.courseKey !== courseKey(sender) || resource?.stage !== 'ready') {
        throw new Error('当前播放资源尚未核对');
      }
      const observed = validateMediaObservation(msg, resource);
      const currentTab = await chrome.tabs.get(tabId);
      requireOwner(job, msg, sender, ['course']);
      const page = { ...sender, url: currentTab.url };
      const url = new URL(currentTab.url);
      if (!isSite(page) || route(page) !== 'learn' || courseKey(page) !== candidate.courseKey ||
        !routeEquals(`${url.pathname}${url.hash}`, observed.routeKey)) {
        throw new Error('当前页面与播放位置观察不符');
      }
      const episode = job.interruption;
      if (episode?.requiresContinuityCheck === true && !episode.continuityChecked) {
        throw new Error('恢复后的播放位置尚未核对');
      }
      const previous = resource.positionSample;
      let gapDetected = false;
      if (previous && observed.time > previous.time &&
        observed.position - previous.position > (observed.time - previous.time) / 1000 + 2) {
        const record = candidate.records?.[resource.key];
        if (!record) throw new Error('播放记录无法确认，位置观察未保存');
        const prior = record.progressGap;
        record.progressGap = {
          from: Math.min(prior?.from ?? previous.position, previous.position),
          to: Math.max(prior?.to ?? observed.position, observed.position)
        };
        record.ended = false;
        record.confirmed = false;
        gapDetected = true;
      }
      if (gapDetected) return save(job);
      return saveObservation(job, candidate, resource, observed);
    }
    if (msg.action === 'interruption-position') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      const episode = job.interruption;
      const resource = candidate.currentResource;
      if (!episode || msg.episodeId !== episode.id || !resource ||
        (episode.key || resource.key) !== msg.key || resource.stage !== 'ready') {
        throw new Error('恢复位置与保存的任务不符');
      }
      const observed = validateMediaObservation({ ...msg, time: Date.now(), allowance: 0 }, resource);
      const currentTab = await chrome.tabs.get(tabId);
      requireOwner(job, msg, sender, ['course']);
      const page = { ...sender, url: currentTab.url };
      const url = new URL(currentTab.url);
      if (!isSite(page) || route(page) !== 'learn' || courseKey(page) !== candidate.courseKey ||
        !routeEquals(`${url.pathname}${url.hash}`, observed.routeKey)) {
        throw new Error('恢复后的页面或资源路由无法确认');
      }
      const sample = episode.positionSample || resource.positionSample;
      if ((sample && observed.position - sample.position > sample.allowance + 2) ||
        (!sample && observed.position > 2)) {
        const record = candidate.records?.[resource.key];
        if (!record) throw new Error('恢复资源播放记录无法确认');
        const prior = record.progressGap;
        const from = sample?.position ?? 0;
        record.progressGap = {
          from: Math.min(prior?.from ?? from, from),
          to: Math.max(prior?.to ?? observed.position, observed.position)
        };
        record.ended = false;
        record.confirmed = false;
        episode.gapDetected = true;
        addLog(job, '恢复页面的播放位置已前跳，已保留未观看区间，需从区间起点自然覆盖', 'warn');
      }
      episode.continuityChecked = true;
      episode.position = observed.position;
      return save(job);
    }
    if (msg.action === 'record-completions') {
      requireOwner(job, msg, sender, ['course']);
      if (!job.singlePass || !Array.isArray(msg.entries) || !msg.entries.length || msg.entries.length > 32 ||
        new Set(msg.entries.map(entry => entry?.key)).size !== msg.entries.length) {
        throw new Error('批量平台状态无法确认');
      }
      const currentTab = await chrome.tabs.get(tabId);
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      if (!isSite({ ...sender, url: currentTab.url }) || route({ url: currentTab.url }) !== 'learn' ||
        courseKey({ url: currentTab.url }) !== candidate.courseKey) {
        throw courseIdentityError(msg, candidate, { url: currentTab.url }, 'tab.url');
      }
      const confirmedCount = msg.entries.filter(entry => candidate.records?.[entry?.key]?.confirmed !== true).length;
      // Validate on the read copy; nothing is persisted until all entries pass.
      for (const entry of msg.entries) {
        const item = candidate.directory?.items?.find(item => item.key === entry?.key);
        const isTaskDocument = item?.mediaType === 'document' && item.taskItem === true;
        if (!entry || !['page-marker', 'site-progress'].includes(entry.completionSource) ||
          !(entry.completionSource === 'page-marker' || entry.sitePercent >= 80) ||
          (isTaskDocument && (entry.completionSource !== 'page-marker' || entry.sitePercent != null))) {
          throw new Error('批量平台完成证据无法确认');
        }
        const previous = candidate.records?.[entry.key] || {};
        applyResourceRecord(job, { ...msg, key: entry.key, result: {
          title: item?.title, confirmed: true, sitePercent: entry.sitePercent,
          completionSource: entry.completionSource, ended: Boolean(previous.ended),
          targetReached: Boolean(previous.targetReached), deferred: false
        } }, sender);
      }
      if (confirmedCount) addLog(job, `平台已确认完成 ${confirmedCount} 项资源`, 'ok',
        { eventCode: 'resource-confirmed', resourceKey: '', evidence: { count: confirmedCount } });
      return save(job);
    }
    if (msg.action === 'record') {
      applyResourceRecord(job, msg, sender);
      return save(job);
    }
    if (msg.action === 'reload-course') {
      requireOwner(job, msg, sender, ['course']);
      if (job.interruption?.kind === 'network' && job.interruption.navigationAttempt > 0) {
        return pauseAfterNetworkRecovery(job);
      }
      const candidate = job.candidates[job.targetIndex];
      const resource = candidate.currentResource;
      const record = candidate.records?.[msg.key];
      const round = recoveryRound(candidate);
      if (typeof msg.key !== 'string' || !resource || resource.key !== msg.key ||
        !record || record.ended || !resource.routeKey || typeof msg.routeKey !== 'string' ||
        !routeEquals(resource.routeKey, msg.routeKey) ||
        (msg.round != null && msg.round !== round) || candidate.status === 'retry') {
        throw new Error('当前音视频恢复目标无法确认，未刷新');
      }
      const validTab = tab => {
        const currentPage = { ...sender, url: tab.url };
        if (!isSite(currentPage) || route(currentPage) !== 'learn' ||
          courseKey(currentPage) !== candidate.courseKey) return false;
        const url = new URL(tab.url);
        return routeEquals(`${url.pathname}${url.hash}`, resource.routeKey);
      };
      const currentTab = await chrome.tabs.get(tabId);
      requireOwner(job, msg, sender, ['course']);
      if (!validTab(currentTab)) throw new Error('当前课程或资源已改变，未刷新');
      const recovery = recordRecovery(candidate, record.recovery, null);
      if (recovery.reloads >= 1) throw new Error('本轮已刷新过学习页，将稍后重试');
      record.recovery = {
        ...recovery, reloads: recovery.reloads + 1,
        lastReason: String(msg.reason || recovery.lastReason || '播放恢复失败').slice(0, 400)
      };
      if (job.workflow === 'manual') job.expectedRefresh = { token: String(Date.now()), tabId,
        courseKey: candidate.courseKey, generation: job.generation, expiresAt: Date.now() + 45000 };
      addLog(job, '正在刷新当前学习页，已保存课程和音视频断点', 'info',
        { eventCode: 'reload-course', resourceKey: msg.key });
      await save(job);
      if (!canOperate(job)) return job;
      // A pause or route change can arrive while the checkpoint is saved.
      // Recheck after persistence before authorizing the one normal reload.
      const latestTab = await chrome.tabs.get(tabId);
      if (!canOperate(job)) return job;
      requireOwner(job, msg, sender, ['course']);
      if (!validTab(latestTab)) throw new Error('当前课程或资源已改变，未刷新');
      try { await chrome.tabs.reload(tabId); }
      catch {
        requireOwner(job, msg, sender, ['course']);
        let afterFailure;
        try { afterFailure = await chrome.tabs.get(tabId); }
        catch { throw new Error('任务学习页已关闭，无法继续恢复'); }
        requireOwner(job, msg, sender, ['course']);
        if (!validTab(afterFailure)) throw new Error('当前课程或资源已改变，未继续恢复');
        delete job.expectedRefresh;
        record.recovery.reloadFailed = true;
        record.recovery.lastReason = '学习页暂时无法刷新，已保留断点，稍后自动重试';
        addLog(job, record.recovery.lastReason);
        await save(job);
        requireOwner(job, msg, sender, ['course']);
      }
      return job;
    }
    if (msg.action === 'course-result') {
      requireOwner(job, msg, sender, ['course']);
      const candidate = job.candidates[job.targetIndex];
      if (courseKey(sender) !== candidate.courseKey) throw courseIdentityError(msg, candidate, sender, 'sender.url');
      const result = msg.result;
      if (!result || !Number.isInteger(result.total) || result.total < 0 ||
        !Number.isInteger(result.remaining) || result.remaining < 0 || result.remaining > result.total) {
        throw new Error('课程音视频数量未确认，不能结束任务');
      }
      const directory = job.workflow === 'manual' && job.operation === 'inspect' ? candidate.scanDraft || candidate.directory : candidate.directory;
      const taskCount = directory?.items?.filter(isCourseTaskItem).length;
      if (!Array.isArray(directory?.items) || (!directory.items.length && job.workflow !== 'manual') || directory.courseKey !== candidate.courseKey ||
        result.total !== taskCount) {
        const error = new Error('课程结果与已保存的完整目录不符，不能标记完成；请核对目录后继续');
        error.details = diagnosticEvidence({ action: msg.action, rule: 'directory-task-count-match',
          count: directory?.items?.length, expectedTotal: taskCount,
          reportedTotal: result.total, reportedRemaining: result.remaining });
        throw error;
      }
      if (job.workflow === 'manual' && job.operation === 'inspect') {
        if (job.selectedIndex !== job.targetIndex) throw new Error('TASK_CANCELLED');
        const oldRecords = candidate.directory?.courseKey === candidate.courseKey ? candidate.records || {} : {};
        const historicalDocuments = Object.entries(oldRecords).filter(([key, record]) => record.confirmed === true &&
          directory.items.some(item => item.key === key && item.mediaType === 'document'));
        candidate.records = { ...Object.fromEntries(historicalDocuments), ...Object.fromEntries(directory.items.filter(isCourseTaskItem).map(item => [item.key, {
          ...oldRecords[item.key], title: item.title, confirmed: item.observedCompleted === true ||
            item.mediaType === 'document' && oldRecords[item.key]?.confirmed === true
        }])) };
        candidate.directory = directory;
        delete candidate.scanDraft;
        candidate.total = result.total;
        candidate.remaining = Math.max(result.remaining, directory.items.filter(item =>
          item.mediaType === 'document' && item.taskItem !== false && item.observedCompleted !== true).length);
        candidate.unfinished = uniqueTexts(result.unfinished || []);
        candidate.failures = []; candidate.unconfirmed = [];
        candidate.status = candidate.remaining === 0 ? 'complete' : 'inspected';
        candidate.scannedAt = Date.now(); candidate.scanState = 'ready';
        delete candidate.scanError;
        if (job.learnAfterScan && candidate.remaining > 0) {
          outerResult(job, candidate, 'directory-scanned', result.total, candidate.remaining);
          const previousGeneration = job.generation;
          job.generation += 1;
          job.operation = 'play'; job.targetPurpose = 'play';
          delete job.learnAfterScan;
          for (const key of ['pass', 'finalPass', 'lastRefresh', 'refreshTokens', 'currentResource', 'retryAt']) delete candidate[key];
          candidate.previousRecords = copy(candidate.records);
          candidate.records = Object.fromEntries(Object.entries(candidate.records).filter(([, record]) => record.confirmed));
          addLog(job, `本课目录已核对，按用户授权开始学习：${candidate.title}`);
          return saveOwnerHandoff(job, previousGeneration);
        }
        const taskItems = directory.items.filter(isCourseTaskItem);
        const videoCount = taskItems.filter(item => item.mediaType !== 'document').length;
        const unknownDocumentCount = taskItems.filter(item => item.mediaType === 'document' && item.taskItem == null).length;
        const pendingDocuments = taskItems.filter(item => item.mediaType === 'document' && item.observedCompleted !== true);
        const platformConfirmedCount = taskItems.filter(item => item.observedCompleted === true &&
          (item.mediaType !== 'document' || item.taskItem === true)).length;
        const platformPendingCount = taskItems.length - platformConfirmedCount;
        const referenceDocumentCount = directory.items.filter(item => item.mediaType === 'document' && item.taskItem === false).length;
        const platformText = unknownDocumentCount
          ? `平台已确认 ${platformConfirmedCount} 项、待确认 ${platformPendingCount} 项；${unknownDocumentCount} 份文档任务标记待核对`
          : `平台已确认 ${platformConfirmedCount}/${result.total} 项、待确认 ${platformPendingCount} 项`;
        const confirmedPending = taskItems.filter(item => !taskConfirmed(item, candidate.records?.[item.key])).length;
        outerResult(job, candidate, result.total === 0 && directory.items.length > 0 ? 'course-no-tasks'
          : confirmedPending === 0 && result.total > 0 ? 'course-completed'
          : 'directory-scanned', result.total, candidate.remaining);
        if (job.outer?.state === 'active' && !job.outer.awaitingStop) {
          // Blank/ambiguous directories and scan-only candidate counts never
          // become successful outer terminal results.
          return save(pause(job, '完整任务完成依据不足，请核对目录；本轮已暂停。', true));
        }
        return save(awaitSelection(job, `本课扫描完成：${candidate.title}，${platformText}；执行待处理 ${candidate.remaining}/${result.total} 项；等待用户选择。`,
          { eventCode: 'directory-scan-summary', resourceKey: '', evidence: {
            count: directory.items.length, videoCount,
            documentCount: taskItems.length - videoCount - unknownDocumentCount,
            unknownDocumentCount, platformConfirmedCount, platformPendingCount, referenceDocumentCount,
            otherCount: directory.items.length - taskItems.length - referenceDocumentCount,
            pendingMediaCount: candidate.remaining - pendingDocuments.length,
            pendingDocumentCount: pendingDocuments.length - unknownDocumentCount
          } }));
      }
      const outstanding = outstandingRecords(candidate, job.singlePass);
      const unverifiedTasks = job.singlePass && job.targetPurpose === 'play'
        ? directory.items.filter(isCourseTaskItem).filter(item =>
          !taskConfirmed(item, candidate.records?.[item.key]))
        : [];
      candidate.total = result.total;
      candidate.unfinished = uniqueTexts([...(result.unfinished || []),
        ...outstanding.filter(record => (record.started || record.attempted) && !record.ended &&
          !(job.singlePass && (record.targetReached || record.deferred || record.confirmed))).map(record => record.title)]);
      candidate.unconfirmed = uniqueTexts([...(result.unconfirmed || []),
        ...outstanding.filter(record => (record.ended || (job.singlePass && record.targetReached)) &&
          !record.confirmed).map(record => record.title),
        ...unverifiedTasks.map(item => item.title)]);
      candidate.failures = uniqueTexts([...(result.failures || []),
        ...outstanding.filter(record => record.error).map(record => `${record.title}：${record.error}`)]);
      candidate.remaining = Math.max(result.remaining, outstanding.length, unverifiedTasks.length,
        candidate.unfinished.length, candidate.unconfirmed.length, candidate.failures.length);
      const complete = candidate.remaining === 0;
      if (job.targetPurpose === 'inspect') {
        candidate.status = complete ? 'complete' : 'inspected';
        job.inspectIndex += 1;
        advanceCompletedInspections(job);
        addLog(job, `已统计 ${candidate.title}：待处理 ${candidate.remaining}/${candidate.total} 个音视频与计任务文档`);
      } else {
        if (job.singlePass) {
          if (result.finalPass !== true && msg.finalPass !== true) {
            throw new Error('课程本轮最终核对尚未完成');
          }
          candidate.finalPass = true;
          candidate.status = complete ? 'completed' : 'manual';
          delete candidate.retryAt;
          if (job.interruption?.courseKey === candidate.courseKey) delete job.interruption;
        } else if (complete) {
          candidate.status = 'completed';
          delete candidate.retryAt;
        } else scheduleCourseRetry(candidate);
        addLog(job, complete
          ? `${candidate.title}：音视频与计任务文档均有平台完成标记`
          : job.singlePass
            ? `${candidate.title}：${candidate.remaining} 个音视频或计任务文档尚未确认完成，已保留具体提醒`
            : `${candidate.title}：${candidate.remaining} 个音视频或计任务文档待重试，稍后自动继续`,
        candidate.remaining ? (job.singlePass ? 'err' : 'warn') : 'ok');
      }
      if (job.workflow === 'manual') {
        if (job.selectedIndex !== job.targetIndex) throw new Error('TASK_CANCELLED');
        candidate.scannedAt = Date.now();
        outerResult(job, candidate, complete ? (result.total ? 'course-completed' : 'course-no-tasks') : 'course-failed', result.total, candidate.remaining);
        return save(awaitSelection(job, `本课处理结束：${candidate.title}；未确认项已保留，请自行选择下一门课程。`));
      }
      if (job.scope === 'single') {
        if (complete || job.singlePass) return finish(job);
        const previousGeneration = job.generation;
        job.generation += 1;
        return saveOwnerHandoff(job, previousGeneration);
      }
      return save(pause(job, '跨课自动调度已移除，请获取课程列表后手动选择一门课程。', true));
    }
    if (msg.action === 'finish') {
      requireOwner(job, msg, sender, ['home']);
      if (job.inspectIndex < job.candidates.length ||
        job.candidates.some(c => {
          if (job.singlePass && c.status === 'manual' && c.finalPass === true) return false;
          return !['complete', 'completed'].includes(c.status) ||
            !Number.isInteger(c.remaining) || c.remaining < 0 ||
            c.remaining !== 0 || outstandingRecords(c, job.singlePass).length;
        })) {
        throw new Error('仍有课程尚未处理');
      }
      return finish(job);
    }
    if (msg.action === 'log') {
      requireOwner(job, msg, sender, ['go-agent', 'entry-home', 'scan-home', 'home', 'opening', 'course']);
      if (!addLog(job, String(msg.text), msg.type, { time: msg.time, id: msg.id,
        source: 'content', eventCode: msg.eventCode, resourceKey: msg.resourceKey,
        evidence: msg.evidence })) return job;
      return saveLog(job);
    }
    throw new Error('自动任务命令未识别');
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.channel !== CHANNEL) return;
    const pendingCancellation = fenceCancellation(msg, sender);
    serial(() => handle(msg, sender)).then(
      job => sendResponse(msg.action === 'export-diagnostics'
        ? { ok: true, diagnostics: job } : { ok: true, job, tabId: sender.tab?.id, power: powerStatus() }),
      error => sendResponse({ ok: false, error: error.message,
        errorCode: error.code || 'TASK_COMMAND_REJECTED',
        ...(error.details ? { errorDetails: diagnosticEvidence(error.details) } : {}),
        ...(msg.action === 'reset' && isSite(sender)
          ? { job: emergencyJob || lastKnownJob, tabId: sender.tab.id } : {}) })
    ).finally(() => {
      if (pendingCancellation) pendingCancellations = pendingCancellations.filter(item => item !== pendingCancellation);
    });
    return true;
  });

  chrome.alarms?.onAlarm?.addListener(alarm => {
    if (alarm?.name === OUTER_ALARM) {
      // One deadline wake-up uses the same supervisor and serial cancellation
      // path. It never samples, opens, refreshes or operates a resource.
      return serial(async () => {
        const job = await read();
        if (job?.outer?.state !== 'active') return;
        const updated = await outerSupervise(job);
        if (updated.outer?.state === 'active' && ['running', 'scan', 'scan-home'].includes(updated.outer.stage?.name)) {
          scheduleOuterCheck(updated, true);
        }
      }).catch(console.error);
    }
    if (alarm?.name !== NETWORK_RETRY_ALARM) return;
    return serial(async () => {
      const job = await read();
      const episode = job?.interruption;
      if (!job?.running || job.phase !== 'course' || episode?.kind !== 'network' ||
        episode.status !== 'navigating') return;
      if (Date.now() < episode.deadline) {
        scheduleNetworkRetryAlarm(episode.deadline);
        return;
      }
      const updated = await expireOpening(job);
      if (updated) await broadcast(updated);
    }).catch(console.error);
  });

  chrome.runtime.onStartup?.addListener(() => {
    serial(async () => {
      const job = await read();
      const episode = job?.interruption;
      if (job?.running && job.phase === 'course' && episode?.kind === 'network' &&
        episode.status === 'navigating') scheduleNetworkRetryAlarm(episode.deadline);
    }).catch(console.error);
  });

  // Settings are shared by all pages. Keep the task's default in sync without
  // changing ownership, generations, completed records or forced retry targets.
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes || {}, 'wb-playback-target')) return;
    serial(async () => {
      const value = (await chrome.storage.local.get('wb-playback-target'))['wb-playback-target'];
      const target = validTargetPercent(value) ? value : 100;
      const job = await read();
      if (!job?.singlePass || ['idle', 'resetting'].includes(job.phase) || job.targetPercent === target) return;
      job.targetPercent = target;
      await save(job);
    }).catch(console.error);
  });

  chrome.runtime.onInstalled?.addListener(() => {
    serial(async () => {
      const job = await read();
      if (job?.outer?.state === 'active') {
        await save(pause(job, '扩展已更新或重新安装；本轮结果和重进次数已保留，请明确继续。'));
        return;
      }
      if (!job || job.workflow === 'manual' || ['idle', 'resetting'].includes(job.phase)) return;
      pause(job, '助手已更新为按需模式，请获取课程列表后选择课程。');
      job.phase = 'interrupted';
      await save(job);
    }).catch(console.error);
  });

  chrome.tabs.onCreated.addListener(tab => {
    const createdAt = Date.now();
    serial(async () => {
      const job = await read();
      const latePausedOpening = !job?.running && ['paused', 'manual'].includes(job?.phase) && job.resumePhase === 'opening';
      const authorizedOpening = (job?.running && job.phase === 'opening' || latePausedOpening) &&
        tab.openerTabId === job.homeTabId;
      const unlinkedInspectionTab = job?.running && job.phase === 'opening' &&
        job.targetPurpose === 'inspect' && job.workerTabId == null &&
        Number.isFinite(job.openIssuedAt) && createdAt >= job.openIssuedAt &&
        createdAt <= job.openDeadline && Number.isInteger(job.openWindowId) &&
        tab.windowId === job.openWindowId && tab.openerTabId == null;
      if (!authorizedOpening && ['idle', 'resetting'].includes(job?.phase) &&
        tab.openerTabId === job.resetOpeningParentId && createdAt <= job.resetOpeningUntil) {
        // A page can arrive after its old click's reset snapshot. Keep it
        // stopped, without restoring erased course or resource information.
        job.resetHoldTabIds = [...new Set([...job.resetHoldTabIds, tab.id])];
        await save(job);
        return;
      }
      if (unlinkedInspectionTab) {
        job.pendingOpenTabIds = [...new Set([...(job.pendingOpenTabIds || []), tab.id])];
        await save(job);
        return;
      }
      if ((!job?.running || job.phase !== 'opening') && !latePausedOpening) return;
      if (tab.openerTabId !== job.homeTabId) return;
      if (job.workerTabId != null) {
        await save(pause(job, '一次选课打开了多个标签页，已停止，请核对页面。', true));
        return;
      }
      job.pendingOpenTabIds = (job.pendingOpenTabIds || []).filter(id => id !== tab.id);
      job.createdTabIds.push(tab.id);
      job.workerTabId = tab.id;
      bindOwnerInstance(job, tab.id, null);
      await save(job);
    }).catch(console.error);
  });
  chrome.tabs.onRemoved.addListener(id => {
    serial(async () => {
      const job = await read();
      if (job?.pendingOpenTabIds?.includes(id)) {
        job.pendingOpenTabIds = job.pendingOpenTabIds.filter(tabId => tabId !== id);
        await save(job);
      }
      if (job?.resetHoldTabIds?.includes(id)) {
        job.resetHoldTabIds = job.resetHoldTabIds.filter(tabId => tabId !== id);
        await save(job);
      }
      if (!job?.running || ![job.homeTabId, job.workerTabId].includes(id)) return;
      await save(pause(job, '任务页面已关闭，记录已保留。请回到课表点击继续运行。', true));
    }).catch(console.error);
  });
})();
