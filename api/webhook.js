module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).send("ok");
  }

  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  const body = req.body || {};

  if (body.type === "url_verification") {
    if (
      process.env.FEISHU_VERIFICATION_TOKEN &&
      body.token !== process.env.FEISHU_VERIFICATION_TOKEN
    ) {
      return res.status(403).json({ error: "Invalid verification token" });
    }

    return res.status(200).json({
      challenge: body.challenge
    });
  }

  return res.status(200).json({ ok: true });
};
