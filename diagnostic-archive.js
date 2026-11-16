/* Bounded, optional diagnostics. Never read by execution decisions. */
(() => {
  'use strict';
  const bytes = value => {
    let size = 0;
    for (const char of JSON.stringify(value)) {
      const point = char.codePointAt(0);
      size += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    }
    return size;
  };
  function merge(prior, report, outer) {
    const archive = prior?.archive?.version === 1 ? JSON.parse(JSON.stringify(prior.archive)) :
      { version: 1, history: (prior?.logs || []).slice(-300),
        incidents: prior?.incident ? [{ runId: prior.runId, time: prior.incident.time, attempt: 0, incident: prior.incident }] : [],
        incidentCursor: prior?.incident ? `${prior.runId}:${prior.incident.time}:0` : '',
        rounds: [], cursor: { runId: prior?.runId || '', sequence: Math.max(0, ...(prior?.logs || []).map(log => log.sequence || 0)) },
        clipped: { history: 0, incidents: 0, rounds: 0, snapshot: 0 } };
    const cursor = archive.cursor?.runId === report.runId ? archive.cursor.sequence : 0;
    for (const log of report.logs) {
      if ((log.sequence || 0) <= cursor) continue;
      const attempt = log.attempt ?? 0;
      const entry = { ...log, roundId: log.roundId || '', attempt };
      if (entry.eventCode === 'course-failed' && entry.result) {
        const group = { runId: entry.runId, roundId: entry.roundId, attempt, time: entry.time,
          result: entry.result, logs: report.logs.filter(item => item.courseKey === entry.courseKey &&
            (item.attempt ?? 0) === attempt && item.sequence <= entry.sequence).slice(-20) };
        while (group.logs.length && bytes(group) > 20 * 1024) group.logs.shift();
        if (bytes(group) <= 20 * 1024) archive.incidents.push(group);
        else archive.clipped.incidents++;
      }
      if (entry.type === 'err') {
        const previous = [...archive.history].reverse().find(item => item.type === 'err' && item.runId === entry.runId &&
          item.roundId === entry.roundId && item.attempt === attempt && item.courseKey === entry.courseKey &&
          item.phase === entry.phase && item.eventCode === entry.eventCode && item.text === entry.text);
        if (previous) { previous.count = (previous.count || 1) + 1; previous.lastTime = entry.time; continue; }
        entry.count = 1; entry.firstTime = entry.lastTime = entry.time;
      }
      archive.history.push(entry);
    }
    archive.cursor = { runId: report.runId, sequence: Math.max(cursor, ...report.logs.map(log => log.sequence || 0)) };
    const incident = report.incident;
    const attempt = incident?.outerAttempt ?? 0;
    const incidentCursor = incident ? `${report.runId}:${incident.time}:${attempt}` : '';
    if (incident && archive.incidentCursor !== incidentCursor) {
      archive.incidentCursor = incidentCursor;
      const group = { runId: report.runId, roundId: incident.outerRoundId || '', attempt, time: incident.time, incident };
      if (bytes(group) <= 20 * 1024) archive.incidents.push(group);
      else archive.clipped.incidents++;
    }
    if (outer) {
      const summary = { id: outer.id, state: outer.state, createdAt: outer.createdAt, finishedAt: outer.finishedAt,
        summary: outer.summary, entries: outer.entries.map(entry => ({ key: entry.key, title: entry.title,
          state: entry.state, reason: entry.reason, reentries: entry.reentries, latestResult: entry.latestResult })) };
      const index = archive.rounds.findIndex(round => round.id === outer.id);
      if (index >= 0) archive.rounds[index] = summary; else archive.rounds.push(summary);
    }
    const trim = key => { archive[key].shift(); archive.clipped[key]++; };
    let historyBytes = bytes(archive.history);
    while (archive.history.length > 1000 || historyBytes > 1024 * 1024) {
      historyBytes -= bytes(archive.history[0]) + (archive.history.length > 1 ? 1 : 0);
      trim('history');
    }
    archive.incidents = archive.incidents.filter(group => {
      if (bytes(group) <= 20 * 1024) return true;
      archive.clipped.incidents++; return false;
    });
    while (archive.incidents.length > 10) trim('incidents');
    while (archive.rounds.length > 3) trim('rounds');
    const result = { ...report, archive, limits: { ...report.limits, history: 1000, historyBytes: 1024 * 1024,
      incidents: 10, incidentBytes: 20 * 1024, retainedRuns: 3, archiveBytes: 2 * 1024 * 1024 } };
    // Preserve useful bounded evidence, but do not promise unlimited retention.
    let totalBytes;
    while ((totalBytes = bytes(result)) > 2 * 1024 * 1024) {
      if (archive.history.length) {
        let excess = totalBytes - 2 * 1024 * 1024;
        do { excess -= bytes(archive.history[0]) + 1; trim('history'); }
        while (excess > 0 && archive.history.length);
      }
      else if (archive.rounds.length > 1) trim('rounds');
      else if (archive.incidents.length) trim('incidents');
      else if (archive.rounds[0]?.entries.length) {
        const removed = archive.rounds[0].entries.splice(0, 100).length; archive.clipped.rounds += removed;
      }
      else if (result.logs.length) { result.logs.shift(); archive.clipped.snapshot++; }
      else if (Object.keys(result.records).length) { delete result.records[Object.keys(result.records)[0]]; archive.clipped.snapshot++; }
      else if (result.scanDraft?.items.length) { result.scanDraft.items.shift(); archive.clipped.snapshot++; }
      else if (result.documents.length) { result.documents.shift(); archive.clipped.snapshot++; }
      else { result.incident = null; break; }
    }
    return result;
  }
  globalThis.XinweiDiagnosticArchive = { bytes, merge };
})();
