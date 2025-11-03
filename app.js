// app.js（最上位 → カテゴリ → 機種 → クラス → 価格カード）
// idx依存をやめ、postbackに"val"（実値）を載せて受信側はval優先で照合する安定版＋スタンプクラッシャー常時表示。

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

// ---- 常時表示カテゴリ（データ未登録でも出す）----
const ALWAYS_ON_CATEGORIES = ["スタンプクラッシャー"];
function allCategories() {
  const set = new Set((master.items || []).map(i => i.category).filter(Boolean));
  for (const c of ALWAYS_ON_CATEGORIES) set.add(c);
  return [...set];
}

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
  const al = master.aliases || {};
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

function getClassesForCategory(cat) {
  const raw = [
    ...new Set((master.items || [])
      .filter(i => i.category === cat)
      .map(i => i.class)
      .filter(Boolean))
  ];
  if (cat === "油圧ショベル") {
    const desired = ["0.1㎥", "0.2㎥", "0.25㎥", "0.45㎥", "0.7㎥"];
    const set = new Set(raw);
    const ordered = desired.filter(c => set.has(c));
    const others  = raw.filter(c => !desired.includes(c));
    return [...ordered, ...others];
  }
  return raw;
}

// ===== LINE検証・返信など省略部分はそのまま =====

// ===== handleText のカテゴリ取得部分を以下に置換 =====
async function handleText(ev) {
  const textRaw = ev.message.text || "";
  const text0 = normalize(textRaw);

  // 「スライド」「テレスコ」はスライドアームに誘導
  if (/(^|.*)(スライド|テレスコ)(.*|$)/.test(text0)) {
    const classes = [
      ...new Set((master.items || [])
        .filter(i => i.category === "スライドアーム")
        .map(i => i.class)
        .filter(Boolean))
    ];
    return reply(ev.replyToken, quickReplyOptions("クラス", classes, "cls", { cat: "スライドアーム" }));
  }

  const text = text0;
  const cats = allCategories(); // ← 修正済み

  if (text === "メニュー") {
    return reply(ev.replyToken, rootMenu());
  }
  if (text === "レンタル金額を知りたい") {
    return reply(ev.replyToken, categoryMenu(cats));
  }

  if (cats.includes(text)) {
    const cat = text;
    const classes = getClassesForCategory(cat);

    // ★ データ未登録カテゴリ対応
    if (!classes || classes.length === 0) {
      return reply(ev.replyToken, {
        type: "text",
        text: `「${cat}」は現在データ準備中です。\nmaster.json にアイテムを追加すると選択できるようになります。\n\nメニューに戻る → 「メニュー」`
      });
    }

    if (MODEL_FIRST_CATEGORIES.has(cat)) {
      return reply(ev.replyToken, modelMenu(cat));
    }
    return reply(ev.replyToken, quickReplyOptions("クラス", classes, "cls", { cat }));
  }

  return reply(ev.replyToken, rootMenu());
}

// ===== handlePostback の最初のカテゴリ部分を置換 =====
async function handlePostback(ev) {
  const params = Object.fromEntries(new URLSearchParams(ev.postback.data || ""));
  const step = params.step;

  if (step === "action" && params.value === "price") {
    const cats = allCategories(); // ← 修正済み
    return reply(ev.replyToken, categoryMenu(cats));
  }

  // （以降の処理はそのままでOK）
}
