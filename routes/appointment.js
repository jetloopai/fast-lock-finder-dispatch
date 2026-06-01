'use strict';

const express = require('express');
const { VoiceResponse } = require('twilio').twiml;
const { getSession } = require('../lib/session');
const db = require('../lib/db');

const router = express.Router();

const VOICE = 'Polly.Joanna';
const url = (path) => `${process.env.BASE_URL}${path}`;

// Caller pressed 2 — connect immediately to dispatcher
router.post('/start', async (req, res) => {
  const session = getSession(req.body.CallSid);
  if (session) session.flowType = 'appointment';

  const twiml = new VoiceResponse();

  // Load dispatcher number from DB, fall back to env var
  let dispatcherPhone = null;
  try {
    const ladder = await db.getEscalationLadder();
    dispatcherPhone = ladder[0]?.phone || process.env.DISPATCHER_NUMBER;
  } catch (err) {
    dispatcherPhone = process.env.DISPATCHER_NUMBER;
    console.error('Escalation ladder error:', err.message);
  }

  // Create minimal record in background
  if (session) {
    db.createMinimalLead(session.callerPhone, 'Appointment').then(async ({ leadId, jobId, jobNumber, callLogId }) => {
      session.leadId    = leadId;
      session.jobId     = jobId;
      session.jobNumber = jobNumber;
      session.callLogId = callLogId;
    }).catch(err => console.error('DB create error (appointment):', err.message));
  }

  if (!dispatcherPhone) {
    twiml.say({ voice: VOICE },
      'Thank you for calling Fast Lock Finder. Our dispatcher is unavailable right now. Please call back shortly.'
    );
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  twiml.say({ voice: VOICE },
    'Thank you for calling Fast Lock Finder. Connecting you to schedule your appointment. Please hold.'
  );

  const dial = twiml.dial({
    action: url('/dial-status'),
    method: 'POST',
    timeout: 20,
    callerId: process.env.TWILIO_PHONE_NUMBER,
    record: 'record-from-answer',
    recordingStatusCallback: url('/recording-callback'),
    recordingStatusCallbackMethod: 'POST',
    transcribe: true,
    transcribeCallback: url('/transcription-callback/transcription'),
  });
  dial.number(dispatcherPhone);

  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
