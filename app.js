// app.js
import express from "express";
import line from "@line/bot-sdk";
import fs from "fs";

// ===== LINE 設定 =====
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new line.Client(config);
const app = express();
app.use(express.json());

// ===== master.json 読み込み =====
const master = JSON.parse(fs.readFileSync("./master.json", "utf-8"));

// ===== 金額カード生成関数 =====
function replyPriceCard(replyToken, item) {
  const v = item.variants[0];
  const contents = [
    { type: "text", text: `${item.category} ${item.class} ${item.name}`, weight: "bold", size: "md" },
    { type: "text", text: `日決め: ¥${v.day.toLocaleString()}` },
    { type: "text", text: `月決め: ¥${v.month.toLocaleString()}` },
    { type: "text", text: `基本管理料: ¥${v.base.toLocaleString()}` },
    { type: "text", text: `保証料: ¥${v.ins.toLocaleString()}` },
    { type: "text", text: `環境サービス料: ¥${v.env.toLocaleString()}` }
  ];
  if (v.note && v.note !== "0") contents.push({ type: "text", text: `備考: ${v.note}` });

  return client.replyMessage(replyToken, {
    type: "flex",
    altText: `${item.name} のレンタル金額`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents
      },
      footer: {
        type: "box",
        layout: "horizontal",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#1DB446",
            action: { type: "message", label: "メニューに戻る", text: "レンタル金額を知りたい" }
          }
        ]
      }
    }
  });
}

// ===== メッセージ応答 =====
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  if (!events || !events.length) return res.status(200).end();
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text;
  const replyToken = event.replyToken;

  // --- トップメニュー ---
  if (text === "レンタル金額を知りたい" || text === "メニューに戻る") {
    const cats = [...new Set(master.items.map(i => i.category))];
    const items = cats.map(c => ({
      type: "action",
      action: { type: "message", label: c, text: c }
    }));
    return client.replyMessage(replyToken, {
      type: "text",
      text: "カテゴリを選択してください👇",
      quickReply: { items }
    });
  }

  // --- チルトローテーター（クラス選択→即金額表示） ---
  if (text === "チルトローテーター") {
    const classes = ["0.1㎥", "0.25㎥", "0.45㎥"];
    const items = classes.map(c => ({
      type: "action",
      action: { type: "message", label: c, text: `チルトローテーター ${c}` }
    }));
    return client.replyMessage(replyToken, {
      type: "text",
      text: "クラスを選択してください👇",
      quickReply: { items }
    });
  }

  const m = text.match(/^チルトローテーター\s+(0\.1㎥|0\.25㎥|0\.45㎥)$/);
  if (m) {
    const cls = m[1];
    const item = master.items.find(i =>
      i.category === "チルトローテーター" && i.class === cls
    );
    if (item) return replyPriceCard(replyToken, item);

    const fallback = master.items.find(i =>
      i.category === "チルトローテーター" && text.includes(i.class)
    );
    if (fallback) return replyPriceCard(replyToken, fallback);

    return client.replyMessage(replyToken, {
      type: "text",
      text: "該当クラスが見つかりませんでした。"
    });
  }

  // --- 共通カテゴリ選択 ---
  const categoryItems = master.items.filter(i => i.category === text);
  if (categoryItems.length > 0) {
    const classes = [...new Set(categoryItems.map(i => i.class))];
    const items = classes.map(c => ({
      type: "action",
      action: { type: "message", label: c, text: `${text} ${c}` }
    }));
    return client.replyMessage(replyToken, {
      type: "text",
      text: "クラスを選択してください👇",
      quickReply: { items }
    });
  }

  // --- クラス選択後（通常カテゴリ） ---
  const [cat, cls] = text.split(" ");
  const items = master.items.filter(i => i.category === cat && i.class === cls);
  if (items.length > 0) {
    const names = [...new Set(items.map(i => i.name))];
    const q = names.map(n => ({
      type: "action",
      action: { type: "message", label: n, text: `${cat} ${cls} ${n}` }
    }));
    return client.replyMessage(replyToken, {
      type: "text",
      text: "仕様を選択してください👇",
      quickReply: { items: q }
    });
  }

  // --- 最終（仕様まで選択）で金額表示 ---
  const parts = text.split(" ");
  if (parts.length >= 3) {
    const [cat2, cls2, ...rest] = parts;
    const name = rest.join(" ");
    const item = master.items.find(
      i => i.category === cat2 && i.class === cls2 && i.name === name
    );
    if (item) return replyPriceCard(replyToken, item);
  }

  // --- 不明な入力 ---
  return client.replyMessage(replyToken, {
    type: "text",
    text: "選択肢からお選びください。"
  });
}

// ===== サーバ起動 =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`サーバー起動: ${PORT}`));
