'use strict';

const express = require('express');
const { VoiceResponse } = require('twilio').twiml;
const { getSession } = require('../lib/session');
const db = require('../lib/db');

const router = express.Router();

const VOICE = 'Polly.Joanna';
const url = (path) => `${process.env.BASE_URL}${path}`;

router.post('/start', (req, res) => {
  const session = getSession(req.body.CallSid);
  if (session) session.flowType = 'status';

  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'dtmf',
    action: url('/ivr/status/lookup'),
    method: 'POST',
    finishOnKey: '#',
    timeout: 10,
  });
  gather.say({ voice: VOICE },
    'Please enter your job number followed by the pound sign. ' +
    'Or press star to look up by your phone number.'
  );

  twiml.say({ voice: VOICE }, "We didn't receive any input. Goodbye.");
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

router.post('/lookup', async (req, res) => {
  const digits = (req.body.Digits || '').replace('#', '').trim();
  const session = getSession(req.body.CallSid);
  const twiml = new VoiceResponse();

  let job = null;
  try {
    if (digits === '*' || digits === '') {
      const callerPhone = session ? session.callerPhone : (req.body.From || '');
      const last4 = callerPhone.slice(-4);
      job = await db.findJobByPhoneLast4(last4);
    } else {
      job = await db.findJobByNumber(digits);
    }
  } catch (err) {
    console.error('Supabase lookup error:', err.message);
  }

  if (!job) {
    twiml.say({ voice: VOICE },
      'We could not find a matching service request. ' +
      'Please double check your job number and try again, or call us back for assistance.'
    );
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const phrase = db.getStatusPhrase(job.status);
  twiml.say({ voice: VOICE },
    `We found your service request. Job number ${job.job_number}. ${phrase} Thank you for calling Fast Lock Finder. Goodbye.`
  );
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
