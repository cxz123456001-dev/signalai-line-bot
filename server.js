require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(lineConfig);
const USER_ID   = process.env.LINE_USER_ID;
const MIN_SCORE = parseInt(process.env.MIN_SCORE || '65');
const WATCH_PAIRS = ['BTC-USDT', 'ETH-USDT', 'XRP-USDT', 'SOL-USDT'];
const pendingOrders = {};
const waitingInput = {}; // 等待用戶輸入金額+槓桿

async function fetchCandles(instId) {
  const { data } = await axios.get('https://www.okx.com/api/v5/market/candles', {
    params: { instId, bar: '4H', limit: 20 },
  });
  return data.data.map(c => ({
    open: parseFloat(c[1]), high: parseFloat(c[2]),
    low: parseFloat(c[3]), close: parseFloat(c[4]), vol: parseFloat(c[5]),
  }));
}

function analyze(candles) {
  const last  = candles[0];
  const prev5 = candles.slice(1, 6);
  const resistance = Math.max(...prev5.map(c => c.high));
  const support    = Math.min(...prev5.map(c => c.low));
  const avgVol     = prev5.reduce((s, c) => s + c.vol, 0) / prev5.length;
  const volRatio   = last.vol / avgVol;
  const ma10       = candles.slice(0, 10).reduce((s, c) => s + c.close, 0) / 10;
  const reasons = [];
  let score = 50, dir = 'neutral';
  if (last.close > resistance) { reasons.push({ t: `突破${resistance.toFixed(3)}阻力`, ok: true }); score += 18; dir = 'long'; }
  if (last.close < support)    { reasons.push({ t: `跌破${support.toFixed(3)}支撐`, ok: true }); score += 15; dir = 'short'; }
  if (dir === 'neutral' && last.close < support * 1.005 && last.close > support * 0.995) {
    reasons.push({ t: `回測${support.toFixed(3)}支撐`, ok: true }); score += 12; dir = 'long';
  }
  if (volRatio > 1.5) { reasons.push({ t: `成交量放大${volRatio.toFixed(1)}x`, ok: true }); score += 10; }
  else if (volRatio < 0.7) { reasons.push({ t: '成交量萎縮', ok: false }); score -= 8; }
  if (last.close > ma10) { reasons.push({ t: '站上MA10', ok: true }); score += 8; }
  else { reasons.push({ t: '低於MA10', ok: false }); score -= 5; }
  if (last.close > last.open) { reasons.push({ t: '收陽線', ok: true }); score += 5; }
  else { reasons.push({ t: '收陰線', ok: false }); score -= 3; }
  score = Math.min(100, Math.max(0, score));
  const entry = last.close;
  const sl = dir === 'long' ? support * 0.995 : resistance * 1.005;
  const tp = dir === 'long' ? entry + (entry - sl) * 1.8 : entry - (sl - entry) * 1.8;
  const rr = Math.abs((tp - entry) / (entry - sl)).toFixed(1);
  const note = score >= 75 ? `強勢訊號，R/R ${rr}:1，值得關注。` : score >= 60 ? `中等訊號，止損設於 ${sl.toFixed(4)}。` : '訊號偏弱，建議觀望。';
  return { score, dir, reasons, entry, sl, tp, rr, note };
}

function buildMsg(pair, analysis) {
  const isLong = analysis.dir === 'long';
  const emoji = analysis.score >= 75 ? '🟢' : analysis.score >= 60 ? '🟡' : '🔴';
  return {
    type: 'flex', altText: `訊號：${pair.replace('-','/')} ${isLong?'做多':'做空'}`,
    contents: {
      type: 'bubble', size: 'kilo',
      header: { type: 'box', layout: 'horizontal', backgroundColor: '#0f1320', contents: [
        { type: 'text', text: '📊 OKX 交易訊號', color: '#7eb3f7', size: 'sm', weight: 'bold' },
        { type: 'text', text: new Date().toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'}), color: '#8899bb', size: 'xs', align: 'end', gravity: 'center' },
      ]},
      body: { type: 'box', layout: 'vertical', backgroundColor: '#1a1f2e', spacing: 'sm', contents: [
        { type: 'box', layout: 'horizontal', contents: [
          { type: 'text', text: pair.replace('-','/'), color: '#e8eaf0', size: 'xl', weight: 'bold' },
          { type: 'text', text: isLong?'做多 📈':'做空 📉', color: isLong?'#4ade80':'#f87171', size: 'sm', align: 'end', gravity: 'center' },
        ]},
        { type: 'separator', color: '#ffffff15' },
        { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
          { type: 'text', text: '進場', color: '#8a9bb5', size: 'xs', flex: 1 },
          { type: 'text', text: analysis.entry.toFixed(4), color: '#e8eaf0', size: 'sm', weight: 'bold', flex: 2 },
          { type: 'text', text: '目標', color: '#8a9bb5', size: 'xs', flex: 1 },
          { type: 'text', text: analysis.tp.toFixed(4), color: '#4ade80', size: 'sm', weight: 'bold', flex: 2 },
        ]},
        { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
          { type: 'text', text: '止損', color: '#8a9bb5', size: 'xs', flex: 1 },
          { type: 'text', text: analysis.sl.toFixed(4), color: '#f87171', size: 'sm', weight: 'bold', flex: 2 },
          { type: 'text', text: 'R/R', color: '#8a9bb5', size: 'xs', flex: 1 },
          { type: 'text', text: `${analysis.rr}:1`, color: '#fbbf24', size: 'sm', weight: 'bold', flex: 2 },
        ]},
        { type: 'separator', color: '#ffffff15' },
        { type: 'text', text: `${emoji} 評分 ${analysis.score}/100`, color: '#e8eaf0', size: 'sm', weight: 'bold' },
        { type: 'text', text: analysis.reasons.map(r=>`${r.ok?'✅':'❌'} ${r.t}`).join('\n'), color: '#c8d4ec', size: 'xs', wrap: true },
        { type: 'separator', color: '#ffffff15' },
        { type: 'text', text: `💡 ${analysis.note}`, color: '#a5b4fc', size: 'xs', wrap: true },
      ]},
      footer: { type: 'box', layout: 'horizontal', backgroundColor: '#0f1320', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#16a34a', height: 'sm', action: { type: 'message', label: '✅ 確認下單', text: `確認下單 ${pair}` } },
        { type: 'button', style: 'secondary', height: 'sm', action: { type: 'message', label: '❌ 跳過', text: `跳過 ${pair}` } },
      ]},
    },
  };
}

async function scanAndPush() {
  for (const pair of WATCH_PAIRS) {
    try {
      const candles = await fetchCandles(pair);
      const analysis = analyze(candles);
      if (analysis.dir === 'neutral' || analysis.score < MIN_SCORE) continue;
      await client.pushMessage(USER_ID, buildMsg(pair, analysis));
      pendingOrders[pair] = { pair, analysis };
      console.log(`✅ 推送：${pair} 評分${analysis.score}`);
    } catch (e) { console.error(`❌ ${pair}:`, e.message); }
  }
}

app.post('/webhook', middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;
    const text = event.message.text.trim();
    const tok = event.replyToken;

    // 等待輸入金額+槓桿
    if (waitingInput[USER_ID]) {
      const match = text.match(/^(\d+(?:\.\d+)?)\s+(\d+)x?$/i);
      if (match) {
        const amount = parseFloat(match[1]);
        const leverage = parseInt(match[2]);
        const { pair, analysis } = waitingInput[USER_ID];
        const a = analysis;
        const isLong = a.dir === 'long';

        // 計算止盈止損金額
        const slPct = Math.abs((a.sl - a.entry) / a.entry);
        const tpPct = Math.abs((a.tp - a.entry) / a.entry);
        const positionSize = amount * leverage;
        const slAmount = (positionSize * slPct).toFixed(2);
        const tpAmount = (positionSize * tpPct).toFixed(2);
        const fee = (positionSize * 0.0005).toFixed(2); // 0.05% 手續費

        const reply =
          `✅ 下單計算結果\n\n` +
          `交易對：${pair.replace('-','/')} ${isLong?'做多📈':'做空📉'}\n` +
          `━━━━━━━━━━━━\n` +
          `💰 本金：$${amount} USDT\n` +
          `⚡ 槓桿：${leverage}x\n` +
          `📊 倉位：$${positionSize} USDT\n` +
          `━━━━━━━━━━━━\n` +
          `🟢 進場價：${a.entry.toFixed(4)}\n` +
          `🎯 止盈價：${a.tp.toFixed(4)}（+$${tpAmount}）\n` +
          `🛑 止損價：${a.sl.toFixed(4)}（-$${slAmount}）\n` +
          `━━━━━━━━━━━━\n` +
          `📈 R/R：${a.rr}:1\n` +
          `💸 預估手續費：$${fee}\n\n` +
          `📌 請前往 OKX 執行下單！`;

        await client.replyMessage(tok, { type: 'text', text: reply });
        delete waitingInput[USER_ID];
        delete pendingOrders[pair];
      } else {
        await client.replyMessage(tok, { type: 'text', text: '⚠️ 格式錯誤，請輸入：金額 槓桿\n例如：100 10x 或 500 20x' });
      }
      continue;
    }

    if (text === 'myid') {
      await client.replyMessage(tok, { type: 'text', text: `您的 User ID 是：\n${event.source.userId}` });
      continue;
    }

    // 處理確認下單點擊
    if (text.startsWith('確認下單 ')) {
      const pair = text.replace('確認下單 ', '');
      if (pendingOrders[pair]) {
        waitingInput[USER_ID] = pendingOrders[pair];
        await client.replyMessage(tok, { type: 'text', text: `請輸入該筆交易的【金額】和【槓桿】，中間用空格分開：\n例如：100 10x` });
      } else {
        await client.replyMessage(tok, { type: 'text', text: '❌ 找不到對應的掛單訊號或已過期。' });
      }
      continue;
    }

    if (text.startsWith('跳過 ')) {
      const pair = text.replace('跳過 ', '');
      delete pendingOrders[pair];
      await client.replyMessage(tok, { type: 'text', text: `👌 已略過 ${pair} 的訊號通知。` });
      continue;
    }
  }
});

// 每 4 小時執行一次市場掃描 (配合您使用的 4H K線)
cron.schedule('0 */4 * * *', () => {
  console.log('⏰ 開始執行定時市場掃描...');
  scanAndPush();
});

// 啟動 Express 伺服器並監聽 Render 指派的 Port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LINE Bot 伺服器已成功啟動，正在監聽連接埠 ${PORT}`);
});
