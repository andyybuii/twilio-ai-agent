const express = require("express");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");
const OpenAI = require("openai");
const WebSocket = require("ws");
const { createClient } = require("@deepgram/sdk");

// -------------------- ENV --------------------
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  OWNER_NUMBER,
  FORWARD_TO,

  BUSINESS_NAME,
  BUSINESS_START,
  BUSINESS_END,
  TIMEZONE,

  SENDGRID_API_KEY,
  EMAIL_TO,
  EMAIL_FROM,

  OPENAI_API_KEY,
  DEEPGRAM_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,

  PUBLIC_BASE_URL,
  PORT,
} = process.env;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// core
requireEnv("TWILIO_ACCOUNT_SID");
requireEnv("TWILIO_AUTH_TOKEN");
requireEnv("TWILIO_NUMBER");
requireEnv("OWNER_NUMBER");
requireEnv("FORWARD_TO");
requireEnv("BUSINESS_NAME");
requireEnv("BUSINESS_START");
requireEnv("BUSINESS_END");
requireEnv("TIMEZONE");
requireEnv("PUBLIC_BASE_URL");

// streaming keys (only needed for after-hours realtime)
requireEnv("DEEPGRAM_API_KEY");
requireEnv("ELEVENLABS_API_KEY");
requireEnv("ELEVENLABS_VOICE_ID");
requireEnv("OPENAI_API_KEY");

// -------------------- SETUP --------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const deepgram = createClient(DEEPGRAM_API_KEY);

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

function consideredAnswered({ dialCallStatus, dialCallDuration }) {
  // considered answered if completed and lasted at least 5s
  return dialCallStatus === "completed" && Number(dialCallDuration || 0) >= 5;
}

// -------------------- HEALTH --------------------
app.get("/", (req, res) => res.status(200).send("OK"));

// -------------------- VOICE WEBHOOK --------------------
// Set Twilio phone number Voice webhook to POST {PUBLIC_BASE_URL}/voice
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const caller = req.body.From || "Unknown";
  const inHours = isWithinBusinessHours();

  console.log("---- /voice ----", { caller, inHours });

  if (inHours) {
    // Business hours: forward call to your phone/office
    const dial = twiml.dial({
      action: `${PUBLIC_BASE_URL}/post_dial`,
      method: "POST",
      timeout: 20,
    });
    dial.number(FORWARD_TO);
    return res.type("text/xml").send(twiml.toString());
  }

  // After-hours: realtime voice receptionist via Twilio Media Streams
  // Twilio will open a websocket to /twilio-stream
  twiml.say({ voice: "Polly.Nicole" }, `Hi, you’ve reached ${BUSINESS_NAME}. One moment please.`);

  twiml.connect().stream({
    url: PUBLIC_BASE_URL.replace("https://", "wss://") + "/twilio-stream",
    track: "inbound_track", // caller -> us. (We send audio back over same WS)
  });

  // If streaming fails, fallback hangup message
  twiml.say({ voice: "Polly.Nicole" }, "Sorry, we couldn’t connect. Please text us your name, suburb and issue, and we’ll call you in the morning.");
  twiml.hangup();

  return res.type("text/xml").send(twiml.toString());
});

// -------------------- MISSED CALL HANDLER --------------------
app.post("/post_dial", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const caller = req.body.From;
    const dialCallStatus = req.body.DialCallStatus;
    const dialCallDuration = req.body.DialCallDuration;

    console.log("---- /post_dial ----", { caller, dialCallStatus, dialCallDuration });

    if (consideredAnswered({ dialCallStatus, dialCallDuration })) {
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    // missed -> SMS owner
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `📞 Missed call from ${caller} (status: ${dialCallStatus})`,
    });

    // missed -> SMS caller
    if (typeof caller === "string" && caller.startsWith("+")) {
      await client.messages.create({
        from: TWILIO_NUMBER,
        to: caller,
        body: `Hi, this is ${BUSINESS_NAME}. Sorry we missed your call. Reply with your name, suburb, issue and if it’s urgent.`,
      });
    }

    // email
    if (SENDGRID_API_KEY && EMAIL_TO && EMAIL_FROM) {
      await sgMail.send({
        to: EMAIL_TO,
        from: EMAIL_FROM,
        subject: `${BUSINESS_NAME} - Missed call: ${caller}`,
        text: `Missed call\nFrom: ${caller}\nStatus: ${dialCallStatus}\nTime: ${new Date().toISOString()}\n`,
      });
    }

    console.log("✅ Missed-call SMS sent to owner + caller");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error("❌ /post_dial error:", e?.message || e);
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});

// -------------------- INBOUND SMS REPLY FORWARDING --------------------
app.post("/sms", async (req, res) => {
  try {
    const from = req.body.From;
    const body = (req.body.Body || "").trim();

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
        text: `Reply from: ${from}\n\n${body}\n\nTime: ${new Date().toISOString()}\n`,
      });
    }

    await client.messages.create({
      from: TWILIO_NUMBER,
      to: from,
      body: `Thanks — we’ve received your message. ${BUSINESS_NAME} will contact you as soon as possible.`,
    });

    return res.status(200).send("OK");
  } catch (e) {
    console.error("❌ /sms error:", e?.message || e);
    return res.status(200).send("OK");
  }
});

// ============================================================
// REALTIME AFTER-HOURS VOICE BOT (Twilio Media Streams WS)
// ============================================================

async function elevenlabsTTS_ulaw8000(text) {
  // Returns Buffer of mulaw_8000 audio suitable for Twilio
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=ulaw_8000`;

  const r = await fetch(url, {
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
        stability: 0.45,
        similarity_boost: 0.85,
        style: 0.35,
        use_speaker_boost: true,
      },
    }),
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`ElevenLabs TTS error ${r.status}: ${errText}`);
  }

  const arrayBuffer = await r.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function llmRespond(conversation, lastUserText) {
  // conversation: array of {role, content}
  // returns { replyText, extraction }
  const sys = `You are an Australian after-hours plumbing receptionist.
Be warm, natural, and brief. Ask only what you need.
Your goals:
1) Collect: name, suburb/location, issue, and emergency (yes/no).
2) If emergency: acknowledge and say "I’m alerting the on-call plumber now."
3) Otherwise: promise a call back in the morning.
Never mention AI.`;

  const messages = [
    { role: "system", content: sys },
    ...conversation,
    { role: "user", content: lastUserText },
  ];

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    messages,
  });

  const replyText = resp.choices?.[0]?.message?.content?.trim() || "Thanks. We’ll call you in the morning.";

  // Extract structured info in a second call (more reliable)
  const extractResp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "Extract details from the conversation. Return ONLY valid JSON with keys: name, location, issue, emergency (yes/no/unsure). Use empty string if unknown.",
      },
      { role: "user", content: `Conversation:\n${conversation.map(m => `${m.role}: ${m.content}`).join("\n")}\nuser: ${lastUserText}` },
    ],
  });

  let extraction = { name: "", location: "", issue: "", emergency: "unsure" };
  try {
    extraction = JSON.parse(extractResp.choices?.[0]?.message?.content || "{}");
  } catch {}

  return { replyText, extraction };
}

function sendAudioToTwilio(ws, streamSid, ulawBuffer) {
  // Twilio expects base64-encoded audio payloads in "media" events.
  const payload = ulawBuffer.toString("base64");
  const msg = {
    event: "media",
    streamSid,
    media: { payload },
  };
  ws.send(JSON.stringify(msg));
}

function sendMark(ws, streamSid, name) {
  ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name } }));
}

function safeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

const server = app.listen(PORT || 3000, () => {
  console.log(`🚀 Server running on port ${PORT || 3000}`);
});

const wss = new WebSocket.Server({ server, path: "/twilio-stream" });

wss.on("connection", async (ws) => {
  console.log("🟢 Twilio stream connected");

  let streamSid = null;
  let callSid = null;

  // Deepgram live transcription (accept mulaw 8000)
  const dg = deepgram.listen.live({
    model: "nova-2",
    language: "en-AU",
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    smart_format: true,
    interim_results: true,
    endpointing: 150, // ms
    utterance_end_ms: 800,
  });

  let conversation = [];
  let lastFinal = "";
  let lastHeardAt = Date.now();

  const greet = async () => {
    const text = `Hi, this is ${BUSINESS_NAME}. How can I help you tonight?`;
    try {
      const audio = await elevenlabsTTS_ulaw8000(text);
      if (streamSid) sendAudioToTwilio(ws, streamSid, audio);
      conversation.push({ role: "assistant", content: text });
    } catch (e) {
      console.error("❌ TTS greet error:", e?.message || e);
    }
  };

  dg.on("open", () => console.log("🟣 Deepgram open"));
  dg.on("close", () => console.log("🟣 Deepgram close"));
  dg.on("error", (e) => console.error("❌ Deepgram error:", e));

  dg.on("transcript", async (data) => {
    try {
      const alt = data.channel?.alternatives?.[0];
      const transcript = safeText(alt?.transcript);
      const isFinal = data.is_final;

      if (!transcript) return;

      lastHeardAt = Date.now();

      if (!isFinal) return;

      // Avoid repeating same final
      if (transcript === lastFinal) return;
      lastFinal = transcript;

      console.log("🗣️ FINAL:", transcript);
      conversation.push({ role: "user", content: transcript });

      // Ask LLM what to say next + extraction
      const { replyText, extraction } = await llmRespond(conversation, transcript);
      conversation.push({ role: "assistant", content: replyText });

      // Speak it back (human-like AU voice via ElevenLabs)
      const audio = await elevenlabsTTS_ulaw8000(replyText);
      if (streamSid) sendAudioToTwilio(ws, streamSid, audio);

      // If emergency YES -> immediately alert owner (SMS + optional email)
      const emergency = String(extraction.emergency || "").toLowerCase();
      if (emergency === "yes") {
        const msg =
          `🚨 EMERGENCY AFTER HOURS (${BUSINESS_NAME})\n` +
          `Call: ${callSid || ""}\n` +
          `Name: ${extraction.name || ""}\n` +
          `Location: ${extraction.location || ""}\n` +
          `Issue: ${extraction.issue || transcript}\n`;

        await client.messages.create({ from: TWILIO_NUMBER, to: OWNER_NUMBER, body: msg });
        if (SENDGRID_API_KEY && EMAIL_TO && EMAIL_FROM) {
          await sgMail.send({
            to: EMAIL_TO,
            from: EMAIL_FROM,
            subject: `🚨 EMERGENCY - ${BUSINESS_NAME}`,
            text: msg,
          });
        }
      }

      // If we’ve got enough info, you can end the call politely
      // (simple heuristic: once we have name + location + issue)
      const hasName = (extraction.name || "").trim().length > 0;
      const hasLoc = (extraction.location || "").trim().length > 0;
      const hasIssue = (extraction.issue || transcript).trim().length > 0;

      if (hasName && hasLoc && hasIssue) {
        const closing = "Perfect — thanks. We’ll call you in the morning.";
        const closingAudio = await elevenlabsTTS_ulaw8000(closing);
        if (streamSid) sendAudioToTwilio(ws, streamSid, closingAudio);

        // Send non-emergency summary to owner
        const summary =
          `📞 AFTER HOURS LEAD (${BUSINESS_NAME})\n` +
          `Call: ${callSid || ""}\n` +
          `Name: ${extraction.name || ""}\n` +
          `Location: ${extraction.location || ""}\n` +
          `Issue: ${extraction.issue || transcript}\n` +
          `Emergency: ${extraction.emergency || "unsure"}\n`;

        await client.messages.create({ from: TWILIO_NUMBER, to: OWNER_NUMBER, body: summary });

        if (SENDGRID_API_KEY && EMAIL_TO && EMAIL_FROM) {
          await sgMail.send({
            to: EMAIL_TO,
            from: EMAIL_FROM,
            subject: `${BUSINESS_NAME} - After-hours lead`,
            text: summary + `\nTime: ${new Date().toISOString()}\n`,
          });
        }

        // Mark end, then close WS (Twilio will hang up after stream ends)
        if (streamSid) sendMark(ws, streamSid, "end_call");
        ws.close();
      }
    } catch (e) {
      console.error("❌ transcript handler error:", e?.message || e);
    }
  });

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        console.log("▶️ start", { streamSid, callSid });
        await greet();
        return;
      }

      if (msg.event === "media") {
        // Twilio sends base64 mulaw_8k audio
        const audio = Buffer.from(msg.media.payload, "base64");
        dg.send(audio);
        return;
      }

      if (msg.event === "stop") {
        console.log("⏹️ stop", { streamSid });
        dg.finish();
        return;
      }
    } catch (e) {
      console.error("❌ WS message error:", e?.message || e);
    }
  });

  ws.on("close", () => {
    console.log("🔴 Twilio stream disconnected");
    try { dg.finish(); } catch {}
  });
});
