require('dotenv').config();

const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: false }));

// Routes
const voiceRouter       = require('./routes/voice');
const emergencyRouter   = require('./routes/emergency');
const appointmentRouter = require('./routes/appointment');
const statusRouter      = require('./routes/status');
const dialStatusRouter  = require('./routes/dialStatus');
const recordingRouter   = require('./routes/recording');
const dispatchRouter    = require('./routes/dispatch');

app.use('/voice',              voiceRouter);
app.use('/ivr/emergency',      emergencyRouter);
app.use('/ivr/appointment',    appointmentRouter);
app.use('/ivr/status',         statusRouter);
app.use('/dial-status',        dialStatusRouter);
app.use('/recording-callback', recordingRouter);
app.use('/transcription-callback', recordingRouter);
app.use('/dispatch',           dispatchRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Fast Lock Finder dispatch server running on port ${port}`));
