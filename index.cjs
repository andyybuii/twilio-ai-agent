// index.cjs
const express = require("express");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");
const OpenAI = require("openai");

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

  // ElevenLabs (optional for natural voice)
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  PUBLIC_BASE_URL, // MUST be: https://nodejs-production-fbbf0.up.railway.app

  // Server
  PORT,
} = process.env;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Required
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

console.log("ENV CHECK:", {
  twilio: { twilioNumber: TWILIO_NUMBER, owner: OWNER_NUMBER, forwardTo: FORWARD_TO },
  business: { name: BUSINESS_NAME, start: BUSINESS_START, end: BUSINESS_END, timezone: TIMEZONE },
  sendgrid: { hasKey: !!SENDGRID_API_KEY, hasTo: !!EMAIL_TO, hasFrom: !!EMAIL_FROM },
  openai: { hasKey: !!OPENAI_API_KEY, model: OPENAI_MODEL_SAFE },
  elevenlabs: {
    hasKey: !!ELEVENLABS_API_KEY,
    hasVoiceId: !!ELEVENLABS_VOICE_ID,
    baseUrl: PUBLIC_BASE_URL || null,
  },
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

// Twilio <Play> needs a public URL. We give it /audio?text=...
function audioUrlFor(text) {
  const base = (PUBLIC_BASE_URL || "").replace(/\/$/, "");
  return `${base}/audio?text=${encodeURIComponent(text)}`;
}

function sayOrPlay(twimlOrGather, text) {
  if (elevenEnabled()) {
    // Use ElevenLabs voice
    twimlOrGather.play(audioUrlFor(text));
    return;
  }
  // Fallback Twilio voice
  twimlOrGather.say({ voice: "alice" }, text);
}

// This endpoint streams mp3 from ElevenLabs to Twilio (no caching needed)
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
        voice_settings: { stability: 0.25, similarity_boost: 0.95 },
      }),
    });

    if (!resp.ok) {
      const errTxt = await resp.text().catch(() => "");
      console.error("❌ ElevenLabs TTS failed:", resp.status, errTxt.slice(0, 300));
      return res.status(502).send("ElevenLabs TTS failed");
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    // Stream response body back to Twilio
    const buf = Buffer.from(await resp.arrayBuffer());
    return res.send(buf);
  } catch (e) {
    console.error("❌ /audio error:", e?.message || e);
    return res.status(500).send("Error");
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

  if (inHours) {
    const dial = twiml.dial({
      action: "/post_dial",
      method: "POST",
      timeout: 20,
    });
    dial.number(FORWARD_TO);
    return res.type("text/xml").send(twiml.toString());
  }

  // AFTER HOURS (ElevenLabs if enabled)
  sayOrPlay(
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

  // IMPORTANT: use ElevenLabs here too (play inside Gather)
  sayOrPlay(
    gather,
    "Please tell me your name, your suburb, what the issue is, and whether it’s an emergency."
  );

  // Fallback if no input
  sayOrPlay(twiml, "Sorry, I didn’t catch that. Please call again, or text this number. Goodbye.");
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
      extracted = JSON.parse(match ? match[0] : txt);
    } catch (e) {
      console.error("❌ OpenAI extraction failed:", e?.message || e);
    }
  }

  // SMS owner
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

  // Email owner (optional)
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
  }

  const emergencyValue = String(extracted.emergency || "").toLowerCase();
const isEmergency =
  emergencyValue.includes("yes") ||
  emergencyValue.includes("true") ||
  emergencyValue.includes("emerg");

if (isEmergency) {
  // Optional: immediately call the owner as well (not just SMS/email)
  try {
    await client.calls.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      twiml: `<Response><Say voice="alice">Emergency after hours call from ${caller}. Please check your text messages now.</Say></Response>`,
    });
    console.log("✅ Emergency call placed to owner");
  } catch (e) {
    console.error("❌ Emergency call failed:", e?.message || e);
  }

  // What caller hears (custom emergency line)
  sayOrPlay(
    twiml,
    "Thanks — this sounds urgent. We’re going to try contact you as soon as possible. If you’re in immediate danger, please call emergency services."
  );
} else {
  sayOrPlay(
    twiml,
    "Thank you. We’ve got your details and you’ll receive a call in the morning."
  );
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

    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `💬 Reply from ${from}\n\n${body}`,
    });

    if (SENDGRID_API_KEY && EMAIL_TO && EMAIL_FROM) {
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
    }

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
const listenPort = PORT || 3000;
app.listen(listenPort, () => console.log(`🚀 Server running on port ${listenPort}`));
