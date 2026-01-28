const express = require("express");
const twilio = require("twilio");

const sgMail = require("@sendgrid/mail");

const {
  SENDGRID_API_KEY,
  EMAIL_TO,
  EMAIL_FROM,
} = process.env;

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

const app = express();
app.use(express.urlencoded({ extended: false }));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  OWNER_NUMBER,
  BUSINESS_NAME,
  PORT,
} = process.env;

console.log("ENV CHECK:", {
  hasBusinessName: !!process.env.BUSINESS_NAME,
  businessName: process.env.BUSINESS_NAME || null,
});

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}

app.get("/", (req, res) => res.status(200).send("OK ✅"));

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Tune these
const RING_TIMEOUT_SECONDS = 25;
const ANSWERED_THRESHOLD_SECONDS = 12;

// 1) Incoming call -> forward to owner
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);
    requireEnv("TWILIO_NUMBER", TWILIO_NUMBER);

    const dial = twiml.dial({
      timeout: RING_TIMEOUT_SECONDS,
      action: "/post_dial",
      method: "POST",
      callerId: TWILIO_NUMBER,
      answerOnBridge: true,
    });

    // ✅ Enable machine detection so we can tell human vs voicemail
    dial.number(
      {
        machineDetection: "Enable",
        machineDetectionTimeout: 8,
      },
      OWNER_NUMBER
    );

    return res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error("❌ /voice error:", e);
    twiml.say("Sorry, an error occurred.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});

// 2) After dial ends -> decide if missed -> send SMS
app.post("/post_dial", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    requireEnv("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID);
    requireEnv("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN);
    requireEnv("TWILIO_NUMBER", TWILIO_NUMBER);
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);
    const businessName = BUSINESS_NAME || "our team";

    const caller = req.body.From || "Unknown caller";
    const dialCallStatus = (req.body.DialCallStatus || "").toLowerCase(); // completed, no-answer, busy, failed, canceled
    const dialCallDuration = parseInt(req.body.DialCallDuration || "0", 10);
    const answeredBy =
      (req.body.DialCallAnsweredBy || req.body.AnsweredBy || "").toLowerCase(); // human / machine / unknown / ""

    console.log("---- /post_dial ----");
    console.log({ caller, dialCallStatus, dialCallDuration, answeredBy });

    // ✅ BEST RULE: only treat as answered if Twilio says human
    const answeredByHuman = answeredBy === "human";

    // Fallback rule: if no answeredBy info, treat as answered only if long enough
    const answeredByDuration =
      dialCallStatus === "completed" && dialCallDuration >= ANSWERED_THRESHOLD_SECONDS;

    const consideredAnswered = answeredBy ? answeredByHuman : answeredByDuration;

    console.log("consideredAnswered:", consideredAnswered);

    if (consideredAnswered) {
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    // MISSED -> send SMS to owner + caller
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `📞 Missed call from ${caller}`,
    });

    // Send email alert too
if (SENDGRID_API_KEY && EMAIL_TO && EMAIL_FROM) {
  await sgMail.send({
    to: EMAIL_TO,
    from: EMAIL_FROM,
    subject: `${BUSINESS_NAME || "Missed call"}: ${caller}`,
    text: `Missed call

From: ${caller}
Status: ${dialCallStatus}
AnsweredBy: ${answeredBy || "n/a"}
Time: ${new Date().toISOString()}`,
  });

  console.log("✅ Email sent");
} else {
  console.log("⚠️ Email skipped - missing env vars");
}

    if (typeof caller === "string" && caller.startsWith("+")) {
      await client.messages.create({
        from: TWILIO_NUMBER,
        to: caller,
        body: `Hi, this is ${businessName}. Sorry we missed your call. Reply with your name, location, and what you need help with — we’ll get back to you ASAP.`,
      });
    }

    console.log("✅ SMS sent to owner + caller");

    twiml.say("Sorry we missed your call. Please check your messages.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error("❌ /post_dial error:", e);
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});

app.listen(PORT || 3000, () => console.log("Server running"));
