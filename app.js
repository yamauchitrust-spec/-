
// app.js（最新版・チルトローテーター仕様スキップ対応）

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

// ... あなたの最新版 app.js の全体コードここに続く ...

// handlePostback 内の該当部分に以下を組み込み

// ★特例（保険）：クローラーフォークがここに来た場合でも直行
if (cat === "クローラーフォーク") {
  return reply(ev.replyToken,
    quickReplyOptions("仕様", ["普通サヤ", "長サヤ"], "name", { cat })
  );
}

// ★特例: チルトローテーターは仕様選択をスキップして即価格表示
if (cat === "チルトローテーター") {
  const cls = params.val || "標準";
  const items = (master.items || []).filter(i =>
    i.category === cat && (i.class === cls || !i.class)
  );
  if (items.length === 0)
    return reply(ev.replyToken, { type: "text", text: "該当データが見つかりませんでした。" });
  
  const it = items[0];
  const v = pickVariant(it);
  const title = `${cat}${cls ? " " + cls : ""}｜${it.name}`;
  return reply(ev.replyToken, priceCard(title, v));
}

// 特例1：グラップルソー（林業用機械）→ 即価格
if (cat === "林業用機械" && (params.model === "グラップルソー" || params.model?.includes("グラップルソー"))) {
  const items = (master.items || []).filter(i =>
    i.category === cat &&
    i.class === cls &&
    baseModel(i.name) === "グラップルソー"
  );
  if (items.length === 0) return reply(ev.replyToken, { type: "text", text: "該当データが見つかりませんでした。" });
  const it = items[0];
  const v = pickVariant(it);
  const title = `${cat} ${cls}｜グラップルソー`;
  return reply(ev.replyToken, priceCard(title, v));
}

// ... あなたの残りの app.js 処理
