const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded

// ===== ENV =====
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,     // your Twilio number e.g. +61468080662
  OWNER_NUMBER,      // your mobile e.g. +6147xxxxxxxx
  PORT,
} = process.env;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}

requireEnv("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID);
requireEnv("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN);
requireEnv("TWILIO_NUMBER", TWILIO_NUMBER);
requireEnv("OWNER_NUMBER", OWNER_NUMBER);

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Tune these
const RING_TIMEOUT_SECONDS = 25;         // how long your phone rings
const ANSWERED_THRESHOLD_SECONDS = 12;   // >= this = answered, < this = missed (voicemail/screening/etc)

// Health check
app.get("/", (req, res) => res.status(200).send("OK ✅"));

// =====================
// 1) INBOUND CALL WEBHOOK
// Twilio Console > Phone Numbers > (your number) > Voice:
// "A call comes in" = POST https://YOUR_DOMAIN/voice
// =====================
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const caller = req.body.From || "Unknown";
    console.log("---- /voice ----");
    console.log("From:", caller, "To:", req.body.To);

    // Dial your mobile
    const dial = twiml.dial({
      timeout: RING_TIMEOUT_SECONDS,
      action: "/post_dial",
      method: "POST",

      // ✅ helps mobile carriers treat it like a real call
      callerId: TWILIO_NUMBER,

      // ✅ don’t connect the original caller until you actually answer
      answerOnBridge: true,
    });

    // OPTIONAL: enable Twilio machine detection to help avoid voicemail counting as "answered"
    // This can add ~1-2s delay sometimes.
    dial.number(
      { machineDetection: "Enable", machineDetectionTimeout: 8 },
      OWNER_NUMBER
    );

    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("Error in /voice:", err);
    twiml.say("Sorry, an error occurred.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});

// =====================
// 2) POST-DIAL CALLBACK
// Twilio hits this AFTER the dial attempt ends.
// We decide answered vs missed and send SMS.
// =====================
app.post("/post_dial", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const caller = req.body.From || "Unknown";
    const dialCallStatus = req.body.DialCallStatus || "";     // completed, no-answer, busy, failed, canceled
    const dialCallDuration = parseInt(req.body.DialCallDuration || "0", 10); // seconds
    const answeredBy = req.body.DialCallAnsweredBy || req.body.AnsweredBy || ""; // sometimes present if machineDetection enabled

    console.log("---- /post_dial ----");
    console.log("Caller:", caller);
    console.log("DialCallStatus:", dialCallStatus);
    console.log("DialCallDuration:", dialCallDuration);
    console.log("AnsweredBy:", answeredBy);

    // If you call your own Twilio number to test, don’t spam yourself
    const isSelfTest = caller === OWNER_NUMBER;

    // Decide answered vs missed:
    // - If duration is long enough, assume answered
    // - Otherwise treat as missed (even if Twilio says "completed" because voicemail can complete)
    const answered =
      dialCallStatus === "completed" && dialCallDuration >= ANSWERED_THRESHOLD_SECONDS;

    if (answered) {
      console.log("✅ Answered (by duration) -> no SMS");
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    console.log("❌ Missed -> sending SMS");

    // 1) SMS to you (owner)
    if (!isSelfTest) {
      await client.messages.create({
        from: TWILIO_NUMBER,
        to: OWNER_NUMBER,
        body: `Missed call from ${caller} (status: ${dialCallStatus}, duration: ${dialCallDuration}s)`,
      });
    }

    // 2) SMS to caller (auto-reply)
    // Only send if caller looks like a real phone number (starts with +)
    if (!isSelfTest && typeof caller === "string" && caller.startsWith("+")) {
      await client.messages.create({
        from: TWILIO_NUMBER,
        to: caller,
        body:
          "Hi, this is Andy. Sorry we missed your call. Reply with your name, suburb/location, and what you need — we’ll get back to you ASAP.",
      });
    }

    // What caller hears
    twiml.say("Sorry, we missed your call. Please check your SMS for next steps. Goodbye.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("Error in /post_dial:", err);
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});

const listenPort = PORT || 3000;
app.listen(listenPort, () => {
  console.log(`Server running on port ${listenPort}`);
});
