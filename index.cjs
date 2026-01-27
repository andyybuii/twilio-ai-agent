const express = require("express");
const twilio = require("twilio");

const app = express();

// Twilio sends webhooks as x-www-form-urlencoded by default
app.use(express.urlencoded({ extended: false }));

// ---------- ENV VARS ----------
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,     // your Twilio number (E.164) e.g. +61468080662
  OWNER_NUMBER,      // your main mobile (E.164) e.g. +61478xxxxxxx
  PUBLIC_BASE_URL,   // e.g. https://nodejs-production-fbbf0.up.railway.app
  PORT,
} = process.env;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}

// ---------- SETTINGS YOU CAN TWEAK ----------
const RING_TIMEOUT_SECONDS = 20;

// If Twilio marks DialCallStatus as "completed" but duration is short,
// it’s usually voicemail pickup. Treat as MISSED if duration < threshold.
const ANSWERED_THRESHOLD_SECONDS = 12;

// Do you also want to SMS the caller when you miss a call?
const SMS_CALLER_TOO = true; // change to false if you don't want this

// ---------- HEALTH CHECK ----------
app.get("/", (req, res) => {
  res.status(200).send("Twilio webhook running ✅");
});

// ---------- MAIN VOICE WEBHOOK ----------
// Twilio Console > Phone Numbers > (your number) > Voice Configuration
// "A call comes in" = Webhook (HTTP POST) to https://YOUR_DOMAIN/voice
app.post("/voice", (req, res) => {
  try {
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);
    requireEnv("PUBLIC_BASE_URL", PUBLIC_BASE_URL);

    const baseUrl = PUBLIC_BASE_URL.replace(/\/$/, ""); // remove trailing slash if any
    const twiml = new twilio.twiml.VoiceResponse();

    // Forward call to your phone, and when it ends Twilio will hit /missed
    const dial = twiml.dial({
      timeout: RING_TIMEOUT_SECONDS,
      action: `${baseUrl}/missed`,
      method: "POST",
    });

    dial.number(OWNER_NUMBER);

    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("Error in /voice:", err);
    res.status(500).send("Server error");
  }
});

// ---------- MISSED CALL HANDLER ----------
// Twilio POSTs here after Dial ends, with DialCallStatus + DialCallDuration
app.post("/missed", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    requireEnv("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID);
    requireEnv("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN);
    requireEnv("TWILIO_NUMBER", TWILIO_NUMBER);
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);

    const dialCallStatus = req.body.DialCallStatus || ""; // completed, busy, no-answer, failed, canceled
    const dialCallDuration = parseInt(req.body.DialCallDuration || "0", 10); // seconds
    const caller = req.body.From || "Unknown caller";

    console.log("---- /missed ----");
    console.log("Caller:", caller);
    console.log("DialCallStatus:", dialCallStatus);
    console.log("DialCallDuration:", dialCallDuration);

    // Consider it answered only if it was "completed" AND long enough
    const consideredAnswered =
      dialCallStatus === "completed" &&
      dialCallDuration >= ANSWERED_THRESHOLD_SECONDS;

    console.log("consideredAnswered:", consideredAnswered);

    // If answered (long enough), do nothing
    if (consideredAnswered) {
      console.log("Answered (long enough) -> no SMS");
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    // Otherwise: treat as missed
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    console.log("Sending missed call SMS to owner...");

    // 1) SMS YOU
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `Missed call from ${caller}`,
    });

    console.log("✅ Owner SMS sent");

    // 2) OPTIONAL: SMS the caller too
    if (SMS_CALLER_TOO && caller && caller.startsWith("+")) {
      console.log("Sending missed call SMS to caller...");
      await client.messages.create({
        from: TWILIO_NUMBER,
        to: caller,
        body: `Sorry we missed your call. Reply with your name + what you need and we'll get back to you ASAP.`,
      });
      console.log("✅ Caller SMS sent");
    } else {
      console.log("Caller SMS disabled or invalid caller number");
    }

    // What caller hears on the phone call
    twiml.say("Sorry, we missed your call. We'll get back to you shortly.");
    twiml.hangup();

    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("Error in /missed:", err);
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});

// ---------- START SERVER ----------
const listenPort = PORT || 3000;
app.listen(listenPort, () => {
  console.log(`Server running on port ${listenPort}`);
});
