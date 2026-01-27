const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  OWNER_NUMBER,
  PORT,
} = process.env;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}

app.get("/", (req, res) => {
  res.status(200).send("Twilio webhook running ✅");
});

app.post("/voice", (req, res) => {
  try {
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);

    const twiml = new twilio.twiml.VoiceResponse();

    const dial = twiml.dial({
      timeout: 20,
      // ✅ relative URL so it NEVER breaks if domain/env changes
      action: "/missed",
      method: "POST",
    });

    dial.number(OWNER_NUMBER);

    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("Error in /voice:", err);
    return res.status(500).send("Server error");
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
    const dialCallStatus = req.body.DialCallStatus;
    const dialDuration = parseInt(req.body.DialCallDuration || "0", 10);

    console.log("---- /missed ----");
    console.log("Caller:", caller);
    console.log("DialCallStatus:", dialCallStatus);
    console.log("DialCallDuration:", dialDuration);

    // If you answered (completed + duration), do nothing
    if (dialCallStatus === "completed" && dialDuration > 0) {
      console.log("Answered -> no SMS");
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    console.log("Sending SMS...");
    const msg = await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `Missed call from ${caller}`,
    });

    console.log("✅ SMS created:", msg.sid, "status:", msg.status);

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
