'use strict';

const express = require('express');
const { VoiceResponse } = require('twilio').twiml;
const { getSession } = require('../lib/session');
const db = require('../lib/db');

const router = express.Router();

const VOICE = 'Polly.Joanna';
const url = (path) => `${process.env.BASE_URL}${path}`;

// Step 1 — caller pressed 1, connect immediately to dispatcher
router.post('/start', async (req, res) => {
  const session = getSession(req.body.CallSid);
  if (session) session.flowType = 'emergency';

  const twiml = new VoiceResponse();

  // Load escalation ladder (DB first, env var fallback)
  let ladder = [];
  try {
    ladder = await db.getEscalationLadder();
  } catch (err) {
    console.error('Escalation ladder error:', err.message);
  }

  // Create a minimal job record in the background (don't block the call)
  if (session) {
    db.createMinimalLead(session.callerPhone, 'Emergency Lockout').then(async ({ leadId, jobId, jobNumber, callLogId }) => {
      session.leadId    = leadId;
      session.jobId     = jobId;
      session.jobNumber = jobNumber;
      session.callLogId = callLogId;
    }).catch(err => console.error('DB create error (emergency):', err.message));
  }

  const dispatcherPhone = ladder[0]?.phone || process.env.DISPATCHER_NUMBER;

  if (!dispatcherPhone) {
    twiml.say({ voice: VOICE },
      'Thank you for calling Fast Lock Finder. We are unable to reach a technician right now. Please call back shortly.'
    );
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  twiml.say({ voice: VOICE }, 'Thank you for calling Fast Lock Finder. Connecting you to a locksmith now. Please hold.');

  const dial = twiml.dial({
    action: url('/dial-status'),
    method: 'POST',
    timeout: 20,
    callerId: process.env.TWILIO_PHONE_NUMBER,
  });
  dial.number({ url: url('/ivr/emergency/tech-whisper'), method: 'POST' }, dispatcherPhone);

  res.type('text/xml').send(twiml.toString());
});

// Whisper played to the tech/dispatcher before bridging
router.post('/tech-whisper', (req, res) => {
  const twiml = new VoiceResponse();
  const gather = twiml.gather({ numDigits: '1', timeout: 10 });
  gather.say({ voice: VOICE },
    'Incoming lockout service call from Fast Lock Finder. Press any key to accept.'
  );
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// Voicemail — reached after all escalation steps exhausted
router.post('/voicemail', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({ voice: VOICE },
    'We are unable to reach a technician right now. ' +
    'Please leave a message after the tone and we will call you back immediately.'
  );
  twiml.record({
    action: url('/recording-callback'),
    method: 'POST',
    maxLength: 120,
    timeout: 5,
    playBeep: true,
    transcribe: false,
  });
  twiml.say({ voice: VOICE }, 'We did not receive a recording. Goodbye.');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
