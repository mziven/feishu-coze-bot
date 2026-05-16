const express = require("express");
const crypto = require("crypto");

const app = express();

app.use(express.text({ type: "*/*" }));

const seenEvents = new Map();

function isDuplicate(eventId) {
  if (!eventId) return false;

  const now = Date.now();
  for (const [key, time] of seenEvents.entries()) {
    if (now - time > 10 * 60 * 1000) {
      seenEvents.delete(key);
    }
  }

  if (seenEvents.has(eventId)) return true;

  seenEvents.set(eventId, now);
  return false;
}

function parseBody(rawBody) {
  if (!rawBody) return {};
  if (typeof rawBody === "object") return rawBody;
  return JSON.parse(rawBody);
}

function verifyFeishuRequest(req, rawBody) {
  const appSecret = process.env.FEISHU_APP_SECRET;
  const timestamp = req.get("x-lark-request-timestamp");
  const signature = req.get("x-lark-signature");

  if (!appSecret || !timestamp || !signature) {
    return true;
  }

  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(`${timestamp}\n${rawBody}`)
    .digest("base64");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function getTextFromMessage(event) {
  const content = event?.message?.content;
  if (!content) return "";

  try {
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    return parsed.text || "";
  } catch {
    return String(content);
  }
}

async function getTenantAccessToken() {
  const response = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        app_id: process.env.FEISHU_APP_ID,
        app_secret: process.env.FEISHU_APP_SECRET
      })
    }
  );

  const data = await response.json();

  if (!response.ok || !data.tenant_access_token) {
    throw new Error(`Failed to get Feishu tenant token: ${JSON.stringify(data)}`);
  }

  return data.tenant_access_token;
}

async function sendFeishuMessage(chatId, text) {
  const token = await getTenantAccessToken();

  const response = await fetch(
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text })
      })
    }
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new Error(`Failed to send Feishu message: ${JSON.stringify(data)}`);
  }
}

function extractCozeAnswer(rawText) {
  let answer = "";

  for (const line of rawText.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed.startsWith("data:")) continue;

    const jsonText = trimmed.replace(/^data:\s*/, "");
    if (!jsonText || jsonText === "[DONE]") continue;

    try {
      const data = JSON.parse(jsonText);

      if (typeof data.content === "string") {
        answer = data.content;
      }

      if (typeof data?.content?.text === "string") {
        answer = data.content.text;
      }

      if (typeof data?.data?.content === "string") {
        answer = data.data.content;
      }

      if (typeof data?.data?.content?.text === "string") {
        answer = data.data.content.text;
      }
    } catch {}
  }

  return answer || rawText;
}

async function callCoze(text, sessionId) {
  const response = await fetch(process.env.COZE_CHAT_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.COZE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content: {
        query: {
          prompt: [
            {
              type: "text",
              content: {
                text
              }
            }
          ]
        }
      },
      type: "query",
      session_id: sessionId,
      project_id: Number(process.env.COZE_PROJECT_ID)
    })
  });

  const rawText = await response.text();

  if (!response.ok) {
    throw new Error(`Coze request failed: ${rawText}`);
  }

  return extractCozeAnswer(rawText);
}

app.post("/api/webhook", async (req, res) => {
  const rawBody = req.body || "";

  try {
    const body = parseBody(rawBody);

    if (body.type === "url_verification") {
      if (
        process.env.FEISHU_VERIFICATION_TOKEN &&
        body.token !== process.env.FEISHU_VERIFICATION_TOKEN
      ) {
        return res.status(403).json({ error: "Invalid verification token" });
      }

      return res.json({ challenge: body.challenge });
    }

    if (!verifyFeishuRequest(req, rawBody)) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const eventId = body.event_id || body.uuid || body.header?.event_id;
    if (isDuplicate(eventId)) {
      return res.status(200).json({ ok: true, duplicate: true });
    }

    const event = body.event;
    const message = event?.message;

    if (!message || message.message_type !== "text") {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const chatId = message.chat_id;
    const userText = getTextFromMessage(event);

    if (!chatId || !userText) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const sessionId = chatId;
    const answer = await callCoze(userText, sessionId);

    await sendFeishuMessage(chatId, answer || "我暂时没有生成有效回复。");

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(200).json({
      ok: true,
      handled: true,
      error: error.message
    });
  }
});

module.exports = app;
