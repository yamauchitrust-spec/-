// app.js
import express from "express";
import crypto from "crypto";
import fs from "fs";

const app = express();

// ---- 生ボディ保持（LINE署名検証用）----
function rawBodySaver(req, res, buf) { req.rawBody = buf; }
app.use(express.json({ verify: rawBodySaver }));

// ---- 環境変数 ----
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const PORT           = process.env.PORT || 3000;

// ---- master読込（同階層の master.json）----
const master = JSON.parse(fs.readFileSync("./master.json", "utf8"));

// ==================================================
//  ヘルパー：数値の安全化（"¥20,000" や 全角 "２００００" もOK）
// ==================================================
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

// variants が無くても旧形式（日/月/基本/保証/環境）が直下にあれば拾う
function pickVariant(it) {
  if (it?.variants?.length > 0) return it.variants[0];
  return {
    label: "通常",
    day:  toNumber(it?.day),
    month: toNumber(it?.month),
    base: toNumber(it?.base),
    ins:  toNumber(it?.ins),
    env:  toNumber(it?.env),
    note: it?.note || ""
  };
}

// ==================================================
//  LINE 署名検証 & 返信
// ==================================================
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

// ==================================================
//  同義語対応（スライド/テレスコ、フェラバン 等）
// ==================================================
function normalize(text) {
  const t = text.trim();
  const al = master.aliases || {};
  for (const [alias, canon] of Object.entries(al)) {
    if (t.includes(alias)) return t.replace(alias, canon);
  }
  return t;
}

// ==================================================
//  UI生成
// ==================================================
function quickReplyOptions(type, options, payloadKey, extra = {}) {
  const items = (options || []).filter(Boolean);
  return {
    type: "text",
    text: `「${type}」を選んでください`,
    quickReply: {
      items: items.map(opt => ({
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
  // 念のためここでも数値化
  const fields = [
    ["日決め",   toNumber(p?.day)],
    ["月決め",   toNumber(p?.month)],
    ["基本管理料", toNumber(p?.base)],
    ["保証料",     toNumber(p?.ins)],
    ["環境サービス料", toNumber(p?.env)],
  ];

  const rows = fields.map(([k, n]) => ({
    type: "box",
    layout: "baseline",
    contents: [
      { type: "text", text: k, size: "sm", color: "#555" },
      { type: "text", text: n == null ? "―" : `¥${n.toLocaleString()}`, size: "sm", align: "end" }
    ]
  }));

  if (p?.note) {
    rows.push({ type: "text", text: `備考：${p.note}`, size: "xs", color: "#888", wrap: true });
  }

  return {
    type: "flex",
    altText: "レンタル価格",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: title, weight: "bold", wrap: true },
          { type: "separator" },
          { type: "box", layout: "vertical", spacing: "sm", contents: rows }
        ]
      }
    }
  };
}

// ==================================================
//  Webhook
// ==================================================
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
      console.error(e);
      await reply(ev.replyToken, { type: "text", text: "エラーが発生しました。入力内容をご確認ください。" });
    }
  }
  res.status(200).end();
});

// 最初のテキスト：カテゴリを推定→無ければ選ばせる
async function handleText(ev) {
  const q = normalize(ev.message.text);
  const cats = [...new Set((master.items || []).map(i => i.category).filter(Boolean))];

  // ざっくり含有でカテゴリ当て
  const hitCat = cats.find(c => q.includes(c)) || null;

  if (!hitCat) {
    return reply(ev.replyToken, quickReplyOptions("カテゴリ", cats, "cat"));
  }

  const classes = [
    ...new Set((master.items || [])
      .filter(i => i.category === hitCat)
      .map(i => i.class)
      .filter(Boolean))
  ];

  return reply(ev.replyToken, quickReplyOptions("クラス", classes, "cls", { cat: hitCat }));
}

async function handlePostback(ev) {
  const params = Object.fromEntries(new URLSearchParams(ev.postback.data || ""));
  const step = params.step;

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

    // 仕様が1件しか無い時はそのまま確定して金額表示に進めても良いが、明示選択に統一
    return reply(ev.replyToken, quickReplyOptions("仕様", names, "name", {
      cat: params.cat,
      cls: params.value
    }));
  }

  if (step === "name") {
    const items = (master.items || []).filter(i =>
      i.category === params.cat && i.class === params.cls && i.name === params.value
    );
    if (items.length === 0) {
      return reply(ev.replyToken, { type: "text", text: "該当データが見つかりませんでした。" });
    }

    const it = items[0];

    // バリエーションが複数あれば選択へ
    if (it.variants && it.variants.length > 1) {
      const labels = it.variants.map(v => v.label).filter(Boolean);
      return reply(ev.replyToken, quickReplyOptions("バリエーション", labels, "var", {
        cat: params.cat, cls: params.cls, name: params.value
      }));
    }

    // 単一バリアント or 旧形式（日/月…が直下）に対応
    const v = pickVariant(it);
    const title = `${params.cat} ${params.cls}｜${params.value}${v.label && v.label !== "通常" ? "・" + v.label : ""}`;
    return reply(ev.replyToken, priceCard(title, v));
  }

  if (step === "var") {
    const item = (master.items || []).find(i =>
      i.category === params.cat && i.class === params.cls && i.name === params.name
    );
    if (!item) {
      return reply(ev.replyToken, { type: "text", text: "該当データが見つかりませんでした。" });
    }
    const v = (item.variants || []).find(x => x.label === params.value) || pickVariant(item);
    const title = `${params.cat} ${params.cls}｜${params.name}${v.label && v.label !== "通常" ? "・" + v.label : ""}`;
    return reply(ev.replyToken, priceCard(title, v));
  }
}

// 起動確認
app.get("/", (_, res) => res.send("LINE Bot OK"));
app.listen(PORT, () => console.log("Server started on", PORT));
