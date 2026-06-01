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

function retryTwiml(twiml, message, retryPath) {
  twiml.say({ voice: VOICE }, message);
  twiml.redirect({ method: 'POST' }, url(retryPath));
  return twiml.toString();
}

router.post('/start', (req, res) => {
  const session = getSession(req.body.CallSid);
  if (session) session.flowType = 'appointment';
  const twiml = new VoiceResponse();
  speechGather(twiml, 'You have reached Appointment Scheduling. Please say your full name.', '/ivr/appointment/name', '/ivr/appointment/start');
  res.type('text/xml').send(twiml.toString());
});

router.post('/name', (req, res) => {
  const speech = (req.body.SpeechResult || '').trim();
  const twiml = new VoiceResponse();
  if (!speech) return res.type('text/xml').send(retryTwiml(twiml, "Sorry, I didn't catch that.", '/ivr/appointment/start'));
  const session = getSession(req.body.CallSid);
  if (session) session.callerName = speech;
  speechGather(twiml, 'Please say the service address.', '/ivr/appointment/address', '/ivr/appointment/name');
  res.type('text/xml').send(twiml.toString());
});

router.post('/address', (req, res) => {
  const speech = (req.body.SpeechResult || '').trim();
  const twiml = new VoiceResponse();
  if (!speech) return res.type('text/xml').send(retryTwiml(twiml, "Sorry, I didn't catch the address.", '/ivr/appointment/address'));
  const session = getSession(req.body.CallSid);
  if (session) session.serviceAddress = speech;
  speechGather(twiml, 'Please say the vehicle make and model.', '/ivr/appointment/vehicle', '/ivr/appointment/address');
  res.type('text/xml').send(twiml.toString());
});

router.post('/vehicle', (req, res) => {
  const speech = (req.body.SpeechResult || '').trim();
  const twiml = new VoiceResponse();
  if (!speech) return res.type('text/xml').send(retryTwiml(twiml, "Sorry, I didn't catch the vehicle information.", '/ivr/appointment/vehicle'));
  const session = getSession(req.body.CallSid);
  if (session) session.vehicleMakeModel = speech;
  speechGather(twiml, 'Please say your preferred date.', '/ivr/appointment/date', '/ivr/appointment/vehicle');
  res.type('text/xml').send(twiml.toString());
});

router.post('/date', (req, res) => {
  const speech = (req.body.SpeechResult || '').trim();
  const twiml = new VoiceResponse();
  if (!speech) return res.type('text/xml').send(retryTwiml(twiml, "Sorry, I didn't catch the date.", '/ivr/appointment/date'));
  const session = getSession(req.body.CallSid);
  if (session) session.preferredDate = speech;
  speechGather(twiml, 'Please say your preferred time.', '/ivr/appointment/time', '/ivr/appointment/date');
  res.type('text/xml').send(twiml.toString());
});

router.post('/time', async (req, res) => {
  const speech = (req.body.SpeechResult || '').trim();
  const twiml = new VoiceResponse();
  if (!speech) return res.type('text/xml').send(retryTwiml(twiml, "Sorry, I didn't catch the time.", '/ivr/appointment/time'));

  const session = getSession(req.body.CallSid);
  if (session) session.preferredTime = speech;

  try {
    const notes = `Date: ${session.preferredDate || ''}, Time: ${speech}`;
    const leadId = await db.createLead({
      name:        session.callerName || 'Unknown',
      phone:       session.callerPhone,
      serviceType: 'Appointment',
      address:     session.serviceAddress || '',
      vehicle:     session.vehicleMakeModel || '',
    });
    const { jobId, jobNumber } = await db.createJob({
      leadId,
      jobType: `Appointment — ${notes}`,
    });
    session.leadId    = leadId;
    session.jobId     = jobId;
    session.jobNumber = jobNumber;
  } catch (err) {
    console.error('Supabase create error (appointment):', err.message);
  }

  const jobMsg = session && session.jobNumber
    ? `Your appointment has been scheduled. Your reference number is ${session.jobNumber}. `
    : 'Your appointment has been scheduled. ';

  twiml.say({ voice: VOICE }, `${jobMsg}Transferring you to our dispatcher now. Please hold.`);

  // Load dispatcher from DB
  let dispatcherPhone = null;
  try {
    const ladder = await db.getEscalationLadder();
    if (ladder.length) dispatcherPhone = ladder[0].phone;
  } catch (err) {
    console.error('Failed to load dispatcher:', err.message);
  }

  if (dispatcherPhone) {
    const dial = twiml.dial({
      action: url('/dial-status'),
      method: 'POST',
      timeout: 20,
      callerId: process.env.TWILIO_PHONE_NUMBER,
    });
    dial.number(dispatcherPhone);
  } else {
    twiml.say({ voice: VOICE }, 'Our dispatcher is unavailable. We will call you back shortly. Goodbye.');
    twiml.hangup();
  }

  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
