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
  PUBLIC_BASE_URL, // e.g. https://nodejs-production-fbbf0.up.railway.app
  PORT,
} = process.env;

// Basic safety check (helps debugging if env vars missing)
function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}

// Helper to build absolute URLs (Twilio is happier with absolute URLs)
function absUrl(path) {
  requireEnv("PUBLIC_BASE_URL", PUBLIC_BASE_URL);
  const base = PUBLIC_BASE_URL.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

app.get("/", (req, res) => {
  res.status(200).send("Twilio webhook running ✅");
});

// --------- MAIN VOICE WEBHOOK ---------
// Twilio Voice -> "A call comes in" should point here: /voice (HTTP POST)
app.post("/voice", (req, res) => {
  try {
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);
    requireEnv("PUBLIC_BASE_URL", PUBLIC_BASE_URL);

    const from = req.body.From || "Unknown caller";
    console.log("---- /voice ----");
    console.log("Incoming From:", from);

    const twiml = new twilio.twiml.VoiceResponse();

    // Forward to you first
    const dial = twiml.dial({
      timeout: 20,
      action: absUrl("/missed"), // IMPORTANT: absolute URL
      method: "POST",
    });

    dial.number(
      {
        // Extra logging (optional but very helpful)
        statusCallback: absUrl("/dial-status"),
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      },
      OWNER_NUMBER
    );

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (err) {
    console.error("Error in /voice:", err);

    // Always respond with TwiML even on error
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Sorry, an error occurred.");
    twiml.hangup();

    res.type("text/xml");
    res.send(twiml.toString());
  }
});

// --------- DIAL STATUS CALLBACK (DEBUG) ---------
app.post("/dial-status", (req, res) => {
  console.log("---- /dial-status ----");
  console.log("Dial status callback:", req.body);
  res.sendStatus(200);
});

// --------- MISSED CALL HANDLER ---------
// Triggered after the Dial attempt ends.
// We only send SMS + call you back if NOT answered.
app.post("/missed", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    requireEnv("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID);
    requireEnv("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN);
    requireEnv("TWILIO_NUMBER", TWILIO_NUMBER);
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);

    console.log("---- /missed ----");

    const caller = req.body.From || "Unknown caller";
    const dialCallStatus = req.body.DialCallStatus; // completed, busy, no-answer, failed, canceled

    console.log("From (caller):", caller);
    console.log("DialCallStatus:", dialCallStatus);
    console.log("TWILIO_NUMBER:", TWILIO_NUMBER);
    console.log("OWNER_NUMBER:", OWNER_NUMBER);

    // If you answered the call, do nothing.
    if (dialCallStatus === "completed") {
      twiml.hangup();
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    // 1) Send SMS to you
    console.log("Sending SMS...");
    const sms = await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `Missed call from ${caller}`,
    });
    console.log("SMS sent. SID:", sms.sid);

    // 2) Call you back with a spoken message
    console.log("Placing callback call...");
    const call = await client.calls.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      twiml: `<Response><Say voice="alice">You missed a call from ${caller}.</Say></Response>`,
    });
    console.log("Callback call created. SID:", call.sid);

    // What the original caller hears
    twiml.say("Sorry, we missed your call. We will call you back shortly.");
    twiml.hangup();

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (err) {
    console.error("Error in /missed:", err);

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
