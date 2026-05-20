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
const USER_ID       = process.env.LINE_USER_ID;
const MIN_SCORE     = parseInt(process.env.MIN_SCORE || '65');
const MAX_LOSS_USDT = parseFloat(process.env.MAX_LOSS_USDT || '20');
const BASE_CAPITAL  = parseFloat(process.env.BASE_CAPITAL || '100');
const MAX_LOSS_PCT  = parseFloat(process.env.MAX_LOSS_PCT || '0.05');

// ══════════════════════════════════════════════
// 合約設定（SWAP 永續合約）
// ══════════════════════════════════════════════
const INST_TYPE     = 'SWAP';
const MGN_MODE      = 'cross';
const DEFAULT_LEVER = parseInt(process.env.DEFAULT_LEVER || '10');
const OKX_API_KEY   = process.env.OKX_API_KEY   || '';
const OKX_SECRET    = process.env.OKX_SECRET     || '';
const OKX_PASS      = process.env.OKX_PASS       || '';
const IS_DEMO       = process.env.IS_DEMO === 'true';

const toSwap = id => id.endsWith('-SWAP') ? id : id + '-SWAP';
const toSpot = id => id.replace(/-SWAP$/, '');

// ── 動態小數位數（比照 OKX 顯示精度）────────────────
// 例：0.00009244 → 8位；81600.00 → 2位；1.2345 → 4位
function getDecimals(price) {
  if (!price || price <= 0) return 4;
  if (price < 0.000001) return 10;
  if (price < 0.0001)   return 8;
  if (price < 0.001)    return 6;
  if (price < 0.1)      return 5;
  if (price < 1)        return 4;
  if (price < 10)       return 4;
  if (price < 1000)     return 3;
  if (price < 10000)    return 2;
  return 2;
}
function fmt(price) {
  if (price === null || price === undefined) return '—';
  return price.toFixed(getDecimals(price));
}
function fmtDiff(diff, price) {
  const d = getDecimals(price);
  const str = diff.toFixed(d);
  return diff >= 0 ? '+' + str : str;
}

// 固定監控幣對（合約格式）
const FIXED_PAIRS = [
  'BTC-USDT-SWAP','ETH-USDT-SWAP','ADA-USDT-SWAP','DOGE-USDT-SWAP',
  'SOL-USDT-SWAP','HYPE-USDT-SWAP','XRP-USDT-SWAP',
  'ZEC-USDT-SWAP','LABU-USDT-SWAP','BILL-USDT-SWAP',
  'BSB-USDT-SWAP','XAC-USDT-SWAP',
];

let WATCH_PAIRS = [...FIXED_PAIRS];
const pendingOrders = {};

// ── 方案B：冷卻機制（同幣種訊號 30 分鐘內不重複推送）──
const signalCooldown = new Map(); // pair → timestamp
const COOLDOWN_MS = 30 * 60 * 1000; // 30 分鐘

function isOnCooldown(pair) {
  const last = signalCooldown.get(pair);
  return last && (Date.now() - last) < COOLDOWN_MS;
}
function setCooldown(pair) { signalCooldown.set(pair, Date.now()); }

// ── 方案D：每日績效記錄 ──────────────────────────────
const dailyStats = { wins: 0, losses: 0, totalPnl: 0, signals: [], date: new Date().toLocaleDateString('zh-TW') };
function recordSignal(pair, score, dir) {
  dailyStats.signals.push({ pair, score, dir, time: new Date().toLocaleTimeString('zh-TW') });
}

// ══════════════════════════════════════════════
// 1. 動態抓取交易量前10名幣對
// ══════════════════════════════════════════════
async function updateTopPairs() {
  try {
    const { data } = await axios.get('https://www.okx.com/api/v5/market/tickers', {
      params: { instType: 'SWAP' }
    });
    const stableCoins = ['USDT','USDC','DAI','BUSD','TUSD','USDP','FDUSD'];
    const top10 = data.data
      .filter(t => t.instId.endsWith('-USDT-SWAP'))
      .filter(t => !stableCoins.some(s => t.instId.startsWith(s)))
      .sort((a, b) => parseFloat(b.volCcy24h) - parseFloat(a.volCcy24h))
      .slice(0, 10)
      .map(t => t.instId);  // already SWAP format

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
  const [candles, candles5m, ticker] = await Promise.all([
    fetchCandles(instId),
    fetchCandles5m(instId),
    fetchTicker(instId).catch(() => null),
  ]);
  const currentPrice = ticker ? parseFloat(ticker.last) : null;

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

  // 合約張數估算（以 1 USDT/張 粗估，實際依幣種合約面值）
  const swapSz = Math.max(1, Math.floor(positionSize / entry));

  return {
    score, dir, reasons, entry, sl, tp1, tp2, tp3,
    rr: '1:1.8', atr, leverage: finalLeverage,
    capital, positionSize: positionSize.toFixed(2),
    slAmount, tp1Amount, tp2Amount, tp3Amount, fee,
    doubleCapital, flow5m, rsi, macd, swapSz,
    currentPrice: currentPrice || entry,  // 即時價格
  };
}


// ══════════════════════════════════════════════
// OKX 合約下單（簽名 + API）
// ══════════════════════════════════════════════
const crypto = require('crypto');

function okxSign(timestamp, method, path, body = '') {
  const msg = timestamp + method + path + body;
  return crypto.createHmac('sha256', OKX_SECRET).update(msg).digest('base64');
}

function okxHeaders(method, path, body = '') {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
  return {
    'OK-ACCESS-KEY':        OKX_API_KEY,
    'OK-ACCESS-SIGN':       okxSign(ts, method, path, body),
    'OK-ACCESS-TIMESTAMP':  ts,
    'OK-ACCESS-PASSPHRASE': OKX_PASS,
    'Content-Type':         'application/json',
    ...(IS_DEMO ? { 'x-simulated-trading': '1' } : {}),
  };
}

async function okxPost(path, body) {
  const bodyStr = JSON.stringify(body);
  const { data } = await axios.post(
    'https://www.okx.com' + path, bodyStr,
    { headers: okxHeaders('POST', path, bodyStr), timeout: 10000 }
  );
  return data;
}

async function setLeverage(instId, lever) {
  try {
    await okxPost('/api/v5/account/set-leverage', {
      instId, lever: String(lever), mgnMode: MGN_MODE,
    });
    console.log(`⚡ 槓桿設定 ${instId} ${lever}x`);
  } catch (e) { console.warn('槓桿設定失敗:', e.message); }
}

async function placeSwapOrder(instId, a) {
  if (!OKX_API_KEY) return '⚠️ 未設定 OKX API Key，請在 Render Environment 加入。';
  const isLong  = a.dir === 'long';
  const posSide = isLong ? 'long' : 'short';
  const side    = isLong ? 'buy'  : 'sell';
  const closeSide = isLong ? 'sell' : 'buy';

  try {
    await setLeverage(instId, a.leverage);

    // 市價開倉
    const orderRes = await okxPost('/api/v5/trade/order', {
      instId, tdMode: MGN_MODE, side, posSide,
      ordType: 'market', sz: String(a.swapSz || 1),
    });
    if (orderRes.code !== '0') return `❌ 開倉失敗：${orderRes.msg}`;
    const ordId = orderRes.data[0].ordId;

    // 等成交
    await new Promise(r => setTimeout(r, 1500));

    // 止損
    await okxPost('/api/v5/trade/order-algo', {
      instId, tdMode: MGN_MODE, side: closeSide, posSide,
      ordType: 'conditional', sz: String(a.swapSz || 1),
      slTriggerPx: a.sl.toFixed(Math.max(6, getDecimals(a.sl))), slOrdPx: '-1',
    });

    // 三等分止盈（每筆 1/3 張數，最少1）
    const szEach = String(Math.max(1, Math.floor((a.swapSz || 1) / 3)));
    for (const tp of [a.tp1, a.tp2, a.tp3]) {
      await okxPost('/api/v5/trade/order-algo', {
        instId, tdMode: MGN_MODE, side: closeSide, posSide,
        ordType: 'conditional', sz: szEach,
        tpTriggerPx: tp.toFixed(Math.max(6, getDecimals(tp))), tpOrdPx: '-1',
      });
    }

    return `✅ 合約下單成功！\n訂單ID：${ordId}\n止損/三等分止盈已掛單`;
  } catch (e) {
    console.error('下單錯誤:', e.message);
    return `❌ 下單失敗：${e.message}`;
  }
}


// ══════════════════════════════════════════════
// 方案D：每日報告 Flex Message
// ══════════════════════════════════════════════
function buildDailyReport() {
  const total    = dailyStats.signals.length;
  const topPairs = dailyStats.signals
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const longCount  = dailyStats.signals.filter(s => s.dir === 'long').length;
  const shortCount = dailyStats.signals.filter(s => s.dir === 'short').length;
  const avgScore   = total > 0 ? Math.round(dailyStats.signals.reduce((s, x) => s + x.score, 0) / total) : 0;

  const signalRows = topPairs.map(s => ({
    type: 'box', layout: 'horizontal', paddingAll: '6px',
    backgroundColor: '#0d1520', cornerRadius: '5px', margin: 'xs',
    contents: [
      { type: 'text', text: s.pair.replace(/-USDT-SWAP$/, ''), color: '#00cfff', size: 'xs', flex: 2 },
      { type: 'text', text: s.dir === 'long' ? '📈 多' : '📉 空', color: s.dir === 'long' ? '#4ade80' : '#f87171', size: 'xs', flex: 1, align: 'center' },
      { type: 'text', text: `${s.score}分`, color: s.score >= 80 ? '#ff4466' : '#FFD600', size: 'xs', flex: 1, align: 'end' },
      { type: 'text', text: s.time, color: '#6b7a99', size: 'xxs', flex: 2, align: 'end' },
    ]
  }));

  return {
    type: 'flex',
    altText: `📊 每日報告 ${dailyStats.date}`,
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0a0e1a', paddingAll: '12px',
        contents: [
          { type: 'text', text: '📊 CWS-Apex 每日報告', color: '#7eb3f7', size: 'sm', weight: 'bold' },
          { type: 'text', text: dailyStats.date, color: '#6b7a99', size: 'xs' },
        ]
      },
      body: {
        type: 'box', layout: 'vertical', backgroundColor: '#141824', spacing: 'sm',
        contents: [
          // 統計摘要
          { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
            { type: 'box', layout: 'vertical', flex: 1, backgroundColor: '#0d1520', cornerRadius: '8px', paddingAll: '10px', contents: [
              { type: 'text', text: '訊號總數', color: '#6b7a99', size: 'xxs', align: 'center' },
              { type: 'text', text: String(total), color: '#00cfff', size: 'xl', weight: 'bold', align: 'center' },
            ]},
            { type: 'box', layout: 'vertical', flex: 1, backgroundColor: '#0d1520', cornerRadius: '8px', paddingAll: '10px', contents: [
              { type: 'text', text: '平均評分', color: '#6b7a99', size: 'xxs', align: 'center' },
              { type: 'text', text: `${avgScore}分`, color: avgScore >= 75 ? '#4ade80' : '#FFD600', size: 'xl', weight: 'bold', align: 'center' },
            ]},
            { type: 'box', layout: 'vertical', flex: 1, backgroundColor: '#0d1520', cornerRadius: '8px', paddingAll: '10px', contents: [
              { type: 'text', text: '多/空比', color: '#6b7a99', size: 'xxs', align: 'center' },
              { type: 'text', text: `${longCount}/${shortCount}`, color: '#e8eaf0', size: 'xl', weight: 'bold', align: 'center' },
            ]},
          ]},
          { type: 'separator', color: '#ffffff12', margin: 'md' },
          { type: 'text', text: '🏆 今日最強訊號', color: '#e8eaf0', size: 'xs', weight: 'bold' },
          ...(signalRows.length > 0 ? signalRows : [
            { type: 'text', text: '今日無訊號記錄', color: '#6b7a99', size: 'xs', align: 'center', margin: 'md' }
          ]),
          { type: 'separator', color: '#ffffff12', margin: 'md' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: `🔴 強訊號（≥80分）：${dailyStats.signals.filter(s=>s.score>=80).length}筆`, color: '#ff4466', size: 'xxs', flex: 1 },
            { type: 'text', text: `🟡 中訊號（≥${MIN_SCORE}分）：${dailyStats.signals.filter(s=>s.score>=MIN_SCORE&&s.score<80).length}筆`, color: '#FFD600', size: 'xxs', flex: 1, align: 'end' },
          ]},
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', backgroundColor: '#0a0e1a',
        contents: [
          { type: 'button', style: 'secondary', height: 'sm',
            action: { type: 'message', label: '🔍 立即掃描', text: '掃描' } },
        ]
      }
    }
  };
}

// ══════════════════════════════════════════════
// 6. LINE 訊號卡
// ══════════════════════════════════════════════
function buildSignalCard(pair, a, signalLevel = 'strong') {
  const isLong  = a.dir === 'long';
  const isStrong = signalLevel === 'strong';
  // 方案C：強度標示
  const levelBadge = isStrong ? '🔴 強訊號' : '🟡 觀察訊號';
  const levelColor = isStrong ? '#ff4466' : '#FFD600';
  const headerBg  = isStrong ? '#0a0e1a' : '#1a1400';
  const emoji     = isStrong ? '🔴' : '🟡';
  const now       = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  const displayPair = pair.replace(/-SWAP$/, '').replace(/-/g, '/');

  // 當下即時價格（分析時抓到的 entry 就是最新成交價）
  const currentPrice = a.currentPrice || a.entry;
  const priceDiff    = currentPrice - a.entry;
  const priceDiffStr = priceDiff >= 0 ? `+${priceDiff.toFixed(4)}` : priceDiff.toFixed(4);
  const priceColor   = priceDiff >= 0 ? '#4ade80' : '#f87171';

  return {
    type: 'flex',
    altText: `${emoji} ${displayPair} ${isLong?'做多':'做空'} 評分${a.score} 現價${fmt(currentPrice)}`,
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'horizontal', backgroundColor: headerBg, paddingAll: '12px',
        contents: [
          {
            type: 'box', layout: 'vertical', flex: 1,
            contents: [
              { type: 'text', text: '📊 CWS-Apex 訊號', color: '#7eb3f7', size: 'sm', weight: 'bold' },
              { type: 'text', text: now, color: '#6b7a99', size: 'xs' },
            ]
          },
          {
            type: 'box', layout: 'vertical', alignItems: 'flex-end',
            contents: [
              { type: 'text', text: levelBadge, color: levelColor, size: 'xs', weight: 'bold' },
              { type: 'text', text: `評分 ${a.score}/100`, color: '#6b7a99', size: 'xxs' },
            ]
          },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', backgroundColor: '#141824', spacing: 'sm',
        contents: [
          // 幣對 + 方向
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: displayPair, color: '#e8eaf0', size: 'xl', weight: 'bold', flex: 1 },
            { type: 'text', text: isLong ? '做多 📈' : '做空 📉', color: isLong ? '#4ade80' : '#f87171', size: 'sm', align: 'end', gravity: 'center' },
          ]},

          // ── 當下即時價格區塊（新增）──────────────────
          { type: 'box', layout: 'horizontal', backgroundColor: '#0d1520', cornerRadius: '6px', paddingAll: '8px', margin: 'sm', contents: [
            { type: 'box', layout: 'vertical', flex: 1, contents: [
              { type: 'text', text: '💹 即時價格', color: '#6b7a99', size: 'xxs' },
              { type: 'text', text: fmt(currentPrice), color: '#00cfff', size: 'lg', weight: 'bold' },
            ]},
            { type: 'box', layout: 'vertical', alignItems: 'flex-end', contents: [
              { type: 'text', text: '較訊號價', color: '#6b7a99', size: 'xxs' },
              { type: 'text', text: priceDiffStr, color: priceColor, size: 'sm', weight: 'bold' },
              { type: 'text', text: `RSI ${a.rsi?.toFixed(0)}  ${a.doubleCapital ? '⚡加倍' : ''}`, color: '#6b7a99', size: 'xxs' },
            ]},
          ]},

          { type: 'separator', color: '#ffffff12' },

          // 進場 + 槓桿
          { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
            { type: 'text', text: '訊號價', color: '#6b7a99', size: 'xs', flex: 1 },
            { type: 'text', text: fmt(a.entry), color: '#e8eaf0', size: 'sm', weight: 'bold', flex: 2 },
            { type: 'text', text: '槓桿', color: '#6b7a99', size: 'xs', flex: 1 },
            { type: 'text', text: `${a.leverage}x`, color: '#fbbf24', size: 'sm', weight: 'bold', flex: 2 },
          ]},
          // 止損
          { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
            { type: 'text', text: '止損', color: '#6b7a99', size: 'xs', flex: 1 },
            { type: 'text', text: fmt(a.sl), color: '#f87171', size: 'sm', weight: 'bold', flex: 2 },
            { type: 'text', text: '最虧', color: '#6b7a99', size: 'xs', flex: 1 },
            { type: 'text', text: `-$${a.slAmount}`, color: '#f87171', size: 'sm', weight: 'bold', flex: 2 },
          ]},
          { type: 'separator', color: '#ffffff12' },

          // 止盈三等分
          { type: 'text', text: '🎯 止盈三等分', color: '#4ade80', size: 'xs', weight: 'bold' },
          { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
            { type: 'text', text: '第1', color: '#6b7a99', size: 'xs', flex: 1 },
            { type: 'text', text: fmt(a.tp1), color: '#4ade80', size: 'xs', flex: 2 },
            { type: 'text', text: `+$${a.tp1Amount}`, color: '#4ade80', size: 'xs', flex: 2 },
          ]},
          { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
            { type: 'text', text: '第2', color: '#6b7a99', size: 'xs', flex: 1 },
            { type: 'text', text: fmt(a.tp2), color: '#4ade80', size: 'xs', flex: 2 },
            { type: 'text', text: `+$${a.tp2Amount}`, color: '#4ade80', size: 'xs', flex: 2 },
          ]},
          { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
            { type: 'text', text: '第3', color: '#6b7a99', size: 'xs', flex: 1 },
            { type: 'text', text: fmt(a.tp3), color: '#4ade80', size: 'xs', flex: 2 },
            { type: 'text', text: `+$${a.tp3Amount}`, color: '#4ade80', size: 'xs', flex: 2 },
          ]},
          { type: 'separator', color: '#ffffff12' },

          // 信號條件
          { type: 'text', text: a.reasons.filter(r => r.ok).map(r => `✅ ${r.t}`).join('  '), color: '#4ade80', size: 'xxs', wrap: true },
          { type: 'text', text: a.reasons.filter(r => !r.ok).map(r => `❌ ${r.t}`).join('  '), color: '#f87171', size: 'xxs', wrap: true },
          { type: 'separator', color: '#ffffff12' },

          // 費用
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
          { type: 'button', style: 'primary', color: isStrong ? '#16a34a' : '#856a00', height: 'sm',
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

  // ── 方案A：並行分析所有幣對（速度提升 3-5x）────────
  const results = await Promise.allSettled(
    WATCH_PAIRS.map(pair => analyze(pair).then(a => ({ pair, a })))
  );

  for (const res of results) {
    if (res.status === 'rejected') { console.error('❌ 分析失敗:', res.reason?.message); continue; }
    const { pair, a } = res.value;
    try {
      if (a.dir === 'neutral') continue;

      // ── 方案B：冷卻機制 ──────────────────────────
      if (isOnCooldown(pair)) {
        console.log(`⏸ ${pair} 冷卻中，跳過`);
        continue;
      }

      // ── 方案C：訊號強度分級 ──────────────────────
      if (a.score >= 80) {
        // 🔴 強訊號 → 立即推送（正常訊號卡）
        await client.pushMessage(USER_ID, buildSignalCard(pair, a, 'strong'));
        pendingOrders[pair] = { pair, analysis: a };
        setCooldown(pair);
        recordSignal(pair, a.score, a.dir);
        console.log(`🔴 強訊號推送：${pair} 評分${a.score}`);
      } else if (a.score >= MIN_SCORE) {
        // 🟡 中訊號 → 推送並標註「觀察」
        await client.pushMessage(USER_ID, buildSignalCard(pair, a, 'watch'));
        pendingOrders[pair] = { pair, analysis: a };
        setCooldown(pair);
        recordSignal(pair, a.score, a.dir);
        console.log(`🟡 中訊號推送：${pair} 評分${a.score}`);
      } else if (a.score >= 50) {
        // ⚪ 弱訊號 → 靜默記錄，不推送
        recordSignal(pair, a.score, a.dir);
        console.log(`⚪ 弱訊號記錄（不推送）：${pair} 評分${a.score}`);
      }
    } catch (e) { console.error(`❌ 推送失敗 ${pair}:`, e.message); }
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
      const displayPair = pair.replace(/-SWAP$/, '').replace('-', '/');

      // 手動執行確認訊息（含完整下單參數，請自行前往 OKX 執行）
      const reply =
        `✅ 下單確認\n\n` +
        `${displayPair} ${isLong ? '做多 📈' : '做空 📉'}（永續合約）\n` +
        `━━━━━━━━━━━━\n` +
        `💰 本金：$${a.capital} USDT${a.doubleCapital ? ' ⚡加倍' : ''}\n` +
        `⚡ 槓桿：${a.leverage}x\n` +
        `📊 倉位：$${a.positionSize} USDT\n` +
        `━━━━━━━━━━━━\n` +
        `🟢 進場：${fmt(a.entry)}\n` +
        `🛑 止損：${fmt(a.sl)}（-$${a.slAmount}）\n` +
        `━━━━━━━━━━━━\n` +
        `🎯 止盈三等分：\n` +
        `  第1：${fmt(a.tp1)}（+$${a.tp1Amount}）\n` +
        `  第2：${fmt(a.tp2)}（+$${a.tp2Amount}）\n` +
        `  第3：${fmt(a.tp3)}（+$${a.tp3Amount}）\n` +
        `━━━━━━━━━━━━\n` +
        `💸 手續費：$${a.fee}\n` +
        `📉 最大虧損：$${a.slAmount}\n\n` +
        `📌 請前往 OKX 合約頁面手動執行！`;
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

    } else if (text === '報告' || text === '每日報告') {
      await client.replyMessage(tok, buildDailyReport());

    } else if (text === '清除冷卻' || text === '重置') {
      signalCooldown.clear();
      await client.replyMessage(tok, { type: 'text', text: '✅ 已清除所有幣種冷卻，下次掃描將重新評估。' });
    }
  }
});

// ══════════════════════════════════════════════
// 9. 定時任務
// ══════════════════════════════════════════════
cron.schedule('*/3 * * * *', scanAndPush);
cron.schedule('0 * * * *', updateTopPairs);

// ── 方案D：每天早上 8:00 推送每日報告 ────────
cron.schedule('0 8 * * *', async () => {
  try {
    const report = buildDailyReport();
    await client.pushMessage(USER_ID, report);
    // 重置每日統計
    dailyStats.wins = 0;
    dailyStats.losses = 0;
    dailyStats.totalPnl = 0;
    dailyStats.signals = [];
    dailyStats.date = new Date().toLocaleDateString('zh-TW');
    console.log('📊 每日報告已推送');
  } catch (e) { console.error('每日報告推送失敗:', e.message); }
}, { timezone: 'Asia/Taipei' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Bot 啟動 Port ${PORT}`);
  await updateTopPairs();
  await scanAndPush();
});
