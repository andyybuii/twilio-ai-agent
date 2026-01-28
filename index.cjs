const express = require("express");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");

// ================= ENV =================

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  OWNER_NUMBER,
  BUSINESS_NAME,

  SENDGRID_API_KEY,
  EMAIL_TO,
  EMAIL_FROM,

  PORT,
} = process.env;

// ================= CHECK ENV =================

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing env var: ${name}`);
  }
}

[
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_NUMBER",
  "OWNER_NUMBER",
].forEach(requireEnv);

// ================= SENDGRID =================

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

console.log("SENDGRID CHECK:", {
  hasKey: !!SENDGRID_API_KEY,
  hasTo: !!EMAIL_TO,
  hasFrom: !!EMAIL_FROM,
});

// ================= TWILIO =================

const client = twilio(
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN
);

// ================= APP =================

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ================= VOICE =================

// Incoming call
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const dial = twiml.dial({
    action: "/post_dial",
    timeout: 20,
    answerOnBridge: true,
  });

  dial.number(OWNER_NUMBER);

  res.type("text/xml");
  res.send(twiml.toString());
});

// ================= POST DIAL =================

app.post("/post_dial", async (req, res) => {
  try {
    const {
      DialCallStatus,
      DialCallDuration,
      AnsweredBy,
      From,
    } = req.body;

    const caller = From;
    const dialCallStatus = DialCallStatus;
    const dialCallDuration = Number(DialCallDuration || 0);
    const answeredBy = AnsweredBy || "";

    console.log("---- /post_dial ----");
    console.log({
      caller,
      dialCallStatus,
      dialCallDuration,
      answeredBy,
    });

    const consideredAnswered =
      dialCallStatus === "completed" &&
      dialCallDuration > 5;

    console.log("consideredAnswered:", consideredAnswered);

    const twiml = new twilio.twiml.VoiceResponse();

    // If answered, end call
    if (consideredAnswered) {
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    // ================= MISSED CALL =================

    // SMS to owner
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `📞 Missed call from ${caller}`,
    });

    // SMS to caller
    if (typeof caller === "string" && caller.startsWith("+")) {
      await client.messages.create({
        from: TWILIO_NUMBER,
        to: caller,
        body: `Hi, this is ${
          BUSINESS_NAME || "our office"
        }. Sorry we missed your call. Please reply with your name, location, and issue.`,
      });
    }

    console.log("✅ SMS sent to owner + caller");

    // ================= EMAIL =================

    if (SENDGRID_API_KEY && EMAIL_TO && EMAIL_FROM) {
      try {
        await sgMail.send({
          to: EMAIL_TO,
          from: EMAIL_FROM,
          subject: `${BUSINESS_NAME || "Missed call"}: ${caller}`,
          text: `Missed call alert

From: ${caller}
Status: ${dialCallStatus}
AnsweredBy: ${answeredBy || "n/a"}
Time: ${new Date().toISOString()}`,
        });

        console.log("✅ Email sent");
      } catch (e) {
        console.error(
          "❌ Email failed:",
          e?.response?.body || e?.message || e
        );
      }
    } else {
      console.log("⚠️ Email skipped - missing env vars");
    }

    twiml.hangup();
    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("❌ /post_dial error:", err);

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.hangup();

    res.type("text/xml").send(twiml.toString());
  }
});

// ================= SERVER =================

const listenPort = PORT || 3000;

app.listen(listenPort, () => {
  console.log(`🚀 Server running on port ${listenPort}`);
});
