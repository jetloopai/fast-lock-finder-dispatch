'use strict';

const sessions = new Map();

function createSession(callSid, callerPhone) {
  const session = {
    callerPhone,
    callerName: null,
    serviceAddress: null,
    vehicleMakeModel: null,
    preferredDate: null,
    preferredTime: null,
    flowType: null,
    leadId: null,
    jobId: null,
    callLogId: null,
    jobNumber: null,
    escalationStep: 0,
    answeredByLocksmiths: null, // id of locksmith who answered
    createdAt: Date.now(),
  };
  sessions.set(callSid, session);
  return session;
}

function getSession(callSid) {
  return sessions.get(callSid) || null;
}

function deleteSession(callSid) {
  sessions.delete(callSid);
}

// Purge sessions older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [sid, s] of sessions) {
    if (s.createdAt < cutoff) sessions.delete(sid);
  }
}, 10 * 60 * 1000);

module.exports = { createSession, getSession, deleteSession };
