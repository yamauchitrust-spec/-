// app.js（最上位 → カテゴリ → 機種 → クラス → 価格カード）
// idx依存をやめ、postbackに実値"val"を載せて受信側はval優先で照合する安定版。
// 追加: クローラーフォークはクラス選択をスキップして仕様（普通サヤ/長サヤ）に直行
// 追加: 油圧ショベルのクラス並びを「ミニショベル, 0.1, 0.2, 0.25, 0.45, 0.7」に固定（存在するものだけ）

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

// 油圧ショベルのクラス並びを固定（存在するものだけ）※ミニショベルを先頭に
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

// スライドアーム：選択条件でベース行を絞り込む
// pose: "後方小旋回" | "超小旋回" | "スタンダード" | undefined
// crane: "クレーン仕様" | "クレーン無し" | undefined
// track: "鉄キャタ" | "ゴムキャタ" | undefined
function pickSlideBaseItem(cls, pose, crane, track) {
  let list = (master.items || []).filter(i => i.category === "スライドアーム" && i.class === cls);
  if (list.length === 0) return null;

  // 0.25㎥：pose（後方/超小）
  if (cls === "0.25㎥" && pose) {
    const withPose = list.filter(i => i.name.includes(pose));
    if (withPose.length) list = withPose;
  }

  // 0.45㎥：クレーン仕様/無し
  if (cls === "0.45㎥" && crane) {
    if (crane === "クレーン仕様") {
      const onlyCrane = list.filter(i => i.name.includes("クレーン"));
      if (onlyCrane.length) list = onlyCrane;
    } else if (crane === "クレーン無し") {
      const noCrane = list.filter(i => !i.name.includes("クレーン"));
      if (noCrane.length) list = noCrane;
    }
  }

  // 0.7㎥：pose → track → crane
  if (cls === "0.7㎥") {
    if (pose) {
      const byPose = list.filter(i => i.name.includes(pose));
      if (byPose.length) list = byPose;
    }
    if (track) {
      const byTrack = list.filter(i => i.name.includes(track));
      if (byTrack.length) list = byTrack;
    }
    if (crane) {
      if (crane === "クレーン仕様") {
        const onlyCrane = list.filter(i => i.name.includes("クレーン"));
        if (onlyCrane.length) list = onlyCrane;
      } else if (crane === "クレーン無し") {
        const noCrane = list.filter(i => !i.name.includes("クレーン"));
        if (noCrane.length) list = noCrane;
      }
    }
  }

  // 最終優先：後方小旋回 → それ以外
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

  // 価格表示後に「メニューに戻る」を Quick Reply で出す
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
    },
    quickReply: {
      items: [{
        type: "action",
        action: { type: "message", label: "メニューに戻る", text: "メニュー" }
      }]
    }
  };
}

// ラベル20文字制限を安全に丸める
function safeLabel(s, max = 20) {
  const arr = Array.from(String(s || ""));
  return arr.length <= max ? String(s) : arr.slice(0, max - 1).join("") + "…";
}

// Quick Reply（idxではなく、postback.data に実値 "val" を入れる）
function quickReplyOptions(type, options, step, extra = {}) {
  const list = (options || []).filter(Boolean);
  return {
    type: "text",
    text: `「${type}」を選んでください`,
    quickReply: {
      items: list.slice(0, 13).map((opt) => ({
        type: "action",
        action: {
          type: "postback",
          label: safeLabel(opt, 20),
          data: new URLSearchParams({ step, val: String(opt), ...extra }).toString(),
          displayText: String(opt)
        }
      }))
    }
  };
}

// カテゴリメニュー（多い場合はカルーセル分割）
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
            label: safeLabel(model),
            data: new URLSearchParams({ step: "model", cat, val: model }).toString(),
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

  if (text === "メニュー") {
    return reply(ev.replyToken, rootMenu());
  }
  if (text === "レンタル金額を知りたい") {
    return reply(ev.replyToken, categoryMenu(cats));
  }

  if (cats.includes(text)) {
    const cat = text;
    // ★ 特例：クローラーフォークはクラス選択をスキップして仕様へ直行
    if (cat === "クローラーフォーク") {
      return reply(ev.replyToken,
        quickReplyOptions("仕様", ["普通サヤ", "長サヤ"], "name", { cat })
      );
    }
    if (MODEL_FIRST_CATEGORIES.has(cat)) {
      return reply(ev.replyToken, modelMenu(cat));
    }
    const classes = getClassesForCategory(cat);
    return reply(ev.replyToken, quickReplyOptions("クラス", classes, "cls", { cat }));
  }

  const hitCat = cats.find(c => text.includes(c));
  if (hitCat) {
    if (MODEL_FIRST_CATEGORIES.has(hitCat)) {
      return reply(ev.replyToken, modelMenu(hitCat));
    }
    const classes = getClassesForCategory(hitCat);
    return reply(ev.replyToken, quickReplyOptions("クラス", classes, "cls", { cat: hitCat }));
  }

  return reply(ev.replyToken, rootMenu());
}

async function handlePostback(ev) {
  const params = Object.fromEntries(new URLSearchParams(ev.postback.data || ""));
  const step = params.step;

  // 最上位アクション
  if (step === "action" && params.value === "price") {
    const cats = [...new Set((master.items || []).map(i => i.category).filter(Boolean))];
    return reply(ev.replyToken, categoryMenu(cats));
  }

  // 機種選択
  if (step === "model") {
    const cat = params.cat;
    const model = params.val || params.model; // val優先
    const classesAll = [
      ...new Set((master.items || [])
        .filter(i => i.category === cat && baseModel(i.name) === model)
        .map(i => i.class)
        .filter(Boolean))
    ];
    return reply(ev.replyToken, quickReplyOptions("クラス", classesAll, "cls", { cat, model }));
  }

  // カテゴリ → クラス
  if (step === "cat") {
    const catVal = params.val || params.value;

    // ★ 特例：クローラーフォークはクラス選択をスキップして仕様へ直行
    if (catVal === "クローラーフォーク") {
      return reply(ev.replyToken,
        quickReplyOptions("仕様", ["普通サヤ", "長サヤ"], "name", { cat: "クローラーフォーク" })
      );
    }

    const classesAll = getClassesForCategory(catVal);
    return reply(ev.replyToken, quickReplyOptions("クラス", classesAll, "cls", { cat: catVal }));
  }

  // クラス選択 → 仕様（特例含む）
  if (step === "cls") {
    const cat = params.cat;

    // ★特例（保険）：クローラーフォークがここに来た場合でも直行
    if (cat === "クローラーフォーク") {
      return reply(ev.replyToken,
        quickReplyOptions("仕様", ["普通サヤ", "長サヤ"], "name", { cat })
      );
    }

    const classesAll = [
      ...new Set((master.items || [])
        .filter(i => i.category === cat && (params.model ? baseModel(i.name) === params.model : true))
        .map(i => i.class)
        .filter(Boolean))
    ];
    const cls = params.val || (params.idx != null ? classesAll[Number(params.idx)] : null);
    if (!cls) return reply(ev.replyToken, { type: "text", text: "クラス選択に失敗しました。" });

    // ★特例：チルトローテーターは仕様をスキップして即価格表示
    if (cat === "チルトローテーター") {
      const items = (master.items || []).filter(i =>
        i.category === cat && (cls ? i.class === cls : true)
      );
      if (items.length === 0) {
        return reply(ev.replyToken, { type: "text", text: "該当データが見つかりませんでした。" });
      }
      const it = items[0];                 // 代表行（先頭）を採用。必要なら基準名で優先度付け可
      const v  = pickVariant(it);
      const title = `${cat}${cls ? " " + cls : ""}｜${baseModel(it.name)}`;
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

    // 特例2：フェラバン 0.25㎥ → 排土板付き固定
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
      if (items.length === 0) return reply(ev.replyToken, { type: "text", text: "該当データが見つかりませんでした。" });
      const it = items.find(i => i.name.includes("排土板")) || items[0];
      const v = pickVariant(it);
      const title = `${cat} ${cls}｜${baseModel(it.name)}（排土板付き）`;
      return reply(ev.replyToken, priceCard(title, v));
    }

    // スライドアームの分岐
    if (cat === "スライドアーム") {
      if (cls === "0.25㎥") {
        // 後方/超小 → バケット/法面
        return reply(ev.replyToken,
          quickReplyOptions("タイプ", ["後方小旋回", "超小旋回"], "pose", { cat, cls })
        );
      }
      if (cls === "0.45㎥") {
        // クレーン仕様/無し → バケット/法面
        return reply(ev.replyToken,
          quickReplyOptions("クレーン", ["クレーン仕様", "クレーン無し"], "crane", { cat, cls })
        );
      }
      if (cls === "0.7㎥") {
        // スタンダード/後方 → 鉄/ゴム →（特例でスキップ可）→ クレーン → バケット/法面
        return reply(ev.replyToken,
          quickReplyOptions("タイプ", ["スタンダード", "後方小旋回"], "pose70", { cat, cls })
        );
      }
      // その他のクラス：バケット/法面のみ
      return reply(ev.replyToken,
        quickReplyOptions("仕様", ["バケット", "法面付き"], "name", { cat, cls })
      );
    }

    // 通常：仕様名一覧を提示
    const namesAll = [
      ...new Set((master.items || [])
        .filter(i =>
          i.category === cat &&
          (cls ? i.class === cls : true) &&
          (params.model ? baseModel(i.name) === params.model : true)
        )
        .map(i => i.name)
        .filter(Boolean))
    ];
    return reply(ev.replyToken, quickReplyOptions("仕様", namesAll, "name", { cat, cls }));
  }

  // --- 追加：スライド 0.25 用（pose → name） ---
  if (step === "pose") {
    const cat = params.cat;
    const cls = params.cls;
    const poses = ["後方小旋回", "超小旋回"];
    const pose = params.val || (params.idx != null ? poses[Number(params.idx)] : null);
    if (!pose) return reply(ev.replyToken, { type: "text", text: "タイプ選択に失敗しました。" });

    return reply(ev.replyToken,
      quickReplyOptions("仕様", ["バケット", "法面付き"], "name", { cat, cls, pose })
    );
  }

  // --- 追加：スライド 0.7 用（pose70 → track） ---
  if (step === "pose70") {
    const cat = params.cat;
    const cls = params.cls;
    const poses = ["スタンダード", "後方小旋回"];
    const pose = params.val || (params.idx != null ? poses[Number(params.idx)] : null);
    if (!pose) return reply(ev.replyToken, { type: "text", text: "タイプ選択に失敗しました。" });

    return reply(ev.replyToken,
      quickReplyOptions("キャタ", ["鉄キャタ", "ゴムキャタ"], "track", { cat, cls, pose })
    );
  }

  // --- 置換済：スライド 0.7 用（track → crane or 直接 name：特例対応） ---
  if (step === "track") {
    const cat  = params.cat;
    const cls  = params.cls;
    const pose = params.pose;

    const tracks = ["鉄キャタ", "ゴムキャタ"];
    const track  = params.val || (params.idx != null ? tracks[Number(params.idx)] : null);
    if (!track) return reply(ev.replyToken, { type: "text", text: "キャタ選択に失敗しました。" });

    // ★ 0.7㎥ の特例分岐
    if (cat === "スライドアーム" && cls === "0.7㎥") {
      // 1) スタンダード × ゴムキャタ → クレーン仕様のみ
      if (pose === "スタンダード" && track === "ゴムキャタ") {
        return reply(ev.replyToken,
          quickReplyOptions("仕様", ["バケット", "法面付き"], "name", {
            cat, cls, pose, track, crane: "クレーン仕様"
          })
        );
      }
      // 2) 後方小旋回 × ゴムキャタ → クレーン無しのみ
      if (pose === "後方小旋回" && track === "ゴムキャタ") {
        return reply(ev.replyToken,
          quickReplyOptions("仕様", ["バケット", "法面付き"], "name", {
            cat, cls, pose, track, crane: "クレーン無し"
          })
        );
      }
      // 3) 後方小旋回 × 鉄キャタ → クレーン仕様のみ
      if (pose === "後方小旋回" && track === "鉄キャタ") {
        return reply(ev.replyToken,
          quickReplyOptions("仕様", ["バケット", "法面付き"], "name", {
            cat, cls, pose, track, crane: "クレーン仕様"
          })
        );
      }
    }

    // 通常：クレーン仕様 / クレーン無し を選択
    return reply(ev.replyToken,
      quickReplyOptions("クレーン", ["クレーン仕様", "クレーン無し"], "crane", { cat, cls, pose, track })
    );
  }

  // --- 追加：スライド 0.45/0.7 用（crane → name） ---
  if (step === "crane") {
    const cat = params.cat;
    const cls = params.cls;
    const cranes = ["クレーン仕様", "クレーン無し"];
    const crane = params.val || (params.idx != null ? cranes[Number(params.idx)] : null);
    if (!crane) return reply(ev.replyToken, { type: "text", text: "クレーン選択に失敗しました。" });

    return reply(ev.replyToken,
      quickReplyOptions("仕様", ["バケット", "法面付き"], "name", { cat, cls, crane, pose: params.pose, track: params.track })
    );
  }

  // 仕様選択 → 価格カード
  if (step === "name") {
    const cat = params.cat;
    const cls = params.cls;

    // スライドアーム：バケット/法面（0.25/0.45/0.7 すべて統合）
    if (cat === "スライドアーム") {
      const chosen = params.val; // "バケット" or "法面付き"
      if (!chosen) return reply(ev.replyToken, { type: "text", text: "仕様選択に失敗しました。" });

      // 0.25：pose、0.45：crane、0.7：pose/track/crane を反映
      const pose25 = (cls === "0.25㎥") ? params.pose : undefined;
      const crane45 = (cls === "0.45㎥") ? params.crane : undefined;
      const pose70  = (cls === "0.7㎥")  ? params.pose  : undefined;
      const track70 = (cls === "0.7㎥")  ? params.track : undefined;
      const crane70 = (cls === "0.7㎥")  ? params.crane : undefined;

      const pose  = pose25 || pose70;
      const crane = crane45 || crane70;
      const track = track70;

      const it = pickSlideBaseItem(cls, pose, crane, track);
      if (!it) return reply(ev.replyToken, { type: "text", text: "該当データが見つかりませんでした。" });

      const v = pickVariant(it);
      if (chosen === "法面付き") {
        const add = SLOPE_ADD[cls] || { day: 0, month: 0 };
        v.day   = (v.day ?? 0) + add.day;
        v.month = (v.month ?? 0) + add.month;
      }

      const tags = [];
      if (pose)  tags.push(pose);
      if (track) tags.push(track);
      if (crane) tags.push(crane);
      const tagStr = tags.length ? tags.join("・") + "｜" : "";

      const title = `スライドアーム ${cls}｜${tagStr}${baseModel(it.name)}（${chosen}）`;
      return reply(ev.replyToken, priceCard(title, v));
    }

    // 通常（非スライド）
    const name = params.val || params.value;
    let items = (master.items || []).filter(i =>
      i.category === cat && (cls ? i.class === cls : true) && i.name === name
    );

    if (items.length === 0) {
      // 念のための緩和（前方/含有/baseModel）
      const all = (master.items || []).filter(i => i.category === cat && (cls ? i.class === cls : true));
      let it = all.find(i => i.name === name)
        || all.find(i => i.name?.startsWith(name))
        || all.find(i => i.name?.includes(name))
        || all.find(i => baseModel(i.name) === name || baseModel(i.name).includes(name));
      if (!it) {
        console.warn("[NO MATCH]", { cat, cls, name, params });
        return reply(ev.replyToken, { type: "text", text: "該当データが見つかりませんでした。" });
      }
      const v = pickVariant(it);
      const title = `${cat}${cls ? " " + cls : ""}｜${it.name}${v.label && v.label !== "通常" ? "・" + v.label : ""}`;
      return reply(ev.replyToken, priceCard(title, v));
    }

    const it = items[0];
    const v = pickVariant(it);
    const title = `${cat}${cls ? " " + cls : ""}｜${name}${v.label && v.label !== "通常" ? "・" + v.label : ""}`;
    return reply(ev.replyToken, priceCard(title, v));
  }
}

// ===== 診断API =====
app.get("/diag", (req, res) => {
  const { cat, cls, name } = req.query;
  const items = (master.items || []).filter(i => i.category === cat && (cls ? i.class === cls : true) && i.name === name);
  if (items.length === 0) return res.json({ ok: false, reason: "no_match", query: { cat, cls, name } });
  const it = items[0];
  const v = pickVariant(it);
  res.json({ ok: true, item: { category: it.category, class: it.class, name: it.name }, variant: v });
});

// ===== 起動確認 =====
app.get("/", (_, res) => res.send("LINE Bot OK"));
app.listen(PORT, () => console.log("Server started on", PORT));
