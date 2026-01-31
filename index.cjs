// index.cjs
const express = require("express");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");
const OpenAI = require("openai");
const Fuse = require("fuse.js");
const sydneySuburbs = require("./sydney_suburbs.json");

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

  // OpenAI (optional)
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

// Required core
requireEnv("TWILIO_ACCOUNT_SID");
requireEnv("TWILIO_AUTH_TOKEN");
requireEnv("TWILIO_NUMBER");
requireEnv("OWNER_NUMBER");
requireEnv("FORWARD_TO");
requireEnv("BUSINESS_NAME");
requireEnv("BUSINESS_START");
requireEnv("BUSINESS_END");
requireEnv("TIMEZONE");

// Optional
if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const OPENAI_MODEL_SAFE = OPENAI_MODEL || "gpt-4o-mini";

// -------------------- APP SETUP --------------------
const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio form-encoded
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

// -------------------- SYDNEY SUBURB FUZZY MATCH (FUSE.JS) --------------------
const suburbFuse = new Fuse(sydneySuburbs, {
  includeScore: true,
  threshold: 0.35, // lower = stricter; higher = more forgiving
  distance: 50,
  ignoreLocation: true,
  minMatchCharLength: 3,
});

function cleanLocationText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns suburb string or "" if not confident
function bestSydneySuburb(raw) {
  const q = cleanLocationText(raw);
  if (!q) return "";

  const results = suburbFuse.search(q);
  if (!results || results.length === 0) return "";

  const best = results[0];
  // Fuse score: 0 = perfect, 1 = worst
  if (best.score != null && best.score <= 0.40) return best.item;

  return "";
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
    twimlOrGather.play(audioUrlFor(text));
    return;
  }
  twimlOrGather.say({ voice: "alice" }, text);
}

// Streams mp3 from ElevenLabs to Twilio
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
    // Business hours -> forward call
    const dial = twiml.dial({
      action: "/post_dial",
      method: "POST",
      timeout: 20,
    });

    dial.number(FORWARD_TO);
    return res.type("text/xml").send(twiml.toString());
  }

  // After hours -> AI receptionist (basic)
  await sayOrPlay(
    twiml,
    `Hey, this is ${BUSINESS_NAME}. We’re currently helping another customer. Please let me know what your name is, your suburb, and what the issue is, and is it urgent?   We’ll get back to you immediately if it is urgent, if not we will call you tomorrow morning.`
  );

  const gather = twiml.gather({
  input: "speech",
  action: "/afterhours",
  method: "POST",
  speechTimeout: "auto",
  timeout: 6,

  // ✅ improve recognition for Australia
  language: "en-AU",
  speechModel: "phone_call",
  enhanced: true,
});
 // ✅ Use ElevenLabs for gather prompt too
sayOrPlay(
  gather,
  "Perfect, can you tell me your name, what suburb you're in, what the issue is, and is it urgent?"
);

  await sayOrPlay(twiml, "Sorry, I didn’t catch that. Please call again. Goodbye.");
  twiml.hangup();
  return res.type("text/xml").send(twiml.toString());
});

// 2) After-hours handler
app.post("/afterhours", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const caller = req.body.From;
  const speech = (req.body.SpeechResult || "").trim();

  console.log("---- /afterhours ----", { caller, speech });

  let extracted = {
    name: "",
    location: "",
    issue: speech || "",
    emergency: "",
  };

  // OpenAI extraction (optional)
  if (openai && speech) {
    try {
      const response = await openai.responses.create({
        model: OPENAI_MODEL_SAFE,
        input: [
          {
            role: "system",
            content:
              "You are a receptionist for a Sydney plumbing business. Extract details from the caller message. Output ONLY valid JSON with keys: name, location, issue, emergency (yes/no/unsure). Use empty string if unknown.",
          },
          { role: "user", content: speech },
        ],
      });

      const txt = (response.output_text || "").trim();
      const match = txt.match(/\{[\s\S]*\}/);
      const jsonStr = match ? match[0] : txt;

      extracted = JSON.parse(jsonStr);
      // ✅ suburb autocorrect
if (extracted?.location) {
  const corrected = bestSydneySuburb(extracted.location);
  if (corrected) extracted.location = corrected;
}
    } catch (e) {
      console.error("❌ OpenAI extraction failed:", e?.message || e);
    }
  }

  // Sydney suburb correction (Fuse)
  const corrected =
    bestSydneySuburb(extracted.location) ||
    bestSydneySuburb(speech);

  if (corrected) extracted.location = corrected;

  const isEmergency =
    (extracted.emergency || "").toLowerCase().includes("yes") ||
    (speech || "").toLowerCase().includes("emergency");

  const Fuse = require("fuse.js");

// ✅ put your full Sydney suburbs array here:
const sydneySuburbs = [
  // "Canley Vale",
  // "Canley Heights",
  // ...
];

const suburbFuse = new Fuse(sydneySuburbs, {
  includeScore: true,
  threshold: 0.35,
  distance: 50,
});

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Simple Levenshtein distance (no extra deps)
function levenshtein(a, b) {
  a = norm(a);
  b = norm(b);
  if (!a || !b) return 9999;

  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function bestSydneySuburb(raw) {
  const q = norm(raw);
  if (!q) return "";

  // 1) Try Fuse first
  const fuseResults = suburbFuse.search(q);
  if (fuseResults?.length) {
    const best = fuseResults[0];
    if (best.score != null && best.score <= 0.30) return best.item;
  }

  // 2) Fallback: edit-distance against the whole list
  let best = "";
  let bestScore = Infinity;

  for (const suburb of sydneySuburbs) {
    const d = levenshtein(q, suburb);
    const ratio = d / Math.max(1, norm(suburb).length);
    if (ratio < bestScore) {
      bestScore = ratio;
      best = suburb;
    }
  }

  // ✅ accept only if "close enough"
  // This catches Candyville -> Canley Vale type issues
  if (best && bestScore <= 0.40) return best;

  return "";
}

  // Alert owner via SMS
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
        `Emergency: ${extracted.emergency || (isEmergency ? "yes" : "no/unsure")}\n`,
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
        subject: `${BUSINESS_NAME} - After-hours lead from ${caller}${isEmergency ? " (URGENT)" : ""}`,
        text:
          `AFTER HOURS LEAD\n\n` +
          `From: ${caller}\n` +
          `Name: ${extracted.name || ""}\n` +
          `Location: ${extracted.location || ""}\n` +
          `Issue: ${extracted.issue || ""}\n` +
          `Emergency: ${extracted.emergency || (isEmergency ? "yes" : "no/unsure")}\n` +
          `Captured at: ${new Date().toISOString()}\n`,
      });
      console.log("✅ After-hours email sent");
    } catch (e) {
      console.error("❌ After-hours email failed:", e?.response?.body || e?.message || e);
    }
  } else {
    console.log("⚠️ After-hours email skipped - missing env vars");
  }

  // Caller closing line (custom emergency response)
  if (isEmergency) {
    await sayOrPlay(
      twiml,
      "Thanks — this sounds urgent. Please check your messages now. We’ll try to contact you as soon as possible."
    );
  } else {
    await sayOrPlay(
      twiml,
      "Thanks — we’ve received your details and you will receive a call in the morning.   "
    );
  }

  twiml.hangup();
  return res.type("text/xml").send(twiml.toString());
});

// 3) Post-Dial: missed call detection (business hours)
app.post("/post_dial", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const caller = req.body.From;
    const dialCallStatus = req.body.DialCallStatus;
    const dialCallDuration = req.body.DialCallDuration;
    const answeredBy = req.body.AnsweredBy || "";

    console.log("---- /post_dial ----", {
      caller,
      dialCallStatus,
      dialCallDuration,
      answeredBy,
    });

    const isAnswered = consideredAnswered({ dialCallStatus, answeredBy, dialCallDuration });

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

    console.log("✅ Missed-call SMS sent to owner + caller");

    // Optional email alert
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
        console.log("✅ Missed-call email sent");
      } catch (e) {
        console.error("❌ Missed-call email failed:", e?.response?.body || e?.message || e);
      }
    }

    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("❌ /post_dial error:", err);
    return res.status(200).send("OK");
  }
});

// 4) Inbound SMS reply forwarding
app.post("/sms", async (req, res) => {
  try {
    const from = req.body.From;
    const to = req.body.To;
    const body = (req.body.Body || "").trim();

    console.log("---- /sms inbound ----", { from, to, body });

    // Forward to owner
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
            `Customer replied.\n\nFrom: ${from}\nTo (Twilio): ${to}\n\nMessage:\n${body}\n\nTime: ${new Date().toISOString()}\n`,
        });
      } catch (e) {
        console.error("❌ Reply email failed:", e?.response?.body || e?.message || e);
      }
    }

    // Confirm to customer
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
