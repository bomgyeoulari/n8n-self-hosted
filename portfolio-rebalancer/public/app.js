/* =========================================================
   ETF Portfolio Rebalancer — app.js
   ========================================================= */

// ── State ─────────────────────────────────────────────────
let state = {
  accounts: [],        // [{ id, name, investAmount, cash, holdings: [...] }]
  prices: {},          // { code: { price, name, change, changeRate } }
  manualPrices: {},    // { code: price } — user overrides
  charts: {},          // { code: [{ date, close }] }
  lastRefresh: null,
};

// ── Persistence ───────────────────────────────────────────
function save() {
  localStorage.setItem('portfolio-rebalancer', JSON.stringify({
    accounts: state.accounts,
    prices: state.prices,
    manualPrices: state.manualPrices,
    lastRefresh: state.lastRefresh,
  }));
}

function load() {
  try {
    const raw = localStorage.getItem('portfolio-rebalancer');
    if (!raw) return seedDefault();
    const saved = JSON.parse(raw);
    state.accounts = saved.accounts || [];
    state.prices = saved.prices || {};
    state.manualPrices = saved.manualPrices || {};
    state.lastRefresh = saved.lastRefresh || null;
    if (state.accounts.length === 0) seedDefault();
  } catch {
    seedDefault();
  }
}

function seedDefault() {
  state.accounts = [
    {
      id: uid(),
      name: 'IRP',
      investAmount: 250000,
      cash: 284608,
      holdings: [
        { id: uid(), code: '381180', name: 'TIGER 미국필라델피아반도체나스닥', shortName: 'TIGER 반도체', risk: '위험', qty: 47, avgPrice: 18802, target: 20 },
        { id: uid(), code: '487230', name: 'KODEX 미국AI전력핵심인프라', shortName: 'KODEX AI전력', risk: '위험', qty: 78, avgPrice: 14483, target: 20 },
        { id: uid(), code: '478150', name: 'TIMEFOLIO 글로벌우주테크&방산', shortName: 'TIMEFOLIO 우주', risk: '위험', qty: 90, avgPrice: 17152, target: 30 },
        { id: uid(), code: '251600', name: 'PLUS 고배당채권혼합', shortName: 'PLUS 고배당채권', risk: '안전', qty: 0, avgPrice: 0, target: 15 },
        { id: uid(), code: '448540', name: 'ACE 엔비디아채권혼합블름버그', shortName: 'ACE 엔비디아채권', risk: '안전', qty: 85, avgPrice: 24524, target: 15 },
      ],
    },
  ];
  save();
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// ── Price fetching ─────────────────────────────────────────
async function fetchPrices(codes) {
  if (codes.length === 0) return;
  setStatus('시세 조회 중...');
  try {
    const res = await fetch('/api/prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes }),
    });
    const data = await res.json();
    Object.assign(state.prices, data);
    state.lastRefresh = new Date().toLocaleString('ko-KR');
    save();
    setStatus(`마지막 갱신: ${state.lastRefresh}`);
  } catch (e) {
    setStatus('⚠️ 시세 조회 실패 — 서버가 실행 중인지 확인하세요');
  }
}

async function fetchChart(code) {
  if (state.charts[code]) return;
  try {
    const res = await fetch(`/api/chart/${code}`);
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      state.charts[code] = data;
    }
  } catch {}
}

function setStatus(msg) {
  document.getElementById('refresh-status').textContent = msg;
}

// ── Calculations ───────────────────────────────────────────
function getPrice(code) {
  // Manual overrides take precedence over API prices
  if (state.manualPrices && state.manualPrices[code] > 0) return state.manualPrices[code];
  return state.prices[code]?.price || 0;
}

function calcHolding(h) {
  const price = getPrice(h.code);
  const value = price * h.qty;
  const profit = h.avgPrice > 0 ? ((price - h.avgPrice) / h.avgPrice) * 100 : 0;
  return { price, value, profit };
}

function calcAccount(account) {
  const holdings = account.holdings.map(h => {
    const { price, value, profit } = calcHolding(h);
    return { ...h, price, value, profit };
  });

  const totalValue = holdings.reduce((s, h) => s + h.value, 0);
  const totalWithCash = totalValue + (account.cash || 0);

  holdings.forEach(h => {
    h.currentRatio = totalValue > 0 ? (h.value / totalValue) * 100 : 0;
  });

  // Rebalancing: available = cash + investAmount
  const available = (account.cash || 0) + (account.investAmount || 0);
  const newTotal = totalValue + available;

  holdings.forEach(h => {
    const targetValue = (h.target / 100) * newTotal;
    const currentValue = h.value;
    const diff = targetValue - currentValue;
    if (h.price > 0) {
      h.orderQty = Math.floor(diff / h.price);
    } else {
      h.orderQty = 0;
    }
    h.expectedQty = h.qty + h.orderQty;
    h.expectedValue = h.price * h.expectedQty;
  });

  const expectedTotal = holdings.reduce((s, h) => s + h.expectedValue, 0);
  holdings.forEach(h => {
    h.expectedRatio = expectedTotal > 0 ? (h.expectedValue / expectedTotal) * 100 : 0;
  });

  const totalCost = account.holdings.reduce((s, h) => s + h.avgPrice * h.qty, 0);
  const totalProfit = totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0;

  return { holdings, totalValue, totalWithCash, newTotal, available, totalCost, totalProfit };
}

// ── Rendering ──────────────────────────────────────────────
function render() {
  const container = document.getElementById('accounts-container');

  if (state.accounts.length === 0) {
    container.innerHTML = `
      <div class="empty-accounts">
        <h2>📭 계좌가 없습니다</h2>
        <p>상단의 "+ 계좌 추가" 버튼으로 계좌를 추가하세요.</p>
        <button class="btn btn-primary" onclick="openAddAccount()">+ 계좌 추가</button>
      </div>`;
    return;
  }

  container.innerHTML = state.accounts.map(a => renderAccount(a)).join('');

  // Draw sparklines after DOM is ready
  state.accounts.forEach(account => {
    account.holdings.forEach(h => {
      const canvas = document.getElementById(`spark-${h.id}`);
      if (canvas && state.charts[h.code]) {
        drawSparkline(canvas, state.charts[h.code]);
      }
    });
  });

  // Fetch charts in background
  const allCodes = [...new Set(state.accounts.flatMap(a => a.holdings.map(h => h.code)))];
  allCodes.forEach(code => {
    if (!state.charts[code]) {
      fetchChart(code).then(() => {
        state.accounts.forEach(account => {
          account.holdings.forEach(h => {
            if (h.code === code) {
              const canvas = document.getElementById(`spark-${h.id}`);
              if (canvas && state.charts[h.code]) drawSparkline(canvas, state.charts[h.code]);
            }
          });
        });
      });
    }
  });
}

function renderAccount(account) {
  const { holdings, totalValue, newTotal, available, totalProfit } = calcAccount(account);
  const targetSum = account.holdings.reduce((s, h) => s + h.target, 0);
  const warningMsg = Math.abs(targetSum - 100) > 0.1
    ? `⚠️ 목표 비율 합계가 ${targetSum.toFixed(1)}% 입니다 (100%가 되어야 합니다)`
    : '';

  const rows = holdings.map(h => renderHoldingRow(h, account.id)).join('');
  const profitClass = totalProfit >= 0 ? 'up' : 'down';
  const profitSign = totalProfit >= 0 ? '+' : '';

  return `
  <div class="account-card" id="account-${account.id}">
    <div class="account-header">
      <div class="account-title">계좌: ${esc(account.name)}</div>
      <div class="account-meta">
        <div class="meta-item">총 평가액 <strong>${fmt(totalValue)}원</strong></div>
        <div class="meta-item">리밸런싱 후 <strong>${fmt(newTotal)}원</strong></div>
        <div class="meta-item">수익률 <strong class="${profitClass}">${profitSign}${totalProfit.toFixed(2)}%</strong></div>
      </div>
      <div class="account-actions">
        <button class="btn btn-secondary btn-sm" onclick="openAddHolding('${account.id}')">+ 종목 추가</button>
        <button class="btn btn-ghost btn-sm" onclick="openEditAccount('${account.id}')">계좌 편집</button>
        <button class="btn btn-danger btn-sm" onclick="deleteAccount('${account.id}')">삭제</button>
      </div>
    </div>

    <div class="cash-row">
      <label>현금 잔액 (IRP):</label>
      <input type="number" value="${account.cash || 0}"
        onchange="updateCash('${account.id}', this.value)"
        title="현재 계좌의 현금 잔액 입력" />
      <label class="invest-label">월 추가 납입:</label>
      <input type="number" value="${account.investAmount || 0}"
        onchange="updateInvest('${account.id}', this.value)"
        title="이번 달 추가 납입 예정 금액" />
      <span style="color:var(--text-muted);font-size:12px">
        → 리밸런싱 가용 금액: <strong>${fmt(available)}원</strong>
      </span>
    </div>

    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>종목명</th>
            <th>코드</th>
            <th>평단가</th>
            <th>30일 추세</th>
            <th>현재가</th>
            <th>수익률</th>
            <th>현재 평가액</th>
            <th>목표 비율</th>
            <th>현재 비율</th>
            <th>보유수</th>
            <th>추가 주문</th>
            <th>예상 평가액</th>
            <th>예상 비율</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="6">합계</td>
            <td>${fmt(totalValue)}원</td>
            <td>${targetSum.toFixed(1)}%</td>
            <td>100.0%</td>
            <td></td>
            <td></td>
            <td>${fmt(holdings.reduce((s,h)=>s+h.expectedValue,0))}원</td>
            <td>100.0%</td>
          </tr>
        </tfoot>
      </table>
    </div>

    ${warningMsg ? `<div class="rebalance-note">${warningMsg}</div>` : ''}

    <div class="account-summary">
      <div class="summary-box">
        <div class="label">현재 총 평가액</div>
        <div class="value">${fmt(totalValue)}원</div>
      </div>
      <div class="summary-box">
        <div class="label">현금 잔액</div>
        <div class="value">${fmt(account.cash || 0)}원</div>
      </div>
      <div class="summary-box">
        <div class="label">월 납입액</div>
        <div class="value">${fmt(account.investAmount || 0)}원</div>
      </div>
      <div class="summary-box">
        <div class="label">리밸런싱 후 총액</div>
        <div class="value">${fmt(newTotal)}원</div>
      </div>
      <div class="summary-box">
        <div class="label">총 수익률</div>
        <div class="value ${profitClass}">${profitSign}${totalProfit.toFixed(2)}%</div>
      </div>
    </div>
  </div>`;
}

function renderHoldingRow(h, accountId) {
  const priceData = state.prices[h.code];
  let priceCell, profitCell;

  const isManual = state.manualPrices && state.manualPrices[h.code] > 0;

  if (isManual) {
    const manualP = state.manualPrices[h.code];
    priceCell = `<span class="price-flat">${fmt(manualP)}원 <small style="background:#fef3c7;color:#92400e;padding:1px 4px;border-radius:3px;font-size:10px">수동</small></span>`;
    const profitCls = h.profit >= 0 ? 'profit-pos' : 'profit-neg';
    const profitSign = h.profit >= 0 ? '+' : '';
    profitCell = `<span class="${profitCls}">${profitSign}${h.profit.toFixed(2)}%</span>`;
  } else if (!priceData) {
    priceCell = `<span class="price-loading" title="🔄 새로고침 버튼을 눌러 시세를 조회하거나 가격을 직접 입력하세요">-</span>`;
    profitCell = `-`;
  } else if (priceData.error) {
    priceCell = `<span style="color:var(--warn);font-size:11px;cursor:pointer" title="${priceData.error}" onclick="event.stopPropagation();openBulkPrice()">⚠️ 조회 실패</span>`;
    profitCell = `-`;
  } else {
    const changeRate = parseFloat(priceData.changeRate) || 0;
    const cls = changeRate > 0 ? 'price-up' : changeRate < 0 ? 'price-down' : 'price-flat';
    const sign = changeRate > 0 ? '▲' : changeRate < 0 ? '▼' : '';
    priceCell = `<span class="${cls}">${fmt(priceData.price)}원 <small>${sign}${Math.abs(changeRate).toFixed(2)}%</small></span>`;
    const profitCls = h.profit >= 0 ? 'profit-pos' : 'profit-neg';
    const profitSign = h.profit >= 0 ? '+' : '';
    profitCell = `<span class="${profitCls}">${profitSign}${h.profit.toFixed(2)}%</span>`;
  }

  // Current ratio bar
  const diff = h.currentRatio - h.target;
  const barCls = Math.abs(diff) <= 2 ? 'ok' : diff > 0 ? 'over' : 'under';
  const barW = Math.min(100, (h.currentRatio / (h.target || 1)) * 100);

  // Order qty display
  let orderCell;
  if (h.orderQty > 0) orderCell = `<span class="order-positive">+${h.orderQty}주 매수</span>`;
  else if (h.orderQty < 0) orderCell = `<span class="order-negative">${h.orderQty}주 매도</span>`;
  else orderCell = `<span class="order-zero">-</span>`;

  // Expected ratio
  const expDiff = h.expectedRatio - h.target;
  const expCls = Math.abs(expDiff) <= 2 ? 'ok' : expDiff > 0 ? 'over' : 'under';

  const riskBadge = h.risk === '위험'
    ? `<span class="badge badge-risk">위험</span>`
    : `<span class="badge badge-safe">안전</span>`;

  return `
    <tr onclick="openEditHolding('${accountId}', '${h.id}')">
      <td>${riskBadge} ${esc(h.shortName || h.name)}</td>
      <td style="color:var(--text-muted)">${h.code}</td>
      <td style="text-align:right">${h.avgPrice > 0 ? fmt(h.avgPrice) + '원' : '-'}</td>
      <td class="sparkline-cell" onclick="event.stopPropagation()">
        <canvas id="spark-${h.id}" class="sparkline" width="80" height="30"></canvas>
      </td>
      <td style="text-align:right">${priceCell}</td>
      <td style="text-align:right">${profitCell}</td>
      <td style="text-align:right">${h.price > 0 ? fmt(h.value) + '원' : '-'}</td>
      <td style="text-align:right">
        <span style="background:#dbeafe;color:#1e40af;padding:2px 7px;border-radius:99px;font-size:11px;font-weight:700">${h.target}%</span>
      </td>
      <td class="ratio-cell">
        <div class="ratio-bar-wrap">
          <div class="ratio-bar-bg"><div class="ratio-bar ${barCls}" style="width:${barW}%"></div></div>
          <span class="ratio-text" style="color:${barCls === 'ok' ? 'var(--success)' : barCls === 'over' ? 'var(--up)' : 'var(--primary)'}">${h.currentRatio.toFixed(1)}%</span>
        </div>
      </td>
      <td style="text-align:right">${h.qty}주</td>
      <td style="text-align:right">${orderCell}</td>
      <td style="text-align:right">${h.price > 0 ? fmt(h.expectedValue) + '원' : '-'}</td>
      <td class="ratio-cell">
        <div class="ratio-bar-wrap">
          <div class="ratio-bar-bg"><div class="ratio-bar ${expCls}" style="width:${Math.min(100,(h.expectedRatio/(h.target||1))*100)}%"></div></div>
          <span class="ratio-text" style="color:${expCls === 'ok' ? 'var(--success)' : expCls === 'over' ? 'var(--up)' : 'var(--primary)'}">${h.expectedRatio.toFixed(1)}%</span>
        </div>
      </td>
    </tr>`;
}

// ── Sparkline ──────────────────────────────────────────────
function drawSparkline(canvas, data) {
  if (!data || data.length < 2) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const prices = data.map(d => d.close);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const pad = 2;

  ctx.clearRect(0, 0, W, H);

  const points = prices.map((p, i) => ({
    x: pad + (i / (prices.length - 1)) * (W - pad * 2),
    y: pad + (1 - (p - min) / range) * (H - pad * 2),
  }));

  // Fill
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  const isUp = prices[prices.length - 1] >= prices[0];
  const color = isUp ? '#ef4444' : '#3b82f6';
  grad.addColorStop(0, isUp ? 'rgba(239,68,68,0.2)' : 'rgba(59,130,246,0.2)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');

  ctx.beginPath();
  ctx.moveTo(points[0].x, H);
  points.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.lineTo(points[points.length - 1].x, H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  points.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ── Account CRUD ───────────────────────────────────────────
let _editingAccountId = null;

function openAddAccount() {
  _editingAccountId = null;
  document.getElementById('modal-account-title').textContent = '계좌 추가';
  document.getElementById('modal-account-name').value = '';
  document.getElementById('modal-account-invest').value = '250000';
  document.getElementById('modal-account').classList.remove('hidden');
}

function openEditAccount(id) {
  _editingAccountId = id;
  const account = state.accounts.find(a => a.id === id);
  if (!account) return;
  document.getElementById('modal-account-title').textContent = '계좌 편집';
  document.getElementById('modal-account-name').value = account.name;
  document.getElementById('modal-account-invest').value = account.investAmount || 0;
  document.getElementById('modal-account').classList.remove('hidden');
}

function closeAccountModal() {
  document.getElementById('modal-account').classList.add('hidden');
}

function saveAccount() {
  const name = document.getElementById('modal-account-name').value.trim();
  if (!name) { alert('계좌명을 입력하세요'); return; }
  const investAmount = parseInt(document.getElementById('modal-account-invest').value) || 0;

  if (_editingAccountId) {
    const account = state.accounts.find(a => a.id === _editingAccountId);
    if (account) { account.name = name; account.investAmount = investAmount; }
  } else {
    state.accounts.push({ id: uid(), name, investAmount, cash: 0, holdings: [] });
  }
  save();
  closeAccountModal();
  render();
}

function deleteAccount(id) {
  if (!confirm('이 계좌를 삭제하시겠습니까?')) return;
  state.accounts = state.accounts.filter(a => a.id !== id);
  save();
  render();
}

function updateCash(accountId, val) {
  const account = state.accounts.find(a => a.id === accountId);
  if (account) { account.cash = parseInt(val) || 0; save(); render(); }
}

function updateInvest(accountId, val) {
  const account = state.accounts.find(a => a.id === accountId);
  if (account) { account.investAmount = parseInt(val) || 0; save(); render(); }
}

// ── Holding CRUD ───────────────────────────────────────────
let _editingAccountForHolding = null;
let _editingHoldingId = null;

function openAddHolding(accountId) {
  _editingAccountForHolding = accountId;
  _editingHoldingId = null;
  document.getElementById('modal-holding-title').textContent = '종목 추가';
  document.getElementById('modal-holding-code').value = '';
  document.getElementById('modal-holding-name').value = '';
  document.getElementById('modal-holding-risk').value = '위험';
  document.getElementById('modal-holding-qty').value = '';
  document.getElementById('modal-holding-avgprice').value = '';
  document.getElementById('modal-holding-target').value = '';
  document.getElementById('modal-holding-manualprice').value = '';
  document.getElementById('lookup-result').textContent = '';
  document.getElementById('lookup-result').className = 'lookup-result';
  document.getElementById('btn-delete-holding').style.display = 'none';
  document.getElementById('modal-holding').classList.remove('hidden');
}

function openEditHolding(accountId, holdingId) {
  _editingAccountForHolding = accountId;
  _editingHoldingId = holdingId;
  const account = state.accounts.find(a => a.id === accountId);
  const h = account?.holdings.find(h => h.id === holdingId);
  if (!h) return;

  document.getElementById('modal-holding-title').textContent = '종목 편집';
  document.getElementById('modal-holding-code').value = h.code;
  document.getElementById('modal-holding-name').value = h.shortName || h.name;
  document.getElementById('modal-holding-risk').value = h.risk || '위험';
  document.getElementById('modal-holding-qty').value = h.qty;
  document.getElementById('modal-holding-avgprice').value = h.avgPrice;
  document.getElementById('modal-holding-target').value = h.target;
  document.getElementById('modal-holding-manualprice').value = state.manualPrices[h.code] || '';
  document.getElementById('lookup-result').textContent = h.name || '';
  document.getElementById('lookup-result').className = 'lookup-result ok';
  document.getElementById('btn-delete-holding').style.display = 'inline-block';
  document.getElementById('modal-holding').classList.remove('hidden');
}

function closeHoldingModal() {
  document.getElementById('modal-holding').classList.add('hidden');
}

async function lookupCode() {
  const code = document.getElementById('modal-holding-code').value.trim();
  if (code.length !== 6) { alert('6자리 종목 코드를 입력하세요'); return; }

  const el = document.getElementById('lookup-result');
  el.textContent = '조회 중...';
  el.className = 'lookup-result';

  try {
    const res = await fetch(`/api/price/${code}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (data.price > 0) {
      el.textContent = `✓ ${data.name} — 현재가: ${fmt(data.price)}원`;
      el.className = 'lookup-result ok';
      if (!document.getElementById('modal-holding-name').value) {
        document.getElementById('modal-holding-name').value = data.name?.substring(0, 20) || '';
      }
      state.prices[code] = data;
    } else {
      throw new Error('가격 정보 없음');
    }
  } catch (e) {
    el.textContent = `✗ 조회 실패: ${e.message}`;
    el.className = 'lookup-result err';
  }
}

function saveHolding() {
  const code = document.getElementById('modal-holding-code').value.trim();
  const name = document.getElementById('modal-holding-name').value.trim();
  const risk = document.getElementById('modal-holding-risk').value;
  const qty = parseInt(document.getElementById('modal-holding-qty').value) || 0;
  const avgPrice = parseInt(document.getElementById('modal-holding-avgprice').value) || 0;
  const target = parseFloat(document.getElementById('modal-holding-target').value) || 0;

  const manualPrice = parseInt(document.getElementById('modal-holding-manualprice').value) || 0;

  if (!code || code.length !== 6) { alert('올바른 종목 코드를 입력하세요'); return; }
  if (!name) { alert('종목명을 입력하세요'); return; }

  const account = state.accounts.find(a => a.id === _editingAccountForHolding);
  if (!account) return;

  // Update manual price override
  if (manualPrice > 0) state.manualPrices[code] = manualPrice;
  else delete state.manualPrices[code];

  if (_editingHoldingId) {
    const h = account.holdings.find(h => h.id === _editingHoldingId);
    if (h) { h.code = code; h.shortName = name; h.name = h.name || name; h.risk = risk; h.qty = qty; h.avgPrice = avgPrice; h.target = target; }
  } else {
    account.holdings.push({ id: uid(), code, name, shortName: name, risk, qty, avgPrice, target });
  }

  save();
  closeHoldingModal();
  render();
}

function deleteHolding() {
  if (!confirm('이 종목을 삭제하시겠습니까?')) return;
  const account = state.accounts.find(a => a.id === _editingAccountForHolding);
  if (account) {
    account.holdings = account.holdings.filter(h => h.id !== _editingHoldingId);
    save();
  }
  closeHoldingModal();
  render();
}

// ── Bulk Price Entry ───────────────────────────────────────
function openBulkPrice() {
  const allCodes = [...new Set(state.accounts.flatMap(a => a.holdings.map(h => h.code)))];
  const container = document.getElementById('bulk-price-fields');

  container.innerHTML = allCodes.map(code => {
    const holding = state.accounts.flatMap(a => a.holdings).find(h => h.code === code);
    const currentPrice = getPrice(code);
    const name = holding?.shortName || holding?.name || code;
    const manualVal = state.manualPrices[code] || '';
    return `
      <div class="form-group">
        <label>${esc(name)} (${code})</label>
        <div class="input-row">
          <input type="number" id="bulk-price-${code}" value="${manualVal || currentPrice || ''}"
            placeholder="현재가 입력 (원)" min="0" style="text-align:right"/>
          <span style="display:flex;align-items:center;font-size:12px;color:var(--text-muted);white-space:nowrap">
            ${currentPrice > 0 ? `API: ${fmt(currentPrice)}원` : 'API 없음'}
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
  const allCodes = [...new Set(state.accounts.flatMap(a => a.holdings.map(h => h.code)))];
  allCodes.forEach(code => {
    const val = parseInt(document.getElementById(`bulk-price-${code}`)?.value) || 0;
    if (val > 0) state.manualPrices[code] = val;
    else delete state.manualPrices[code];
  });
  save();
  closeBulkPrice();
  render();
}

// ── Export ─────────────────────────────────────────────────
function exportCSV() {
  const lines = ['계좌,종목코드,종목명,보유수,평단가,현재가,현재평가액,목표비율,현재비율,추가주문,예상평가액,예상비율'];
  state.accounts.forEach(account => {
    const { holdings } = calcAccount(account);
    holdings.forEach(h => {
      lines.push([
        account.name, h.code, h.shortName || h.name, h.qty, h.avgPrice,
        h.price, h.value, h.target + '%', h.currentRatio.toFixed(2) + '%',
        h.orderQty, h.expectedValue, h.expectedRatio.toFixed(2) + '%',
      ].join(','));
    });
  });
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `portfolio_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Utilities ──────────────────────────────────────────────
function fmt(n) {
  if (!n && n !== 0) return '-';
  return Math.round(n).toLocaleString('ko-KR');
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Event Wiring ───────────────────────────────────────────
function init() {
  load();

  document.getElementById('btn-add-account').addEventListener('click', openAddAccount);
  document.getElementById('btn-bulk-price').addEventListener('click', openBulkPrice);
  document.getElementById('btn-cancel-bulk').addEventListener('click', closeBulkPrice);
  document.getElementById('btn-save-bulk').addEventListener('click', saveBulkPrices);
  document.querySelector('#modal-bulk-price .modal-backdrop').addEventListener('click', closeBulkPrice);

  document.getElementById('btn-refresh').addEventListener('click', async () => {
    const codes = [...new Set(state.accounts.flatMap(a => a.holdings.map(h => h.code)))];
    await fetchPrices(codes);
    render();
  });
  document.getElementById('btn-export').addEventListener('click', exportCSV);

  // Account modal
  document.getElementById('btn-save-account').addEventListener('click', saveAccount);
  document.getElementById('btn-cancel-account').addEventListener('click', closeAccountModal);
  document.querySelector('#modal-account .modal-backdrop').addEventListener('click', closeAccountModal);

  // Holding modal
  document.getElementById('btn-lookup-code').addEventListener('click', lookupCode);
  document.getElementById('btn-save-holding').addEventListener('click', saveHolding);
  document.getElementById('btn-cancel-holding').addEventListener('click', closeHoldingModal);
  document.getElementById('btn-delete-holding').addEventListener('click', deleteHolding);
  document.querySelector('#modal-holding .modal-backdrop').addEventListener('click', closeHoldingModal);

  // Enter to lookup
  document.getElementById('modal-holding-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') lookupCode();
  });

  // Initial render
  render();

  // Auto-fetch prices on load
  const codes = [...new Set(state.accounts.flatMap(a => a.holdings.map(h => h.code)))];
  if (codes.length > 0) fetchPrices(codes).then(render);

  // Refresh every 5 minutes
  setInterval(async () => {
    const c = [...new Set(state.accounts.flatMap(a => a.holdings.map(h => h.code)))];
    if (c.length > 0) { await fetchPrices(c); render(); }
  }, 5 * 60 * 1000);
}

document.addEventListener('DOMContentLoaded', init);
