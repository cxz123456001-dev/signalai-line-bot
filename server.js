require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const axios = require('axios');
const cron = require('node-cron');
 
const app = express();
 
// ══════════════════════════════════════════════
// Keep-Alive：防止 Render 免費方案休眠
// ══════════════════════════════════════════════
const RENDER_URL = process.env.RENDER_URL || ''; // 填入你的 Render URL
app.get('/ping', (req, res) => res.send('pong 🏓'));
app.get('/health', (req, res) => res.json({
  status: 'ok',
  uptime: Math.floor(process.uptime()),
  pairs: WATCH_PAIRS?.length ?? 0,
  pending: Object.keys(pendingOrders ?? {}).length,
  time: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
}));
 
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret:      process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(lineConfig);
const USER_ID       = process.env.LINE_USER_ID;
const MIN_SCORE     = parseInt(process.env.MIN_SCORE || '65');
const MAX_LOSS_USDT = parseFloat(process.env.MAX_LOSS_USDT || '20');
const BASE_CAPITAL  = parseFloat(process.env.BASE_CAPITAL || '100');
const MAX_LOSS_PCT  = parseFloat(process.env.MAX_LOSS_PCT || '0.05');
 
// 固定監控幣對
const FIXED_PAIRS = [
  'BTC-USDT','ETH-USDT','ADA-USDT','DOGE-USDT',
  'SOL-USDT','HYPE-USDT','XRP-USDT'
];
 
let WATCH_PAIRS = [...FIXED_PAIRS];
const pendingOrders = {};
 
// ══════════════════════════════════════════════
// 1. 動態抓取交易量前10名幣對
// ══════════════════════════════════════════════
async function updateTopPairs() {
  try {
    const { data } = await axios.get('https://www.okx.com/api/v5/market/tickers', {
      params: { instType: 'SPOT' }
    });
    const stableCoins = ['USDT','USDC','DAI','BUSD','TUSD','USDP','FDUSD'];
    const top10 = data.data
      .filter(t => t.instId.endsWith('-USDT'))
      .filter(t => !stableCoins.some(s => t.instId.startsWith(s)))
      .sort((a, b) => parseFloat(b.volCcy24h) - parseFloat(a.volCcy24h))
      .slice(0, 10)
      .map(t => t.instId);
 
    const merged = [...new Set([...FIXED_PAIRS, ...top10])];
    WATCH_PAIRS = merged;
    console.log(`📊 監控幣對更新：${WATCH_PAIRS.join(', ')}`);
  } catch (e) {
    console.error('更新幣對失敗:', e.message);
  }
}
 
// ══════════════════════════════════════════════
// 2. 行情抓取
// ══════════════════════════════════════════════
async function fetchCandles(instId, bar = '4H', limit = 50) {
  const { data } = await axios.get('https://www.okx.com/api/v5/market/candles', {
    params: { instId, bar, limit }
  });
  return data.data.map(c => ({
    ts: parseInt(c[0]),
    open: parseFloat(c[1]), high: parseFloat(c[2]),
    low: parseFloat(c[3]),  close: parseFloat(c[4]), vol: parseFloat(c[5]),
  }));
}
 
async function fetchCandles5m(instId) {
  return fetchCandles(instId, '5m', 20);
}
 
async function fetchTicker(instId) {
  const { data } = await axios.get('https://www.okx.com/api/v5/market/ticker', {
    params: { instId }
  });
  return data.data[0];
}
 
// ══════════════════════════════════════════════
// 3. 技術指標計算
// ══════════════════════════════════════════════
function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i - 1].close - candles[i].close;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}
 
function calcMACD(candles) {
  const closes = candles.map(c => c.close).reverse();
  const ema = (data, period) => {
    const k = 2 / (period + 1);
    let emaVal = data[0];
    for (let i = 1; i < data.length; i++) emaVal = data[i] * k + emaVal * (1 - k);
    return emaVal;
  };
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12 - ema26;
  const signal = ema(closes.slice(-9), 9);
  return { macd: macdLine, signal, histogram: macdLine - signal };
}
 
function calcATR(candles, period = 14) {
  const trs = [];
  for (let i = 0; i < Math.min(period, candles.length - 1); i++) {
    const high = candles[i].high, low = candles[i].low, prevClose = candles[i + 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}
 
function calcBollinger(candles, period = 20) {
  const closes = candles.slice(0, period).map(c => c.close);
  const avg = closes.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(closes.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / period);
  return { upper: avg + 2 * std, middle: avg, lower: avg - 2 * std };
}
 
function calc5mFlow(candles5m) {
  const recent = candles5m.slice(0, 5);
  const bullVol = recent.filter(c => c.close > c.open).reduce((s, c) => s + c.vol, 0);
  const bearVol = recent.filter(c => c.close <= c.open).reduce((s, c) => s + c.vol, 0);
  const total = bullVol + bearVol;
  const bullRatio = total > 0 ? bullVol / total : 0.5;
  const avgVol = recent.reduce((s, c) => s + c.vol, 0) / recent.length;
  const prevAvg = candles5m.slice(5, 10).reduce((s, c) => s + c.vol, 0) / 5;
  const volSurge = prevAvg > 0 ? avgVol / prevAvg : 1;
  return { bullRatio, bearRatio: 1 - bullRatio, volSurge, avgVol };
}
 
// ══════════════════════════════════════════════
// 4. 市場輿情（CryptoPanic + Fear & Greed）
// ══════════════════════════════════════════════
async function fetchSentiment(coinSymbol) {
  try {
    const fgRes = await axios.get('https://api.alternative.me/fng/?limit=1');
    const fgValue = parseInt(fgRes.data.data[0].value);
    const fgLabel = fgRes.data.data[0].value_classification;
 
    let newsScore = 0;
    let newsItems = [];
    try {
      const coin = coinSymbol.replace('-USDT','');
      const newsRes = await axios.get(`https://cryptopanic.com/api/v1/posts/?auth_token=free&currencies=${coin}&kind=news&public=true`);
      const posts = newsRes.data.results?.slice(0, 5) || [];
      for (const p of posts) {
        if (p.votes?.positive > p.votes?.negative) newsScore += 1;
        else if (p.votes?.negative > p.votes?.positive) newsScore -= 1;
        newsItems.push(p.title?.slice(0, 40) + '…');
      }
    } catch (_) {}
 
    return { fgValue, fgLabel, newsScore, newsItems };
  } catch (e) {
    return { fgValue: 50, fgLabel: 'Neutral', newsScore: 0, newsItems: [] };
  }
}
 
// ══════════════════════════════════════════════
// 5. 綜合分析
// ══════════════════════════════════════════════
async function analyze(instId) {
  const [candles, candles5m] = await Promise.all([
    fetchCandles(instId),
    fetchCandles5m(instId),
  ]);
 
  const last  = candles[0];
  const prev5 = candles.slice(1, 6);
 
  const resistance = Math.max(...prev5.map(c => c.high));
  const support    = Math.min(...prev5.map(c => c.low));
  const avgVol     = prev5.reduce((s, c) => s + c.vol, 0) / prev5.length;
  const volRatio   = last.vol / avgVol;
  const ma10       = candles.slice(0, 10).reduce((s, c) => s + c.close, 0) / 10;
  const ma20       = candles.slice(0, 20).reduce((s, c) => s + c.close, 0) / 20;
 
  const rsi    = calcRSI(candles);
  const macd   = calcMACD(candles);
  const atr    = calcATR(candles);
  const boll   = calcBollinger(candles);
  const flow5m = calc5mFlow(candles5m);
 
  const reasons = [];
  let score = 50, dir = 'neutral';
 
  // 突破阻力
  if (last.close > resistance && volRatio > 1.2) {
    reasons.push({ t: `突破${resistance.toFixed(3)}阻力`, ok: true });
    score += 18; dir = 'long';
  }
  // 跌破支撐
  if (last.close < support && volRatio > 1.2) {
    reasons.push({ t: `跌破${support.toFixed(3)}支撐`, ok: true });
    score += 15; dir = 'short';
  }
  // 回測支撐
  if (dir === 'neutral' && last.close < support * 1.005 && last.close > support * 0.995) {
    reasons.push({ t: `回測${support.toFixed(3)}支撐`, ok: true });
    score += 12; dir = 'long';
  }
  // RSI
  if (rsi < 35 && dir !== 'short') {
    reasons.push({ t: `RSI超賣(${rsi.toFixed(0)})`, ok: true }); score += 10;
    if (dir === 'neutral') dir = 'long';
  } else if (rsi > 65 && dir !== 'long') {
    reasons.push({ t: `RSI超買(${rsi.toFixed(0)})`, ok: true }); score += 8;
    if (dir === 'neutral') dir = 'short';
  } else {
    reasons.push({ t: `RSI中性(${rsi.toFixed(0)})`, ok: false }); score -= 3;
  }
  // MACD
  if (macd.histogram > 0 && macd.macd > macd.signal) {
    reasons.push({ t: 'MACD金叉', ok: true }); score += 8;
  } else if (macd.histogram < 0 && macd.macd < macd.signal) {
    reasons.push({ t: 'MACD死叉', ok: false }); score -= 5;
  }
  // 布林通道
  if (last.close > boll.upper) {
    reasons.push({ t: '突破布林上軌', ok: dir === 'long' }); score += dir === 'long' ? 6 : -4;
  } else if (last.close < boll.lower) {
    reasons.push({ t: '跌破布林下軌', ok: dir === 'short' }); score += dir === 'short' ? 6 : -4;
  }
  // 成交量
  if (volRatio > 1.5) {
    reasons.push({ t: `量放大${volRatio.toFixed(1)}x`, ok: true }); score += 8;
  } else if (volRatio < 0.7) {
    reasons.push({ t: '量萎縮', ok: false }); score -= 6;
  }
  // MA
  if (last.close > ma10 && ma10 > ma20) {
    reasons.push({ t: 'MA10>MA20多頭', ok: true }); score += 6;
  } else if (last.close < ma10 && ma10 < ma20) {
    reasons.push({ t: 'MA10<MA20空頭', ok: false }); score -= 4;
  }
  // 5分鐘資金流
  if (flow5m.bullRatio > 0.65) {
    reasons.push({ t: `5m買方${(flow5m.bullRatio*100).toFixed(0)}%`, ok: true }); score += 5;
  } else if (flow5m.bullRatio < 0.35) {
    reasons.push({ t: `5m賣方${((1-flow5m.bullRatio)*100).toFixed(0)}%`, ok: false }); score -= 4;
  }
  // K線方向
  if (last.close > last.open) {
    reasons.push({ t: '收陽線', ok: true }); score += 4;
  } else {
    reasons.push({ t: '收陰線', ok: false }); score -= 3;
  }
 
  score = Math.min(100, Math.max(0, score));
  const entry = last.close;
 
  // ATR 動態止損
  const atrSL = atr * 1.5;
  const sl = dir === 'long' ? entry - atrSL : entry + atrSL;
  const slDist = Math.abs(entry - sl);
 
  // 止盈分3等分
  const tp1 = dir === 'long' ? entry + slDist : entry - slDist;         // 1:1
  const tp2 = dir === 'long' ? entry + slDist * 1.8 : entry - slDist * 1.8; // 1:1.8
  const tp3 = dir === 'long' ? entry + slDist * 3.0 : entry - slDist * 3.0; // 1:3
 
  // 動態槓桿評估
  let leverage = 5;
  if (flow5m.volSurge > 2 && flow5m.bullRatio > 0.6 && score >= 75) leverage = 20;
  else if (flow5m.volSurge > 1.5 && score >= 70) leverage = 15;
  else if (score >= 65) leverage = 10;
  else leverage = 5;
 
  // 是否加倍本金
  const doubleCapital = flow5m.volSurge > 2.5 && score >= 80;
 
  // 風控計算
  const capital = doubleCapital ? BASE_CAPITAL * 2 : BASE_CAPITAL;
  const slPct = slDist / entry;
  const maxLossByPct = capital * MAX_LOSS_PCT;
  const effectiveMaxLoss = Math.min(MAX_LOSS_USDT, maxLossByPct);
  const safePositionSize = effectiveMaxLoss / slPct;
  const safeLeverage = Math.min(leverage, Math.floor(safePositionSize / capital));
  const finalLeverage = Math.max(1, safeLeverage);
  const positionSize = capital * finalLeverage;
  const slAmount = (positionSize * slPct).toFixed(2);
  const tp1Amount = (positionSize * (slDist / entry)).toFixed(2);
  const tp2Amount = (positionSize * (slDist * 1.8 / entry)).toFixed(2);
  const tp3Amount = (positionSize * (slDist * 3 / entry)).toFixed(2);
  const fee = (positionSize * 0.0005).toFixed(2);
 
  return {
    score, dir, reasons, entry, sl, tp1, tp2, tp3,
    rr: '1:1.8', atr, leverage: finalLeverage,
    capital, positionSize: positionSize.toFixed(2),
    slAmount, tp1Amount, tp2Amount, tp3Amount, fee,
    doubleCapital, flow5m, rsi, macd,
  };
}
 
// ══════════════════════════════════════════════
// 6. LINE 訊號卡
// ══════════════════════════════════════════════
function buildSignalCard(pair, a) {
  const isLong = a.dir === 'long';
  const emoji  = a.score >= 75 ? '🟢' : a.score >= 60 ? '🟡' : '🔴';
  return {
    type: 'flex',
    altText: `${emoji} ${pair.replace('-','/')} ${isLong?'做多':'做空'} 評分${a.score}`,
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'horizontal', backgroundColor: '#0a0e1a',
        contents: [
          { type: 'text', text: '📊 OKX 交易訊號', color: '#7eb3f7', size: 'sm', weight: 'bold' },
          { type: 'text', text: new Date().toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit'}), color: '#6b7a99', size: 'xs', align: 'end', gravity: 'center' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', backgroundColor: '#141824', spacing: 'sm',
        contents: [
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: pair.replace('-','/'), color: '#e8eaf0', size: 'lg', weight: 'bold' },
            { type: 'text', text: isLong?'做多 📈':'做空 📉', color: isLong?'#4ade80':'#f87171', size: 'sm', align: 'end', gravity: 'center' },
          ]},
          { type: 'text', text: `${emoji} 評分 ${a.score}/100  •  RSI ${a.rsi?.toFixed(0)}  •  ${a.doubleCapital?'⚡ 量能爆發加倍':''}`, color: '#c8d4ec', size: 'xs', wrap: true },
          { type: 'separator', color: '#ffffff12' },
          { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
            { type: 'text', text: '進場', color: '#6b7a99', size: 'xs', flex: 1 },
            { type: 'text', text: a.entry.toFixed(4), color: '#e8eaf0', size: 'sm', weight: 'bold', flex: 2 },
            { type: 'text', text: '槓桿', color: '#6b7a99', size: 'xs', flex: 1 },
            { type: 'text', text: `${a.leverage}x`, color: '#fbbf24', size: 'sm', weight: 'bold', flex: 2 },
          ]},
          { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
            { type: 'text', text: '止損', color: '#6b7a99', size: 'xs', flex: 1 },
            { type: 'text', text: `${a.sl.toFixed(4)}`, color: '#f87171', size: 'sm', weight: 'bold', flex: 2 },
            { type: 'text', text: '最虧', color: '#6b7a99', size: 'xs', flex: 1 },
            { type: 'text', text: `-$${a.slAmount}`, color: '#f87171', size: 'sm', weight: 'bold', flex: 2 },
          ]},
          { type: 'separator', color: '#ffffff12' },
          { type: 'text', text: '🎯 止盈三等分', color: '#4ade80', size: 'xs', weight: 'bold' },
          { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
            { type: 'text', text: '第1目標', color: '#6b7a99', size: 'xs', flex: 2 },
            { type: 'text', text: a.tp1.toFixed(4), color: '#4ade80', size: 'xs', flex: 2 },
            { type: 'text', text: `+$${a.tp1Amount}`, color: '#4ade80', size: 'xs', flex: 2 },
          ]},
          { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
            { type: 'text', text: '第2目標', color: '#6b7a99', size: 'xs', flex: 2 },
            { type: 'text', text: a.tp2.toFixed(4), color: '#4ade80', size: 'xs', flex: 2 },
            { type: 'text', text: `+$${a.tp2Amount}`, color: '#4ade80', size: 'xs', flex: 2 },
          ]},
          { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
            { type: 'text', text: '第3目標', color: '#6b7a99', size: 'xs', flex: 2 },
            { type: 'text', text: a.tp3.toFixed(4), color: '#4ade80', size: 'xs', flex: 2 },
            { type: 'text', text: `+$${a.tp3Amount}`, color: '#4ade80', size: 'xs', flex: 2 },
          ]},
          { type: 'separator', color: '#ffffff12' },
          { type: 'text', text: a.reasons.filter(r=>r.ok).map(r=>`✅ ${r.t}`).join('  '), color: '#4ade80', size: 'xxs', wrap: true },
          { type: 'text', text: a.reasons.filter(r=>!r.ok).map(r=>`❌ ${r.t}`).join('  '), color: '#f87171', size: 'xxs', wrap: true },
          { type: 'separator', color: '#ffffff12' },
          { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
            { type: 'text', text: '本金', color: '#6b7a99', size: 'xs', flex: 1 },
            { type: 'text', text: `$${a.capital}`, color: '#e8eaf0', size: 'xs', flex: 1 },
            { type: 'text', text: '倉位', color: '#6b7a99', size: 'xs', flex: 1 },
            { type: 'text', text: `$${a.positionSize}`, color: '#e8eaf0', size: 'xs', flex: 1 },
            { type: 'text', text: '手續費', color: '#6b7a99', size: 'xs', flex: 1 },
            { type: 'text', text: `$${a.fee}`, color: '#e8eaf0', size: 'xs', flex: 1 },
          ]},
        ],
      },
      footer: {
        type: 'box', layout: 'horizontal', backgroundColor: '#0a0e1a', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#16a34a', height: 'sm',
            action: { type: 'message', label: '✅ 一鍵下單', text: `一鍵下單 ${pair}` } },
          { type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'message', label: '❌ 跳過', text: `跳過 ${pair}` } },
        ],
      },
    },
  };
}
 
// ══════════════════════════════════════════════
// 7. 掃描推送
// ══════════════════════════════════════════════
async function scanAndPush() {
  console.log(`[${new Date().toLocaleTimeString()}] 掃描 ${WATCH_PAIRS.length} 個幣對…`);
  for (const pair of WATCH_PAIRS) {
    try {
      const a = await analyze(pair);
      if (a.dir === 'neutral' || a.score < MIN_SCORE) continue;
      await client.pushMessage(USER_ID, buildSignalCard(pair, a));
      pendingOrders[pair] = { pair, analysis: a };
      console.log(`✅ 推送：${pair} 評分${a.score} 槓桿${a.leverage}x`);
    } catch (e) { console.error(`❌ ${pair}:`, e.message); }
  }
}
 
// ══════════════════════════════════════════════
// 8. Webhook
// ══════════════════════════════════════════════
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;
    const text = event.message.text.trim();
    const tok  = event.replyToken;
 
    if (text === 'myid') {
      await client.replyMessage(tok, { type: 'text', text: `你的 ID：\n${event.source.userId}` });
 
    } else if (text.startsWith('一鍵下單')) {
      const pair = text.replace('一鍵下單','').trim();
      const o = pendingOrders[pair];
      if (!o) { await client.replyMessage(tok, { type: 'text', text: `⚠️ 找不到 ${pair} 訂單。` }); continue; }
      const a = o.analysis;
      const isLong = a.dir === 'long';
      const reply =
        `✅ 下單確認\n\n` +
        `${pair.replace('-','/')} ${isLong?'做多📈':'做空📉'}\n` +
        `━━━━━━━━━━━━\n` +
        `💰 本金：$${a.capital} USDT${a.doubleCapital?' ⚡加倍':''}\n` +
        `⚡ 槓桿：${a.leverage}x\n` +
        `📊 倉位：$${a.positionSize} USDT\n` +
        `━━━━━━━━━━━━\n` +
        `🟢 進場：${a.entry.toFixed(4)}\n` +
        `🛑 止損：${a.sl.toFixed(4)}（-$${a.slAmount}）\n` +
        `━━━━━━━━━━━━\n` +
        `🎯 止盈三等分：\n` +
        `  第1：${a.tp1.toFixed(4)}（+$${a.tp1Amount}）\n` +
        `  第2：${a.tp2.toFixed(4)}（+$${a.tp2Amount}）\n` +
        `  第3：${a.tp3.toFixed(4)}（+$${a.tp3Amount}）\n` +
        `━━━━━━━━━━━━\n` +
        `💸 手續費：$${a.fee}\n` +
        `📉 最大虧損：$${a.slAmount}\n\n` +
        `📌 請前往 OKX 執行！`;
      await client.replyMessage(tok, { type: 'text', text: reply });
      delete pendingOrders[pair];
 
    } else if (text.startsWith('跳過')) {
      const pair = text.replace('跳過','').trim();
      delete pendingOrders[pair];
      await client.replyMessage(tok, { type: 'text', text: `⏭️ 已跳過 ${pair.replace('-','/')}。` });
 
    } else if (text === '狀態') {
      await client.replyMessage(tok, {
        type: 'text',
        text: `🤖 SignalAI 狀態\n\n待確認：${Object.keys(pendingOrders).length} 筆\n監控：${WATCH_PAIRS.length} 個幣對\n門檻：${MIN_SCORE}分\n止損上限：$${MAX_LOSS_USDT}\n本金：$${BASE_CAPITAL}\n\n傳「幣對」查看監控清單\n傳「掃描」立即掃描`
      });
 
    } else if (text === '幣對') {
      await client.replyMessage(tok, { type: 'text', text: `📊 監控清單：\n${WATCH_PAIRS.map(p=>p.replace('-USDT','')).join('、')}` });
 
    } else if (text === '掃描') {
      await client.replyMessage(tok, { type: 'text', text: '🔍 掃描中…' });
      scanAndPush();
    }
  }
});
 
// ══════════════════════════════════════════════
// 9. 定時任務
// ══════════════════════════════════════════════
cron.schedule('*/3 * * * *', scanAndPush);
cron.schedule('0 * * * *', updateTopPairs); // 每小時更新前10名
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Bot 啟動 Port ${PORT}`);
  await updateTopPairs();
  await scanAndPush();
 
  // ── Self-Ping：每 8 分鐘 ping 自己，防止 Render 休眠 ──────────
  if (RENDER_URL) {
    setInterval(async () => {
      try {
        const res = await axios.get(`${RENDER_URL}/ping`, { timeout: 10000 });
        console.log(`💓 Keep-alive ping OK (${res.status})`);
      } catch (e) {
        console.warn(`⚠️  Keep-alive ping 失敗: ${e.message}`);
      }
    }, 8 * 60 * 1000); // 8 分鐘
    console.log(`💓 Keep-alive 已啟動 → ${RENDER_URL}/ping`);
  } else {
    console.warn('⚠️  未設定 RENDER_URL，Keep-alive 未啟動（請在 Environment 加入）');
  }
 
  // ── Watchdog：偵測 cron 是否停滯，超過 15 分鐘自動重啟 ────────
  let lastCronAt = Date.now();
  const _origScan = scanAndPush;
  // 包裝 scanAndPush，每次執行都更新心跳
  const scanAndPushWrapped = async () => {
    lastCronAt = Date.now();
    return _origScan();
  };
 
  // 替換 cron 中的 scanAndPush 為包裝版
  // （注意：cron 已排程完畢，這裡用 setInterval 額外監控）
  setInterval(() => {
    const elapsed = (Date.now() - lastCronAt) / 1000;
    if (elapsed > 14 * 60) { // 14 分鐘沒跑過 → 強制觸發
      console.warn(`⚠️  Watchdog：cron 已 ${Math.floor(elapsed)}s 未執行，強制掃描`);
      lastCronAt = Date.now();
      scanAndPush().catch(e => console.error('Watchdog 觸發掃描失敗:', e.message));
    }
  }, 60 * 1000); // 每分鐘檢查一次
  console.log('🐕 Watchdog 已啟動（14 分鐘無動作自動恢復）');
});
 
