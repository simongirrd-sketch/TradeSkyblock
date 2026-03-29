// ===== CONSTANTS =====
const BAZAAR_API = 'https://api.hypixel.net/v2/skyblock/bazaar';
const ITEMS_API  = 'https://api.hypixel.net/v2/resources/skyblock/items';

// Hypixel per-order limit: 256 for special items, 71680 for everything else
const SPECIAL_ORDER_LIMIT = new Set([
  'BOOSTER_COOKIE','HOT_POTATO_BOOK','FUMING_POTATO_BOOK','SUMMONING_EYE',
  'RECOMBOBULATOR_3000','MUSIC_RUNE_1','TITANIC_EXP_BOTTLE',
  'JUMBO_BACKPACK','LARGE_BACKPACK','MEDIUM_BACKPACK','SMALL_BACKPACK','GREATER_BACKPACK',
  'ENDER_CHEST','EMERALD_BLADE','LIVID_DAGGER','CENTURY_CAKE','NEW_YEAR_CAKE',
  'HALLOWEEN_BASKET','PERSONAL_COMPACTOR_4000','PERSONAL_COMPACTOR_5000',
  'PERSONAL_COMPACTOR_6000','PERSONAL_COMPACTOR_7000',
  'PERSONAL_DELETOR_4000','PERSONAL_DELETOR_5000',
  'PERSONAL_DELETOR_6000','PERSONAL_DELETOR_7000',
  'MINION_EXPANDER','HYPER_CATALYST','CATALYST','SUPER_CATALYST',
  'TRAVEL_SCROLL_TO_CRYSTAL_HOLLOWS','TRAVEL_SCROLL_TO_THE_END',
  'TRAVEL_SCROLL_TO_DWARVEN_MINES','TRAVEL_SCROLL_TO_DEEP_CAVERNS',
  'TRAVEL_SCROLL_TO_SPIDERS_DEN','TRAVEL_SCROLL_TO_GOLD_MINE',
  'TRAVEL_SCROLL_TO_THE_BARN','TRAVEL_SCROLL_TO_MUSHROOM_DESERT',
  'TRAVEL_SCROLL_TO_THE_FARMING_ISLANDS','TRAVEL_SCROLL_TO_JERRY_WORKSHOP',
  'TRAVEL_SCROLL_TO_PARK',
]);

function getOrderCap(id) { return SPECIAL_ORDER_LIMIT.has(id) ? 256 : 71680; }

// Manipulation detection (adaptive formula from bazaarflip.ianrenton.com)
// For expensive items: spread > 20% = suspicious
// For cheap items: much higher tolerance to avoid false positives
function isManipulated(buyOrder, sellOffer) {
  return sellOffer > buyOrder + buyOrder * (100 / (buyOrder + 12) + 0.2);
}

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
  return n.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
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

// ===== FETCH =====
async function fetchBazaar() {
  setStatus('Récupération des données du Bazaar...');
  const res = await fetch(BAZAAR_API);
  if (!res.ok) throw new Error(`Erreur API Bazaar: ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error('API Hypixel : erreur Bazaar');
  return data.products;
}

async function fetchNpcPrices() {
  try {
    const res = await fetch(ITEMS_API);
    if (!res.ok) return {};
    const data = await res.json();
    const prices = {};
    for (const item of (data.items || [])) {
      if (item.id && item.npc_sell_price) prices[item.id] = item.npc_sell_price;
    }
    return prices;
  } catch { return {}; }
}

// ===== PROCESS BAZAAR =====
function processBazaar(products, npcPrices, opts) {
  const { budget, maxItems, maxBacklog, maxQtyUser, includeEnchantments, removeManipulated: filterManip, npcOnly, sortBy } = opts;

  const profitable    = [];
  const notProfitable = [];
  const notAffordable = [];
  const backlogTooLong = [];
  const manipulated   = [];
  const enchantments  = [];

  for (const [id, product] of Object.entries(products)) {
    const qs = product.quick_status;
    if (!qs) continue;

    const name = cleanName(id);

    // Enchantment filter
    if (!includeEnchantments && name.toLowerCase().startsWith('enchantment ')) {
      enchantments.push({ id, name });
      continue;
    }

    // Need live order book data
    // buy_summary  = current sell offers (lowest ask = what you pay to buy instantly)
    // sell_summary = current buy orders  (highest bid = what you get selling instantly)
    const lowestSellOffer = product.buy_summary?.[0]?.pricePerUnit;
    const highestBuyOrder = product.sell_summary?.[0]?.pricePerUnit;
    if (!lowestSellOffer || !highestBuyOrder || lowestSellOffer <= 0 || highestBuyOrder <= 0) continue;

    // Place orders just inside the spread (1-tick undercut strategy)
    const buyPrice  = Math.round((highestBuyOrder + 0.1) * 10) / 10;
    let   sellPrice = Math.round((lowestSellOffer  - 0.1) * 10) / 10;
    let   isNpc     = false;

    // NPC override: if NPC pays more than bazaar sell price, sell to NPC instead
    const npcPrice = npcPrices[id] || 0;
    if (npcPrice > 0 && npcPrice >= sellPrice) {
      sellPrice = npcPrice;
      isNpc = true;
    }

    const profitPerItem = sellPrice - buyPrice;

    // Filter: not profitable
    if (profitPerItem < 0.1) {
      notProfitable.push({ id, name, profitPerItem });
      continue;
    }

    // Filter: can't afford even 1
    const orderCap  = getOrderCap(id);
    const canAfford = Math.floor(budget / buyPrice);
    if (canAfford < 1) {
      notAffordable.push({ id, name, buyPrice });
      continue;
    }

    // Sales backlog = (units currently for sale) / (units sold per day)
    // buy_summary = sell offers in market = what's available to buy
    const sellVolume     = (product.buy_summary || []).reduce((s, o) => s + o.amount, 0);
    const sellMovingWeek = qs.sellMovingWeek || 0;
    const backlog        = sellMovingWeek > 0 ? sellVolume / (sellMovingWeek / 7) : Infinity;

    // Filter: backlog too long (NPC items skip this — no buyer needed)
    if (!isNpc && maxBacklog < 999 && backlog > maxBacklog) {
      backlogTooLong.push({ id, name, backlog });
      continue;
    }

    // Filter: manipulation detection
    if (filterManip && isManipulated(highestBuyOrder, lowestSellOffer)) {
      manipulated.push({ id, name });
      continue;
    }

    // Filter: NPC only
    if (npcOnly && !isNpc) continue;

    // Quantity: capped by budget, Hypixel order limit, and optional user limit
    let maxQty = Math.min(canAfford, orderCap);
    if (maxQtyUser > 0) maxQty = Math.min(maxQty, maxQtyUser);

    const numOrders  = Math.ceil(maxQty / orderCap);
    const totalProfit = profitPerItem * maxQty;
    const totalInvest = buyPrice * maxQty;
    const margin      = (profitPerItem / sellPrice) * 100;

    profitable.push({
      id, name, buyPrice, sellPrice, profitPerItem, margin,
      backlog, isNpc, maxQty, numOrders, totalProfit, totalInvest,
      orderCap, sellMovingWeek
    });
  }

  // Sort
  switch (sortBy) {
    case 'profitPerItem': profitable.sort((a, b) => b.profitPerItem - a.profitPerItem); break;
    case 'backlog':       profitable.sort((a, b) => (a.backlog === Infinity ? 9999 : a.backlog) - (b.backlog === Infinity ? 9999 : b.backlog)); break;
    case 'name':          profitable.sort((a, b) => a.name.localeCompare(b.name)); break;
    default:              profitable.sort((a, b) => b.totalProfit - a.totalProfit); break;
  }

  return {
    items: profitable.slice(0, maxItems),
    excluded: { notProfitable, notAffordable, backlogTooLong, manipulated, enchantments }
  };
}

// ===== RENDER RESULTS =====
function renderResults(items, budget) {
  showSection('planSection');

  const bestProfit = items[0]?.totalProfit || 0;
  const bestPPU    = items[0]?.profitPerItem || 0;

  document.getElementById('planSummary').innerHTML = `
    <div class="summary-row">
      <div class="summary-item">
        <div class="summary-label">Budget</div>
        <div class="summary-val blue">${fmt(budget)}</div>
      </div>
      <div class="summary-item">
        <div class="summary-label">Opportunités trouvées</div>
        <div class="summary-val">${items.length}</div>
      </div>
      <div class="summary-item">
        <div class="summary-label">Meilleur profit total</div>
        <div class="summary-val green">+${fmt(bestProfit)}</div>
      </div>
      <div class="summary-item">
        <div class="summary-label">Meilleur profit/item</div>
        <div class="summary-val yellow">+${fmt(bestPPU)}</div>
      </div>
    </div>
  `;

  document.getElementById('planItems').innerHTML = items.map((item, i) => {
    const backlogStr   = item.isNpc ? 'N/A' : (item.backlog === Infinity ? '∞' : item.backlog.toFixed(1) + 'j');
    const backlogClass = item.isNpc ? 'muted' : (item.backlog < 1 ? 'green' : item.backlog < 3 ? 'yellow' : item.backlog > 14 ? 'red' : '');
    const sellStr      = item.isNpc
      ? `${fmt(item.sellPrice)} <span class="npc-badge">PNJ</span>`
      : fmt(item.sellPrice);
    return `<tr>
      <td style="font-weight:700;color:var(--muted)">${i + 1}</td>
      <td style="font-weight:700;white-space:normal">${item.name}</td>
      <td class="price ${backlogClass}">${backlogStr}</td>
      <td class="price">${fmt(item.buyPrice)}</td>
      <td class="price">${sellStr}</td>
      <td class="price green">+${fmt(item.profitPerItem)}</td>
      <td class="price blue">${item.maxQty.toLocaleString('fr-FR')}</td>
      <td class="price">${item.numOrders}</td>
      <td class="price green" style="font-weight:700">+${fmt(item.totalProfit)}</td>
    </tr>`;
  }).join('');
}

// ===== RENDER EXCLUDED =====
function renderExcluded(excluded) {
  const { notProfitable, notAffordable, backlogTooLong, manipulated, enchantments } = excluded;

  const sections = [
    {
      title: 'Pas rentables',
      items: notProfitable.sort((a, b) => a.profitPerItem - b.profitPerItem).slice(0, 30),
      extra: i => `${fmt(i.profitPerItem)} coins/item`
    },
    {
      title: 'Pas les moyens',
      items: notAffordable.sort((a, b) => b.buyPrice - a.buyPrice).slice(0, 30),
      extra: i => `${fmt(i.buyPrice)} coins/item`
    },
    {
      title: 'Backlog trop long',
      items: backlogTooLong.sort((a, b) => b.backlog - a.backlog).slice(0, 30),
      extra: i => `${i.backlog === Infinity ? '∞' : i.backlog.toFixed(1)} jours`
    },
    {
      title: 'Items manipulés (exclus)',
      items: manipulated.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 30),
      extra: () => ''
    },
    {
      title: 'Enchantements (exclus)',
      items: enchantments.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 30),
      extra: () => ''
    },
  ].filter(s => s.items.length > 0);

  if (!sections.length) return;
  showSection('excludedSection');

  document.getElementById('excludedContent').innerHTML = sections.map(s => `
    <details class="excluded-group">
      <summary class="excluded-summary">${s.title} <span class="excluded-count">${s.items.length}${s.items.length === 30 ? '+' : ''}</span></summary>
      <ul class="excluded-list">
        ${s.items.map(i => `<li>${i.name}${s.extra(i) ? ` — <span class="muted">${s.extra(i)}</span>` : ''}</li>`).join('')}
      </ul>
    </details>
  `).join('');
}

// ===== SETTINGS PERSISTENCE =====
const SETTINGS_KEYS = ['maxItems','maxBacklog','maxQtyBazaar','sortBy','includeEnchantments','removeManipulated','npcOnly'];

function saveSettings() {
  SETTINGS_KEYS.forEach(k => {
    const el = document.getElementById(k);
    if (!el) return;
    localStorage.setItem('ts_' + k, el.type === 'checkbox' ? el.checked : el.value);
  });
  const budget = document.getElementById('budget').value;
  if (budget) localStorage.setItem('ts_budget', budget);
}

function loadSettings() {
  SETTINGS_KEYS.forEach(k => {
    const el = document.getElementById(k);
    if (!el) return;
    const val = localStorage.getItem('ts_' + k);
    if (val === null) return;
    if (el.type === 'checkbox') el.checked = val === 'true';
    else el.value = val;
  });
  const budget = localStorage.getItem('ts_budget');
  if (budget) document.getElementById('budget').value = budget;
}

// ===== MAIN =====
analyzeBtn.addEventListener('click', async () => {
  clearError();
  const budget = parseFloat(document.getElementById('budget').value);
  if (!budget || budget < 1000) { showError('Entre un budget valide (minimum 1 000 coins).'); return; }

  const opts = {
    budget,
    maxItems:            parseInt(document.getElementById('maxItems').value)    || 10,
    maxBacklog:          parseInt(document.getElementById('maxBacklog').value)  || 7,
    maxQtyUser:          parseInt(document.getElementById('maxQtyBazaar').value) || 0,
    sortBy:              document.getElementById('sortBy').value,
    includeEnchantments: document.getElementById('includeEnchantments').checked,
    removeManipulated:   document.getElementById('removeManipulated').checked,
    npcOnly:             document.getElementById('npcOnly').checked,
  };

  saveSettings();

  analyzeBtn.disabled = true;
  btnText.textContent  = 'Analyse en cours...';
  btnIcon.textContent  = '⏳';
  ['planSection', 'excludedSection'].forEach(id => document.getElementById(id).classList.add('hidden'));
  errorBox.classList.add('hidden');

  try {
    setStatus('Récupération des données...');
    const [products, npcPrices] = await Promise.all([fetchBazaar(), fetchNpcPrices()]);

    setStatus('Calcul des opportunités...');
    const { items, excluded } = processBazaar(products, npcPrices, opts);

    if (!items.length) {
      showError('Aucune opportunité trouvée. Essaie d\'élargir les filtres (backlog, budget, etc.).');
      hideStatus();
      return;
    }

    renderResults(items, budget);
    renderExcluded(excluded);
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
  const el  = document.getElementById(id);
  el.classList.toggle('hidden');
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

// Load settings on startup
window.addEventListener('load', loadSettings);
