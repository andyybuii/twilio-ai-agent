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

  // Email
  SENDGRID_API_KEY,
  EMAIL_TO,
  EMAIL_FROM,

  // OpenAI
  OPENAI_API_KEY,

  // Server
  PORT,
} = process.env;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Required for core flow
requireEnv("TWILIO_ACCOUNT_SID");
requireEnv("TWILIO_AUTH_TOKEN");
requireEnv("TWILIO_NUMBER");
requireEnv("OWNER_NUMBER");
requireEnv("FORWARD_TO");
requireEnv("BUSINESS_NAME");
requireEnv("BUSINESS_START");
requireEnv("BUSINESS_END");
requireEnv("TIMEZONE");

// Optional but recommended
if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

console.log("ENV CHECK:", {
  hasTwilio: !!TWILIO_ACCOUNT_SID && !!TWILIO_AUTH_TOKEN,
  twilioNumber: TWILIO_NUMBER || null,
  owner: OWNER_NUMBER || null,
  forwardTo: FORWARD_TO || null,
  businessName: BUSINESS_NAME || null,
  start: BUSINESS_START || null,
  end: BUSINESS_END || null,
  timezone: TIMEZONE || null,
  sendgrid: {
    hasKey: !!SENDGRID_API_KEY,
    hasTo: !!EMAIL_TO,
    hasFrom: !!EMAIL_FROM,
  },
  hasOpenAIKey: !!OPENAI_API_KEY,
});

// -------------------- APP SETUP --------------------
const app = express();

// Twilio sends form-encoded by default
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// -------------------- TIME HELPERS --------------------
function isWithinBusinessHours() {
  // Uses Intl.DateTimeFormat to get hour in TIMEZONE without extra deps
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

  // Example: 8 to 17 means 8:00–16:59
  return hour >= start && hour < end;
}

// Twilio AnsweredBy can be "human", "machine_start", "fax", etc.
// DialCallStatus can be "completed", "no-answer", "busy", "failed", "canceled"
function consideredAnswered({ dialCallStatus, answeredBy, dialCallDuration }) {
  // If Twilio says completed AND there was some duration, usually answered (human or VM)
  if (dialCallStatus === "completed" && Number(dialCallDuration || 0) > 0) return true;

  // Sometimes answeredBy is present
  if (answeredBy && String(answeredBy).trim().length > 0) return true;

  return false;
}

// -------------------- ROUTES --------------------

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// 1) Inbound call webhook (Twilio Voice URL)
app.post("/voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const caller = req.body.From;

  const inHours = isWithinBusinessHours();

  console.log("---- /voice ----", { caller, inHours });

  if (inHours) {
    // Forward call to owner phone (or office line)
    const dial = twiml.dial({
      action: "/post_dial",        // Twilio hits this when Dial finishes
      method: "POST",
      timeout: 20,                 // ring time
    });

    dial.number(FORWARD_TO);

    // Optional: whisper to owner before connecting
    twiml.say({ voice: "Polly.Nicole" }, "text...");

    return res.type("text/xml").send(twiml.toString());
  }

  // AFTER HOURS: AI receptionist
  twiml.say(
    { voice: "alice" },
    `Hi, you’ve reached ${BUSINESS_NAME}. We’re currently closed, but I can take your details and we’ll call you in the morning.`
  );

  // We do a 2-step gather:
  // Step A: ask all details in one go (simpler)
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

  // If no speech captured, fallback
  twiml.say({ voice: "alice" }, "Sorry, I didn’t catch that. Please call again, or text this number. Goodbye.");
  twiml.hangup();

  return res.type("text/xml").send(twiml.toString());
});

// 2) After-hours handler: take speech transcript, ask OpenAI to structure it, then alert owner (SMS + email)
app.post("/afterhours", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const caller = req.body.From;
  const speech = (req.body.SpeechResult || "").trim();

  console.log("---- /afterhours ----", { caller, speech });

  // If OpenAI isn't configured, still do something useful
  let extracted = {
    name: "",
    location: "",
    issue: speech || "",
    emergency: "",
  };

  if (openai && speech) {
    try {
      // Using Responses API via the Node SDK  [oai_citation:1‡platform.openai.com](https://platform.openai.com/docs/guides/tools-web-search?utm_source=chatgpt.com)
      const response = await openai.responses.create({
        model: "gpt-5",
        reasoning: { effort: "low" },
        input: [
          {
            role: "system",
            content:
              "You are a phone receptionist for a trades business in Australia. Extract details from the caller message. Output ONLY valid JSON with keys: name, location, issue, emergency (yes/no/unsure). If unknown, use empty string.",
          },
          { role: "user", content: speech },
        ],
      });

      const txt = (response.output_text || "").trim();

      // best-effort parse JSON
      extracted = JSON.parse(txt);
    } catch (e) {
      console.error("❌ OpenAI parse failed:", e?.message || e);
    }
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
        `Emergency: ${extracted.emergency || ""}\n`,
    });

    console.log("✅ After-hours SMS sent to owner");
  } catch (e) {
    console.error("❌ After-hours SMS failed:", e?.message || e);
  }

  // Email owner too
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

  // Respond to caller
  twiml.say(
    { voice: "alice" },
    "Thank you. We’ve received your details and you will receive a call in the morning."
  );
  twiml.hangup();

  return res.type("text/xml").send(twiml.toString());
});

// 3) Post-Dial handler: decides if missed, then sends SMS + email
app.post("/post_dial", async (req, res) => {
  try {
    const caller = req.body.From;
    const dialCallStatus = req.body.DialCallStatus;
    const dialCallDuration = req.body.DialCallDuration;
    const answeredBy = req.body.AnsweredBy || "";

    console.log("---- /post_dial ----");
    console.log({ caller, dialCallStatus, dialCallDuration, answeredBy });

    const isAnswered = consideredAnswered({ dialCallStatus, answeredBy, dialCallDuration });
    console.log("consideredAnswered:", isAnswered);

    const twiml = new twilio.twiml.VoiceResponse();

    if (isAnswered) {
      // nothing else to do
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    // MISSED -> send SMS to owner
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `📞 Missed call from ${caller} (status: ${dialCallStatus})`,
    });

    // MISSED -> send SMS to caller
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
    return res.status(200).send("OK"); // still 200 so Twilio stops retrying
  }
});

// 4) Inbound SMS reply forwarding (Twilio Messaging URL)
app.post("/sms", async (req, res) => {
  try {
    const from = req.body.From; // customer number
    const to = req.body.To;     // your Twilio number
    const body = (req.body.Body || "").trim();

    console.log("---- /sms inbound ----");
    console.log({ from, to, body });

    // Forward to owner
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `💬 Reply from ${from}\n\n${body}`,
    });

    console.log("✅ Forwarded reply to owner via SMS");

    // Email the reply too
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

    // Optional: auto-confirm to customer (you said this worked — keep it)
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
app.listen(listenPort, () => {
  console.log(`🚀 Server running on port ${listenPort}`);
});
