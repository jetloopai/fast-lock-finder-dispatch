'use strict';

const express = require('express');
const { VoiceResponse } = require('twilio').twiml;
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();
const VOICE  = 'Polly.Joanna';
const url    = (path) => `${process.env.BASE_URL}${path}`;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Step 1 — tech calls in, prompted for their dispatch code
router.post('/start', (req, res) => {
  const twiml  = new VoiceResponse();
  const gather = twiml.gather({
    input:       'dtmf',
    action:      url('/dispatch/claim'),
    method:      'POST',
    finishOnKey: '#',
    timeout:     15,
    numDigits:   6,
  });
  gather.say({ voice: VOICE },
    'Welcome to Fast Lock Finder dispatch. Enter your 6-digit dispatch code followed by the pound sign.'
  );
  twiml.say({ voice: VOICE }, 'No code entered. Goodbye.');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// Step 2 — claim the code, bridge to customer
router.post('/claim', async (req, res) => {
  const code   = (req.body.Digits || '').toUpperCase().trim();
  const callerPhone = req.body.From;
  const twiml  = new VoiceResponse();

  if (!code || code.length !== 6) {
    twiml.say({ voice: VOICE }, 'Invalid code. Please try again.');
    twiml.redirect({ method: 'POST' }, url('/dispatch/start'));
    return res.type('text/xml').send(twiml.toString());
  }

  try {
    // Call the claim_code DB function (locks the row, marks in_progress)
    const { data, error } = await supabase.rpc('claim_code', {
      p_code: code,
      p_sid:  req.body.CallSid,
      p_from: callerPhone,
    });

    if (error || !data || data.length === 0) {
      twiml.say({ voice: VOICE },
        'That code was not found or has already been used. Please check your code and try again.'
      );
      twiml.redirect({ method: 'POST' }, url('/dispatch/start'));
      return res.type('text/xml').send(twiml.toString());
    }

    const { lead_phone } = data[0];

    twiml.say({ voice: VOICE }, 'Code accepted. Connecting you to the customer now.');
    const dial = twiml.dial({
      action:   url('/dispatch/complete'),
      method:   'POST',
      timeout:  30,
      callerId: process.env.TWILIO_PHONE_NUMBER,
    });
    dial.number(lead_phone);

  } catch (err) {
    console.error('Dispatch claim error:', err.message);
    twiml.say({ voice: VOICE }, 'An error occurred. Please contact your dispatcher.');
    twiml.hangup();
  }

  res.type('text/xml').send(twiml.toString());
});

// Step 3 — after call ends, mark dispatch code complete
router.post('/complete', async (req, res) => {
  const dialStatus = req.body.DialCallStatus;
  const twiml = new VoiceResponse();

  if (dialStatus !== 'completed') {
    twiml.say({ voice: VOICE }, 'The customer did not answer. Please try again shortly.');
  }

  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
