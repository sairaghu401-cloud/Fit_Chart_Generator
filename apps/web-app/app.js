const API_CHART = "http://localhost:8001";
const API_FIT = "http://localhost:8000";
const FETCH_TIMEOUT_MS = 4000;

let demoMode = false;
let selectedImageFile = null;
let selectedTechpackFile = null;
let lastChart = null;
let lastRecommendation = null;
const artifactCache = {}; // sku_id -> artifact object, populated from real or simulated chart generation

const DEFAULT_ARTIFACT = {
  sku_id: "sku_demo_1", zones: ["shoulder", "chest", "waist", "sleeve"],
  sizes: ["S", "M", "L", "XL"],
  dims_cm: [[42.0, 92.0, 78.0, 57.0], [44.5, 100.0, 84.0, 59.0], [47.0, 108.0, 90.0, 61.0], [49.5, 116.0, 96.0, 63.0]],
  ease_min_cm: [1.5, 4.0, 3.0, 0.0], usable_stretch_pct: [0, 0, 0, 0], shrinkage_pct: 0.021,
  sigma: [1.2, 1.8, 1.6, 1.0], cutpoints: [-0.87, 1.24],
};

/* ================= theme ================= */
const themeToggle = document.getElementById('themeToggle');
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  themeToggle.innerHTML = t === 'dark' ? '<i class="fa-solid fa-sun" aria-hidden="true"></i>' : '<i class="fa-solid fa-moon" aria-hidden="true"></i>';
  localStorage.setItem('fitchart-theme', t);
}
applyTheme(localStorage.getItem('fitchart-theme') || 'light');
themeToggle.onclick = () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');

/* ================= fab + scroll ================= */
const fab = document.getElementById('fabTop');
window.addEventListener('scroll', () => fab.classList.toggle('show', window.scrollY > 400));
fab.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });

/* ================= reveal on scroll ================= */
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); revealObserver.unobserve(e.target); } });
}, { threshold: 0.15 });
document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

/* ================= animated counters (hero targets only) ================= */
function animateNum(el) {
  const target = parseFloat(el.dataset.target);
  const decimal = el.dataset.decimal === 'true';
  const prefix = el.dataset.prefix || '';
  const suffix = el.dataset.suffix || '';
  let cur = 0;
  const step = target / 40 || 0.01;
  const tick = () => {
    cur += step;
    if (cur >= target) cur = target;
    el.textContent = prefix + (decimal ? cur.toFixed(2) : Math.round(cur)) + suffix;
    if (cur < target) requestAnimationFrame(tick);
  };
  tick();
}
window.addEventListener('load', () => document.querySelectorAll('.hero-stats .num').forEach(animateNum));

/* ================= ripple ================= */
document.querySelectorAll('.btn-gradient').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 650);
  });
});

/* ================= toast ================= */
function toast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  while (container.children.length >= 3) container.firstChild.remove();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-circle-check' : 'fa-circle-exclamation'}" aria-hidden="true"></i><span>${message}</span><button class="toast-close" aria-label="Dismiss notification"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;
  el.querySelector('.toast-close').onclick = () => el.remove();
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/* ================= custom tooltip (interactive chart) ================= */
const globalTooltip = document.createElement('div');
globalTooltip.className = 'custom-tooltip';
document.body.appendChild(globalTooltip);
function positionTooltip(e) {
  const pad = 16;
  let x = e.pageX + pad, y = e.pageY + pad;
  if (x + 250 > window.innerWidth + window.scrollX) x = e.pageX - 250 - pad;
  globalTooltip.style.left = x + 'px';
  globalTooltip.style.top = y + 'px';
}
document.addEventListener('mouseover', (e) => {
  const cell = e.target.closest('[data-tip]');
  if (!cell) return;
  globalTooltip.textContent = cell.dataset.tip;
  globalTooltip.classList.add('show');
  positionTooltip(e);
});
document.addEventListener('mousemove', (e) => { if (globalTooltip.classList.contains('show')) positionTooltip(e); });
document.addEventListener('mouseout', (e) => { if (e.target.closest('[data-tip]')) globalTooltip.classList.remove('show'); });

/* ================= validation ================= */
function setFieldError(id, msg) {
  const input = document.getElementById(id);
  const err = document.getElementById('err-' + id);
  if (err) err.textContent = msg || '';
  if (input) input.classList.toggle('input-invalid', !!msg);
}
function clearFieldErrors(ids) { ids.forEach(id => setFieldError(id, '')); }

function validateSellerForm() {
  const ids = ['name', 'cotton', 'elastane', 'gsm'];
  clearFieldErrors(ids);
  const name = document.getElementById('name').value.trim();
  const cotton = Number(document.getElementById('cotton').value);
  const elastane = Number(document.getElementById('elastane').value);
  const gsm = Number(document.getElementById('gsm').value);
  let firstInvalid = null;
  if (!name) { setFieldError('name', 'Product name is required.'); firstInvalid = firstInvalid || 'name'; }
  if (isNaN(cotton) || cotton < 0 || cotton > 100) { setFieldError('cotton', 'Must be between 0 and 100%.'); firstInvalid = firstInvalid || 'cotton'; }
  if (isNaN(elastane) || elastane < 0 || elastane > 100) { setFieldError('elastane', 'Must be between 0 and 100%.'); firstInvalid = firstInvalid || 'elastane'; }
  if (isNaN(gsm) || gsm < 50 || gsm > 500) { setFieldError('gsm', 'Must be between 50 and 500.'); firstInvalid = firstInvalid || 'gsm'; }
  if (firstInvalid) {
    document.getElementById(firstInvalid).focus();
    toast('Please fix the highlighted fields.', 'error');
    return false;
  }
  return true;
}

function validateShopperForm() {
  const ids = ['height', 'weight'];
  clearFieldErrors(ids);
  document.getElementById('err-consent').textContent = '';
  const height = Number(document.getElementById('height').value);
  const weight = Number(document.getElementById('weight').value);
  const consented = document.getElementById('consentCheck').checked;
  let firstInvalid = null;
  if (isNaN(height) || height < 100 || height > 250) { setFieldError('height', 'Must be between 100 and 250 cm.'); firstInvalid = firstInvalid || 'height'; }
  if (isNaN(weight) || weight < 20 || weight > 250) { setFieldError('weight', 'Must be between 20 and 250 kg.'); firstInvalid = firstInvalid || 'weight'; }
  if (!consented) {
    document.getElementById('err-consent').textContent = 'Please accept the consent notice to continue.';
    firstInvalid = firstInvalid || 'consentCheck';
  }
  if (firstInvalid) {
    document.getElementById(firstInvalid).focus();
    toast('Please fix the highlighted fields.', 'error');
    return false;
  }
  return true;
}

/* ================= loading overlay + button spinner ================= */
const overlay = document.getElementById('loadingOverlay');
const overlayText = document.getElementById('loadingText');
function showLoading(text) { overlayText.textContent = text; overlay.classList.add('show'); }
function hideLoading() { overlay.classList.remove('show'); }
function setBtnLoading(btn, loading, label) {
  if (loading) {
    btn.dataset.label = btn.innerHTML;
    btn.innerHTML = `<span class="btn-spinner"></span> ${label}`;
    btn.disabled = true;
  } else {
    btn.innerHTML = btn.dataset.label;
    btn.disabled = false;
  }
}

/* ================= demo mode ================= */
function enterDemoMode() {
  if (demoMode) return;
  demoMode = true;
  const banner = document.getElementById('demoBanner');
  if (banner) banner.hidden = false;
  toast('Backend unreachable — switched to Demo Mode with simulated data.', 'error');
}

async function apiFetch(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ================= garment image dropzone ================= */
const dropzone = document.getElementById('dropzone');
const imageInput = document.getElementById('imageInput');
const dzEmpty = document.getElementById('dropzoneEmpty');
const dzPreview = document.getElementById('dropzonePreview');
const previewImg = document.getElementById('previewImg');
const previewName = document.getElementById('previewName');
const removeImageBtn = document.getElementById('removeImageBtn');
const browseBtn = document.getElementById('browseBtn');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const VALID_IMAGE_TYPES = ['image/jpeg', 'image/png'];

function openImageDialog() { imageInput.click(); }
browseBtn.addEventListener('click', (e) => { e.stopPropagation(); openImageDialog(); });
dzEmpty.addEventListener('click', openImageDialog);
dropzone.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && !dzEmpty.hidden) { e.preventDefault(); openImageDialog(); }
});
['dragenter', 'dragover'].forEach(evt => dropzone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(evt => dropzone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', (e) => { const file = e.dataTransfer.files && e.dataTransfer.files[0]; if (file) handleImageFile(file); });
imageInput.addEventListener('change', () => { const file = imageInput.files && imageInput.files[0]; if (file) handleImageFile(file); });

function handleImageFile(file) {
  const err = document.getElementById('err-image');
  err.textContent = '';
  if (!VALID_IMAGE_TYPES.includes(file.type)) {
    err.textContent = 'Only JPG, JPEG or PNG images are supported.';
    toast('Unsupported file type — please upload a JPG or PNG image.', 'error');
    imageInput.value = ''; return;
  }
  if (file.size > MAX_FILE_BYTES) {
    err.textContent = 'Image must be smaller than 8MB.';
    toast('That image is too large — max size is 8MB.', 'error');
    imageInput.value = ''; return;
  }
  selectedImageFile = file;
  const reader = new FileReader();
  reader.onload = (ev) => {
    previewImg.src = ev.target.result;
    previewName.textContent = file.name;
    dzEmpty.hidden = true;
    dzPreview.hidden = false;
    toast(`"${file.name}" ready — will be sent to chart-service on Generate.`, 'success');
  };
  reader.readAsDataURL(file);
}
removeImageBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  selectedImageFile = null;
  imageInput.value = '';
  previewImg.src = '';
  previewName.textContent = '';
  dzPreview.hidden = true;
  dzEmpty.hidden = false;
  document.getElementById('err-image').textContent = '';
  resetStatusNote('imageStatusNote', 'Selected image is sent to chart-service for mock AI extraction when you click Generate.');
});

/* ================= tech pack dropzone ================= */
const techpackZone = document.getElementById('techpackZone');
const techpackInput = document.getElementById('techpackInput');
const techpackEmpty = document.getElementById('techpackEmpty');
const techpackPreview = document.getElementById('techpackPreview');
const techpackName = document.getElementById('techpackName');
const removeTechpackBtn = document.getElementById('removeTechpackBtn');
const techpackBrowseBtn = document.getElementById('techpackBrowseBtn');

function openTechpackDialog() { techpackInput.click(); }
techpackBrowseBtn.addEventListener('click', (e) => { e.stopPropagation(); openTechpackDialog(); });
techpackEmpty.addEventListener('click', openTechpackDialog);
techpackZone.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && !techpackEmpty.hidden) { e.preventDefault(); openTechpackDialog(); }
});
['dragenter', 'dragover'].forEach(evt => techpackZone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); techpackZone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(evt => techpackZone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); techpackZone.classList.remove('dragover'); }));
techpackZone.addEventListener('drop', (e) => { const file = e.dataTransfer.files && e.dataTransfer.files[0]; if (file) handleTechpackFile(file); });
techpackInput.addEventListener('change', () => { const file = techpackInput.files && techpackInput.files[0]; if (file) handleTechpackFile(file); });

function handleTechpackFile(file) {
  const err = document.getElementById('err-techpack');
  err.textContent = '';
  if (file.type !== 'application/pdf') {
    err.textContent = 'Only PDF files are supported.';
    toast('Unsupported file type — please upload a PDF tech pack.', 'error');
    techpackInput.value = ''; return;
  }
  if (file.size > MAX_FILE_BYTES) {
    err.textContent = 'File must be smaller than 8MB.';
    toast('That file is too large — max size is 8MB.', 'error');
    techpackInput.value = ''; return;
  }
  selectedTechpackFile = file;
  techpackName.textContent = file.name;
  techpackEmpty.hidden = true;
  techpackPreview.hidden = false;
  toast(`"${file.name}" ready — will be sent to chart-service on Generate.`, 'success');
}
removeTechpackBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  selectedTechpackFile = null;
  techpackInput.value = '';
  techpackName.textContent = '';
  techpackPreview.hidden = true;
  techpackEmpty.hidden = false;
  document.getElementById('err-techpack').textContent = '';
  resetStatusNote('techpackStatusNote', 'Selected PDF is sent to chart-service for mock OCR/table extraction when you click Generate.');
});

function resetStatusNote(id, text) {
  const note = document.getElementById(id);
  if (!note) return;
  note.classList.remove('status-ok', 'status-error');
  note.innerHTML = `<i class="fa-solid fa-circle-info" aria-hidden="true"></i> ${text}`;
}

async function uploadAsset(skuId, kind, file) {
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('file', file);
  const res = await apiFetch(`${API_CHART}/v1/skus/${skuId}/assets`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error('asset_upload_failed');
  const data = await res.json();
  const noteId = kind === 'image' ? 'imageStatusNote' : 'techpackStatusNote';
  const note = document.getElementById(noteId);
  if (note) {
    note.classList.add('status-ok');
    note.innerHTML = `<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Received by backend (${data.size_kb} KB). ${data.mock_extraction.note}`;
  }
  return data;
}

/* ================= wash slider ================= */
const washInput = document.getElementById('wash');
washInput.addEventListener('input', () => document.getElementById('washVal').textContent = washInput.value);

/* ================= optional direct measurements ================= */
function readOptionalMeasurements() {
  const fields = { chestIn: 'chest_cm', waistIn: 'waist_cm', shoulderIn: 'shoulder_cm', sleeveIn: 'sleeve_cm' };
  const out = {};
  for (const [inputId, apiField] of Object.entries(fields)) {
    const raw = document.getElementById(inputId).value;
    if (raw !== '') out[apiField] = Number(raw);
  }
  return out;
}

/* ================= demo scenarios (call the real API, never bypass it) ================= */
const DEMO_SCENARIOS = {
  slim:    { height: 160, weight: 50, pref: 'tight',   usual: '' },
  average: { height: 175, weight: 75, pref: 'regular', usual: '' },
  tall:    { height: 187, weight: 83.5, pref: 'relaxed', usual: 'L' },
  large:   { height: 185, weight: 100, pref: 'relaxed', usual: 'XL' },
  extreme: { height: 205, weight: 165, pref: 'relaxed', usual: '' },
};
document.querySelectorAll('[data-scenario]').forEach(btn => {
  btn.addEventListener('click', () => {
    const s = DEMO_SCENARIOS[btn.dataset.scenario];
    document.getElementById('height').value = s.height;
    document.getElementById('weight').value = s.weight;
    document.getElementById('pref').value = s.pref;
    document.getElementById('usualSize').value = s.usual;
    ['chestIn', 'waistIn', 'shoulderIn', 'sleeveIn'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('consentCheck').checked = true;
    getRecommendation();
  });
});

/* ================= session stats (real, no fabricated numbers) ================= */
function bumpSessionStat(key, elId) {
  const n = (parseInt(localStorage.getItem(key) || '0', 10)) + 1;
  localStorage.setItem(key, n);
  const el = document.getElementById(elId);
  if (el) el.textContent = n;
  return n;
}
function recordConfidence(pct) {
  const arr = JSON.parse(localStorage.getItem('fitchart-conf-log') || '[]');
  arr.push(pct);
  if (arr.length > 100) arr.shift();
  localStorage.setItem('fitchart-conf-log', JSON.stringify(arr));
  const avg = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  const el = document.getElementById('statAvgConf');
  if (el) el.textContent = avg + '%';
}
(function initStats() {
  const charts = parseInt(localStorage.getItem('fitchart-count') || '0', 10);
  const recs = parseInt(localStorage.getItem('fitchart-rec-count') || '0', 10);
  const chartsEl = document.getElementById('statCharts');
  const recsEl = document.getElementById('statRecs');
  if (chartsEl) chartsEl.textContent = charts;
  if (recsEl) recsEl.textContent = recs;
  const arr = JSON.parse(localStorage.getItem('fitchart-conf-log') || '[]');
  if (arr.length) {
    const avg = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    const el = document.getElementById('statAvgConf');
    if (el) el.textContent = avg + '%';
  }
})();

/* ================= AI pipeline visualization ================= */
const SELLER_STEPS = [
  { id: 'image', name: 'Image Agent', icon: 'fa-image' },
  { id: 'fabric', name: 'Fabric Agent', icon: 'fa-shirt' },
  { id: 'measure', name: 'Measurement Agent', icon: 'fa-ruler-combined' },
  { id: 'chart', name: 'Chart Generator', icon: 'fa-table-cells' },
  { id: 'quality', name: 'Quality Validator', icon: 'fa-shield-halved' },
];
const SHOPPER_STEPS = [
  { id: 'bayes', name: 'Bayesian Fit Agent', icon: 'fa-chart-simple' },
  { id: 'rec', name: 'Recommendation Agent', icon: 'fa-robot' },
];

function buildPipelineHtml(containerId, steps) {
  return `<div class="pipeline-run">
    <div class="pipeline-progress-track"><div class="pipeline-progress-fill" id="${containerId}-fill"></div></div>
    ${steps.map(s => `<div class="pipeline-step" id="${containerId}-${s.id}">
      <span class="step-icon"><i class="fa-solid ${s.icon}" aria-hidden="true"></i></span>
      <span class="step-name">${s.name}</span>
      <span class="step-status">Pending</span>
    </div>`).join('')}
  </div>`;
}

async function runPipelineAnimation(containerId, steps, stepMs = 320) {
  for (let i = 0; i < steps.length; i++) {
    const stepEl = document.getElementById(`${containerId}-${steps[i].id}`);
    if (!stepEl) continue;
    stepEl.classList.add('running');
    stepEl.querySelector('.step-status').textContent = 'Running';
    await new Promise(r => setTimeout(r, stepMs));
    stepEl.classList.remove('running');
    stepEl.classList.add('done');
    stepEl.querySelector('.step-status').textContent = 'Done';
    const fill = document.getElementById(`${containerId}-fill`);
    if (fill) fill.style.width = Math.round(((i + 1) / steps.length) * 100) + '%';
  }
}

/* ================= client-side mock math (mirrors backend, demo-mode fallback only) ================= */
function erf(x) {
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function phi(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

function mockMechanics(cotton, elastane) {
  const stretchPct = Math.min(elastane * 0.04, 0.35);
  const shrink = 0.03 * (cotton / 100);
  return {
    usable_stretch_pct: [stretchPct, stretchPct, stretchPct, stretchPct],
    shrinkage_pct: Math.round(shrink * 10000) / 10000,
    ease_min_cm: stretchPct === 0 ? [1.5, 4.0, 3.0, 0.0] : [1.0, 2.5, 2.0, 0.0],
  };
}

function buildMockChart(name, category, cotton, elastane, gsm) {
  const skuId = 'sku_sim_' + Math.random().toString(36).slice(2, 8);
  const zones = ['shoulder', 'chest', 'waist', 'sleeve'];
  const dims = [[42.0, 92.0, 78.0, 57.0], [44.5, 100.0, 84.0, 59.0], [47.0, 108.0, 90.0, 61.0], [49.5, 116.0, 96.0, 63.0]];
  const sizeLabels = ['S', 'M', 'L', 'XL'];
  const mech = mockMechanics(cotton, elastane);
  const outlierFlags = [];
  if (elastane > 20) {
    outlierFlags.push({ field: 'composition.elastane', severity: 'high', reason: `${elastane}% elastane is unusually high for this category.`, action: 'blocks_publish' });
  }

  const sizes = sizeLabels.map((label, i) => {
    const row = { label, confidence: 0.9 };
    const explanations = {};
    zones.forEach((zone, zi) => {
      const val = Math.round(dims[i][zi] * 10) / 10;
      const ease = mech.ease_min_cm[zi];
      explanations[`${zone}_cm`] = `${val} cm = body ${zone} + ${ease} cm ease. ${mech.usable_stretch_pct[zi] ? 'Stretch credit ' + Math.round(mech.usable_stretch_pct[zi] * 1000) / 10 + '%.' : 'No stretch credit: zero-stretch fabric.'}`;
      row[`${zone}_cm`] = val;
    });
    row.explanations = explanations;
    row.post_wash = { washes: 5 };
    zones.forEach((zone, zi) => { row.post_wash[`${zone}_cm`] = Math.round(dims[i][zi] * (1 - mech.shrinkage_pct) * 10) / 10; });
    return row;
  });

  const status = outlierFlags.length ? 'blocked' : 'simulated';
  return {
    sku_id: skuId, version: 1, status, simulated: true,
    generated_in_ms: 900,
    sizes, outlier_flags: outlierFlags,
    artifact: {
      sku_id: skuId, artifact_version: 1, sizes: sizeLabels, zones, dims_cm: dims,
      ease_min_cm: mech.ease_min_cm, usable_stretch_pct: mech.usable_stretch_pct,
      shrinkage_pct: mech.shrinkage_pct, sigma: [1.2, 1.8, 1.6, 1.0], cutpoints: [-0.87, 1.24],
    },
  };
}

function estimateBodyZones(height, weight) {
  return {
    shoulder: height * 0.245,
    chest: height * 0.53 + weight * 0.18,
    waist: height * 0.46 + weight * 0.22,
    sleeve: height * 0.32,
  };
}

function buildMockRecommend(skuId, height, weight, washHorizon, usualSize) {
  const start = performance.now();
  const art = artifactCache[skuId] || DEFAULT_ARTIFACT;
  const zones = art.zones, sizes = art.sizes, dims = art.dims_cm;
  const ease = art.ease_min_cm, stretch = art.usable_stretch_pct, shrink = art.shrinkage_pct;
  const sigma = art.sigma, cutpoints = art.cutpoints;
  const bodyZones = estimateBodyZones(height, weight);

  let perSize = sizes.map((size, i) => {
    const uVals = zones.map((zone, zi) => {
      const shrinkFactor = shrink * Math.min(washHorizon / 5, 1);
      const effective = dims[i][zi] * (1 - shrinkFactor) * (1 + stretch[zi]);
      const required = bodyZones[zone] + ease[zi];
      return (effective - required) / sigma[zi];
    });
    const tau = 1.0;
    const uTight = -tau * Math.log(uVals.reduce((a, u) => a + Math.exp(-u / tau), 0));
    const uLoose = uVals.reduce((a, u) => a + u, 0) / uVals.length;
    const pSmall = phi(cutpoints[0] - uTight);
    const pLarge = 1 - phi(cutpoints[1] - uLoose);
    const pFit = Math.max(0, 1 - pSmall - pLarge);
    let bindingIdx = 0;
    uVals.forEach((u, idx) => { if (u < uVals[bindingIdx]) bindingIdx = idx; });
    const zoneSlack = {};
    zones.forEach((z, zi) => { zoneSlack[z] = Math.round(uVals[zi] * sigma[zi] * 100) / 100; });
    return { size, p_small: Math.round(pSmall * 1000) / 1000, p_fit: pFit, p_large: Math.round(pLarge * 1000) / 1000, binding_zone: zones[bindingIdx], zone_slack_cm: zoneSlack };
  });

  // Same 80/20 probability-space usual-size prior as the real backend: a
  // small, non-overriding calibration nudge, applied only when provided.
  if (usualSize && sizes.includes(usualSize)) {
    const priorOf = (size) => {
      const rankDiff = Math.abs(sizes.indexOf(size) - sizes.indexOf(usualSize));
      return Math.exp(-(rankDiff * rankDiff) / 2);
    };
    const priorTotal = sizes.reduce((sum, s) => sum + priorOf(s), 0);
    perSize = perSize.map(s => ({ ...s, p_fit: 0.8 * s.p_fit + 0.2 * (priorOf(s.size) / priorTotal) }));
  }
  perSize = perSize.map(s => ({ ...s, p_fit: Math.round(s.p_fit * 1000) / 1000 }));

  const best = perSize.reduce((a, b) => (b.p_fit > a.p_fit ? b : a));
  const explanations = [
    `${best.size} is the best fit (${Math.round(best.p_fit * 100)}% confident, simulated). Binding zone: ${best.binding_zone} with ${best.zone_slack_cm[best.binding_zone]} cm slack.`,
  ];
  if (washHorizon > 0) explanations.push(`Forecast after ${washHorizon} washes: fabric shrinks ${Math.round(shrink * 1000) / 10}% (simulated).`);
  if (usualSize) {
    explanations.push(best.size === usualSize
      ? `Your usual ${usualSize} size also supports this recommendation.`
      : `Your usual size is ${usualSize}, but the measurements suggest ${best.size} may provide a closer fit for this garment.`);
  }

  return {
    recommended_size: best.size, confidence: best.p_fit, per_size: perSize, explanations,
    privacy: { raw_image_retained: false, processed: 'client-simulated' },
    trace_id: 'sim_' + Math.random().toString(36).slice(2, 10),
    latency_ms: Math.round((performance.now() - start) * 10) / 10,
    simulated: true,
  };
}

/* ================= seller: generate chart ================= */
document.getElementById('generateBtn').onclick = generateChart;

async function doGenerateChartWork(name, category, cotton, elastane, gsm) {
  const fabric = { composition: { cotton, elastane }, gsm, is_preshrunk: false };
  try {
    const skuRes = await apiFetch(`${API_CHART}/v1/skus`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, category, fabric }),
    });
    if (!skuRes.ok) throw new Error('sku_create_failed');
    const sku = await skuRes.json();

    if (selectedImageFile) await uploadAsset(sku.sku_id, 'image', selectedImageFile).catch(() => {
      const n = document.getElementById('imageStatusNote'); if (n) { n.classList.add('status-error'); n.innerHTML = '<i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i> Could not reach backend for this file.'; }
    });
    if (selectedTechpackFile) await uploadAsset(sku.sku_id, 'techpack', selectedTechpackFile).catch(() => {
      const n = document.getElementById('techpackStatusNote'); if (n) { n.classList.add('status-error'); n.innerHTML = '<i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i> Could not reach backend for this file.'; }
    });

    const chartRes = await apiFetch(`${API_CHART}/v1/skus/${sku.sku_id}/generate-chart`, { method: "POST" });
    if (!chartRes.ok) throw new Error('chart_generate_failed');
    return await chartRes.json();
  } catch (err) {
    enterDemoMode();
    return buildMockChart(name, category, cotton, elastane, gsm);
  }
}

async function generateChart() {
  if (!validateSellerForm()) return;
  const btn = document.getElementById('generateBtn');
  const out = document.getElementById('sellerResult');
  setBtnLoading(btn, true, 'Generating...');
  out.innerHTML = buildPipelineHtml('sellerPipe', SELLER_STEPS);
  showLoading('Running AI agent pipeline...');

  const name = document.getElementById('name').value.trim();
  const category = document.getElementById('category').value;
  const cotton = Number(document.getElementById('cotton').value);
  const elastane = Number(document.getElementById('elastane').value);
  const gsm = Number(document.getElementById('gsm').value);

  const animPromise = runPipelineAnimation('sellerPipe', SELLER_STEPS);
  const [chart] = await Promise.all([
    doGenerateChartWork(name, category, cotton, elastane, gsm),
    animPromise,
  ]);

  lastChart = chart;
  artifactCache[chart.sku_id] = chart.artifact;
  renderSellerResult(chart);
  document.getElementById('sku').value = chart.sku_id;
  bumpSessionStat('fitchart-count', 'statCharts');
  toast(`Chart ${chart.status}${chart.simulated ? ' (simulated)' : ''} for ${chart.sku_id}`, chart.status === 'blocked' ? 'error' : 'success');

  hideLoading();
  setBtnLoading(btn, false);
}

function statusBadge(chart) {
  if (chart.status === 'blocked') return { cls: 'badge-red', icon: 'fa-circle-exclamation', label: 'Blocked' };
  if (chart.simulated) return { cls: 'badge-neutral', icon: 'fa-flask', label: 'Simulated' };
  return { cls: 'badge-green', icon: 'fa-circle-check', label: 'Published' };
}

function renderSellerResult(chart) {
  const out = document.getElementById('sellerResult');
  const sb = statusBadge(chart);
  const avgConf = Math.round((chart.sizes.reduce((a, s) => a + s.confidence, 0) / chart.sizes.length) * 100);

  let html = `<div class="status-line">
    <span class="badge ${sb.cls}"><i class="fa-solid ${sb.icon}" aria-hidden="true"></i> ${sb.label}</span>
    <span class="badge badge-neutral">${chart.sku_id}</span>
    <button type="button" class="copy-btn" id="copySkuBtn" aria-label="Copy SKU ${chart.sku_id} to clipboard"><i class="fa-solid fa-copy" aria-hidden="true"></i> Copy SKU</button>
    <span class="badge badge-neutral"><i class="fa-solid fa-stopwatch" aria-hidden="true"></i> ${(chart.generated_in_ms / 1000).toFixed(1)}s pipeline</span>
    <span class="badge badge-neutral"><i class="fa-solid fa-bullseye" aria-hidden="true"></i> Avg confidence ${avgConf}%</span>
    <span class="badge badge-neutral" title="Demo model tag — not a production ML registry version"><i class="fa-solid fa-code-branch" aria-hidden="true"></i> fit-core v1.0 (mock)</span>
  </div>`;

  for (const f of chart.outlier_flags || []) {
    html += `<div class="flag-card"><b>⚠ ${f.field}</b> (${f.severity}) — ${f.reason}</div>`;
  }

  html += `<div class="chart-toolbar">
    <button type="button" class="chip-btn" id="exportCsvBtn"><i class="fa-solid fa-file-csv" aria-hidden="true"></i> Export CSV</button>
    <button type="button" class="chip-btn" id="exportPdfBtn"><i class="fa-solid fa-file-pdf" aria-hidden="true"></i> Export PDF</button>
    <button type="button" class="chip-btn report" id="downloadReportBtn"><i class="fa-solid fa-file-lines" aria-hidden="true"></i> Download Report</button>
  </div>`;

  html += `<div class="table-wrap"><table><thead><tr><th>Size</th><th>Shoulder</th><th>Chest</th><th>Waist</th><th>Sleeve</th><th>5-wash chest</th></tr></thead><tbody>`;
  for (const s of chart.sizes) {
    html += `<tr>
      <td><b>${s.label}</b></td>
      <td data-tip="${s.explanations.shoulder_cm}">${s.shoulder_cm}</td>
      <td data-tip="${s.explanations.chest_cm}">${s.chest_cm}</td>
      <td data-tip="${s.explanations.waist_cm}">${s.waist_cm}</td>
      <td data-tip="${s.explanations.sleeve_cm}">${s.sleeve_cm}</td>
      <td data-tip="Forecast chest width after 5 washes, based on this fabric's shrinkage rate.">${s.post_wash.chest_cm}</td>
    </tr>`;
  }
  html += `</tbody></table></div>`;
  out.innerHTML = html;

  document.getElementById('copySkuBtn').onclick = async () => {
    const copyBtn = document.getElementById('copySkuBtn');
    try {
      await navigator.clipboard.writeText(chart.sku_id);
      copyBtn.classList.add('copied');
      copyBtn.innerHTML = `<i class="fa-solid fa-check" aria-hidden="true"></i> Copied`;
      toast('SKU copied to clipboard.', 'success');
      setTimeout(() => { copyBtn.classList.remove('copied'); copyBtn.innerHTML = `<i class="fa-solid fa-copy" aria-hidden="true"></i> Copy SKU`; }, 2000);
    } catch { toast('Could not copy SKU — please copy it manually.', 'error'); }
  };

  document.getElementById('exportCsvBtn').onclick = () => {
    let csv = 'Size,Shoulder (cm),Chest (cm),Waist (cm),Sleeve (cm),5-Wash Chest (cm)\n';
    for (const s of chart.sizes) csv += `${s.label},${s.shoulder_cm},${s.chest_cm},${s.waist_cm},${s.sleeve_cm},${s.post_wash.chest_cm}\n`;
    downloadBlob(csv, `${chart.sku_id}_size_chart.csv`, 'text/csv');
    toast('Size chart CSV downloaded.', 'success');
  };
  document.getElementById('exportPdfBtn').onclick = () => {
    toast('Opening print dialog — choose "Save as PDF".', 'success');
    setTimeout(() => window.print(), 300);
  };
  document.getElementById('downloadReportBtn').onclick = downloadReport;
}

function downloadReport() {
  let txt = `FitChart AI — Report\nGenerated: ${new Date().toISOString()}\n${'='.repeat(40)}\n\n`;
  if (lastChart) {
    txt += `SKU: ${lastChart.sku_id}\nStatus: ${lastChart.status}${lastChart.simulated ? ' (simulated — backend was unreachable)' : ''}\nPipeline time: ${(lastChart.generated_in_ms / 1000).toFixed(1)}s\n\nSize Chart:\n`;
    for (const s of lastChart.sizes) txt += `  ${s.label}: shoulder ${s.shoulder_cm}cm, chest ${s.chest_cm}cm, waist ${s.waist_cm}cm, sleeve ${s.sleeve_cm}cm\n`;
  } else {
    txt += 'No size chart generated yet in this session.\n';
  }
  txt += '\n';
  if (lastRecommendation) {
    txt += `Recommendation:\n  Size: ${lastRecommendation.recommended_size} (${Math.round(lastRecommendation.confidence * 100)}% confidence)${lastRecommendation.simulated ? ' (simulated)' : ''}\n  Latency: ${lastRecommendation.latency_ms}ms\n`;
  } else {
    txt += 'No fit recommendation generated yet in this session.\n';
  }
  downloadBlob(txt, 'fitchart_report.txt', 'text/plain');
  toast('Report downloaded.', 'success');
}

/* ================= shopper: recommendation ================= */
document.getElementById('recommendBtn').onclick = getRecommendation;

async function getRecommendation() {
  if (!validateShopperForm()) return;
  const btn = document.getElementById('recommendBtn');
  const out = document.getElementById('shopperResult');
  setBtnLoading(btn, true, 'Analyzing...');
  out.innerHTML = buildPipelineHtml('shopperPipe', SHOPPER_STEPS);
  showLoading('Computing Bayesian fit posterior...');

  const skuId = document.getElementById('sku').value.trim();
  const height = Number(document.getElementById('height').value);
  const weight = Number(document.getElementById('weight').value);
  const pref = document.getElementById('pref').value;
  const usualSize = document.getElementById('usualSize').value;
  const washHorizon = Number(document.getElementById('wash').value);
  const optionalMeasurements = readOptionalMeasurements();

  const animPromise = runPipelineAnimation('shopperPipe', SHOPPER_STEPS);
  const workPromise = (async () => {
    try {
      const bodyPayload = { height_cm: height, weight_kg: weight, fit_preference: pref, ...optionalMeasurements };
      if (usualSize) bodyPayload.usual_size = usualSize;
      const res = await apiFetch(`${API_FIT}/v1/fit/recommend`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku_id: skuId, body: bodyPayload, wash_horizon: washHorizon }),
      });
      if (!res.ok) {
        if (res.status === 404) throw new Error('not_found');
        throw new Error('recommend_failed');
      }
      return await res.json();
    } catch (err) {
      if (err.message === 'not_found') {
        hideLoading(); setBtnLoading(btn, false);
        out.innerHTML = `<div class="flag-card"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> No chart found for "${skuId}". Generate one in Seller Studio first.</div>`;
        toast('No chart found for this SKU.', 'error');
        throw err;
      }
      enterDemoMode();
      return buildMockRecommend(skuId, height, weight, washHorizon, usualSize);
    }
  })();

  let r;
  try {
    [r] = await Promise.all([workPromise, animPromise]);
  } catch {
    hideLoading(); setBtnLoading(btn, false);
    return;
  }

  lastRecommendation = r;
  renderShopperResult(r, skuId, { height, weight });
  const latEl = document.getElementById('statLatency');
  if (latEl) { latEl.textContent = r.latency_ms + ' ms'; }
  bumpSessionStat('fitchart-rec-count', 'statRecs');
  recordConfidence(Math.round(r.confidence * 100));
  toast(`Recommended size ${r.recommended_size} in ${r.latency_ms}ms${r.simulated ? ' (simulated)' : ''}`, 'success');

  hideLoading();
  setBtnLoading(btn, false);
}

function matchClass(pct) {
  if (pct >= 80) return { cls: 'match-excellent', label: 'Excellent Fit' };
  if (pct >= 55) return { cls: 'match-good', label: 'Good Fit' };
  return { cls: 'match-low', label: 'Poor Fit' };
}

function renderShopperResult(r, skuId, inputBody) {
  const out = document.getElementById('shopperResult');
  const pct = Math.round(r.confidence * 100);
  const m = matchClass(pct);
  const radius = 52, circ = 2 * Math.PI * radius;
  const offset = circ * (1 - r.confidence);

  const risk = r.fit_risk || { level: 'LOW', reasons: [] };
  const riskCls = { LOW: 'risk-low', MEDIUM: 'risk-medium', HIGH: 'risk-high' }[risk.level] || 'risk-low';

  let html = '';

  if (r.no_suitable_size) {
    const g = r.guidance || {};
    const problems = Object.entries(g.problems || {}).map(([z, v]) => `${z} (${v} cm)`).join(', ');
    html += `<div class="no-suitable-banner">
      <b><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> No suitable size found</b>
      Closest available: <b>${g.closest_available || r.recommended_size}</b>${problems ? ` — insufficient ease at: ${problems}` : ''}.
      ${g.suggested_action ? `<br>${g.suggested_action}` : ''}
    </div>`;
  }

  html += `<div class="rec-hero">
    <div class="label"><i class="fa-solid fa-bullseye" aria-hidden="true"></i> Recommended Size ${r.simulated ? '<span class="demo-tag">Simulated</span>' : ''}</div>
    <div class="ring-wrap">
      <svg viewBox="0 0 120 120">
        <defs><linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#4f46e5"/><stop offset="100%" stop-color="#9333ea"/>
        </linearGradient></defs>
        <circle class="ring-bg" cx="60" cy="60" r="${radius}"></circle>
        <circle class="ring-fill" cx="60" cy="60" r="${radius}" stroke-dasharray="${circ}" stroke-dashoffset="${circ}" data-offset="${offset}"></circle>
      </svg>
      <div class="ring-center"><div class="ring-size">${r.recommended_size}</div><div class="ring-pct">${pct}%</div></div>
    </div>
    <div class="match-badge ${m.cls}">${m.label}</div>
    <div style="margin-top:8px"><span class="risk-badge ${riskCls}"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> ${risk.level} risk</span></div>
    <div class="progress-track" style="max-width:220px;margin:10px auto 0"><div class="progress-fill" data-w="${pct}" style="background:linear-gradient(90deg,var(--blue),var(--purple))"></div></div>
    <div class="latency-pill"><i class="fa-solid fa-bolt" aria-hidden="true"></i> ${r.latency_ms} ms response time · fit-core v1.0</div>
  </div>`;

  if (r.body_profile) {
    html += `<div class="profile-card"><i class="fa-solid fa-person" aria-hidden="true"></i>
      <div><b>${r.body_profile.label}</b><small>Based on ${r.body_profile.basis}</small></div>
    </div>`;
  }

  html += `<div class="why-title"><i class="fa-solid fa-chart-simple" aria-hidden="true"></i> Fit Probability by Size</div>`;
  for (const s of r.per_size) {
    const sp = Math.round(s.p_fit * 100);
    html += `<div class="size-row"><span class="sz">${s.size}</span>
      <div class="progress-track"><div class="progress-fill" data-w="${sp}"></div></div>
      <span class="pct">${sp}%</span></div>`;
  }

  const best = r.per_size.find(s => s.size === r.recommended_size) || r.per_size[0];
  const slack = best.zone_slack_cm || {};
  const shrinkExpl = r.explanations.find(e => /wash|shrink/i.test(e));

  html += `<div class="why-title"><i class="fa-solid fa-circle-question" aria-hidden="true"></i> Why This Size?</div><div class="why-grid">`;
  html += `<div class="why-card"><b><i class="fa-solid fa-shirt" aria-hidden="true"></i>Chest Fit</b>${slack.chest !== undefined ? (slack.chest >= 0 ? '+' : '') + slack.chest + ' cm slack' : 'Closest to body measurement'}</div>`;
  html += `<div class="why-card"><b><i class="fa-solid fa-ruler-horizontal" aria-hidden="true"></i>Waist Ease</b>${slack.waist !== undefined ? (slack.waist >= 0 ? '+' : '') + slack.waist + ' cm ease' : 'Comfort ease applied'}</div>`;
  html += `<div class="why-card"><b><i class="fa-solid fa-hand-point-right" aria-hidden="true"></i>Sleeve Length</b>${slack.sleeve !== undefined ? (slack.sleeve >= 0 ? '+' : '') + slack.sleeve + ' cm slack' : 'Ideal reach'}</div>`;
  html += `<div class="why-card"><b><i class="fa-solid fa-droplet" aria-hidden="true"></i>Fabric Shrinkage</b>${shrinkExpl ? shrinkExpl : 'Increase wash horizon to preview post-wash shrinkage'}</div>`;
  html += `</div>`;

  if (r.size_comparison && (r.size_comparison.smaller || r.size_comparison.larger)) {
    html += `<div class="why-title"><i class="fa-solid fa-arrows-left-right" aria-hidden="true"></i> Why Not the Next Size?</div><div class="why-grid">`;
    if (r.size_comparison.smaller) {
      html += `<div class="why-card"><b><i class="fa-solid fa-arrow-down" aria-hidden="true"></i>Why not ${r.size_comparison.smaller.size}?</b>${r.size_comparison.smaller.reason}</div>`;
    }
    if (r.size_comparison.larger) {
      html += `<div class="why-card"><b><i class="fa-solid fa-arrow-up" aria-hidden="true"></i>Why not ${r.size_comparison.larger.size}?</b>${r.size_comparison.larger.reason}</div>`;
    }
    html += `</div>`;
  }

  // Explainability detail — pulls real values from the request + cached artifact, never fabricated
  const art = artifactCache[skuId];
  html += `<div class="why-title"><i class="fa-solid fa-list-check" aria-hidden="true"></i> Full Explanation</div><div class="explain-detail">`;
  html += `<div class="explain-row"><span class="k">Your height / weight</span><span class="v">${inputBody.height} cm / ${inputBody.weight} kg</span></div>`;
  if (r.measurement_sources) {
    const tags = Object.entries(r.measurement_sources)
      .map(([zone, src]) => `${zone}<span class="source-tag source-${src}">${src}</span>`).join(' &nbsp; ');
    html += `<div class="explain-row"><span class="k">Measurement sources</span><span class="v">${tags}</span></div>`;
  }
  if (art) {
    const idx = art.sizes.indexOf(r.recommended_size);
    const zi = {}; art.zones.forEach((z, i) => zi[z] = i);
    html += `<div class="explain-row"><span class="k">Garment measurements (${r.recommended_size})</span><span class="v">${art.zones.map(z => `${z} ${art.dims_cm[idx][zi[z]]}cm`).join(', ')}</span></div>`;
    html += `<div class="explain-row"><span class="k">Ease allowance</span><span class="v">${art.zones.map(z => `${z} +${art.ease_min_cm[zi[z]]}cm`).join(', ')}</span></div>`;
    html += `<div class="explain-row"><span class="k">Fabric stretch</span><span class="v">${Math.round((art.usable_stretch_pct[0] || 0) * 1000) / 10}%</span></div>`;
    html += `<div class="explain-row"><span class="k">Shrinkage rate</span><span class="v">${Math.round(art.shrinkage_pct * 1000) / 10}%</span></div>`;
  } else {
    html += `<div class="explain-row"><span class="k">Garment / ease / stretch / shrinkage</span><span class="v">Not cached — reload the chart to see full detail</span></div>`;
  }
  html += `<div class="explain-row"><span class="k">Wash prediction</span><span class="v">${r.explanations.find(e => /wash/i.test(e)) || 'Set wash horizon > 0 to preview'}</span></div>`;
  html += `<div class="explain-row"><span class="k">Confidence</span><span class="v">${pct}% (${m.label})</span></div>`;
  html += `</div>`;

  if (art) {
    html += `<div class="chart-toolbar" style="margin-top:14px">
      <button type="button" class="chip-btn" id="viewFullChartBtn"><i class="fa-solid fa-table-list" aria-hidden="true"></i> View Full Size Chart</button>
      <button type="button" class="chip-btn" id="exportRecCsvBtn"><i class="fa-solid fa-file-csv" aria-hidden="true"></i> Export CSV</button>
    </div>
    <div id="fullChartWrap" hidden></div>`;
  }

  html += `<div class="priv-note"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> Raw image retained: ${r.privacy.raw_image_retained} · Processed: ${r.privacy.processed}</div>`;

  out.innerHTML = html;
  requestAnimationFrame(() => {
    out.querySelectorAll('.progress-fill').forEach(el => { el.style.width = el.dataset.w + '%'; });
    const ring = out.querySelector('.ring-fill');
    if (ring) ring.style.strokeDashoffset = ring.dataset.offset;
  });

  if (art) {
    document.getElementById('viewFullChartBtn').onclick = () => toggleFullChart(art, r.recommended_size);
    document.getElementById('exportRecCsvBtn').onclick = () => {
      let csv = 'Size,' + art.zones.map(z => z + ' (cm)').join(',') + '\n';
      art.sizes.forEach((size, i) => { csv += size + ',' + art.dims_cm[i].join(',') + '\n'; });
      downloadBlob(csv, `${skuId}_full_chart.csv`, 'text/csv');
      toast('Full size chart CSV downloaded.', 'success');
    };
  }
}

function toggleFullChart(art, recommendedSize) {
  const wrap = document.getElementById('fullChartWrap');
  if (!wrap.hidden) { wrap.hidden = true; return; }
  let html = `<div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Size</th>${art.zones.map(z => `<th>${z}</th>`).join('')}</tr></thead><tbody>`;
  art.sizes.forEach((size, i) => {
    const rowClass = size === recommendedSize ? ' class="row-recommended"' : '';
    html += `<tr${rowClass}><td><b>${size}</b>${size === recommendedSize ? ' <i class="fa-solid fa-star" aria-hidden="true" title="Recommended"></i>' : ''}</td>${art.dims_cm[i].map(v => `<td>${v} cm</td>`).join('')}</tr>`;
  });
  html += `</tbody></table></div>`;
  wrap.innerHTML = html;
  wrap.hidden = false;
}
