// ---------- MISSED CALL HANDLER ----------
app.post("/missed", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const {
      TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN,
      TWILIO_NUMBER,
      OWNER_NUMBER,
    } = process.env;

    if (!TWILIO_ACCOUNT_SID) throw new Error("Missing SID");
    if (!TWILIO_AUTH_TOKEN) throw new Error("Missing Token");
    if (!TWILIO_NUMBER) throw new Error("Missing Twilio Number");
    if (!OWNER_NUMBER) throw new Error("Missing Owner Number");

    const dialStatus = req.body.DialCallStatus; // completed, no-answer, busy, failed
    const answeredBy = req.body.AnsweredBy;     // human / machine / undefined
    const caller = req.body.From || "Unknown";

    console.log("---- MISSED CALL ----");
    console.log("Caller:", caller);
    console.log("Dial Status:", dialStatus);
    console.log("AnsweredBy:", answeredBy);

    // ONLY skip SMS if truly answered by you
    const wasAnswered =
      dialStatus === "completed" && answeredBy === "human";

    if (wasAnswered) {
      console.log("Call answered -> No SMS");
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    // Otherwise: MISSED → Send SMS
    console.log("Missed call -> Sending SMS");

    const client = twilio(
      TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN
    );

    await client.messages.create({
      from: TWILIO_NUMBER,
      to: OWNER_NUMBER,
      body: `Missed call from ${caller}`,
    });

    console.log("✅ SMS SENT");

    // Message for caller
    twiml.say(
      "Sorry we missed your call. Please text us your name and what you need."
    );
    twiml.hangup();

    return res.type("text/xml").send(twiml.toString());

  } catch (err) {
    console.error("MISSED ERROR:", err);

    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
});
