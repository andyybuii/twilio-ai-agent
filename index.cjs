const express = require("express");
const twilio = require("twilio");

const app = express();

app.use(express.urlencoded({ extended: false }));

// ---------- ENV VARS ----------
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  OWNER_NUMBER,
  PUBLIC_BASE_URL,
  PORT,
  BUSINESS_NAME,
} = process.env;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}

// Health check
app.get("/", (req, res) => {
  res.send("Twilio webhook running ✅");
});

// ---------- MAIN CALL HANDLER ----------
app.post("/voice", (req, res) => {
  try {
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);

    const baseUrl = PUBLIC_BASE_URL;

    const twiml = new twilio.twiml.VoiceResponse();

    const dial = twiml.dial({
      timeout: 30, // LET IT RING LONGER
      action: `${baseUrl}/missed`,
      method: "POST",
    });

    dial.number(OWNER_NUMBER);

    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

// ---------- MISSED CALL HANDLER ----------
app.post("/missed", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    requireEnv("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID);
    requireEnv("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN);
    requireEnv("TWILIO_NUMBER", TWILIO_NUMBER);
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);
    requireEnv("BUSINESS_NAME", BUSINESS_NAME);

    const status = req.body.DialCallStatus;
    const caller = req.body.From;

    console.log("---- MISSED CALL ----");
    console.log("Caller:", caller);
    console.log("Status:", status);

    // If answered, stop
    if (status === "completed") {
      console.log("Answered → No SMS");
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    const client = twilio(
      TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN
    );

    // SMS TO YOU
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `📞 Missed call from ${caller}`,
    });

    // SMS TO CALLER
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: caller,
      body: `Hi, this is ${BUSINESS_NAME}. Sorry we missed your call. Please reply with your name, location and issue and we’ll get back to you ASAP.`,
    });

    console.log("✅ SMS sent to owner & caller");

    twiml.say("Sorry, we missed your call. Please check your messages.");
    twiml.hangup();

    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("Missed error:", err);
    twiml.hangup();
    res.type("text/xml").send(twiml.toString());
  }
});

// ---------- START ----------
const listenPort = PORT || 3000;

app.listen(listenPort, () => {
  console.log("Server running on", listenPort);
});
