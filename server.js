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
 
// F3：連續虧損動態門檻
function getConsecutiveBonus() {
  const n = dailyStats.consecutiveLoss || 0;
  if (n >= 5) return 20; // 暫停1小時等級
  if (n >= 3) return 10;
  if (n >= 2) return 5;
  return 0;
}
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
// A：核心幣優先掃描（這些幣的訊號最快推送）
const CORE_PAIRS = ['BTC-USDT','ETH-USDT','SOL-USDT','BNB-USDT','XRP-USDT','DOGE-USDT','ADA-USDT','AVAX-USDT'];
// B：差分掃描快取（K線收盤價 → 沒變則跳過）
const closeCache = new Map(); // pair → lastClose
const recentPushes = new Map(); // pair → { dir, entry, ts } 防重複推送
 
const isDuplicatePush = (pair, a) => {
  const last = recentPushes.get(pair);
  if (!last) return false;
  // 只看方向+時間，不看進場價（快速行情下進場價已移動）
  return last.dir === a.dir && Date.now() - last.ts < 10 * 60 * 1000;
};
const markPushed = (pair, a) => recentPushes.set(pair, { dir: a.dir, entry: a.entry, ts: Date.now() });
 
// ── 方案B：冷卻機制 ─────────────────────────────────
const signalCooldown = new Map();
const COOLDOWN_MS = 15 * 60 * 1000; // T3：縮短冷卻至 15 分鐘
const isOnCooldown = pair => { const t = signalCooldown.get(pair); return t && Date.now()-t < COOLDOWN_MS; };
const setCooldown = pair => signalCooldown.set(pair, Date.now());
 
// ── 每日績效記錄 ─────────────────────────────────────
const dailyStats = {
  signals: [],       // 所有推送的訊號
  results: [],       // 結果追蹤 { pair, dir, score, result:'win'|'loss'|'break', pnl, time }
  dailyLoss: 0,
  isFused: false,
  date: new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }),
};
const recordSignal = (pair, score, dir) => dailyStats.signals.push({
  pair, score, dir,
  time: new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei' })
});
const recordResult = (pair, dir, score, result, pnl = 0) => {
  dailyStats.results.push({ pair, dir, score, result, pnl,
    time: new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei' }) });
  // F3：連續虧損計數
  if (result === 'loss') dailyStats.consecutiveLoss = (dailyStats.consecutiveLoss || 0) + 1;
  else dailyStats.consecutiveLoss = 0; // 贏了就重置
};
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
// ══════════════════════════════════════════════
// S1：川普 Truth Social 監控
// ══════════════════════════════════════════════
let trumpCache = { lastPost: '', lastTs: 0 };
const TRUMP_BULL_KW = ['crypto','bitcoin','btc','blockchain','stablecoin','strategic reserve','buy','genius act','clarity act','freedom'];
const TRUMP_BEAR_KW = ['tariff','sanction','ban','restrict','investigate','fraud','manipulate','china','iran war','blockade'];
const TRUMP_GEO_KW  = ['iran','strait','hormuz','war','blockade','nuclear','military','attack'];
 
async function checkTrumpPosts() {
  const APIFY_KEY = process.env.APIFY_API_KEY || '';
  if (!APIFY_KEY) return; // 未設定就跳過
  try {
    // Apify Truth Social Scraper
    const url = `https://api.apify.com/v2/acts/muhammetakkurtt~truth-social-scraper/run-sync-get-dataset-items?token=${APIFY_KEY}&username=realDonaldTrump&maxItems=1`;
    const { data } = await axios.get(url, { timeout: 20000 });
    if (!data?.length) return;
    const post = data[0];
    const text = (post.content || post.text || '').toLowerCase();
    const ts   = post.createdAt || post.created_at || '';
    // 避免重複推送同一篇
    if (ts === trumpCache.lastTs || !text) return;
    trumpCache = { lastPost: text, lastTs: ts };
 
    // 判斷關鍵字類型
    const hasBull = TRUMP_BULL_KW.some(k => text.includes(k));
    const hasBear = TRUMP_BEAR_KW.some(k => text.includes(k));
    const hasGeo  = TRUMP_GEO_KW.some(k => text.includes(k));
 
    if (!hasBull && !hasBear && !hasGeo) return; // 無關貼文跳過
 
    const preview = (post.content || post.text || '').slice(0, 120);
    let msg = `🇺🇸 **川普 Truth Social 新貼文**
`;
    msg += `─────────────────
`;
    msg += `"${preview}..."
`;
    msg += `─────────────────
`;
    if (hasGeo)       msg += `🌍 地緣政治消息 → 建議暫停開倉
`;
    else if (hasBull) msg += `🟢 正面加密消息 → 做多情緒提升
`;
    else if (hasBear) msg += `🔴 負面消息 → 注意風險
`;
    msg += `⏰ ${new Date(ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`;
 
    await discordPush(msg, false, hasGeo ? 0xFF8C00 : hasBull ? 0x00E578 : 0xFF4466);
    console.log(`🇺🇸 川普新貼文偵測：${hasBull?'正面':hasBear?'負面':'地緣政治'}`);
 
    // 暫存情緒供評分使用
    trumpCache.sentiment = hasBull ? 'bull' : hasBear ? 'bear' : 'geo';
    trumpCache.sentimentTs = Date.now();
  } catch(e) { console.warn('川普監控失敗:', e.message); }
}
 
// ── I4：VIX 恐慌指數快取 ─────────────────────────────
let vixCache = { value: 15, ts: 0 };
async function updateVIX() {
  const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
  if (!FINNHUB_KEY) return;
  try {
    const { data } = await axios.get('https://finnhub.io/api/v1/quote', {
      params: { symbol: 'VIX', token: FINNHUB_KEY }, timeout: 8000
    });
    if (data?.c > 0) {
      vixCache = { value: data.c, ts: Date.now() };
      console.log(`📊 VIX 更新：${data.c.toFixed(1)}`);
      if (data.c > 35) {
        await discordPush(`🚨 **VIX 警報：${data.c.toFixed(1)}**\n極度恐慌！建議暫停做多，等待市場穩定`, false);
      }
    }
  } catch(e) { console.warn('VIX 更新失敗:', e.message); }
}
 
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
  // 縮小乘數確保止損在合理範圍（目標 0.8-1.5%）
  return atr < avg*0.7 ? 0.8 : atr > avg*1.5 ? 1.2 : 1.0;
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
 
// ── I1：Stochastic RSI ────────────────────────────────
function calcStochRSI(candles, rsiPeriod=14, stochPeriod=14) {
  if (candles.length < rsiPeriod + stochPeriod) return 0.5;
  // 計算一串 RSI 值
  const rsiArr = [];
  for (let s = 0; s <= stochPeriod; s++) {
    const slice = candles.slice(s, s + rsiPeriod + 1);
    let gains=0, losses=0;
    for (let i=0; i<slice.length-1; i++) {
      const d = slice[i].close - slice[i+1].close;
      if (d > 0) gains += d; else losses -= d;
    }
    const avgG = gains/rsiPeriod, avgL = losses/rsiPeriod;
    rsiArr.push(avgL === 0 ? 100 : 100 - 100/(1+avgG/avgL));
  }
  const maxRsi = Math.max(...rsiArr), minRsi = Math.min(...rsiArr);
  return maxRsi === minRsi ? 0.5 : (rsiArr[0] - minRsi) / (maxRsi - minRsi);
}
 
// ── I2：EMA 排列順序 ───────────────────────────────────
function calcEMAOrder(candles) {
  const ema = (period) => {
    const k=2/(period+1); let e=candles[candles.length-1].close;
    for (let i=candles.length-2; i>=0; i--) e=candles[i].close*k+e*(1-k);
    return e;
  };
  if (candles.length < 55) return 'neutral';
  const e5=ema(5), e10=ema(10), e20=ema(20), e50=ema(50);
  if (e5>e10 && e10>e20 && e20>e50) return 'bull'; // 完美多頭排列
  if (e5<e10 && e10<e20 && e20<e50) return 'bear'; // 完美空頭排列
  return 'neutral';
}
 
// ── I3：K線形態識別 ────────────────────────────────────
function detectCandlePattern(candles) {
  const c0=candles[0], c1=candles[1], c2=candles[2];
  const atr = candles.slice(0,14).reduce((s,c,i,a)=>
    i===0?s:s+Math.max(c.high-c.low,Math.abs(c.close-a[i-1].close)),0)/13||1;
  const body0   = Math.abs(c0.close-c0.open);
  const upper0  = c0.high - Math.max(c0.open,c0.close);
  const lower0  = Math.min(c0.open,c0.close) - c0.low;
  const isBull0 = c0.close > c0.open;
  const isBull1 = c1.close > c1.open;
  const body1   = Math.abs(c1.close-c1.open);
 
  const patterns = { bull:0, bear:0, neutral:false, name:'' };
 
  // 錘子線（做多）：下影線 > 實體2倍，上影線短，實體在上方
  if (!isBull0 || isBull0) { // 錘子可以是陽或陰
    if (lower0 > body0*2 && upper0 < body0*0.5 && body0 > atr*0.1) {
      patterns.bull += 12; patterns.name = '錘子線';
    }
  }
  // 流星線（做空）：上影線 > 實體2倍，下影線短
  if (upper0 > body0*2 && lower0 < body0*0.5 && body0 > atr*0.1) {
    patterns.bear += 12; patterns.name = '流星線';
  }
  // 多頭吞噬（做多）：前根陰 + 當根陽且完全覆蓋
  if (isBull0 && !isBull1 && c0.close > c1.open && c0.open < c1.close) {
    patterns.bull += 15; patterns.name = '多頭吞噬';
  }
  // 空頭吞噬（做空）：前根陽 + 當根陰且完全覆蓋
  if (!isBull0 && isBull1 && c0.close < c1.open && c0.open > c1.close) {
    patterns.bear += 15; patterns.name = '空頭吞噬';
  }
  // 十字星（中性）：實體極小
  if (body0 < atr*0.1) {
    patterns.neutral = true; patterns.name = '十字星';
  }
 
  return patterns;
}
 
// ── F1：市場結構 HH/HL/LL/LH ──────────────────────────
function detectMarketStructure(candles) {
  if (candles.length < 10) return 'neutral';
  // 找最近3個擺動高低點
  const highs = [], lows = [];
  for (let i=1; i<Math.min(15,candles.length-1); i++) {
    if (candles[i].high > candles[i-1].high && candles[i].high > candles[i+1]?.high) highs.push(candles[i].high);
    if (candles[i].low  < candles[i-1].low  && candles[i].low  < candles[i+1]?.low)  lows.push(candles[i].low);
  }
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[0] > highs[1]; // 最新高點 > 前高點 = Higher High
    const hl = lows[0]  > lows[1];  // 最新低點 > 前低點 = Higher Low
    const ll = lows[0]  < lows[1];  // Lower Low
    const lh = highs[0] < highs[1]; // Lower High
    if (hh && hl) return 'bull'; // HH + HL = 上升結構
    if (ll && lh) return 'bear'; // LL + LH = 下降結構
  }
  return 'neutral';
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
 
// ── P4：三重確認突破偵測 ─────────────────────────────
// 5m + 15m + 1H 三時框同時確認，才判定為有效突破
function detectTripleBreakout(candles1h, candles5m, candles15m) {
  const result = { bullBreak: false, bearBreak: false, strength: 0, desc: '' };
  if (!candles1h.length || !candles5m.length || !candles15m.length) return result;
 
  // ── 5m 確認：連續 3 根同向 + 成交量遞增 ──────────
  const c5 = candles5m.slice(0, 5);
  const vol5Avg = candles5m.slice(5, 15).reduce((s,c)=>s+c.vol,0) / 10 || 1;
  const bull5 = c5.slice(0,3).every(c => c.close > c.open); // 連續3根陽線
  const bear5 = c5.slice(0,3).every(c => c.close < c.open); // 連續3根陰線
  const volSpike5 = c5[0].vol / vol5Avg; // 最新根量比
 
  // ── 15m 確認：突破近15根最高/最低 + 爆量 ─────────
  const c15 = candles15m;
  const high15 = Math.max(...c15.slice(1, 16).map(c => c.high)); // 前15根最高點
  const low15  = Math.min(...c15.slice(1, 16).map(c => c.low));  // 前15根最低點
  const vol15Avg = c15.slice(1, 11).reduce((s,c)=>s+c.vol,0) / 10 || 1;
  const volSpike15 = c15[0].vol / vol15Avg;
  const bull15 = c15[0].close > high15 && volSpike15 > 2;  // 突破15根最高 + 爆量
  const bear15 = c15[0].close < low15  && volSpike15 > 2;  // 跌破15根最低 + 爆量
 
  // ── 1H 確認：MACD 方向 或 突破壓力/支撐 ─────────
  const macd1h = (() => {
    const c = candles1h.map(x => x.close).reverse();
    const ema = (d, p) => { const k=2/(p+1); let e=d[0]; for(let i=1;i<d.length;i++) e=d[i]*k+e*(1-k); return e; };
    const m = ema(c,12)-ema(c,26); return { histogram: m - ema(c.slice(-9),9) };
  })();
  const bull1h = macd1h.histogram > 0;
  const bear1h = macd1h.histogram < 0;
 
  // ── 三重確認結果 ──────────────────────────────────
  const bullScore = (bull5?1:0) + (bull15?1:0) + (bull1h?1:0);
  const bearScore = (bear5?1:0) + (bear15?1:0) + (bear1h?1:0);
 
  if (bullScore >= 2 && bull15) {
    // 至少 2/3 確認，且 15m 必須突破
    result.bullBreak = true;
    result.strength  = bullScore;
    result.volSpike  = Math.max(volSpike5, volSpike15).toFixed(1);
    result.desc = `三重確認急拉：5m${bull5?'✅':'⬜'} 15m${bull15?'✅':'⬜'} 1H${bull1h?'✅':'⬜'} 量${result.volSpike}x`;
  }
  if (bearScore >= 2 && bear15) {
    result.bearBreak = true;
    result.strength  = bearScore;
    result.volSpike  = Math.max(volSpike5, volSpike15).toFixed(1);
    result.desc = `三重確認急跌：5m${bear5?'✅':'⬜'} 15m${bear15?'✅':'⬜'} 1H${bear1h?'✅':'⬜'} 量${result.volSpike}x`;
  }
 
  return result;
}
 
// ── 做多評分 ───────────────────────────────────
function scoreLong(reasons, score, p) {
  const { last, resistance, support, rsi, macd, boll, ma10, ma20, ma50, flow5m, volRatio, isCandle_bull, bodyRatio, mtf, obvTrend, rsiDiv, isTrend, vwap, adx, signal15m, mom15m, tripleBreak, stochRsi, emaOrder, candlePat, mktStruct } = p;
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
 
  // ── I1：Stochastic RSI ────────────────────────────
  if (stochRsi !== undefined) {
    if (stochRsi < 0.2)      { reasons.push({ t: `StochRSI超賣(${stochRsi.toFixed(2)})`, ok: true  }); score += 10; }
    else if (stochRsi > 0.8) { reasons.push({ t: `StochRSI過熱(${stochRsi.toFixed(2)})`, ok: false }); score -= 10; }
  }
 
  // ── I2：EMA 排列順序 ──────────────────────────────
  if (emaOrder === 'bull')    { reasons.push({ t: 'EMA完美多頭排列✨', ok: true  }); score += 12; }
  else if (emaOrder === 'bear') { reasons.push({ t: 'EMA空頭排列',      ok: false }); score -=  8; }
 
  // ── I3：K線形態 ───────────────────────────────────
  if (candlePat.bull > 0)    { reasons.push({ t: `${candlePat.name}📈`, ok: true  }); score += candlePat.bull; }
  if (candlePat.neutral)     { reasons.push({ t: `${candlePat.name}猶豫`, ok: false }); score -= 8; }
 
  // ── F1：市場結構 HH/HL ────────────────────────────
  if (mktStruct === 'bull')  { reasons.push({ t: 'HH+HL上升結構✅', ok: true  }); score += 15; }
  else if (mktStruct === 'bear') { reasons.push({ t: 'LL+LH下降結構', ok: false }); score -= 10; }
 
  // ── F4：過熱反轉（做多但指標過熱 → 扣分）────────
  if (rsi > 80 && adx > 50)  { reasons.push({ t: `過熱反轉風險(RSI${rsi.toFixed(0)})`, ok: false }); score -= 15; }
 
  // ── P4：三重確認突破加分 ─────────────────────────
  if (tripleBreak?.bullBreak) {
    const bonus = tripleBreak.strength >= 3 ? 25 : 15;
    reasons.push({ t: `三重確認急拉🚀(${tripleBreak.strength}/3)`, ok: true }); score += bonus;
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
  const { last, support, rsi, macd, boll, ma10, ma20, ma50, flow5m, volRatio, isCandle_bull, bodyRatio, mtf, obvTrend, rsiDiv, isTrend, vwap, adx, signal15m, mom15m, tripleBreak, stochRsi, emaOrder, candlePat, mktStruct } = p;
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
 
  // ── I1：Stochastic RSI ────────────────────────────
  if (stochRsi !== undefined) {
    if (stochRsi > 0.8)      { reasons.push({ t: `StochRSI過熱(${stochRsi.toFixed(2)})`, ok: true  }); score += 10; }
    else if (stochRsi < 0.2) { reasons.push({ t: `StochRSI超賣(${stochRsi.toFixed(2)})`, ok: false }); score -= 10; }
  }
 
  // ── I2：EMA 排列順序 ──────────────────────────────
  if (emaOrder === 'bear')    { reasons.push({ t: 'EMA完美空頭排列✨', ok: true  }); score += 12; }
  else if (emaOrder === 'bull') { reasons.push({ t: 'EMA多頭排列',      ok: false }); score -=  8; }
 
  // ── I3：K線形態 ───────────────────────────────────
  if (candlePat.bear > 0)    { reasons.push({ t: `${candlePat.name}📉`, ok: true  }); score += candlePat.bear; }
  if (candlePat.neutral)     { reasons.push({ t: `${candlePat.name}猶豫`, ok: false }); score -= 8; }
 
  // ── F1：市場結構 LL/LH ────────────────────────────
  if (mktStruct === 'bear')  { reasons.push({ t: 'LL+LH下降結構✅', ok: true  }); score += 15; }
  else if (mktStruct === 'bull') { reasons.push({ t: 'HH+HL上升結構', ok: false }); score -= 10; }
 
  // ── F4：過賣反轉（做空但指標過賣 → 扣分）────────
  if (rsi < 20 && adx > 50)  { reasons.push({ t: `過賣反轉風險(RSI${rsi.toFixed(0)})`, ok: false }); score -= 15; }
 
  // ── P4：三重確認跌破加分 ─────────────────────────
  if (tripleBreak?.bearBreak) {
    const bonus = tripleBreak.strength >= 3 ? 25 : 15;
    reasons.push({ t: `三重確認急跌📉(${tripleBreak.strength}/3)`, ok: true }); score += bonus;
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
 
  // B：差分掃描 — 1H K線收盤沒變就快速返回
  // （1H K線每小時才更新，大部分輪次是重複資料）
  // 注：差分比對在 scanList 裡做，這裡只是保留空間
 
  const [candles, candles5m] = await Promise.all([
    fetchCandles(instId, '1H', 55).catch(() => []),  // 55根確保ma50計算完整
    fetchCandles5m(instId).catch(() => []),
  ]);
  const ticker = candles.length ? { last: String(candles[0].close) } : null;
  // D：補抓 Ticker 即時價（不走 rateLimiter，直接 axios）
  let livePrice = candles.length ? candles[0].close : 0;
  try {
    const swapId = instId.endsWith('-SWAP') ? instId : instId.replace(/-USDT$/, '-USDT-SWAP');
    const { data: td } = await axios.get('https://www.okx.com/api/v5/market/ticker',
      { params: { instId: swapId }, timeout: 5000 });
    const tp = parseFloat(td?.data?.[0]?.last);
    if (tp > 0) livePrice = tp;
  } catch(_) {}
 
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
  const vwap       = calcVWAP(candles);      // W2: VWAP
  const stochRsi   = calcStochRSI(candles);  // I1: Stoch RSI
  const emaOrder   = calcEMAOrder(candles);  // I2: EMA排列
  const candlePat  = detectCandlePattern(candles); // I3: K線形態
  const mktStruct  = detectMarketStructure(candles); // F1: 市場結構
  const flow5m   = calc5mFlow(candles5m);
  // ── P4：三重確認突破偵測 ─────────────────────────
  const tripleBreak = detectTripleBreakout(candles, candles5m, candles15m);
 
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
 
  if      (longPts  >= shortPts + 4) dir = 'long';  // 方向需差4分才確認
  else if (shortPts >= longPts  + 4) dir = 'short';
 
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
    score = scoreLong(reasons, score, { last, resistance, support, rsi, macd, boll, ma10, ma20, ma50, flow5m, volRatio, isCandle_bull, bodyRatio, mtf, obvTrend, rsiDiv, isTrend, vwap, adx, signal15m, mom15m, tripleBreak, stochRsi, emaOrder, candlePat, mktStruct });
  } else if (dir === 'short') {
    score = scoreShort(reasons, score, { last, resistance, support, rsi, macd, boll, ma10, ma20, ma50, flow5m, volRatio, isCandle_bull, bodyRatio, mtf, obvTrend, rsiDiv, isTrend, vwap, adx, signal15m, mom15m, tripleBreak, stochRsi, emaOrder, candlePat, mktStruct });
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
    sl = Math.min(sl, entry * (1 - 0.005)); // 最少 0.5% 距離
  } else if (dir === 'short') {
    const keyHigh = Math.max(...prev10.map(c => c.high)); // 前10根最高點
    const keyStop = keyHigh + atr * 0.3;
    const atrStop = entry   + atrSL;
    sl = Math.min(Math.min(keyStop, atrStop), entry + atrSL * 1.5);
    sl = Math.max(sl, entry * (1 + 0.005)); // 最少 0.5% 距離
  } else {
    sl = dir === 'long' ? entry - atrSL : entry + atrSL;
  }
  const slDist = Math.abs(entry - sl);
 
  // 止盈分3等分
  const tp1 = dir === 'long' ? entry + slDist * 0.8 : entry - slDist * 0.8; // TP1縮短更易達到         // 1:1
  const tp2 = dir === 'long' ? entry + slDist * 1.5 : entry - slDist * 1.5; // 1:1.8
  const tp3 = dir === 'long' ? entry + slDist * 2.5 : entry - slDist * 2.5; // 1:2.5
 
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
  const tp1Amount = (positionSize * (slDist * 0.8 / entry)).toFixed(2);
  const tp2Amount = (positionSize * (slDist * 1.5 / entry)).toFixed(2);
  const tp3Amount = (positionSize * (slDist * 2.5 / entry)).toFixed(2);
  const fee = (positionSize * 0.0005).toFixed(2);
 
  // 合約張數估算（以 1 USDT/張 粗估，實際依幣種合約面值）
  const swapSz = Math.max(1, Math.floor(positionSize / entry));
 
  return {
    score, dir, reasons, entry, sl, tp1, tp2, tp3,
    rr: '1:1.5', atr, atrMult, leverage: finalLeverage,
    capital, positionSize: positionSize.toFixed(2),
    slAmount, tp1Amount, tp2Amount, tp3Amount, fee,
    doubleCapital, flow5m, rsi, macd, swapSz,
    currentPrice: livePrice || currentPrice || entry,
    livePrice,
    adx, isTrend, mtfDir: mtf.mtfDir, obvTrend, rsiDiv, flow5m, trend4h, atr: atr, vwap, signal15m, tripleBreak,
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
    const slPct   = a.entry > 0 ? ((Math.abs(a.entry-a.sl)/a.entry)*100).toFixed(2) : '0';
    const rrRatio  = a.slAmount > 0 ? (a.tp3Amount/a.slAmount).toFixed(1) : '—';
    const t4h      = a.trend4h==='bull'?'📈多頭':a.trend4h==='bear'?'📉空頭':'➡️中性';
    const tBtc     = btcTrend==='bull'?'📈多頭':btcTrend==='bear'?'📉空頭':'➡️中性';
    const slArrow  = isLong ? '🔻' : '🔺';
    return (
      `${badge} **${sym}** ${dir}  評分 **${a.score}**/100  ${(()=>{ const h=parseInt(new Date().toLocaleString('en-US',{timeZone:'Asia/Taipei',hour:'numeric',hour12:false})); return h>=21||h<5?'🇺🇸美國盤':h>=15?'🇪🇺歐洲盤':h>=8?'🌏亞洲盤':'🌙深夜'; })()}
` +
      `RSI **${(a.rsi||0).toFixed(0)}** · ADX **${(a.adx||0).toFixed(0)}** · ${a.isTrend?'📊趨勢':'〰震盪'} · ${a.vwapPos||''} · 15m${a.signal15m==='bull'?' 📈':a.signal15m==='bear'?' 📉':' ➡️'}
` +
      `4H ${t4h} · BTC ${tBtc}
` +
      `──────────────
` +
      `💹 現價：\`${fmt(price)}\`
` +
      `🟢 進場：\`${fmt(a.livePrice||a.entry||0)}\`  ⚡${a.leverage||1}x  盈虧比 **1:${rrRatio}**
` +
      (a.livePrice && a.entry && Math.abs(a.livePrice-a.entry)/a.entry > 0.005 ? `⚠️ 價格偏差 ${((Math.abs(a.livePrice-a.entry)/a.entry)*100).toFixed(2)}% 請確認進場\n` : '') +
      `${slArrow} 止損：\`${fmt(a.sl||0)}\`（-${slPct}%，最虧 **-$${a.slAmount||0}**）
` +
      `──────────────
` +
      `🎯 TP1：\`${fmt(a.tp1||0)}\`（**+$${a.tp1Amount||0}**）
` +
      `🎯 TP2：\`${fmt(a.tp2||0)}\`（**+$${a.tp2Amount||0}**）
` +
      `🎯 TP3：\`${fmt(a.tp3||0)}\`（**+$${a.tp3Amount||0}**）
` +
      `──────────────
` +
      `✅ ${good}
` +
      (a.tripleBreak?.bullBreak || a.tripleBreak?.bearBreak ? `🚀 ${a.tripleBreak.desc}
` : '') +
      (bad ? `❌ ${bad}\n` : '') +
      (a.rsiDiv && a.rsiDiv !== 'none' ? `🔔 RSI${a.rsiDiv==='bullish'?'底背離':'頂背離'} · ` : '') +
      (a.obvTrend === 'up' ? 'OBV↑ ' : a.obvTrend === 'down' ? 'OBV↓ ' : '') +
      ((a.rsiDiv && a.rsiDiv !== 'none') || a.obvTrend !== 'flat' ? '\n' : '') +
      `──────────────\n` +
      `💰 本金 **$${a.capital||100}** · 倉位 **$${a.positionSize||0}** · 手續費 $${a.fee||0}\n` +
      `📌 Alice Bot`
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
 
 
 
  const _tw = new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei' });
  console.log(`[${_tw}] 掃描 ${WATCH_PAIRS.length} 個幣對（核心${CORE_PAIRS.filter(p=>WATCH_PAIRS.includes(p)).length}+其他${WATCH_PAIRS.filter(p=>!CORE_PAIRS.includes(p)).length}）BTC:${btcTrend}`);
 
  // A+B：優先掃描核心幣 + 差分掃描
  const _coreList  = WATCH_PAIRS.filter(p => CORE_PAIRS.includes(p));
  const _otherList = WATCH_PAIRS.filter(p => !CORE_PAIRS.includes(p));
 
  async function _scanList(pairs) {
    const _res = [];
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      let r = await analyze(pair).then(a => {
        if (a?.entry) closeCache.set(pair, a.entry);
        return { pair, a };
      }).catch(e => ({ status:'rejected', reason:e }));
      if (r.status === 'rejected' || !r.a) {
        await new Promise(x => setTimeout(x, 1000));
        r = await analyze(pair).then(a => ({ pair, a })).catch(e => ({ status:'rejected', reason:e }));
      }
      _res.push({ status:'fulfilled', value: r });
      if (i < pairs.length - 1) await new Promise(x => setTimeout(x, 600));
    }
    return _res;
  }
 
  const _coreResults  = await _scanList(_coreList);
  console.log(`✅ 核心幣 ${_coreList.length} 個掃完`);
  const _otherResults = await _scanList(_otherList);
  const results = [..._coreResults, ..._otherResults];
 
  // ── 收集所有有效訊號，每輪只推送最高分一個 ────────
  const validSignals = [];
 
  for (const res of results) {
    if (res.status === 'rejected') continue;
    const { pair, a } = res.value;
    if (!a || a.dir === 'neutral') continue;
    if (a.score < MIN_SCORE) {
      if (a.score >= 60) dailyStats.potential = [...(dailyStats.potential||[]), { pair, score: a.score, dir: a.dir }];
      continue;
    }
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
    // S4：加密新聞情緒加成（30分鐘內有效）
    const pairNews = newsCache.pairSentiment?.[pair];
    if (pairNews && Date.now() - pairNews.ts < 30 * 60 * 1000) {
      if (pairNews.bull && a.dir === 'long')   a.score = Math.min(100, a.score + 8);
      if (!pairNews.bull && a.dir === 'short') a.score = Math.min(100, a.score + 8);
    }
 
    // S2：經濟日曆過濾
    const ecoEvent = isNearEconomicEvent();
    if (ecoEvent) {
      if (ecoEvent.before && ecoEvent.ev.impact === 'high') {
        console.log(`📅 ${pair} 重大數據前${ecoEvent.diff}分（${ecoEvent.ev.name}），跳過`); continue;
      }
      if (!ecoEvent.before && ecoEvent.ev.impact === 'high' && a.score < MIN_SCORE + 5) {
        console.log(`📅 ${pair} 數據剛發布${-ecoEvent.diff}分，等待確認，跳過`); continue;
      }
    }
 
    // S1：川普情緒加成（30分鐘內有效）
    if (trumpCache.sentimentTs && Date.now() - trumpCache.sentimentTs < 30 * 60 * 1000) {
      if (trumpCache.sentiment === 'bull' && a.dir === 'long')  a.score = Math.min(100, a.score + 10);
      if (trumpCache.sentiment === 'bear' && a.dir === 'short') a.score = Math.min(100, a.score + 10);
      if (trumpCache.sentiment === 'geo') { console.log(`🌍 ${pair} 地緣政治警戒，跳過`); continue; }
    }
 
    // 方向平衡過濾（防止全部同一方向）
    // BTC 空頭 → 多單需要 85 分（已有），空單仍正常
    // BTC 多頭 → 空單需要 85 分（已有），多單仍正常
    const todaySigs = dailyStats.signals;
    if (todaySigs.length >= 10) {
      const todayShorts = todaySigs.filter(s => s.dir === 'short').length;
      const shortRatio  = todayShorts / todaySigs.length;
      const todayLongs  = todaySigs.filter(s => s.dir === 'long').length;
      const longRatio   = todayLongs / todaySigs.length;
      // 做空比例 > 80% → 做空訊號額外需要 +8 分
      if (shortRatio > 0.7 && a.dir === 'short' && a.score < MIN_SCORE + 10) {
        console.log(`⚖️ ${pair} 今日做空比例過高(${Math.round(shortRatio*100)}%)，跳過`); continue;
      }
      // 做多比例 > 80% → 做多訊號額外需要 +8 分
      if (longRatio > 0.7 && a.dir === 'long' && a.score < MIN_SCORE + 10) {
        console.log(`⚖️ ${pair} 今日做多比例過高(${Math.round(longRatio*100)}%)，跳過`); continue;
      }
    }
 
    // I4：VIX 市場恐慌過濾
    const vix = vixCache.value;
    if (vix > 35 && a.dir === 'long') { console.log(`🚨 ${pair} VIX=${vix.toFixed(1)}極度恐慌，否決做多`); continue; }
    if (vix > 25 && vix <= 35 && a.score < MIN_SCORE + 5) { console.log(`⚠️ ${pair} VIX=${vix.toFixed(1)}市場謹慎，跳過`); continue; }
 
    // F3：連續虧損動態門檻
    const consecBonus = getConsecutiveBonus();
    if (consecBonus >= 20 && a.score < MIN_SCORE + 20) { console.log(`🛑 ${pair} 連虧熔斷，跳過`); continue; }
    else if (consecBonus > 0 && a.score < MIN_SCORE + consecBonus) { console.log(`⚠️ ${pair} 連虧保守門檻(+${consecBonus})，跳過`); continue; }
 
    // ── W4：時段動態門檻 ─────────────────────────────
    const twHour = new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hour12: false });
    const h = parseInt(twHour);
    let sessionMinScore = MIN_SCORE;
    if (h >= 8 && h < 16) {
      sessionMinScore = MIN_SCORE + 5;
      if (a.score < sessionMinScore) { console.log(`🌏 ${pair} 亞洲盤門檻(${sessionMinScore})未達，跳過`); continue; }
    } else if (h === 21 && new Date().getMinutes() < 30) {
      // F2：美國開盤前15分（21:00-21:30）假突破最多
      sessionMinScore = MIN_SCORE + 8;
      if (a.score < sessionMinScore) { console.log(`⚠️ ${pair} 美開盤前門檻(${sessionMinScore})未達，跳過`); continue; }
    } else if (h >= 21 || h < 5) {
      sessionMinScore = Math.max(MIN_SCORE - 3, 60);
    } else if (h === 4 && new Date().getMinutes() < 30) {
      // F2：美國收盤前（04:00-04:30）
      sessionMinScore = MIN_SCORE + 5;
      if (a.score < sessionMinScore) { console.log(`⚠️ ${pair} 美收盤前門檻(${sessionMinScore})未達，跳過`); continue; }
    }
    // （歐洲盤 16-21 使用標準門檻）
 
    // ADX 極弱否決（ADX < 15 趨勢完全不可信）
    if ((a.adx || 0) < 15 && !a.tripleBreak?.bullBreak && !a.tripleBreak?.bearBreak) {
      console.log(`🚫 ${pair} ADX極弱(${(a.adx||0).toFixed(0)})，否決`); continue;
    }
 
    // D1：RSI 極端值（做多時過熱，做空時過賣）
    const rsi = a.rsi || 50;
    if (a.dir === 'long'  && rsi > 75) { console.log(`🚫 ${pair} RSI過熱(${rsi.toFixed(0)})，否決做多`); continue; }
    if (a.dir === 'short' && rsi < 25) { console.log(`🚫 ${pair} RSI過賣(${rsi.toFixed(0)})，否決做空`); continue; }
    // D2：成交量極度萎縮（volSurge < 0.5，假突破風險極高）
    if (a.flow5m?.volSurge < 0.5) { console.log(`🚫 ${pair} 成交量極萎縮(${a.flow5m.volSurge.toFixed(2)}x)，否決`); continue; }
    // D3：止損距離過大（slDist / entry > 3%，風險過高）
    if (a.entry > 0 && slDist / a.entry > 0.02) { console.log(`🚫 ${pair} 止損過大(${(slDist/a.entry*100).toFixed(1)}%)，否決`); continue; }
    // D4：止損距離過小（slDist / entry < 0.5%，容易被掃）
    if (a.entry > 0 && slDist / a.entry < 0.005) { console.log(`🚫 ${pair} 止損過近(${(slDist/a.entry*100).toFixed(2)}%)，否決`); continue; }
 
    // ── 方案 C：波動率過濾（ATR% 甜蜜區間）──────────
    const atrPct = a.entry > 0 ? (a.atr || 0) / a.entry : 0;
    if (atrPct < 0.003) { console.log(`🌙 ${pair} 波動率過低(${(atrPct*100).toFixed(2)}%)，盤整中跳過`); continue; }
    if (atrPct > 0.04)  { console.log(`⚡ ${pair} 波動率過高(${(atrPct*100).toFixed(2)}%)，極端行情跳過`); continue; }
 
    // 強訊號（≥85）跳過冷卻限制
    if (isOnCooldown(pair) && a.score < 85) continue;
    // 量能萎縮否決（reasons 裡有量能萎縮就跳過）
    if (a.reasons?.some(r => r.t?.includes('量能萎縮') && !r.ok)) {
      console.log(`🚫 ${pair} 量能萎縮否決`); continue;
    }
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
  // 只有強訊號全推；中訊號只在 BTC 非單邊行情才推（減少雜訊）
  const mediumAllowed = btcTrend === 'neutral' ? medium.slice(0, 1) : [];
  const toSend = [...strong, ...mediumAllowed];
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
    const isTriple = a.tripleBreak?.bullBreak || a.tripleBreak?.bearBreak;
    const color = isTriple ? 0xFF8C00  // 橙色=三重確認突破
      : a.dir === 'long'
        ? (isStrong ? 0x00E578 : 0x00A854)
        : (isStrong ? 0xFF4466 : 0xCC2244);
    const ok = await discordPush(msg, true, color);
    if (ok) {
      markPushed(pair, a);
      setCooldown(pair);
      recordSignal(pair, a.score, a.dir);
      // S3：加入追蹤清單
      trackedSignals.set(pair, { entry:a.entry, sl:a.sl, tp1:a.tp1, tp2:a.tp2, tp3:a.tp3, dir:a.dir, ts:Date.now() });
      console.log(`✅ 推送完成：${pair} [連虧:${dailyStats.consecutiveLoss||0}]`);
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
 
    } else if (text.startsWith('今日數據 ') || text.startsWith('數據 ')) {
      // 手動新增今日臨時經濟事件（格式：今日數據 CPI 或 今日數據 CPI 21:30）
      const input = text.replace(/^(今日數據|數據)\s+/, '').trim();
      const parts = input.split(/\s+/);
      const name = parts[0] || 'CPI';
      const timePart = parts[1] || '21:30';
      const [hStr, mStr] = timePart.split(':');
      const hour = parseInt(hStr) || 21;
      const minute = parseInt(mStr) || 30;
      // 加入今日臨時事件（只對今天有效，不影響 ECONOMIC_EVENTS）
      const now = new Date();
      const tpe = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      ECONOMIC_EVENTS.push({ name: `今日 ${name}`, hour, minute, dayOfWeek: tpe.getDay(), impact: 'high', temp: true });
      // 清除明天過期的臨時事件
      setTimeout(() => {
        const idx = ECONOMIC_EVENTS.findIndex(e => e.temp && e.name.startsWith('今日'));
        if (idx !== -1) ECONOMIC_EVENTS.splice(idx, 1);
      }, 24 * 60 * 60 * 1000);
      await client.replyMessage(tok, {
        type: 'text',
        text: `✅ 今日臨時數據已加入\n📅 ${name} ${hour}:${String(minute).padStart(2,'0')}\n⚠️ 發布前後30分鐘將暫停訊號`,
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
// S2：經濟日曆（高影響力事件過濾）
// ══════════════════════════════════════════════
// 固定重大事件時間（台北時間，每月更新）
// CPI 通常每月第2-3週，非農第1個週五，Fed 每6週
const ECONOMIC_EVENTS = [
  // dayOfWeek: -1 = 每月特定日，需手動觸發（不自動推送）
  // dayOfWeek: 0-6 = 固定星期，每週或每月同一天
  { name: '美國非農就業',  hour: 21, minute: 30, dayOfWeek: 5, impact: 'high' },   // 每月第1個週五
  { name: 'Fed 利率決議',  hour: 2,  minute: 0,  dayOfWeek: 3, impact: 'high' },   // 每6週週三
  // 以下為每月不固定，設 -1 不自動推（避免每天誤推）
  { name: '美國 CPI',      hour: 21, minute: 30, dayOfWeek: -1, impact: 'high' },
  { name: '美國 PCE',      hour: 21, minute: 30, dayOfWeek: -1, impact: 'medium' },
  { name: '美國 GDP',      hour: 21, minute: 30, dayOfWeek: -1, impact: 'medium' },
  { name: '美國零售銷售',   hour: 21, minute: 30, dayOfWeek: -1, impact: 'medium' },
];
 
function isNearEconomicEvent() {
  const now = new Date();
  const tpe = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const h = tpe.getHours(), m = tpe.getMinutes(), dow = tpe.getDay();
  const totalMin = h * 60 + m;
 
  for (const ev of ECONOMIC_EVENTS) {
    if (ev.dayOfWeek !== -1 && ev.dayOfWeek !== dow) continue;
    const evMin = ev.hour * 60 + ev.minute;
    const diff  = evMin - totalMin; // 正數=未發布，負數=已發布
    if (diff > 0 && diff <= 30) return { before: true,  ev, diff }; // 發布前30分
    if (diff < 0 && diff >= -15) return { before: false, ev, diff }; // 發布後15分
  }
  return null;
}
 
async function sendDailyEconomicCalendar() {
  // 每天早上9點推送今日重要事件
  // 只推送今天 dayOfWeek 符合的事件
  const now  = new Date();
  const tpe  = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const dow  = tpe.getDay(); // 0=日,1=一,...,6=六
  const today = now.toLocaleDateString('zh-TW', { timeZone:'Asia/Taipei', weekday:'short' });
 
  // 只保留今天星期幾對應的事件
  // dayOfWeek: -1 代表「每月固定，需人工確認」
  // 每月只有特定幾天才有 CPI/PCE/GDP 等，不能每天都推
  // 解法：只在特定條件下才推
  //   非農 → 只在週五推
  //   其他 → dayOfWeek: -1 的事件只在「有已知實際日期」時推
  // 目前做法：只推 dayOfWeek 明確符合今天星期的事件（避免誤推）
  const todayEvents = ECONOMIC_EVENTS.filter(e => {
    if (e.dayOfWeek === -1) return false; // 不明確日期的不自動推
    return e.dayOfWeek === dow;
  });
 
  if (!todayEvents.length) {
    console.log('📅 今日無預設重要經濟數據');
    return;
  }
 
  const list = todayEvents.map(e =>
    `• ${e.name} ${e.hour}:${String(e.minute).padStart(2,'0')} ${e.impact==='high'?'🔴':'🟡'}`
  ).join('\n');
 
  await discordPush(
    `📅 **今日重要經濟數據** (${today})\n─────────────────\n${list}\n─────────────────\n🔴=高影響 · 建議發布前後30分謹慎開倉`,
    false
  ).catch(()=>{});
}
 
// ══════════════════════════════════════════════
// S3：動態止盈追蹤（追蹤訊號後推送止損調整建議）
// ══════════════════════════════════════════════
const trackedSignals = new Map(); // pair → { entry, sl, tp1, tp2, tp3, dir, ts }
 
async function checkTrackedSignals() {
  if (!trackedSignals.size) return;
  const now = Date.now();
  for (const [pair, sig] of trackedSignals.entries()) {
    const sym = pair.replace('-USDT','');
    // 超過4小時 → 保本並移除
    if (now - sig.ts > 8 * 60 * 60 * 1000) { // 延長至8小時
      if (!sig.tp1Hit && !sig.slHit) recordResult(pair, sig.dir, sig.score||70, 'break', 0);
      trackedSignals.delete(pair); continue;
    }
    try {
      const candles = await fetchCached15m(pair).catch(() => []);
      if (!candles.length) continue;
      const price = candles[0].close;
 
      // ── 止損觸及 → 敗 ──────────────────────
      if (!sig.slHit && !sig.tp1Hit) {
        const slHit = sig.dir==='long' ? price<=sig.sl : price>=sig.sl;
        if (slHit) {
          sig.slHit = true;
          recordResult(pair, sig.dir, sig.score||70, 'loss', -(sig.slAmount||0));
          await discordPush(
            `❌ **${sym} ${sig.dir==='long'?'做多':'做空'} 止損觸及**\n現價：\`${fmt(price)}\`  止損：\`${fmt(sig.sl)}\`\n虧損：-$${sig.slAmount||0}`,
            false, 0xFF4466
          );
          trackedSignals.delete(pair); continue;
        }
      }
 
      // ── TP1 達到 → 記錄勝 ─────────────────
      if (!sig.tp1Hit) {
        const tp1Hit = sig.dir==='long' ? price>=sig.tp1 : price<=sig.tp1;
        if (tp1Hit) {
          sig.tp1Hit = true;
          recordResult(pair, sig.dir, sig.score||70, 'win', +(sig.tp1Amount||0));
          await discordPush(
            `🎯 **${sym} ${sig.dir==='long'?'做多':'做空'} TP1 達到！**\n現價：\`${fmt(price)}\`  +$${sig.tp1Amount||0}\n💡 建議止損移至進場價（保本）\n剩餘：TP2 \`${fmt(sig.tp2)}\` / TP3 \`${fmt(sig.tp3)}\``,
            false, 0x00E578
          );
        }
      }
      // ── TP2 達到 ──────────────────────────
      if (sig.tp1Hit && !sig.tp2Hit) {
        const tp2Hit = sig.dir==='long' ? price>=sig.tp2 : price<=sig.tp2;
        if (tp2Hit) {
          sig.tp2Hit = true;
          await discordPush(`🎯 **${sym} TP2 達到！** +$${sig.tp2Amount||0}\n💡 止損移至 TP1（鎖利）`, false, 0x00E578);
        }
      }
      // ── TP3 達到 → 完全勝 ─────────────────
      if (sig.tp2Hit && !sig.tp3Hit) {
        const tp3Hit = sig.dir==='long' ? price>=sig.tp3 : price<=sig.tp3;
        if (tp3Hit) {
          sig.tp3Hit = true;
          await discordPush(`🏆 **${sym} TP3 全達！** +$${sig.tp3Amount||0} 🎉`, false, 0xFFD700);
          trackedSignals.delete(pair);
        }
      }
    } catch(e) {}
  }
}
 
// ══════════════════════════════════════════════
// S4：加密新聞即時偵測（cryptocurrency.cv 免費）
// ══════════════════════════════════════════════
let newsCache = { lastId: '', ts: 0 };
const NEWS_BULL_KW = ['etf approved','institutional','buy','bullish','adopt','reserve','partnership','launch','upgrade'];
const NEWS_BEAR_KW = ['hack','exploit','scam','ban','sec','lawsuit','crash','bankruptcy','fraud','shutdown'];
const NEWS_COIN_MAP = { 'bitcoin':'BTC-USDT','ethereum':'ETH-USDT','solana':'SOL-USDT','bnb':'BNB-USDT','xrp':'XRP-USDT' };
 
async function checkCryptoNews() {
  try {
    const { data } = await axios.get('https://cryptocurrency.cv/api/v2/news?limit=5&language=en', { timeout: 10000 });
    const articles = data?.articles || data?.data || [];
    if (!articles.length) return;
    const latest = articles[0];
    const newsId = latest.id || latest.url || latest.title;
    if (newsId === newsCache.lastId) return; // 沒有新消息
    newsCache = { lastId: newsId, ts: Date.now() };
 
    const title = (latest.title || '').toLowerCase();
    const hasBull = NEWS_BULL_KW.some(k => title.includes(k));
    const hasBear = NEWS_BEAR_KW.some(k => title.includes(k));
    if (!hasBull && !hasBear) return;
 
    // 找相關幣種
    const relatedPair = Object.entries(NEWS_COIN_MAP).find(([k]) => title.includes(k))?.[1] || '';
 
    const msg = `📰 **加密新聞快訊**
─────────────────
${latest.title}
─────────────────
${hasBull ? '🟢 正面消息' : '🔴 負面消息'}${relatedPair ? ` · 相關：${relatedPair.replace('-USDT','')}` : ''}
來源：${latest.source || latest.sourceName || 'CryptoCurrency.cv'}`;
    await discordPush(msg, false, hasBull ? 0x00A854 : 0xCC2244);
 
    // 暫存消息情緒（30分鐘有效）
    if (relatedPair) {
      newsCache.pairSentiment = newsCache.pairSentiment || {};
      newsCache.pairSentiment[relatedPair] = { bull: hasBull, ts: Date.now() };
    }
    console.log(`📰 新聞偵測：${hasBull?'正面':'負面'} - ${latest.title?.slice(0,50)}`);
  } catch(e) { console.warn('加密新聞檢查失敗:', e.message); }
}
 
// ══════════════════════════════════════════════
// 定時任務
// ══════════════════════════════════════════════
cron.schedule('*/1 * * * *', scanAndPush); // A+B 後核心幣 ~15秒，整輪 ~35秒，1分鐘夠用
cron.schedule('0 9 * * *', () => sendDailyEconomicCalendar().catch(()=>{}), { timezone: 'Asia/Taipei' }); // S2：每日日曆
cron.schedule('*/15 * * * *', () => { updateBtcTrend().catch(()=>{}); updateVIX().catch(()=>{}); }); // BTC趨勢+VIX每15分鐘
cron.schedule('*/10 * * * *', () => checkTrumpPosts().catch(()=>{})); // S1：川普監控每10分鐘
cron.schedule('*/5 * * * *',  () => checkTrackedSignals().catch(()=>{})); // S3：止盈追蹤每5分鐘
cron.schedule('*/10 * * * *', () => checkCryptoNews().catch(()=>{}));     // S4：加密新聞每10分鐘
 
// 每6小時清理過期快取（防止記憶體洩漏）
cron.schedule('0 */6 * * *', () => {
  const now = Date.now();
  let cleared = 0;
  for (const [k, v] of cache4h.entries())      { if (now - v.ts > TTL_4H  * 2) { cache4h.delete(k);      cleared++; } }
  for (const [k, v] of cache15m.entries())     { if (now - v.ts > TTL_15M * 2) { cache15m.delete(k);     cleared++; } }
  for (const [k, v] of fundRateCache.entries()){ if (now - v.ts > 15*60*1000*2){ fundRateCache.delete(k); cleared++; } }
  if (cleared > 0) console.log(`🧹 清理過期快取 ${cleared} 項`);
});
 
// 每天 00:00 重置每日統計與熔斷
// 每天 20:00 推送今日績效摘要
cron.schedule('0 20 * * *', async () => {
  try {
    const sigs    = dailyStats.signals;
    const results = dailyStats.results || [];
    if (!sigs.length) return;
 
    // 勝率計算
    const wins   = results.filter(r => r.result === 'win').length;
    const losses = results.filter(r => r.result === 'loss').length;
    const breaks = results.filter(r => r.result === 'break').length;
    const total  = wins + losses + breaks;
    const winRate = total > 0 ? Math.round(wins / total * 100) : null;
    const totalPnl = results.reduce((s, r) => s + (r.pnl || 0), 0);
 
    // 按評分分組的勝率
    const highScoreWins = results.filter(r => r.score >= 80 && r.result === 'win').length;
    const highScoreTotal = results.filter(r => r.score >= 80).length;
    const highWinRate = highScoreTotal > 0 ? Math.round(highScoreWins/highScoreTotal*100) : null;
 
    const strong   = sigs.filter(s => s.score >= 80).length;
    const mid      = sigs.filter(s => s.score >= 70 && s.score < 80).length;
    const longs    = sigs.filter(s => s.dir === 'long').length;
    const shorts   = sigs.filter(s => s.dir === 'short').length;
    const avgScore = Math.round(sigs.reduce((s,x) => s+x.score, 0) / sigs.length);
    const topPairs = Object.entries(sigs.reduce((acc,s) => {
      acc[s.pair] = (acc[s.pair]||0)+1; return acc;
    }, {})).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([p,n])=>`${p.replace('-USDT','')}(${n})`).join(' ');
 
    const winRateBar = winRate !== null
      ? `${'🟩'.repeat(Math.round(winRate/10))}${'⬜'.repeat(10-Math.round(winRate/10))} ${winRate}%`
      : '追蹤中...';
 
    const summary =
      `📊 **今日訊號摘要** ${dailyStats.date}\n` +
      `──────────────\n` +
      `總推送：**${sigs.length}** 個（🔴強${strong} 🟡中${mid}）\n` +
      `做多：${longs} · 做空：${shorts} · 平均分：**${avgScore}**\n` +
      `──────────────\n` +
      (total > 0 ?
        `🏆 **今日勝率**\n${winRateBar}\n` +
        `✅ 勝 ${wins} · ❌ 敗 ${losses} · ➡️ 平 ${breaks}\n` +
        `💰 今日損益：${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}\n` +
        (highWinRate !== null ? `📈 強訊號(≥80分)勝率：**${highWinRate}%**\n` : '') :
        `⏳ 今日追蹤中（${trackedSignals.size}個進行中）\n`
      ) +
      `──────────────\n` +
      `最多幣種：${topPairs}\n` +
      `今日虧損：$${dailyStats.dailyLoss.toFixed(2)}/$${DAILY_MAX_LOSS}`;
    await discordPush(summary, false);
    console.log('📊 每日摘要已推送');
  } catch(e) { console.error('摘要推送失敗:', e.message); }
}, { timezone: 'Asia/Taipei' });
 
cron.schedule('0 0 * * *', () => {
  dailyStats.dailyLoss = 0;
  dailyStats.isFused   = false;
  dailyStats.signals         = [];
  dailyStats.results         = [];  // 清空結果追蹤
  dailyStats.potential       = [];
  dailyStats.consecutiveLoss = 0;
  dailyStats.date      = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  recentPushes.clear();   // 清除跨日去重快取
  signalCooldown.clear();  // 清除冷卻
  cache4h.clear();    // 清除 4H K線快取
  cache15m.clear();   // 清除 15m K線快取
  closeCache.clear(); // 清除差分快取
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
    try { await updateBtcTrend(); await updateVIX(); await checkCryptoNews(); } catch(e) {}
  }, 2000);
 
  setTimeout(() => console.log(`📊 監控：${WATCH_PAIRS.map(p=>p.replace('-USDT','')).join(' ')}`), 8000);
 
  setTimeout(async () => {
    try { await scanAndPush(); } catch(e) {}
  }, 20000); // 啟動 20 秒後才開始第一次掃描
});
