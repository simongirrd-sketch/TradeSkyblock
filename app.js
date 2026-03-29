// ===== CONSTANTS =====
const BAZAAR_API = 'https://api.hypixel.net/v2/skyblock/bazaar';
const EXCLUDE_PATTERNS = ['ENCHANTED_BOOK', 'RUNE_', 'PET_ITEM_', 'DUNGEON_'];

// ===== DOM REFS =====
const analyzeBtn = document.getElementById('analyzeBtn');
const btnText    = document.getElementById('btnText');
const btnIcon    = document.getElementById('btnIcon');
const statusBar  = document.getElementById('statusBar');
const statusText = document.getElementById('statusText');
const errorBox   = document.getElementById('errorBox');

// ===== HELPERS =====
function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return '—';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000)     return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)         return (n / 1_000).toFixed(1) + 'k';
  return Math.round(n).toLocaleString('fr-FR');
}
function pct(n) { return n.toFixed(1) + '%'; }
function cleanName(id) {
  return id.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
function setStatus(msg) { statusBar.classList.remove('hidden'); statusText.textContent = msg; }
function hideStatus()   { statusBar.classList.add('hidden'); }
function showError(msg) { errorBox.textContent = msg; errorBox.classList.remove('hidden'); }
function clearError()   { errorBox.classList.add('hidden'); errorBox.textContent = ''; }
function showSection(id){ document.getElementById(id).classList.remove('hidden'); }

// ===== FETCH BAZAAR =====
async function fetchBazaar() {
  setStatus('Récupération des données du Bazaar Hypixel...');
  const res = await fetch(BAZAAR_API);
  if (!res.ok) throw new Error(`Erreur API Hypixel: ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error('L\'API Hypixel a retourné une erreur.');
  return data.products;
}

// ===== PROCESS ITEMS =====
function processBazaar(products, budget, strategy, riskLevel) {
  const items = [];

  for (const [id, product] of Object.entries(products)) {
    if (EXCLUDE_PATTERNS.some(p => id.includes(p))) continue;
    const qs = product.quick_status;
    if (!qs) continue;

    // Hypixel API naming (counterintuitive):
    //   buy_summary[0]  = lowest ASK  (qs.buyPrice)  = prix minimum auquel quelqu'un vend
    //   sell_summary[0] = highest BID (qs.sellPrice) = prix maximum auquel quelqu'un achète
    const liveAsk = product.buy_summary?.[0]?.pricePerUnit;  // lowest sell order in market
    const liveBid = product.sell_summary?.[0]?.pricePerUnit; // highest buy order in market

    if (!liveAsk || !liveBid || liveAsk <= 0 || liveBid <= 0) continue;
    if (liveAsk <= liveBid) continue; // no spread (shouldn't happen in live market)

    // To flip: place buy order just above current top bid, sell order just below current lowest ask
    const buyOrderPrice  = Math.round((liveBid + 0.1) * 10) / 10;
    const sellOrderPrice = Math.round((liveAsk - 0.1) * 10) / 10;

    const profitPerUnit = sellOrderPrice - buyOrderPrice;
    const margin        = (profitPerUnit / sellOrderPrice) * 100;

    if (profitPerUnit <= 0 || margin < 0.5) continue;

    const buyVol = qs.buyMovingWeek;
    const sellVol = qs.sellMovingWeek;
    const minVol = Math.min(buyVol, sellVol);
    if (minVol < 200) continue;

    // Cap margin at 60% — above that is likely bad/manipulated data
    if (margin > 60) continue;

    // Risk
    const volRatio = buyVol / (sellVol || 1);
    let risk = 'low';
    if (margin > 20 || volRatio > 3 || volRatio < 0.33) risk = 'high';
    else if (margin > 10 || volRatio > 2 || volRatio < 0.5) risk = 'medium';

    if (riskLevel === 'low'    && risk !== 'low')    continue;
    if (riskLevel === 'medium' && risk === 'high')   continue;

    const score = margin * Math.log10(minVol + 1);

    items.push({
      id, name: cleanName(id),
      buyOrderPrice, sellOrderPrice,
      profitPerUnit, margin,
      buyVol, sellVol, minVol, risk, score
    });
  }

  items.sort((a, b) => b.score - a.score);
  return items;
}

// ===== BUILD INVESTMENT PLAN =====
function buildPlan(items, budget, maxItems, maxQty) {
  const top = items.slice(0, maxItems);
  if (top.length === 0) return [];

  // Weight each item by score for budget allocation
  const totalScore = top.reduce((s, it) => s + it.score, 0);

  return top.map((it, i) => {
    // Budget share proportional to score, capped at 40%
    const rawShare  = it.score / totalScore;
    const capShare  = Math.min(rawShare, 0.40);
    const allocated = budget * capShare;

    // How many units to buy without crashing market (max 2% weekly volume)
    const marketCap  = Math.floor(it.minVol * 0.02);
    const canAfford  = Math.floor(allocated / it.buyOrderPrice);
    const rawQty     = Math.max(1, Math.min(marketCap, canAfford));
    const qty        = maxQty ? Math.min(rawQty, maxQty) : rawQty;

    const numOrders   = 1;
    const qtyPerOrder = qty;

    const totalInvest = qty * it.buyOrderPrice;
    const totalProfit = qty * it.profitPerUnit;
    const roi         = (totalProfit / totalInvest) * 100;
    const pctBudget   = (totalInvest / budget) * 100;

    return { ...it, qty, numOrders, qtyPerOrder, totalInvest, totalProfit, roi, pctBudget };
  });
}

// ===== MARKET STATS =====
function computeStats(products) {
  let totalItems = 0, activeFlips = 0, bestMargin = 0, totalVolume = 0;
  for (const [, p] of Object.entries(products)) {
    const qs = p.quick_status;
    if (!qs) continue;
    totalItems++;
    totalVolume += qs.buyMovingWeek || 0;
    const spread = qs.buyPrice - qs.sellPrice;
    if (spread > 0 && qs.buyPrice > 0) {
      const m = (spread / qs.buyPrice) * 100;
      if (m > 1) activeFlips++;
      if (m > bestMargin) bestMargin = m;
    }
  }
  return { totalItems, activeFlips, bestMargin, totalVolume };
}

// ===== RENDER STATS =====
function renderStats(stats, budget) {
  showSection('marketOverview');
  document.getElementById('statsGrid').innerHTML = `
    <div class="stat-card"><div class="stat-label">Items total</div><div class="stat-value blue">${stats.totalItems.toLocaleString('fr-FR')}</div></div>
    <div class="stat-card"><div class="stat-label">Flips actifs</div><div class="stat-value green">${stats.activeFlips.toLocaleString('fr-FR')}</div></div>
    <div class="stat-card"><div class="stat-label">Meilleure marge</div><div class="stat-value yellow">${pct(stats.bestMargin)}</div></div>
    <div class="stat-card"><div class="stat-label">Volume hebdo</div><div class="stat-value purple">${fmt(stats.totalVolume)}</div></div>
    <div class="stat-card"><div class="stat-label">Ton budget</div><div class="stat-value blue">${fmt(budget)}</div></div>
  `;
}

// ===== RENDER PLAN =====
function renderPlan(plan, budget) {
  if (!plan.length) return;
  showSection('planSection');

  const totalInvest = plan.reduce((s, p) => s + p.totalInvest, 0);
  const totalProfit = plan.reduce((s, p) => s + p.totalProfit, 0);
  const remaining   = budget - totalInvest;
  const globalROI   = (totalProfit / totalInvest) * 100;

  // Summary bar
  document.getElementById('planSummary').innerHTML = `
    <div class="summary-row">
      <div class="summary-item">
        <div class="summary-label">Budget total</div>
        <div class="summary-val blue">${fmt(budget)}</div>
      </div>
      <div class="summary-item">
        <div class="summary-label">Investi</div>
        <div class="summary-val yellow">${fmt(totalInvest)}</div>
      </div>
      <div class="summary-item">
        <div class="summary-label">Reste en poche</div>
        <div class="summary-val">${fmt(remaining)}</div>
      </div>
      <div class="summary-item">
        <div class="summary-label">Profit attendu</div>
        <div class="summary-val green">+${fmt(totalProfit)}</div>
      </div>
      <div class="summary-item">
        <div class="summary-label">ROI global</div>
        <div class="summary-val green">${pct(globalROI)}</div>
      </div>
    </div>
    <div class="budget-bar-wrap">
      ${plan.map((p, i) => `<div class="budget-seg seg-${i}" style="width:${p.pctBudget.toFixed(1)}%" title="${p.name}: ${fmt(p.totalInvest)}"></div>`).join('')}
      <div class="budget-seg seg-rest" style="width:${((remaining/budget)*100).toFixed(1)}%" title="Disponible: ${fmt(remaining)}"></div>
    </div>
    <div class="budget-legend">
      ${plan.map((p, i) => `<span class="legend-dot dot-${i}"></span><span>${p.name}</span>`).join('')}
      <span class="legend-dot dot-rest"></span><span>Disponible</span>
    </div>
  `;

  // Item cards
  document.getElementById('planItems').innerHTML = plan.map((p, i) => `
    <div class="plan-card card">
      <div class="plan-card-header">
        <div class="plan-rank rank-color-${i}">#${i + 1}</div>
        <div class="plan-name">${p.name}</div>
        <div class="plan-badge-risk badge-risk ${p.risk}">${p.risk === 'low' ? 'Faible' : p.risk === 'medium' ? 'Moyen' : 'Élevé'}</div>
        <div class="plan-pct">${pct(p.pctBudget)} du budget</div>
      </div>

      <div class="plan-details">

        <div class="detail-block">
          <div class="detail-title">Prix</div>
          <div class="detail-row"><span>Ton buy order à placer</span><strong>${fmt(p.buyOrderPrice)} coins</strong></div>
          <div class="detail-row"><span>Ton sell order à placer</span><strong>${fmt(p.sellOrderPrice)} coins</strong></div>
          <div class="detail-row"><span>Profit par unité</span><strong class="green">+${fmt(p.profitPerUnit)} coins</strong></div>
          <div class="detail-row"><span>Marge</span><strong class="yellow">${pct(p.margin)}</strong></div>
        </div>

        <div class="detail-block">
          <div class="detail-title">Quantité &amp; Ordres</div>
          <div class="detail-row"><span>Quantité à acheter</span><strong class="blue">${p.qty.toLocaleString('fr-FR')} unités</strong></div>
          <div class="detail-row"><span>Volume hebdo dispo</span><strong>${fmt(p.minVol)}</strong></div>
        </div>

        <div class="detail-block">
          <div class="detail-title">Résultat attendu</div>
          <div class="detail-row"><span>Total investi</span><strong>${fmt(p.totalInvest)} coins</strong></div>
          <div class="detail-row"><span>Profit total</span><strong class="green">+${fmt(p.totalProfit)} coins</strong></div>
          <div class="detail-row"><span>ROI</span><strong class="green">${pct(p.roi)}</strong></div>
        </div>

        <div class="detail-block how-to">
          <div class="detail-title">Comment faire</div>
          <ol>
            <li>Ouvre le Bazaar → cherche <strong>${p.name}</strong></li>
            <li>Clique sur <em>Buy Commodities</em> → <em>Create Buy Order</em></li>
            <li>Prix : <strong>${fmt(p.buyOrderPrice)} coins</strong> par unité</li>
            <li>Quantité : <strong>${p.qty.toLocaleString('fr-FR')}</strong> unités</li>
            <li>Attends que l'ordre se remplisse, puis place un <em>Sell Order</em> à <strong>${fmt(p.sellOrderPrice)} coins</strong></li>
          </ol>
        </div>

      </div>
    </div>
  `).join('');
}

// ===== RENDER RAW DATA =====
function renderRaw(products) {
  showSection('rawSection');
  const entries = Object.entries(products)
    .map(([id, p]) => ({ id, qs: p.quick_status }))
    .filter(e => e.qs && e.qs.buyMovingWeek > 0)
    .sort((a, b) => (b.qs.buyMovingWeek + b.qs.sellMovingWeek) - (a.qs.buyMovingWeek + a.qs.sellMovingWeek))
    .slice(0, 50);

  document.getElementById('rawBody').innerHTML = entries.map(({ id, qs }) => {
    const spread = qs.buyPrice - qs.sellPrice;
    const spreadPct = qs.buyPrice > 0 ? pct(spread / qs.buyPrice * 100) : '—';
    return `<tr>
      <td style="font-weight:600">${cleanName(id)}</td>
      <td class="price">${fmt(qs.sellPrice)}</td>
      <td class="price">${fmt(qs.buyPrice)}</td>
      <td class="price blue">${fmt(qs.buyMovingWeek)}</td>
      <td class="price blue">${fmt(qs.sellMovingWeek)}</td>
      <td class="price ${spread > 0 ? 'green' : 'red'}">${spreadPct}</td>
    </tr>`;
  }).join('');

  document.getElementById('toggleRaw').addEventListener('click', () => {
    const raw = document.getElementById('rawData');
    const btn = document.getElementById('toggleRaw');
    raw.classList.toggle('hidden');
    btn.textContent = raw.classList.contains('hidden') ? 'Afficher' : 'Masquer';
  });
}

// ===== MAIN =====
analyzeBtn.addEventListener('click', async () => {
  clearError();
  const budget   = parseFloat(document.getElementById('budget').value);
  const strategy = document.getElementById('strategy').value;
  const risk     = document.getElementById('riskLevel').value;
  const maxItems = parseInt(document.getElementById('maxItems').value);
  const maxQty   = parseInt(document.getElementById('maxQtyBazaar').value) || 0;

  if (!budget || budget < 1000) { showError('Entre un budget valide (minimum 1 000 coins).'); return; }

  analyzeBtn.disabled = true;
  btnText.textContent = 'Analyse en cours...';
  btnIcon.textContent = '⏳';
  ['marketOverview', 'planSection', 'rawSection'].forEach(id => document.getElementById(id).classList.add('hidden'));

  try {
    const products = await fetchBazaar();

    setStatus('Calcul des opportunités...');
    const stats = computeStats(products);
    renderStats(stats, budget);

    const items = processBazaar(products, budget, strategy, risk);
    if (!items.length) { showError('Aucune opportunité trouvée. Essaie un autre niveau de risque.'); hideStatus(); return; }

    const plan = buildPlan(items, budget, maxItems, maxQty);
    renderPlan(plan, budget);
    renderRaw(products);
    hideStatus();

  } catch (err) {
    hideStatus();
    showError('Erreur : ' + err.message);
  } finally {
    analyzeBtn.disabled = false;
    btnText.textContent = 'Analyser le Bazaar';
    btnIcon.textContent = '⚡';
  }
});

// ===== OPTIONS TOGGLE =====
function toggleOptions(id) {
  const el = document.getElementById(id);
  el.classList.toggle('hidden');
  // Update button text
  const btn = el.previousElementSibling;
  btn.textContent = el.classList.contains('hidden') ? 'Options ▼' : 'Options ▲';
}

// ===== TAB SWITCHING =====
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    document.getElementById('tab-bazaar').classList.toggle('hidden', target !== 'bazaar');
    document.getElementById('tab-ah').classList.toggle('hidden', target !== 'ah');
    document.getElementById('tab-npc').classList.toggle('hidden', target !== 'npc');
  });
});

// Persist budget
window.addEventListener('load', () => {
  const saved = localStorage.getItem('ts_budget');
  if (saved) document.getElementById('budget').value = saved;
});
document.getElementById('budget').addEventListener('change', e => localStorage.setItem('ts_budget', e.target.value));
