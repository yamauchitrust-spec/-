// app.js（最上位メニュー→カテゴリタップ式 / Flex準拠＋6桁カラー）
// Node >=18（fetchはグローバル）

import express from "express";
import crypto from "crypto";
import fs from "fs";

const app = express();
function rawBodySaver(req, res, buf) { req.rawBody = buf; }
app.use(express.json({ verify: rawBodySaver }));

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const PORT           = process.env.PORT || 3000;

const master = JSON.parse(fs.readFileSync("./master.json", "utf8"));

// ===== 数値補正 =====
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

// ===== 正規化（エイリアス対応） =====
function normalize(text) {
  const t = (text || "").trim();
  const al = master.aliases || {};
  for (const [alias, canon] of Object.entries(al)) {
    if (t.includes(alias)) return t.replace(alias, canon);
  }
  return t;
}

// ===== UI（価格カード / カテゴリメニュー / ルートメニュー） =====
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
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: title, weight: "bold", size: "md", wrap: true },
          { type: "separator", margin: "sm" },
          { type: "box", layout: "vertical", spacing: "xs", margin: "sm", contents: rows }
        ]
      }
    }
  };
}

// カテゴリメニュー（多い場合はカルーセルに自動分割）
function categoryMenu(categories) {
  const chunk = (arr, n) => {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  };
  const groups = chunk(categories, 10);

  const bubbles = groups.map((group, idx) => ({
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: `カテゴリを選択してください ${groups.length>1 ? `(${idx+1}/${groups.length})` : ""}`, weight: "bold", size: "md", wrap: true },
        ...group.map(cat => ({
          type: "button",
          style: "secondary",
          height: "sm",
          action: { type: "message", label: cat, text: cat }
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

// 最上位メニュー（レンタル金額を知りたい）
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
            height: "md",
            action: {
              type: "postback",
              label: "レンタル金額を知りたい",
              data: new URLSearchParams({ step: "action", value: "price" }).toString(),
              displayText: "レンタル金額を知りたい"
            }
          },
          { type: "separator", margin: "md" },
          {
            type: "text",
            text: "※「レンタル金額を知りたい」を押すとカテゴリ選択に進みます。",
            size: "xs",
            color: "#888888",
            wrap: true
          }
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
      // 友だち追加時：最上位メニューを表示
      if (ev.type === "follow") {
        await reply(ev.replyToken, rootMenu());
        continue;
      }

      if (ev.type === "message" && ev.message.type === "text") {
        await handleText(ev); // 中でトップメニューを返す
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

// どんなテキストでも、まずは最上位メニューを返す
async function handleText(ev) {
  const textRaw = ev.message.text || "";
  const text = normalize(textRaw);

  // いつでも「メニュー」でトップへ戻れる
  if (text === "メニュー") {
    return reply(ev.replyToken, rootMenu());
  }

  // 初回/自由入力：まずトップを見せる
  return reply(ev.replyToken, rootMenu());
}

async function handlePostback(ev) {
  const params = Object.fromEntries(new URLSearchParams(ev.postback.data || ""));
  const step = params.step;

  // ルートメニュー：「レンタル金額を知りたい」→ カテゴリ選択へ
  if (step === "action" && params.value === "price") {
    const cats = [...new Set((master.items || []).map(i => i.category).filter(Boolean))];
    return reply(ev.replyToken, categoryMenu(cats));
  }

  if (step === "cat") {
    const classes = [
      ...new Set((master.items || [])
        .filter(i => i.category === params.value)
        .map(i => i.class)
        .filter(Boolean))
    ];
    return reply(ev.replyToken, quickReplyOptions("クラス", classes, "cls", { cat: params.value }));
  }

  if (step === "cls") {
    const list = (master.items || []).filter(i =>
      i.category === params.cat && i.class === params.value
    );
    const names = [...new Set(list.map(i => i.name).filter(Boolean))];
    return reply(ev.replyToken, quickReplyOptions("仕様", names, "name", { cat: params.cat, cls: params.value }));
  }

  if (step === "name") {
    const items = (master.items || []).filter(i =>
      i.category === params.cat && i.class === params.cls && i.name === params.value
    );
    if (items.length === 0)
      return reply(ev.replyToken, { type: "text", text: "該当データが見つかりませんでした。" });

    const it = items[0];
    const v = pickVariant(it);
    console.log("[PRICE]", { matched: params, variant: v });
    const title = `${params.cat} ${params.cls}｜${params.value}${v.label && v.label !== "通常" ? "・" + v.label : ""}`;
    return reply(ev.replyToken, priceCard(title, v));
  }
}

// ===== 診断 =====
app.get("/diag", (req, res) => {
  const { cat, cls, name } = req.query;
  const items = (master.items || []).filter(i => i.category === cat && i.class === cls && i.name === name);
  if (items.length === 0) return res.json({ ok: false, reason: "no_match", query: { cat, cls, name } });
  const it = items[0];
  const v = pickVariant(it);
  res.json({ ok: true, item: { category: it.category, class: it.class, name: it.name }, variant: v });
});

app.get("/", (_, res) => res.send("LINE Bot OK"));
app.listen(PORT, () => console.log("Server started on", PORT));
