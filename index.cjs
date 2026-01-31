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

  // OpenAI (optional but recommended)
  OPENAI_API_KEY,
  OPENAI_MODEL,

  // ElevenLabs (optional but recommended for human voice)
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  PUBLIC_BASE_URL, // e.g. https://nodejs-production-fbbf0.up.railway.app

  // Server
  PORT,
} = process.env;

// -------------------- REQUIRED ENV CHECK --------------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Core flow
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
const OPENAI_MODEL_SAFE = OPENAI_MODEL || "gpt-4o-mini"; // you can change

// -------------------- APP SETUP --------------------
const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(express.json());

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// -------------------- LOG ENV (SAFE) --------------------
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

function baseUrlClean() {
  return String(PUBLIC_BASE_URL || "").replace(/\/$/, "");
}

// Twilio <Play> needs a public URL -> we serve mp3 via /audio?text=
function audioUrlFor(text) {
  return `${baseUrlClean()}/audio?text=${encodeURIComponent(text)}`;
}

// Use ElevenLabs if configured, otherwise fallback to Twilio Say
function sayOrPlay(twimlOrGather, text) {
  if (elevenEnabled()) {
    twimlOrGather.play(audioUrlFor(text));
    return;
  }
  twimlOrGather.say({ voice: "alice" }, text);
}

// Optional: small in-memory cache (reduces ElevenLabs calls when text repeats)
const audioCache = new Map(); // key -> { buf, ts }
const AUDIO_TTL_MS = 10 * 60 * 1000; // 10 min

function audioKey(text) {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex");
}

function getCachedAudio(key) {
  const item = audioCache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > AUDIO_TTL_MS) {
    audioCache.delete(key);
    return null;
  }
  return item.buf;
}

function setCachedAudio(key, buf) {
  audioCache.set(key, { buf, ts: Date.now() });
}

// Streams mp3 from ElevenLabs to Twilio
app.get("/audio", async (req, res) => {
  try {
    const text = String(req.query.text || "").trim();
    if (!text) return res.status(400).send("Missing text");
    if (!elevenEnabled()) return res.status(500).send("ElevenLabs not configured");

    const key = audioKey(text);
    const cached = getCachedAudio(key);
    if (cached) {
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      return res.send(cached);
    }

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
        // If your account supports other models, keep this as-is for best general quality:
        model_id: "eleven_multilingual_v2",
        // Tune these if you want more “human”:
        voice_settings: {
          stability: 0.35,
          similarity_boost: 0.95,
          style: 0.2,
          use_speaker_boost: true,
        },
      }),
    });

    if (!resp.ok) {
      const errTxt = await resp.text().catch(() => "");
      console.error("❌ ElevenLabs TTS failed:", resp.status, errTxt.slice(0, 300));
      return res.status(502).send("ElevenLabs TTS failed");
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    setCachedAudio(key, buf);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.send(buf);
  } catch (e) {
    console.error("❌ /audio error:", e?.message || e);
    return res.status(500).send("Error");
  }
});

// -------------------- SYDNEY SUBURB FUZZY MATCH (Fuse.js) --------------------
// NOTE: This is a starter list + includes your key suburbs.
// You can expand later by adding the full 600+ list into this array (no other code changes needed).
const sydneySuburbs = [
  "Sydney",
  "Parramatta",
  "Liverpool",
  "Penrith",
  "Blacktown",
  "Bankstown",
  "Campbelltown",
  "Fairfield",
  "Cabramatta",
  "Canley Vale",
  "Canley Heights",
  "Bonnyrigg",
  "Wetherill Park",
  "Smithfield",
  "Bossley Park",
  "Edensor Park",
  "Green Valley",
  "Mount Pritchard",
  "Wakeley",
  "Villawood",
  "Carramar",
  "Guildford",
  "Granville",
  "Auburn",
  "Strathfield",
  "Burwood",
  "Ashfield",
  "Newtown",
  "Chatswood",
  "Hurstville",
  "Kogarah",
  "Sutherland",
  "Cronulla",
  "Bondi",
  "Bondi Junction",
  "Manly",
  "Dee Why",
  "Ryde",
  "Epping",
  "Castle Hill",
  "Rouse Hill",
];

const suburbFuse = new Fuse(sydneySuburbs, {
  includeScore: true,
  threshold: 0.35, // lower = stricter
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
  // Fuse score: 0 = perfect, 1 = worst
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

  try {
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

    // AFTER HOURS INTRO (ElevenLabs)
    sayOrPlay(
      twiml,
      `Hi, this is ${BUSINESS_NAME}. We’re currently helping another customer and couldn’t answer. ` +
        `Please say your name first, then your suburb, then what the issue is, and finally whether it’s urgent.`
    );

    // Gather for speech
    const gather = twiml.gather({
      input: "speech",
      action: "/afterhours",
      method: "POST",
      speechTimeout: "auto",
      timeout: 10,

      // Improve recognition
      language: "en-AU",
      speechModel: "phone_call",
      enhanced: true,
    });

    // IMPORTANT: Use ElevenLabs voice for the gather prompt too
    sayOrPlay(
      gather,
      "Start with your name, then your suburb, then what the issue is, and whether it’s urgent."
    );

    // Fallback if no speech captured
    sayOrPlay(twiml, "Sorry, I didn’t catch that. Please call again, or text this number. Goodbye.");
    twiml.hangup();

    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("❌ /voice error:", err);
    // Always return TwiML so Twilio doesn't throw "application error"
    sayOrPlay(twiml, "Sorry, something went wrong. Please try again.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});

// 2) After-hours handler
app.post("/afterhours", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const caller = req.body.From;
  const speech = String(req.body.SpeechResult || "").trim();

  console.log("---- /afterhours ----", { caller, speech });

  try {
    // If nothing captured, ask again
    if (!speech) {
      sayOrPlay(twiml, "Sorry, I didn’t catch that. Please call again and leave your details.");
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    let extracted = { name: "", location: "", issue: speech, emergency: "" };

    // OpenAI structuring (optional)
    if (openai) {
      try {
        const response = await openai.responses.create({
          model: OPENAI_MODEL_SAFE,
          input: [
            {
              role: "system",
              content:
                "You are a receptionist for an Australian trades business. Extract details from the caller message. " +
                "Output ONLY valid JSON with keys: name, location, issue, emergency (yes/no/unsure). " +
                "Use empty string if unknown. Keep location to suburb only if possible.",
            },
            { role: "user", content: speech },
          ],
        });

        const txt = String(response.output_text || "").trim();
        const match = txt.match(/\{[\s\S]*\}/);
        const jsonStr = match ? match[0] : txt;

        extracted = JSON.parse(jsonStr);
      } catch (e) {
        console.error("❌ OpenAI extraction failed:", e?.message || e);
      }
    }

    // --- Sydney suburb correction ---
    // Fix things like "Candyville" -> "Canley Vale"
    const fixedSuburb = bestSydneySuburb(extracted.location || "");
    if (fixedSuburb) extracted.location = fixedSuburb;

    // Urgency handling (custom line)
    const emergencyFlag = String(extracted.emergency || "").toLowerCase();
    const urgent =
      emergencyFlag.includes("yes") || emergencyFlag.includes("urgent") || emergencyFlag.includes("emergency");

    // Alert owner via SMS
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
          `Urgent: ${urgent ? "YES" : (extracted.emergency || "")}\n`,
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
            `Urgent: ${urgent ? "YES" : (extracted.emergency || "")}\n` +
            `Captured at: ${new Date().toISOString()}\n`,
        });
        console.log("✅ After-hours email sent");
      } catch (e) {
        console.error("❌ After-hours email failed:", e?.response?.body || e?.message || e);
      }
    } else {
      console.log("⚠️ After-hours email skipped - missing env vars");
    }

    // Speak back to caller
    if (urgent) {
      sayOrPlay(
        twiml,
        "Thanks. This sounds urgent. Please check your messages now — we will try to contact you as soon as possible."
      );
    } else {
      sayOrPlay(
        twiml,
        "Thank you. We’ve received your details and we’ll get back to you as soon as possible."
      );
    }

    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("❌ /afterhours error:", err);
    sayOrPlay(twiml, "Sorry, something went wrong. Please try again.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
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
    return res.status(200).send("OK"); // stop Twilio retries
  }
});

// 4) Inbound SMS: forward replies to owner
app.post("/sms", async (req, res) => {
  try {
    const from = req.body.From; // customer
    const to = req.body.To; // Twilio number
    const body = String(req.body.Body || "").trim();

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

    // Auto-confirm to customer (keep/remove as you want)
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
