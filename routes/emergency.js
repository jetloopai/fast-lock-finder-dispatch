'use strict';

const express = require('express');
const { VoiceResponse } = require('twilio').twiml;
const { getSession } = require('../lib/session');
const db = require('../lib/db');

const router = express.Router();

const VOICE = 'Polly.Joanna';
const url = (path) => `${process.env.BASE_URL}${path}`;

function speechGather(twiml, promptText, actionPath, retryPath) {
  const gather = twiml.gather({
    input: 'speech',
    action: url(actionPath),
    method: 'POST',
    speechTimeout: 'auto',
    speechModel: 'phone_call',
    language: 'en-US',
    timeout: 5,
  });
  gather.say({ voice: VOICE }, promptText);
  twiml.redirect({ method: 'POST' }, url(retryPath));
}

// Step 1 — enter emergency flow
router.post('/start', (req, res) => {
  const session = getSession(req.body.CallSid);
  if (session) session.flowType = 'emergency';
  const twiml = new VoiceResponse();
  speechGather(twiml, 'You have reached Emergency Lockout Service. Please say your full name.', '/ivr/emergency/name', '/ivr/emergency/start');
  res.type('text/xml').send(twiml.toString());
});

// Step 2 — collect name
router.post('/name', (req, res) => {
  const speech = (req.body.SpeechResult || '').trim();
  const twiml = new VoiceResponse();
  if (!speech) {
    twiml.say({ voice: VOICE }, "Sorry, I didn't catch that.");
    twiml.redirect({ method: 'POST' }, url('/ivr/emergency/start'));
    return res.type('text/xml').send(twiml.toString());
  }
  const session = getSession(req.body.CallSid);
  if (session) session.callerName = speech;
  speechGather(twiml, 'Please say the service address.', '/ivr/emergency/address', '/ivr/emergency/name');
  res.type('text/xml').send(twiml.toString());
});

// Step 3 — collect address
router.post('/address', (req, res) => {
  const speech = (req.body.SpeechResult || '').trim();
  const twiml = new VoiceResponse();
  if (!speech) {
    twiml.say({ voice: VOICE }, "Sorry, I didn't catch the address.");
    twiml.redirect({ method: 'POST' }, url('/ivr/emergency/address'));
    return res.type('text/xml').send(twiml.toString());
  }
  const session = getSession(req.body.CallSid);
  if (session) session.serviceAddress = speech;
  speechGather(twiml, 'Please say the vehicle make and model.', '/ivr/emergency/vehicle', '/ivr/emergency/address');
  res.type('text/xml').send(twiml.toString());
});

// Step 4 — collect vehicle, create Supabase records, dial dispatcher
router.post('/vehicle', async (req, res) => {
  const speech = (req.body.SpeechResult || '').trim();
  const twiml = new VoiceResponse();
  if (!speech) {
    twiml.say({ voice: VOICE }, "Sorry, I didn't catch the vehicle information.");
    twiml.redirect({ method: 'POST' }, url('/ivr/emergency/vehicle'));
    return res.type('text/xml').send(twiml.toString());
  }

  const session = getSession(req.body.CallSid);
  if (session) session.vehicleMakeModel = speech;

  // Get escalation ladder first so we have dispatcher's number
  let ladder = [];
  try {
    ladder = await db.getEscalationLadder();
  } catch (err) {
    console.error('Failed to load escalation ladder:', err.message);
  }

  // Create Supabase records
  try {
    const leadId = await db.createLead({
      name:        session.callerName || 'Unknown',
      phone:       session.callerPhone,
      serviceType: 'Emergency Lockout',
      address:     session.serviceAddress || '',
      vehicle:     speech,
    });
    const { jobId, jobNumber } = await db.createJob({ leadId, jobType: 'Emergency Lockout' });
    const callLogId = await db.createCallLog({ jobId, clientPhone: session.callerPhone });

    session.leadId    = leadId;
    session.jobId     = jobId;
    session.callLogId = callLogId;
    session.jobNumber = jobNumber;
  } catch (err) {
    console.error('Supabase create error (emergency):', err.message);
  }

  const jobMsg = session && session.jobNumber
    ? `Your job number is ${session.jobNumber}. `
    : '';

  twiml.say({ voice: VOICE },
    `${jobMsg}Thank you. We are connecting you to a dispatcher now. Please hold.`
  );

  // Dial the first person in the ladder (escalation_priority = 0, the dispatcher)
  const dispatcher = ladder[0];
  if (dispatcher) {
    const dial = twiml.dial({
      action: url('/dial-status'),
      method: 'POST',
      timeout: 20,
      callerId: process.env.TWILIO_PHONE_NUMBER,
    });
    dial.number({ url: url('/ivr/tech-whisper'), method: 'POST' }, dispatcher.phone);
  } else {
    // No locksmiths in DB at all — go straight to voicemail
    twiml.redirect({ method: 'POST' }, url('/ivr/emergency/voicemail'));
  }

  res.type('text/xml').send(twiml.toString());
});

// Whisper played to the receiving party before bridging
router.post('/tech-whisper', (req, res) => {
  const twiml = new VoiceResponse();
  const gather = twiml.gather({ numDigits: '1', timeout: 10 });
  gather.say({ voice: VOICE },
    'Incoming emergency lockout call from Fast Lock Finder. Press any key to accept.'
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
