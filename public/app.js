let RAW = null;
let currentZip = null;
let currentView = 'overview';
let brandFilter = '';
let sortBy = 'skus';
let selectedBrand = null;
let roleMode = 'brand';
let BRAND_LABELS = {};
let BRAND_LABEL_LIST = [];
let compareZip = null;
let compareSearch = '';
let compareSort = 'avg_desc';

const fmt = {
  num: n => (n ?? 0).toLocaleString(),
  pct: n => (n != null ? n.toFixed(1) + '%' : '—'),
  price: n => n ? '$' + n.toFixed(2) : '—',
  short: s => s?.length > 22 ? s.slice(0, 20) + '…' : s
};

function heatColor(pct) {
  if (pct === 0) return '#1a1a1a';
  const light = 100 - Math.round((pct / 100) * 70);
  return `hsl(0,80%,${light}%)`;
}

function nationalAvg(brandId) {
  return RAW.cross[brandId]?.avg ?? 0;
}

function signalForBrand(brandId, zip) {
  const local = RAW.zips[zip]?.brands?.find(b => b.id === brandId);
  const natAvg = nationalAvg(brandId);
  if (!local) return 'absent';
  if (local.p < natAvg - 15) return 'gap';
  if (local.p > natAvg + 10) return 'strong';
  return 'on-par';
}

function renderSidebar() {
  const d = RAW.zips[currentZip];
  if (!d) return;

  document.getElementById('sb-store-count').textContent = d.ts;
  document.getElementById('sb-brand-count').textContent = d.br;

  const maxS = d.stores[0]?.s || 1;
  document.getElementById('sb-stores').innerHTML = d.stores.slice(0, 20).map(s => `
    <div class="sb-row">
      <span class="sb-name" title="${s.n}">${fmt.short(s.n)}</span>
      <span class="sb-val mono">${s.s}</span>
    </div>
    <div class="sb-bar-wrap"><div class="sb-bar" style="width:${(s.s/maxS*100).toFixed(1)}%"></div></div>
  `).join('');

  const filtered = d.brands.filter(b => !brandFilter || b.n.toLowerCase().includes(brandFilter));
  const sorted = [...filtered].sort((a,b) => {
    if (sortBy==='penetration') return b.p - a.p;
    if (sortBy==='avg_price') return b.ap - a.ap;
    return b.sk - a.sk;
  });
  const maxB = sorted[0]?.sk || 1;
  document.getElementById('sb-brands').innerHTML = sorted.slice(0, 20).map(b => `
    <div class="sb-row ${selectedBrand===b.id?'active':''}" onclick="selectBrand('${b.id}')">
      <span class="sb-name" title="${b.n}">${fmt.short(b.n)}</span>
      <span class="sb-val mono">${fmt.pct(b.p)}</span>
    </div>
    <div class="sb-bar-wrap"><div class="sb-bar" style="width:${(b.sk/maxB*100).toFixed(1)}%"></div></div>
  `).join('');
}

function renderKPIs() {
  const d = RAW.zips[currentZip];
  if (!d) return;
  const nat = RAW.meta.national;
  const weightNote = RAW.meta.weights_complete ? 'weighted avg (pop×density)' : 'weighted avg (missing weights default to 1)';

  const set = (id, val) => {
    document.getElementById('kpi-'+id).textContent = val;
  };

  set('stores', d.ts);
  set('skus', fmt.num(d.sk));
  set('brands', d.br);
  set('price', fmt.price(d.ap));
  set('price-item', fmt.price(d.pp));
  set('stock', fmt.pct(d.ir));

  const hhiLabel = d.hhi < 0.01 ? 'Fragmented' : d.hhi < 0.02 ? 'Moderate' : 'Concentrated';
  set('hhi', d.hhi.toFixed(4));
}

function renderPriceChart() {
  const d = RAW.zips[currentZip];
  const pd = d.pd;
  const keys = Object.keys(pd);
  const max = Math.max(...Object.values(pd));
  const total = Object.values(pd).reduce((a,b)=>a+b,0);
  document.getElementById('price-total-note').textContent = `${fmt.num(total)} SKUs with price data`;
  document.getElementById('price-chart').innerHTML = keys.map(k => `
    <div class="price-bar-row">
      <span class="price-bar-label">${k}</span>
      <div class="price-bar-outer">
        <div class="price-bar-inner" style="width:${max ? (pd[k]/max*100).toFixed(1) : 0}%"></div>
      </div>
      <span class="price-bar-count">${fmt.num(pd[k])}</span>
    </div>
  `).join('');
}

function renderSubcategoryChart() {
  const d = RAW.zips[currentZip];
  const subcats = d.subcats || {};
  const entries = Object.entries(subcats).sort((a,b) => b[1] - a[1]);
  const max = entries[0]?.[1] || 1;
  const total = entries.reduce((sum, e) => sum + e[1], 0);
  if (!entries.length) {
    document.getElementById('subcategory-chart').innerHTML = '<div class="empty">No subcategory data.</div>';
    return;
  }
  const html = entries.map(([name, count]) => {
    const pct = total ? (count / total * 100) : 0;
    return `
      <div class="price-bar-row">
        <span class="price-bar-label">${name}</span>
        <div class="price-bar-outer">
          <div class="price-bar-inner" style="width:${(count/max*100).toFixed(1)}%"></div>
        </div>
        <span class="price-bar-count">${pct.toFixed(0)}%</span>
      </div>
    `;
  }).join('');
  document.getElementById('subcategory-chart').innerHTML = html || '<div class="empty">No subcategory data.</div>';
}

function renderBubble() {
  const d = RAW.zips[currentZip];
  const brands = d.brands.slice(0, 25);
  const svg = document.getElementById('bubble-svg');

  const W = 480, H = 260, pad = 40;
  const maxP = 100, maxSK = Math.max(...brands.map(b=>b.sk));
  const maxPrice = Math.max(...brands.map(b=>b.ap||0));

  const px = p => pad + (p / maxP) * (W - pad*2);
  const py = s => H - pad - (s / maxSK) * (H - pad*2);
  const pr = p => p ? 3 + (p / maxPrice) * 10 : 4;

  let out = `
    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H-pad}" stroke="#2a2a2a"/>
    <line x1="${pad}" y1="${H-pad}" x2="${W-pad}" y2="${H-pad}" stroke="#2a2a2a"/>
    <text x="${pad-5}" y="${pad}" fill="#777" font-size="8" text-anchor="end" font-family="DM Mono">SKUs</text>
    <text x="${W-pad}" y="${H-pad+14}" fill="#777" font-size="8" text-anchor="end" font-family="DM Mono">Penetration %</text>
  `;
  [25,50,75,100].forEach(v => {
    const x = px(v);
    out += `<line x1="${x}" y1="${pad}" x2="${x}" y2="${H-pad}" stroke="#1e1e1e"/>
            <text x="${x}" y="${H-pad+12}" fill="#555" font-size="7" text-anchor="middle" font-family="DM Mono">${v}%</text>`;
  });
  [0.25,0.5,0.75,1].forEach(v => {
    const y = py(v*maxSK);
    out += `<line x1="${pad}" y1="${y}" x2="${W-pad}" y2="${y}" stroke="#1e1e1e"/>
            <text x="${pad-4}" y="${y+3}" fill="#555" font-size="7" text-anchor="end" font-family="DM Mono">${Math.round(v*maxSK)}</text>`;
  });

  brands.forEach(b => {
    const x = px(b.p), y = py(b.sk), r = pr(b.ap);
    const nat = nationalAvg(b.id);
    const isGap = b.p < nat - 15;
    const isSelected = selectedBrand === b.id;
    const fill = isSelected ? '#f5f5f0' : isGap ? '#444' : '#2a2a2a';
    const stroke = isSelected ? '#fff' : isGap ? '#888' : '#444';
    out += `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1"
              style="cursor:pointer" onclick="selectBrand('${b.id}')">
              <title>${b.n}\nPenetration: ${b.p}%\nSKUs: ${b.sk}\nAvg Price: ${fmt.price(b.ap)}</title>
            </circle>`;
    if (b.sk > maxSK * 0.3 || isSelected) {
      out += `<text x="${x}" y="${y - r - 3}" fill="#888" font-size="7" text-anchor="middle" font-family="DM Mono">${b.n}</text>`;
    }
  });

  svg.innerHTML = out;
}

function renderStoreBars() {
  const d = RAW.zips[currentZip];
  const stores = d.stores.slice(0, 15);
  const max = stores[0]?.s || 1;
  document.getElementById('store-bars').innerHTML = stores.map(s => `
    <div style="display:flex;align-items:center;gap:12px;padding:5px 0;">
      <div style="width:160px;font-size:11px;color:var(--gray5);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;" title="${s.n}">${s.n}</div>
      <div style="flex:1;height:18px;background:var(--gray2);position:relative;">
        <div style="height:18px;background:var(--gray3);width:${(s.s/max*100).toFixed(1)}%;transition:width 0.5s;"></div>
      </div>
      <div style="font-family:DM Mono,monospace;font-size:10px;color:var(--gray5);width:40px;text-align:right;">${s.s}</div>
      <div style="font-family:DM Mono,monospace;font-size:10px;color:var(--gray4);width:60px;text-align:right;">${s.b} brands</div>
    </div>
  `).join('');
}

function renderBrandTable() {
  const d = RAW.zips[currentZip];
  let brands = [...d.brands];

  if (brandFilter) brands = brands.filter(b => b.n.toLowerCase().includes(brandFilter));
  brands.sort((a,b) => {
    if (sortBy==='penetration') return b.p - a.p;
    if (sortBy==='avg_price') return b.ap - a.ap;
    if (sortBy==='gap') {
      const ga = Math.max(0, nationalAvg(a.id) - a.p);
      const gb = Math.max(0, nationalAvg(b.id) - b.p);
      return gb - ga;
    }
    return b.sk - a.sk;
  });

  document.getElementById('brands-count-note').textContent = `${brands.length} brands · ${currentZip} ${RAW.zip_labels[currentZip]}`;

  document.getElementById('brand-tbody').innerHTML = brands.slice(0, 80).map((b, i) => {
    const nat = nationalAvg(b.id);
    const diff = b.p - nat;
    const sig = signalForBrand(b.id, currentZip);
    const sigLabel = sig === 'gap' ? 'gap' : sig === 'strong' ? 'strong' : sig === 'absent' ? 'absent' : '';
    return `<tr class="${selectedBrand===b.id?'selected':''}" onclick="selectBrand('${b.id}')">
      <td class="mono" style="color:var(--gray4)">${i+1}</td>
      <td>${b.n}</td>
      <td class="r mono">${b.sk}</td>
      <td class="r mono">${b.sc}/${b.ts || d.ts}</td>
      <td class="r">
        <div class="ibar-wrap">
          <div class="ibar"><div class="ibar-fill" style="width:${b.p}%"></div></div>
          <span class="mono">${fmt.pct(b.p)}</span>
        </div>
      </td>
      <td><span class="mono">${b.sk > 0 ? (b.sk/b.sc).toFixed(1) : '—'} SKU/store</span></td>
      <td class="r mono">${fmt.price(b.ap)}</td>
      <td class="r mono">${fmt.price(b.pp || 0)}</td>
      <td class="r mono">${fmt.pct(b.sr)}</td>
      <td class="r mono" style="color:${diff>=0?'#ccc':'#888'}">${diff>=0?'+':''}${diff.toFixed(1)}%</td>
      <td>${sigLabel ? `<span class="signal ${sigLabel}">${sigLabel}</span>` : '<span class="mono" style="color:var(--gray4)">—</span>'}</td>
    </tr>`;
  }).join('');
}

function renderHeatmap() {
  const entries = Object.entries(RAW.cross).map(([id, data]) => {
    const label = BRAND_LABELS[id] || id;
    const left = data.zips[currentZip]?.p || 0;
    const right = data.zips[compareZip]?.p || 0;
    return {
      id,
      label,
      avg: data.avg || 0,
      left,
      right,
      gap: (left - (data.avg || 0))
    };
  });

  const filtered = compareSearch
    ? entries.filter(e => e.label.toLowerCase().includes(compareSearch))
    : entries;

  filtered.sort((a,b) => {
    switch (compareSort) {
      case 'avg_asc': return a.avg - b.avg;
      case 'left_desc': return b.left - a.left;
      case 'left_asc': return a.left - b.left;
      case 'right_desc': return b.right - a.right;
      case 'right_asc': return a.right - b.right;
      case 'gap_desc': return b.gap - a.gap;
      case 'gap_asc': return a.gap - b.gap;
      case 'avg_desc':
      default: return b.avg - a.avg;
    }
  });

  const topBrands = filtered.slice(0, 40).map(e => e.id);

  const leftZip = currentZip;
  const rightZip = compareZip || RAW.zip_list.find(z => z !== currentZip) || currentZip;

  let html = '<thead><tr><th style="text-align:left">Brand</th>';
  html += `<th title="${RAW.zip_labels[leftZip]}">${leftZip}</th>`;
  html += '<th>Weighted Avg</th>';
  html += `<th title="${RAW.zip_labels[rightZip]}">${rightZip}</th>`;
  html += '</tr></thead><tbody>';

  topBrands.forEach(brand => {
    const cd = RAW.cross[brand];
    const label = BRAND_LABELS[brand] || brand;
    html += `<tr class="${selectedBrand===brand?'selected':''}" onclick="selectBrand('${brand}')">
      <td class="row-label" style="white-space:nowrap;padding-right:12px;">${label}</td>`;
    const left = cd.zips[leftZip];
    const leftPct = left ? left.p : 0;
    html += `<td style="background:${heatColor(leftPct)};color:${leftPct>40?'#fff':'#666'}"
      onmouseover="showTip(event,'${label} in ${leftZip}: ${leftPct}% penetration (${left?.sc||0}/${left?.ts||0} stores, ${left?.sk||0} SKUs)')"
      onmouseout="hideTip()">${leftPct > 0 ? leftPct.toFixed(0)+'%' : '—'}</td>`;
    html += `<td style="background:${heatColor(cd.avg)};color:${cd.avg>40?'#fff':'#666'}"
      onmouseover="showTip(event,'${label} weighted avg: ${cd.avg.toFixed(1)}% penetration')"
      onmouseout="hideTip()">${cd.avg.toFixed(0)}%</td>`;
    const right = cd.zips[rightZip];
    const rightPct = right ? right.p : 0;
    html += `<td style="background:${heatColor(rightPct)};color:${rightPct>40?'#fff':'#666'}"
      onmouseover="showTip(event,'${label} in ${rightZip}: ${rightPct}% penetration (${right?.sc||0}/${right?.ts||0} stores, ${right?.sk||0} SKUs)')"
      onmouseout="hideTip()">${rightPct > 0 ? rightPct.toFixed(0)+'%' : '—'}</td>`;
    html += '</tr>';
  });
  html += '</tbody>';
  document.getElementById('heatmap-table').innerHTML = html;
}

function renderCmpProfiles() {
  const metrics = [
    {k:'ts', label:'Stores'},
    {k:'sk', label:'SKUs'},
    {k:'br', label:'Brands'},
    {k:'ap', label:'Avg Price', fmt: v => '$'+v.toFixed(2)},
    {k:'ir', label:'In-Stock', fmt: v => v.toFixed(1)+'%'},
    {k:'hhi', label:'HHI', fmt: v => v.toFixed(4)},
  ];

  let html = `<div style="display:grid;grid-template-columns:120px ${RAW.zip_list.map(()=>'1fr').join(' ')};gap:0;border:var(--border);">`;
  html += '<div class="cmp-cell" style="background:var(--gray1);border-bottom:var(--border);"></div>';
  RAW.zip_list.forEach(z => {
    html += `<div class="cmp-cell" style="background:var(--gray1);border-bottom:var(--border);border-left:var(--border);">
      <div class="cmp-zip-label">${z}</div>
      <div style="font-size:11px;color:var(--gray5)">${RAW.zip_labels[z]}</div>
    </div>`;
  });
  metrics.forEach(m => {
    const vals = RAW.zip_list.map(z => RAW.zips[z][m.k]);
    const max = Math.max(...vals);
    html += `<div class="cmp-cell" style="background:var(--gray1);border-top:var(--border);">
      <div style="font-family:DM Mono,monospace;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:var(--gray4)">${m.label}</div>
    </div>`;
    RAW.zip_list.forEach((z,i) => {
      const v = vals[i];
      const display = m.fmt ? m.fmt(v) : v.toLocaleString();
      const pct = max ? v/max*100 : 0;
      const isCurrent = z === currentZip;
      html += `<div class="cmp-cell" style="border-top:var(--border);border-left:var(--border);${isCurrent?'background:var(--gray2)':''}">
        <div style="font-size:13px;font-weight:${isCurrent?600:400}">${display}</div>
        <div style="height:2px;background:var(--gray3);margin-top:5px;">
          <div style="height:2px;background:${isCurrent?'var(--white)':'var(--gray4)'};width:${pct.toFixed(1)}%"></div>
        </div>
      </div>`;
    });
  });
  html += '</div>';
  document.getElementById('cmp-profiles').innerHTML = html;
}

function renderSignals() {
  const d = RAW.zips[currentZip];
  document.getElementById('signals-zip-note').textContent = currentZip + ' ' + RAW.zip_labels[currentZip];

  const gapBrands = d.brands
    .filter(b => RAW.cross[b.id])
    .map(b => ({ ...b, gap: nationalAvg(b.id) - b.p }))
    .filter(b => b.gap > 15)
    .sort((a,b) => b.gap - a.gap)
    .slice(0, 6);

  const strongBrands = d.brands
    .filter(b => RAW.cross[b.id])
    .map(b => ({ ...b, lift: b.p - nationalAvg(b.id) }))
    .filter(b => b.lift > 10)
    .sort((a,b) => b.lift - a.lift)
    .slice(0, 2);

  const lowBrandStores = d.stores.filter(s => s.b < 10 && s.s > 20).slice(0,2);
  const allAvgPrice = RAW.meta.national.ap;
  const priceSignal = d.ap > allAvgPrice * 1.2;

  const cards = [];

  gapBrands.slice(0,3).forEach(b => {
    cards.push({
      icon: 'EXPANSION GAP',
      headline: `<span class="insight-brand">${b.n}</span> is under-distributed in ${currentZip}`,
      body: `${fmt.pct(b.p)} store penetration locally vs ${fmt.pct(nationalAvg(b.id))} weighted average — a ${b.gap.toFixed(1)}pt gap. Present in ${b.sc} of ${d.ts} stores.`
    });
  });

  strongBrands.forEach(b => {
    cards.push({
      icon: 'MARKET STRENGTH',
      headline: `<span class="insight-brand">${b.n}</span> over-indexes in ${currentZip}`,
      body: `${fmt.pct(b.p)} penetration here vs ${fmt.pct(nationalAvg(b.id))} weighted average — ${b.lift.toFixed(1)}pts above average. ${b.sk} SKUs across ${b.sc} stores.`
    });
  });

  if (priceSignal) {
    cards.push({
      icon: 'PRICE SIGNAL',
      headline: `Premium price point — avg ${fmt.price(d.ap)} vs ${fmt.price(allAvgPrice)} weighted average`,
      body: `This market skews higher than the 6-market weighted average. Premium brands may find stronger shelf placement here.`
    });
  }

  if (lowBrandStores.length) {
    lowBrandStores.forEach(s => {
      cards.push({
        icon: 'DISTRIBUTION WHITESPACE',
        headline: `<span class="insight-brand">${s.n}</span> carries only ${s.b} brands`,
        body: `This store has ${s.s} protein SKUs but only ${s.b} distinct brands — a narrow assortment that suggests limited vendor relationships.`
      });
    });
  }

  const hhiNote = d.hhi < 0.01 
    ? `HHI of ${d.hhi.toFixed(4)} signals extreme fragmentation — no brand dominates.`
    : `HHI of ${d.hhi.toFixed(4)} indicates moderate concentration.`;
  cards.push({
    icon: 'CATEGORY STRUCTURE',
    headline: `${d.hhi < 0.01 ? 'Highly fragmented' : 'Moderately concentrated'} protein market in ${currentZip}`,
    body: hhiNote + ` ${d.br} brands share ${d.sk} SKUs across ${d.ts} stores.`
  });

  document.getElementById('signals-grid').innerHTML = cards.map(c => `
    <div class="insight-card">
      <div class="insight-icon">${c.icon}</div>
      <div class="insight-headline">${c.headline}</div>
      <div class="insight-body">${c.body}</div>
    </div>
  `).join('');

  const absentBrands = Object.entries(RAW.cross)
    .filter(([brandId]) => {
      const localBrand = d.brands.find(b => b.id === brandId);
      if (localBrand && localBrand.sc > 0) return false;
      const zipsPresent = RAW.zip_list.filter(z => z !== currentZip && RAW.cross[brandId].zips[z]?.sc > 0);
      return zipsPresent.length >= 2;
    })
    .map(([brandId, data]) => {
      const zipsPresent = RAW.zip_list.filter(z => z !== currentZip && data.zips[z]?.sc > 0);
      const avgSkuWhere = zipsPresent.length
        ? (zipsPresent.reduce((sum,z) => sum + data.zips[z].sk, 0) / zipsPresent.length).toFixed(0)
        : 0;
      const label = data.zips[RAW.zip_list[0]]?.n || brandId;
      return { brand: label, avg: data.avg, zipsPresent: zipsPresent.length, avgSkuWhere };
    })
    .sort((a,b) => b.avg - a.avg)
    .slice(0, 20);

  document.getElementById('absent-tbody').innerHTML = absentBrands.map(b => `
    <tr>
      <td>${b.brand}</td>
      <td class="r mono">${fmt.pct(b.avg)}</td>
      <td class="r mono">${b.zipsPresent}/${RAW.zip_list.length - 1}</td>
      <td class="r mono">${b.avgSkuWhere}</td>
      <td><span class="signal gap">not present</span></td>
    </tr>
  `).join('');
}

function renderMethodology() {
  const m = RAW.meta;
  const missingNote = m.weights_complete ? 'Population and density weights are fully provided.' : 'Weights are incomplete; missing values default to 1.0.';
  document.getElementById('method-note').textContent = `Data generated ${m.generated_at} · ${missingNote}`;

  const weightsRows = m.weights.map(w => `
    <tr>
      <td class="mono">${w.zip}</td>
      <td>${w.label}</td>
      <td class="mono">${w.population ?? '—'}</td>
      <td class="mono">${w.density ?? '—'}</td>
      <td class="mono">${w.weight}</td>
      <td class="mono">${w.provided ? 'yes' : 'no'}</td>
    </tr>
  `).join('');

  const subcatList = (m.subcategory_rules || []).join(', ');
  const coveragePct = m.rows_total ? (m.unit_price_available / m.rows_total * 100) : 0;
  const html = `
    <div style="font-size:12px;color:var(--gray5);line-height:1.7;margin-bottom:16px;">
      Source file: <span class="mono">${m.source_file}</span><br>
      Rows: <span class="mono">${fmt.num(m.rows_total)}</span> · Missing UPC: <span class="mono">${fmt.num(m.missing_upc)}</span> · Missing pack size: <span class="mono">${fmt.num(m.missing_pack_size)}</span> · Missing size: <span class="mono">${fmt.num(m.missing_size)}</span><br>
      Price-per-item coverage: <span class="mono">${fmt.num(m.unit_price_available)}</span> rows (${coveragePct.toFixed(1)}%) with pack counts parsed
    </div>
    <div style="font-size:12px;color:var(--gray5);line-height:1.7;margin-bottom:16px;">
      Penetration = (stores carrying brand ÷ total stores) × 100<br>
      Shelf depth = SKUs ÷ stores carrying brand<br>
      In-stock rate = in-stock SKUs ÷ total SKUs × 100<br>
      HHI = sum of (brand SKU share²) within ZIP<br>
      Avg price per SKU = mean of product prices (sale price preferred) within ZIP/brand<br>
      Price per item = price ÷ pack size when pack size present (count/ct/pack heuristics)<br>
      Weighted average = Σ(metric × weight) ÷ Σ(weight) where ${m.weight_formula}<br>
      Brand normalization = lowercase + punctuation collapsed + Unicode dashes normalized<br>
      Subcategory rules = ${subcatList}
    </div>
    <table class="method-grid">
      <thead>
        <tr>
          <th>ZIP</th>
          <th>Label</th>
          <th>Population</th>
          <th>Density</th>
          <th>Weight</th>
          <th>Provided</th>
        </tr>
      </thead>
      <tbody>${weightsRows}</tbody>
    </table>
  `;
  document.getElementById('methodology').innerHTML = html;
}

function renderTailoredControls() {
  const d = RAW.zips[currentZip];
  const search = document.getElementById('entity-search').value.toLowerCase().trim();

  let options = [];
  if (roleMode === 'brand') {
    options = BRAND_LABEL_LIST.slice();
    document.getElementById('entity-search').placeholder = 'Search brands…';
  } else {
    options = d.stores.map(s => s.n).sort((a,b) => a.localeCompare(b));
    document.getElementById('entity-search').placeholder = 'Search retailers…';
  }
  if (search) {
    options = options.filter(o => o.toLowerCase().includes(search));
  }

  const select = document.getElementById('entity-select');
  select.innerHTML = options.map(o => `<option value="${o}">${o}</option>`).join('');
  document.getElementById('tailor-note').textContent = `${currentZip} ${RAW.zip_labels[currentZip]} · ${roleMode === 'brand' ? 'brand' : 'retailer'} insights`;

  if (options.length === 0) {
    document.getElementById('tailored-grid').innerHTML = '<div class="empty">No matches — refine your search.</div>';
  }
}

async function renderTailoredInsights() {
  const select = document.getElementById('entity-select');
  const value = select.value;
  if (!value) return;

  let data;
  if (roleMode === 'brand') {
    const res = await fetch(`/api/brand?zip=${encodeURIComponent(currentZip)}&brand=${encodeURIComponent(value)}`);
    data = await res.json();
    if (data.error) {
      document.getElementById('tailored-grid').innerHTML = `<div class="empty">${data.error}</div>`;
      return;
    }
    const cards = [
      {
        icon: 'LOCAL VS WEIGHTED AVG',
        headline: `${data.brand_label} in ${data.zip} (${data.zip_label})`,
        body: `Penetration ${fmt.pct(data.local.penetration)} vs ${fmt.pct(data.national.avg_penetration)} weighted average (${data.delta.penetration >= 0 ? '+' : ''}${data.delta.penetration}pts). Stores: ${data.local.stores}/${data.local.total_stores}.`
      },
      {
        icon: 'SHELF DEPTH',
        headline: `${data.local.skus} SKUs locally`,
        body: `Avg SKUs where present: ${data.national.avg_skus_where_present}. Avg price: ${fmt.price(data.local.avg_price)}. Price per item: ${fmt.price(data.local.price_per_item)} vs ${fmt.price(data.national.avg_price_per_item)} weighted average. In-stock: ${fmt.pct(data.local.in_stock)}.`
      },
      {
        icon: 'MARKET RANK',
        headline: `Ranked #${data.rank.zip_rank_by_penetration} of ${data.rank.total_zips} ZIPs`,
        body: `${data.national.zips_present} of ${data.national.total_zips} ZIPs carry this brand. Use this ZIP as a benchmark for distribution.`
      },
      {
        icon: 'SUBCATEGORY MIX',
        headline: `Where this brand shows up`,
        body: data.subcategories && data.subcategories.length
          ? data.subcategories.map(s => `${s.name}: ${s.skus} SKUs`).join('<br>')
          : 'No subcategory breakdown available.'
      },
      {
        icon: 'TOP STORES',
        headline: `Top stores carrying ${data.brand_label}`,
        body: data.top_stores.length ? data.top_stores.map(s => `${s.store}: ${s.sk} SKUs, ${fmt.price(s.ap)} avg, ${fmt.pct(s.sr)} in-stock`).join('<br>') : 'No store-level detail available.'
      }
    ];
    document.getElementById('tailored-grid').innerHTML = cards.map(c => `
      <div class="insight-card">
        <div class="insight-icon">${c.icon}</div>
        <div class="insight-headline">${c.headline}</div>
        <div class="insight-body">${c.body}</div>
      </div>
    `).join('');
  } else {
    const res = await fetch(`/api/store?zip=${encodeURIComponent(currentZip)}&store=${encodeURIComponent(value)}`);
    data = await res.json();
    if (data.error) {
      document.getElementById('tailored-grid').innerHTML = `<div class="empty">${data.error}</div>`;
      return;
    }
    const s = data.store_stats;
    const cards = [
      {
        icon: 'STORE PROFILE',
        headline: `${data.store} in ${data.zip} (${data.zip_label})`,
        body: `${s.s} SKUs and ${s.b} brands. Avg price ${fmt.price(s.ap)}. Price per item ${fmt.price(s.pp || 0)}. In-stock ${fmt.pct(s.ir)}.`
      },
      {
        icon: 'VS ZIP AVG',
        headline: `Compared to ZIP average`,
        body: `SKU count vs avg: ${s.s} vs ${data.zip_avg.skus}. Brand count vs avg: ${s.b} vs ${data.zip_avg.brands}.`
      },
      {
        icon: 'TOP BRANDS',
        headline: `Top brands in this store`,
        body: data.top_brands.length ? data.top_brands.map(b => `${b.brand}: ${b.sk} SKUs`).join('<br>') : 'No brand breakdown available.'
      },
      {
        icon: 'ACTION',
        headline: `Assortment opportunities`,
        body: `Focus on categories where store SKU count lags ZIP average or where top brands are under-represented.`
      }
    ];
    document.getElementById('tailored-grid').innerHTML = cards.map(c => `
      <div class="insight-card">
        <div class="insight-icon">${c.icon}</div>
        <div class="insight-headline">${c.headline}</div>
        <div class="insight-body">${c.body}</div>
      </div>
    `).join('');
  }
}

function showTip(e, text) {
  const t = document.getElementById('tooltip');
  t.textContent = text;
  t.style.left = (e.clientX + 12) + 'px';
  t.style.top = (e.clientY + 12) + 'px';
  t.style.opacity = 1;
}
function hideTip() {
  document.getElementById('tooltip').style.opacity = 0;
}

function selectBrand(id) {
  selectedBrand = selectedBrand === id ? null : id;
  renderAll();
}

function setView(v) {
  currentView = v;
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById('view-'+v).classList.add('active');
  document.querySelectorAll('.vtab').forEach(el => el.classList.remove('active'));
  document.querySelector(`.vtab[data-view="${v}"]`).classList.add('active');
  renderView();
}

function renderView() {
  if (currentView === 'overview') { renderKPIs(); renderPriceChart(); renderSubcategoryChart(); renderBubble(); renderStoreBars(); }
  if (currentView === 'brands') { renderBrandTable(); }
  if (currentView === 'compare') { renderHeatmap(); renderCmpProfiles(); }
  if (currentView === 'signals') { renderSignals(); renderMethodology(); renderTailoredControls(); }
}

function renderAll() {
  renderSidebar();
  renderView();
}

async function init() {
  const res = await fetch('/api/data');
  RAW = await res.json();

  const zipSelect = document.getElementById('zip-select');
  zipSelect.innerHTML = RAW.zip_list.map(z => `<option value="${z}">${z} — ${RAW.zip_labels[z]}</option>`).join('');
  currentZip = RAW.zip_list[0] || null;
  if (currentZip) zipSelect.value = currentZip;
  compareZip = RAW.zip_list.find(z => z !== currentZip) || currentZip;
  const compareSelect = document.getElementById('compare-zip-select');
  if (compareSelect) {
    compareSelect.innerHTML = RAW.zip_list.map(z => `<option value="${z}">${z} — ${RAW.zip_labels[z]}</option>`).join('');
    compareSelect.value = compareZip;
  }

  BRAND_LABELS = {};
  const labelSet = new Set();
  Object.entries(RAW.cross).forEach(([brandId, data]) => {
    let label = brandId;
    for (const z of RAW.zip_list) {
      if (data.zips[z]?.n) { label = data.zips[z].n; break; }
    }
    BRAND_LABELS[brandId] = label;
    labelSet.add(label);
  });
  BRAND_LABEL_LIST = Array.from(labelSet).sort((a,b) => a.localeCompare(b));

  document.getElementById('zip-select').addEventListener('change', e => {
    currentZip = e.target.value;
    selectedBrand = null;
    if (compareZip === currentZip) {
      compareZip = RAW.zip_list.find(z => z !== currentZip) || currentZip;
      document.getElementById('compare-zip-select').value = compareZip;
    }
    renderAll();
  });
  if (compareSelect) {
    compareSelect.addEventListener('change', e => {
      compareZip = e.target.value;
      renderAll();
    });
  }
  const compareSearchEl = document.getElementById('compare-search');
  if (compareSearchEl) {
    compareSearchEl.addEventListener('input', e => {
      compareSearch = e.target.value.toLowerCase().trim();
      renderAll();
    });
  }
  const compareSortEl = document.getElementById('compare-sort');
  if (compareSortEl) {
    compareSortEl.addEventListener('change', e => {
      compareSort = e.target.value;
      renderAll();
    });
  }
  document.getElementById('sort-select').addEventListener('change', e => {
    sortBy = e.target.value;
    renderAll();
  });
  document.getElementById('brand-search').addEventListener('input', e => {
    brandFilter = e.target.value.toLowerCase().trim();
    renderAll();
  });
  document.querySelectorAll('.vtab').forEach(el => {
    el.addEventListener('click', () => setView(el.dataset.view));
  });

  document.getElementById('entity-search').addEventListener('input', () => renderTailoredControls());
  document.getElementById('entity-go').addEventListener('click', () => renderTailoredInsights());
  document.querySelectorAll('.role-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.role-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      roleMode = btn.dataset.role;
      renderTailoredControls();
    });
  });

  renderAll();
}

init();
