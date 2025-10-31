// app.js（チルトローテーター即金額対応版）
import express from "express";
import crypto from "crypto";
import fs from "fs";

const app = express();
function rawBodySaver(req, res, buf) { req.rawBody = buf; }
app.use(express.json({ verify: rawBodySaver }));

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_TOKEN  = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const PORT           = process.env.PORT || 3000;

// master.json読み込み
const master = JSON.parse(fs.readFileSync("./master.json", "utf8"));

function toNumber(v){if(v==null)return null;const n=Number(String(v).replace(/[^0-9.-]/g,""));return isNaN(n)?null:n;}
function pickVariant(it){if(!it?.variants?.length)return{day:0,month:0,base:0,ins:0,env:0};return it.variants[0];}
function baseModel(name=""){return name.split("（")[0].split("(")[0].trim();}

async function reply(token,payload){
  await fetch("https://api.line.me/v2/bot/message/reply",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${CHANNEL_TOKEN}`},
    body:JSON.stringify({replyToken:token,messages:Array.isArray(payload)?payload:[payload]})
  });
}

function priceCard(title,v){
  const rows=[["日決め",v.day],["月決め",v.month],["基本管理料",v.base],["保証料",v.ins],["環境サービス料",v.env]]
  .map(([k,n])=>({type:"box",layout:"baseline",contents:[{type:"text",text:k,size:"sm",color:"#555",flex:4},{type:"text",text:n?`¥${n.toLocaleString()}`:"―",size:"sm",align:"end",flex:6}]}));
  return{type:"flex",altText:`${title} のレンタル価格`,contents:{type:"bubble",body:{type:"box",layout:"vertical",spacing:"sm",contents:[{type:"text",text:title,weight:"bold",size:"md"},{type:"separator",margin:"sm"},{type:"box",layout:"vertical",contents:rows}]}},quickReply:{items:[{type:"action",action:{type:"message",label:"メニューに戻る",text:"メニュー"}}]}};
}

// チルトローテーター専用ハンドラ
async function handleTilt(event,params){
  if(params.step==="cat"&&params.value==="チルトローテーター"){
    const classes=["0.1㎥","0.25㎥","0.45㎥"];
    const items=classes.map((c,i)=>({
      type:"action",
      action:{type:"postback",label:c,data:new URLSearchParams({step:"cls-tilt",cat:"チルトローテーター",idx:String(i)}).toString(),displayText:c}
    }));
    return reply(event.replyToken,{type:"text",text:"クラスを選択してください👇",quickReply:{items}});
  }
  if(params.step==="cls-tilt"){
    const classes=["0.1㎥","0.25㎥","0.45㎥"];
    const cls=params.idx?classes[Number(params.idx)]:params.value;
    const it=(master.items||[]).find(i=>i.category==="チルトローテーター"&&i.class===cls);
    if(!it)return reply(event.replyToken,{type:"text",text:"該当データが見つかりませんでした。"});
    const v=pickVariant(it);
    const title=`チルトローテーター ${cls}｜${baseModel(it.name)}`;
    return reply(event.replyToken,priceCard(title,v));
  }
}

app.post("/webhook",async(req,res)=>{
  if(!req.body.events?.length)return res.status(200).end();
  for(const ev of req.body.events){
    if(ev.type==="postback"){
      const params=Object.fromEntries(new URLSearchParams(ev.postback.data||""));
      if(params.cat==="チルトローテーター"||params.step==="cls-tilt"){
        await handleTilt(ev,params);
        continue;
      }
    }
  }
  res.status(200).end();
});

app.get("/",(_,res)=>res.send("Bot OK"));
app.listen(PORT,()=>console.log("Server running on",PORT));
