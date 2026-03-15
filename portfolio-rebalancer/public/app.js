/* ═══════════════════════════════════════════════════════════
   ETF Portfolio Rebalancer — app.js  (v2 — redesigned)
   ═══════════════════════════════════════════════════════════ */

// ── Palette for donut chart (10 colors) ───────────────────
const PALETTE = [
  '#6366f1','#f59e0b','#10b981','#ef4444','#3b82f6',
  '#8b5cf6','#ec4899','#14b8a6','#f97316','#84cc16',
];

// ── State ──────────────────────────────────────────────────
let state = {
  accounts:     [],   // [{ id, name, investAmount, cash, holdings:[...] }]
  prices:       {},   // { code: { price, name, change, changeRate } }
  manualPrices: {},   // { code: price }  — user overrides
  charts:       {},   // { code: [{date,close}] }
  checkedOrders:{},   // { `${accountId}-${code}`: bool }  — order checkboxes
  lastRefresh:  null,
};

// ── Persist / Load ─────────────────────────────────────────
function save() {
  localStorage.setItem('pf-rb-v2', JSON.stringify({
    accounts: state.accounts, prices: state.prices,
    manualPrices: state.manualPrices, checkedOrders: state.checkedOrders,
    lastRefresh: state.lastRefresh,
  }));
}
function load() {
  try {
    const raw = localStorage.getItem('pf-rb-v2');
    if (!raw) return seedDefault();
    const s = JSON.parse(raw);
    state.accounts     = s.accounts     || [];
    state.prices       = s.prices       || {};
    state.manualPrices = s.manualPrices || {};
    state.checkedOrders= s.checkedOrders|| {};
    state.lastRefresh  = s.lastRefresh  || null;
    if (!state.accounts.length) seedDefault();
  } catch { seedDefault(); }
}
function seedDefault() {
  state.accounts = [{
    id: uid(), name: 'IRP', investAmount: 250000, cash: 284608,
    holdings: [
      { id: uid(), code:'381180', name:'TIGER 미국필라델피아반도체나스닥', shortName:'TIGER 반도체', risk:'위험', qty:47, avgPrice:18802, target:20 },
      { id: uid(), code:'487230', name:'KODEX 미국AI전력핵심인프라',      shortName:'KODEX AI전력', risk:'위험', qty:78, avgPrice:14483, target:20 },
      { id: uid(), code:'478150', name:'TIMEFOLIO 글로벌우주테크&방산',   shortName:'TIMEFOLIO 우주', risk:'위험', qty:90, avgPrice:17152, target:30 },
      { id: uid(), code:'251600', name:'PLUS 고배당채권혼합',             shortName:'PLUS 고배당채권', risk:'안전', qty:0,  avgPrice:0,     target:15 },
      { id: uid(), code:'448540', name:'ACE 엔비디아채권혼합블름버그',    shortName:'ACE 엔비디아채권', risk:'안전', qty:85, avgPrice:24524, target:15 },
    ],
  }];
  save();
}
function uid() { return Math.random().toString(36).slice(2,10); }

// ── Price Fetching ─────────────────────────────────────────
async function fetchPrices(codes) {
  if (!codes.length) return;
  setStatus('시세 조회 중…');
  const btn = document.getElementById('btn-refresh');
  btn.disabled = true;
  btn.textContent = '⏳ 조회 중…';
  try {
    const res = await fetch('/api/prices', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ codes }),
    });
    const data = await res.json();
    Object.assign(state.prices, data);
    state.lastRefresh = new Date().toLocaleString('ko-KR');
    save();
    setStatus(`✓ ${state.lastRefresh} 기준`);
  } catch(e) {
    setStatus('⚠️ 서버 연결 실패 — npm start 실행 여부 확인');
  }
  btn.disabled = false;
  btn.textContent = '🔄 시세 새로고침';
}

async function fetchChart(code) {
  if (state.charts[code]) return;
  try {
    const r = await fetch(`/api/chart/${code}`);
    const d = await r.json();
    if (Array.isArray(d) && d.length) state.charts[code] = d;
  } catch {}
}

function setStatus(msg) {
  const el = document.getElementById('refresh-status');
  if (el) el.textContent = msg;
}

// ── Calculations ───────────────────────────────────────────
function getPrice(code) {
  if (state.manualPrices?.[code] > 0) return state.manualPrices[code];
  return state.prices[code]?.price || 0;
}

function calcAccount(account) {
  const holdings = account.holdings.map(h => {
    const price  = getPrice(h.code);
    const value  = price * h.qty;
    const profit = h.avgPrice > 0 ? ((price - h.avgPrice) / h.avgPrice) * 100 : 0;
    return { ...h, price, value, profit };
  });

  const totalValue   = holdings.reduce((s,h) => s + h.value, 0);
  const available    = (account.cash || 0) + (account.investAmount || 0);
  const newTotal     = totalValue + available;
  const totalCost    = account.holdings.reduce((s,h) => s + h.avgPrice * h.qty, 0);
  const totalProfit  = totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0;

  holdings.forEach(h => {
    h.currentRatio = totalValue > 0 ? (h.value / totalValue) * 100 : 0;
  });

  holdings.forEach(h => {
    const diff = (h.target / 100) * newTotal - h.value;
    h.orderQty    = h.price > 0 ? Math.floor(diff / h.price) : 0;
    h.expectedQty = h.qty + h.orderQty;
    h.expectedValue = h.price * h.expectedQty;
    h.orderCost   = h.price * Math.abs(h.orderQty);
  });

  const expectedTotal = holdings.reduce((s,h) => s + h.expectedValue, 0);
  holdings.forEach(h => {
    h.expectedRatio = expectedTotal > 0 ? (h.expectedValue / expectedTotal) * 100 : 0;
  });

  return { holdings, totalValue, available, newTotal, totalCost, totalProfit };
}

// ── Render Entry ───────────────────────────────────────────
function render() {
  renderGlobalStats();
  const container = document.getElementById('accounts-container');

  if (!state.accounts.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">📂</div>
        <h2>계좌가 없습니다</h2>
        <p>상단의 "+ 계좌 추가" 버튼으로 첫 번째 계좌를 추가하세요.</p>
        <button class="btn btn-primary" onclick="openAddAccount()">+ 계좌 추가</button>
      </div>`;
    return;
  }

  container.innerHTML = state.accounts.map(renderAccount).join('');

  // Draw all sparklines + donut charts
  requestAnimationFrame(() => {
    state.accounts.forEach(account => {
      drawDonut(account);
      account.holdings.forEach(h => {
        const canvas = document.getElementById(`spark-${h.id}`);
        if (canvas && state.charts[h.code]) drawSparkline(canvas, state.charts[h.code]);
      });
    });
    fetchChartsInBackground();
  });
}

function renderGlobalStats() {
  const el = document.getElementById('global-stats');
  if (!el) return;
  if (!state.accounts.length) { el.innerHTML = ''; return; }

  let total = 0, cost = 0;
  state.accounts.forEach(a => {
    const { totalValue, totalCost } = calcAccount(a);
    total += totalValue; cost += totalCost;
  });
  const profit = cost > 0 ? ((total - cost) / cost) * 100 : 0;
  const pSign  = profit >= 0 ? '+' : '';
  const cls    = profit >= 0 ? 'up' : 'down';

  el.innerHTML = `
    <div class="gstat">총 평가액 <strong>${fmt(total)}원</strong></div>
    <div class="gstat ${cls}">수익률 <strong>${pSign}${profit.toFixed(2)}%</strong></div>
    ${state.lastRefresh ? `<div class="gstat">기준 <strong>${state.lastRefresh}</strong></div>` : ''}
  `;
}

// ── Account Block ──────────────────────────────────────────
function renderAccount(account) {
  const { holdings, totalValue, available, newTotal, totalProfit } = calcAccount(account);
  const profitClass = totalProfit >= 0 ? 'up' : 'down';
  const profitSign  = totalProfit >= 0 ? '+' : '';
  const targetSum   = account.holdings.reduce((s,h) => s + h.target, 0);

  const warnHtml = Math.abs(targetSum - 100) > 0.1
    ? `<div class="warn-bar">⚠️ 목표 비율 합계 ${targetSum.toFixed(1)}% — 100%가 되어야 합니다</div>`
    : '';

  return `
<div class="account-card" id="account-${account.id}">

  <!-- Title bar -->
  <div class="account-titlebar">
    <div class="account-name">
      ${esc(account.name)}
      <span class="acct-badge">계좌</span>
    </div>
    <div class="account-kpi">
      <div class="kpi-item">
        <div class="kpi-label">총 평가액</div>
        <div class="kpi-value">${fmt(totalValue)}원</div>
      </div>
      <div class="kpi-item">
        <div class="kpi-label">리밸런싱 후</div>
        <div class="kpi-value">${fmt(newTotal)}원</div>
      </div>
      <div class="kpi-item">
        <div class="kpi-label">총 수익률</div>
        <div class="kpi-value ${profitClass}">${profitSign}${totalProfit.toFixed(2)}%</div>
      </div>
    </div>
    <div class="account-acts">
      <button class="btn btn-secondary btn-sm" onclick="openAddHolding('${account.id}')">+ 종목</button>
      <button class="btn btn-ghost btn-sm"     onclick="openEditAccount('${account.id}')">편집</button>
      <button class="btn btn-danger btn-sm"    onclick="deleteAccount('${account.id}')">삭제</button>
    </div>
  </div>

  <!-- Step 1: Cash/invest inputs -->
  <div class="cash-strip">
    <div class="ci-group">
      <label>① 현금 잔액</label>
      <input type="number" value="${account.cash || 0}"
        onchange="updateCash('${account.id}', this.value)" />
      <span style="font-size:11px;color:#92400e">원</span>
    </div>
    <div class="ci-group">
      <label>② 월 납입액</label>
      <input type="number" value="${account.investAmount || 0}"
        onchange="updateInvest('${account.id}', this.value)" />
      <span style="font-size:11px;color:#92400e">원</span>
    </div>
    <span class="cash-arrow">→</span>
    <div class="cash-result">가용 금액 ${fmt(available)}원</div>
  </div>

  <!-- Viz: donut + orders -->
  <div class="account-viz">

    <!-- Donut chart -->
    <div class="donut-panel">
      <div class="donut-title">현재 포트폴리오 비중</div>
      <div class="donut-wrap">
        <canvas id="donut-${account.id}" width="160" height="160"></canvas>
        <div class="donut-center">
          <div class="dc-label">종목</div>
          <div class="dc-value">${holdings.length}개</div>
        </div>
      </div>
      <div class="donut-legend" id="legend-${account.id}">
        ${holdings.map((h,i) => `
          <div class="legend-item">
            <div class="legend-dot" style="background:${PALETTE[i % PALETTE.length]}"></div>
            <div class="legend-name" title="${h.name}">${esc(h.shortName || h.name)}</div>
            <div class="legend-pct">${h.currentRatio.toFixed(1)}%</div>
            <div class="legend-target">목표${h.target}%</div>
          </div>`).join('')}
      </div>
    </div>

    <!-- Order checklist -->
    <div class="order-panel">
      <div class="order-panel-title">
        ③ 이번 달 주문 목록
        ${renderOrderBadge(holdings, account.id)}
      </div>
      ${renderOrderList(holdings, account)}
    </div>

  </div>

  <!-- Holdings table -->
  <div class="holdings-section">
    <div class="holdings-header">
      <h3>📋 종목별 상세</h3>
      <span style="font-size:11px;color:var(--text3)">행 클릭 시 편집</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>종목명</th>
            <th>30일</th>
            <th>현재가</th>
            <th>수익률</th>
            <th>현재 평가액</th>
            <th>목표%</th>
            <th class="th-center">현재 비중</th>
            <th>보유수</th>
            <th>주문</th>
            <th class="th-center">리밸런싱 후</th>
          </tr>
        </thead>
        <tbody>
          ${holdings.map(h => renderHoldingRow(h, account.id)).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td>합계</td>
            <td></td><td></td><td></td>
            <td>${fmt(totalValue)}원</td>
            <td>${targetSum.toFixed(0)}%</td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>
  </div>

  ${warnHtml}

  <!-- Footer KPI strip -->
  <div class="account-footer">
    <div class="footer-box">
      <div class="fb-label">현재 총 평가액</div>
      <div class="fb-value">${fmt(totalValue)}원</div>
    </div>
    <div class="footer-box">
      <div class="fb-label">현금 잔액</div>
      <div class="fb-value">${fmt(account.cash || 0)}원</div>
    </div>
    <div class="footer-box">
      <div class="fb-label">월 납입액</div>
      <div class="fb-value">${fmt(account.investAmount || 0)}원</div>
    </div>
    <div class="footer-box">
      <div class="fb-label">리밸런싱 가용</div>
      <div class="fb-value">${fmt(available)}원</div>
    </div>
    <div class="footer-box">
      <div class="fb-label">리밸런싱 후 총액</div>
      <div class="fb-value">${fmt(newTotal)}원</div>
    </div>
    <div class="footer-box">
      <div class="fb-label">총 수익률</div>
      <div class="fb-value ${profitClass}">${profitSign}${totalProfit.toFixed(2)}%</div>
    </div>
  </div>

</div>`;
}

// ── Order Panel ────────────────────────────────────────────
function renderOrderBadge(holdings, accountId) {
  const orders = holdings.filter(h => h.orderQty !== 0);
  const done   = orders.filter(h => state.checkedOrders[`${accountId}-${h.code}`]);
  if (!orders.length) return '';
  return `<span class="badge-count">${done.length}/${orders.length}</span>`;
}

function renderOrderList(holdings, account) {
  const orders = holdings.filter(h => h.orderQty !== 0);

  if (!orders.length) {
    // Check if prices are loaded
    const anyPrice = holdings.some(h => h.price > 0);
    if (!anyPrice) {
      return `<div class="no-orders">⏳ 시세를 조회하면 주문 수량이 계산됩니다<br><small>상단 🔄 새로고침 버튼을 클릭하세요</small></div>`;
    }
    return `<div class="order-all-done">✅ 모든 종목이 목표 비율에 맞습니다!</div>`;
  }

  const allDone = orders.every(h => state.checkedOrders[`${account.id}-${h.code}`]);
  if (allDone) {
    return `
      <div class="order-all-done">🎉 모든 주문 완료! 보유 수량을 업데이트하세요.</div>
      <div class="order-list" style="opacity:0.5">${orders.map(h => renderOrderItem(h, account.id)).join('')}</div>`;
  }

  return `<div class="order-list">${orders.map(h => renderOrderItem(h, account.id)).join('')}</div>`;
}

function renderOrderItem(h, accountId) {
  const key     = `${accountId}-${h.code}`;
  const checked = state.checkedOrders[key] ? 'checked' : '';
  const done    = state.checkedOrders[key] ? 'checked-done' : '';
  const isBuy   = h.orderQty > 0;
  const cls     = isBuy ? 'buy' : 'sell';
  const icon    = isBuy ? '🟥' : '🟦';
  const label   = isBuy ? `+${h.orderQty}주 매수` : `${h.orderQty}주 매도`;
  const cost    = fmt(h.orderCost);
  const costLbl = isBuy ? `${cost}원 필요` : `${cost}원 회수`;

  return `
    <div class="order-item ${cls} ${done}" id="oi-${accountId}-${h.code}">
      <input type="checkbox" class="order-check" ${checked}
        onchange="toggleOrder('${accountId}','${h.code}', this.checked)"
        onclick="event.stopPropagation()" />
      <span class="order-icon">${icon}</span>
      <span class="order-name">${esc(h.shortName || h.name)}</span>
      <span class="order-gap">${h.currentRatio.toFixed(1)}% → ${h.expectedRatio.toFixed(1)}%</span>
      <span class="order-action ${cls}">${label}</span>
      <span class="order-cost ${cls}">${costLbl}</span>
    </div>`;
}

function toggleOrder(accountId, code, checked) {
  const key = `${accountId}-${code}`;
  state.checkedOrders[key] = checked;
  save();

  // Update the specific item without full re-render
  const item = document.getElementById(`oi-${accountId}-${code}`);
  if (item) {
    if (checked) item.classList.add('checked-done');
    else         item.classList.remove('checked-done');
  }
  // Re-render badge only
  const account = state.accounts.find(a => a.id === accountId);
  if (account) {
    const { holdings } = calcAccount(account);
    const badgeEl = document.querySelector(`#account-${accountId} .order-panel-title`);
    if (badgeEl) {
      badgeEl.innerHTML = `③ 이번 달 주문 목록 ${renderOrderBadge(holdings, accountId)}`;
    }
  }
}

// ── Holdings Table Row ─────────────────────────────────────
function renderHoldingRow(h, accountId) {
  const priceData = state.prices[h.code];
  const isManual  = state.manualPrices?.[h.code] > 0;
  let priceCell, profitCell;

  if (isManual) {
    const mp = state.manualPrices[h.code];
    priceCell  = `<span class="price-flat">${fmt(mp)}<sup class="manual-badge">수동</sup></span>`;
    const pcls = h.profit >= 0 ? 'profit-pos' : 'profit-neg';
    profitCell = `<span class="${pcls}">${h.profit >= 0 ? '+' : ''}${h.profit.toFixed(2)}%</span>`;
  } else if (!priceData) {
    priceCell  = `<span class="price-loading">-</span>`;
    profitCell = `<span class="price-loading">-</span>`;
  } else if (priceData.error) {
    priceCell  = `<span style="color:var(--warn);cursor:pointer;font-size:11px"
                    title="${priceData.error}" onclick="event.stopPropagation();openBulkPrice()">⚠️ 실패</span>`;
    profitCell = `<span class="price-loading">-</span>`;
  } else {
    const cr   = parseFloat(priceData.changeRate) || 0;
    const pcls = cr > 0 ? 'price-up' : cr < 0 ? 'price-down' : 'price-flat';
    const sign = cr > 0 ? '▲' : cr < 0 ? '▼' : '';
    priceCell  = `<span class="${pcls}">${fmt(priceData.price)}원<br>
                    <span class="price-change">${sign}${Math.abs(cr).toFixed(2)}%</span></span>`;
    const plcls = h.profit >= 0 ? 'profit-pos' : 'profit-neg';
    profitCell  = `<span class="${plcls}">${h.profit >= 0 ? '+' : ''}${h.profit.toFixed(2)}%</span>`;
  }

  // Ratio bar
  const diff   = h.currentRatio - h.target;
  const barCls = Math.abs(diff) <= 2 ? 'ok' : diff > 0 ? 'over' : 'under';
  const barW   = Math.min(100, (h.currentRatio / (h.target || 1)) * 100);

  // Order tag
  let orderTag;
  if (h.orderQty > 0)      orderTag = `<span class="order-tag buy">▲ +${h.orderQty}주</span>`;
  else if (h.orderQty < 0) orderTag = `<span class="order-tag sell">▼ ${h.orderQty}주</span>`;
  else                     orderTag = `<span class="order-tag hold">✓ 유지</span>`;

  // Before → After ratio
  const eCls = Math.abs(h.expectedRatio - h.target) <= 2 ? 'ok'
             : h.expectedRatio > h.target ? 'over' : 'under';

  const riskBadge = h.risk === '위험'
    ? `<span class="risk-chip risk-danger">위험</span>`
    : `<span class="risk-chip risk-safe">안전</span>`;

  return `
    <tr onclick="openEditHolding('${accountId}','${h.id}')">
      <td>
        <div class="holding-name-cell">
          ${riskBadge}
          <div>
            <div class="holding-name-main">${esc(h.shortName || h.name)}</div>
            <div class="holding-name-code">${h.code}</div>
          </div>
        </div>
      </td>
      <td class="spark-cell" onclick="event.stopPropagation()">
        <canvas id="spark-${h.id}" width="76" height="28"></canvas>
      </td>
      <td style="text-align:right">${priceCell}</td>
      <td style="text-align:right">${profitCell}</td>
      <td style="text-align:right">${h.price > 0 ? fmt(h.value)+'원' : '-'}</td>
      <td style="text-align:right">
        <span style="background:var(--primary-bg);color:var(--primary);padding:2px 8px;border-radius:99px;font-size:11px;font-weight:800">${h.target}%</span>
      </td>
      <td class="ratio-bar-cell">
        <div class="rbc-wrap">
          <div class="rbc-bar"><div class="rbc-fill ${barCls}" style="width:${barW}%"></div></div>
          <span class="rbc-pct" style="color:${barCls==='ok'?'var(--success)':barCls==='over'?'var(--up)':'var(--primary)'}">${h.currentRatio.toFixed(1)}%</span>
        </div>
      </td>
      <td style="text-align:right">${h.qty}주</td>
      <td style="text-align:center">${orderTag}</td>
      <td>
        <div class="ratio-shift">
          <span class="before">${h.currentRatio.toFixed(1)}%</span>
          <span class="arrow">→</span>
          <span class="after ${eCls}">${h.expectedRatio.toFixed(1)}%</span>
        </div>
      </td>
    </tr>`;
}

// ── Donut Chart ────────────────────────────────────────────
function drawDonut(account) {
  const canvas = document.getElementById(`donut-${account.id}`);
  if (!canvas) return;

  const { holdings } = calcAccount(account);
  const totalValue = holdings.reduce((s,h) => s + h.value, 0);
  if (totalValue <= 0) {
    // Draw empty circle
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 160, 160);
    ctx.beginPath();
    ctx.arc(80, 80, 60, 0, Math.PI * 2);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 20;
    ctx.stroke();
    return;
  }

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 160, 160);

  const cx = 80, cy = 80, R = 65, r = 42;
  let angle = -Math.PI / 2;

  holdings.forEach((h, i) => {
    const ratio = h.value / totalValue;
    const sweep = ratio * Math.PI * 2;
    const color = PALETTE[i % PALETTE.length];

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, angle, angle + sweep);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    angle += sweep;
  });

  // Punch hole
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // Target ring (dashed outer)
  angle = -Math.PI / 2;
  holdings.forEach((h, i) => {
    const sweep = (h.target / 100) * Math.PI * 2;
    const color = PALETTE[i % PALETTE.length];
    ctx.beginPath();
    ctx.arc(cx, cy, R + 6, angle, angle + sweep - 0.03);
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    angle += sweep;
  });
}

// ── Sparkline ──────────────────────────────────────────────
function drawSparkline(canvas, data) {
  if (!data || data.length < 2) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const prices = data.map(d => d.close);
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 1;
  const pad = 2;

  ctx.clearRect(0, 0, W, H);

  const pts = prices.map((p, i) => ({
    x: pad + (i / (prices.length - 1)) * (W - pad * 2),
    y: pad + (1 - (p - min) / range) * (H - pad * 2),
  }));

  const isUp = prices[prices.length - 1] >= prices[0];
  const color = isUp ? '#ef4444' : '#3b82f6';

  // Fill
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, isUp ? 'rgba(239,68,68,0.18)' : 'rgba(59,130,246,0.18)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.beginPath();
  ctx.moveTo(pts[0].x, H);
  pts.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.lineTo(pts[pts.length-1].x, H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function fetchChartsInBackground() {
  const codes = [...new Set(state.accounts.flatMap(a => a.holdings.map(h => h.code)))];
  codes.forEach(code => {
    if (!state.charts[code]) {
      fetchChart(code).then(() => {
        state.accounts.forEach(account => {
          account.holdings.forEach(h => {
            if (h.code === code) {
              const canvas = document.getElementById(`spark-${h.id}`);
              if (canvas && state.charts[code]) drawSparkline(canvas, state.charts[code]);
            }
          });
        });
      });
    }
  });
}

// ── Account CRUD ───────────────────────────────────────────
let _editAccId = null;

function openAddAccount() {
  _editAccId = null;
  document.getElementById('modal-account-title').textContent = '계좌 추가';
  document.getElementById('modal-account-name').value  = '';
  document.getElementById('modal-account-invest').value = '250000';
  document.getElementById('modal-account').classList.remove('hidden');
  setTimeout(() => document.getElementById('modal-account-name').focus(), 50);
}

function openEditAccount(id) {
  _editAccId = id;
  const a = state.accounts.find(a => a.id === id);
  if (!a) return;
  document.getElementById('modal-account-title').textContent = '계좌 편집';
  document.getElementById('modal-account-name').value   = a.name;
  document.getElementById('modal-account-invest').value = a.investAmount || 0;
  document.getElementById('modal-account').classList.remove('hidden');
}

function closeAccountModal() {
  document.getElementById('modal-account').classList.add('hidden');
}

function saveAccount() {
  const name = document.getElementById('modal-account-name').value.trim();
  if (!name) { alert('계좌명을 입력하세요'); return; }
  const invest = parseInt(document.getElementById('modal-account-invest').value) || 0;
  if (_editAccId) {
    const a = state.accounts.find(a => a.id === _editAccId);
    if (a) { a.name = name; a.investAmount = invest; }
  } else {
    state.accounts.push({ id: uid(), name, investAmount: invest, cash: 0, holdings: [] });
  }
  save(); closeAccountModal(); render();
}

function deleteAccount(id) {
  if (!confirm('이 계좌를 삭제하시겠습니까?')) return;
  state.accounts = state.accounts.filter(a => a.id !== id);
  save(); render();
}

function updateCash(accountId, val) {
  const a = state.accounts.find(a => a.id === accountId);
  if (a) { a.cash = parseInt(val) || 0; save(); render(); }
}

function updateInvest(accountId, val) {
  const a = state.accounts.find(a => a.id === accountId);
  if (a) { a.investAmount = parseInt(val) || 0; save(); render(); }
}

// ── Holding CRUD ───────────────────────────────────────────
let _editAccForHolding = null, _editHoldingId = null;

function openAddHolding(accountId) {
  _editAccForHolding = accountId; _editHoldingId = null;
  document.getElementById('modal-holding-title').textContent = '종목 추가';
  document.getElementById('modal-holding-code').value = '';
  document.getElementById('modal-holding-name').value = '';
  document.querySelector('input[name="risk"][value="위험"]').checked = true;
  document.getElementById('modal-holding-qty').value = '';
  document.getElementById('modal-holding-avgprice').value = '';
  document.getElementById('modal-holding-target').value = '';
  document.getElementById('modal-holding-manualprice').value = '';
  document.getElementById('lookup-result').textContent = '';
  document.getElementById('lookup-result').className = 'lookup-result';
  document.getElementById('btn-delete-holding').style.display = 'none';
  document.getElementById('modal-holding').classList.remove('hidden');
  setTimeout(() => document.getElementById('modal-holding-code').focus(), 50);
}

function openEditHolding(accountId, holdingId) {
  _editAccForHolding = accountId; _editHoldingId = holdingId;
  const acc = state.accounts.find(a => a.id === accountId);
  const h   = acc?.holdings.find(h => h.id === holdingId);
  if (!h) return;
  document.getElementById('modal-holding-title').textContent = '종목 편집';
  document.getElementById('modal-holding-code').value       = h.code;
  document.getElementById('modal-holding-name').value       = h.shortName || h.name;
  document.querySelector(`input[name="risk"][value="${h.risk || '위험'}"]`).checked = true;
  document.getElementById('modal-holding-qty').value        = h.qty;
  document.getElementById('modal-holding-avgprice').value   = h.avgPrice;
  document.getElementById('modal-holding-target').value     = h.target;
  document.getElementById('modal-holding-manualprice').value= state.manualPrices[h.code] || '';
  document.getElementById('lookup-result').textContent      = h.name || '';
  document.getElementById('lookup-result').className        = 'lookup-result ok';
  document.getElementById('btn-delete-holding').style.display = 'inline-flex';
  document.getElementById('modal-holding').classList.remove('hidden');
}

function closeHoldingModal() {
  document.getElementById('modal-holding').classList.add('hidden');
}

async function lookupCode() {
  const code = document.getElementById('modal-holding-code').value.trim();
  if (code.length !== 6) { alert('6자리 종목 코드를 입력하세요'); return; }
  const el = document.getElementById('lookup-result');
  el.textContent = '🔍 조회 중…'; el.className = 'lookup-result';
  const btn = document.getElementById('btn-lookup-code');
  btn.disabled = true;
  try {
    const res  = await fetch(`/api/price/${code}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (data.price > 0) {
      el.textContent = `✓ ${data.name}  |  현재가: ${fmt(data.price)}원`;
      el.className   = 'lookup-result ok';
      if (!document.getElementById('modal-holding-name').value)
        document.getElementById('modal-holding-name').value = (data.name || '').slice(0, 20);
      state.prices[code] = data;
    } else throw new Error('가격 없음');
  } catch(e) {
    el.textContent = `✗ 조회 실패: ${e.message}`;
    el.className   = 'lookup-result err';
  }
  btn.disabled = false;
}

function saveHolding() {
  const code        = document.getElementById('modal-holding-code').value.trim();
  const name        = document.getElementById('modal-holding-name').value.trim();
  const risk        = document.querySelector('input[name="risk"]:checked')?.value || '위험';
  const qty         = parseInt(document.getElementById('modal-holding-qty').value)        || 0;
  const avgPrice    = parseInt(document.getElementById('modal-holding-avgprice').value)   || 0;
  const target      = parseFloat(document.getElementById('modal-holding-target').value)   || 0;
  const manualPrice = parseInt(document.getElementById('modal-holding-manualprice').value)|| 0;

  if (!code || code.length !== 6) { alert('올바른 종목 코드를 입력하세요'); return; }
  if (!name)  { alert('종목명을 입력하세요'); return; }

  const acc = state.accounts.find(a => a.id === _editAccForHolding);
  if (!acc) return;

  if (manualPrice > 0) state.manualPrices[code] = manualPrice;
  else delete state.manualPrices[code];

  if (_editHoldingId) {
    const h = acc.holdings.find(h => h.id === _editHoldingId);
    if (h) Object.assign(h, { code, shortName: name, name: h.name || name, risk, qty, avgPrice, target });
  } else {
    acc.holdings.push({ id: uid(), code, name, shortName: name, risk, qty, avgPrice, target });
  }
  save(); closeHoldingModal(); render();
}

function deleteHolding() {
  if (!confirm('이 종목을 삭제하시겠습니까?')) return;
  const acc = state.accounts.find(a => a.id === _editAccForHolding);
  if (acc) acc.holdings = acc.holdings.filter(h => h.id !== _editHoldingId);
  save(); closeHoldingModal(); render();
}

// ── Bulk Price Modal ───────────────────────────────────────
function openBulkPrice() {
  const codes = [...new Set(state.accounts.flatMap(a => a.holdings.map(h => h.code)))];
  const container = document.getElementById('bulk-price-fields');
  container.innerHTML = codes.map(code => {
    const h    = state.accounts.flatMap(a => a.holdings).find(h => h.code === code);
    const name = h?.shortName || h?.name || code;
    const cur  = getPrice(code);
    const val  = state.manualPrices[code] || cur || '';
    return `
      <div class="form-group">
        <label>${esc(name)} <span class="label-hint">(${code})</span></label>
        <div class="input-row">
          <input type="number" id="bp-${code}" value="${val}" placeholder="현재가 (원)" min="0" style="text-align:right" />
          <span style="display:flex;align-items:center;font-size:11px;color:var(--text3);white-space:nowrap">
            ${cur > 0 ? `API ${fmt(cur)}원` : 'API 미조회'}
          </span>
        </div>
      </div>`;
  }).join('');
  document.getElementById('modal-bulk-price').classList.remove('hidden');
}

function closeBulkPrice() {
  document.getElementById('modal-bulk-price').classList.add('hidden');
}

function saveBulkPrices() {
  const codes = [...new Set(state.accounts.flatMap(a => a.holdings.map(h => h.code)))];
  codes.forEach(code => {
    const val = parseInt(document.getElementById(`bp-${code}`)?.value) || 0;
    if (val > 0) state.manualPrices[code] = val;
    else delete state.manualPrices[code];
  });
  save(); closeBulkPrice(); render();
}

// ── Export CSV ─────────────────────────────────────────────
function exportCSV() {
  const lines = ['계좌,종목코드,종목명,보유수,평단가,현재가,현재평가액,목표%,현재%,추가주문,예상평가액,예상%'];
  state.accounts.forEach(a => {
    const { holdings } = calcAccount(a);
    holdings.forEach(h => {
      lines.push([a.name, h.code, h.shortName||h.name, h.qty, h.avgPrice, h.price,
        h.value, h.target+'%', h.currentRatio.toFixed(2)+'%',
        h.orderQty, h.expectedValue, h.expectedRatio.toFixed(2)+'%'].join(','));
    });
  });
  const blob = new Blob(['\uFEFF'+lines.join('\n')], {type:'text/csv;charset=utf-8'});
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `portfolio_${new Date().toISOString().slice(0,10)}.csv`,
  });
  a.click(); URL.revokeObjectURL(a.href);
}

// ── Utilities ──────────────────────────────────────────────
function fmt(n) {
  if (!n && n !== 0) return '-';
  return Math.round(n).toLocaleString('ko-KR');
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ───────────────────────────────────────────────────
function init() {
  load();

  // Nav buttons
  document.getElementById('btn-add-account').addEventListener('click', openAddAccount);
  document.getElementById('btn-export').addEventListener('click', exportCSV);
  document.getElementById('btn-bulk-price').addEventListener('click', openBulkPrice);
  document.getElementById('btn-refresh').addEventListener('click', async () => {
    const codes = [...new Set(state.accounts.flatMap(a => a.holdings.map(h => h.code)))];
    await fetchPrices(codes);
    render();
  });

  // Account modal
  document.getElementById('btn-save-account').addEventListener('click', saveAccount);
  document.getElementById('btn-cancel-account').addEventListener('click', closeAccountModal);
  document.getElementById('btn-cancel-account2').addEventListener('click', closeAccountModal);
  document.querySelector('#modal-account .modal-backdrop').addEventListener('click', closeAccountModal);

  // Holding modal
  document.getElementById('btn-lookup-code').addEventListener('click', lookupCode);
  document.getElementById('btn-save-holding').addEventListener('click', saveHolding);
  document.getElementById('btn-cancel-holding').addEventListener('click', closeHoldingModal);
  document.getElementById('btn-close-holding').addEventListener('click', closeHoldingModal);
  document.getElementById('btn-delete-holding').addEventListener('click', deleteHolding);
  document.querySelector('#modal-holding .modal-backdrop').addEventListener('click', closeHoldingModal);
  document.getElementById('modal-holding-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') lookupCode();
  });

  // Bulk price modal
  document.getElementById('btn-save-bulk').addEventListener('click', saveBulkPrices);
  document.getElementById('btn-cancel-bulk').addEventListener('click', closeBulkPrice);
  document.getElementById('btn-cancel-bulk2').addEventListener('click', closeBulkPrice);
  document.querySelector('#modal-bulk-price .modal-backdrop').addEventListener('click', closeBulkPrice);

  // Initial draw
  render();

  // Auto-fetch prices
  const codes = [...new Set(state.accounts.flatMap(a => a.holdings.map(h => h.code)))];
  if (codes.length) fetchPrices(codes).then(render);

  // Auto-refresh every 5 min
  setInterval(async () => {
    const c = [...new Set(state.accounts.flatMap(a => a.holdings.map(h => h.code)))];
    if (c.length) { await fetchPrices(c); render(); }
  }, 5 * 60 * 1000);
}

document.addEventListener('DOMContentLoaded', init);
