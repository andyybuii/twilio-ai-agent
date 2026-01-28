const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,      // your Twilio number +61...
  OWNER_NUMBER,       // your mobile +61...
  BUSINESS_NAME,      // e.g. "XYZ Plumbing"
  PORT,
} = process.env;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}

// ======================
// TWEAK THESE SETTINGS
// ======================
const RING_TIMEOUT_SECONDS = 20;

// "completed" can mean voicemail answered.
// If the dial leg is completed but duration is short, treat as missed.
// If you genuinely answered, duration is usually longer.
const ANSWERED_THRESHOLD_SECONDS = 12;

// De-dupe: only send 1 missed-call SMS per caller per window
const DEDUPE_WINDOW_MS = 30 * 60 * 1000; // 30 mins

// In-memory dedupe store (fine for V1). Later you can move to Redis/DB.
const lastSentByCaller = new Map();

function recentlySentToCaller(caller) {
  const last = lastSentByCaller.get(caller);
  if (!last) return false;
  return Date.now() - last < DEDUPE_WINDOW_MS;
}

function markSentToCaller(caller) {
  lastSentByCaller.set(caller, Date.now());
}

// Health check
app.get("/", (req, res) => res.status(200).send("OK ✅"));

// ======================
// VOICE WEBHOOK
// Twilio number -> Voice -> A call comes in -> POST /voice
// ======================
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    requireEnv("OWNER_NUMBER", OWNER_NUMBER);

    const dial = twiml.dial({
  timeout: RING_TIMEOUT_SECONDS,
  action: "/post_dial",
  method: "POST",
  callerId: TWILIO_NUMBER,     // ✅ make the outbound leg come from your Twilio number
  answerOnBridge: true         // ✅ don't connect caller until you answer
});

dial.number(OWNER_NUMBER);

    return res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error("❌ /voice error:", e.message);
    twiml.say("Sorry, we are having trouble right now.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});

// ======================
// AFTER DIAL HANDLER
// Twilio hits this after dialing the owner finishes.
// Decide if it was truly answered.
// ======================
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
    const dialCallDuration = parseInt(req.body.DialCallDuration || "0", 10); // seconds

    console.log("---- /post_dial ----");
    console.log({ caller, dialCallStatus, dialCallDuration });

    // Consider "answered" only if completed AND duration >= threshold
    const consideredAnswered =
      dialCallStatus === "completed" && dialCallDuration >= ANSWERED_THRESHOLD_SECONDS;

    console.log("consideredAnswered:", consideredAnswered);

    if (consideredAnswered) {
      // Call handled by owner (real conversation) → nothing else
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    // If caller is invalid or hidden, still notify owner but skip texting caller
    const canTextCaller = typeof caller === "string" && caller.startsWith("+");

    // De-dupe so you don't spam caller if they redial repeatedly
    const dedupeKey = canTextCaller ? caller : null;
    const shouldDedupe = dedupeKey && recentlySentToCaller(dedupeKey);

    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    // 1) SMS OWNER always (you want this every time)
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `Missed call from ${caller} (status: ${dialCallStatus})`,
    });

    console.log("✅ Owner SMS sent");

    // 2) SMS CALLER (only if valid + not deduped)
    if (canTextCaller && !shouldDedupe) {
      await client.messages.create({
        from: TWILIO_NUMBER,
        to: caller,
        body: `Hi, this is ${businessName}. Sorry we missed your call. Please reply with your name, suburb/location, and what you need help with — we’ll get back to you ASAP.`,
      });

      markSentToCaller(dedupeKey);
      console.log("✅ Caller SMS sent");
    } else {
      console.log(
        canTextCaller
          ? "Caller SMS skipped (deduped)"
          : "Caller SMS skipped (caller not SMS-capable/hidden)"
      );
    }

    // What caller hears when you miss (optional)
    twiml.say("Sorry we missed your call. Please check your messages and reply with your details.");
    twiml.hangup();

    return res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error("❌ /post_dial error:", e);
    twiml.say("Sorry, an error occurred.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});

const listenPort = PORT || 3000;
app.listen(listenPort, () => console.log(`Server listening on ${listenPort}`));
