// app.js 完全版 - LINEレンタル価格Bot
import express from "express";
import line from "@line/bot-sdk";
import fs from "fs";

// ==== LINEチャネル設定 ====
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);
const app = express();
app.use(express.json());

// ==== レンタル価格マスタ読込 ====
const master = JSON.parse(fs.readFileSync("./master.json", "utf8"));

// ==== サーバ起動 ====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`サーバー起動：${PORT}`));

// ==== LINEイベント受信 ====
app.post("/webhook", (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).catch(console.error);
  res.status(200).end();
});

// ==== イベント処理 ====
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const text = event.message.text;
  const replyToken = event.replyToken;

  // --- トップメニュー ---
  if (text === "レンタル金額を知りたい") {
    const categories = [
      "油圧ショベル",
      "スライドアーム",
      "ロングアーム",
      "木材破砕機",
      "マルチャー",
      "スタンプクラッシャー",
      "林業用機械",
      "チルトローテーター",
      "クローラーフォーク",
      "キャリアダンプ",
      "ブルドーザー",
      "タイヤショベル",
      "コンパクトトラックローダー",
      "資材・備品",
    ];
    const items = categories.map(c => ({
      type: "action",
      action: { type: "message", label: c, text: c },
    }));

    return client.replyMessage(replyToken, {
      type: "text",
      text: "カテゴリを選択してください👇",
      quickReply: { items },
    });
  }

  // --- スタンプクラッシャー ---
  if (text === "スタンプクラッシャー") {
    const machines = ["SC400", "SC600", "SC850Pro"];
    return replyQuick(replyToken, machines, "スタンプクラッシャー");
  }
  if (text.includes("スタンプクラッシャー")) {
    const item = master.items.find(i =>
      i.category === "スタンプクラッシャー" && text.includes(i.name)
    );
    if (item) return replyPriceCard(replyToken, item);
  }

  // --- マルチャー ---
  if (text === "マルチャー") {
    const classes = ["0.1㎥", "0.2㎥", "0.25㎥", "0.45㎥"];
    return replyQuick(replyToken, classes, "マルチャー");
  }
  if (text.includes("マルチャー")) {
    const item = master.items.find(i =>
      i.category === "マルチャー" && text.includes(i.class)
    );
    if (item) return replyPriceCard(replyToken, item);
  }

  // --- スライドアーム ---
  if (text === "スライドアーム") {
    const classes = ["0.2㎥", "0.25㎥", "0.45㎥", "0.7㎥"];
    return replyQuick(replyToken, classes, "スライドアーム");
  }

  if (text.includes("スライドアーム")) {
    const item = master.items.find(i =>
      i.category === "スライドアーム" &&
      text.includes(i.class)
    );
    if (item) return replyPriceCard(replyToken, item);
  }

  // --- 林業用機械 ---
  if (text === "林業用機械") {
    const machines = ["フェラバンチャーザウルスロボ", "グラップルソー", "林業用グラップル"];
    return replyQuick(replyToken, machines, "林業用機械");
  }
  if (text.includes("林業用機械")) {
    const item = master.items.find(i =>
      i.category === "林業用機械" && text.includes(i.name)
    );
    if (item) return replyPriceCard(replyToken, item);
  }

  // --- チルトローテーター ---
  if (text === "チルトローテーター") {
    const classes = ["0.1㎥", "0.25㎥", "0.45㎥"];
    return replyQuick(replyToken, classes, "チルトローテーター");
  }
  if (text.includes("チルトローテーター")) {
    const item = master.items.find(i =>
      i.category === "チルトローテーター" && text.includes(i.class)
    );
    if (item) return replyPriceCard(replyToken, item);
  }

  // --- クローラーフォーク ---
  if (text === "クローラーフォーク") {
    const types = ["普通サヤ", "長サヤ"];
    return replyQuick(replyToken, types, "クローラーフォーク");
  }
  if (text.includes("クローラーフォーク")) {
    const item = master.items.find(i =>
      i.category === "クローラーフォーク" && text.includes(i.name)
    );
    if (item) return replyPriceCard(replyToken, item);
  }

  // --- 木材破砕機 ---
  if (text === "木材破砕機") {
    const types = ["SR3100", "MC2000", "MC4000/MC6000"];
    return replyQuick(replyToken, types, "木材破砕機");
  }
  if (text.includes("木材破砕機")) {
    const item = master.items.find(i =>
      i.category === "木材破砕機" && text.includes(i.name)
    );
    if (item) return replyPriceCard(replyToken, item);
  }

  // --- 資材・備品 ---
  if (text === "資材・備品") {
    const items = ["除湿器ドライマックス", "スポットクーラー", "アルミ代車", "鉄板3×6", "鉄板5×10", "鉄板5×20"];
    return replyQuick(replyToken, items, "資材・備品");
  }
  if (text.includes("資材・備品")) {
    const item = master.items.find(i =>
      i.category === "資材・備品" && text.includes(i.name)
    );
    if (item) return replyPriceCard(replyToken, item);
  }

  // --- その他カテゴリの共通処理 ---
  const item = master.items.find(i =>
    text.includes(i.category) && (text.includes(i.name) || text.includes(i.class))
  );
  if (item) return replyPriceCard(replyToken, item);
}

// === 共通関数 ===

// 🔹 クイックリプライ生成
function replyQuick(token, list, prefix) {
  const items = list.map(v => ({
    type: "action",
    action: { type: "message", label: v, text: `${prefix} ${v}` },
  }));
  return client.replyMessage(token, {
    type: "text",
    text: "選択してください👇",
    quickReply: { items },
  });
}

// 🔹 金額カード生成
function replyPriceCard(token, item) {
  const v = item.variants[0];
  const body = [
    { type: "text", text: `【${item.category}】${item.name} ${item.class || ""}`, weight: "bold", size: "md" },
    { type: "text", text: `日決め：¥${v.day.toLocaleString()}` },
    { type: "text", text: `月決め：¥${v.month.toLocaleString()}` },
    { type: "text", text: `基本管理料：¥${v.base.toLocaleString()}` },
    { type: "text", text: `保証料：¥${v.ins.toLocaleString()}` },
    { type: "text", text: `環境サービス料：¥${v.env.toLocaleString()}` }
  ];
  if (v.note) body.push({ type: "text", text: `備考：${v.note}` });

  return client.replyMessage(token, [
    {
      type: "flex",
      altText: `${item.name} のレンタル価格`,
      contents: { type: "bubble", body: { type: "box", layout: "vertical", contents: body } }
    },
    {
      type: "text",
      text: "🔁 メニューに戻る",
      quickReply: {
        items: [{ type: "action", action: { type: "message", label: "メニューへ", text: "レンタル金額を知りたい" } }]
      }
    }
  ]);
}
