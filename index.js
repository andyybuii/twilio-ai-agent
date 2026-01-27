const express = require("express");
const { VoiceResponse } = require("twilio").twiml;
const twilio = require("twilio");
const { DateTime } = require("luxon");

const app = express();

// Twilio sends form-encoded by default
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  OWNER_NUMBER,
  TZ = "Australia/Sydney",
} = process.env;

const client =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

function isBusinessHours() {
  const now = DateTime.now().setZone(TZ);

  // Luxon: 1=Mon ... 7=Sun
  const day = now.weekday;
  const hour = now.hour;
  const minute = now.minute;

  const minutes = hour * 60 + minute;

  // Mon–Fri 07:00–17:00
  if (day >= 1 && day <= 5) return minutes >= 7 * 60 && minutes < 17 * 60;

  // Sat 07:00–12:00
  if (day === 6) return minutes >= 7 * 60 && minutes < 12 * 60;

  // Sun closed
  return false;
}

app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// MAIN VOICE WEBHOOK (Twilio will hit this on incoming calls)
app.post("/voice", async (req, res) => {
  const twiml = new VoiceResponse();

  const from = req.body.From || "Unknown";
  const called = req.body.To || "Unknown";
  const inHours = isBusinessHours();

  // ✅ If during business hours, you can either:
  // A) ring your phone, or
  // B) later point this to your Studio Flow.
  //
  // For now: ring owner during business hours.
  if (inHours) {
    twiml.say(
      "Thanks for calling. Please hold while I connect you."
    );
    twiml.dial({ callerId: called }, OWNER_NUMBER);
    return res.type("text/xml").send(twiml.toString());
  }

  // After hours flow
  twiml.say(
    "Hi. You have reached us after hours. I can take a quick message and we will call you back tomorrow morning."
  );

  // Gather short voice message
  const gather = twiml.gather({
    input: "speech",
    action: "/after-hours",
    method: "POST",
    speechTimeout: "auto",
  });

  gather.say(
    "Please tell me your name, suburb, and what you need help with after the beep."
  );

  twiml.say("Sorry, I didn't catch that. Goodbye.");
  twiml.hangup();

  // Notify owner immediately (SMS + call)
  try {
    if (client && TWILIO_NUMBER && OWNER_NUMBER) {
      await client.messages.create({
        from: TWILIO_NUMBER,
        to: OWNER_NUMBER,
        body: `AFTER-HOURS CALL\nFrom: ${from}\nTo: ${called}\nTime: ${DateTime.now()
          .setZone(TZ)
          .toFormat("ccc dd LLL, h:mm a")}\n\nCaller is leaving a message now.`,
      });

      // quick “notify” call (optional)
      await client.calls.create({
        from: TWILIO_NUMBER,
        to: OWNER_NUMBER,
        twiml: `<Response><Say>After hours call received from ${from.replace(
          "+",
          ""
        )}. You will get an SMS with details.</Say></Response>`,
      });
    }
  } catch (e) {
    console.error("Notify owner failed:", e?.message || e);
  }

  return res.type("text/xml").send(twiml.toString());
});

// Receives the recorded speech text from Gather
app.post("/after-hours", async (req, res) => {
  const twiml = new VoiceResponse();

  const from = req.body.From || "Unknown";
  const speech = req.body.SpeechResult || "(no message captured)";

  // Confirm to caller
  twiml.say("Thanks. We have your message and will call you back tomorrow morning. Goodbye.");
  twiml.hangup();

  // Send message to owner with the captured speech
  try {
    if (client && TWILIO_NUMBER && OWNER_NUMBER) {
      await client.messages.create({
        from: TWILIO_NUMBER,
        to: OWNER_NUMBER,
        body: `AFTER-HOURS MESSAGE\nFrom: ${from}\nTime: ${DateTime.now()
          .setZone(TZ)
          .toFormat("ccc dd LLL, h:mm a")}\n\nMessage:\n${speech}`,
      });
    }
  } catch (e) {
    console.error("Send SMS failed:", e?.message || e);
  }

  return res.type("text/xml").send(twiml.toString());
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
