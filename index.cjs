const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  OWNER_NUMBER,
  PUBLIC_BASE_URL, // https://nodejs-production-fbbf0.up.railway.app
  PORT,
} = process.env;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}

app.get("/", (req, res) => res.status(200).send("Twilio webhook running ✅"));

app.post("/voice", (req, res) => {
  try {
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);

    const baseUrl = (PUBLIC_BASE_URL || "").replace(/\/$/, "");
    if (!baseUrl) throw new Error("Missing env var: PUBLIC_BASE_URL");

    const twiml = new twilio.twiml.VoiceResponse();

    const dial = twiml.dial({
      timeout: 20,
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

app.post("/missed", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    requireEnv("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID);
    requireEnv("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN);
    requireEnv("TWILIO_NUMBER", TWILIO_NUMBER);
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);

    const caller = req.body.From || "Unknown caller";
    const dialCallStatus = req.body.DialCallStatus; // completed, busy, no-answer, failed, canceled

    console.log("---- /missed ----");
    console.log("Caller:", caller);
    console.log("DialCallStatus:", dialCallStatus);

    // If the dial leg connected, you answered (or voicemail picked up).
    // We ONLY treat as missed if it did NOT complete.
    const MISSED_STATUSES = new Set(["no-answer", "busy", "failed", "canceled"]);
    const isMissed = MISSED_STATUSES.has(dialCallStatus);

    if (!isMissed) {
      console.log("Not missed -> no SMS");
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    // 1) SMS to you
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `Missed call from ${caller}`,
    });

    // 2) SMS to caller (only if it’s a real number)
    if (caller && caller.startsWith("+")) {
      await client.messages.create({
        from: TWILIO_NUMBER,
        to: caller,
        body:
          "Sorry we missed your call. Reply with your name + what you need and we’ll get back to you ASAP.",
      });
    }

    // What caller hears
    twiml.say("Sorry, we missed your call. Please text us your name and what you need.");
    twiml.hangup();

    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("Error in /missed:", err);
    twiml.say("Sorry, an error occurred.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});

const listenPort = PORT || 3000;
app.listen(listenPort, () => console.log(`Server running on port ${listenPort}`));
