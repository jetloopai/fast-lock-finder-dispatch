'use strict';

const express = require('express');
const { VoiceResponse } = require('twilio').twiml;
const { createSession } = require('../lib/session');

const router = express.Router();

const VOICE = 'Polly.Joanna';
const url = (path) => `${process.env.BASE_URL}${path}`;

router.post('/', (req, res) => {
  const callSid = req.body.CallSid;
  const callerPhone = req.body.From || '';
  createSession(callSid, callerPhone);

  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    numDigits: '1',
    action: url('/voice/menu-selection'),
    method: 'POST',
    timeout: 8,
  });
  gather.say({ voice: VOICE },
    'Thank you for calling Fast Lock Finder. ' +
    'Press 1 for Emergency Lockout Service. ' +
    'Press 2 to Schedule an Appointment. ' +
    'Press 3 to Check the Status of an Existing Service Request.'
  );

  // Fallback if no key pressed
  twiml.say({ voice: VOICE }, "We didn't receive your selection. Please try again.");
  twiml.redirect({ method: 'POST' }, url('/voice'));

  res.type('text/xml').send(twiml.toString());
});

router.post('/menu-selection', (req, res) => {
  const digit = req.body.Digits;
  if (digit === '1') return res.redirect(307, url('/ivr/emergency/start'));
  if (digit === '2') return res.redirect(307, url('/ivr/appointment/start'));
  if (digit === '3') return res.redirect(307, url('/ivr/status/start'));

  const twiml = new VoiceResponse();
  twiml.say({ voice: VOICE }, 'Invalid selection. Please try again.');
  twiml.redirect({ method: 'POST' }, url('/voice'));
  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
