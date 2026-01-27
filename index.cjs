const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  OWNER_NUMBER,
  PUBLIC_BASE_URL,
  PORT,
} = process.env;

function must(name, val) {
  if (!val) throw new Error(`Missing env var: ${name}`);
}

function getBaseUrl(req) {
  // Prefer env var, fallback to host header
  // (Railway gives https, Twilio hits https)
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/$/, "");
  return `https://${req.headers.host}`;
}

app.get("/", (req, res) => res.status(200).send("OK ✅"));

/**
 * Twilio Voice webhook
 * Twilio Console -> Phone Number -> Voice -> A call comes in
 * POST https://YOUR_DOMAIN/voice
 */
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    must("OWNER_NUMBER", OWNER_NUMBER);

    const baseUrl = getBaseUrl(req);

    const dial = twiml.dial({
      timeout: 20,
      answerOnBridge: true,
      action: `${baseUrl}/missed`,
      method: "POST",
    });

    // Enable machine detection so voicemail != human
    dial.number(
      {
        machineDetection: "Enable",
        machineDetectionTimeout: 5,
      },
      OWNER_NUMBER
    );

    return res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error("❌ /voice error:", e.message);
    twiml.say("Sorry, an error occurred.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});

/**
 * Called by Twilio AFTER the dial attempt
 * We only send SMS if not answered by a HUMAN
 */
app.post("/missed", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    must("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID);
    must("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN);
    must("TWILIO_NUMBER", TWILIO_NUMBER);
    must("OWNER_NUMBER", OWNER_NUMBER);

    const caller = req.body.From || "Unknown caller";
    const dialCallStatus = req.body.DialCallStatus; // completed, no-answer, busy, failed, canceled
    const answeredBy =
      req.body.DialCallAnsweredBy || req.body.AnsweredBy || ""; // human / machine / fax / unknown / ""

    console.log("---- /missed ----");
    console.log({ caller, dialCallStatus, answeredBy, body: req.body });

    // ✅ If human answered, do nothing
    if (answeredBy === "human") {
      console.log("Answered by human -> no SMS");
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    // 1) SMS YOU
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `Missed call from ${caller}`,
    });

    // 2) SMS CALLER (auto-reply)
    // NOTE: Caller must be able to receive SMS + your number must be SMS-capable for that destination
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: caller,
      body: `Sorry we missed your call. Reply with your name + what you need and we'll get back to you ASAP.`,
    });

    console.log("✅ Sent SMS to owner + caller");

    // What caller hears on the phone
    twiml.say("Sorry, we missed your call. Please send us a text and we will get back to you shortly.");
    twiml.hangup();

    return res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error("❌ /missed error:", e);
    twiml.say("Sorry, an error occurred.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});

const listenPort = PORT || 3000;
app.listen(listenPort, () => console.log(`Server running on ${listenPort}`));
