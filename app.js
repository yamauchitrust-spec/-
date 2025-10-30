// app.js（最上位 → カテゴリ → 機種 → クラス → 価格カード）
// ・林業用機械は“機種（フェラバン/グラップルソー/林業用グラップル）”から選択
// ・グラップルソー：仕様階層スキップ（クラス選択後に即価格）
// ・フェラバン 0.25㎥：排土板付き固定で即価格
// ・スライドアーム：通常/法面付きの2択＋法面加算自動計算
// ・Quick Replyのlabelは自動短縮（20文字制限）＆ postback は idx で軽量化
// ・「スライド」「テレスコ」→ スライドアームのクラス選択へ誘導
// ・Flexは6桁カラー、Node >= 18（fetchはグローバル）

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

// ---- スライドアーム 法面加算（以前のご指定どおり）----
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
// “機種（ベース名）”を抽出：括弧の前まで（全角/半角対応）
function baseModel(name = "") {
  const cut1 = name.split("（")[0];
  const cut2 = cut1.split("(")[0];
  return cut2.trim();
}

// スライドアームのベース項目を1つ取得（クラスごと）
// 優先：後方小旋回 → それ以外 → 先頭
function pickSlideBaseItem(cls) {
  const list = (master.items || []).filter(i => i.category === "スライドアーム" && i.class === cls);
  if (list.length === 0) return null;
  const pref = list.find(i => i.name.includes("後方小旋回"));
  return pref || list[0];
}

// ===== LINE 署名検証・返信 =====
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

// ===== UI（Flex） =====
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

// Quick Reply（最大13件・label20文字制限・postbackは idx のみで軽量化）
function quickReplyOptions(type, options, payloadKey, extra = {}) {
  const list = (options || []).filter(Boolean);
  const safeLabel = (s, max = 20) => {
    const arr = Array.from(String(s || ""));
    return arr.length <= max ? String(s) : arr.slice(0, max - 1).join("") + "…";
  };
  return {
    type: "text",
    text: `「${type}」を選んでください`,
    quickReply: {
      items: list.slice(0, 13).map((opt, i) => ({
        type: "action",
        action: {
          type: "postback",
          label: safeLabel(opt, 20),
          data: new URLSearchParams({ step: payloadKey, idx: String(i), ...extra }).toString(),
          displayText: String(opt)
        }
      }))
    }
  };
}

// カテゴリメニュー（多い場合はカルーセルに分割）
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
          action: { type: "message", label: cat, text: cat } // タップでテキスト送信
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

// “機種（ベース名）”メニュー（カテゴリ内）
function modelMenu(cat) {
  const names = [...new Set(
    (master.items || [])
      .filter(i => i.category === cat)
      .map(i => baseModel(i.name))
      .filter(Boolean)
  )];
  const chunk = (arr, n) => {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  };
  const groups = chunk(names, 10);
  const bubbles = groups.map((group, idx) => ({
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "text", text: `${cat}｜機種を選んでください ${groups.length>1 ? `(${idx+1}/${groups.length})` : ""}`, weight: "bold", size: "md", wrap: true },
        ...group.map(model => ({
          type: "button",
          style: "secondary",
          height: "sm",
          action: {
            type: "postback",
            label: model,
            data: new URLSearchParams({ step: "model", cat, model }).toString(),
            displayText: model
          }
        }))
      ]
    }
  }));
  return {
    type: "flex",
    altText: `${cat} の機種を選択`,
    contents: bubbles.length === 1 ? bubbles[0] : { type: "carousel", contents: bubbles }
  };
}

// 最上位メニュー
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

// ===== ハンドラ =====

// テキスト入力：カテゴリ→（林業用機械なら 機種）→クラス → 仕様（※特例はスキップ）
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
  const cats = [...new Set((master.items || []).map(i => i.category).filter(Boolean))];

  // いつでも「メニュー」でトップへ
  if (text === "メニュー") {
    return reply(ev.replyToken, rootMenu());
  }

  // 「レンタル金額を知りたい」→ カテゴリメニュー
  if (text === "レンタル金額を知りたい") {
    return reply(ev.replyToken, categoryMenu(cats));
  }

  // テキストがカテゴリ名に完全一致
  if (cats.includes(text)) {
    const cat = text;
    if (MODEL_FIRST_CATEGORIES.has(cat)) {
      return reply(ev.replyToken, modelMenu(cat)); // まず機種
    }
    // 通常カテゴリはクラス選択へ
    const classes = [
      ...new Set((master.items || [])
        .filter(i => i.category === cat)
        .map(i => i.class)
        .filter(Boolean))
    ];
    return reply(ev.replyToken, quickReplyOptions("クラス", classes, "cls", { cat }));
  }

  // 部分一致（例：「スライド」→スライドアーム）
  const hitCat = cats.find(c => text.includes(c));
  if (hitCat) {
    if (MODEL_FIRST_CATEGORIES.has(hitCat)) {
      return reply(ev.replyToken, modelMenu(hitCat));
    }
    const classes = [
      ...new Set((master.items || [])
        .filter(i => i.category === hitCat)
        .map(i => i.class)
        .filter(Boolean))
    ];
    return reply(ev.replyToken, quickReplyOptions("クラス", classes, "cls", { cat: hitCat }));
  }

  // どれにも当たらなければトップへ
  return reply(ev.replyToken, rootMenu());
}

async function handlePostback(ev) {
  const params = Object.fromEntries(new URLSearchParams(ev.postback.data || ""));
  const step = params.step;

  // 最上位アクション：カテゴリメニューへ
  if (step === "action" && params.value === "price") {
    const cats = [...new Set((master.items || []).map(i => i.category).filter(Boolean))];
    return reply(ev.replyToken, categoryMenu(cats));
  }

  // 機種選択（林業用機械など）
  if (step === "model") {
    const cat = params.cat;
    const model = params.model; // ベース名

    // ベース名一致でクラス一覧（重複排除）
    const classesAll = [
      ...new Set((master.items || [])
        .filter(i => i.category === cat && baseModel(i.name) === model)
        .map(i => i.class)
        .filter(Boolean))
    ];
    // クラス選択（postbackは idx）
    return reply(ev.replyToken, quickReplyOptions("クラス", classesAll, "cls", { cat, model }));
  }

  // カテゴリ → クラス（通常ルート）
  if (step === "cat") {
    const classesAll = [
      ...new Set((master.items || [])
        .filter(i => i.category === params.value)
        .map(i => i.class)
        .filter(Boolean))
    ];
    return reply(ev.replyToken, quickReplyOptions("クラス", classesAll, "cls", { cat: params.value }));
  }

  // クラス選択 → 仕様（★ 特例はスキップして即価格）
  if (step === "cls") {
    console.log("[CLS]", params);
    const cat = params.cat;

    // classesAll を再計算（idx → 実体化）
    const classesAll = [
      ...new Set((master.items || [])
        .filter(i => i.category === cat && (params.model ? baseModel(i.name) === params.model : true))
        .map(i => i.class)
        .filter(Boolean))
    ];
    const cls = params.idx != null ? classesAll[Number(params.idx)] : params.value;

    // ★ 特例1：グラップルソーは仕様スキップ → 即金額
    if (cat === "林業用機械" && (params.model === "グラップルソー" || params.model?.includes("グラップルソー"))) {
      const items = (master.items || []).filter(i =>
        i.category === cat &&
        i.class === cls &&
        baseModel(i.name) === "グラップルソー"
      );
      if (items.length === 0) {
        return reply(ev.replyToken, { type: "text", text: "該当データが見つかりませんでした。" });
      }
      const it = items[0];
      const v = pickVariant(it);
      const title = `${cat} ${cls}｜グラップルソー`;
      return reply(ev.replyToken, priceCard(title, v));
    }

    // ★ 特例2：フェラバン 0.25㎥ は排土板付き固定 → 即金額
    if (
      cat === "林業用機械" &&
      (params.model === "フェラバンチャーザウルスロボ" || params.model?.includes("フェラバン")) &&
      cls === "0.25㎥"
    ) {
      const items = (master.items || []).filter(i =>
        i.category === cat &&
        i.class === cls &&
        baseModel(i.name).includes("フェラバンチャーザウルスロボ")
      );
      if (items.length === 0) {
        return reply(ev.replyToken, { type: "text", text: "該当データが見つかりませんでした。" });
      }
      const it = items.find(i => i.name.includes("排土板")) || items[0];
      const v = pickVariant(it);
      const title = `${cat} ${cls}｜${baseModel(it.name)}（排土板付き）`;
      return reply(ev.replyToken, priceCard(title, v));
    }

    // ★ スライドアーム：通常/法面付き の2択を提示（この時点では価格出さない）
    if (cat === "スライドアーム") {
      return reply(ev.replyToken, quickReplyOptions("仕様", ["通常", "法面付き"], "name", { cat, cls }));
    }

    // 通常処理：仕様名一覧を作成 → Quick Reply（idx）
    const namesAll = [
      ...new Set((master.items || [])
        .filter(i =>
          i.category === cat &&
          i.class === cls &&
          (params.model ? baseModel(i.name) === params.model : true)
        )
        .map(i => i.name)
        .filter(Boolean))
    ];
    return reply(ev.replyToken, quickReplyOptions("仕様", namesAll, "name", { cat, cls }));
  }
  // 仕様選択 → 価格カード
  if (step === "name") {
    const cat = params.cat;
    const cls = params.cls;

    // ★ スライドアームの「通常/法面付き」は加算で即計算
    if (cat === "スライドアーム") {
      const choices = ["通常", "法面付き"];
      const chosen = params.idx != null ? choices[Number(params.idx)] : params.value;

      if (chosen === "通常" || chosen === "法面付き") {
        const it = pickSlideBaseItem(cls);
        if (!it) {
          return reply(ev.replyToken, { type: "text", text: "該当データが見つかりませんでした。" });
        }
        const v = pickVariant(it);

        if (chosen === "法面付き") {
          const add = SLOPE_ADD[cls] || { day: 0, month: 0 };
          v.day   = (v.day ?? 0) + add.day;
          v.month = (v.month ?? 0) + add.month;
          const title = `スライドアーム ${cls}｜${baseModel(it.name)}（法面付き）`;
          return reply(ev.replyToken, priceCard(title, v));
        } else {
          const title = `スライドアーム ${cls}｜${baseModel(it.name)}（通常）`;
          return reply(ev.replyToken, priceCard(title, v));
        }
      }
      // ここに来るのは通常の仕様名（個別行）を選んだ場合（将来拡張用）
    }

    // 通常：idx → 実体化して価格表示
    const namesAll = [
      ...new Set((master.items || [])
        .filter(i =>
          i.category === cat &&
          i.class === cls &&
          (params.model ? baseModel(i.name) === params.model : true)
        )
        .map(i => i.name)
        .filter(Boolean))
    ];
    const name = params.idx != null ? namesAll[Number(params.idx)] : params.value;

    const items = (master.items || []).filter(i =>
      i.category === cat && i.class === cls && i.name === name
    );
    if (items.length === 0) {
      console.warn("[NO MATCH]", params);
      return reply(ev.replyToken, { type: "text", text: "該当データが見つかりませんでした。" });
    }
    const it = items[0];
    const v = pickVariant(it);
    console.log("[PRICE]", { matched: params, variant: v });
    const title = `${cat} ${cls}｜${name}${v.label && v.label !== "通常" ? "・" + v.label : ""}`;
    return reply(ev.replyToken, priceCard(title, v));
  }
}

// ===== 診断API =====
app.get("/diag", (req, res) => {
  const { cat, cls, name } = req.query;
  const items = (master.items || []).filter(i => i.category === cat && i.class === cls && i.name === name);
  if (items.length === 0) return res.json({ ok: false, reason: "no_match", query: { cat, cls, name } });
  const it = items[0];
  const v = pickVariant(it);
  res.json({ ok: true, item: { category: it.category, class: it.class, name: it.name }, variant: v });
});

// ===== 起動確認 =====
app.get("/", (_, res) => res.send("LINE Bot OK"));
app.listen(PORT, () => console.log("Server started on", PORT));
