// app.js（安定版 + スタンプクラッシャー即金額表示）

import express from "express";
import crypto from "crypto";
import fs from "fs";

const app = express();
function rawBodySaver(req, res, buf) { req.rawBody = buf; }
app.use(express.json({ verify: rawBodySaver }));

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const PORT           = process.env.PORT || 3000;

// ---- master.json 読み込み ----
const master = JSON.parse(fs.readFileSync("./master.json", "utf8"));

// ---- LINE署名検証 ----
function validateSignature(req) {
  const signature = req.headers["x-line-signature"];
  const hmac = crypto.createHmac("sha256", CHANNEL_SECRET);
  hmac.update(req.rawBody);
  const digest = hmac.digest("base64");
  return signature === digest;
}

// ---- LINE返信 ----
async function reply(replyToken, payload) {
  const body = JSON.stringify({
    replyToken,
    messages: Array.isArray(payload) ? payload : [payload],
  });
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${CHANNEL_TOKEN}`
    },
    body
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[LINE API ERROR]", res.status, res.statusText, text);
  }
}

// ---- ユーティリティ ----
function toNumber(v) { return v == null ? null : Number(v); }
function baseModel(name = "") {
  const cut1 = name.split("（")[0];
  const cut2 = cut1.split("(")[0];
  return cut2.trim();
}
function pickVariant(it) {
  return {
    label: "通常",
    day: it.day, month: it.month, base: it.base,
    ins: it.ins, env: it.env, note: it.note || ""
  };
}

// ---- UIコンポーネント ----
function priceCard(title, p) {
  const fields = [
    ["日決め", p.day],
    ["月決め", p.month],
    ["基本管理料", p.base],
    ["保証料", p.ins],
    ["環境サービス料", p.env],
  ];
  const rows = fields.map(([k, n]) => ({
    type: "box",
    layout: "baseline",
    contents: [
      { type: "text", text: k, size: "sm", color: "#555", flex: 4 },
      { type: "text", text: n == null ? "―" : `¥${n.toLocaleString()}`, size: "sm", align: "end", flex: 6 }
    ]
  }));
  if (p.note) {
    rows.push({ type: "text", text: `備考：${p.note}`, size: "xs", color: "#888", wrap: true, margin: "md" });
  }
  return {
    type: "flex",
    altText: `${title} のレンタル価格`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: title, weight: "bold", size: "md" },
          { type: "separator", margin: "sm" },
          { type: "box", layout: "vertical", contents: rows, margin: "sm", spacing: "xs" }
        ]
      }
    },
    quickReply: {
      items: [{
        type: "action",
        action: { type: "message", label: "メニューに戻る", text: "メニュー" }
      }]
    }
  };
}

function quickReplyOptions(type, options, step, extra = {}) {
  return {
    type: "text",
    text: `「${type}」を選んでください`,
    quickReply: {
      items: options.slice(0, 13).map((opt, i) => ({
        type: "action",
        action: {
          type: "postback",
          label: opt,
          data: new URLSearchParams({ step, idx: i, ...extra }).toString(),
          displayText: opt
        }
      }))
    }
  };
}

function categoryMenu() {
  const cats = [...new Set(master.items.map(i => i.category))];
  const groups = [];
  for (let i = 0; i < cats.length; i += 10) groups.push(cats.slice(i, i + 10));
  const bubbles = groups.map((g, i) => ({
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: `カテゴリを選択してください (${i+1}/${groups.length})`, weight: "bold", size: "md" },
        ...g.map(c => ({
          type: "button",
          style: "secondary",
          height: "sm",
          action: { type: "message", label: c, text: c }
        }))
      ]
    }
  }));
  return {
    type: "flex",
    altText: "カテゴリを選択してください",
    contents: bubbles.length === 1 ? bubbles[0] : { type: "carousel", contents: bubbles }
  };
}

function rootMenu() {
  return {
    type: "flex",
    altText: "メニュー",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "メニュー", weight: "bold", size: "lg" },
          {
            type: "button",
            style: "primary",
            color: "#1DB446",
            action: {
              type: "postback",
              label: "レンタル金額を知りたい",
              data: new URLSearchParams({ step: "action", value: "price" }).toString(),
              displayText: "レンタル金額を知りたい"
            }
          }
        ]
      }
    }
  };
}

// ---- Webhook ----
app.post("/webhook", async (req, res) => {
  if (!validateSignature(req)) return res.status(401).end();
  const events = req.body.events || [];
  for (const ev of events) {
    try {
      if (ev.type === "follow") {
        await reply(ev.replyToken, rootMenu());
        continue;
      }
      if (ev.type === "message" && ev.message.type === "text") {
        await handleText(ev);
      } else if (ev.type === "postback") {
        await handlePostback(ev);
      }
    } catch (e) {
      console.error("[ERR]", e);
      await reply(ev.replyToken, { type: "text", text: "エラーが発生しました。" });
    }
  }
  res.status(200).end();
});

async function handleText(ev) {
  const text = ev.message.text.trim();
  const cats = [...new Set(master.items.map(i => i.category))];

  if (text === "メニュー") return reply(ev.replyToken, rootMenu());
  if (text === "レンタル金額を知りたい") return reply(ev.replyToken, categoryMenu());
  if (cats.includes(text)) {
    const cat = text;
    const classes = [...new Set(master.items.filter(i => i.category === cat).map(i => i.class))];
    return reply(ev.replyToken, quickReplyOptions("クラス", classes, "cls", { cat }));
  }
  return reply(ev.replyToken, rootMenu());
}

async function handlePostback(ev) {
  const params = Object.fromEntries(new URLSearchParams(ev.postback.data || ""));
  const step = params.step;

  if (step === "action" && params.value === "price") {
    return reply(ev.replyToken, categoryMenu());
  }

  if (step === "cls") {
    const cat = params.cat;
    const clsList = [...new Set(master.items.filter(i => i.category === cat).map(i => i.class))];
    const cls = clsList[Number(params.idx)];

    // ✅ チルトローテーター＆スタンプクラッシャー → 即価格表示
    if (["チルトローテーター", "スタンプクラッシャー"].includes(cat)) {
      const items = master.items.filter(i => i.category === cat && i.class === cls);
      if (items.length === 0) return reply(ev.replyToken, { type: "text", text: "該当データが見つかりません。" });
      const it = items[0];
      const v = pickVariant(it);
      const title = `${cat} ${cls}｜${baseModel(it.name)}`;
      return reply(ev.replyToken, priceCard(title, v));
    }

    // 通常カテゴリ → 仕様選択へ
    const names = [...new Set(master.items.filter(i => i.category === cat && i.class === cls).map(i => i.name))];
    return reply(ev.replyToken, quickReplyOptions("仕様", names, "name", { cat, cls }));
  }

  if (step === "name") {
    const cat = params.cat;
    const cls = params.cls;
    const names = [...new Set(master.items.filter(i => i.category === cat && i.class === cls).map(i => i.name))];
    const name = names[Number(params.idx)];
    const items = master.items.filter(i => i.category === cat && i.class === cls && i.name === name);
    if (items.length === 0) return reply(ev.replyToken, { type: "text", text: "該当データが見つかりません。" });
    const it = items[0];
    const v = pickVariant(it);
    const title = `${cat} ${cls}｜${name}`;
    return reply(ev.replyToken, priceCard(title, v));
  }
}

// ---- 起動 ----
app.get("/", (_, res) => res.send("LINE Bot OK"));
app.listen(PORT, () => console.log("Server started on", PORT));
