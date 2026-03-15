const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

let yahooFinance;
try {
  yahooFinance = require('yahoo-finance2').default;
  // Suppress validation warnings for non-critical fields
  yahooFinance.setGlobalConfig({ validation: { logErrors: false } });
} catch (e) {
  console.warn('[warn] yahoo-finance2 not available:', e.message);
}

const NAVER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://finance.naver.com',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
};

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Naver Finance with cookie fetch ───────────────────────
let naverCookieCache = { value: null, ts: 0 };

async function getNaverCookies() {
  const now = Date.now();
  if (naverCookieCache.value && now - naverCookieCache.ts < 10 * 60 * 1000) {
    return naverCookieCache.value;
  }
  try {
    const r = await axios.get('https://finance.naver.com', {
      headers: NAVER_HEADERS,
      timeout: 8000,
      maxRedirects: 3,
    });
    const setCookies = r.headers['set-cookie'] || [];
    const cookie = setCookies.map(c => c.split(';')[0]).join('; ');
    naverCookieCache = { value: cookie, ts: now };
    return cookie;
  } catch {
    return '';
  }
}

async function fetchNaverPrice(code) {
  const cookie = await getNaverCookies();
  const headers = { ...NAVER_HEADERS, Cookie: cookie };

  // Try the PC sise JSON API first
  const r = await axios.get(
    `https://finance.naver.com/item/sise.nhn?code=${code}`,
    { headers, timeout: 8000, responseType: 'arraybuffer' }
  );
  // Naver returns EUC-KR encoded HTML — parse it
  const html = Buffer.from(r.data).toString('utf-8');

  // Extract closing price
  const priceMatch = html.match(/id="_nowVal"[^>]*>([0-9,]+)</);
  const nameMatch = html.match(/name="ItemName"[^>]*value="([^"]+)"/);

  if (priceMatch) {
    return {
      code,
      name: nameMatch ? nameMatch[1] : '',
      price: parseInt(priceMatch[1].replace(/,/g, ''), 10),
      source: 'naver',
    };
  }
  throw new Error('Price not found in Naver response');
}

async function fetchYahooPrice(code) {
  if (!yahooFinance) throw new Error('yahoo-finance2 not available');

  // Korean stocks: code.KS (KOSPI) or code.KQ (KOSDAQ)
  // ETFs are generally on KOSPI
  let result;
  try {
    result = await yahooFinance.quote(`${code}.KS`, {}, { validateResult: false });
  } catch {
    result = await yahooFinance.quote(`${code}.KQ`, {}, { validateResult: false });
  }

  if (!result || !result.regularMarketPrice) throw new Error('No price from Yahoo Finance');

  return {
    code,
    name: result.longName || result.shortName || result.symbol || '',
    price: Math.round(result.regularMarketPrice),
    change: result.regularMarketChange ? Math.round(result.regularMarketChange) : 0,
    changeRate: result.regularMarketChangePercent
      ? result.regularMarketChangePercent.toFixed(2)
      : '0',
    source: 'yahoo',
  };
}

// ── Price endpoint ─────────────────────────────────────────
app.get('/api/price/:code', async (req, res) => {
  const { code } = req.params;
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: '종목 코드는 6자리 숫자여야 합니다' });
  }

  // Try Yahoo Finance first (more reliable in non-KR environments)
  // Then fall back to Naver Finance
  const attempts = [
    () => fetchYahooPrice(code),
    () => fetchNaverPrice(code),
  ];

  for (const attempt of attempts) {
    try {
      const result = await attempt();
      return res.json(result);
    } catch (e) {
      // try next
    }
  }

  res.status(500).json({
    error: '시세 조회 실패 — Yahoo Finance와 Naver Finance 모두 응답 없음. 수동으로 가격을 입력하세요.',
  });
});

// ── Chart endpoint ─────────────────────────────────────────
app.get('/api/chart/:code', async (req, res) => {
  const { code } = req.params;
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: '잘못된 종목 코드' });
  }

  // Try Yahoo Finance historical data
  if (yahooFinance) {
    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 35);

      const history = await yahooFinance.historical(`${code}.KS`, {
        period1: startDate.toISOString().slice(0, 10),
        period2: endDate.toISOString().slice(0, 10),
        interval: '1d',
      }, { validateResult: false });

      if (history && history.length > 0) {
        const points = history.map(d => ({
          date: d.date.toISOString().slice(0, 10).replace(/-/g, ''),
          open: Math.round(d.open || 0),
          high: Math.round(d.high || 0),
          low: Math.round(d.low || 0),
          close: Math.round(d.close || d.adjClose || 0),
          volume: Math.round(d.volume || 0),
        })).filter(p => p.close > 0);

        return res.json(points);
      }
    } catch (e) {
      // fall through to Naver
    }
  }

  // Try Naver Finance chart API (fchart)
  try {
    const cookie = await getNaverCookies();
    const r = await axios.get(
      `https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=day&count=30&requestType=0`,
      { headers: { ...NAVER_HEADERS, Cookie: cookie }, timeout: 8000 }
    );
    const xml = r.data || '';
    const matches = [...xml.matchAll(/data="([^"]+)"/g)];
    const points = matches.map(m => {
      const parts = m[1].split('|');
      return {
        date: parts[0],
        open: parseInt(parts[1]) || 0,
        high: parseInt(parts[2]) || 0,
        low: parseInt(parts[3]) || 0,
        close: parseInt(parts[4]) || 0,
        volume: parseInt(parts[5]) || 0,
      };
    }).filter(p => p.close > 0);

    if (points.length > 0) return res.json(points);
  } catch {}

  res.status(500).json({ error: '차트 데이터 조회 실패' });
});

// ── Batch prices ───────────────────────────────────────────
app.post('/api/prices', async (req, res) => {
  const { codes } = req.body;
  if (!Array.isArray(codes) || codes.length === 0) {
    return res.status(400).json({ error: 'codes 배열이 필요합니다' });
  }

  const results = await Promise.allSettled(
    codes.map(code =>
      fetch(`http://localhost:${PORT}/api/price/${code}`)
        .then(r => r.json())
        .catch(e => ({ code, error: e.message }))
    )
  );

  const prices = {};
  results.forEach((r, i) => {
    const code = codes[i];
    prices[code] = r.status === 'fulfilled' ? r.value : { code, error: r.reason?.message };
  });

  res.json(prices);
});

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   📊 ETF 포트폴리오 리밸런싱 도구              ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║   👉 http://localhost:${PORT}                    ║`);
  console.log('╚══════════════════════════════════════════════╝\n');
});
