"use strict";

/**
 * twilio-ai-agent index.cjs
 * - Business hours: forwards call to FORWARD_TO
 * - After-hours: suburb -> issue -> urgent flow (all prompts via ElevenLabs if configured)
 * - Missed call: SMS owner + SMS caller
 * - Inbound SMS: forward to owner (+ optional email)
 * - /audio: ElevenLabs TTS streaming for Twilio <Play>
 */

const express = require("express");
const twilio = require("twilio");
const sgMail = require("@sendgrid/mail");
const OpenAI = require("openai");
const Fuse = require("fuse.js");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// -------------------- ENV --------------------
const {
  PORT,

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

  // SendGrid (optional)
  SENDGRID_API_KEY,
  EMAIL_TO,
  EMAIL_FROM,

  // OpenAI (optional but recommended)
  OPENAI_API_KEY,
  OPENAI_MODEL,

  // ElevenLabs (optional)
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  PUBLIC_BASE_URL,
} = process.env;

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Missing env var: ${name}`);
  return process.env[name];
}

// Required core vars
requireEnv("TWILIO_ACCOUNT_SID");
requireEnv("TWILIO_AUTH_TOKEN");
requireEnv("TWILIO_NUMBER");
requireEnv("OWNER_NUMBER");
requireEnv("FORWARD_TO");
requireEnv("BUSINESS_NAME");

// Optional vars handling
if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// OpenAI optional
const openai =
  OPENAI_API_KEY && OPENAI_API_KEY.trim()
    ? new OpenAI({ apiKey: OPENAI_API_KEY })
    : null;

const OPENAI_MODEL_SAFE = (OPENAI_MODEL || "gpt-4o-mini").toString();

// -------------------- LOG ENV CHECK --------------------
console.log("ENV CHECK:", {
  twilio: {
    twilioNumber: TWILIO_NUMBER,
    owner: OWNER_NUMBER,
    forwardTo: FORWARD_TO,
  },
  business: {
    name: BUSINESS_NAME,
    start: BUSINESS_START,
    end: BUSINESS_END,
    timezone: TIMEZONE || "Australia/Sydney",
  },
  sendgrid: { hasKey: !!SENDGRID_API_KEY, hasTo: !!EMAIL_TO, hasFrom: !!EMAIL_FROM },
  openai: { hasKey: !!OPENAI_API_KEY, model: OPENAI_MODEL_SAFE },
  elevenlabs: {
    hasKey: !!ELEVENLABS_API_KEY,
    hasVoiceId: !!ELEVENLABS_VOICE_ID,
    baseUrl: PUBLIC_BASE_URL || "",
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
  const start = parseInt(BUSINESS_START || "9", 10);
  const end = parseInt(BUSINESS_END || "17", 10);

  // supports overnight windows (e.g., start 22 end 6)
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
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

async function sayOrPlay(twimlOrGather, text) {
  if (elevenEnabled()) {
    twimlOrGather.play(audioUrlFor(text));
    return;
  }
  // fallback Twilio voice
  twimlOrGather.say({ voice: "alice" }, text);
}

// This endpoint streams mp3 from ElevenLabs to Twilio
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
          stability: 0.35,
          similarity_boost: 0.95,
          style: 0.25,
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

// -------------------- SYDNEY SUBURBS LIST --------------------
const SYDNEY_SUBURBS = [
  "Abbotsbury",
  "Abbotsford",
  "Acacia Gardens",
  "Agnes Banks",
  "Airds",
  "Alexandria",
  "Alfords Point",
  "Allambie Heights",
  "Allawah",
  "Ambarvale",
  "Angus",
  "Annandale",
  "Annangrove",
  "Arcadia",
  "Arncliffe",
  "Arndell Park",
  "Artarmon",
  "Ashbury",
  "Ashcroft",
  "Ashfield",
  "Asquith",
  "Auburn",
  "Austral",
  "Avalon Beach",
  "Badgerys Creek",
  "Balgowlah",
  "Balmain",
  "Bangor",
  "Banksia",
  "Banksmeadow",
  "Bankstown",
  "Barangaroo",
  "Barden Ridge",
  "Bardia",
  "Bardwell Park",
  "Bardwell Valley",
  "Bass Hill",
  "Baulkham Hills",
  "Bayview",
  "Beacon Hill",
  "Beaconsfield",
  "Beaumont Hills",
  "Beecroft",
  "Belfield",
  "Bella Vista",
  "Bellevue Hill",
  "Belmore",
  "Belrose",
  "Berala",
  "Berkshire Park",
  "Berowra",
  "Berrilee",
  "Beverley Park",
  "Beverly Hills",
  "Bexley",
  "Bidwill",
  "Bilgola",
  "Birchgrove",
  "Birrong",
  "Blackett",
  "Blacktown",
  "Blair Athol",
  "Blairmount",
  "Blakehurst",
  "Bligh Park",
  "Bondi",
  "Bonnet Bay",
  "Bossley Park",
  "Botany",
  "Bow Bowing",
  "Box Hill",
  "Bradbury",
  "Bradfield",
  "Breakfast Point",
  "Brighton-Le-Sands",
  "Bringelly",
  "Bronte",
  "Brooklyn",
  "Brookvale",
  "Bundeena",
  "Bungarribee",
  "Burraneer",
  "Burwood",
  "Busby",
  "Cabarita",
  "Cabramatta",
  "Caddens",
  "Cambridg",
  "Camellia",
  "Cammeray",
  "Campbelltown",
  "Camperdown",
  "Campsie",
  "Canada Bay",
  "Canley Heights",
  "Canley Vale",
  "Canoelands",
  "Canterbury",
  "Caringbah",
  "Carlingford",
  "Carlton",
  "Carnes Hill",
  "Carramar",
  "Carss Park",
  "Cartwright",
  "Castle Cove",
  "Castle Hill",
  "Castlecrag",
  "Castlereagh",
  "Casula",
  "Catherine Field",
  "Cattai",
  "Cecil Hills",
  "Cecil Park",
  "Centennial Park",
  "Chatswood",
  "Cheltenham",
  "Cherrybrook",
  "Chester Hill",
  "Chifley",
  "Chippendale",
  "Chipping Norton",
  "Chiswick",
  "Chullora",
  "Church Point",
  "Claremont Meadows",
  "Clarendon",
  "Clareville",
  "Claymore",
  "Clemton Park",
  "Clontarf",
  "Clovelly",
  "Clyde",
  "Coasters Retreat",
  "Cobbitty",
  "Colebee",
  "Collaroy",
  "Colyton",
  "Como",
  "Concord",
  "Condell Park",
  "Connells Point",
  "Constitution Hill",
  "Coogee",
  "Cottage Point",
  "Cowan",
  "Cranebrook",
  "Cremorne",
  "Cremorne Point",
  "Cromer",
  "Cronulla",
  "Crows Nest",
  "Croydon",
  "Croydon Park",
  "Curl Curl",
  "Currans Hill",
  "Currawong Beach",
  "Daceyville",
  "Dangar Island",
  "Darling Point",
  "Darlinghurst",
  "Darlington",
  "Davidson",
  "Dawes Point",
  "Dean Park",
  "Dee Why",
  "Denham Court",
  "Denistone",
  "Dharruk",
  "Dolans Bay",
  "Dolls Point",
  "Doonside",
  "Double Bay",
  "Dover Heights",
  "Drummoyne",
  "Duffys Forest",
  "Dulwich Hill",
  "Dundas",
  "Dundas Valley",
  "Dural",
  "Eagle Vale",
  "Earlwood",
  "East Hills",
  "East Killara",
  "East Lindfield",
  "East Ryde",
  "Eastern Creek",
  "Eastgardens",
  "Eastlakes",
  "Eastwood",
  "Edensor Park",
  "Edgecliff",
  "Edmondson Park",
  "Elanora Heights",
  "Elderslie",
  "Elizabeth Bay",
  "Elizabeth Hills",
  "Elvina Bay",
  "Emerton",
  "Enfield",
  "Engadine",
  "Englorie Park",
  "Enmore",
  "Epping",
  "Ermington",
  "Erskine Park",
  "Erskineville",
  "Eschol Park",
  "Eveleigh",
  "Fairfield",
  "Fairlight",
  "Fiddletown",
  "Five Dock",
  "Forest Glen",
  "Forest Lodge",
  "Forestville",
  "Frenchs Forest",
  "Freshwater",
  "Gables",
  "Galston",
  "Georges Hall",
  "Gilead",
  "Girraween",
  "Gladesville",
  "Glebe",
  "Gledswood Hills",
  "Glen Alpine",
  "Glendenning",
  "Glenfield",
  "Glenhaven",
  "Glenmore Park",
  "Glenorie",
  "Glenwood",
  "Gordon",
  "Grantham Farm",
  "Granville",
  "Grays Point",
  "Great Mackerel Beach",
  "Green Valley",
  "Greenacre",
  "Greendale",
  "Greenfield Park",
  "Greenhills Beach",
  "Greenwich",
  "Gregory Hills",
  "Greystanes",
  "Guildford",
  "Gymea",
  "Haberfield",
  "Hammondville",
  "Harrington Park",
  "Harris Park",
  "Hassall Grove",
  "Haymarket",
  "Heathcote",
  "Hebersham",
  "Heckenberg",
  "Henley",
  "Hillsdale",
  "Hinchinbrook",
  "Hobartville",
  "Holroyd",
  "Holsworthy",
  "Homebush",
  "Horningsea Park",
  "Hornsby",
  "Horsley Park",
  "Hoxton Park",
  "Hunters Hill",
  "Huntingwood",
  "Huntleys Cove",
  "Huntleys Point",
  "Hurlstone Park",
  "Hurstville",
  "Hurstville Grove",
  "Illawong",
  "Ingleburn",
  "Ingleside",
  "Jamisontown",
  "Jannali",
  "Jordan Springs",
  "Kangaroo Point",
  "Kareela",
  "Kearns",
  "Kellyville",
  "Kellyville Ridge",
  "Kemps Creek",
  "Kensington",
  "Kenthurst",
  "Kentlyn",
  "Killara",
  "Killarney Heights",
  "Kings Langley",
  "Kings Park",
  "Kingsford",
  "Kingsgrove",
  "Kingswood",
  "Kirkham",
  "Kirrawee",
  "Kirribilli",
  "Kogarah",
  "Kogarah Bay",
  "Ku-ring-gai Chase",
  "Kurnell",
  "Kurraba Point",
  "Kyeemagh",
  "Kyle Bay",
  "La Perouse",
  "Lakemba",
  "Lalor Park",
  "Lane Cove",
  "Lane Cove North",
  "Lane Cove West",
  "Lansdowne",
  "Lansvale",
  "Laughtondale",
  "Lavender Bay",
  "Leets Vale",
  "Leichhardt",
  "Len Waters Estate",
  "Leppington",
  "Lethbridge Park",
  "Leumeah",
  "Lewisham",
  "Liberty Grove",
  "Lidcombe",
  "Lilli Pilli",
  "Lilyfield",
  "Lindfield",
  "Linley Point",
  "Little Bay",
  "Liverpool",
  "Llandilo",
  "Loftus",
  "Londonderry",
  "Long Point",
  "Longueville",
  "Lovett Bay",
  "Lower Portland",
  "Lucas Heights",
  "Luddenham",
  "Lugarno",
  "Lurnea",
  "Macquarie Fields",
  "Macquarie Links",
  "Macquarie Park",
  "Maianbar",
  "Malabar",
  "Manly",
  "Manly Vale",
  "Maraylya",
  "Marayong",
  "Maroota",
  "Maroubra",
  "Marrickville",
  "Marsden Park",
  "Marsfield",
  "Mascot",
  "Matraville",
  "Mays Hill",
  "McCarrs Creek",
  "McGraths Hill",
  "McMahons Point",
  "Meadowbank",
  "Melonba",
  "Melrose Park",
  "Menai",
  "Menangle Park",
  "Merrylands",
  "Middle Cove",
  "Middle Dural",
  "Middleton Grange",
  "Miller",
  "Millers Point",
  "Milperra",
  "Milsons Passage",
  "Milsons Point",
  "Minchinbury",
  "Minto",
  "Minto Heights",
  "Miranda",
  "Mona Vale",
  "Monterey",
  "Moore Park",
  "Moorebank",
  "Morning Bay",
  "Mortdale",
  "Mortlake",
  "Mosman",
  "Mount Annan",
  "Mount Colah",
  "Mount Druitt",
  "Mount Kuring-Gai",
  "Mount Lewis",
  "Mount Pritchard",
  "Mount Vernon",
  "Mulgoa",
  "Mulgrave",
  "Narellan",
  "Narellan Vale",
  "Naremburn",
  "Narraweena",
  "Narrabeen",
  "Narwee",
  "Nelson",
  "Neutral Bay",
  "Newington",
  "Newport",
  "Newtown",
  "Nirimba Fields",
  "Normanhurst",
  "North Balgowlah",
  "North Bondi",
  "North Curl Curl",
  "North Epping",
  "North Kellyville",
  "North Manly",
  "North Narrabeen",
  "North Parramatta",
  "North Rocks",
  "North Ryde",
  "North St Marys",
  "North Strathfield",
  "North Sydney",
  "North Turramurra",
  "North Wahroonga",
  "North Willoughby",
  "Northbridge",
  "Northmead",
  "Northwood",
  "Norwest",
  "Oakhurst",
  "Oakville",
  "Oatlands",
  "Oatley",
  "Old Guildford",
  "Old Toongabbie",
  "Oran Park",
  "Orchard Hills",
  "Oxford Falls",
  "Oxley Park",
  "Oyster Bay",
  "Paddington",
  "Padstow",
  "Padstow Heights",
  "Pagewood",
  "Palm Beach",
  "Panania",
  "Parklea",
  "Parramatta",
  "Peakhurst",
  "Pemulwuy",
  "Pendle Hill",
  "Pennant Hills",
  "Penrith",
  "Penshurst",
  "Petersham",
  "Phillip Bay",
  "Picnic Point",
  "Pitt Town",
  "Pleasure Point",
  "Plumpton",
  "Point Piper",
  "Port Botany",
  "Port Hacking",
  "Potts Hill",
  "Potts Point",
  "Prairiewood",
  "Prestons",
  "Prospect",
  "Punchbowl",
  "Putney",
  "Pymble",
  "Pyrmont",
  "Quakers Hill",
  "Queens Park",
  "Queenscliff",
  "Raby",
  "Ramsgate",
  "Ramsgate Beach",
  "Randwick",
  "Redfern",
  "Regents Park",
  "Regentville",
  "Revesby",
  "Revesby Heights",
  "Rhodes",
  "Richards",
  "Richmond",
  "Riverstone",
  "Riverview",
  "Riverwood",
  "Rockdale",
  "Rodd Point",
  "Rookwood",
  "Rooty Hill",
  "Ropes Crossing",
  "Rose Bay",
  "Rosebery",
  "Rosehill",
  "Roselands",
  "Rosemeadow",
  "Roseville",
  "Roseville Chase",
  "Rossmore",
  "Rouse Hill",
  "Rozelle",
  "Ruse",
  "Rushcutters Bay",
  "Russell Lea",
  "Rydalmere",
  "Ryde",
  "Sackville North",
  "Sadleir",
  "Sandringham",
  "Sandy Point",
  "Sans Souci",
  "Schofields",
  "Scotland Island",
  "Seaforth",
  "Sefton",
  "Seven Hills",
  "Shalvey",
  "Shanes Park",
  "Silverwater",
  "Singletons Mill",
  "Smeaton Grange",
  "Smithfield",
  "South Coogee",
  "South Granville",
  "South Hurstville",
  "South Maroota",
  "South Penrith",
  "South Turramurra",
  "South Wentworthville",
  "South Windsor",
  "Spring Farm",
  "St Andrews",
  "St Clair",
  "St Helens Park",
  "St Ives",
  "St Ives Chase",
  "St Johns Park",
  "St Leonards",
  "St Marys",
  "St Peters",
  "Stanhope Gardens",
  "Stanmore",
  "Strathfield",
  "Strathfield South",
  "Summer Hill",
  "Surry Hills",
  "Sutherland",
  "Sydenham",
  "Sydney",
  "Sydney Olympic Park",
  "Sylvania",
  "Sylvania Waters",
  "Tallawong",
  "Tamarama",
  "Taren Point",
  "Telopea",
  "Tempe",
  "Tennyson Point",
  "Terrey Hills",
  "The Ponds",
  "The Rocks",
  "Thornleigh",
  "Toongabbie",
  "Tregear",
  "Turramurra",
  "Turrella",
  "Ultimo",
  "Varroville",
  "Vaucluse",
  "Villawood",
  "Vineyard",
  "Voyager Point",
  "Wahroonga",
  "Waitara",
  "Wakeley",
  "Wareemba",
  "Warrawee",
  "Warriewood",
  "Warwick Farm",
  "Waterfall",
  "Waterloo",
  "Watsons Bay",
  "Wattle Grove",
  "Waverley",
  "Waverton",
  "Wedderburn",
  "Wentworth Point",
  "Wentworthville",
  "Werrington",
  "Werrington County",
  "Werrington Downs",
  "West Hoxton",
  "West Pennant Hills",
  "West Pymble",
  "West Ryde",
  "Westleigh",
  "Westmead",
  "Wetherill Park",
  "Whalan",
  "Whale Beach",
  "Wheeler Heights",
  "Wiley Park",
  "Willmot",
  "Willoughby",
  "Willoughby East",
  "Windsor",
  "Windsor Downs",
  "Winston Hills",
  "Wisemans Ferry",
  "Wolli Creek",
  "Wollstonecraft",
  "Woodbine",
  "Woodcroft",
  "Woodpark",
  "Woollahra",
  "Woolloomooloo",
  "Woolooware",
  "Woolwich",
  "Woronora",
  "Woronora Heights",
  "Yagoona",
  "Yarrawarrah",
  "Yennora",
  "Yowie Bay",
  "Zetland",
];

// -------------------- SYDNEY SUBURB FUZZY MATCH --------------------
let suburbFuse = null;

try {
  suburbFuse = new Fuse(SYDNEY_SUBURBS, {
    includeScore: true,
    threshold: 0.35, // lower = stricter; higher = more forgiving
    distance: 50,
    ignoreLocation: true,
  });
  console.log("✅ suburbFuse ready:", SYDNEY_SUBURBS.length, "suburbs");
} catch (e) {
  console.error("❌ suburbFuse failed to init:", e?.message || e);
}

function cleanLocationText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bestSydneySuburb(raw) {
  if (!suburbFuse) return "";
  const q = cleanLocationText(raw);
  if (!q) return "";

  const results = suburbFuse.search(q);
  if (!results || results.length === 0) return "";

  const best = results[0];
  // Fuse score: 0 = perfect, 1 = worst
  if (best.score != null && best.score <= 0.33) return best.item;

  return "";
}

// -------------------- TEMP LEAD STORE (multi-step after-hours) --------------------
const tempLeadStore = new Map(); // key -> { caller, suburb, issue, name }

// -------------------- ROUTES --------------------

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// 1) Inbound call webhook
app.post("/voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const caller = req.body.From;

  const inHours = isWithinBusinessHours();
  console.log("---- /voice ----", { caller, inHours });

  // BUSINESS HOURS: forward call
  if (inHours) {
    const dial = twiml.dial({
      action: "/post_dial",
      method: "POST",
      timeout: 20,
    });
    dial.number(FORWARD_TO);
    return res.type("text/xml").send(twiml.toString());
  }

  // AFTER HOURS: Step 0 intro (Eleven voice)
  await sayOrPlay(
    twiml,
    `Hey — it’s ${BUSINESS_NAME}. I’m on another job at the moment.`
  );

  // Step 1: ask suburb only
  const gather1 = twiml.gather({
    input: "speech",
    action: "/afterhours_suburb",
    method: "POST",

    // Important: give time, and don't cut off early
    timeout: 12, // time allowed before they start talking
    speechTimeout: "auto", // wait until they stop talking

    language: "en-AU",
    speechModel: "phone_call",
    enhanced: true,
  });

  await sayOrPlay(gather1, "What suburb are you in?");

  // If they say nothing
  twiml.redirect({ method: "POST" }, "/voice");

  return res.type("text/xml").send(twiml.toString());
});

// 2A) After-hours: suburb step
app.post("/afterhours_suburb", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const caller = req.body.From;
  const rawSuburb = (req.body.SpeechResult || "").trim();

  console.log("---- /afterhours_suburb ----", { caller, rawSuburb });

  const suburb = bestSydneySuburb(rawSuburb) || rawSuburb || "";

  const key = Buffer.from(`${caller}|${Date.now()}`).toString("base64url");
  tempLeadStore.set(key, { caller, suburb });

  // Step 2: ask issue
  const gather2 = twiml.gather({
    input: "speech",
    action: `/afterhours_issue?key=${encodeURIComponent(key)}`,
    method: "POST",
    timeout: 12,
    speechTimeout: "auto",
    language: "en-AU",
    speechModel: "phone_call",
    enhanced: true,
  });

  await sayOrPlay(
    gather2,
    `No worries… And what’s going on?`
  );

  twiml.redirect({ method: "POST" }, "/voice");
  return res.type("text/xml").send(twiml.toString());
});

// 2B) After-hours: issue step
app.post("/afterhours_issue", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const key = String(req.query.key || "");
  const speech = (req.body.SpeechResult || "").trim();

  const saved = tempLeadStore.get(key) || {};
  const caller = saved.caller || req.body.From;
  const suburb = saved.suburb || "";

  console.log("---- /afterhours_issue ----", { caller, suburb, speech });

  let name = "";
  let issue = speech || "";

  // Optional: OpenAI extracts name from the issue message if they mention it
  if (openai && speech) {
    try {
      const response = await openai.responses.create({
        model: OPENAI_MODEL_SAFE,
        input: [
          {
            role: "system",
            content:
              "You are a receptionist for an Australian plumbing business. Extract ONLY valid JSON with keys: name, issue. Use empty string if unknown.",
          },
          { role: "user", content: speech },
        ],
      });

      const txt = (response.output_text || "").trim();
      const match = txt.match(/\{[\s\S]*\}/);
      const jsonStr = match ? match[0] : txt;
      const parsed = JSON.parse(jsonStr);

      name = (parsed.name || "").toString();
      issue = (parsed.issue || issue || "").toString();
    } catch (e) {
      console.error("❌ OpenAI extraction failed:", e?.message || e);
    }
  }

  tempLeadStore.set(key, { caller, suburb, name, issue });

  // Step 3: urgency yes/no
  const gather3 = twiml.gather({
    input: "speech",
    action: `/afterhours_urgent?key=${encodeURIComponent(key)}`,
    method: "POST",
    timeout: 10,
    speechTimeout: "auto",
    language: "en-AU",
    speechModel: "phone_call",
    enhanced: true,
  });

  await sayOrPlay(
    gather3,
    "Got it. And is it urgent — like water won’t stop, or flooding? Just say yes or no."
  );

  twiml.redirect({ method: "POST" }, "/voice");
  return res.type("text/xml").send(twiml.toString());
});

// 2C) After-hours: urgent step (final)
app.post("/afterhours_urgent", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const key = String(req.query.key || "");
  const rawUrgent = (req.body.SpeechResult || "").trim().toLowerCase();

  const saved = tempLeadStore.get(key) || {};
  const caller = saved.caller || req.body.From;
  let suburb = saved.suburb || "";
  const name = saved.name || "";
  const issue = saved.issue || "";

  // snap suburb again if it still looks off
  const snapped = bestSydneySuburb(suburb);
  if (snapped) suburb = snapped;

  console.log("---- /afterhours_urgent ----", { caller, suburb, name, issue, rawUrgent });

  const urgent =
    rawUrgent.includes("yes") ||
    rawUrgent.includes("yeah") ||
    rawUrgent.includes("yep") ||
    rawUrgent.includes("urgent") ||
    rawUrgent.includes("flood") ||
    rawUrgent.includes("burst");

  const urgentLabel = urgent ? "yes" : "no";

  // SMS owner
  try {
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body:
        `📞 AFTER HOURS LEAD (${BUSINESS_NAME})\n` +
        `From: ${caller}\n` +
        `Name: ${name}\n` +
        `Suburb: ${suburb}\n` +
        `Issue: ${issue}\n` +
        `Urgent: ${urgentLabel}\n`,
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
          `Name: ${name}\n` +
          `Suburb: ${suburb}\n` +
          `Issue: ${issue}\n` +
          `Urgent: ${urgentLabel}\n` +
          `Captured at: ${new Date().toISOString()}\n`,
      });
      console.log("✅ After-hours email sent");
    } catch (e) {
      console.error("❌ After-hours email failed:", e?.response?.body || e?.message || e);
    }
  }

  // Final voice line
  if (urgent) {
    await sayOrPlay(
      twiml,
      "Okay, got it — that sounds urgent. Check your messages now. We’ll try to contact you as soon as possible."
    );
  } else {
    await sayOrPlay(
      twiml,
      "Alright… got it. Thanks for that. We’ve got your details and we’ll get back to you as soon as possible."
    );
  }

  twiml.hangup();
  tempLeadStore.delete(key);

  return res.type("text/xml").send(twiml.toString());
});

// 3) Post-dial: missed call detection
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
    const from = req.body.From;
    const to = req.body.To;
    const body = (req.body.Body || "").trim();

    console.log("---- /sms inbound ----", { from, to, body });

    // Forward reply to owner via SMS
    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `💬 Reply from ${from}\n\n${body}`,
    });

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
  } catch (e) {
    console.error("❌ /sms error:", e?.message || e);
    return res.status(200).send("OK");
  }
});

// -------------------- START --------------------
const listenPort = PORT || 3000;
app.listen(listenPort, () => console.log(`🚀 Server running on port ${listenPort}`));
