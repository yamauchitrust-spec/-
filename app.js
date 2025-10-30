// app.js (Flex準拠・色コード修正版)
import express from "express";
import crypto from "crypto";
import fs from "fs";

const app = express();

// ---- 生ボディ保持（署名検証用）----
function rawBodySaver(req, res, buf) { req.rawBody = buf; }
app.use(express.json({ verify: rawBodySaver }));

// ---- 環境変数 ----
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const PORT           = process.env.PORT || 3000;

// ---- master読み込み ----
const master = JSON.parse(fs.readFileSync("./master.json", "utf8"));

// ==================================================
//  数値変換・エイリアス対応
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
  const al = master.aliases || {};
  for (const [alias, canon] of Object.entries(al)) {
    if (t.includes(alias)) return t.replace(alias, canon);
  }
  return t;
}

// ==================================================
//  LINE署名検証 & 返信
// ==================================================
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
    console.error("[LINE API ERROR]", res.status,
