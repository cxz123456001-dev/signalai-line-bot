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
const MIN_SCORE       = parseInt(process.env.MIN_SCORE     || '65');
const MAX_LOSS_USDT   = parseFloat(process.env.MAX_LOSS_USDT  || '20');
const BASE_CAPITAL    = parseFloat(process.env.BASE_CAPITAL   || '100');
const MAX_LOSS_PCT    = parseFloat(process.env.MAX_LOSS_PCT   || '0.05');
const DAILY_MAX_LOSS  = parseFloat(process.env.DAILY_MAX_LOSS || '50');  // 每日最大虧損熔斷
const MIN_VOL_USDT    = parseFloat(process.env.MIN_VOL_USDT   || '5000000'); // 流動性門檻 500萬
const FUND_RATE_LIMIT = parseFloat(process.env.FUND_RATE_LIMIT|| '0.0008'); // 資金費率極值
const OI_SURGE_RATIO  = parseFloat(process.env.OI_SURGE_RATIO  || '1.3');   // OI 暴增倍數門檻
const LS_RATIO_BULL   = parseFloat(process.env.LS_RATIO_BULL   || '0.60');  // 大戶多空比多頭門檻
const LS_RATIO_BEAR   = parseFloat(process.env.LS_RATIO_BEAR   || '0.40');  // 大戶多空比空頭門檻
 
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
 
// ── 核心必選幣對（流動性佳、技術指標可靠）──────────
const FIXED_PAIRS = [
  'BTC-USDT','ETH-USDT','SOL-USDT',
  'XRP-USDT','DOGE-USDT','ADA-USDT',
];
 
// ── 動態篩選設定 ─────────────────────────────────────
const DYN_TOP_N       = parseInt(process.env.DYN_TOP_N        || '20'); // 動態最多幾個
const DYN_MIN_VOL     = parseFloat(process.env.DYN_MIN_VOL    || '30000000'); // 最低 3000 萬 USDT
const DYN_ATR_MULT    = parseFloat(process.env.DYN_ATR_MULT   || '1.3');  // ATR 需 > 均值 1.3x
const DYN_PRICE_CHG   = parseFloat(process.env.DYN_PRICE_CHG  || '0.03'); // 24h 漲跌幅下限 3%
const DYN_PRICE_MAX   = parseFloat(process.env.DYN_PRICE_MAX  || '0.15'); // 24h 漲跌幅上限 15%
 
// 動態幣種清單快取
let dynamicPairs = [];
let dynamicPairsUpdatedAt = 0;
let dynamicPairsDetail = []; // 篩選結果詳細資訊（供報告用）
 
let WATCH_PAIRS = [...FIXED_PAIRS];
const pendingOrders = {};
 
// ── 方案B：冷卻機制 ─────────────────────────────────
const signalCooldown = new Map();
const COOLDOWN_MS = 30 * 60 * 1000;
function isOnCooldown(pair) {
  const last = signalCooldown.get(pair);
  return last && (Date.now() - last) < COOLDOWN_MS;
}
function setCooldown(pair) { signalCooldown.set(pair, Date.now()); }
 
// ── 每日績效記錄 ─────────────────────────────────────
const dailyStats = {
  wins: 0, losses: 0, totalPnl: 0, signals: [],
  dailyLoss: 0,           // 今日已虧損（熔斷用）
  isFused: false,         // 今日熔斷旗標
  date: new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }),
};
function recordSignal(pair, score, dir) {
  dailyStats.signals.push({ pair, score, dir, time: new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei' }) });
}
function addDailyLoss(amount) {
  dailyStats.dailyLoss += amount;
  if (!dailyStats.isFused && dailyStats.dailyLoss >= DAILY_MAX_LOSS) {
    dailyStats.isFused = true;
    console.warn(`🔴 每日虧損熔斷觸發！今日虧損 $${dailyStats.dailyLoss.toFixed(2)}，停止交易`);
    client.pushMessage(USER_ID, {
      type: 'text',
      text: `🚨 熔斷警告
 
今日累計虧損已達 $${dailyStats.dailyLoss.toFixed(2)}（上限 $${DAILY_MAX_LOSS}）
 
⛔ 今日剩餘時間停止推送訊號
明日 08:00 自動重置`,
    }).catch(()=>{});
  }
}
 
// ── BTC 市場情緒緩存 ─────────────────────────────────
let btcTrend = 'neutral'; // 'bull' | 'bear' | 'neutral'
let btcTrendUpdatedAt = 0;
async function updateBtcTrend() {
  try {
    const candles = await fetchCandles('BTC-USDT-SWAP', '1H', 25);
    const ma20 = candles.slice(0, 20).reduce((s, c) => s + c.close, 0) / 20;
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
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.rate;
  try {
    const { data } = await axios.get('https://www.okx.com/api/v5/public/funding-rate', {
      params: { instId }
    });
    const rate = parseFloat(data.data[0]?.fundingRate || 0);
    fundRateCache.set(instId, { rate, ts: Date.now() });
    return rate;
  } catch (e) { return 0; }
}
 
// ── 24h 交易量快取（流動性過濾）───────────────────────
const volCache = new Map(); // instId → { vol24h, ts }
async function getVol24h(instId) {
  const cached = volCache.get(instId);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached.vol24h;
  try {
    const { data } = await axios.get('https://www.okx.com/api/v5/market/ticker', {
      params: { instId }
    });
    const vol = parseFloat(data.data[0]?.volCcy24h || 0);
    volCache.set(instId, { vol24h: vol, ts: Date.now() });
    return vol;
  } catch (e) { return Infinity; } // 查不到視為通過
}
 
// ── 未平倉量 OI（Open Interest）────────────────────────
const oiCache = new Map(); // instId → { oi, prevOi, ts }
async function getOIData(instId) {
  const cached = oiCache.get(instId);
  if (cached && Date.now() - cached.ts < 3 * 60 * 1000) return cached;
  try {
    // 當前 OI
    const { data: curr } = await axios.get('https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume', {
      params: { ccy: instId.replace('-USDT-SWAP',''), period: '5m' }
    });
    const rows = curr.data || [];
    if (rows.length < 2) return { oi: 0, prevOi: 0, oiRatio: 1 };
    const oi     = parseFloat(rows[0][1]);
    const prevOi = parseFloat(rows[4]?.[1] || rows[1][1]); // 20分鐘前
    const oiRatio = prevOi > 0 ? oi / prevOi : 1;
    const result = { oi, prevOi, oiRatio, ts: Date.now() };
    oiCache.set(instId, result);
    return result;
  } catch (e) { return { oi: 0, prevOi: 0, oiRatio: 1 }; }
}
 
// ── 大戶多空比（Long/Short Ratio）────────────────────
const lsCache = new Map(); // instId → { lsRatio, ts }
async function getLSRatio(instId) {
  const cached = lsCache.get(instId);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.lsRatio;
  try {
    const ccy = instId.replace('-USDT-SWAP','');
    const { data } = await axios.get('https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio', {
      params: { ccy, period: '5m' }
    });
    const rows = data.data || [];
    if (!rows.length) return 0.5;
    // longRatio = longAcc / (longAcc + shortAcc)
    const longRatio = parseFloat(rows[0][1]);
    lsCache.set(instId, { lsRatio: longRatio, ts: Date.now() });
    return longRatio;
  } catch (e) { return 0.5; }
}
 
// ── 經濟日曆（重大事件熔斷）──────────────────────────
// 使用 investing.com 公開行事曆 API（免費）
let economicEvents = []; // { time, impact, name }
let economicEventsUpdatedAt = 0;
async function updateEconomicCalendar() {
  try {
    // 用 axios 抓取 Forex Factory JSON feed
    const { data } = await axios.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    economicEvents = (data || [])
      .filter(e => e.impact === 'High')
      .map(e => ({
        name:   e.title,
        time:   new Date(e.date).getTime(),
        impact: e.impact,
      }));
    economicEventsUpdatedAt = Date.now();
    console.log(`📅 經濟日曆更新：${economicEvents.length} 個高影響事件`);
  } catch (e) {
    console.warn('⚠️ 經濟日曆更新失敗:', e.message);
  }
}
 
function isEconomicEventSoon(bufferMinutes = 30) {
  const now = Date.now();
  return economicEvents.some(e => {
    const diff = e.time - now;
    return diff > 0 && diff < bufferMinutes * 60 * 1000;
  });
}
 
function getUpcomingEvents(bufferMinutes = 60) {
  const now = Date.now();
  return economicEvents.filter(e => {
    const diff = e.time - now;
    return diff > -5 * 60 * 1000 && diff < bufferMinutes * 60 * 1000;
  });
}
 
// ── ADX 計算（方案E：市況偵測）───────────────────────
function calcADX(candles, period = 14) {
  if (candles.length < period + 2) return 25;
  let plusDM = 0, minusDM = 0, tr = 0;
  for (let i = 0; i < period; i++) {
    const c = candles[i], p = candles[i + 1];
    const upMove   = c.high - p.high;
    const downMove = p.low  - c.low;
    plusDM  += upMove   > downMove && upMove   > 0 ? upMove   : 0;
    minusDM += downMove > upMove   && downMove > 0 ? downMove : 0;
    tr += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  const plusDI  = tr > 0 ? 100 * plusDM  / tr : 0;
  const minusDI = tr > 0 ? 100 * minusDM / tr : 0;
  const dx = (plusDI + minusDI) > 0 ? 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI) : 0;
  return dx; // ADX > 25 = 趨勢，≤25 = 震盪
}
 
// ── OBV 計算（方案D：量價異動）───────────────────────
function calcOBV(candles) {
  let obv = 0;
  for (let i = candles.length - 1; i > 0; i--) {
    if (candles[i - 1].close > candles[i].close) obv += candles[i - 1].vol;
    else if (candles[i - 1].close < candles[i].close) obv -= candles[i - 1].vol;
  }
  return obv;
}
 
// OBV 趨勢：最近 5 根 vs 前 5 根
function calcOBVTrend(candles) {
  const recent = calcOBV(candles.slice(0, 5));
  const prev   = calcOBV(candles.slice(5, 10));
  return recent > prev ? 'up' : recent < prev ? 'down' : 'flat';
}
 
// ── RSI 背離偵測（方案D）────────────────────────────
function detectRSIDivergence(candles) {
  if (candles.length < 15) return 'none';
  const prices = candles.slice(0, 10).map(c => c.close);
  const rsiArr = candles.slice(0, 10).map((_, i) => calcRSI(candles.slice(i)));
  const priceDown = prices[0] < prices[4];  // 近期價格創低
  const rsiUp     = rsiArr[0] > rsiArr[4];  // RSI 未創低（底背離）
  const priceUp   = prices[0] > prices[4];  // 近期價格創高
  const rsiDown   = rsiArr[0] < rsiArr[4];  // RSI 未創高（頂背離）
  if (priceDown && rsiUp)   return 'bullish';  // 底背離 → 做多
  if (priceUp   && rsiDown) return 'bearish';  // 頂背離 → 做空
  return 'none';
}
 
// ── ATR 動態倍數（方案E）────────────────────────────
function getATRMultiplier(atr, candles) {
  const avgATR = candles.slice(0, 20).reduce((s, c) => {
    const p = candles[candles.indexOf(c) + 1];
    if (!p) return s;
    return s + Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }, 0) / 20;
  if (atr < avgATR * 0.7) return 1.2;   // 低波動：止損緊一點
  if (atr > avgATR * 1.5) return 2.0;   // 高波動：止損寬一點
  return 1.5;                            // 正常
}
 
// ── 多時框分析（方案C）───────────────────────────────
async function analyzeMultiTimeframe(instId) {
  try {
    const [c4h, c1h] = await Promise.all([
      fetchCandles(instId, '4H', 30),
      fetchCandles(instId, '1H', 30),
    ]);
    const ma20_4h  = c4h.slice(0, 20).reduce((s, c) => s + c.close, 0) / 20;
    const macd4h   = calcMACD(c4h);
    const ma20_1h  = c1h.slice(0, 20).reduce((s, c) => s + c.close, 0) / 20;
    const rsi1h    = calcRSI(c1h);
    const macd1h   = calcMACD(c1h);
 
    const bull4h = c4h[0].close > ma20_4h && macd4h.histogram > 0;
    const bear4h = c4h[0].close < ma20_4h && macd4h.histogram < 0;
    // 1H 回調到 MA 附近
    const pullback1h = Math.abs(c1h[0].close - ma20_1h) / ma20_1h < 0.008;
    // 1H 反彈確認
    const bounce1h_long  = rsi1h > 45 && macd1h.histogram > 0 && pullback1h;
    const bounce1h_short = rsi1h < 55 && macd1h.histogram < 0 && pullback1h;
 
    let mtfDir = 'neutral', mtfBonus = 0;
    if (bull4h && bounce1h_long)  { mtfDir = 'long';  mtfBonus = 15; }
    if (bear4h && bounce1h_short) { mtfDir = 'short'; mtfBonus = 15; }
    return { mtfDir, mtfBonus };
  } catch (e) {
    return { mtfDir: 'neutral', mtfBonus: 0 };
  }
}
 
// ══════════════════════════════════════════════
// 1. 動態抓取交易量前10名幣對
// ══════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// 動態高波動篩選系統
// 條件：ATR高 + 成交量大 + OI增加 + 24h漲幅適中
// ══════════════════════════════════════════════════════
async function updateTopPairs() {
  try {
    // Step 1：抓全市場 SWAP tickers
    const { data } = await axios.get('https://www.okx.com/api/v5/market/tickers', {
      params: { instType: 'SWAP' }, timeout: 10000,
    });
 
    const stableCoins = ['USDT','USDC','DAI','BUSD','TUSD','USDP','FDUSD','USDD'];
    const blacklist   = ['LABU','BILL','BSB','XAC','ZEC']; // 低流動性黑名單
 
    // Step 2：基礎過濾
    const candidates = data.data
      .filter(t => t.instId.endsWith('-USDT-SWAP'))
      .filter(t => !stableCoins.some(s => t.instId.startsWith(s)))
      .filter(t => !blacklist.some(b => t.instId.startsWith(b)))
      .filter(t => parseFloat(t.volCcy24h) >= DYN_MIN_VOL)
      .map(t => ({
        instId:    t.instId,
        vol24h:    parseFloat(t.volCcy24h),
        price:     parseFloat(t.last),
        priceChg:  Math.abs(parseFloat(t.chgUtc0 || t.change24h || 0)),
        openPrice: parseFloat(t.open24h || t.last),
      }))
      .filter(t => t.priceChg >= DYN_PRICE_CHG && t.priceChg <= DYN_PRICE_MAX);
 
    if (!candidates.length) {
      console.warn('⚠️ 動態篩選：無符合條件幣種，保持現有清單');
      return;
    }
 
    // Step 3：分批抓 ATR + OI（每批 8 個，避免 429）
    const top60 = candidates
      .sort((a, b) => b.vol24h - a.vol24h)
      .slice(0, 60);
 
    const allScored = [];
    for (let i = 0; i < top60.length; i += 8) {
      const batch = top60.slice(i, i + 8);
      const batchRes = await Promise.allSettled(batch.map(async t => {
        try {
          const [candles, oiData] = await Promise.all([
            fetchCandles(t.instId, '1H', 25).catch(() => null),
            getOIData(t.instId).catch(() => ({ oiRatio: 1 })),
          ]);
          if (!candles || candles.length < 15) return null;
 
          // ATR 計算（近14根）
          const atrCurr = calcATR(candles);
          const atrAvg  = candles.slice(0, 20).reduce((s, c, idx) => {
            if (idx === 0) return s;
            const prev = candles[idx];
            return s + Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
          }, 0) / 20;
          const atrRatio = atrAvg > 0 ? atrCurr / atrAvg : 1;
 
          // 動態評分：ATR × OI × 成交量
          const dynScore =
            atrRatio * 40 +
            (oiData.oiRatio > 1.1 ? 30 : 0) +
            Math.min(t.vol24h / 1e8, 30);
 
          return {
            instId:   t.instId,
            vol24h:   t.vol24h,
            priceChg: t.priceChg,
            atrRatio: atrRatio.toFixed(2),
            oiRatio:  oiData.oiRatio.toFixed(2),
            score:    parseFloat(dynScore.toFixed(1)),
          };
        } catch (_) { return null; }
      }));
      allScored.push(...batchRes);
      if (i + 8 < top60.length) await new Promise(r => setTimeout(r, 600));
    }
    const scored = allScored;
 
    // Step 4：排序 + 取前 N 個
    const filtered = scored
      .filter(r => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value)
      .filter(t => parseFloat(t.atrRatio) >= DYN_ATR_MULT) // ATR 需超過均值 1.3x
      .sort((a, b) => b.score - a.score)
      .slice(0, DYN_TOP_N);
 
    if (!filtered.length) {
      console.warn('⚠️ 動態篩選後無符合幣種，保持現有清單');
      return;
    }
 
    dynamicPairs = filtered.map(t => t.instId);
    dynamicPairsDetail = filtered;
    dynamicPairsUpdatedAt = Date.now();
 
    // Step 5：合併固定 + 動態，去重，限制總數
    const merged = [...new Set([...FIXED_PAIRS, ...dynamicPairs])].slice(0, 35);
    WATCH_PAIRS = merged;
 
    console.log(`🔥 動態篩選完成：${filtered.length} 個高波動幣種`);
    console.log(`📊 監控清單（${WATCH_PAIRS.length} 個）：${WATCH_PAIRS.map(p => p.replace('-USDT-SWAP','')).join(' ')}`);
    console.log(`Top5：${filtered.slice(0,5).map(t => `${t.instId.replace('-USDT-SWAP','')}(ATR:${t.atrRatio}x OI:${t.oiRatio}x 分:${t.score})`).join(' | ')}`);
  } catch (e) {
    console.error('更新幣對失敗:', e.message);
  }
}
 
// ══════════════════════════════════════════════
// 2. 行情抓取
// ══════════════════════════════════════════════
async function fetchWithRetry(url, params, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const { data } = await axios.get(url, { params, timeout: 10000 });
      return data;
    } catch (e) {
      const status = e.response?.status;
      if (status === 429) {
        // 429 速率限制：等待時間指數遞增
        const wait = (i + 1) * 2000;
        console.warn(`⏳ 429 速率限制，${wait/1000}s 後重試 (${i+1}/${retries})...`);
        await new Promise(r => setTimeout(r, wait));
      } else if (i === retries - 1) {
        throw e;
      } else {
        await new Promise(r => setTimeout(r, 500));
      }
    }
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
  if (!candles5m || candles5m.length < 5) {
    return { bullRatio: 0.5, bearRatio: 0.5, volSurge: 1, avgVol: 0 };
  }
  const recent = candles5m.slice(0, 5);
  const bullVol = recent.filter(c => c.close > c.open).reduce((s, c) => s + c.vol, 0);
  const bearVol = recent.filter(c => c.close <= c.open).reduce((s, c) => s + c.vol, 0);
  const total = bullVol + bearVol;
  const bullRatio = total > 0 ? bullVol / total : 0.5;
  const avgVol = recent.reduce((s, c) => s + c.vol, 0) / recent.length;
  const prev = candles5m.slice(5, 10);
  const prevAvg = prev.length ? prev.reduce((s, c) => s + c.vol, 0) / prev.length : avgVol;
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
  const [candles, candles5m, ticker, mtf, oiData, lsRatio] = await Promise.all([
    fetchCandles(instId).catch(() => []),
    fetchCandles5m(instId).catch(() => []),
    fetchTicker(instId).catch(() => null),
    analyzeMultiTimeframe(instId).catch(() => ({ mtfDir: 'neutral', mtfBonus: 0 })),
    getOIData(instId).catch(() => ({ oi: 0, oiRatio: 1 })),
    getLSRatio(instId).catch(() => 0.5),
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
  const adx      = calcADX(candles);              // 方案E：市況偵測
  const obvTrend = calcOBVTrend(candles);         // 方案D：量價異動
  const rsiDiv   = detectRSIDivergence(candles);  // 方案D：RSI背離
  const isTrend  = adx > 25;                      // 方案E：趨勢 or 震盪模式
 
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
  // 做多獨立評分
  // ══════════════════════════════════════════════
  if (dir === 'long') {
    // 突破阻力
    if (last.close > resistance && volRatio > 1.2) {
      reasons.push({ t: `突破${fmt(resistance)}阻力`, ok: true }); score += 18;
    }
    // 支撐回測
    if (last.close < support * 1.005 && last.close > support * 0.995) {
      reasons.push({ t: `回測${fmt(support)}支撐`, ok: true }); score += 12;
    }
    // RSI
    if (rsi < 35) {
      reasons.push({ t: `RSI超賣(${rsi.toFixed(0)})`, ok: true }); score += 14;
    } else if (rsi < 50) {
      reasons.push({ t: `RSI健康(${rsi.toFixed(0)})`, ok: true }); score += 6;
    } else if (rsi > 70) {
      reasons.push({ t: `RSI過熱(${rsi.toFixed(0)})`, ok: false }); score -= 8;
    } else {
      reasons.push({ t: `RSI中性(${rsi.toFixed(0)})`, ok: false }); score -= 3;
    }
    // MACD
    if (macd.histogram > 0 && macd.macd > macd.signal) {
      reasons.push({ t: 'MACD金叉', ok: true }); score += 10;
    } else {
      reasons.push({ t: 'MACD未金叉', ok: false }); score -= 6;
    }
    // 布林
    if (last.close > boll.upper) {
      reasons.push({ t: '突破布林上軌', ok: true }); score += 8;
    }
    // MA 多頭排列
    if (ma10 > ma20) {
      reasons.push({ t: 'MA10>MA20多頭', ok: true }); score += 8;
      if (ma20 > ma50) { reasons.push({ t: 'MA均線多頭排列', ok: true }); score += 5; }
    } else {
      reasons.push({ t: 'MA均線空頭', ok: false }); score -= 7;
    }
    // 5m資金流
    if (flow5m.bullRatio > 0.65) {
      reasons.push({ t: `5m買方${(flow5m.bullRatio*100).toFixed(0)}%`, ok: true }); score += 7;
    } else if (flow5m.bullRatio < 0.4) {
      reasons.push({ t: '5m賣方壓制', ok: false }); score -= 6;
    }
    // 量能
    if (volRatio > 1.5) {
      reasons.push({ t: `放量${volRatio.toFixed(1)}x`, ok: true }); score += 7;
    } else if (volRatio < 0.7) {
      reasons.push({ t: '量能萎縮', ok: false }); score -= 5;
    }
    // K線
    if (isCandle_bull && bodyRatio > 0.5) {
      reasons.push({ t: '強力陽線', ok: true }); score += 5;
    } else if (!isCandle_bull) {
      reasons.push({ t: '收陰線', ok: false }); score -= 5;
    }
    // 方案C：多時框共振
    if (mtf.mtfDir === 'long') {
      reasons.push({ t: '4H+1H共振做多', ok: true }); score += mtf.mtfBonus;
    }
    // 方案D：OBV量價 + RSI背離
    if (obvTrend === 'up') {
      reasons.push({ t: 'OBV量能上升', ok: true }); score += 8;
    }
    if (rsiDiv === 'bullish') {
      reasons.push({ t: 'RSI底背離', ok: true }); score += 10;
    }
    // 方案E：自適應 — 趨勢模式加重動量，震盪模式加重均值回歸
    if (isTrend) {
      if (ma10 > ma20 && macd.histogram > 0) { score += 5; }
    } else {
      if (rsi < 35) { score += 6; }
    }
    // ── OI 未平倉量（做多）───────────────────────────
    if (oiData.oiRatio >= OI_SURGE_RATIO) {
      // OI 暴增 + 價格漲 = 強多確認
      if (last.close > candles[1].close) {
        reasons.push({ t: `OI暴增${oiData.oiRatio.toFixed(1)}x↑多`, ok: true }); score += 12;
      } else {
        // OI 暴增 + 價格跌 = 多頭陷阱警告
        reasons.push({ t: `OI暴增但價跌⚠️`, ok: false }); score -= 8;
      }
    } else if (oiData.oiRatio < 0.85) {
      reasons.push({ t: 'OI驟降謹慎', ok: false }); score -= 5;
    }
    // ── 大戶多空比（做多）────────────────────────────
    if (lsRatio >= LS_RATIO_BULL) {
      reasons.push({ t: `大戶多方${(lsRatio*100).toFixed(0)}%`, ok: true }); score += 10;
    } else if (lsRatio <= LS_RATIO_BEAR) {
      reasons.push({ t: `大戶偏空${((1-lsRatio)*100).toFixed(0)}%`, ok: false }); score -= 8;
    }
 
  // ══════════════════════════════════════════════
  // 做空獨立評分（與做多完全對稱優化）
  // ══════════════════════════════════════════════
  } else if (dir === 'short') {
    // 跌破支撐
    if (last.close < support && volRatio > 1.2) {
      reasons.push({ t: `跌破${fmt(support)}支撐`, ok: true }); score += 18;
    }
    // RSI
    if (rsi > 65) {
      reasons.push({ t: `RSI超買(${rsi.toFixed(0)})`, ok: true }); score += 14;
    } else if (rsi > 50) {
      reasons.push({ t: `RSI偏高(${rsi.toFixed(0)})`, ok: true }); score += 6;
    } else if (rsi < 30) {
      reasons.push({ t: `RSI過低(${rsi.toFixed(0)})`, ok: false }); score -= 8;
    } else {
      reasons.push({ t: `RSI中性(${rsi.toFixed(0)})`, ok: false }); score -= 3;
    }
    // MACD 死叉
    if (macd.histogram < 0 && macd.macd < macd.signal) {
      reasons.push({ t: 'MACD死叉', ok: true }); score += 10;
    } else {
      reasons.push({ t: 'MACD未死叉', ok: false }); score -= 6;
    }
    // 布林
    if (last.close < boll.lower) {
      reasons.push({ t: '跌破布林下軌', ok: true }); score += 8;
    }
    // MA 空頭排列
    if (ma10 < ma20) {
      reasons.push({ t: 'MA10<MA20空頭', ok: true }); score += 8;
      if (ma20 < ma50) { reasons.push({ t: 'MA均線空頭排列', ok: true }); score += 5; }
    } else {
      reasons.push({ t: 'MA均線多頭', ok: false }); score -= 7;
    }
    // 5m資金流（賣方主導是利多）
    if (flow5m.bullRatio < 0.35) {
      reasons.push({ t: `5m賣方${((1-flow5m.bullRatio)*100).toFixed(0)}%`, ok: true }); score += 7;
    } else if (flow5m.bullRatio > 0.6) {
      reasons.push({ t: '5m買方壓制', ok: false }); score -= 6;
    }
    // 量能（放量下跌是利多）
    if (volRatio > 1.5) {
      reasons.push({ t: `放量下跌${volRatio.toFixed(1)}x`, ok: true }); score += 7;
    } else if (volRatio < 0.7) {
      reasons.push({ t: '量能萎縮', ok: false }); score -= 5;
    }
    // K線（強力陰線是利多）
    if (!isCandle_bull && bodyRatio > 0.5) {
      reasons.push({ t: '強力陰線', ok: true }); score += 5;
    } else if (isCandle_bull) {
      reasons.push({ t: '收陽線', ok: false }); score -= 5;
    }
    // 方案C：多時框共振
    if (mtf.mtfDir === 'short') {
      reasons.push({ t: '4H+1H共振做空', ok: true }); score += mtf.mtfBonus;
    }
    // 方案D：OBV量價 + RSI背離
    if (obvTrend === 'down') {
      reasons.push({ t: 'OBV量能下降', ok: true }); score += 8;
    }
    if (rsiDiv === 'bearish') {
      reasons.push({ t: 'RSI頂背離', ok: true }); score += 10;
    }
    // 方案E：自適應
    if (isTrend) {
      if (ma10 < ma20 && macd.histogram < 0) { score += 5; }
    } else {
      if (rsi > 65) { score += 6; }
    }
    // ── OI 未平倉量（做空）───────────────────────────
    if (oiData.oiRatio >= OI_SURGE_RATIO) {
      // OI 暴增 + 價格跌 = 強空確認
      if (last.close < candles[1].close) {
        reasons.push({ t: `OI暴增${oiData.oiRatio.toFixed(1)}x↓空`, ok: true }); score += 12;
      } else {
        // OI 暴增 + 價格漲 = 空頭陷阱警告
        reasons.push({ t: `OI暴增但價漲⚠️`, ok: false }); score -= 8;
      }
    } else if (oiData.oiRatio < 0.85) {
      reasons.push({ t: 'OI驟降謹慎', ok: false }); score -= 5;
    }
    // ── 大戶多空比（做空）────────────────────────────
    if (lsRatio <= LS_RATIO_BEAR) {
      reasons.push({ t: `大戶空方${((1-lsRatio)*100).toFixed(0)}%`, ok: true }); score += 10;
    } else if (lsRatio >= LS_RATIO_BULL) {
      reasons.push({ t: `大戶偏多${(lsRatio*100).toFixed(0)}%`, ok: false }); score -= 8;
    }
 
  // ── 中性（條件不足）──────────────────────────
  } else {
    reasons.push({ t: `RSI中性(${rsi.toFixed(0)})`, ok: false });
    reasons.push({ t: 'MACD方向不明', ok: false });
    score = 35;
  }
 
  score = Math.min(100, Math.max(0, score));
  const entry = last.close;
 
  // 方案E：ATR 動態倍數（低波動緊、高波動寬）
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
 
  // 是否加倍本金
  const doubleCapital = flow5m.volSurge > 2.5 && score >= 80 && (
    (dir === 'long'  && flow5m.bullRatio > 0.65) ||
    (dir === 'short' && flow5m.bullRatio < 0.35)
  );
 
  // 方案E：Kelly 動態本金（依評分調整）
  let kellyMult = 1.0;
  if (score >= 90) kellyMult = 2.0;
  else if (score >= 80) kellyMult = 1.5;
  const capital = BASE_CAPITAL * kellyMult * (doubleCapital ? 1.5 : 1);
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
    oiRatio: oiData.oiRatio, lsRatio, // OI + 大戶多空比
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
// 指令選單 Flex Message
// ══════════════════════════════════════════════
function buildCommandMenu() {
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
  const fuseStatus = dailyStats.isFused ? '🚨 已熔斷' : '✅ 運作中';
  const btcEmoji   = btcTrend === 'bull' ? '📈' : btcTrend === 'bear' ? '📉' : '⚖️';
 
  const btnStyle = (bg, label, txt) => ({
    type: 'box', layout: 'vertical', flex: 1,
    backgroundColor: bg, cornerRadius: '8px', paddingAll: '10px',
    action: { type: 'message', label, text: txt },
    contents: [
      { type: 'text', text: label, color: '#FFFFFF', size: 'xs', weight: 'bold', align: 'center', wrap: true },
    ]
  });
 
  return {
    type: 'flex',
    altText: '📋 Alice 指令選單',
    contents: {
      type: 'bubble', size: 'giga',
      styles: { body: { backgroundColor: '#0D1117' } },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px',
        contents: [
 
          // Header
          {
            type: 'box', layout: 'horizontal', alignItems: 'center', marginBottom: 'md',
            contents: [
              {
                type: 'box', layout: 'vertical', flex: 1,
                contents: [
                  { type: 'text', text: '🔷 Alice 指令中心', color: '#00CFFF', size: 'md', weight: 'bold' },
                  { type: 'text', text: now, color: '#6B7A99', size: 'xxs' },
                ]
              },
              {
                type: 'box', layout: 'vertical', alignItems: 'flex-end',
                contents: [
                  { type: 'text', text: fuseStatus, color: dailyStats.isFused ? '#FF3C50' : '#00E578', size: 'xs', weight: 'bold' },
                  { type: 'text', text: `BTC ${btcEmoji} ${btcTrend === 'bull' ? '多頭' : btcTrend === 'bear' ? '空頭' : '中性'}`, color: '#8B949E', size: 'xxs' },
                ]
              }
            ]
          },
 
          { type: 'separator', color: '#21262D', margin: 'md' },
 
          // 掃描 & 狀態
          { type: 'text', text: '📡 掃描 & 監控', color: '#8B949E', size: 'xxs', margin: 'md' },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
            contents: [
              btnStyle('#005533', '🔍 立即掃描', '掃描'),
              btnStyle('#003366', '📊 系統狀態', '狀態'),
              btnStyle('#222233', '📋 監控幣對', '幣對'),
            ]
          },
 
          { type: 'separator', color: '#21262D', margin: 'md' },
 
          // 市場數據
          { type: 'text', text: '📈 市場數據查詢', color: '#8B949E', size: 'xxs', margin: 'md' },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
            contents: [
              btnStyle('#1a1a00', '📊 OI BTC', 'OI BTC'),
              btnStyle('#1a1a00', '📊 OI ETH', 'OI ETH'),
              btnStyle('#1a1a00', '📊 OI SOL', 'OI SOL'),
            ]
          },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
            contents: [
              {
                type: 'box', layout: 'vertical', flex: 1,
                backgroundColor: '#0d1a2e', cornerRadius: '8px', paddingAll: '10px',
                action: { type: 'message', label: '自訂OI查詢', text: 'OI ' },
                contents: [
                  { type: 'text', text: '🔎 OI 自訂幣種', color: '#00CFFF', size: 'xs', align: 'center' },
                  { type: 'text', text: '輸入：OI 幣種名', color: '#6B7A99', size: 'xxs', align: 'center', margin: 'xs' },
                ]
              },
              {
                type: 'box', layout: 'vertical', flex: 1,
                backgroundColor: '#0d1a0d', cornerRadius: '8px', paddingAll: '10px',
                action: { type: 'message', label: '經濟日曆', text: '日曆' },
                contents: [
                  { type: 'text', text: '📅 經濟日曆', color: '#00E578', size: 'xs', align: 'center' },
                  { type: 'text', text: '重大事件預覽', color: '#6B7A99', size: 'xxs', align: 'center', margin: 'xs' },
                ]
              },
            ]
          },
 
          { type: 'separator', color: '#21262D', margin: 'md' },
 
          // 報告 & 設定
          { type: 'text', text: '⚙️ 報告 & 設定', color: '#8B949E', size: 'xxs', margin: 'md' },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
            contents: [
              btnStyle('#1a0d00', '📊 每日報告', '報告'),
              btnStyle('#1a0000', '🔓 清除冷卻', '清除冷卻'),
              btnStyle('#220000', '🚨 重置熔斷', '重置熔斷'),
            ]
          },
 
          { type: 'separator', color: '#21262D', margin: 'md' },
 
          // 監控清單管理
          { type: 'text', text: '➕ 監控清單管理', color: '#8B949E', size: 'xxs', margin: 'md' },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
            contents: [
              {
                type: 'box', layout: 'vertical', flex: 1,
                backgroundColor: '#001a33', cornerRadius: '8px', paddingAll: '10px',
                action: { type: 'message', label: '新增監控', text: '新增監控 ' },
                contents: [
                  { type: 'text', text: '➕ 新增幣種', color: '#00CFFF', size: 'xs', align: 'center' },
                  { type: 'text', text: '輸入：新增監控 BTC', color: '#6B7A99', size: 'xxs', align: 'center', margin: 'xs' },
                ]
              },
              {
                type: 'box', layout: 'vertical', flex: 1,
                backgroundColor: '#1a0000', cornerRadius: '8px', paddingAll: '10px',
                action: { type: 'message', label: '移除監控', text: '移除監控 ' },
                contents: [
                  { type: 'text', text: '➖ 移除幣種', color: '#FF3C50', size: 'xs', align: 'center' },
                  { type: 'text', text: '輸入：移除監控 BTC', color: '#6B7A99', size: 'xxs', align: 'center', margin: 'xs' },
                ]
              },
              {
                type: 'box', layout: 'vertical', flex: 1,
                backgroundColor: '#001a00', cornerRadius: '8px', paddingAll: '10px',
                action: { type: 'message', label: '恢復預設', text: '恢復預設監控' },
                contents: [
                  { type: 'text', text: '🔄 恢復預設', color: '#00E578', size: 'xs', align: 'center' },
                  { type: 'text', text: '重設為預設清單', color: '#6B7A99', size: 'xxs', align: 'center', margin: 'xs' },
                ]
              },
            ]
          },
 
          // 提示
          {
            type: 'box', layout: 'vertical', margin: 'lg',
            backgroundColor: '#0d1520', cornerRadius: '8px', paddingAll: '10px',
            contents: [
              { type: 'text', text: '💡 快速輸入指令', color: '#6B7A99', size: 'xxs', weight: 'bold', margin: 'none' },
              { type: 'text', text: '輸入「?」或「指令」隨時叫出此選單', color: '#6B7A99', size: 'xxs', margin: 'xs', wrap: true },
            ]
          },
 
        ]
      }
    }
  };
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
          { type: 'text', text: '📊 Alice 每日報告', color: '#7eb3f7', size: 'sm', weight: 'bold' },
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
  const now       = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' });
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
              { type: 'text', text: `RSI ${a.rsi?.toFixed(0)} ADX ${a.adx?.toFixed(0)||'—'} ${a.isTrend?'趨勢':'震盪'} ${a.doubleCapital?'⚡':''}`, color: '#6b7a99', size: 'xxs' },
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
          { type: 'text', text: [
            a.mtfDir !== 'neutral' ? `📡 MTF${a.mtfDir==='long'?'多':'空'}` : '',
            a.obvTrend === 'up' ? 'OBV↑' : a.obvTrend === 'down' ? 'OBV↓' : '',
            a.rsiDiv !== 'none' ? (a.rsiDiv==='bullish'?'🔔底背離':'🔔頂背離') : '',
            a.oiRatio >= 1.3 ? `OI暴增${a.oiRatio?.toFixed(1)}x` : '',
            a.lsRatio ? `大戶多${(a.lsRatio*100).toFixed(0)}%` : '',
          ].filter(Boolean).join('  ') || '—', color: '#00cfff', size: 'xxs', wrap: true },
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

  // ── 每日熔斷檢查 ─────────────────────────────────
  if (dailyStats.isFused) {
    console.log('⛔ 今日已熔斷，跳過掃描');
    return;
  }
 
  // ── 經濟日曆熔斷：重大事件前 30 分鐘暫停 ──────────
  if (isEconomicEventSoon(30)) {
    const events = getUpcomingEvents(30);
    const names  = events.map(e => e.name).join(' / ');
    console.warn(`📅 重大經濟事件即將發布（${names}），暫停本次掃描`);
    return;
  }
 
  // ── BTC 市場情緒更新（每10分鐘）──────────────────
  if (Date.now() - btcTrendUpdatedAt > 10 * 60 * 1000) {
    await updateBtcTrend();
  }
 
  console.log(`[${new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei' })}] 掃描 ${WATCH_PAIRS.length} 個幣對… BTC:${btcTrend}`);
 
  // ── 方案A：分批並行（每批 5 個，避免 429）───────────
  const BATCH_SIZE = 5;
  const results = [];
  for (let i = 0; i < WATCH_PAIRS.length; i += BATCH_SIZE) {
    const batch = WATCH_PAIRS.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(pair => analyze(pair).then(a => ({ pair, a })))
    );
    results.push(...batchResults);
    // 批次間休息 800ms，避免觸發速率限制
    if (i + BATCH_SIZE < WATCH_PAIRS.length) {
      await new Promise(r => setTimeout(r, 800));
    }
  }
 
  for (const res of results) {
    if (res.status === 'rejected') { console.error('❌ 分析失敗:', res.reason?.message); continue; }
    const { pair, a } = res.value;
    try {
      if (a.dir === 'neutral') continue;
 
      // ── Phase1：流動性過濾 ─────────────────────────
      const vol24h = await getVol24h(pair);
      if (vol24h < MIN_VOL_USDT) {
        console.log(`💧 ${pair} 流動性不足(${(vol24h/1e6).toFixed(1)}M)，跳過`);
        continue;
      }
 
      // ── Phase1：BTC 情緒過濾 ──────────────────────
      if (a.dir === 'long' && btcTrend === 'bear') {
        console.log(`🐻 BTC空頭環境，跳過 ${pair} 做多`);
        continue;
      }
      if (a.dir === 'short' && btcTrend === 'bull') {
        console.log(`🐂 BTC多頭環境，跳過 ${pair} 做空`);
        continue;
      }
 
      // ── Phase2：資金費率過濾 ──────────────────────
      const fundRate = await getFundRate(pair);
      if (a.dir === 'long'  && fundRate >  FUND_RATE_LIMIT) {
        console.log(`💸 ${pair} 資金費率過高(${(fundRate*100).toFixed(4)}%)，跳過做多`);
        continue;
      }
      if (a.dir === 'short' && fundRate < -FUND_RATE_LIMIT) {
        console.log(`💸 ${pair} 資金費率過負(${(fundRate*100).toFixed(4)}%)，跳過做空`);
        continue;
      }
 
      // ── 方案B：冷卻機制 ───────────────────────────
      if (isOnCooldown(pair)) {
        console.log(`⏸ ${pair} 冷卻中，跳過`);
        continue;
      }
 
      // ── 方案C：訊號強度分級推送 ───────────────────
      if (a.score >= 80) {
        await client.pushMessage(USER_ID, buildSignalCard(pair, a, 'strong'));
        pendingOrders[pair] = { pair, analysis: a };
        setCooldown(pair);
        recordSignal(pair, a.score, a.dir);
        console.log(`🔴 強訊號推送：${pair} 評分${a.score} ADX${a.adx?.toFixed(0)} MTF:${a.mtfDir}`);
      } else if (a.score >= MIN_SCORE) {
        await client.pushMessage(USER_ID, buildSignalCard(pair, a, 'watch'));
        pendingOrders[pair] = { pair, analysis: a };
        setCooldown(pair);
        recordSignal(pair, a.score, a.dir);
        console.log(`🟡 中訊號推送：${pair} 評分${a.score}`);
      } else if (a.score >= 50) {
        recordSignal(pair, a.score, a.dir);
        console.log(`⚪ 弱訊號記錄：${pair} 評分${a.score}`);
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
      const fuseStatus = dailyStats.isFused ? `🚨 已熔斷（今日虧損$${dailyStats.dailyLoss.toFixed(2)}）` : `✅ 正常（今日虧損$${dailyStats.dailyLoss.toFixed(2)}/$${DAILY_MAX_LOSS}）`;
      await client.replyMessage(tok, {
        type: 'text',
        text: `🤖 Alice 狀態
 
` +
          `🪙 BTC趨勢：${btcTrend === 'bull' ? '📈 多頭' : btcTrend === 'bear' ? '📉 空頭' : '⚖️ 中性'}
` +
          `🛡 熔斷狀態：${fuseStatus}
` +
          `📊 待確認：${Object.keys(pendingOrders).length} 筆
` +
          `🔍 監控：${WATCH_PAIRS.length} 個幣對
` +
          `⚡ 門檻：${MIN_SCORE}分 | 止損上限 $${MAX_LOSS_USDT}
` +
          `💰 本金：$${BASE_CAPITAL} | 流動性門檻 ${(MIN_VOL_USDT/1e6).toFixed(0)}M
 
` +
          `指令：掃描 / 幣對 / 報告 / 日曆 / OI BTC / 清除冷卻 / 重置熔斷`
      });
 
    } else if (text === '幣對') {
      await client.replyMessage(tok, { type: 'text', text: `📊 監控清單：\n${WATCH_PAIRS.map(p=>p.replace('-USDT-SWAP','')).join('、')}` });
 
    } else if (text === '指令' || text === 'help' || text === '選單' || text === '?') {
      await client.replyMessage(tok, buildCommandMenu());
 
    } else if (text === '掃描') {
      await client.replyMessage(tok, { type: 'text', text: '🔍 掃描中…' });
      scanAndPush();
 
    } else if (text === '報告' || text === '每日報告') {
      await client.replyMessage(tok, buildDailyReport());
 
    } else if (text === '清除冷卻' || text === '重置') {
      signalCooldown.clear();
      await client.replyMessage(tok, { type: 'text', text: '✅ 已清除所有幣種冷卻，下次掃描將重新評估。' });
 
    } else if (text === '重置熔斷') {
      dailyStats.isFused = false;
      dailyStats.dailyLoss = 0;
      await client.replyMessage(tok, { type: 'text', text: '✅ 熔斷已手動重置，恢復正常掃描。' });
 
    } else if (text.startsWith('OI ') || text.startsWith('oi ')) {
      // ── OI 查詢：OI BTC / OI ETH / OI 任意幣 ──────────
      const symbol = text.split(' ')[1]?.toUpperCase();
      if (!symbol) {
        await client.replyMessage(tok, { type: 'text', text: '請輸入：OI 幣種\n例：OI BTC、OI ETH、OI SOL' });
        continue;
      }
      const instId = symbol.includes('-SWAP') ? symbol : `${symbol}-USDT-SWAP`;
      try {
        const [oi, ls, fr] = await Promise.all([
          getOIData(instId),
          getLSRatio(instId),
          getFundRate(instId),
        ]);
        const oiStatus = oi.oiRatio >= 1.3 ? '🔺 暴增' : oi.oiRatio < 0.85 ? '🔻 驟降' : '➡️ 正常';
        const lsStatus = ls >= LS_RATIO_BULL ? '✅ 大戶偏多' : ls <= LS_RATIO_BEAR ? '🔴 大戶偏空' : '⚖️ 大戶中性';
        const frStatus = fr > FUND_RATE_LIMIT ? '⚠️ 過高（不宜做多）' : fr < -FUND_RATE_LIMIT ? '⚠️ 過負（不宜做空）' : '✅ 正常';
        await client.replyMessage(tok, {
          type: 'text',
          text: `📊 ${symbol} 市場結構\n` +
            `━━━━━━━━━━━━\n` +
            `📈 未平倉量 OI：${oi.oi > 0 ? oi.oi.toLocaleString() : '—'}\n` +
            `📊 OI 變化：${oiStatus} (${oi.oiRatio.toFixed(2)}x)\n` +
            `━━━━━━━━━━━━\n` +
            `👥 大戶多空比\n` +
            `  多方：${(ls*100).toFixed(1)}%  空方：${((1-ls)*100).toFixed(1)}%\n` +
            `  ${lsStatus}\n` +
            `━━━━━━━━━━━━\n` +
            `💸 資金費率：${(fr*100).toFixed(4)}%\n` +
            `  ${frStatus}`
        });
      } catch (e) {
        await client.replyMessage(tok, { type: 'text', text: `❌ 查詢失敗：${e.message}` });
      }
 
    } else if (text === '日曆' || text === '經濟日曆') {
      // ── 經濟日曆：未來 8 小時重大事件 ─────────────────
      await updateEconomicCalendar(); // 先更新一次確保最新
      const upcoming = getUpcomingEvents(480); // 未來8小時
      if (!upcoming.length) {
        await client.replyMessage(tok, { type: 'text', text: '📅 未來 8 小時無高影響事件\n\n交易環境相對安全 ✅' });
      } else {
        const lines = upcoming.map(e => {
          const t = new Date(e.time).toLocaleTimeString('zh-TW', {
            hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei',
          });
          const diff = Math.round((e.time - Date.now()) / 60000);
          const diffStr = diff <= 0 ? '剛發布' : diff < 60 ? `${diff}分後` : `${Math.floor(diff/60)}時${diff%60}分後`;
          return `⚡ ${t}（${diffStr}）\n   ${e.name}`;
        }).join('\n');
        const isSoon = isEconomicEventSoon(30);
        await client.replyMessage(tok, {
          type: 'text',
          text: `📅 重大經濟事件（未來8小時）\n` +
            `━━━━━━━━━━━━\n` +
            (isSoon ? `🚨 30分鐘內有事件，掃描已暫停！\n━━━━━━━━━━━━\n` : '') +
            lines,
        });
      }
 
    } else if (text.startsWith('新增監控')) {
      // ── 新增監控幣種：新增監控 BTC / 新增監控 BTC ETH SOL ─
      const symbols = text.replace('新增監控','').trim().toUpperCase().split(/\s+/).filter(Boolean);
      if (!symbols.length) {
        await client.replyMessage(tok, { type: 'text', text: '請輸入幣種\n例：新增監控 BTC\n   新增監控 BTC ETH SOL' });
        continue;
      }
      const added = [], skipped = [];
      for (const sym of symbols) {
        const instId = sym.includes('-SWAP') ? sym : `${sym}-USDT-SWAP`;
        if (WATCH_PAIRS.includes(instId)) { skipped.push(sym); continue; }
        WATCH_PAIRS.push(instId);
        added.push(sym);
      }
      await client.replyMessage(tok, {
        type: 'text',
        text: `✅ 監控清單更新\n\n` +
          (added.length  ? `➕ 新增：${added.join('、')}\n` : '') +
          (skipped.length? `⏭️ 已存在：${skipped.join('、')}\n` : '') +
          `\n目前共監控 ${WATCH_PAIRS.length} 個幣對`,
      });
 
    } else if (text.startsWith('移除監控')) {
      // ── 移除監控幣種 ────────────────────────────────────
      const symbols = text.replace('移除監控','').trim().toUpperCase().split(/\s+/).filter(Boolean);
      if (!symbols.length) {
        await client.replyMessage(tok, { type: 'text', text: '請輸入幣種\n例：移除監控 ZEC' });
        continue;
      }
      const removed = [], notFound = [];
      for (const sym of symbols) {
        const instId = sym.includes('-SWAP') ? sym : `${sym}-USDT-SWAP`;
        const idx = WATCH_PAIRS.indexOf(instId);
        if (idx === -1) { notFound.push(sym); continue; }
        WATCH_PAIRS.splice(idx, 1);
        removed.push(sym);
      }
      await client.replyMessage(tok, {
        type: 'text',
        text: `✅ 監控清單更新\n\n` +
          (removed.length  ? `➖ 移除：${removed.join('、')}\n` : '') +
          (notFound.length ? `⚠️ 未找到：${notFound.join('、')}\n` : '') +
          `\n目前共監控 ${WATCH_PAIRS.length} 個幣對`,
      });
 
    } else if (text === '恢復預設監控') {
      // ── 恢復預設幣種清單 ─────────────────────────────────
      WATCH_PAIRS.length = 0;
      FIXED_PAIRS.forEach(p => WATCH_PAIRS.push(p));
      await client.replyMessage(tok, {
        type: 'text',
        text: `🔄 已恢復預設監控清單\n\n${WATCH_PAIRS.map(p=>p.replace('-USDT-SWAP','')).join('、')}`,
      });
 
    } else if (text === '熱榜' || text === '動態清單' || text === '波動榜') {
      // ── 查看當前動態篩選結果 ─────────────────────────
      if (!dynamicPairsDetail.length) {
        await client.replyMessage(tok, { type: 'text', text: '⏳ 動態清單尚未初始化，請稍後或輸入「掃描」觸發更新。' });
        continue;
      }
      const ago = Math.round((Date.now() - dynamicPairsUpdatedAt) / 60000);
      const lines = dynamicPairsDetail.slice(0, 10).map((t, i) => {
        const sym = t.instId.replace('-USDT-SWAP','');
        const chgStr = (t.priceChg * 100).toFixed(1) + '%';
        return `${i+1}. ${sym}  ATR ${t.atrRatio}x  OI ${t.oiRatio}x  漲跌${chgStr}  分${t.score}`;
      }).join('\n');
      await client.replyMessage(tok, {
        type: 'text',
        text: `🔥 高波動幣種榜（${ago}分前更新）\n` +
          `━━━━━━━━━━━━\n` +
          lines + '\n' +
          `━━━━━━━━━━━━\n` +
          `共監控 ${WATCH_PAIRS.length} 個幣對\n` +
          `每30分鐘自動更新`,
      });
 
    } else if (text === 'BTC' || text === 'btc') {
      // ── 快速查 BTC OI ───────────────────────────────────
      const instId = 'BTC-USDT-SWAP';
      try {
        const [oi, ls] = await Promise.all([getOIData(instId), getLSRatio(instId)]);
        const oiStatus = oi.oiRatio >= 1.3 ? '🔺暴增' : oi.oiRatio < 0.85 ? '🔻驟降' : '➡️正常';
        await client.replyMessage(tok, {
          type: 'text',
          text: `🪙 BTC 市況快報\n` +
            `趨勢：${btcTrend==='bull'?'📈 多頭':btcTrend==='bear'?'📉 空頭':'⚖️ 中性'}\n` +
            `OI：${oiStatus} (${oi.oiRatio.toFixed(2)}x)\n` +
            `大戶：多 ${(ls*100).toFixed(1)}% / 空 ${((1-ls)*100).toFixed(1)}%`,
        });
      } catch (e) {
        await client.replyMessage(tok, { type: 'text', text: `❌ 查詢失敗：${e.message}` });
      }
 
    } else if (text === '設定監控' || text === '監控設定') {
      // ── 設定監控選單 Flex ────────────────────────────────
      await client.replyMessage(tok, buildWatchlistFlex());
 
    } else {
      // ── 未知指令 → 提示選單 ──────────────────────────────
      await client.replyMessage(tok, {
        type: 'text',
        text: `❓ 不認識這個指令\n\n傳「指令」或「?」查看所有功能`,
      });
    }
  }
});
 
// ── 監控清單 Flex Message ────────────────────────────
function buildWatchlistFlex() {
  const items = WATCH_PAIRS.map(p => {
    const sym = p.replace('-USDT-SWAP','');
    return {
      type: 'box', layout: 'horizontal',
      paddingAll: '8px', backgroundColor: '#161B22',
      cornerRadius: '6px', margin: 'sm',
      contents: [
        { type: 'text', text: sym, color: '#00CFFF', size: 'sm', weight: 'bold', flex: 1 },
        {
          type: 'box', layout: 'vertical', flex: 0,
          backgroundColor: '#330000', cornerRadius: '4px', paddingAll: '4px',
          action: { type: 'message', label: '移除', text: `移除監控 ${sym}` },
          contents: [{ type: 'text', text: '✕', color: '#FF3C50', size: 'xxs' }],
        },
      ],
    };
  });
  return {
    type: 'flex',
    altText: '⚙️ 監控清單設定',
    contents: {
      type: 'bubble', size: 'giga',
      styles: { body: { backgroundColor: '#0D1117' } },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px',
        contents: [
          { type: 'text', text: '⚙️ 監控清單設定', color: '#E6EDF3', size: 'lg', weight: 'bold' },
          { type: 'text', text: `目前監控 ${WATCH_PAIRS.length} 個幣種`, color: '#8B949E', size: 'xs', margin: 'xs' },
          { type: 'separator', color: '#21262D', margin: 'md' },
          ...items,
          { type: 'separator', color: '#21262D', margin: 'md' },
          {
            type: 'box', layout: 'vertical', backgroundColor: '#001833',
            cornerRadius: '8px', paddingAll: '12px', margin: 'md',
            contents: [
              { type: 'text', text: '➕ 新增幣種', color: '#00CFFF', size: 'sm', weight: 'bold' },
              { type: 'text', text: '輸入：新增監控 BTC\n多個：新增監控 BTC ETH SOL', color: '#8B949E', size: 'xxs', margin: 'sm', wrap: true },
            ],
          },
          {
            type: 'box', layout: 'vertical', backgroundColor: '#001800',
            cornerRadius: '8px', paddingAll: '12px', margin: 'sm',
            action: { type: 'message', label: '恢復預設', text: '恢復預設監控' },
            contents: [{ type: 'text', text: '🔄 恢復預設清單', color: '#00E578', size: 'sm', align: 'center' }],
          },
        ],
      },
    },
  };
}
 
// ══════════════════════════════════════════════
// 9. 定時任務
// ══════════════════════════════════════════════
cron.schedule('*/3 * * * *', scanAndPush);
cron.schedule('*/30 * * * *', updateTopPairs); // 每30分鐘重新篩選高波動幣種
cron.schedule('*/15 * * * *', updateBtcTrend);
cron.schedule('0 */6 * * *', updateEconomicCalendar); // 每6小時更新經濟日曆
 
// ── 方案D：每天早上 8:00 推送每日報告 ────────
cron.schedule('0 8 * * *', async () => {
  try {
    const report = buildDailyReport();
    await client.pushMessage(USER_ID, report);
    // 重置每日統計（含熔斷）
    dailyStats.wins = 0;
    dailyStats.losses = 0;
    dailyStats.totalPnl = 0;
    dailyStats.signals = [];
    dailyStats.dailyLoss = 0;
    dailyStats.isFused = false;
    dailyStats.date = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
    console.log('📊 每日報告已推送');
  } catch (e) { console.error('每日報告推送失敗:', e.message); }
}, { timezone: 'Asia/Taipei' });
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Bot 啟動 Port ${PORT}`);
  await updateTopPairs();
  await updateBtcTrend();
  await updateEconomicCalendar(); // 初始化經濟日曆
  await scanAndPush();
});
 
