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
const USER_ID       = process.env.LINE_USER_ID;
const MIN_SCORE       = parseInt(process.env.MIN_SCORE     || '65');
const MAX_LOSS_USDT   = parseFloat(process.env.MAX_LOSS_USDT  || '20');
const BASE_CAPITAL    = parseFloat(process.env.BASE_CAPITAL   || '100');
const MAX_LOSS_PCT    = parseFloat(process.env.MAX_LOSS_PCT   || '0.05');
const DAILY_MAX_LOSS  = parseFloat(process.env.DAILY_MAX_LOSS || '50');  // 每日最大虧損熔斷
const FUND_RATE_LIMIT = parseFloat(process.env.FUND_RATE_LIMIT|| '0.0008'); // 資金費率極值
 
// ══════════════════════════════════════════════
// 合約設定（SWAP 永續合約）
// ══════════════════════════════════════════════
const MGN_MODE      = 'cross';
const DEFAULT_LEVER = parseInt(process.env.DEFAULT_LEVER || '10');
const OKX_API_KEY   = process.env.OKX_API_KEY   || '';
const OKX_SECRET    = process.env.OKX_SECRET     || '';
const OKX_PASS      = process.env.OKX_PASS       || '';
const IS_DEMO       = process.env.IS_DEMO === 'true';
 
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
function fmtDiff(diff, price) {
  const d = getDecimals(price);
  const str = diff.toFixed(d);
  return diff >= 0 ? '+' + str : str;
}
 
// ── 核心必選幣對（流動性佳、技術指標可靠）──────────
const FIXED_PAIRS = [
  'BTC-USDT','ETH-USDT','SOL-USDT',
  'XRP-USDT','BNB-USDT','LINK-USDT',
];
 
 
let WATCH_PAIRS = [...FIXED_PAIRS];
const pendingOrders = {};
const recentPushes = new Map(); // pair → { dir, entry, ts } 防重複推送
 
function isDuplicatePush(pair, a) {
  const key = pair;
  const last = recentPushes.get(key);
  if (!last) return false;
  const sameDir = last.dir === a.dir;
  const sameEntry = Math.abs(last.entry - a.entry) / a.entry < 0.002; // 價格差 < 0.2%
  const fresh = Date.now() - last.ts < 10 * 60 * 1000; // 10分鐘內
  return sameDir && sameEntry && fresh;
}
function markPushed(pair, a) {
  recentPushes.set(pair, { dir: a.dir, entry: a.entry, ts: Date.now() });
}
 
// ── 方案B：冷卻機制 ─────────────────────────────────
const signalCooldown = new Map();
const COOLDOWN_MS = 30 * 60 * 1000;
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
    console.warn(`🔴 每日虧損熔斷觸發！今日虧損 $${dailyStats.dailyLoss.toFixed(2)}，停止交易`);
    client.pushMessage(USER_ID, {
      type: 'text',
      text: `🚨 熔斷警告\n\n今日累計虧損已達 $${dailyStats.dailyLoss.toFixed(2)}（上限 $${DAILY_MAX_LOSS}）\n\n⛔ 今日剩餘時間停止推送訊號\n明日 08:00 自動重置`,
    }).catch(e => console.warn('熔斷推送失敗:', e.message));
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
 
 
// ── 監控清單（固定，不打 API）────────────────────
function updateTopPairs() {
  console.log(`📊 監控：${WATCH_PAIRS.map(p=>p.replace('-USDT','')).join(' ')}`);
}
 
// ══════════════════════════════════════════════
// 2. 行情抓取
// ══════════════════════════════════════════════
// 全域 API 限速器（最多 8 次/秒，OKX 上限20次/秒）
// 所有 OKX API 呼叫都必須通過此限速器
// ══════════════════════════════════════════════
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
 
async function fetchTicker(instId) {
  const data = await fetchWithRetry('https://www.okx.com/api/v5/market/ticker', { instId });
  return data?.data?.[0] || null;
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
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}
 
function calcBollinger(candles, period = 20) {
  const closes = candles.slice(0, period).map(c => c.close);
  const avg = closes.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(closes.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / period);
  return { upper: avg + 2 * std, middle: avg, lower: avg - 2 * std };
}
 
function calc5mFlow(candles5m) {
  if (!candles5m || candles5m.length < 5) return { bullRatio: 0.5, bearRatio: 0.5, volSurge: 1, avgVol: 0 };
  const r = candles5m.slice(0, 5);
  const bv = r.filter(c=>c.close>c.open).reduce((s,c)=>s+c.vol,0);
  const tot = r.reduce((s,c)=>s+c.vol,0);
  const bullRatio = tot > 0 ? bv/tot : 0.5;
  const avgVol = tot / r.length;
  const prev = candles5m.slice(5,10);
  const prevAvg = prev.length ? prev.reduce((s,c)=>s+c.vol,0)/prev.length : avgVol||1;
  return { bullRatio, bearRatio: 1-bullRatio, volSurge: prevAvg>0?avgVol/prevAvg:1, avgVol };
}
 
// ── 做多評分 ───────────────────────────────────
function scoreLong(reasons, score, p) {
  const { last, resistance, support, rsi, macd, boll, ma10, ma20, ma50, flow5m, volRatio, isCandle_bull, bodyRatio, mtf, obvTrend, rsiDiv, isTrend } = p;
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
  return score;
}
 
// ── 做空評分 ───────────────────────────────────
function scoreShort(reasons, score, p) {
  const { last, support, rsi, macd, boll, ma10, ma20, ma50, flow5m, volRatio, isCandle_bull, bodyRatio, mtf, obvTrend, rsiDiv, isTrend } = p;
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
  return score;
}
 
async function analyze(instId) {
  const mtf = { mtfDir: 'neutral', mtfBonus: 0 }; // MTF 已移除
 
  const [candles, candles5m] = await Promise.all([
    fetchCandles(instId, '1H', 50).catch(() => []),
    fetchCandles5m(instId).catch(() => []),
  ]);
  // 現價直接從最新 K 線取，省去一次 Ticker API
  const ticker = candles.length ? { last: String(candles[0].close) } : null;
 
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
  const flow5m   = calc5mFlow(candles5m);
  const { adx, isTrend, obvTrend, rsiDiv } = calcTrendSignals(candles); // 趨勢輔助指標
 
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
 
  if      (longPts  >= shortPts + 3) dir = 'long';
  else if (shortPts >= longPts  + 3) dir = 'short';
 
  // ══════════════════════════════════════════════
  // 評分計算（呼叫獨立函式）
  // ══════════════════════════════════════════════
  if (dir === 'long') {
    score = scoreLong(reasons, score, { last, resistance, support, rsi, macd, boll, ma10, ma20, ma50, flow5m, volRatio, isCandle_bull, bodyRatio, mtf, obvTrend, rsiDiv, isTrend });
  } else if (dir === 'short') {
    score = scoreShort(reasons, score, { last, resistance, support, rsi, macd, boll, ma10, ma20, ma50, flow5m, volRatio, isCandle_bull, bodyRatio, mtf, obvTrend, rsiDiv, isTrend });
  } else {
    reasons.push({ t: `RSI中性(${rsi.toFixed(0)})`, ok: false });
    reasons.push({ t: 'MACD方向不明', ok: false });
    score = 35;
  }
 
  score = Math.min(100, Math.max(0, score));
  const entry = last.close;
 
  // ATR 動態倍數（低波動緊、高波動寬）
  const atrMult = getATRMultiplier(atr, candles);
  const atrSL = atr * atrMult;
  const sl = dir === 'long' ? entry - atrSL : entry + atrSL;
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
    adx, isTrend, mtfDir: mtf.mtfDir, obvTrend, rsiDiv,
  };
}
 
 
// ── OKX 下單 ────────────────────────────────────
const crypto = require('crypto');
 
function okxSign(ts, method, path, body='') { return crypto.createHmac('sha256',OKX_SECRET).update(ts+method+path+body).digest('base64'); }
 
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
// 指令選單 Flex Message
// ══════════════════════════════════════════════
 
 
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
      `${badge} ${sym} ${dir}  評分${a.score}\n` +
      `━━━━━━━━━━━━\n` +
      `💹 現價：${fmt(price)}\n` +
      `🟢 進場：${fmt(a.entry||0)}  ⚡${a.leverage||1}x\n` +
      `🛑 止損：${fmt(a.sl||0)}（-$${a.slAmount||0}）\n` +
      `━━━━━━━━━━━━\n` +
      `🎯 TP1：${fmt(a.tp1||0)}（+$${a.tp1Amount||0}）\n` +
      `🎯 TP2：${fmt(a.tp2||0)}（+$${a.tp2Amount||0}）\n` +
      `🎯 TP3：${fmt(a.tp3||0)}（+$${a.tp3Amount||0}）\n` +
      `━━━━━━━━━━━━\n` +
      `✅ ${good}\n` +
      (bad ? `❌ ${bad}\n` : '') +
      `💰 $${a.capital||100}本金  $${a.positionSize||0}倉位\n` +
      `\n回覆「一鍵下單 ${pair}」執行`
    );
  } catch (err) {
    console.error('buildTextSignal 錯誤:', err.message, JSON.stringify(a).slice(0,200));
    return `${badge} ${pair} 訊號（格式錯誤，請查看 log）`;
  }
}
 
function buildSignalCard(pair, a, signalLevel = 'strong') {
  const isLong  = a.dir === 'long';
  const isStrong = signalLevel === 'strong';
  // 強度標示
  const levelBadge = isStrong ? '🔴 強訊號' : '🟡 觀察訊號';
  const levelColor = isStrong ? '#ff4466' : '#FFD600';
  const headerBg  = isStrong ? '#0a0e1a' : '#1a1400';
  const emoji     = isStrong ? '🔴' : '🟡';
  const now       = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' });
  const displayPair = pair.replace(/-SWAP$/, '').replace(/-/g, '/');
 
  // 當下即時價格（分析時抓到的 entry 就是最新成交價）
  const currentPrice = (a.currentPrice && a.currentPrice > 0) ? a.currentPrice : a.entry;
  const priceDiff    = currentPrice - a.entry;
  const priceDiffStr = fmtDiff(priceDiff, currentPrice);
  const priceColor   = priceDiff >= 0 ? '#4ade80' : '#f87171';
 
  return {
    type: 'flex',
    altText: `${emoji} ${displayPair} ${isLong?'做多📈':'做空📉'} 評分${a.score} ${a.isTrend?'趨勢行情':'震盪行情'}`,
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'horizontal', backgroundColor: headerBg, paddingAll: '12px',
        contents: [
          {
            type: 'box', layout: 'vertical', flex: 1,
            contents: [
              { type: 'text', text: '📊 Alice 訊號', color: '#7eb3f7', size: 'sm', weight: 'bold' },
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
              { type: 'text', text: priceDiffStr, color: priceColor, size: 'sm', weight: 'bold' },
              { type: 'text', text: `RSI ${a.rsi?.toFixed(0)} | ADX ${a.adx?.toFixed(0)||'—'} ${a.isTrend?'📊趨勢':'〰️震盪'} | ${a.dir==='long'?'多頭↑':'空頭↓'} ${a.doubleCapital?'⚡':''}`, color: '#6b7a99', size: 'xxs' },
            ]},
          ]},
 
          { type: 'separator', color: '#ffffff12' },
 
          { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
            { type: 'text', text: '訊號價', color: '#6b7a99', size: 'xs', flex: 1 },
            { type: 'text', text: fmt(a.entry), color: '#e8eaf0', size: 'sm', weight: 'bold', flex: 2 },
            { type: 'text', text: '槓桿', color: '#6b7a99', size: 'xs', flex: 1 },
            { type: 'text', text: `${a.leverage}x`, color: '#fbbf24', size: 'sm', weight: 'bold', flex: 2 },
          ]},
          { type: 'box', layout: 'baseline', spacing: 'sm', contents: [
            { type: 'text', text: isLong ? '止損 ▼' : '止損 ▲', color: '#6b7a99', size: 'xs', flex: 1 },
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
 
          { type: 'text', text: a.reasons.filter(r => r.ok).map(r => `✅ ${r.t}`).join('  '), color: '#4ade80', size: 'xxs', wrap: true },
          { type: 'text', text: a.reasons.filter(r => !r.ok).map(r => `❌ ${r.t}`).join('  '), color: '#f87171', size: 'xxs', wrap: true },
          { type: 'text', text: [
            a.mtfDir !== 'neutral' ? `📡 MTF${a.mtfDir==='long'?'多':'空'}` : '',
            a.obvTrend === 'up' ? 'OBV↑' : a.obvTrend === 'down' ? 'OBV↓' : '',
            a.rsiDiv !== 'none' ? (a.rsiDiv==='bullish'?'🔔底背離':'🔔頂背離') : '',
          ].filter(Boolean).join('  ') || '—', color: '#00cfff', size: 'xxs', wrap: true },
          { type: 'separator', color: '#ffffff12' },
 
          // 費用
          { type: 'text', text: `💰 本金$${a.capital}  📊 倉位$${a.positionSize}  💸 費$${a.fee}`, color: '#6b7a99', size: 'xxs', wrap: true },
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
 
// ── 掃描推送 ────────────────────────────────────
let _scanning = false; // 互斥鎖，防止並行掃描
async function scanAndPush() {
  if (_scanning) { console.log('⏳ 上次掃描尚未完成，跳過'); return; }
  _scanning = true;
  try { await _doScan(); } finally { _scanning = false; }
}
async function _doScan() {
  // ── 每日熔斷檢查 ─────────────────────────────────
  if (dailyStats.isFused) { return; }
 
 
 
  console.log(`[${new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei' })}] 掃描 ${WATCH_PAIRS.length} 個幣對… BTC:${btcTrend}`);
 
  // ── 完全序列掃描（每次一個幣，避免 429）────────────
  const results = [];
  for (let i = 0; i < WATCH_PAIRS.length; i++) {
    const pair = WATCH_PAIRS[i];
    const r = await analyze(pair).then(a => ({ pair, a })).catch(e => ({ status:'rejected', reason:e }));
    results.push({ status: 'fulfilled', value: r });
    // 每幣掃完後休息 1 秒（2次API × 800ms + 緩衝）
    if (i < WATCH_PAIRS.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
 
  // ── 收集所有有效訊號，每輪只推送最高分一個 ────────
  const validSignals = [];
 
  for (const res of results) {
    if (res.status === 'rejected') continue;
    const { pair, a } = res.value;
    if (!a || a.dir === 'neutral') continue;
    if (a.score < MIN_SCORE) { if (a.score >= 50) recordSignal(pair, a.score, a.dir); continue; }
    if (a.dir === 'long'  && btcTrend === 'bear' && a.score < 80) continue;
    if (a.dir === 'short' && btcTrend === 'bull' && a.score < 80) continue;
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
 
  // 只推送評分最高的一個
  pushable.sort((x, y) => y.a.score - x.a.score);
  const best = pushable[0];
  if (pushable.length > 1) {
    const others = pushable.slice(1).map(s => `${s.pair.replace('-USDT','')}(${s.a.score})`).join(' ');
    console.log(`  其他訊號略過：${others}`);
    pushable.slice(1).forEach(s => recordSignal(s.pair, s.a.score, s.a.dir));
  }
 
  const { pair, a } = best;
  const badge = a.score >= 80 ? '🔴 強訊號' : '🟡 中訊號';
  const msg = buildTextSignal(pair, a, badge);
  console.log(`📤 推送 ${pair} ${badge} 評分${a.score}（${msg.length}字）`);
  try {
    await client.pushMessage(USER_ID, { type: 'text', text: msg });
    markPushed(pair, a);
    pendingOrders[pair] = { pair, analysis: a, createdAt: Date.now() };
    setCooldown(pair);
    recordSignal(pair, a.score, a.dir);
    console.log(`✅ 推送完成：${pair}`);
  } catch (e) {
    const status = e.response?.status;
    if (status === 429) {
      console.warn(`⚠️ LINE 429，等 5 秒`);
      await new Promise(r => setTimeout(r, 5000));
    } else if (!status) {
      console.error(`❌ LINE 網路錯誤: ${e.message} (${e.code||'?'})`);
    } else {
      console.error(`❌ LINE [${status}]: ${JSON.stringify(e.response?.data||{}).slice(0,100)}`);
    }
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
    } else if (text.startsWith('一鍵下單')) {
      const pair = text.replace('一鍵下單','').trim();
      const o = pendingOrders[pair];
      if (!o) { await client.replyMessage(tok, { type: 'text', text: `⚠️ 找不到 ${pair} 訂單。` }); continue; }
      const a = o.analysis;
      const isLong = a.dir === 'long';
      const displayPair = pair.replace(/-USDT-SWAP$/, '').replace(/-USDT$/, '').replace('-', '/') + '/USDT';
      const instId = pair.endsWith('-SWAP') ? pair : pair.replace(/-USDT$/, '') + '-USDT-SWAP';
 
      // 先回覆「下單中」
      await client.replyMessage(tok, {
        type: 'text',
        text: `⏳ ${isLong ? '做多📈' : '做空📉'} 下單中...\n${displayPair} ${a.leverage}x 槓桿\n進場 ${fmt(a.entry)} | 止損 ${fmt(a.sl)}`,
      });
 
      // 自動下單到 OKX（做多/做空均支援）
      const orderResult = await placeSwapOrder(instId, a);
 
      // 推送結果
      await client.pushMessage(USER_ID, {
        type: 'text',
        text: orderResult + `\n\n` +
          `${displayPair} ${isLong ? '做多 📈' : '做空 📉'}\n` +
          `━━━━━━━━━━━━\n` +
          `💰 本金：$${a.capital}${a.doubleCapital ? ' ⚡' : ''}  ⚡ ${a.leverage}x\n` +
          `📊 倉位：$${a.positionSize} USDT\n` +
          `🟢 進場：${fmt(a.entry)}\n` +
          `🛑 止損：${fmt(a.sl)}（-$${a.slAmount}）\n` +
          `🎯 TP1：${fmt(a.tp1)}（+$${a.tp1Amount}）\n` +
          `🎯 TP2：${fmt(a.tp2)}（+$${a.tp2Amount}）\n` +
          `🎯 TP3：${fmt(a.tp3)}（+$${a.tp3Amount}）\n` +
          `💸 手續費：$${a.fee}`,
      });
      delete pendingOrders[pair];
    } else if (text.startsWith('跳過')) {
      const pair = text.replace('跳過','').trim();
      delete pendingOrders[pair];
      await client.replyMessage(tok, { type: 'text', text: `⏭️ 已跳過 ${pair.replace('-','/')}。` });
    } else if (text === '狀態') {
      const fuseStatus = dailyStats.isFused ? `🚨 已熔斷（今日虧損$${dailyStats.dailyLoss.toFixed(2)}）` : `✅ 正常（今日虧損$${dailyStats.dailyLoss.toFixed(2)}/$${DAILY_MAX_LOSS}）`;
      await client.replyMessage(tok, {
        type: 'text',
        text: `🐕 Alice 狀態\n\n` +
          `🪙 BTC趨勢：${btcTrend === 'bull' ? '📈 多頭' : btcTrend === 'bear' ? '📉 空頭' : '⚖️ 中性'}\n` +
          `🛡 熔斷狀態：${fuseStatus}\n` +
          `📊 待確認：${Object.keys(pendingOrders).length} 筆\n` +
          `🔍 監控：${WATCH_PAIRS.length} 個幣對\n` +
          `⚡ 門檻：${MIN_SCORE}分 | 止損上限 $${MAX_LOSS_USDT}\n` +
          `💰 本金：$${BASE_CAPITAL}\n\n` +
          `指令：掃描 / 幣對 / 報告 / 清除冷卻 / 重置熔斷`
      });
    } else if (text === '幣對') {
      await client.replyMessage(tok, { type: 'text', text: `📊 監控清單：\n${WATCH_PAIRS.map(p=>p.replace('-USDT-SWAP','')).join('、')}` });
    } else if (text === '指令' || text === 'help' || text === '選單' || text === '?') {
      await client.replyMessage(tok, {
        type: 'text',
        text: `🤖 Alice 指令列表\n\n` +
          `📡 掃描 — 立即掃描訊號\n` +
          `📊 狀態 — 系統狀態\n` +
          `💱 幣對 — 監控清單\n` +
          `➕ 新增 BTC — 加入監控\n` +
          `➖ 移除 BTC — 移除監控\n` +
          `✅ 一鍵下單 [幣對] — 自動下單\n` +
          `❌ 跳過 [幣對] — 略過訊號\n` +
          `🔄 重置熔斷 — 解除熔斷\n` +
          `♻️ 清除冷卻 — 重置冷卻`,
      });
    } else if (text === '報告') {
      const long_c = dailyStats.signals.filter(s=>s.dir==='long').length;
      const short_c = dailyStats.signals.filter(s=>s.dir==='short').length;
      const total = dailyStats.signals.length;
      const avgScore = total > 0 ? Math.round(dailyStats.signals.reduce((s,x)=>s+x.score,0)/total) : 0;
      await client.replyMessage(tok, {
        type: 'text',
        text: `📊 Alice 今日報告（${dailyStats.date}）\n\n` +
          `訊號總數：${total} 筆\n` +
          `做多：${long_c} 筆  做空：${short_c} 筆\n` +
          `平均評分：${avgScore} 分\n` +
          `今日虧損：$${dailyStats.dailyLoss.toFixed(2)}/$${DAILY_MAX_LOSS}\n\n` +
          (dailyStats.signals.slice(-5).reverse().map(s =>
            `${s.time} ${s.pair.replace('-USDT-SWAP','').replace('-USDT','')} ${s.dir==='long'?'📈':'📉'} ${s.score}分`
          ).join('\n') || '今日無訊號')
      });
    } else if (text === '掃描') {
      await client.replyMessage(tok, { type: 'text', text: '🔍 掃描中…' });
      scanAndPush();
    } else if (text === '清除冷卻' || text === '重置') {
      signalCooldown.clear();
      await client.replyMessage(tok, { type: 'text', text: '✅ 已清除所有幣種冷卻，下次掃描將重新評估。' });
    } else if (text === '重置熔斷') {
      dailyStats.isFused = false;
      dailyStats.dailyLoss = 0;
      await client.replyMessage(tok, { type: 'text', text: '✅ 熔斷已手動重置，恢復正常掃描。' });
    } else if (text === '熱榜' || text === '動態清單' || text === '波動榜') {
      await client.replyMessage(tok, {
        type: 'text',
        text: `📊 監控清單\n━━━━━━━━━━━━\n` +
          WATCH_PAIRS.map((p,i) => `${i+1}. ${p.replace('-USDT','')}`).join('\n') +
          `\n━━━━━━━━━━━━\n共 ${WATCH_PAIRS.length} 個幣對`,
      });
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
  pending: Object.keys(pendingOrders ?? {}).length,
  time: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
}));
 
// ══════════════════════════════════════════════
// 定時任務
// ══════════════════════════════════════════════
cron.schedule('*/3 * * * *', scanAndPush);
cron.schedule('*/15 * * * *', () => updateBtcTrend().catch(()=>{})); // BTC趨勢每15分鐘
 
// 每 30 分鐘清除超過 2 小時的過期待確認訂單
cron.schedule('*/30 * * * *', () => {
  const expireMs = 2 * 60 * 60 * 1000;
  const now = Date.now();
  let cleared = 0;
  for (const [pair, order] of Object.entries(pendingOrders)) {
    if (order.createdAt && now - order.createdAt > expireMs) {
      delete pendingOrders[pair];
      cleared++;
    }
  }
  if (cleared > 0) console.log(`🧹 清除 ${cleared} 筆過期訂單`);
});
 
// 每天 00:00 重置每日統計與熔斷
cron.schedule('0 0 * * *', () => {
  dailyStats.dailyLoss = 0;
  dailyStats.isFused   = false;
  dailyStats.signals   = [];
  dailyStats.date      = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  console.log('🔄 每日統計重置完成');
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
    if (elapsed > 5 * 60) {
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
 
  setTimeout(() => { updateTopPairs(); }, 8000);
 
  setTimeout(async () => {
    try { await scanAndPush(); } catch(e) {}
  }, 20000); // 啟動 20 秒後才開始第一次掃描
});
 
