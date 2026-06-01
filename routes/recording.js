'use strict';

const express = require('express');
const { VoiceResponse } = require('twilio').twiml;
const { getSession, deleteSession } = require('../lib/session');
const db = require('../lib/db');

const router = express.Router();

router.post('/', async (req, res) => {
  const callSid      = req.body.CallSid;
  const recordingUrl = req.body.RecordingUrl;
  const session      = getSession(callSid);

  if (session && recordingUrl) {
    try {
      await db.saveRecording({
        callLogId:    session.callLogId,
        jobId:        session.jobId,
        recordingUrl: recordingUrl + '.mp3',
      });
    } catch (err) {
      console.error('Supabase recording update error:', err.message);
    }
  }

  deleteSession(callSid);

  const twiml = new VoiceResponse();
  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
