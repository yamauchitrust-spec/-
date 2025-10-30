// app.js
import express from "express";
import crypto from "crypto";
import fs from "fs";

const app = express();
function rawBodySaver(req, res, buf) { req.rawBody = buf; }
app.use(express.json({ verify: rawBodySaver }));

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const PORT = process.env.PORT || 3000;

const master = JSON.parse(fs.readFileSync("./master.json", "utf8"));

function validateSignature(req) {
  const signature = req.headers["x-line-signature"];
  const hmac = crypto.createHmac("sha256", CHANNEL_SECRET);
  hmac.update(req.rawBody);
  const digest = hmac.digest("base64");
  return signature === digest;
}

async function reply(replyToken, payload) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${CHANNEL_TOKEN}`
    },
    body: JSON.stringify({
      replyToken,
      messages: Array.isArray(payload) ? payload : [payload],
    })
  });
}

function normalize(text) {
  const t = text.trim();
  const al = master.aliases || {};
  for (const [k,v] of Object.entries(al)) {
    if (t.includes(k)) return t.replace(k, v);
  }
  return t;
}

function quickReplyOptions(type, options, payloadKey, extra={}) {
  return {
    type: "text",
    text: `「${type}」を選んでください`,
    quickReply: {
      items: options.map(opt => ({
        type: "action",
        action: {
          type: "postback",
          label: opt,
          data: new URLSearchParams({ step: payloadKey, value: opt, ...extra }).toString(),
          displayText: opt
        }
      }))
    }
  };
}

function priceCard(title, p) {
  const rows = [
    ["日決め", p.day], ["月決め", p.month],
    ["基本管理料", p.base], ["保証料", p.ins], ["環境サービス料", p.env]
  ].map(([k,v]) => ({
    type:"box", layout:"baseline",
    contents:[
      {type:"text", text:k, size:"sm", color:"#555"},
      {type:"text", text: v==null ? "―" : `¥${Number(v).toLocaleString()}`, size:"sm", align:"end"}
    ]
  }));
  if (p.note) rows.push({ type:"text", text:`備考：${p.note}`, size:"xs", color:"#888", wrap:true });
  return {
    type: "flex",
    altText: "レンタル価格",
    contents: {
      type: "bubble",
      body: {
        type: "box", layout: "vertical", spacing: "md",
        contents: [
          { type: "text", text: title, weight: "bold", wrap: true },
          { type: "separator" },
          { type: "box", layout: "vertical", spacing: "sm", contents: rows }
        ]
      }
    }
  };
}

app.post("/webhook", async (req, res) => {
  if (!validateSignature(req)) return res.status(401).end();
  const events = req.body.events || [];
  for (const ev of events) {
    try {
      if (ev.type === "message" && ev.message.type === "text") {
        await handleText(ev);
      } else if (ev.type === "postback") {
        await handlePostback(ev);
      }
    } catch (e) {
      await reply(ev.replyToken, { type:"text", text:"エラーが発生しました。" });
      console.error(e);
    }
  }
  res.status(200).end();
});

async function handleText(ev) {
  const q = normalize(ev.message.text);
  const cats = [...new Set(master.items.map(i => i.category))];
  const hitCat = cats.find(c => q.includes(c)) || null;
  if (!hitCat) return reply(ev.replyToken, quickReplyOptions("カテゴリ", cats, "cat"));
  const classes = [...new Set(master.items.filter(i => i.category === hitCat).map(i => i.class))];
  return reply(ev.replyToken, quickReplyOptions("クラス", classes, "cls", { cat: hitCat }));
}

async function handlePostback(ev) {
  const params = Object.fromEntries(new URLSearchParams(ev.postback.data));
  const step = params.step;
  if (step === "cat") {
    const classes = [...new Set(master.items.filter(i => i.category === params.value).map(i => i.class))];
    return reply(ev.replyToken, quickReplyOptions("クラス", classes, "cls", { cat: params.value }));
  }
  if (step === "cls") {
    const list = master.items.filter(i => i.category === params.cat && i.class === params.value);
    const names = [...new Set(list.map(i => i.name))];
    return reply(ev.replyToken, quickReplyOptions("仕様", names, "name", { cat: params.cat, cls: params.value }));
  }
  if (step === "name") {
    const items = master.items.filter(i =>
      i.category === params.cat && i.class === params.cls && i.name === params.value
    );
    if (items.length === 0) return reply(ev.replyToken, { type:"text", text:"該当データがありません。" });
    const it = items[0];
    const v = it.variants ? it.variants[0] : null;
    const title = `${params.cat} ${params.cls}｜${params.value}`;
    return reply(ev.replyToken, priceCard(title, v));
  }
}

app.get("/", (_,res)=>res.send("LINE Bot OK"));
app.listen(PORT, ()=>console.log("Server started on", PORT));
