'use strict';

const express = require('express');
const { VoiceResponse } = require('twilio').twiml;
const { getSession, deleteSession } = require('../lib/session');
const db = require('../lib/db');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();

const STATUS_KEYWORDS = {
  // Job progress
  en_route:  ['on my way', 'heading over', 'heading there', 'driving over', 'en route', 'leaving now', 'be there soon', 'on the way'],
  arrived:   ['i arrived', "i'm here", 'on site', 'at the location', 'outside', 'i am here', 'just pulled up', 'pulled up'],
  completed: ['all done', 'job complete', 'job is done', 'finished', 'wrapped up', 'good to go', 'all set', 'work is done', 'just finished'],

  // Lead outcomes — no job created
  quote_only: ['just needed a price', 'just want a quote', 'how much does it cost', 'what do you charge',
               'just checking prices', 'price shopping', 'just wanted to know the price',
               "i'll call back", "i'll think about it", 'let me think about it', 'i need to think',
               'call you back', 'will call back', 'i may call back', 'might call back',
               'just comparing', 'getting quotes'],

  // Declined / lost lead
  declined:  ['too expensive', 'too much', 'never mind', 'nevermind', 'not interested',
              'going with someone else', 'found someone cheaper', 'found another locksmith',
              'already handled', 'figured it out', 'got in already', 'no longer need',
              "don't need it anymore", 'cancel', 'disregard'],

  // Missed / no service
  missed:    ['no answer', 'nobody answered', 'they left', 'customer left',
              'car was towed', 'situation changed', 'not there anymore'],
};

// Map detected status to the job_status enum values in Supabase
const STATUS_TO_JOB_STATUS = {
  en_route:   'en_route',
  arrived:    'arrived',
  completed:  'complete',
  quote_only: null,     // update lead status only, not job
  declined:   'missed',
  missed:     'missed',
};

function detectStatus(transcript) {
  const t = transcript.toLowerCase();
  for (const [status, keywords] of Object.entries(STATUS_KEYWORDS)) {
    if (keywords.some(k => t.includes(k))) return status;
  }
  return null;
}

async function applyDetectedStatus(session, detectedStatus) {
  if (!detectedStatus || !session) return;
  const jobStatus = STATUS_TO_JOB_STATUS[detectedStatus];

  // Update job status if it maps to one
  if (jobStatus && session.jobId) {
    await db.updateJob(session.jobId, { status: jobStatus });
    console.log(`Auto-status: job ${session.jobId} → ${jobStatus} (detected: ${detectedStatus})`);
  }

  // For quote_only/declined — update the lead back to 'new' or 'missed'
  if (session.leadId) {
    if (detectedStatus === 'quote_only') {
      await db.updateLead(session.leadId, { status: 'new' });
    } else if (detectedStatus === 'declined') {
      await db.updateLead(session.leadId, { status: 'missed' });
    }
  }
}

async function summarizeWithClaude(transcript) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Summarize this locksmith service call in 2-3 sentences. Include: what service was needed, key details mentioned, and outcome if discussed. Be concise.\n\nTranscript:\n${transcript}`,
      }],
    });
    return msg.content[0]?.text || null;
  } catch (err) {
    console.error('Claude summary error:', err.message);
    return null;
  }
}

// Called by Twilio when a recording is ready
router.post('/', async (req, res) => {
  const callSid      = req.body.CallSid;
  const recordingUrl = req.body.RecordingUrl;
  const transcript   = req.body.TranscriptionText || null;
  const session      = getSession(callSid);

  // Process in background — respond to Twilio immediately
  const twiml = new VoiceResponse();
  res.type('text/xml').send(twiml.toString());

  try {
    const detectedStatus = transcript ? detectStatus(transcript) : null;
    const summary        = transcript ? await summarizeWithClaude(transcript) : null;

    const updates = {};
    if (recordingUrl)    updates['recording_url'] = recordingUrl + '.mp3';
    if (transcript)      updates['transcript']    = transcript;
    if (summary)         updates['summary']       = summary;
    if (detectedStatus)  updates['auto_status']   = detectedStatus;

    if (session?.callLogId && Object.keys(updates).length) {
      await db.updateCallLog(session.callLogId, updates);
    }

    // Auto-update job/lead status
    await applyDetectedStatus(session, detectedStatus);

    // Handle voicemail recording URL on job record
    if (session?.jobId && recordingUrl && !session?.callLogId) {
      await db.updateJob(session.jobId, { recording_url: recordingUrl + '.mp3' });
    }
  } catch (err) {
    console.error('Recording callback error:', err.message);
  }

  deleteSession(callSid);
});

// Called by Twilio when transcription is ready (separate callback)
router.post('/transcription', async (req, res) => {
  const callSid    = req.body.CallSid;
  const transcript = req.body.TranscriptionText;
  const session    = getSession(callSid);

  res.sendStatus(200);

  if (!transcript) return;

  try {
    const detectedStatus = detectStatus(transcript);
    const summary        = await summarizeWithClaude(transcript);

    const updates = { transcript };
    if (summary)        updates.summary     = summary;
    if (detectedStatus) updates.auto_status = detectedStatus;

    if (session?.callLogId) {
      await db.updateCallLog(session.callLogId, updates);
    }

    await applyDetectedStatus(session, detectedStatus);
  } catch (err) {
    console.error('Transcription callback error:', err.message);
  }
});

module.exports = router;
