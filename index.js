const express = require("express");
const { DateTime } = require("luxon");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

// Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Business hours config
const TZ = process.env.TZ || "Australia/Sydney";
const OWNER = process.env.OWNER_NUMBER;
const FROM = process.env.TWILIO_NUMBER;

// Check business hours
function isBusinessHours() {
  const now = DateTime.now().setZone(TZ);

  const day = now.weekday; // 1 = Mon, 7 = Sun
  const hour = now.hour;

  // Mon–Fri 7am–5pm
  if (day >= 1 && day <= 5) {
    return hour >= 7 && hour < 17;
  }

  // Sat 7am–12pm
  if (day === 6) {
    return hour >= 7 && hour < 12;
  }

  return false;
}

// Voice webhook
app.post("/voice", async (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  if (isBusinessHours()) {
    twiml.say(
      "Thanks for calling. We are currently open. Please stay on the line."
    );
  } else {
    twiml.say(
      "Thanks for calling. We are currently closed. We will call you back tomorrow morning."
    );

    const caller = req.body.From;

    // Send SMS
    await client.messages.create({
      from: FROM,
      to: OWNER,
      body: `Missed call from ${caller}`
    });

    // Call owner
    await client.calls.create({
      from: FROM,
      to: OWNER,
      twiml: "<Response><Say>You have a missed call.</Say></Response>"
    });
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// Health check
app.get("/", (req, res) => {
  res.send("Twilio webhook running");
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
