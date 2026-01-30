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

  // OpenAI (optional but needed for structured extraction)
  OPENAI_API_KEY,
  OPENAI_MODEL,

  // ElevenLabs (optional for more natural voice)
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  PUBLIC_BASE_URL, // e.g. https://your-railway-domain.up.railway.app

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
const OPENAI_MODEL_SAFE = OPENAI_MODEL || "gpt-4o-mini"; // change if you want

console.log("ENV CHECK:", {
  twilio: {
    hasAccount: !!TWILIO_ACCOUNT_SID,
    hasToken: !!TWILIO_AUTH_TOKEN,
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
    publicBaseUrl: PUBLIC_BASE_URL || null,
  },
});

// -------------------- APP SETUP --------------------
const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(express.json());

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

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

// -------------------- ELEVENLABS (OPTIONAL) --------------------
// Twilio <Play> needs a PUBLIC URL to an audio file.
// We generate mp3 in-memory and serve it at /audio/:id
const audioCache = new Map(); // id -> Buffer

function makeAudioId(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

async function elevenlabsTTSToCache(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID || !PUBLIC_BASE_URL) return null;

  const id = makeAudioId(text);
  if (audioCache.has(id)) return id;

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
    console.error("❌ ElevenLabs TTS failed:", resp.status, errTxt.slice(0, 200));
    return null;
  }

  const arr = await resp.arrayBuffer();
  const buf = Buffer.from(arr);
  audioCache.set(id, buf);
  return id;
}

async function sayOrPlay(twiml, text) {
  // Try ElevenLabs first (if configured)
  try {
    const id = await elevenlabsTTSToCache(text);
    if (id) {
      twiml.play(`${PUBLIC_BASE_URL}/audio/${id}`);
      return;
    }
  } catch (e) {
    console.error("❌ sayOrPlay ElevenLabs error:", e?.message || e);
  }

  // Fallback to Twilio TTS
  twiml.say({ voice: "alice" }, text);
}

// Serve cached mp3 to Twilio
app.get("/audio/:id", (req, res) => {
  const id = req.params.id;
  const buf = audioCache.get(id);
  if (!buf) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.send(buf);
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

  if (inHours) {
    const dial = twiml.dial({
      action: "/post_dial",
      method: "POST",
      timeout: 20,
    });
    dial.number(FORWARD_TO);
    return res.type("text/xml").send(twiml.toString());
  }

  // AFTER HOURS: take details
  await sayOrPlay(
    twiml,
    `Hi, you’ve reached ${BUSINESS_NAME}. We’re currently closed, but I can take your details and we’ll call you in the morning.`
  );

  const gather = twiml.gather({
    input: "speech",
    action: "/afterhours",
    method: "POST",
    speechTimeout: "auto",
    timeout: 6,
  });

  gather.say(
    { voice: "alice" },
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

  // OpenAI structuring (optional)
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

      // safer parse: grab first JSON object if model adds extra text
      const match = txt.match(/\{[\s\S]*\}/);
      const jsonStr = match ? match[0] : txt;

      extracted = JSON.parse(jsonStr);
    } catch (e) {
      console.error("❌ OpenAI extraction failed:", e?.message || e);
    }
  }

  // Alert owner SMS
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
    "Thank you. We’ve received your details and you will receive a call in the morning."
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

    // Email alert too
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

    // Auto-confirm to customer (remove this if you don’t want it)
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
