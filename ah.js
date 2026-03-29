// ===== AH FLIP — AUCTION HOUSE FLIPPER =====

const AH_API    = 'https://api.hypixel.net/v2/skyblock/auctions';
const TIER_ORDER = ['COMMON','UNCOMMON','RARE','EPIC','LEGENDARY','MYTHIC','DIVINE','SPECIAL'];

// ===== DOM =====
const ahAnalyzeBtn = document.getElementById('ahAnalyzeBtn');
const ahBtnText    = document.getElementById('ahBtnText');
const ahBtnIcon    = document.getElementById('ahBtnIcon');
const ahStatusBar  = document.getElementById('ahStatusBar');
const ahStatusText = document.getElementById('ahStatusText');
const ahErrorBox   = document.getElementById('ahErrorBox');

function ahSetStatus(msg) { ahStatusBar.classList.remove('hidden'); ahStatusText.textContent = msg; }
function ahHideStatus()   { ahStatusBar.classList.add('hidden'); }
function ahShowError(msg) { ahErrorBox.textContent = msg; ahErrorBox.classList.remove('hidden'); }
function ahClearError()   { ahErrorBox.classList.add('hidden'); }
function ahShow(id)       { document.getElementById(id).classList.remove('hidden'); }

// ===== FETCH AH PAGES =====
async function fetchAHPages(numPages) {
  // First fetch page 0 to know total pages
  ahSetStatus('Récupération de la page 1...');
  const first = await fetch(`${AH_API}?page=0`).then(r => r.json());
  if (!first.success) throw new Error('API Hypixel AH indisponible.');

  const totalPages = Math.min(first.totalPages, numPages);
  let auctions = [...first.auctions];

  // Fetch remaining pages in parallel (max 5 at a time to avoid rate limit)
  for (let start = 1; start < totalPages; start += 5) {
    const batch = [];
    for (let p = start; p < Math.min(start + 5, totalPages); p++) batch.push(p);
    ahSetStatus(`Scan en cours... page ${start + 1}/${totalPages}`);
    const pages = await Promise.all(batch.map(p => fetch(`${AH_API}?page=${p}`).then(r => r.json())));
    for (const page of pages) if (page.success) auctions.push(...page.auctions);
  }

  return auctions;
}

// ===== NORMALIZE ITEM NAME =====
function normalizeName(name) {
  return name
    .replace(/[✪✦❤♣]/g, '')   // remove stars/symbols
    .replace(/\s+/g, ' ')
    .trim();
}

function isNoisyItem(name) {
  // Skip pets, starred items, and items with too-variable prices
  if (/\[Lvl \d+\]/.test(name)) return true;   // pets
  if (/✪/.test(name)) return true;              // starred items
  if (/✦/.test(name)) return true;
  return false;
}

// ===== PROCESS AUCTIONS =====
function processAH(allAuctions, budget, minProfit, minTier, maxQty) {
  const minTierIdx = TIER_ORDER.indexOf(minTier);
  const now = Date.now();

  // Filter: BIN only, minimum tier, active, no noisy items
  const bins = allAuctions.filter(a =>
    a.bin &&
    !a.claimed &&
    a.end > now &&
    TIER_ORDER.indexOf(a.tier) >= minTierIdx &&
    a.starting_bid > 0 &&
    !isNoisyItem(a.item_name)
  );

  // Group by normalized name + tier
  const groups = {};
  for (const a of bins) {
    const key = normalizeName(a.item_name) + '|' + a.tier;
    if (!groups[key]) groups[key] = { name: normalizeName(a.item_name), tier: a.tier, auctions: [] };
    groups[key].auctions.push(a);
  }

  const flips = [];

  for (const [, grp] of Object.entries(groups)) {
    // Need ≥6 listings for a reliable median
    if (grp.auctions.length < 6) continue;

    const prices = grp.auctions.map(a => a.starting_bid).sort((a, b) => a - b);

    // Trim top/bottom 10% outliers before computing median
    const trim  = Math.max(1, Math.floor(prices.length * 0.1));
    const clean = prices.slice(trim, prices.length - trim);

    const mid    = Math.floor(clean.length / 2);
    const median = clean.length % 2 !== 0 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;

    // Price consistency check: coefficient of variation < 60%
    // High CV means wildly different prices → item too variable to flip reliably
    const mean = clean.reduce((s, p) => s + p, 0) / clean.length;
    const std  = Math.sqrt(clean.reduce((s, p) => s + (p - mean) ** 2, 0) / clean.length);
    const cv   = std / mean;
    if (cv > 0.60) continue;

    // Find underpriced BINs (below 82% of median)
    for (const auction of grp.auctions) {
      const ratio = auction.starting_bid / median;
      if (ratio >= 0.82) continue;
      if (auction.starting_bid > budget) continue;
      // For AH, maxQty = max units you'd want from this item group at once
      if (maxQty && grp.auctions.filter(a => a.starting_bid < median * 0.82).length > maxQty) continue;

      const sellPrice = median * 0.99;   // after 1% AH tax
      const profit    = sellPrice - auction.starting_bid;
      if (profit < minProfit) continue;

      const discount   = (1 - ratio) * 100;
      // Liquidity score: more listings = item moves more
      const liquidity  = Math.min(grp.auctions.length, 100);
      const score      = profit * (discount / 100) * Math.log10(liquidity + 1);

      flips.push({
        name:      grp.name,
        tier:      grp.tier,
        binPrice:  auction.starting_bid,
        median,
        profit,
        discount,
        listings:  grp.auctions.length,
        seller:    auction.auctioneer?.slice(0, 8) + '...',
        uuid:      auction.uuid,
        score,
      });
    }
  }

  // Sort by score (profit × discount × liquidity)
  flips.sort((a, b) => b.score - a.score);

  // Deduplicate: max 2 results per item name to show variety
  const seen = {};
  return flips.filter(f => {
    seen[f.name] = (seen[f.name] || 0) + 1;
    return seen[f.name] <= 2;
  });
}

// ===== RENDER AH STATS =====
function renderAHStats(allBins, flips, pages) {
  ahShow('ahStatsSection');
  document.getElementById('ahStatsGrid').innerHTML = `
    <div class="stat-card"><div class="stat-label">BIN scannés</div><div class="stat-value blue">${allBins.toLocaleString('fr-FR')}</div></div>
    <div class="stat-card"><div class="stat-label">Flips trouvés</div><div class="stat-value green">${flips.length.toLocaleString('fr-FR')}</div></div>
    <div class="stat-card"><div class="stat-label">Meilleur profit</div><div class="stat-value yellow">${flips.length ? fmt(flips[0].profit) : '—'}</div></div>
    <div class="stat-card"><div class="stat-label">Pages scannées</div><div class="stat-value purple">${pages}</div></div>
  `;
}

// ===== TIER BADGE =====
const TIER_COLORS = {
  COMMON: '#aaaaaa', UNCOMMON: '#55ff55', RARE: '#5555ff',
  EPIC: '#aa00aa', LEGENDARY: '#ffaa00', MYTHIC: '#ff55ff',
  DIVINE: '#55ffff', SPECIAL: '#ff5555'
};
function tierBadge(tier) {
  const color = TIER_COLORS[tier] || '#fff';
  const label = tier.charAt(0) + tier.slice(1).toLowerCase();
  return `<span class="tier-badge" style="color:${color};border-color:${color}22;background:${color}11">${label}</span>`;
}

// ===== RENDER AH RESULTS =====
function renderAHResults(flips, budget) {
  if (!flips.length) return;
  ahShow('ahResultsSection');

  const top50 = flips.slice(0, 50);
  document.getElementById('ahResultsBody').innerHTML = top50.map((f, i) => `
    <tr class="${i < 3 ? 'rank-' + (i+1) : ''}">
      <td style="font-weight:700;color:var(--muted)">${i + 1}</td>
      <td style="font-weight:600;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${f.name}">${f.name}</td>
      <td>${tierBadge(f.tier)}</td>
      <td class="price red">${fmt(f.binPrice)}</td>
      <td class="price">${fmt(f.median)}</td>
      <td class="price yellow">-${f.discount.toFixed(1)}%</td>
      <td class="price green">+${fmt(f.profit)}</td>
      <td><span class="listings-badge ${f.listings >= 30 ? 'liq-high' : f.listings >= 15 ? 'liq-med' : ''}">${f.listings}</span></td>
      <td style="color:var(--muted);font-size:0.8rem">${f.seller}</td>
    </tr>
  `).join('');
}

// ===== MAIN =====
ahAnalyzeBtn.addEventListener('click', async () => {
  ahClearError();
  document.getElementById('ahResultsSection').classList.add('hidden');
  document.getElementById('ahStatsSection').classList.add('hidden');

  const budget    = parseFloat(document.getElementById('ahBudget').value) || Infinity;
  const numPages  = parseInt(document.getElementById('ahPages').value);
  const minProfit = parseInt(document.getElementById('ahMinProfit').value);
  const minTier   = document.getElementById('ahTier').value;
  const maxQty    = parseInt(document.getElementById('maxQtyAH').value) || 0;

  ahAnalyzeBtn.disabled = true;
  ahBtnText.textContent = 'Scan en cours...';
  ahBtnIcon.textContent = '⏳';

  try {
    const allAuctions = await fetchAHPages(numPages);
    const bins = allAuctions.filter(a => a.bin);

    ahSetStatus('Analyse des prix...');
    const flips = processAH(allAuctions, budget, minProfit, minTier, maxQty);

    renderAHStats(bins.length, flips, numPages);
    renderAHResults(flips, budget);
    ahHideStatus();

    if (!flips.length) {
      ahShowError('Aucun flip trouvé avec ces critères. Baisse le profit minimum ou la rareté minimum.');
    }

  } catch (err) {
    ahHideStatus();
    ahShowError('Erreur : ' + err.message);
  } finally {
    ahAnalyzeBtn.disabled = false;
    ahBtnText.textContent = 'Scanner l\'Auction House';
    ahBtnIcon.textContent = '🔍';
  }
});

// Persist AH budget
window.addEventListener('load', () => {
  const saved = localStorage.getItem('ts_ah_budget');
  if (saved) document.getElementById('ahBudget').value = saved;
});
document.getElementById('ahBudget').addEventListener('change', e => localStorage.setItem('ts_ah_budget', e.target.value));
