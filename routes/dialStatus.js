'use strict';

const express = require('express');
const { VoiceResponse } = require('twilio').twiml;
const { getSession, deleteSession } = require('../lib/session');
const db = require('../lib/db');

const router = express.Router();

const VOICE = 'Polly.Joanna';
const url = (path) => `${process.env.BASE_URL}${path}`;

// Env var fallbacks guarantee escalation works even if DB is empty
function getEscalationPhone(ladder, step) {
  const fromDB  = ladder[step]?.phone;
  const fromEnv = [
    process.env.DISPATCHER_NUMBER,
    process.env.TECH1_NUMBER,
    process.env.TECH2_NUMBER,
    process.env.TECH3_NUMBER,
  ][step];
  return fromDB || fromEnv || null;
}

router.post('/', async (req, res) => {
  const callSid    = req.body.CallSid;
  const dialStatus = req.body.DialCallStatus;
  const session    = getSession(callSid);
  const twiml      = new VoiceResponse();

  // Call answered and completed — clean up
  if (dialStatus === 'completed') {
    deleteSession(callSid);
    return res.type('text/xml').send(twiml.toString());
  }

  if (!session) {
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Appointment flow — dispatcher only, then polite message
  if (session.flowType === 'appointment') {
    deleteSession(callSid);
    twiml.say({ voice: VOICE },
      'Our dispatcher is currently unavailable. We have noted your call and will reach out to schedule your appointment shortly. Thank you.'
    );
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Emergency flow — escalate through ladder with env var fallbacks
  let ladder = [];
  try {
    ladder = await db.getEscalationLadder();
  } catch (err) {
    console.error('Ladder fetch error:', err.message);
  }

  // Advance to next step
  session.escalationStep += 1;
  const nextPhone = getEscalationPhone(ladder, session.escalationStep);

  if (nextPhone) {
    const messages = [
      'Connecting you to the first available technician. Please hold.',
      'Please hold while we try another technician.',
      'Please hold while we try one more technician.',
    ];
    const msg = messages[session.escalationStep - 1] || 'Please hold.';

    twiml.say({ voice: VOICE }, msg);
    const dial = twiml.dial({
      action: url('/dial-status'),
      method: 'POST',
      timeout: 20,
      callerId: process.env.TWILIO_PHONE_NUMBER,
    });
    dial.number({ url: url('/ivr/emergency/tech-whisper'), method: 'POST' }, nextPhone);
  } else {
    // All options exhausted
    twiml.redirect({ method: 'POST' }, url('/ivr/emergency/voicemail'));
  }

  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
