const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  OWNER_NUMBER,
  PUBLIC_BASE_URL, // e.g. https://nodejs-production-fbbf0.up.railway.app
  PORT,
} = process.env;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}

app.get("/", (req, res) => {
  res.status(200).send("Twilio webhook running ✅");
});

// Voice webhook: Twilio phone number -> Voice -> A call comes in -> POST /voice
app.post("/voice", (req, res) => {
  try {
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);
    requireEnv("PUBLIC_BASE_URL", PUBLIC_BASE_URL);

    const twiml = new twilio.twiml.VoiceResponse();

    const dial = twiml.dial({
      timeout: 20,
      action: `${PUBLIC_BASE_URL}/missed`, // MUST be full URL
      method: "POST",
    });

    dial.number(OWNER_NUMBER);

    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("Error in /voice:", err);
    res.status(500).send("Server error");
  }
});

// Called after Dial ends
app.post("/missed", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    requireEnv("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID);
    requireEnv("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN);
    requireEnv("TWILIO_NUMBER", TWILIO_NUMBER);
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);

    const dialCallStatus = req.body.DialCallStatus; // completed, busy, no-answer, failed, canceled
    const caller = req.body.From || "Unknown caller";

    console.log("---- /missed ----");
    console.log("Caller:", caller);
    console.log("DialCallStatus:", dialCallStatus);

    // If you answered, do nothing
    if (dialCallStatus === "completed") {
      console.log("Answered -> no SMS");
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    // Otherwise missed -> send SMS to you
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    console.log("Sending missed call SMS...");

    const msg = await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `Missed call from ${caller}`,
    });

    console.log("✅ SMS created:", msg.sid);

    // What caller hears
    twiml.say("Sorry, we missed your call. We'll get back to you shortly.");
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
app.listen(listenPort, () => {
  console.log(`Server running on port ${listenPort}`);
});
