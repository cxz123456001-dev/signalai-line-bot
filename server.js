require('dotenv').config();
process.env.TZ = 'Asia/Taipei'; // 強制台北時間
 
// ── 防止多實例：用環境變數標記（Render 同一 dyno 不同 process）
const INSTANCE_ID = process.env.RENDER_INSTANCE_ID || process.pid.toString();
console.log(`🔖 實例 ID: ${INSTANCE_ID} PID: ${process.pid}`);
 
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
 
// ── Discord Webhook 推送（完全免費、無月限）────────────
async function discordPush(text, isSignal = false, color = 0x00CFFF) {
  if (!DISCORD_WEBHOOK) {
    console.warn('⚠️ DISCORD_WEBHOOK_URL 未設定，跳過推送');
    return false;
  }
  const body = isSignal
    ? { embeds: [{ description: text, color }] }
    : { content: text };
 
  for (let i = 1; i <= 3; i++) {
    try {
      await axios.post(DISCORD_WEBHOOK, body, { timeout: 15000 });
      return true;
    } catch (e) {
      const status = e.response?.status;
      if (i < 3) {
        console.warn(`⚠️ Discord 推送失敗 [${status||e.code}]，${i*3}秒後重試 (${i}/3)...`);
        await new Promise(r => setTimeout(r, i * 3000));
      } else {
        console.error(`❌ Discord 推送放棄 [${status||e.code}]: ${e.message}`);
        // #5 備援：Discord 全部失敗時嘗試 LINE 簡短通知
        if (isSignal && process.env.LINE_USER_ID && process.env.LINE_CHANNEL_ACCESS_TOKEN) {
          try {
            const shortMsg = text.split('\n').slice(0, 3).join('\n') + '\n⚠️ Discord 暫時斷線';
            await axios.post('https://api.line.me/v2/bot/message/push',
              { to: process.env.LINE_USER_ID, messages: [{ type: 'text', text: shortMsg }] },
              { headers: { 'Content-Type': 'application/json',
                  Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
                timeout: 10000 }
            );
            console.log('📱 LINE 備援推送成功');
          } catch (_) { console.error('❌ LINE 備援也失敗'); }
        }
        return false;
      }
    }
  }
}
 
// linePush 別名（相容現有呼叫點）
const linePush = (text) => discordPush(text, true);
const USER_ID         = process.env.LINE_USER_ID;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const MIN_SCORE       = parseInt(process.env.MIN_SCORE     || '70'); // 70分以上才推送，減少雜訊
const MAX_LOSS_USDT   = parseFloat(process.env.MAX_LOSS_USDT  || '20');
const BASE_CAPITAL    = parseFloat(process.env.BASE_CAPITAL   || '100');
const MAX_LOSS_PCT    = parseFloat(process.env.MAX_LOSS_PCT   || '0.05');
const DAILY_MAX_LOSS  = parseFloat(process.env.DAILY_MAX_LOSS || '50');  // 每日最大虧損熔斷
const FUND_RATE_LIMIT = parseFloat(process.env.FUND_RATE_LIMIT|| '0.0008'); // 資金費率極值
 
// ══════════════════════════════════════════════
// OKX 下單功能已停用（觀察期）
 
const toSwap = id => id.endsWith('-SWAP') ? id : id + '-SWAP';
 
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
const fmtDiff = (d, p) => (d == null ? '—' : (d >= 0 ? '+' : '') + d.toFixed(getDecimals(p)));
 
// ── 核心必選幣對（流動性佳、技術指標可靠）──────────
const FIXED_PAIRS = [
  // 核心大型幣（流動性最佳）
  'BTC-USDT','ETH-USDT','SOL-USDT','BNB-USDT',
  // 主流山寨（成交量大）
  'XRP-USDT','ADA-USDT','AVAX-USDT','TRX-USDT',
  // 高波動生態（DeFi / Layer2）
  'LINK-USDT','DOT-USDT','SUI-USDT','NEAR-USDT',
  // 迷因幣（高波動）
  'DOGE-USDT','PEPE-USDT','WIF-USDT','BONK-USDT',
  // V2 新增：熱門 Layer2 / DeFi / 新興生態
  'OP-USDT','ARB-USDT','INJ-USDT','TIA-USDT',
  'ONDO-USDT','JTO-USDT','EIGEN-USDT','W-USDT',
];
 
// ── EXTRA_PAIRS 環境變數（Render 設定，重啟即生效）────
// 格式：EXTRA_PAIRS=HBAR,FET,RENDER,TAO（逗號分隔，不需要 -USDT）
const EXTRA_PAIRS = (process.env.EXTRA_PAIRS || '')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  .map(s => s.includes('-USDT') ? s : `${s}-USDT`);
if (EXTRA_PAIRS.length) console.log(`➕ EXTRA_PAIRS：${EXTRA_PAIRS.join(' ')}`);
 
let WATCH_PAIRS = [...new Set([...FIXED_PAIRS, ...EXTRA_PAIRS])];
const recentPushes = new Map(); // pair → { dir, entry, ts } 防重複推送
 
const isDuplicatePush = (pair, a) => {
  const last = recentPushes.get(pair);
  if (!last) return false;
  return last.dir === a.dir
    && Math.abs(last.entry - a.entry) / a.entry < 0.002
    && Date.now() - last.ts < 10 * 60 * 1000;
};
const markPushed = (pair, a) => recentPushes.set(pair, { dir: a.dir, entry: a.entry, ts: Date.now() });
 
// ── 方案B：冷卻機制 ─────────────────────────────────
const signalCooldown = new Map();
const COOLDOWN_MS = 15 * 60 * 1000; // T3：縮短冷卻至 15 分鐘
const isOnCooldown = pair => { const t = signalCooldown.get(pair); return t && Date.now()-t < COOLDOWN_MS; };
const setCooldown = pair => signalCooldown.set(pair, Date.now());
 
// ── 每日績效記錄 ─────────────────────────────────────
const dailyStats = {
  signals: [],
  dailyLoss: 0,
  isFused: false,
  date: new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }),
};
const recordSignal = (pair, score, dir) => dailyStats.signals.push({ pair, score, dir, time: new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei' }) });
function addDailyLoss(amount) {
  dailyStats.dailyLoss += amount;
  if (!dailyStats.isFused && dailyStats.dailyLoss >= DAILY_MAX_LOSS) {
    dailyStats.isFused = true;
    const text = `🚨 熔斷\n今日虧損 $${dailyStats.dailyLoss.toFixed(2)}（上限 $${DAILY_MAX_LOSS}）\n⛔ 停止推送，明日重置`;
    linePush(text).catch(() => {});
    console.warn(`🔴 熔斷觸發：$${dailyStats.dailyLoss.toFixed(2)}`);
  }
}
 
// ── BTC 市場情緒緩存 ─────────────────────────────────
let btcTrend = 'neutral'; // 'bull' | 'bear' | 'neutral'
let btcTrendUpdatedAt = 0;
async function updateBtcTrend() {
  try {
    // 直接呼叫 axios，不走 rateLimiter，避免佔用掃描配額
    let candles = [];
    try {
      const { data } = await axios.get('https://www.okx.com/api/v5/market/candles', {
        params: { instId: 'BTC-USDT-SWAP', bar: '1H', limit: 25 }, timeout: 10000
      });
      candles = data?.data?.map(c => ({ close: +c[4], high: +c[2], low: +c[3], vol: +c[5] })) || [];
    } catch (_) {}
    if (!candles.length) return;
    const ma20 = candles.slice(0, 20).reduce((s, c) => s + c.close, 0) / Math.min(20, candles.length);
    const price = candles[0].close;
    const macd  = calcMACD(candles);
    if (price > ma20 && macd.histogram > 0)       btcTrend = 'bull';
    else if (price < ma20 && macd.histogram < 0)  btcTrend = 'bear';
    else                                           btcTrend = 'neutral';
    btcTrendUpdatedAt = Date.now();
    console.log(`🪙 BTC趨勢更新：${btcTrend} (價格${price.toFixed(0)} MA20:${ma20.toFixed(0)})`);
  } catch (e) { console.warn('BTC趨勢更新失敗:', e.message); }
}
 
// ── 資金費率緩存 ─────────────────────────────────────
const fundRateCache = new Map(); // instId → { rate, ts }
async function getFundRate(instId) {
  const cached = fundRateCache.get(instId);
  if (cached && Date.now() - cached.ts < 15 * 60 * 1000) return cached.rate;
  try {
    // 直接 axios，不走 rateLimiter，費率不需要即時
    const { data } = await axios.get('https://www.okx.com/api/v5/public/funding-rate', {
      params: { instId }, timeout: 8000
    });
    const rate = parseFloat(data.data[0]?.fundingRate || 0);
    fundRateCache.set(instId, { rate, ts: Date.now() });
    return rate;
  } catch (e) { return 0; }
}
 
 
// ── ADX 計算（方案E：市況偵測）───────────────────────
// ── 趨勢輔助指標（ADX + OBV趨勢 + RSI背離 合併）──────
function calcTrendSignals(candles) {
  if (!candles || candles.length < 15) {
    return { adx: 25, isTrend: false, obvTrend: 'flat', rsiDiv: 'none' };
  }
  // ADX
  const period = 14;
  let plusDM = 0, minusDM = 0, tr = 0;
  for (let i = 0; i < Math.min(period, candles.length - 1); i++) {
    const c = candles[i], p = candles[i + 1];
    const up = c.high - p.high, dn = p.low - c.low;
    plusDM  += up > dn && up > 0 ? up : 0;
    minusDM += dn > up && dn > 0 ? dn : 0;
    tr += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  const pDI = tr > 0 ? 100 * plusDM / tr : 0;
  const mDI = tr > 0 ? 100 * minusDM / tr : 0;
  const adx = (pDI + mDI) > 0 ? 100 * Math.abs(pDI - mDI) / (pDI + mDI) : 25;
 
  // OBV 趨勢（近5根 vs 前5根）
  const obv = (slice) => slice.reduce((s, c, i, a) => {
    if (i === 0) return s;
    return s + (a[i-1].close > c.close ? a[i-1].vol : a[i-1].close < c.close ? -a[i-1].vol : 0);
  }, 0);
  const obvRecent = obv(candles.slice(0, 6));
  const obvPrev   = obv(candles.slice(5, 11));
  const obvTrend  = obvRecent > obvPrev ? 'up' : obvRecent < obvPrev ? 'down' : 'flat';
 
  // RSI 背離
  let rsiDiv = 'none';
  const prices = candles.slice(0, 10).map(c => c.close);
  const rsi0 = calcRSI(candles), rsi4 = calcRSI(candles.slice(4));
  if (prices[0] < prices[4] && rsi0 > rsi4) rsiDiv = 'bullish';
  else if (prices[0] > prices[4] && rsi0 < rsi4) rsiDiv = 'bearish';
 
  return { adx, isTrend: adx > 25, obvTrend, rsiDiv };
}
 
// ── ATR 動態倍數（方案E）────────────────────────────
function getATRMultiplier(atr, candles) {
  const avg = candles.slice(0,20).reduce((s,c,i)=>{const p=candles[i+1]; return p?s+Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)):s;},0)/20;
  return atr < avg*0.7 ? 1.2 : atr > avg*1.5 ? 2.0 : 1.5;
}
 
 
 
// ══════════════════════════════════════════════
// 2. 行情抓取
// ══════════════════════════════════════════════
// 全域 API 限速器（最多 8 次/秒，OKX 上限20次/秒）
// 所有 OKX API 呼叫都必須通過此限速器
// ══════════════════════════════════════════════
// ── 4H / 15m K線快取（減少 API 呼叫）────────────────
const cache4h  = new Map(); // instId → { candles, ts }
const cache15m = new Map(); // instId → { candles, ts }
 
async function fetchCached4H(instId) {
  const cached = cache4h.get(instId);
  if (cached && Date.now() - cached.ts < 4 * 60 * 60 * 1000) return cached.candles;
  try {
    const swapId = instId.endsWith('-SWAP') ? instId : instId.replace(/-USDT$/, '-USDT-SWAP');
    const { data } = await axios.get('https://www.okx.com/api/v5/market/candles', {
      params: { instId: swapId, bar: '4H', limit: 20 }, timeout: 8000
    });
    const candles = data?.data?.map(c => ({ close:+c[4], high:+c[2], low:+c[3], open:+c[1], vol:+c[5] })) || [];
    if (candles.length) cache4h.set(instId, { candles, ts: Date.now() });
    return candles;
  } catch (_) { return cache4h.get(instId)?.candles || []; }
}
 
async function fetchCached15m(instId) {
  const cached = cache15m.get(instId);
  if (cached && Date.now() - cached.ts < 15 * 60 * 1000) return cached.candles;
  try {
    const swapId = instId.endsWith('-SWAP') ? instId : instId.replace(/-USDT$/, '-USDT-SWAP');
    const { data } = await axios.get('https://www.okx.com/api/v5/market/candles', {
      params: { instId: swapId, bar: '15m', limit: 30 }, timeout: 8000
    });
    const candles = data?.data?.map(c => ({ close:+c[4], high:+c[2], low:+c[3], open:+c[1], vol:+c[5] })) || [];
    if (candles.length) cache15m.set(instId, { candles, ts: Date.now() });
    return candles;
  } catch (_) { return cache15m.get(instId)?.candles || []; }
}
 
const rateLimiter = {
  queue: [],
  running: 0,
  maxConcurrent: 1,        // 單一並行
  minInterval: 600,        // 每個請求間隔 600ms
  lastCallTime: 0,
 
  async acquire() {
    return new Promise(resolve => {
      this.queue.push(resolve);
      this._next();
    });
  },
 
  async _next() {
    if (this.running >= this.maxConcurrent || !this.queue.length) return;
    const now = Date.now();
    const wait = Math.max(0, this.minInterval - (now - this.lastCallTime));
    if (wait > 0) {
      await new Promise(r => setTimeout(r, wait));
    }
    if (!this.queue.length) return;
    const resolve = this.queue.shift();
    this.running++;
    this.lastCallTime = Date.now();
    resolve(() => {
      this.running--;
      this._next();
    });
  }
};
 
async function fetchWithRetry(url, params, retries = 3) {
  const release = await rateLimiter.acquire();
  try {
    for (let i = 0; i < retries; i++) {
      try {
        const { data } = await axios.get(url, { params, timeout: 12000 });
        return data;
      } catch (e) {
        const status = e.response?.status;
        if (status === 429) {
          const wait = (i + 1) * 3000; // 3/6/9 秒
          console.warn(`⏳ 429 速率限制，${wait/1000}s 後重試 (${i+1}/${retries})...`);
          await new Promise(r => setTimeout(r, wait));
        } else if (i === retries - 1) {
          throw e;
        } else {
          await new Promise(r => setTimeout(r, 800));
        }
      }
    }
  } finally {
    release();
  }
}
 
async function fetchCandles(instId, bar = '4H', limit = 50) {
  const data = await fetchWithRetry('https://www.okx.com/api/v5/market/candles', { instId, bar, limit });
  if (!data?.data?.length) return [];
  return data.data.map(c => ({
    ts: parseInt(c[0]),
    open: parseFloat(c[1]), high: parseFloat(c[2]),
    low: parseFloat(c[3]),  close: parseFloat(c[4]), vol: parseFloat(c[5]),
  }));
}
 
async function fetchCandles5m(instId) {
  return fetchCandles(instId, '5m', 20);
}
 
 
// ══════════════════════════════════════════════
// 3. 技術指標計算
// ══════════════════════════════════════════════
function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i-1].close - candles[i].close;
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}
 
function calcMACD(candles) {
  const c = candles.map(x => x.close).reverse();
  const ema = (d, p) => { const k = 2/(p+1); let e = d[0]; for (let i=1;i<d.length;i++) e=d[i]*k+e*(1-k); return e; };
  const m = ema(c,12) - ema(c,26);
  const s = ema(c.slice(-9), 9);
  return { macd: m, signal: s, histogram: m - s };
}
 
function calcATR(candles, period = 14) {
  const trs = [];
  for (let i = 0; i < Math.min(period, candles.length - 1); i++) {
    const high = candles[i].high, low = candles[i].low, prevClose = candles[i + 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return trs.length > 0 ? trs.reduce((a, b) => a + b, 0) / trs.length : 0;
}
 
function calcBollinger(candles, period = 20) {
  const closes = candles.slice(0, period).map(c => c.close);
  const avg = closes.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(closes.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / period);
  return { upper: avg + 2 * std, middle: avg, lower: avg - 2 * std };
}
 
// ── W2：VWAP 計算（成交量加權平均價）──────────────────
// 機構最常用的參考線，判斷多空力道
function calcVWAP(candles, period = 20) {
  const slice = candles.slice(0, Math.min(period, candles.length));
  let totalPV = 0, totalVol = 0;
  for (const c of slice) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    totalPV  += typicalPrice * c.vol;
    totalVol += c.vol;
  }
  return totalVol > 0 ? totalPV / totalVol : slice[0]?.close || 0;
}
 
function calc5mFlow(candles5m) {
  if (!candles5m || candles5m.length < 5) return { bullRatio: 0.5, bearRatio: 0.5, volSurge: 1, avgVol: 0, rebound: false, breakdown: false };
  const r = candles5m.slice(0, 5);
  const bv = r.filter(c=>c.close>c.open).reduce((s,c)=>s+c.vol,0);
  const tot = r.reduce((s,c)=>s+c.vol,0);
  const bullRatio = tot > 0 ? bv/tot : 0.5;
  const avgVol = tot / r.length;
  const prev = candles5m.slice(5,10);
  const prevAvg = prev.length ? prev.reduce((s,c)=>s+c.vol,0)/prev.length : avgVol||1;
  const volSurge = prevAvg > 0 ? avgVol / prevAvg : 1;
 
  // ── 強力反彈偵測（照片模式：急跌後爆量V型反轉）──
  // 條件：前1根大跌 + 最新根爆量大陽線/長下影線
  const c0 = candles5m[0]; // 最新根
  const c1 = candles5m[1]; // 前一根
  const c2 = candles5m[2]; // 前兩根
  const range0 = c0.high - c0.low;
  const body0  = Math.abs(c0.close - c0.open);
  const lowerShadow0 = Math.min(c0.open, c0.close) - c0.low; // 下影線長度
  const drop1  = c1.open > 0 ? (c1.open - c1.close) / c1.open : 0; // 前根跌幅
  const volSpike = c1.vol > 0 ? c0.vol / c1.vol : 1;                // 量能爆增倍數
 
  // 強力反彈：前根急跌(>1%) + 當根爆量(>1.5x) + 收陽或長下影線
  const rebound = drop1 > 0.01
    && volSpike > 1.5
    && (c0.close > c0.open || lowerShadow0 > body0 * 0.8);
 
  // 強力跌破：前根大漲 + 當根爆量大陰線
  const rise1 = c1.open > 0 ? (c1.close - c1.open) / c1.open : 0;
  const upperShadow0 = c0.high - Math.max(c0.open, c0.close);
  const breakdown = rise1 > 0.01
    && volSpike > 1.5
    && (c0.close < c0.open || upperShadow0 > body0 * 0.8);
 
  return { bullRatio, bearRatio: 1-bullRatio, volSurge, avgVol, rebound, breakdown };
}
 
// ── 做多評分 ───────────────────────────────────
function scoreLong(reasons, score, p) {
  const { last, resistance, support, rsi, macd, boll, ma10, ma20, ma50, flow5m, volRatio, isCandle_bull, bodyRatio, mtf, obvTrend, rsiDiv, isTrend, vwap, adx, signal15m, mom15m } = p;
  if (last.close > resistance && volRatio > 1.2) {
    reasons.push({ t: `突破${fmt(resistance)}阻力`, ok: true }); score += 18;
  }
  if (last.close < support * 1.005 && last.close > support * 0.995) {
    reasons.push({ t: `回測${fmt(support)}支撐`, ok: true }); score += 12;
  }
  if (rsi < 35)       { reasons.push({ t: `RSI超賣(${rsi.toFixed(0)})`, ok: true  }); score += 14; }
  else if (rsi < 50)  { reasons.push({ t: `RSI健康(${rsi.toFixed(0)})`, ok: true  }); score +=  6; }
  else if (rsi > 70)  { reasons.push({ t: `RSI過熱(${rsi.toFixed(0)})`, ok: false }); score -=  8; }
  else                { reasons.push({ t: `RSI中性(${rsi.toFixed(0)})`, ok: false }); score -=  3; }
  if (macd.histogram > 0 && macd.macd > macd.signal) {
    reasons.push({ t: 'MACD金叉', ok: true }); score += 10;
  } else { reasons.push({ t: 'MACD未金叉', ok: false }); score -= 6; }
  if (last.close > boll.upper) { reasons.push({ t: '突破布林上軌', ok: true }); score += 8; }
  if (ma10 > ma20) {
    reasons.push({ t: 'MA10>MA20多頭', ok: true }); score += 8;
    if (ma20 > ma50) { reasons.push({ t: 'MA均線多頭排列', ok: true }); score += 5; }
  } else { reasons.push({ t: 'MA均線空頭', ok: false }); score -= 7; }
  if (flow5m.bullRatio > 0.65)      { reasons.push({ t: `5m買方${(flow5m.bullRatio*100).toFixed(0)}%`, ok: true  }); score += 7; }
  else if (flow5m.bullRatio < 0.4)  { reasons.push({ t: '5m賣方壓制', ok: false }); score -= 6; }
  if (volRatio > 1.5)      { reasons.push({ t: `放量${volRatio.toFixed(1)}x`, ok: true  }); score += 7; }
  else if (volRatio < 0.7) { reasons.push({ t: '量能萎縮',    ok: false }); score -= 5; }
  if (isCandle_bull && bodyRatio > 0.5) { reasons.push({ t: '強力陽線', ok: true  }); score += 5; }
  else if (!isCandle_bull)              { reasons.push({ t: '收陰線',   ok: false }); score -= 5; }
  if (mtf.mtfDir === 'long')  { reasons.push({ t: '4H+1H共振做多', ok: true }); score += mtf.mtfBonus; }
  if (obvTrend === 'up')      { reasons.push({ t: 'OBV量能上升', ok: true }); score += 8; }
  if (rsiDiv === 'bullish')   { reasons.push({ t: 'RSI底背離',   ok: true }); score += 10; }
  if (isTrend) { if (ma10 > ma20 && macd.histogram > 0) score += 5; }
  else         { if (rsi < 35) score += 6; }
 
  // ── 5m 強力反彈加分 ───────────────────────────────
  if (flow5m.rebound) {
    reasons.push({ t: '5m急跌爆量反彈🔥', ok: true }); score += 15;
  }
 
  // ── T4：15m 動能確認加分 ─────────────────────────
  if (signal15m === 'bull') {
    reasons.push({ t: `15m多頭動能${mom15m > 5 ? '強🔥' : ''}`, ok: true });
    score += mom15m > 5 ? 12 : 7;
  } else if (signal15m === 'bear') {
    reasons.push({ t: '15m空頭動能', ok: false }); score -= 8;
  }
 
  // ── 多指標共振加分（3個以上核心指標同向 +10）──
  const bullSignals = [
    macd.histogram > 0,
    rsi < 50,
    ma10 > ma20,
    flow5m.bullRatio > 0.55,
    obvTrend === 'up',
    volRatio > 1.2,
  ].filter(Boolean).length;
  if (bullSignals >= 5) { reasons.push({ t: `強多共振(${bullSignals}/6)`, ok: true }); score += 12; }
  else if (bullSignals >= 4) { reasons.push({ t: `多頭共振(${bullSignals}/6)`, ok: true }); score += 6; }
 
  // ── W2：VWAP 加分（機構參考線）────────────────────
  if (vwap && last.close) {
    const vwapDist = (last.close - vwap) / vwap;
    if (vwapDist > 0.003) {
      // 現價在 VWAP 上方 0.3% 以上 → 機構淨買入
      reasons.push({ t: `高於VWAP ${(vwapDist*100).toFixed(1)}%`, ok: true }); score += 10;
    } else if (vwapDist < -0.003) {
      // 現價在 VWAP 下方 → 機構淨賣出，做多不利
      reasons.push({ t: `低於VWAP ${(Math.abs(vwapDist)*100).toFixed(1)}%`, ok: false }); score -= 8;
    } else {
      // 現價在 VWAP ±0.3% 之內 → 方向模糊
      reasons.push({ t: 'VWAP附近震盪', ok: false }); score -= 3;
    }
  }
 
  // ── W3：ADX 分層策略 ──────────────────────────────
  // 根據趨勢強度選對的策略，不在錯誤環境下單
  if (adx !== undefined) {
    if (adx < 20) {
      // 極弱趨勢（震盪市）→ 趨勢突破策略可靠性低
      if (last.close > resistance) {
        reasons.push({ t: `ADX弱(${adx.toFixed(0)})突破不可靠`, ok: false }); score -= 10;
      }
      // 但均值回歸（RSI超賣反彈）在震盪市反而更準
      if (rsi < 35) { score += 5; } // 震盪+超賣，額外加分
    } else if (adx >= 20 && adx < 40) {
      // 中等趨勢 → 兩種策略都適合，不加不減
      reasons.push({ t: `ADX中(${adx.toFixed(0)})趨勢適中`, ok: true }); score += 3;
    } else if (adx >= 40) {
      // 強趨勢 → 順勢突破最可靠
      if (last.close > resistance) {
        reasons.push({ t: `ADX強(${adx.toFixed(0)})順勢突破`, ok: true }); score += 8;
      } else {
        reasons.push({ t: `ADX強趨勢做多`, ok: true }); score += 5;
      }
    }
  }
 
  return score;
}
 
// ── 做空評分 ───────────────────────────────────
function scoreShort(reasons, score, p) {
  const { last, support, rsi, macd, boll, ma10, ma20, ma50, flow5m, volRatio, isCandle_bull, bodyRatio, mtf, obvTrend, rsiDiv, isTrend, vwap, adx, signal15m, mom15m } = p;
  if (last.close < support && volRatio > 1.2) {
    reasons.push({ t: `跌破${fmt(support)}支撐`, ok: true }); score += 18;
  }
  if (rsi > 65)       { reasons.push({ t: `RSI超買(${rsi.toFixed(0)})`, ok: true  }); score += 14; }
  else if (rsi > 50)  { reasons.push({ t: `RSI偏高(${rsi.toFixed(0)})`, ok: true  }); score +=  6; }
  else if (rsi < 30)  { reasons.push({ t: `RSI過低(${rsi.toFixed(0)})`, ok: false }); score -=  8; }
  else                { reasons.push({ t: `RSI中性(${rsi.toFixed(0)})`, ok: false }); score -=  3; }
  if (macd.histogram < 0 && macd.macd < macd.signal) {
    reasons.push({ t: 'MACD死叉', ok: true }); score += 10;
  } else { reasons.push({ t: 'MACD未死叉', ok: false }); score -= 6; }
  if (last.close < boll.lower) { reasons.push({ t: '跌破布林下軌', ok: true }); score += 8; }
  if (ma10 < ma20) {
    reasons.push({ t: 'MA10<MA20空頭', ok: true }); score += 8;
    if (ma20 < ma50) { reasons.push({ t: 'MA均線空頭排列', ok: true }); score += 5; }
  } else { reasons.push({ t: 'MA均線多頭', ok: false }); score -= 7; }
  if (flow5m.bullRatio < 0.35)     { reasons.push({ t: `5m賣方${((1-flow5m.bullRatio)*100).toFixed(0)}%`, ok: true  }); score += 7; }
  else if (flow5m.bullRatio > 0.6) { reasons.push({ t: '5m買方壓制', ok: false }); score -= 6; }
  if (volRatio > 1.5)      { reasons.push({ t: `放量下跌${volRatio.toFixed(1)}x`, ok: true  }); score += 7; }
  else if (volRatio < 0.7) { reasons.push({ t: '量能萎縮',         ok: false }); score -= 5; }
  if (!isCandle_bull && bodyRatio > 0.5) { reasons.push({ t: '強力陰線', ok: true  }); score += 5; }
  else if (isCandle_bull)                { reasons.push({ t: '收陽線',   ok: false }); score -= 5; }
  if (mtf.mtfDir === 'short') { reasons.push({ t: '4H+1H共振做空', ok: true }); score += mtf.mtfBonus; }
  if (obvTrend === 'down')    { reasons.push({ t: 'OBV量能下降', ok: true }); score += 8; }
  if (rsiDiv === 'bearish')   { reasons.push({ t: 'RSI頂背離',   ok: true }); score += 10; }
  if (isTrend) { if (ma10 < ma20 && macd.histogram < 0) score += 5; }
  else         { if (rsi > 65) score += 6; }
 
  // ── 5m 強力跌破加分 ───────────────────────────────
  if (flow5m.breakdown) {
    reasons.push({ t: '5m大漲爆量跌破🔥', ok: true }); score += 15;
  }
 
  // ── T4：15m 動能確認加分 ─────────────────────────
  if (signal15m === 'bear') {
    reasons.push({ t: `15m空頭動能${mom15m < -5 ? '強🔥' : ''}`, ok: true });
    score += Math.abs(mom15m) > 5 ? 12 : 7;
  } else if (signal15m === 'bull') {
    reasons.push({ t: '15m多頭動能', ok: false }); score -= 8;
  }
 
  // ── 多指標共振加分（3個以上核心指標同向 +10）──
  const bearSignals = [
    macd.histogram < 0,
    rsi > 50,
    ma10 < ma20,
    flow5m.bullRatio < 0.45,
    obvTrend === 'down',
    volRatio > 1.2,
  ].filter(Boolean).length;
  if (bearSignals >= 5) { reasons.push({ t: `強空共振(${bearSignals}/6)`, ok: true }); score += 12; }
  else if (bearSignals >= 4) { reasons.push({ t: `空頭共振(${bearSignals}/6)`, ok: true }); score += 6; }
 
  // ── W2：VWAP 加分（機構參考線）────────────────────
  if (vwap && last.close) {
    const vwapDist = (last.close - vwap) / vwap;
    if (vwapDist < -0.003) {
      // 現價在 VWAP 下方 → 機構淨賣出，做空有利
      reasons.push({ t: `低於VWAP ${(Math.abs(vwapDist)*100).toFixed(1)}%`, ok: true }); score += 10;
    } else if (vwapDist > 0.003) {
      // 現價在 VWAP 上方 → 機構淨買入，做空不利
      reasons.push({ t: `高於VWAP ${(vwapDist*100).toFixed(1)}%`, ok: false }); score -= 8;
    } else {
      reasons.push({ t: 'VWAP附近震盪', ok: false }); score -= 3;
    }
  }
 
  // ── W3：ADX 分層策略 ──────────────────────────────
  if (adx !== undefined) {
    if (adx < 20) {
      // 震盪市 → 做空突破不可靠
      if (last.close < support) {
        reasons.push({ t: `ADX弱(${adx.toFixed(0)})跌破不可靠`, ok: false }); score -= 10;
      }
      // RSI 超買反轉在震盪市反而準
      if (rsi > 65) { score += 5; }
    } else if (adx >= 20 && adx < 40) {
      reasons.push({ t: `ADX中(${adx.toFixed(0)})趨勢適中`, ok: true }); score += 3;
    } else if (adx >= 40) {
      if (last.close < support) {
        reasons.push({ t: `ADX強(${adx.toFixed(0)})順勢跌破`, ok: true }); score += 8;
      } else {
        reasons.push({ t: `ADX強趨勢做空`, ok: true }); score += 5;
      }
    }
  }
 
  return score;
}
 
async function analyze(instId) {
  const mtf = { mtfDir: 'neutral', mtfBonus: 0 }; // MTF 已移除
 
  const [candles, candles5m] = await Promise.all([
    fetchCandles(instId, '1H', 50).catch(() => []),
    fetchCandles5m(instId).catch(() => []),
  ]);
  const ticker = candles.length ? { last: String(candles[0].close) } : null;
 
  // ── 4H / 15m K線（快取版，大幅減少 API 呼叫）─────
  const [candles4h, candles15m] = await Promise.all([
    fetchCached4H(instId),
    fetchCached15m(instId),
  ]);
 
  // ── 資料完整性檢查 ─────────────────────────────────
  if (!candles.length || candles.length < 25) {
    throw new Error(`K線資料不足（${candles.length} 根）`);
  }
  if (!candles5m.length || candles5m.length < 5) {
    throw new Error(`5m K線資料不足`);
  }
 
  const currentPrice = ticker ? parseFloat(ticker.last) : null;
  const last  = candles[0];
  if (!last?.close || !last?.high || !last?.low || !last?.vol) {
    throw new Error(`K線欄位缺失`);
  }
  const prev5  = candles.slice(1, 6);
  const prev10 = candles.slice(1, 11);
  // 10根支撐阻力更可靠
  const resistance = Math.max(...prev10.map(c => c.high));
  const support    = Math.min(...prev10.map(c => c.low));
  const avgVol     = prev10.reduce((s, c) => s + c.vol, 0) / prev10.length;
  const volRatio   = last.vol / avgVol;
  const ma10       = candles.slice(0, 10).reduce((s, c) => s + c.close, 0) / 10;
  const ma20       = candles.slice(0, 20).reduce((s, c) => s + c.close, 0) / 20;
 
  const rsi    = calcRSI(candles);
  const macd   = calcMACD(candles);
  const atr    = calcATR(candles);
  const boll   = calcBollinger(candles);
  const vwap   = calcVWAP(candles); // W2: VWAP
  const flow5m   = calc5mFlow(candles5m);
 
  // ── T4：15m 指標計算 ─────────────────────────────────
  let signal15m = 'neutral'; // 'bull' | 'bear' | 'neutral'
  let mom15m = 0; // 15m 動能分數（-10 ~ +10）
  if (candles15m.length >= 15) {
    const rsi15   = calcRSI(candles15m);
    const macd15  = calcMACD(candles15m);
    const ma5_15  = candles15m.slice(0,5).reduce((s,c)=>s+c.close,0)/5;
    const ma10_15 = candles15m.slice(0,10).reduce((s,c)=>s+c.close,0)/10;
    // 15m 趨勢判斷
    if (rsi15 < 45 && macd15.histogram < 0 && ma5_15 < ma10_15) {
      signal15m = 'bear'; mom15m = -1 * Math.min(10, Math.abs(macd15.histogram / candles15m[0].close * 10000));
    } else if (rsi15 > 55 && macd15.histogram > 0 && ma5_15 > ma10_15) {
      signal15m = 'bull'; mom15m = Math.min(10, macd15.histogram / candles15m[0].close * 10000);
    }
  }
  const { adx, isTrend, obvTrend, rsiDiv } = calcTrendSignals(candles);
 
  // ── 方案 A：4H 趨勢方向判斷 ────────────────────────
  let trend4h = 'neutral';
  if (candles4h.length >= 10) {
    const ma10_4h = candles4h.slice(0,10).reduce((s,c)=>s+c.close,0)/10;
    const macd4h  = calcMACD(candles4h);
    if (candles4h[0].close > ma10_4h && macd4h.histogram > 0) trend4h = 'bull';
    else if (candles4h[0].close < ma10_4h && macd4h.histogram < 0) trend4h = 'bear';
  } // 趨勢輔助指標
 
  const reasons = [];
  let score = 50, dir = 'neutral';
 
  const ma50         = candles.slice(-50).reduce((s,c)=>s+c.close,0)/50;
  const isCandle_bull = last.close > last.open;
  const candleBody    = Math.abs(last.close - last.open);
  const candleRange   = last.high - last.low;
  const bodyRatio     = candleRange > 0 ? candleBody / candleRange : 0;
 
  // ── 方向預判（多空信號各自計分）────────────────
  let longPts = 0, shortPts = 0;
  if (last.close > resistance && volRatio > 1.2)           longPts  += 4;
  if (last.close < support    && volRatio > 1.2)           shortPts += 4;
  if (last.close < support * 1.005 && last.close > support * 0.995) longPts += 2;
  if (rsi < 40)  longPts  += 3;
  if (rsi > 60)  shortPts += 3;
  if (macd.histogram > 0 && macd.macd > macd.signal)      longPts  += 2;
  if (macd.histogram < 0 && macd.macd < macd.signal)      shortPts += 2;
  if (ma10 > ma20 && ma20 > ma50)                          longPts  += 2;
  if (ma10 < ma20 && ma20 < ma50)                          shortPts += 2;
  if (flow5m.bullRatio > 0.6)                              longPts  += 2;
  if (flow5m.bullRatio < 0.4)                              shortPts += 2;
  if (isCandle_bull && bodyRatio > 0.5)                    longPts  += 1;
  if (!isCandle_bull && bodyRatio > 0.5)                   shortPts += 1;
  if (last.close > boll.upper)                             longPts  += 1;
  if (last.close < boll.lower)                             shortPts += 1;
 
  if      (longPts  >= shortPts + 3) dir = 'long';  // V1：放寬至 3
  else if (shortPts >= longPts  + 3) dir = 'short';
 
  // ── 方案 A：4H 共振加減分 ──────────────────────────
  // 4H 和 1H 同向 → +15；反向 → -20（幾乎無法過門檻）
  if (dir === 'long'  && trend4h === 'bull') score += 15;
  // #5 校準：4H 衝突直接標記，評分後在 _doScan 過濾
  if (dir === 'long'  && trend4h === 'bear') score -= 12;
  if (dir === 'short' && trend4h === 'bear') score += 15;
  if (dir === 'short' && trend4h === 'bull') score -= 12;
  if (trend4h !== 'neutral') {
    const conflict = (dir==='long'&&trend4h==='bear')||(dir==='short'&&trend4h==='bull');
    reasons.push({ t: conflict ? '4H方向衝突❌' : (trend4h==='bull'?'4H多頭共振✅':'4H空頭共振✅'), ok: !conflict });
  }
 
  // ══════════════════════════════════════════════
  // 評分計算（呼叫獨立函式）
  // ══════════════════════════════════════════════
  if (dir === 'long') {
    score = scoreLong(reasons, score, { last, resistance, support, rsi, macd, boll, ma10, ma20, ma50, flow5m, volRatio, isCandle_bull, bodyRatio, mtf, obvTrend, rsiDiv, isTrend, vwap, adx, signal15m, mom15m });
  } else if (dir === 'short') {
    score = scoreShort(reasons, score, { last, resistance, support, rsi, macd, boll, ma10, ma20, ma50, flow5m, volRatio, isCandle_bull, bodyRatio, mtf, obvTrend, rsiDiv, isTrend, vwap, adx, signal15m, mom15m });
  } else {
    reasons.push({ t: `RSI中性(${rsi.toFixed(0)})`, ok: false });
    reasons.push({ t: 'MACD方向不明', ok: false });
    score = 35;
  }
 
  // ── W1：評分正規化（原始分 → 0~100 標準分）──────────
  // 最低有意義分 = 35（neutral），最高理論值 ≈ 220
  const rawScore = score;
  score = Math.round(Math.min(100, Math.max(0, (rawScore - 35) / 140 * 100))); // #2 校準：/185→/140
  const entry = last.close;
 
  // ── 方案 B：關鍵價位止損 + ATR 保底 ─────────────
  const atrMult = getATRMultiplier(atr, candles);
  const atrSL   = atr * atrMult;
  let sl;
  if (dir === 'long') {
    const keyLow  = Math.min(...prev10.map(c => c.low));  // 前10根最低點
    const keyStop = keyLow  - atr * 0.3;                  // 下移緩衝
    const atrStop = entry   - atrSL;
    // 取較近的止損，但不超過 ATR 止損 1.5 倍，且至少距離 0.5 ATR
    sl = Math.max(Math.max(keyStop, atrStop), entry - atrSL * 1.5);
    sl = Math.min(sl, entry - atr * 0.5);
  } else if (dir === 'short') {
    const keyHigh = Math.max(...prev10.map(c => c.high)); // 前10根最高點
    const keyStop = keyHigh + atr * 0.3;
    const atrStop = entry   + atrSL;
    sl = Math.min(Math.min(keyStop, atrStop), entry + atrSL * 1.5);
    sl = Math.max(sl, entry + atr * 0.5);
  } else {
    sl = dir === 'long' ? entry - atrSL : entry + atrSL;
  }
  const slDist = Math.abs(entry - sl);
 
  // 止盈分3等分
  const tp1 = dir === 'long' ? entry + slDist : entry - slDist;         // 1:1
  const tp2 = dir === 'long' ? entry + slDist * 1.8 : entry - slDist * 1.8; // 1:1.8
  const tp3 = dir === 'long' ? entry + slDist * 3.0 : entry - slDist * 3.0; // 1:3
 
  // 動態槓桿評估
  let leverage = 5;
  if (dir === 'long') {
    if (flow5m.volSurge > 2 && flow5m.bullRatio > 0.6 && score >= 75) leverage = 20;
    else if (flow5m.volSurge > 1.5 && score >= 70) leverage = 15;
    else if (score >= 65) leverage = 10;
    else leverage = 5;
  } else if (dir === 'short') {
    if (flow5m.volSurge > 2 && flow5m.bullRatio < 0.35 && score >= 75) leverage = 20;
    else if (flow5m.volSurge > 1.5 && score >= 70) leverage = 15;
    else if (score >= 65) leverage = 10;
    else leverage = 5;
  }
 
  const doubleCapital = flow5m.volSurge > 2.5 && score >= 85; // 量能爆發且高分才加倍
 
  const capital = BASE_CAPITAL * (doubleCapital ? 1.5 : 1); // 固定本金
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
    rr: '1:1.8', atr, atrMult, leverage: finalLeverage,
    capital, positionSize: positionSize.toFixed(2),
    slAmount, tp1Amount, tp2Amount, tp3Amount, fee,
    doubleCapital, flow5m, rsi, macd, swapSz,
    currentPrice: currentPrice || entry,
    adx, isTrend, mtfDir: mtf.mtfDir, obvTrend, rsiDiv, flow5m, trend4h, atr: atr, vwap, signal15m,
    vwapPos: vwap > 0 ? (last.close > vwap * 1.003 ? '🔼VWAP上' : last.close < vwap * 0.997 ? '🔽VWAP下' : '↔️VWAP中') : '',
  };
}
 
 
// ── OKX 下單 ────────────────────────────────────
 
// ── 訊號卡 ─────────────────────────────────────
// ── 純文字訊號（輕量版，避免 LINE Flex 限速）─────────
function buildTextSignal(pair, a, badge) {
  try {
    const isLong = a.dir === 'long';
    const sym = pair.replace(/-USDT-SWAP$/, '').replace(/-USDT$/, '');
    const dir = isLong ? '做多 📈' : '做空 📉';
    const good = (a.reasons || []).filter(r => r.ok).map(r => r.t).join(' · ') || '—';
    const bad  = (a.reasons || []).filter(r => !r.ok).map(r => r.t).join(' · ');
    const price = a.currentPrice || a.entry || 0;
    return (
      `${badge} **${sym}** ${dir}  評分 **${a.score}**/100  ${(()=>{ const h=parseInt(new Date().toLocaleString('en-US',{timeZone:'Asia/Taipei',hour:'numeric',hour12:false})); return h>=21||h<5?'🇺🇸美國盤':h>=15?'🇪🇺歐洲盤':h>=8?'🌏亞洲盤':'🌙深夜'; })()}\n` +
      `RSI **${(a.rsi||0).toFixed(0)}** · ADX **${(a.adx||0).toFixed(0)}** · ${a.isTrend?'📊 趨勢':'〰️ 震盪'} · ${a.vwapPos||''} · 15m${a.signal15m==='bull'?' 📈':a.signal15m==='bear'?' 📉':' ➡️'}\n` +
      `──────────────\n` +
      `💹 現價：\`${fmt(price)}\`\n` +
      `🟢 進場：\`${fmt(a.entry||0)}\`  ⚡${a.leverage||1}x\n` +
      `🔺 止損：\`${fmt(a.sl||0)}\`（最虧 **-$${a.slAmount||0}**）\n` +
      `──────────────\n` +
      `🎯 TP1：\`${fmt(a.tp1||0)}\`（**+$${a.tp1Amount||0}**）\n` +
      `🎯 TP2：\`${fmt(a.tp2||0)}\`（**+$${a.tp2Amount||0}**）\n` +
      `🎯 TP3：\`${fmt(a.tp3||0)}\`（**+$${a.tp3Amount||0}**）\n` +
      `──────────────\n` +
      `✅ ${good}\n` +
      (bad ? `❌ ${bad}\n` : '') +
      (a.rsiDiv && a.rsiDiv !== 'none' ? `🔔 RSI ${a.rsiDiv==='bullish'?'底背離':'頂背離'} · ` : '') +
      (a.obvTrend === 'up' ? 'OBV↑ ' : a.obvTrend === 'down' ? 'OBV↓ ' : '') +
      ((a.rsiDiv && a.rsiDiv !== 'none') || a.obvTrend !== 'flat' ? '\n' : '') +
      `──────────────\n` +
      `💰 本金 **$${a.capital||100}** · 倉位 **$${a.positionSize||0}** · 手續費 $${a.fee||0}\n` +
      `📌 訊號來源：Alice Bot`
    );
  } catch (err) {
    console.error('buildTextSignal 錯誤:', err.message);
    return `${badge} ${pair} 訊號（格式錯誤）`;
  }
}
 
 
// ── 掃描推送 ────────────────────────────────────
let _scanning = false; // 互斥鎖，防止並行掃描
async function scanAndPush() {
  if (_scanning) { console.log('⏳ 上次掃描尚未完成，跳過'); return; }
  _scanning = true;
  try { await _doScan(); } finally { _scanning = false; }
}
async function _doScan() {
  lastCronAt = Date.now(); // Watchdog reset
  // ── 每日熔斷檢查 ─────────────────────────────────
  if (dailyStats.isFused) { return; }
 
 
 
  console.log(`[${new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei' })}] 掃描 ${WATCH_PAIRS.length} 個幣對… BTC:${btcTrend}`);
 
  // ── 完全序列掃描（每次一個幣，避免 429）────────────
  const results = [];
  for (let i = 0; i < WATCH_PAIRS.length; i++) {
    const pair = WATCH_PAIRS[i];
    const r = await analyze(pair).then(a => ({ pair, a })).catch(e => ({ status:'rejected', reason:e }));
    results.push({ status: 'fulfilled', value: r });
    // 每幣掃完後休息 600ms（4H axios + 2次API × 800ms + 緩衝）
    if (i < WATCH_PAIRS.length - 1) {
      await new Promise(r => setTimeout(r, 600));
    }
  }
 
  // ── 收集所有有效訊號，每輪只推送最高分一個 ────────
  const validSignals = [];
 
  for (const res of results) {
    if (res.status === 'rejected') continue;
    const { pair, a } = res.value;
    if (!a || a.dir === 'neutral') continue;
    if (a.score < MIN_SCORE) { if (a.score >= 50) recordSignal(pair, a.score, a.dir); continue; }
    // #4 過濾：volSurge 依幣種分層（迷因幣放寬）
    const memePairs = ['DOGE-USDT','PEPE-USDT','WIF-USDT','BONK-USDT','SHIB-USDT','FLOKI-USDT'];
    const volSurgeMin = memePairs.includes(pair) ? 0.5 : 0.7;
    if (a.flow5m?.volSurge < volSurgeMin) { console.log(`⚡ ${pair} 量能萎縮(${a.flow5m.volSurge.toFixed(2)}x < ${volSurgeMin})，跳過`); continue; }
    // BTC 趨勢過濾
    if (a.dir === 'long'  && btcTrend === 'bear' && a.score < 85) continue;
    if (a.dir === 'short' && btcTrend === 'bull' && a.score < 85) continue;
    // #5 校準：4H 衝突直接跳過（reasons 有「4H方向衝突❌」的不推送）
    if (a.reasons?.some(r => r.t === '4H方向衝突❌')) {
      console.log(`↩️ ${pair} 4H方向衝突，跳過`); continue;
    }
 
    // ── 方案 D：否決條件（硬性過濾，不管評分多高）──────
    const atr = a.atr || 0;
    const slDist = Math.abs(a.entry - a.sl);
    const candleRange = a.entry * 0.02; // 近似
    // ── W4：時段動態門檻 ─────────────────────────────
    const twHour = new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hour12: false });
    const h = parseInt(twHour);
    let sessionMinScore = MIN_SCORE;
    if (h >= 8 && h < 16) {
      // 亞洲盤：成交量低、假突破多 → 門檻提高 +5
      sessionMinScore = MIN_SCORE + 5;
      if (a.score < sessionMinScore) { console.log(`🌏 ${pair} 亞洲盤門檻(${sessionMinScore})未達，跳過`); continue; }
    } else if (h >= 21 || h < 5) {
      // 美國盤：成交量最大、機構主導 → 門檻降低 -3
      sessionMinScore = Math.max(MIN_SCORE - 3, 60);
    }
    // （歐洲盤 16-21 使用標準門檻）
 
    // D1：RSI 極端值（做多時過熱，做空時過賣）
    const rsi = a.rsi || 50;
    if (a.dir === 'long'  && rsi > 75) { console.log(`🚫 ${pair} RSI過熱(${rsi.toFixed(0)})，否決做多`); continue; }
    if (a.dir === 'short' && rsi < 25) { console.log(`🚫 ${pair} RSI過賣(${rsi.toFixed(0)})，否決做空`); continue; }
    // D2：成交量極度萎縮（volSurge < 0.5，假突破風險極高）
    if (a.flow5m?.volSurge < 0.5) { console.log(`🚫 ${pair} 成交量極萎縮(${a.flow5m.volSurge.toFixed(2)}x)，否決`); continue; }
    // D3：止損距離過大（slDist / entry > 3%，風險過高）
    if (a.entry > 0 && slDist / a.entry > 0.03) { console.log(`🚫 ${pair} 止損過大(${(slDist/a.entry*100).toFixed(1)}%)，否決`); continue; }
    // D4：止損距離過小（slDist / entry < 0.2%，容易被掃）
    if (a.entry > 0 && slDist / a.entry < 0.002) { console.log(`🚫 ${pair} 止損過近(${(slDist/a.entry*100).toFixed(2)}%)，否決`); continue; }
 
    // ── 方案 C：波動率過濾（ATR% 甜蜜區間）──────────
    const atrPct = a.entry > 0 ? (a.atr || 0) / a.entry : 0;
    if (atrPct < 0.003) { console.log(`🌙 ${pair} 波動率過低(${(atrPct*100).toFixed(2)}%)，盤整中跳過`); continue; }
    if (atrPct > 0.04)  { console.log(`⚡ ${pair} 波動率過高(${(atrPct*100).toFixed(2)}%)，極端行情跳過`); continue; }
 
    if (isOnCooldown(pair)) continue;
    if (isDuplicatePush(pair, a)) { console.log(`⏭ 重複略過 ${pair}`); continue; }
    validSignals.push({ pair, a });
  }
 
  // 按需查資金費率（只查有訊號的幣）
  for (const s of validSignals) {
    const fr = await getFundRate(toSwap(s.pair)).catch(() => 0);
    if (s.a.dir === 'long'  && fr >  FUND_RATE_LIMIT) { s.skip = true; continue; }
    if (s.a.dir === 'short' && fr < -FUND_RATE_LIMIT) { s.skip = true; continue; }
  }
  const pushable = validSignals.filter(s => !s.skip);
 
  if (pushable.length === 0) { console.log('⚪ 本輪無有效訊號'); return; }
 
  // V1：強訊號全推，中訊號最多推 2 個
  pushable.sort((x, y) => y.a.score - x.a.score);
  const strong = pushable.filter(s => s.a.score >= 80);
  const medium = pushable.filter(s => s.a.score < 80);
  // 強訊號全推，中訊號只取前 2
  const toSend = [...strong, ...medium.slice(0, 2)];
  const skipped = medium.slice(2);
  if (skipped.length > 0) {
    console.log(`  略過低分訊號：${skipped.map(s=>`${s.pair.replace('-USDT','')}(${s.a.score})`).join(' ')}`);
    skipped.forEach(s => recordSignal(s.pair, s.a.score, s.a.dir));
  }
  console.log(`📊 本輪推送：強${strong.length}個 中${Math.min(medium.length,2)}個`);
 
  for (let si = 0; si < toSend.length; si++) {
    const { pair, a } = toSend[si];
    const isStrong = a.score >= 80;
    const badge = isStrong ? '🔴 強訊號' : '🟡 中訊號';
    const msg = buildTextSignal(pair, a, badge);
    console.log(`📤 推送 ${pair} ${badge} 評分${a.score}（${msg.length}字）`);
    const color = a.dir === 'long'
      ? (isStrong ? 0x00E578 : 0x00A854)
      : (isStrong ? 0xFF4466 : 0xCC2244);
    const ok = await discordPush(msg, true, color);
    if (ok) {
      markPushed(pair, a);
      setCooldown(pair);
      recordSignal(pair, a.score, a.dir);
      console.log(`✅ 推送完成：${pair}`);
    }
    // #3 效能：最後一個訊號不等待
    if (si < toSend.length - 1) await new Promise(r => setTimeout(r, 1000));
  }
}
 
// ── Webhook ────────────────────────────────────
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;
    const text = event.message.text.trim();
    const tok  = event.replyToken;
 
    if (text === 'myid') {
      await client.replyMessage(tok, { type: 'text', text: `你的 ID：\n${event.source.userId}` });
 
    } else if (text.startsWith('新增 ') || text.startsWith('新增監控 ')) {
      const input = text.replace(/^(新增監控?)\s+/, '').toUpperCase();
      const symbols = input.split(/\s+/).filter(Boolean);
      const added = [], exists = [];
      for (const sym of symbols) {
        const pair = sym.includes('-USDT') ? sym : `${sym}-USDT`;
        if (WATCH_PAIRS.includes(pair)) { exists.push(sym); continue; }
        WATCH_PAIRS.push(pair);
        added.push(sym);
      }
      await client.replyMessage(tok, {
        type: 'text',
        text: `✅ 監控更新\n` +
          (added.length  ? `➕ 新增：${added.join('、')}\n` : '') +
          (exists.length ? `⏭️ 已存在：${exists.join('、')}\n` : '') +
          `共 ${WATCH_PAIRS.length} 個幣對`,
      });
 
    } else if (text.startsWith('移除 ') || text.startsWith('移除監控 ')) {
      const input = text.replace(/^(移除監控?)\s+/, '').toUpperCase();
      const symbols = input.split(/\s+/).filter(Boolean);
      const removed = [], notFound = [];
      for (const sym of symbols) {
        const pair = sym.includes('-USDT') ? sym : `${sym}-USDT`;
        const idx = WATCH_PAIRS.indexOf(pair);
        if (idx === -1) { notFound.push(sym); continue; }
        WATCH_PAIRS.splice(idx, 1);
        removed.push(sym);
      }
      await client.replyMessage(tok, {
        type: 'text',
        text: `✅ 監控更新\n` +
          (removed.length  ? `➖ 移除：${removed.join('、')}\n` : '') +
          (notFound.length ? `⚠️ 未找到：${notFound.join('、')}\n` : '') +
          `共 ${WATCH_PAIRS.length} 個幣對`,
      });
 
    } else {
      await client.replyMessage(tok, {
        type: 'text',
        text: `❓ 不認識這個指令\n\n傳「指令」或「?」查看所有功能`,
      });
    }
  }
});
 
 
// ══════════════════════════════════════════════
// Keep-Alive：防止 Render 免費方案休眠
// ══════════════════════════════════════════════
const RENDER_URL = process.env.RENDER_URL || '';
app.get('/ping', (req, res) => res.send('pong 🏓'));
app.get('/health', (req, res) => res.json({
  status: 'ok',
  uptime: Math.floor(process.uptime()),
  pairs: WATCH_PAIRS?.length ?? 0,
  time: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
}));
 
// ══════════════════════════════════════════════
// 定時任務
// ══════════════════════════════════════════════
cron.schedule('*/2 * * * *', scanAndPush); // 加快取後 ~74 秒/輪，2 分鐘有 46 秒緩衝
cron.schedule('*/15 * * * *', () => updateBtcTrend().catch(()=>{})); // BTC趨勢每15分鐘
 
// 每天 00:00 重置每日統計與熔斷
cron.schedule('0 0 * * *', () => {
  dailyStats.dailyLoss = 0;
  dailyStats.isFused   = false;
  dailyStats.signals   = [];
  dailyStats.date      = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  recentPushes.clear();   // 清除跨日去重快取
  signalCooldown.clear();  // 清除冷卻
  cache4h.clear();         // 清除 4H K線快取
  cache15m.clear();        // 清除 15m K線快取
  console.log('🔄 每日重置：統計/去重快取/冷卻 全部清除');
}, { timezone: 'Asia/Taipei' });
 
// ══════════════════════════════════════════════
// 啟動
// ══════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Alice Bot 啟動 Port ${PORT}`);
 
  // Keep-alive 先啟動
  if (RENDER_URL) {
    setInterval(async () => {
      try {
        const res = await axios.get(`${RENDER_URL}/ping`, { timeout: 10000 });
        console.log(`💓 Keep-alive ping OK (${res.status})`);
      } catch (e) { console.warn(`⚠️ Keep-alive ping 失敗: ${e.message}`); }
    }, 8 * 60 * 1000);
    console.log(`💓 Keep-alive 已啟動 → ${RENDER_URL}/ping`);
  }
 
  // Watchdog
  let lastCronAt = Date.now();
  setInterval(() => {
    const elapsed = (Date.now() - lastCronAt) / 1000;
    if (elapsed > 10 * 60) {
      console.warn(`⚠️ Watchdog：${Math.floor(elapsed)}s 未掃描，強制觸發`);
      lastCronAt = Date.now();
      scanAndPush().catch(e => console.error('Watchdog 觸發失敗:', e.message));
    }
  }, 60 * 1000);
  console.log('🐕 Watchdog 已啟動');
 
  // 分散啟動：每個步驟間隔 5 秒，避免瞬間爆量
  setTimeout(async () => {
    try { await updateBtcTrend(); } catch(e) {}
  }, 2000);
 
  setTimeout(() => console.log(`📊 監控：${WATCH_PAIRS.map(p=>p.replace('-USDT','')).join(' ')}`), 8000);
 
  setTimeout(async () => {
    try { await scanAndPush(); } catch(e) {}
  }, 20000); // 啟動 20 秒後才開始第一次掃描
});
 
