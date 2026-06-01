'use strict';

const express = require('express');
const { VoiceResponse } = require('twilio').twiml;
const { createSession, getSession } = require('../lib/session');
const db = require('../lib/db');

const router = express.Router();

const VOICE = 'Polly.Joanna';
const url = (path) => `${process.env.BASE_URL}${path}`;

router.post('/', async (req, res) => {
  const callSid    = req.body.CallSid;
  const callerPhone = req.body.From || '';
  createSession(callSid, callerPhone);

  const twiml = new VoiceResponse();

  // Check if this caller has an active job with an assigned tech — auto-bridge callback
  try {
    const activeJob = await db.findActiveJobByPhone(callerPhone);
    if (activeJob) {
      const techPhone = activeJob.locksmiths.phone;
      const techName  = activeJob.locksmiths.name || 'your technician';

      // Log this callback call
      db.createCallLog({ jobId: activeJob.id, clientPhone: callerPhone })
        .catch(err => console.error('Callback log error:', err.message));

      twiml.say({ voice: VOICE },
        `Welcome back to Fast Lock Finder. Connecting you back to ${techName}. Please hold.`
      );

      const dial = twiml.dial({
        action:   url('/dial-status'),
        method:   'POST',
        timeout:  20,
        record:   'record-from-answer',
        recordingStatusCallback: url('/recording-callback'),
        callerId: process.env.TWILIO_PHONE_NUMBER,
      });
      dial.number(techPhone);

      return res.type('text/xml').send(twiml.toString());
    }
  } catch (err) {
    console.error('Callback lookup error:', err.message);
  }

  // No active job — show normal menu
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
    'Press 3 to Check the Status of an Existing Service Request. ' +
    'Press 4 if you are a technician.'
  );

  twiml.say({ voice: VOICE }, "We didn't receive your selection. Please try again.");
  twiml.redirect({ method: 'POST' }, url('/voice'));

  res.type('text/xml').send(twiml.toString());
});

router.post('/menu-selection', (req, res) => {
  const digit = req.body.Digits;
  const twiml = new VoiceResponse();

  if (digit === '1') {
    twiml.redirect({ method: 'POST' }, url('/ivr/emergency/start'));
  } else if (digit === '2') {
    twiml.redirect({ method: 'POST' }, url('/ivr/appointment/start'));
  } else if (digit === '3') {
    twiml.redirect({ method: 'POST' }, url('/ivr/status/start'));
  } else if (digit === '4') {
    twiml.redirect({ method: 'POST' }, url('/dispatch/start'));
  } else {
    twiml.say({ voice: VOICE }, 'Invalid selection. Please try again.');
    twiml.redirect({ method: 'POST' }, url('/voice'));
  }

  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
