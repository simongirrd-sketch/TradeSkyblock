// ===== NPC FLIP =====
// Achète au Bazaar, revend au PNJ pour profit garanti

const ITEMS_API = 'https://api.hypixel.net/v2/resources/skyblock/items';

// ===== DOM =====
const npcBtn        = document.getElementById('npcAnalyzeBtn');
const npcBtnText    = document.getElementById('npcBtnText');
const npcBtnIcon    = document.getElementById('npcBtnIcon');
const npcStatusBar  = document.getElementById('npcStatusBar');
const npcStatusText = document.getElementById('npcStatusText');
const npcErrorBox   = document.getElementById('npcErrorBox');

function npcSetStatus(msg) { npcStatusBar.classList.remove('hidden'); npcStatusText.textContent = msg; }
function npcHideStatus()   { npcStatusBar.classList.add('hidden'); }
function npcShowError(msg) { npcErrorBox.textContent = msg; npcErrorBox.classList.remove('hidden'); }
function npcClearError()   { npcErrorBox.classList.add('hidden'); }
function npcShow(id)       { document.getElementById(id).classList.remove('hidden'); }

// ===== FETCH NPC PRICES =====
async function fetchNpcPrices() {
  npcSetStatus('Récupération des prix PNJ...');
  const res  = await fetch(ITEMS_API);
  if (!res.ok) throw new Error('Impossible de charger les items Skyblock.');
  const data = await res.json();
  if (!data.success) throw new Error('Erreur API items.');

  // Build map: item_id → { name, npc_sell_price }
  const map = {};
  for (const item of data.items) {
    if (item.npc_sell_price && item.npc_sell_price > 1) {
      map[item.id] = { name: item.name, npcPrice: item.npc_sell_price };
    }
  }
  return map;
}

// ===== PROCESS NPC FLIPS =====
function processNPC(npcMap, products, budget, minProfit, maxQty) {
  const flips = [];

  for (const [id, product] of Object.entries(products)) {
    const npcItem = npcMap[id];
    if (!npcItem) continue;

    // Price you pay to buy from Bazaar (lowest ask)
    const bazaarBuyPrice = product.buy_summary?.[0]?.pricePerUnit;
    if (!bazaarBuyPrice || bazaarBuyPrice <= 0) continue;

    const npcPrice   = npcItem.npcPrice;
    const profit     = npcPrice - bazaarBuyPrice;
    const margin     = (profit / npcPrice) * 100;

    if (profit <= 0 || margin < 1) continue; // Bazaar price already above NPC

    // Max qty: don't spend more than 30% budget per item, don't exceed volume
    const qs        = product.quick_status;
    const weeklyVol = qs?.buyMovingWeek || 0;
    const marketCap = Math.max(1, Math.floor(weeklyVol * 0.02));
    const canAfford = Math.max(1, Math.floor((budget * 0.3) / bazaarBuyPrice));
    const rawQty    = Math.min(marketCap, canAfford);
    const qty       = maxQty ? Math.min(rawQty, maxQty) : rawQty;

    const totalInvest = qty * bazaarBuyPrice;
    const totalProfit = qty * profit;

    if (totalProfit < minProfit) continue;

    flips.push({
      id,
      name:        npcItem.name,
      bazaarPrice: bazaarBuyPrice,
      npcPrice,
      profit,
      margin,
      qty,
      totalInvest,
      totalProfit,
      weeklyVol,
    });
  }

  flips.sort((a, b) => b.totalProfit - a.totalProfit);
  return flips;
}

// ===== RENDER =====
function renderNPCStats(flips) {
  npcShow('npcStatsSection');
  const best = flips[0];
  document.getElementById('npcStatsGrid').innerHTML = `
    <div class="stat-card"><div class="stat-label">Flips trouvés</div><div class="stat-value green">${flips.length}</div></div>
    <div class="stat-card"><div class="stat-label">Meilleur profit/u</div><div class="stat-value yellow">${best ? fmt(best.profit) : '—'}</div></div>
    <div class="stat-card"><div class="stat-label">Meilleure marge</div><div class="stat-value blue">${best ? pct(best.margin) : '—'}</div></div>
    <div class="stat-card"><div class="stat-label">Profit total max</div><div class="stat-value green">${best ? '+' + fmt(best.totalProfit) : '—'}</div></div>
  `;
}

function renderNPCResults(flips) {
  if (!flips.length) return;
  npcShow('npcResultsSection');

  document.getElementById('npcResultsBody').innerHTML = flips.slice(0, 30).map((f, i) => `
    <tr class="${i < 3 ? 'rank-' + (i+1) : ''}">
      <td style="font-weight:700;color:var(--muted)">${i + 1}</td>
      <td style="font-weight:600">${f.name}</td>
      <td class="price red">${fmt(f.bazaarPrice)}</td>
      <td class="price green">${fmt(f.npcPrice)}</td>
      <td class="price green">+${fmt(f.profit)}</td>
      <td class="price yellow">${pct(f.margin)}</td>
      <td class="price blue">${f.qty.toLocaleString('fr-FR')}</td>
      <td class="price">${fmt(f.totalInvest)}</td>
      <td class="price green">+${fmt(f.totalProfit)}</td>
      <td style="color:var(--muted);font-size:0.8rem">${fmt(f.weeklyVol)}/sem</td>
    </tr>
  `).join('');
}

// ===== MAIN =====
npcBtn.addEventListener('click', async () => {
  npcClearError();
  document.getElementById('npcStatsSection').classList.add('hidden');
  document.getElementById('npcResultsSection').classList.add('hidden');

  const budget    = parseFloat(document.getElementById('npcBudget').value) || Infinity;
  const minProfit = parseInt(document.getElementById('npcMinProfit').value);
  const maxQty    = parseInt(document.getElementById('maxQtyNPC').value) || 0;

  npcBtn.disabled = true;
  npcBtnText.textContent = 'Analyse en cours...';
  npcBtnIcon.textContent = '⏳';

  try {
    const [npcMap, bazaarData] = await Promise.all([
      fetchNpcPrices(),
      (async () => {
        npcSetStatus('Récupération du Bazaar...');
        const r = await fetch(BAZAAR_API);
        const d = await r.json();
        if (!d.success) throw new Error('API Bazaar indisponible.');
        return d.products;
      })()
    ]);

    npcSetStatus('Calcul des opportunités...');
    const flips = processNPC(npcMap, bazaarData, budget, minProfit, maxQty);

    renderNPCStats(flips);
    renderNPCResults(flips);
    npcHideStatus();

    if (!flips.length) {
      npcShowError('Aucun flip PNJ trouvé. Les prix Bazaar sont actuellement au-dessus des prix PNJ pour la plupart des items.');
    }

  } catch (err) {
    npcHideStatus();
    npcShowError('Erreur : ' + err.message);
  } finally {
    npcBtn.disabled = false;
    npcBtnText.textContent = 'Analyser les flips PNJ';
    npcBtnIcon.textContent = '🏪';
  }
});

// Persist
window.addEventListener('load', () => {
  const s = localStorage.getItem('ts_npc_budget');
  if (s) document.getElementById('npcBudget').value = s;
});
document.getElementById('npcBudget').addEventListener('change', e => localStorage.setItem('ts_npc_budget', e.target.value));

// Helper shared from app.js
function pct(n) { return n.toFixed(1) + '%'; }
