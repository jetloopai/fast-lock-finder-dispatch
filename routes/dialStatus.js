'use strict';

const express = require('express');
const { VoiceResponse } = require('twilio').twiml;
const { getSession, deleteSession } = require('../lib/session');
const db = require('../lib/db');

const router = express.Router();

const VOICE = 'Polly.Joanna';
const url = (path) => `${process.env.BASE_URL}${path}`;

router.post('/', async (req, res) => {
  const callSid    = req.body.CallSid;
  const dialStatus = req.body.DialCallStatus;
  const session    = getSession(callSid);
  const twiml      = new VoiceResponse();

  // Call was answered and completed — clean up
  if (dialStatus === 'completed') {
    deleteSession(callSid);
    return res.type('text/xml').send(twiml.toString());
  }

  if (!session) {
    twiml.say({ voice: VOICE }, 'Thank you for calling Fast Lock Finder. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Appointment flow: dispatcher didn't answer — no tech escalation
  if (session.flowType === 'appointment') {
    deleteSession(callSid);
    twiml.say({ voice: VOICE },
      'Our dispatcher is currently unavailable. ' +
      'We have your appointment details and will call you back shortly. Thank you.'
    );
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Emergency flow — load escalation ladder and advance
  let ladder = [];
  try {
    ladder = await db.getEscalationLadder();
  } catch (err) {
    console.error('Failed to load escalation ladder:', err.message);
  }

  // escalationStep starts at 0 (just tried ladder[0]), advance to next
  session.escalationStep += 1;
  const next = ladder[session.escalationStep];

  if (next) {
    const messages = [
      'Connecting you to the first available technician. Please hold.',
      'Please hold while we try another technician.',
      'Please hold while we try one more technician.',
    ];
    const message = messages[session.escalationStep - 1] || 'Please hold.';

    twiml.say({ voice: VOICE }, message);
    const dial = twiml.dial({
      action: url('/dial-status'),
      method: 'POST',
      timeout: 20,
      callerId: process.env.TWILIO_PHONE_NUMBER,
    });
    dial.number({ url: url('/ivr/tech-whisper'), method: 'POST' }, next.phone);
  } else {
    // All options exhausted — voicemail
    twiml.redirect({ method: 'POST' }, url('/ivr/emergency/voicemail'));
  }

  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
