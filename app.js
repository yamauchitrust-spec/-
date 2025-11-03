// app.js（最上位 → カテゴリ → 機種 → クラス → 価格カード）
// 安定版：postback は idx 依存をやめ "val"（実値）で受け渡し。
// 追加：クローラーフォークはクラス選択をスキップして仕様（二択）へ直行。
// 追加：油圧ショベルのクラス並びで「ミニショベル」を先頭に固定。

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

// ---- “まず機種を選ぶ”カテゴリ ----
const MODEL_FIRST_CATEGORIES = new Set(["林業用機械"]);

// ---- スライドアーム 法面加算 ----
const SLOPE_ADD = {
  "0.2㎥":  { day: 2000, month:  20000 },
  "0.25㎥": { day: 3000, month:  30000 },
  "0.45㎥": { day: 4000, month:  40000 },
  "0.7㎥":  { day: 5000, month:  50000 },
};

// ===== ユーティリティ =====
function toHalfWidth(str) {
  return String(str)
    .replace(/[！-～]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, " ");
}
function toNumber(val) {
  if (val === null || val === undefined) return null;
  const s = toHalfWidth(String(val)).replace(/[^0-9.-]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function pickVariant(it) {
  if (it?.variants?.length > 0) return it.variants[0];
  return {
    label: "通常",
    day:   toNumber(it?.day),
    month: toNumber(it?.month),
    base:  toNumber(it?.base),
    ins:   toNumber(it?.ins),
    env:   toNumber(it?.env),
    note:  it?.note || ""
  };
}
function normalize(text) {
  const t = (text || "").trim();
  const defaultAliases = { "普通さや": "普通サヤ", "長さや": "長サヤ" };
  const al = { ...(master.aliases || {}), ...defaultAliases };
  for (const [alias, canon] of Object.entries(al)) {
    if (t.includes(alias)) return t.replace(alias, canon);
  }
  return t;
}
function baseModel(name = "") {
  const cut1 = name.split("（")[0];
  const cut2 = cut1.split("(")[0];
  return cut2.trim();
}

// 油圧ショベルのクラス並びを固定＋ミニショベル先頭
function getClassesForCategory(cat) {
  const raw = [
    ...new Set((master.items || [])
      .filter(i => i.category === cat)
      .map(i => i.class)
      .filter(Boolean))
  ];
  if (cat === "油圧ショベル") {
    const desired = ["ミニショベル", "0.1㎥", "0.2㎥", "0.25㎥", "0.45㎥", "0.7㎥"];
    const set = new Set(raw);
    const ordered = desired.filter(c => set.has(c));
    const others  = raw.filter(c => !desired.includes(c));
    return [...ordered, ...others];
  }
  return raw;
}

// ===== 署名検証・返信 =====
function validateSignature(req) {
  const signature = req.headers["x-line-signature"];
  const hmac = crypto.createHmac("sha256", CHANNEL_SECRET);
  hmac.update(req.rawBody);
  const digest = hmac.digest("base64");
  return signature === digest;
}
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

// ===== Flexカード =====
function priceCard(title, p) {
  const fields = [
    ["日決め",         toNumber(p?.day)],
    ["月決め",         toNumber(p?.month)],
    ["基本管理料",     toNumber(p?.base)],
    ["保証料",         toNumber(p?.ins)],
    ["環境サービス料", toNumber(p?.env)]
  ];
  const rows = fields.map(([k, n]) => ({
    type: "box",
    layout: "baseline",
    contents: [
      { type: "text", text: k, size: "sm", color: "#555555", flex: 4 },
      { type: "text", text: n == null ? "―" : `¥${n.toLocaleString()}`, size: "sm", align: "end", flex: 6 }
    ]
  }));
  if (p?.note) {
    rows.push({
      type: "text",
      text: `備考：${p.note}`,
      size: "xs",
      color: "#888888",
      wrap: true,
      margin: "md"
    });
  }

  return {
    type: "flex",
    altText: `${title} のレンタル価格`,
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "sm", contents: [
        { type: "text", text: title, weight: "bold", size: "md", wrap: true },
        { type: "separator", margin: "sm" },
        { type: "box", layout: "vertical", spacing: "xs", margin: "sm", contents: rows }
      ]}
    },
    quickReply: {
      items: [{ type: "action", action: { type: "message", label: "メニューに戻る", text: "メニュー" } }]
    }
  };
}

// ===== rootMenu =====
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
          { type: "text", text: "メニュー", weight: "bold", size: "lg", wrap: true },
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
          },
          { type: "separator", margin: "md" },
          { type: "text", text: "※「レンタル金額を知りたい」を押すとカテゴリ選択に進みます。", size: "xs", color: "#888", wrap: true }
        ]
      }
    }
  };
}

// ===== Webhook =====
app.post("/webhook", async (req, res) => {
  if (!validateSignature(req)) return res.status(401).end();
  const events = req.body.events || [];

  for (const ev of events) {
    try {
      if (ev.type === "follow") await reply(ev.replyToken, rootMenu());
      else if (ev.type === "message" && ev.message.type === "text") await handleText(ev);
      else if (ev.type === "postback") await handlePostback(ev);
    } catch (e) {
      console.error("[ERR]", e);
      await reply(ev.replyToken, { type: "text", text: "エラーが発生しました。" });
    }
  }
  res.status(200).end();
});

// ===== handleText =====
async function handleText(ev) {
  const textRaw = ev.message.text || "";
  const text = normalize(textRaw);
  const cats = [...new Set((master.items || []).map(i => i.category).filter(Boolean))];

  if (text === "メニュー") return reply(ev.replyToken, rootMenu());
  if (text === "レンタル金額を知りたい") return reply(ev.replyToken, categoryMenu(cats));

  if (cats.includes(text)) {
    const cat = text;
    if (cat === "クローラーフォーク") {
      return reply(ev.replyToken, quickReplyOptions("仕様", ["普通サヤ", "長サヤ"], "name", { cat }));
    }
    if (MODEL_FIRST_CATEGORIES.has(cat)) return reply(ev.replyToken, modelMenu(cat));
    const classes = getClassesForCategory(cat);
    return reply(ev.replyToken, quickReplyOptions("クラス", classes, "cls", { cat }));
  }
  return reply(ev.replyToken, rootMenu());
}

// ===== handlePostback =====
async function handlePostback(ev) {
  const params = Object.fromEntries(new URLSearchParams(ev.postback.data || ""));
  const step = params.step;

  if (step === "action" && params.value === "price") {
    const cats = [...new Set((master.items || []).map(i => i.category).filter(Boolean))];
    return reply(ev.replyToken, categoryMenu(cats));
  }

  if (step === "cat") {
    const catVal = params.val || params.value;
    if (catVal === "クローラーフォーク") {
      return reply(ev.replyToken, quickReplyOptions("仕様", ["普通サヤ", "長サヤ"], "name", { cat: catVal }));
    }
    const classesAll = getClassesForCategory(catVal);
    return reply(ev.replyToken, quickReplyOptions("クラス", classesAll, "cls", { cat: catVal }));
  }

  if (step === "name") {
    const cat = params.cat;
    const cls = params.cls;
    const name = params.val || params.value;

    let items;
    if (cat === "クローラーフォーク") {
      items = (master.items || []).filter(i => i.category === cat && i.name === name);
    } else {
      items = (master.items || []).filter(i => i.category === cat && i.class === cls && i.name === name);
    }

    if (items.length === 0) {
      const all = (master.items || []).filter(i => i.category === cat);
      const it = all.find(i => i.name?.includes(name));
      if (!it) return reply(ev.replyToken, { type: "text", text: "該当データが見つかりませんでした。" });
      const v = pickVariant(it);
      return reply(ev.replyToken, priceCard(`${cat} ${it.name}`, v));
    }

    const it = items[0];
    const v = pickVariant(it);
    return reply(ev.replyToken, priceCard(`${cat} ${it.name}`, v));
  }
}

// ===== 起動確認 =====
app.get("/", (_, res) => res.send("LINE Bot OK"));
app.listen(PORT, () => console.log("Server started on", PORT));
