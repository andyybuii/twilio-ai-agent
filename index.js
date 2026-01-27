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

// Twilio Voice webhook: set your phone number "A call comes in" to POST https://<railway-url>/voice
app.post("/voice", (req, res) => {
  try {
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);

    const vr = new twilio.twiml.VoiceResponse();

    const dial = vr.dial({
      timeout: 20,
      action: "/missed",
      method: "POST",
    });

    dial.number(OWNER_NUMBER);

    res.type("text/xml");
    res.send(vr.toString());
  } catch (err) {
    console.error("Error in /voice:", err);
    res.status(500).send("Server error");
  }
});

// Called after Dial finishes. If not answered -> send SMS + call owner back.
app.post("/missed", async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  try {
    requireEnv("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID);
    requireEnv("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN);
    requireEnv("TWILIO_NUMBER", TWILIO_NUMBER);
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);

    const caller = req.body.From || "Unknown caller";
    const dialCallStatus = req.body.DialCallStatus; // completed, busy, no-answer, failed, canceled

    console.log("---- /missed ----");
    console.log("From (caller):", caller);
    console.log("DialCallStatus:", dialCallStatus);
    console.log("TWILIO_NUMBER:", TWILIO_NUMBER);
    console.log("OWNER_NUMBER:", OWNER_NUMBER);

    // If answered (including voicemail), do nothing
    if (dialCallStatus === "completed") {
      vr.hangup();
      res.type("text/xml");
      return res.send(vr.toString());
    }

    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    // 1) SMS you
    try {
      console.log("Sending SMS...");
      const msg = await client.messages.create({
        from: TWILIO_NUMBER,
        to: OWNER_NUMBER,
        body: `Missed call from ${caller}`,
      });
      console.log("SMS sent. SID:", msg.sid);
    } catch (e) {
      console.error("SMS FAILED:", e?.message || e);
      if (e?.code) console.error("SMS Twilio code:", e.code);
      if (e?.moreInfo) console.error("SMS moreInfo:", e.moreInfo);
    }

    // 2) Call you back with a spoken message
    try {
      console.log("Placing callback call...");
      const call = await client.calls.create({
        from: TWILIO_NUMBER,
        to: OWNER_NUMBER,
        twiml: `<Response><Say voice="alice">You missed a call from ${caller}.</Say></Response>`,
      });
      console.log("Callback call created. SID:", call.sid);
    } catch (e) {
      console.error("CALLBACK FAILED:", e?.message || e);
      if (e?.code) console.error("CALLBACK Twilio code:", e.code);
      if (e?.moreInfo) console.error("CALLBACK moreInfo:", e.moreInfo);
    }

    // What the original caller hears
    vr.say("Sorry, we missed your call. We will call you back shortly.");
    vr.hangup();

    res.type("text/xml");
    res.send(vr.toString());
  } catch (err) {
    console.error("Error in /missed (outer):", err);

    vr.say("Sorry, an error occurred.");
    vr.hangup();

    res.type("text/xml");
    res.send(vr.toString());
  }
});

const listenPort = PORT || 3000;
app.listen(listenPort, () => {
  console.log(`Server running on port ${listenPort}`);
});
