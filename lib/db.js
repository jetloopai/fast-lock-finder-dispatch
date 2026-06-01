'use strict';

const { createClient } = require('@supabase/supabase-js');

// Lazy init — avoids crash if env vars not yet loaded
let _supabase = null;
function getClient() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return _supabase;
}
// Alias used throughout this file
const supabase = new Proxy({}, {
  get: (_, prop) => getClient()[prop]
});

const STATUS_PHRASES = {
  pending:   'Your job is pending and will be assigned shortly.',
  assigned:  'A technician has been assigned to your job.',
  en_route:  'Your technician is on the way.',
  arrived:   'Your technician has arrived at the location.',
  completed: 'Your job has been marked as completed.',
  in_progress: 'Your job is currently in progress.',
  complete:  'Your job has been completed.',
  missed:    'Your job was marked as missed. Please call us back for assistance.',
};

// Find an active job for a returning caller — used for callback routing
async function findActiveJobByPhone(callerPhone) {
  // Look up leads matching this phone
  const { data: leads } = await supabase
    .from('leads')
    .select('id')
    .eq('phone', callerPhone);

  if (!leads || !leads.length) return null;
  const leadIds = leads.map(l => l.id);

  // Find the most recent active job with an assigned locksmith
  const { data: jobs } = await supabase
    .from('jobs')
    .select('id, status, locksmith_id, locksmiths(phone, name)')
    .in('lead_id', leadIds)
    .in('status', ['pending', 'assigned', 'en_route', 'arrived', 'in_progress'])
    .order('created_at', { ascending: false })
    .limit(1);

  if (!jobs || !jobs.length) return null;
  const job = jobs[0];
  if (!job.locksmith_id || !job.locksmiths?.phone) return null;
  return job;
}

// Create a minimal lead + job + call log from caller phone only (no questions asked)
async function createMinimalLead(callerPhone, serviceType) {
  const { data: leadData, error: leadErr } = await supabase
    .from('leads')
    .insert({ phone: callerPhone, service_type: serviceType, status: 'new' })
    .select('id')
    .single();
  if (leadErr) throw leadErr;

  const leadId = leadData.id;

  const { data: jobData, error: jobErr } = await supabase
    .from('jobs')
    .insert({ lead_id: leadId, caller_phone: callerPhone, job_type: serviceType, status: 'pending' })
    .select('id, job_number')
    .single();
  if (jobErr) throw jobErr;

  const { data: logData, error: logErr } = await supabase
    .from('call_logs')
    .insert({ job_id: jobData.id, client_phone: callerPhone, start_time: new Date().toISOString(), status: 'answered' })
    .select('id')
    .single();
  if (logErr) throw logErr;

  return { leadId, jobId: jobData.id, jobNumber: jobData.job_number, callLogId: logData.id };
}

// Create a lead record from an inbound call
async function createLead({ name, phone, serviceType, address, vehicle }) {
  const { data, error } = await supabase
    .from('leads')
    .insert({ name, phone, service_type: serviceType, address, vehicle, status: 'new' })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

// Create a job linked to a lead
async function createJob({ leadId, jobType, locksmiths = [] }) {
  const { data, error } = await supabase
    .from('jobs')
    .insert({ lead_id: leadId, job_type: jobType, status: 'pending' })
    .select('id, job_number')
    .single();
  if (error) throw error;
  return { jobId: data.id, jobNumber: data.job_number };
}

// Create a call log entry
async function createCallLog({ jobId, clientPhone }) {
  const { data, error } = await supabase
    .from('call_logs')
    .insert({ job_id: jobId, client_phone: clientPhone, start_time: new Date().toISOString(), status: 'answered' })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

// Save voicemail recording URL to call log; mark call as missed
async function saveRecording({ callLogId, jobId, recordingUrl }) {
  if (callLogId) {
    const { error } = await supabase
      .from('call_logs')
      .update({ recording_url: recordingUrl, end_time: new Date().toISOString(), status: 'missed' })
      .eq('id', callLogId);
    if (error) throw error;
  }
  if (jobId) {
    const { error } = await supabase
      .from('jobs')
      .update({ status: 'missed' })
      .eq('id', jobId);
    if (error) throw error;
  }
}

// Assign a locksmith to a job and advance status
async function assignLocksmith(jobId, locksmiths) {
  const { error } = await supabase
    .from('jobs')
    .update({ locksmith_id: locksmiths, status: 'assigned' })
    .eq('id', jobId);
  if (error) throw error;
}

// Find a job by its human-readable job_number
async function findJobByNumber(jobNumber) {
  const n = parseInt(jobNumber, 10);
  if (isNaN(n)) return null;
  const { data, error } = await supabase
    .from('jobs')
    .select('id, job_number, status, locksmith_id')
    .eq('job_number', n)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Find the most recent job by last 4 digits of caller phone (via leads)
async function findJobByPhoneLast4(last4) {
  const { data, error } = await supabase
    .from('leads')
    .select('id, phone')
    .like('phone', `%${last4}`);
  if (error) throw error;
  if (!data || !data.length) return null;

  const leadIds = data.map(l => l.id);
  const { data: jobs, error: jobErr } = await supabase
    .from('jobs')
    .select('id, job_number, status')
    .in('lead_id', leadIds)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (jobErr) throw jobErr;
  return jobs;
}

// Get active locksmiths ordered by escalation_priority (0 = dispatcher first)
async function getEscalationLadder() {
  const { data, error } = await supabase
    .from('locksmiths')
    .select('id, name, phone, role, escalation_priority')
    .eq('active', true)
    .order('escalation_priority', { ascending: true });
  if (error) throw error;
  return data || [];
}

function getStatusPhrase(status) {
  return STATUS_PHRASES[status] || `Your job status is ${status}.`;
}

async function updateJob(id, fields) {
  const { error } = await supabase.from('jobs').update(fields).eq('id', id);
  if (error) throw error;
}

async function updateCallLog(id, fields) {
  const { error } = await supabase.from('call_logs').update(fields).eq('id', id);
  if (error) throw error;
}

module.exports = {
  findActiveJobByPhone,
  createMinimalLead,
  createLead,
  createJob,
  createCallLog,
  updateJob,
  updateCallLog,
  saveRecording,
  assignLocksmith,
  findJobByNumber,
  findJobByPhoneLast4,
  getEscalationLadder,
  getStatusPhrase,
};
