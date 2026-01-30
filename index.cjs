// index.cjs
const express = require("express");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");
const OpenAI = require("openai");
const crypto = require("crypto");

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

  // OpenAI
  OPENAI_API_KEY,
  OPENAI_MODEL,

  // ElevenLabs (optional)
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

// Normalize base URL (remove trailing slash)
const BASE_URL = (PUBLIC_BASE_URL || "").replace(/\/+$/, "");

// Twilio client
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

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
  sendgrid: {
    hasKey: !!SENDGRID_API_KEY,
    hasTo: !!EMAIL_TO,
    hasFrom: !!EMAIL_FROM,
  },
  openai: {
    hasKey: !!OPENAI_API_KEY,
    model: OPENAI_MODEL_SAFE,
  },
  elevenlabs: {
    hasKey: !!ELEVENLABS_API_KEY,
    hasVoiceId: !!ELEVENLABS_VOICE_ID,
    baseUrl: BASE_URL || null,
  },
});

// -------------------- APP SETUP --------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

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

  return hour >= start && hour < end;
}

function consideredAnswered({ dialCallStatus, answeredBy, dialCallDuration }) {
  if (dialCallStatus === "completed" && Number(dialCallDuration || 0) > 0) return true;
  if (answeredBy && String(answeredBy).trim().length > 0) return true;
  return false;
}

// -------------------- ELEVENLABS --------------------
// IMPORTANT: Twilio <Play> must fetch a PUBLIC mp3 URL.
// We'll cache audio buffers, but ALSO regenerate on demand if cache misses.

const audioCache = new Map();     // id -> Buffer
const audioTextMap = new Map();   // id -> text (so we can regenerate if cache is empty)

function makeAudioId(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function elevenEnabled() {
  return !!(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID && BASE_URL);
}

async function elevenlabsTTS(text) {
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
        stability: 0.4,
        similarity_boost: 0.85,
      },
    }),
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs failed ${resp.status}: ${errTxt.slice(0, 200)}`);
  }

  const arr = await resp.arrayBuffer();
  return Buffer.from(arr);
}

async function ensureAudioCached(text) {
  if (!elevenEnabled()) return null;

  const id = makeAudioId(text);
  audioTextMap.set(id, text);

  if (audioCache.has(id)) return id;

  try {
    const buf = await elevenlabsTTS(text);
    audioCache.set(id, buf);
    return id;
  } catch (e) {
    console.error("❌ ElevenLabs TTS error:", e?.message || e);
    return null;
  }
}

async function sayOrPlay(twimlNode, text) {
  // If ElevenLabs configured, prefer <Play>
  const id = await ensureAudioCached(text);

  if (id) {
    const url = `${BASE_URL}/audio/${id}`;
    console.log("🔊 Using ElevenLabs:", url);
    twimlNode.play(url);
    return;
  }

  console.log("🗣️ Falling back to Twilio voice");
  twimlNode.say({ voice: "alice" }, text);
}

// Serve mp3 to Twilio (and regenerate if needed)
app.get("/audio/:id", async (req, res) => {
  const id = req.params.id;

  // Serve from cache if present
  if (audioCache.has(id)) {
    const buf = audioCache.get(id);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(buf);
  }

  // Regenerate on demand if we have the original text
  const text = audioTextMap.get(id);

  if (!text) {
    return res.status(404).send("Not found");
  }

  if (!elevenEnabled()) {
    return res.status(500).send("ElevenLabs not configured");
  }

  try {
    console.log("♻️ Regenerating audio for id:", id);
    const buf = await elevenlabsTTS(text);
    audioCache.set(id, buf);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(buf);
  } catch (e) {
    console.error("❌ Regenerate failed:", e?.message || e);
    return res.status(500).send("TTS failed");
  }
});

// -------------------- ROUTES --------------------

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// 1) Inbound call webhook
app.post("/voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const caller = req.body.From;

  const inHours = isWithinBusinessHours();
  console.log("---- /voice ----", { caller, inHours });

  // BUSINESS HOURS: forward
  if (inHours) {
    const dial = twiml.dial({
      action: "/post_dial",
      method: "POST",
      timeout: 20,
    });
    dial.number(FORWARD_TO);
    return res.type("text/xml").send(twiml.toString());
  }

  // AFTER HOURS: ElevenLabs (or fallback)
  await sayOrPlay(
    twiml,
    `Hi, you’ve reached ${BUSINESS_NAME}. How can I help you tonight?`
  );

  const gather = twiml.gather({
    input: "speech",
    action: "/afterhours",
    method: "POST",
    speechTimeout: "auto",
    timeout: 6,
  });

  // ✅ Use ElevenLabs inside Gather too
  await sayOrPlay(
    gather,
    "Please tell me your name, your suburb, what the issue is, and whether it’s an emergency."
  );

  twiml.say({ voice: "alice" }, "Sorry, I didn’t catch that. Please call again, or text this number. Goodbye.");
  twiml.hangup();

  return res.type("text/xml").send(twiml.toString());
});

// 2) After-hours handler
app.post("/afterhours", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const caller = req.body.From;
  const speech = (req.body.SpeechResult || "").trim();

  console.log("---- /afterhours ----", { caller, speech });

  let extracted = { name: "", location: "", issue: speech || "", emergency: "" };

  if (openai && speech) {
    try {
      const response = await openai.responses.create({
        model: OPENAI_MODEL_SAFE,
        input: [
          {
            role: "system",
            content:
              "You are a receptionist for an Australian trades business. Extract details from the caller message. Output ONLY valid JSON with keys: name, location, issue, emergency (yes/no/unsure). Use empty string if unknown.",
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

  // Owner SMS
  try {
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body:
        `📞 AFTER HOURS LEAD (${BUSINESS_NAME})\n` +
        `From: ${caller}\n` +
        `Name: ${extracted.name || ""}\n` +
        `Location: ${extracted.location || ""}\n` +
        `Issue: ${extracted.issue || ""}\n` +
        `Emergency: ${extracted.emergency || ""}\n`,
    });
    console.log("✅ After-hours SMS sent to owner");
  } catch (e) {
    console.error("❌ After-hours SMS failed:", e?.message || e);
  }

  // Optional email
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
          `Location: ${extracted.location || ""}\n` +
          `Issue: ${extracted.issue || ""}\n` +
          `Emergency: ${extracted.emergency || ""}\n` +
          `Captured at: ${new Date().toISOString()}\n`,
      });
      console.log("✅ After-hours email sent");
    } catch (e) {
      console.error("❌ After-hours email failed:", e?.response?.body || e?.message || e);
    }
  } else {
    console.log("⚠️ After-hours email skipped - missing env vars");
  }

  await sayOrPlay(
    twiml,
    "Thanks — we’ve got your details. Someone will call you first thing in the morning."
  );
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

    console.log("---- /post_dial ----");
    console.log({ caller, dialCallStatus, dialCallDuration, answeredBy });

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

    // Optional email
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
    const from = req.body.From;
    const to = req.body.To;
    const body = (req.body.Body || "").trim();

    console.log("---- /sms inbound ----", { from, to, body });

    // Forward reply to owner
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `💬 Reply from ${from}\n\n${body}`,
    });

    // Optional email
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
      } catch (e) {
        console.error("❌ Reply email failed:", e?.response?.body || e?.message || e);
      }
    }

    // Auto-confirm to customer
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: from,
      body: `Thanks — we’ve received your message. ${BUSINESS_NAME} will contact you as soon as possible.`,
    });

    return res.status(200).send("OK");
  } catch (err) {
    console.error("❌ /sms error:", err);
    return res.status(200).send("OK");
  }
});

// -------------------- START --------------------
const listenPort = process.env.PORT || 3000;

app.listen(listenPort, () => {
  console.log(`🚀 Server running on port ${listenPort}`);
});
