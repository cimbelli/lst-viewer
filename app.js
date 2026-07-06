// Mappa interattiva LST — vanilla JS, statico.
// Dati: manifest.json elenca i comuni; ogni TopoJSON contiene i valori
// LST_YYYY per ogni anno come proprieta' delle feature. Lo slider Anno
// seleziona quale campo LST_YYYY visualizzare; nessun nuovo fetch per
// cambio anno (tutti gli anni sono gia' nel file caricato).

const PALETTES = {
  giallorosso: ['#ffffcc', '#fee187', '#fdae61', '#f46d43', '#a50026'],
  blurosso:    ['#2166ac', '#67a9cf', '#f7f7f7', '#ef8a62', '#b2182b'],
  viridis:     ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  grigi:       ['#f7f7f7', '#cccccc', '#969696', '#636363', '#252525'],
};

const BASEMAPS = {
  osm: { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '&copy; OpenStreetMap contributors' },
  positron: { url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', attr: '&copy; OpenStreetMap, &copy; CARTO' },
  satellite: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: 'Tiles &copy; Esri' },
};

const state = { manifest: null, dataCache: new Map(), geoLayer: null, map: null, tileLayer: null };
const el = (id) => document.getElementById(id);
const loading = (on) => { const l = el('loading'); if (l) l.style.display = on ? 'block' : 'none'; };

// ---------- classification ----------
function classQuantile(values, k) {
  const s = [...values].sort((a, b) => a - b);
  const breaks = [s[0]];
  for (let i = 1; i < k; i++) {
    const idx = Math.floor((i / k) * (s.length - 1));
    breaks.push(s[idx]);
  }
  breaks.push(s[s.length - 1]);
  return [...new Set(breaks)];
}
function classEqual(values, k) {
  const min = Math.min(...values), max = Math.max(...values);
  const step = (max - min) / k;
  const breaks = [];
  for (let i = 0; i <= k; i++) breaks.push(min + step * i);
  return breaks;
}
function classJenks(data, k) {
  const values = [...data].sort((a, b) => a - b);
  const n = values.length;
  if (n <= k) return [...new Set(values)];
  const mat1 = Array.from({ length: n + 1 }, () => Array(k + 1).fill(0));
  const mat2 = Array.from({ length: n + 1 }, () => Array(k + 1).fill(Infinity));
  for (let i = 1; i <= k; i++) { mat1[1][i] = 1; mat2[1][i] = 0; for (let j = 2; j <= n; j++) mat2[j][i] = Infinity; }
  let v = 0;
  for (let l = 2; l <= n; l++) {
    let s1 = 0, s2 = 0, w = 0;
    for (let m = 1; m <= l; m++) {
      const i3 = l - m + 1;
      const val = values[i3 - 1];
      s2 += val * val; s1 += val; w++;
      v = s2 - (s1 * s1) / w;
      const i4 = i3 - 1;
      if (i4 !== 0) {
        for (let j = 2; j <= k; j++) {
          if (mat2[l][j] >= v + mat2[i4][j - 1]) {
            mat1[l][j] = i3; mat2[l][j] = v + mat2[i4][j - 1];
          }
        }
      }
    }
    mat1[l][1] = 1; mat2[l][1] = v;
  }
  const breaks = Array(k + 1);
  breaks[k] = values[n - 1]; breaks[0] = values[0];
  let kk = n;
  for (let j = k; j >= 2; j--) {
    const id = mat1[kk][j] - 2;
    breaks[j - 1] = values[id];
    kk = mat1[kk][j] - 1;
  }
  return breaks;
}
function computeBreaks(values, method, k) {
  if (method === 'quantile') return classQuantile(values, k);
  if (method === 'equal') return classEqual(values, k);
  if (method === 'jenks') return classJenks(values, k);
  return classQuantile(values, k);
}

// ---------- color ramp ----------
function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex([r, g, b]) { return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join(''); }
function rampColors(stops, k) {
  const rgb = stops.map(hexToRgb);
  const out = [];
  for (let i = 0; i < k; i++) {
    const t = k === 1 ? 0 : i / (k - 1);
    const scaled = t * (rgb.length - 1);
    const i0 = Math.floor(scaled), i1 = Math.min(i0 + 1, rgb.length - 1);
    const f = scaled - i0;
    const c = rgb[i0].map((v, idx) => v + (rgb[i1][idx] - v) * f);
    out.push(rgbToHex(c));
  }
  return out;
}
function colorForValue(v, breaks, colors) {
  for (let i = 0; i < breaks.length - 1; i++) {
    if (v <= breaks[i + 1] || i === breaks.length - 2) return colors[i];
  }
  return colors[colors.length - 1];
}

// ---------- data loading ----------
async function loadManifest() {
  const res = await fetch('data/manifest.json');
  state.manifest = await res.json();
}
async function loadComune(entry) {
  if (state.dataCache.has(entry.code)) return state.dataCache.get(entry.code);
  loading(true);
  const res = await fetch(entry.file);
  const raw = await res.json();
  let geojson;
  if (entry.format === 'topojson') {
    const objName = Object.keys(raw.objects)[0];
    geojson = topojson.feature(raw, raw.objects[objName]);
  } else {
    geojson = raw;
  }
  state.dataCache.set(entry.code, geojson);
  loading(false);
  return geojson;
}

// ---------- rendering ----------
function currentFieldKey() {
  // Es. indicatore = "LST", anno = 2025  ->  "LST_2025"
  return `${el('indicatorSelect').value}_${el('yearSlider').value}`;
}
function styleFeature(feature, breaks, colors, field) {
  const v = feature.properties[field];
  return {
    fillColor: v == null ? '#eeeeee' : colorForValue(v, breaks, colors),
    fillOpacity: 0.75, color: '#666', weight: 0.5,
  };
}
function renderLegend(breaks, colors, field) {
  const box = el('legend');
  const swatches = colors.map(c => `<div class="swatch" style="background:${c}"></div>`).join('');
  const labels = breaks.map(b => Math.round(b * 10) / 10).join('&nbsp;&nbsp;');
  box.innerHTML = `<div class="swatches">${swatches}</div><div>${labels}</div><div class="label">${field}</div>`;
}
function renderInfoPanel(entry, geojson, field, values) {
  const dl = el('infoPanel');
  const min = Math.min(...values), max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  dl.innerHTML = `
    <dt>Comune</dt><dd>${entry.name}</dd>
    <dt>Codice</dt><dd>${entry.code}</dd>
    <dt>Sezioni</dt><dd>${geojson.features.length}</dd>
    <dt>Minimo</dt><dd>${min.toFixed(2)}</dd>
    <dt>Massimo</dt><dd>${max.toFixed(2)}</dd>
    <dt>Media</dt><dd>${mean.toFixed(2)}</dd>
    <dt>Mediana</dt><dd>${median.toFixed(2)}</dd>`;
  const rows = geojson.features.slice(0, 8);
  const table = el('dataTable');
  table.querySelector('thead').innerHTML = `<tr><th>SEZ21_ID</th><th>${field}</th></tr>`;
  table.querySelector('tbody').innerHTML = rows.map(f =>
    `<tr><td>${f.properties.SEZ21_ID ?? ''}</td><td>${(f.properties[field] ?? '').toString()}</td></tr>`
  ).join('');
}
function setBasemap(key) {
  if (state.tileLayer) state.map.removeLayer(state.tileLayer);
  const b = BASEMAPS[key];
  state.tileLayer = L.tileLayer(b.url, { attribution: b.attr, subdomains: 'abc', maxZoom: 19 }).addTo(state.map);
}

async function refresh() {
  const entry = state.manifest.comuni.find(c => c.code === el('comuneSelect').value);
  if (!entry) return;
  const geojson = await loadComune(entry);
  const field = currentFieldKey();
  const indicator = el('indicatorSelect').value;   // es. "LST"

  // Valori annuali (per statistiche del pannello destro)
  const values = geojson.features.map(f => f.properties[field]).filter(v => v != null);
  if (values.length === 0) { console.warn(`Nessun valore per ${field}`); return; }

  // Valori di TUTTI gli anni disponibili per l'indicatore, uniti in un unico
  // array — usati per calcolare classi/colori fissi comuni a tutti gli anni.
  const yearFields = entry.years.map(y => `${indicator}_${y}`);
  const allYearsValues = [];
  for (const f of geojson.features) {
    for (const yf of yearFields) {
      const v = f.properties[yf];
      if (v != null) allYearsValues.push(v);
    }
  }

  const k = parseInt(el('numClasses').value, 10);
  const method = el('classSelect').value;
  const breaks = computeBreaks(allYearsValues, method, k);   // <-- classi FISSE
  const colors = rampColors(PALETTES[el('paletteSelect').value], breaks.length - 1);

  if (state.geoLayer) state.map.removeLayer(state.geoLayer);
  state.geoLayer = L.geoJSON(geojson, {
    renderer: L.canvas(),
    style: (f) => styleFeature(f, breaks, colors, field),
    onEachFeature: (f, layer) => {
      const v = f.properties[field];
      layer.bindTooltip(`${f.properties.SEZ21_ID ?? ''}: ${v ?? 'n/d'}`, { sticky: true });
    },
  }).addTo(state.map);

  try { state.map.fitBounds(state.geoLayer.getBounds(), { padding: [20, 20] }); } catch (e) {}
  renderLegend(breaks, colors, field);
  renderInfoPanel(entry, geojson, field, values);
}

// ---------- wiring ----------
function populateComuneSelect() {
  el('comuneSelect').innerHTML = state.manifest.comuni.map(c => `<option value="${c.code}">${c.name}</option>`).join('');
}
function populateIndicatorSelect(entry) {
  el('indicatorSelect').innerHTML = entry.indicators.map(i => `<option value="${i.key}">${i.label}</option>`).join('');
}
function populateYearSlider(entry) {
  const slider = el('yearSlider');
  slider.min = entry.years[0];
  slider.max = entry.years[entry.years.length - 1];
  slider.value = entry.years[entry.years.length - 1];
  el('yearVal').textContent = slider.value;
}
async function onComuneChange() {
  const entry = state.manifest.comuni.find(c => c.code === el('comuneSelect').value);
  populateIndicatorSelect(entry);
  populateYearSlider(entry);
  await refresh();
}

async function init() {
  state.map = L.map('map', { renderer: L.canvas() }).setView([43.6, 13.5], 12);
  setBasemap('osm');
  await loadManifest();
  populateComuneSelect();
  await onComuneChange();

  el('comuneSelect').addEventListener('change', onComuneChange);
  el('indicatorSelect').addEventListener('change', refresh);
  el('classSelect').addEventListener('change', refresh);
  el('paletteSelect').addEventListener('change', refresh);
  el('numClasses').addEventListener('input', () => { el('numClassesVal').textContent = el('numClasses').value; refresh(); });
  el('yearSlider').addEventListener('input', () => { el('yearVal').textContent = el('yearSlider').value; refresh(); });
  el('basemapSelect').addEventListener('change', () => setBasemap(el('basemapSelect').value));
}
init();
