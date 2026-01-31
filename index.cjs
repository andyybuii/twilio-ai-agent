// index.cjs
const express = require("express");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");
const OpenAI = require("openai");
const crypto = require("crypto");
const Fuse = require("fuse.js");

// -------------------- ENV --------------------
const {
  // Twilio
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  OWNER_NUMBER,
  FORWARD_TO,

  // Business
  BUSINESS_NAME,
  BUSINESS_START,
  BUSINESS_END,
  TIMEZONE,

  // Email (optional)
  SENDGRID_API_KEY,
  EMAIL_TO,
  EMAIL_FROM,

  // OpenAI (optional but recommended for structured extraction)
  OPENAI_API_KEY,
  OPENAI_MODEL,

  // ElevenLabs (optional for more natural voice)
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  PUBLIC_BASE_URL, // e.g. https://nodejs-production-fbbf0.up.railway.app

  // Server
  PORT,
} = process.env;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Required for core forwarding + missed call flow
requireEnv("TWILIO_ACCOUNT_SID");
requireEnv("TWILIO_AUTH_TOKEN");
requireEnv("TWILIO_NUMBER");
requireEnv("OWNER_NUMBER");
requireEnv("FORWARD_TO");
requireEnv("BUSINESS_NAME");
requireEnv("BUSINESS_START");
requireEnv("BUSINESS_END");
requireEnv("TIMEZONE");

// Optional: SendGrid
if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);

// Optional: OpenAI
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const OPENAI_MODEL_SAFE = OPENAI_MODEL || "gpt-4o-mini";

// -------------------- APP SETUP --------------------
const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(express.json());

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// -------------------- LOG ENV CHECK (SAFE) --------------------
console.log("ENV CHECK:", {
  twilio: {
    twilioNumber: TWILIO_NUMBER || null,
    owner: OWNER_NUMBER || null,
    forwardTo: FORWARD_TO || null,
  },
  business: {
    name: BUSINESS_NAME || null,
    start: BUSINESS_START || null,
    end: BUSINESS_END || null,
    timezone: TIMEZONE || null,
  },
  sendgrid: { hasKey: !!SENDGRID_API_KEY, hasTo: !!EMAIL_TO, hasFrom: !!EMAIL_FROM },
  openai: { hasKey: !!OPENAI_API_KEY, model: OPENAI_MODEL_SAFE },
  elevenlabs: { hasKey: !!ELEVENLABS_API_KEY, hasVoiceId: !!ELEVENLABS_VOICE_ID, baseUrl: PUBLIC_BASE_URL || null },
});

// -------------------- TIME HELPERS --------------------
function isWithinBusinessHours() {
  const tz = TIMEZONE || "Australia/Sydney";
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(now)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  const hour = parseInt(parts.hour, 10);
  const start = parseInt(BUSINESS_START, 10);
  const end = parseInt(BUSINESS_END, 10);

  // start=8 end=17 means 8:00–16:59
  return hour >= start && hour < end;
}

function consideredAnswered({ dialCallStatus, answeredBy, dialCallDuration }) {
  if (dialCallStatus === "completed" && Number(dialCallDuration || 0) > 0) return true;
  if (answeredBy && String(answeredBy).trim().length > 0) return true;
  return false;
}

// -------------------- ELEVENLABS HELPERS --------------------
function elevenEnabled() {
  return !!(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && PUBLIC_BASE_URL);
}

function audioUrlFor(text) {
  const base = (PUBLIC_BASE_URL || "").replace(/\/$/, "");
  return `${base}/audio?text=${encodeURIComponent(text)}`;
}

function sayOrPlay(twimlNode, text) {
  if (elevenEnabled()) {
    twimlNode.play(audioUrlFor(text));
    return;
  }
  // fallback
  twimlNode.say({ voice: "alice" }, text);
}

// Streams mp3 from ElevenLabs to Twilio (no caching needed)
app.get("/audio", async (req, res) => {
  try {
    const text = (req.query.text || "").toString().trim();
    if (!text) return res.status(400).send("Missing text");
    if (!elevenEnabled()) return res.status(500).send("ElevenLabs not configured");

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=mp3_44100_128`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          // More human (less robotic)
          stability: 0.20,
          similarity_boost: 0.80,
          style: 0.55,
          use_speaker_boost: true,
        },
      }),
    });

    if (!resp.ok) {
      const errTxt = await resp.text().catch(() => "");
      console.error("❌ ElevenLabs TTS failed:", resp.status, errTxt.slice(0, 300));
      return res.status(502).send("ElevenLabs TTS failed");
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    const buf = Buffer.from(await resp.arrayBuffer());
    return res.send(buf);
  } catch (e) {
    console.error("❌ /audio error:", e?.message || e);
    return res.status(500).send("Error");
  }
});

// -------------------- SYDNEY SUBURB FUZZY MATCH (Fuse.js) --------------------
// Add your full Sydney suburbs list here (658+). Include "Canley Vale" etc.
// Tip: keep them Title Case, exactly as you want saved.
const SYDNEY_SUBURBS = [
  // ✅ starter set (add the rest)
  "Sydney",
  "Canley Vale",
  "Canley Heights",
  "Cabramatta",
  "Cabramatta West",
  "Fairfield",
  "Fairfield West",
  "Liverpool",
  "Parramatta",
  "Blacktown",
  "Bankstown",
  "Auburn",
  "Granville",
  "Strathfield",
  "Burwood",
  "Hurstville",
  "Kogarah",
  "Sutherland",
  "Cronulla",
  "Bondi",
  "Bondi Junction",
  "Chatswood",
  "Ryde",
  "Macquarie Park",
];

const suburbFuse = new Fuse(SYDNEY_SUBURBS, {
  includeScore: true,
  threshold: 0.35,
  distance: 50,
});

function cleanLocationText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns best matching suburb string or "" if not confident
function bestSydneySuburb(raw) {
  const q = cleanLocationText(raw);
  if (!q) return "";

  const results = suburbFuse.search(q);
  if (!results || results.length === 0) return "";

  const best = results[0];
  // Fuse score: 0 best, 1 worst
  if (best.score != null && best.score <= 0.30) return best.item;
  return "";
}

// -------------------- ROUTES --------------------

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// 1) Inbound call webhook
app.post("/voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const caller = req.body.From;

  const inHours = isWithinBusinessHours();
  console.log("---- /voice ----", { caller, inHours });

  if (inHours) {
    const dial = twiml.dial({
      action: "/post_dial",
      method: "POST",
      timeout: 20,
    });
    dial.number(FORWARD_TO);
    return res.type("text/xml").send(twiml.toString());
  }

  // AFTER HOURS (human-style script)
  // ✅ Your exact vibe, ElevenLabs voice
  await sayOrPlay(
    twiml,
    `Hey — it’s ${BUSINESS_NAME}. I’m on another job at the moment. What suburb are you in, and what’s going on?`
  );

  // Gather (speech-to-text)
  const gather = twiml.gather({
    input: "speech",
    action: "/afterhours",
    method: "POST",
    speechTimeout: "auto",
    timeout: 7,

    // Improve recognition for AU callers (Twilio STT)
    language: "en-AU",
    speechModel: "phone_call",
    enhanced: true,
  });

  // ✅ Use ElevenLabs for gather prompt too (so it doesn’t revert to Twilio voice)
  sayOrPlay(
    gather,
    "No worries — just say your suburb, what the issue is, and whether it’s urgent. For example, water won’t stop or flooding."
  );

  // Fallback if no speech captured
  // Twilio will continue to this if Gather gets nothing.
  sayOrPlay(twiml, "Sorry — I didn’t catch that. Please call again, or text this number. Goodbye.");
  twiml.hangup();

  return res.type("text/xml").send(twiml.toString());
});

// 2) After-hours handler
app.post("/afterhours", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const caller = req.body.From;
  const speech = (req.body.SpeechResult || "").trim();

  console.log("---- /afterhours ----", { caller, speech });

  // Default extraction
  let extracted = {
    name: "",
    location: "",
    issue: speech || "",
    emergency: "",
  };

  // OpenAI structuring (recommended)
  if (openai && speech) {
    try {
      const response = await openai.responses.create({
        model: OPENAI_MODEL_SAFE,
        input: [
          {
            role: "system",
            content:
              "You are a receptionist for an Australian plumbing business. Extract details from the caller message. Output ONLY valid JSON with keys: name, location, issue, emergency (yes/no/unsure). Use empty string if unknown.",
          },
          { role: "user", content: speech },
        ],
      });

      const txt = (response.output_text || "").trim();
      const match = txt.match(/\{[\s\S]*\}/);
      const jsonStr = match ? match[0] : txt;
      extracted = JSON.parse(jsonStr);
    } catch (e) {
      console.error("❌ OpenAI extraction failed:", e?.message || e);
    }
  }

  // ✅ Fix suburb with Fuse.js (Sydney-only)
  // If OpenAI returns "Candyville", we try to map it to closest suburb
  if (extracted.location) {
    const fixed = bestSydneySuburb(extracted.location);
    if (fixed) extracted.location = fixed;
  }

  // Determine urgency
  const emergencyYes =
    String(extracted.emergency || "").toLowerCase().includes("yes") ||
    String(extracted.emergency || "").toLowerCase().includes("urgent");

  // Alert owner SMS
  try {
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body:
        `📞 AFTER HOURS LEAD (${BUSINESS_NAME})\n` +
        `From: ${caller}\n` +
        `Name: ${extracted.name || ""}\n` +
        `Suburb: ${extracted.location || ""}\n` +
        `Issue: ${extracted.issue || ""}\n` +
        `Urgent: ${extracted.emergency || ""}\n`,
    });
    console.log("✅ After-hours SMS sent to owner");
  } catch (e) {
    console.error("❌ After-hours SMS failed:", e?.message || e);
  }

  // Email owner too (optional)
  if (SENDGRID_API_KEY && EMAIL_TO && EMAIL_FROM) {
    try {
      await sgMail.send({
        to: EMAIL_TO,
        from: EMAIL_FROM,
        subject: `${BUSINESS_NAME} - After-hours lead from ${caller}`,
        text:
          `AFTER HOURS LEAD\n\n` +
          `From: ${caller}\n` +
          `Name: ${extracted.name || ""}\n` +
          `Suburb: ${extracted.location || ""}\n` +
          `Issue: ${extracted.issue || ""}\n` +
          `Urgent: ${extracted.emergency || ""}\n` +
          `Captured at: ${new Date().toISOString()}\n` +
          `Raw speech: ${speech}\n`,
      });
      console.log("✅ After-hours email sent");
    } catch (e) {
      console.error("❌ After-hours email failed:", e?.response?.body || e?.message || e);
    }
  } else {
    console.log("⚠️ After-hours email skipped - missing env vars");
  }

  // Caller response (human style)
  if (emergencyYes) {
    await sayOrPlay(twiml, "Okay, got it — that sounds urgent. Check your messages now. We’ll try to contact you as soon as possible.");
  } else {
    await sayOrPlay(twiml, "Alright — got it. Thanks for that. We’ve got your details and we’ll get back to you as soon as possible.");
  }

  twiml.hangup();
  return res.type("text/xml").send(twiml.toString());
});

// 3) Post-Dial: missed call detection
app.post("/post_dial", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const caller = req.body.From;
    const dialCallStatus = req.body.DialCallStatus;
    const dialCallDuration = req.body.DialCallDuration;
    const answeredBy = req.body.AnsweredBy || "";

    console.log("---- /post_dial ----", { caller, dialCallStatus, dialCallDuration, answeredBy });

    const isAnswered = consideredAnswered({ dialCallStatus, answeredBy, dialCallDuration });
    console.log("consideredAnswered:", isAnswered);

    if (isAnswered) {
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    // MISSED -> SMS owner
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `📞 Missed call from ${caller} (status: ${dialCallStatus})`,
    });

    // MISSED -> SMS caller
    if (typeof caller === "string" && caller.startsWith("+")) {
      await client.messages.create({
        from: TWILIO_NUMBER,
        to: caller,
        body:
          `Hi, this is ${BUSINESS_NAME}. Sorry we missed your call. ` +
          `Reply with your name, suburb, what the issue is, and if it’s urgent.`,
      });
    }

    console.log("✅ SMS sent to owner + caller");

    // Email alert too (optional)
    if (SENDGRID_API_KEY && EMAIL_TO && EMAIL_FROM) {
      try {
        await sgMail.send({
          to: EMAIL_TO,
          from: EMAIL_FROM,
          subject: `${BUSINESS_NAME} - Missed call: ${caller}`,
          text:
            `Missed call\n\n` +
            `From: ${caller}\n` +
            `Status: ${dialCallStatus}\n` +
            `AnsweredBy: ${answeredBy || "n/a"}\n` +
            `Time: ${new Date().toISOString()}\n`,
        });
        console.log("✅ Email sent");
      } catch (e) {
        console.error("❌ Email failed:", e?.response?.body || e?.message || e);
      }
    } else {
      console.log("⚠️ Email skipped - missing env vars");
    }

    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("❌ /post_dial error:", err);
    return res.status(200).send("OK");
  }
});

// 4) Inbound SMS: forward replies to owner
app.post("/sms", async (req, res) => {
  try {
    const from = req.body.From; // customer
    const to = req.body.To; // Twilio number
    const body = (req.body.Body || "").trim();

    console.log("---- /sms inbound ----", { from, to, body });

    // Forward reply to owner
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `💬 Reply from ${from}\n\n${body}`,
    });

    console.log("✅ Forwarded reply to owner via SMS");

    // Email the reply too (optional)
    if (SENDGRID_API_KEY && EMAIL_TO && EMAIL_FROM) {
      try {
        await sgMail.send({
          to: EMAIL_TO,
          from: EMAIL_FROM,
          subject: `${BUSINESS_NAME} - New SMS reply from ${from}`,
          text:
            `Customer replied to missed-call SMS.\n\n` +
            `From: ${from}\nTo (Twilio): ${to}\n\n` +
            `Message:\n${body}\n\n` +
            `Time: ${new Date().toISOString()}\n`,
        });
        console.log("✅ Reply email sent");
      } catch (e) {
        console.error("❌ Reply email failed:", e?.response?.body || e?.message || e);
      }
    } else {
      console.log("⚠️ Reply email skipped - missing env vars");
    }

    // Auto-confirm to customer
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: from,
      body: `Thanks — we’ve received your message. ${BUSINESS_NAME} will contact you as soon as possible.`,
    });

    console.log("✅ Confirmed receipt to customer");
    return res.status(200).send("OK");
  } catch (err) {
    console.error("❌ /sms error:", err);
    return res.status(200).send("OK");
  }
});

// -------------------- START --------------------
const listenPort = PORT || 3000;
app.listen(listenPort, () => console.log(`🚀 Server running on port ${listenPort}`));
