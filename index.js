const express = require("express");
const twilio = require("twilio");

const app = express();

// Twilio sends webhooks as x-www-form-urlencoded by default
app.use(express.urlencoded({ extended: false }));

// --------- ENV VARS ---------
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  OWNER_NUMBER,
  PORT,
} = process.env;

// Basic safety check (helps debugging if env vars missing)
function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}

app.get("/", (req, res) => {
  res.status(200).send("Twilio webhook running ✅");
});

// --------- MAIN VOICE WEBHOOK ---------
// Twilio Voice -> "A call comes in" should point here: /voice (HTTP POST)
app.post("/voice", (req, res) => {
  try {
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);

    const twiml = new twilio.twiml.VoiceResponse();

    // Try calling you first (so it's NOT treated as "missed" unless you don't answer)
    const dial = twiml.dial({
      timeout: 20, // seconds it rings your phone
      action: "/missed", // Twilio will POST here after the dial attempt ends
      method: "POST",
    });

    dial.number(OWNER_NUMBER);

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (err) {
    console.error("Error in /voice:", err);
    res.status(500).send("Server error");
  }
});

// --------- MISSED CALL HANDLER ---------
// This is triggered after the Dial attempt.
// We only send SMS + call you back if the Dial was NOT answered.
app.post("/missed", async (req, res) => {
  try {
    requireEnv("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID);
    requireEnv("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN);
    requireEnv("TWILIO_NUMBER", TWILIO_NUMBER);
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);

    const caller = req.body.From || "Unknown caller";
    const dialCallStatus = req.body.DialCallStatus; // completed, busy, no-answer, failed, canceled

    console.log("Caller:", caller);
    console.log("DialCallStatus:", dialCallStatus);

    const twiml = new twilio.twiml.VoiceResponse();

    // If you answered the call, do nothing.
    if (dialCallStatus === "completed") {
      twiml.hangup();
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    // 1) Send SMS to you
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `Missed call from ${caller}`,
    });

    // 2) Call you back with a spoken message
    await client.calls.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      twiml: `<Response><Say voice="alice">You missed a call from ${caller}.</Say></Response>`,
    });

    // What the original caller hears
    twiml.say("Sorry, we missed your call. We will call you back shortly.");
    twiml.hangup();

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (err) {
    console.error("Error in /missed:", err);

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Sorry, an error occurred.");
    twiml.hangup();

    res.type("text/xml");
    res.send(twiml.toString());
  }
});

// --------- START SERVER ---------
const listenPort = PORT || 3000;
app.listen(listenPort, () => {
  console.log(`Server running on port ${listenPort}`);
});
