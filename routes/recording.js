'use strict';

const express = require('express');
const { VoiceResponse } = require('twilio').twiml;
const { getSession, deleteSession } = require('../lib/session');
const db = require('../lib/db');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();

const STATUS_KEYWORDS = {
  en_route:  ['on my way', 'heading over', 'driving', 'en route', 'leaving now', 'be there soon'],
  arrived:   ['i arrived', "i'm here", 'on site', 'at the location', 'outside'],
  completed: ['all done', 'job complete', 'finished', 'wrapped up', 'good to go', 'all set'],
};

function detectStatus(transcript) {
  const t = transcript.toLowerCase();
  for (const [status, keywords] of Object.entries(STATUS_KEYWORDS)) {
    if (keywords.some(k => t.includes(k))) return status;
  }
  return null;
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

    // Auto-update job status if detected
    if (session?.jobId && detectedStatus) {
      await db.updateJob(session.jobId, { status: detectedStatus });
      console.log(`Auto-status: job ${session.jobId} → ${detectedStatus}`);
    }

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

    if (session?.jobId && detectedStatus) {
      await db.updateJob(session.jobId, { status: detectedStatus });
    }
  } catch (err) {
    console.error('Transcription callback error:', err.message);
  }
});

module.exports = router;
