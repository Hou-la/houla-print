// @ts-check

/**
 * Hou.la Print — Renderer process (UI logic)
 * Communicates with main process via the `houlaPrint` bridge exposed by preload.
 */

/** @type {typeof window & { houlaPrint: any }} */
const win = /** @type {any} */ (window);
const api = win.houlaPrint;

console.log('[Renderer] houlaPrint bridge available:', !!api);
if (!api) {
  console.error('[Renderer] FATAL: houlaPrint bridge not found. Preload script may have failed.');
}

// ═══════════════════════════════════════════════════════
// i18n — provided by window.i18n (generated from shared locales)
// ═══════════════════════════════════════════════════════

/** @type {{ t: Function, interpolate: Function, isLanguage: Function, LANGUAGES: any[], DEFAULT_LANGUAGE: string }} */
const i18n = win.i18n || {
  t: (k) => k,
  interpolate: (s) => s,
  isLanguage: () => false,
  LANGUAGES: [],
  DEFAULT_LANGUAGE: 'fr',
};

/** Current UI language — kept in sync with the persisted store value. */
let currentLang = i18n.DEFAULT_LANGUAGE;

/** Translate a key in the current language, with optional ${...} interpolation. */
function tr(key, vars) {
  return i18n.t(key, currentLang, vars);
}

/**
 * Walk the DOM and apply translations to every element carrying a
 * data-i18n* attribute. Sets textContent for data-i18n and the matching
 * attribute for data-i18n-title / -placeholder / -alt.
 */
function applyTranslations(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = tr(el.getAttribute('data-i18n'));
  });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', tr(el.getAttribute('data-i18n-title')));
  });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', tr(el.getAttribute('data-i18n-placeholder')));
  });
  scope.querySelectorAll('[data-i18n-alt]').forEach((el) => {
    el.setAttribute('alt', tr(el.getAttribute('data-i18n-alt')));
  });
  document.documentElement.setAttribute('lang', currentLang);
}

/**
 * Set the active language: persist it via the store and re-render the UI live.
 */
async function setLanguage(lang) {
  if (!i18n.isLanguage(lang) || lang === currentLang) return;
  currentLang = lang;
  try {
    await api.setLanguage(lang);
  } catch (err) {
    console.error('[Renderer] setLanguage failed:', err);
  }
  applyTranslations();
  const sel = document.getElementById('setting-language');
  if (sel) sel.value = currentLang;
  // Re-render the dynamic lists so their generated strings pick up the new language
  if (currentState) updateUI(currentState);
}

// ═══════════════════════════════════════════════════════
// DOM references
// ═══════════════════════════════════════════════════════

const $viewLogin = document.getElementById('view-login');
const $viewDashboard = document.getElementById('view-dashboard');
const $statusDot = document.getElementById('status-dot');
const $statusText = document.getElementById('status-text');
const $statPending = document.getElementById('stat-pending');
const $statToday = document.getElementById('stat-today');
const $statFailed = document.getElementById('stat-failed');
const $sepFailed = document.getElementById('sep-failed');
const $workspaceList = document.getElementById('workspace-list');
const $printerList = document.getElementById('printer-list');
const $offlineBanners = document.getElementById('offline-banners');
const $errorBanner = document.getElementById('error-banner');
const $errorText = document.getElementById('error-text');
const $envBadge = document.getElementById('env-badge');
const $settingEnv = document.getElementById('setting-env');
const $settingApiUrl = document.getElementById('setting-api-url');
const $historyList = document.getElementById('history-list');

const PRINTER_TYPE_ICONS = {
  thermal: '🏷️',
  receipt: '🧾',
  standard: '🖨️',
  niimbot: '🔵',
  unknown: '❓',
};

/** Known label sizes (value only — labels come from translations via label-size.<value>) */
const LABEL_SIZE_VALUES = ['57x32', '50x30', '40x30', '50x25', '100x50', '100x100', '100x150'];

/** Translated label for a given label-size value. */
function labelSizeLabel(value) {
  const key = 'label-size.' + value;
  const translated = tr(key);
  if (translated !== key) return translated;
  // Unknown / custom size → render as "<w> × <h> mm — Détecté (RFID)"
  const [ww, hh] = String(value).split('x');
  return tr('label-size.detected', { w: ww, h: hh });
}

/** Build <option> HTML, including a dynamic custom size if needed */
function buildSizeOptions(extraSize) {
  let values = LABEL_SIZE_VALUES;
  if (extraSize && !values.includes(extraSize)) {
    values = [...values, extraSize];
  }
  return values.map(v => `<option value="${escapeAttr(v)}">${escapeHtml(labelSizeLabel(v))}</option>`).join('');
}

// ═══════════════════════════════════════════════════════
// State management
// ═══════════════════════════════════════════════════════

let currentState = null;
let testPrintInProgress = false;
/** Entry IDs currently being reprinted — survives re-renders */
const reprintingIds = new Set();
/** Track printed count to detect when a reprint completes */
let lastPrintedCount = -1;

function updateUI(state) {
  currentState = state;

  // Keep UI language in sync with the persisted store value
  if (state.language && i18n.isLanguage(state.language) && state.language !== currentLang) {
    currentLang = state.language;
    applyTranslations();
    const langSel = document.getElementById('setting-language');
    if (langSel) langSel.value = currentLang;
  }

  // Detect print completion: if printedTodayCount increased, clear reprinting spinners
  if (lastPrintedCount >= 0 && state.printedTodayCount > lastPrintedCount && reprintingIds.size > 0) {
    reprintingIds.clear();
  }
  lastPrintedCount = state.printedTodayCount;

  // Toggle views
  if (state.authenticated) {
    $viewLogin.classList.add('hidden');
    $viewDashboard.classList.remove('hidden');
  } else {
    $viewLogin.classList.remove('hidden');
    $viewDashboard.classList.add('hidden');
    return;
  }

  // Status bar
  const statusMap = {
    'connected':    { dot: true,  key: 'status.connected' },
    'no-workspace': { dot: false, key: 'status.no-workspace' },
    'error':        { dot: false, key: 'status.error' },
    'disconnected': { dot: false, key: 'status.disconnected' },
  };
  const status = statusMap[state.connectionStatus] || statusMap['disconnected'];
  if (status.dot) {
    $statusDot.classList.add('connected');
  } else {
    $statusDot.classList.remove('connected');
  }
  $statusText.textContent = tr(status.key);

  $statPending.textContent = tr('status.pending', { count: state.pendingJobsCount });
  $statToday.textContent = tr('status.today', { count: state.printedTodayCount });

  // Failed counter (hidden when 0)
  const failedCount = state.failedTodayCount || 0;
  if (failedCount > 0) {
    $statFailed.textContent = tr('status.failed', { count: failedCount });
    $statFailed.classList.remove('hidden');
    $sepFailed.classList.remove('hidden');
  } else {
    $statFailed.classList.add('hidden');
    $sepFailed.classList.add('hidden');
  }

  renderUnprintedBanner(state.unprintedEntries || []);

  // Environment badge
  if (state.env === 'development') {
    $envBadge.classList.remove('hidden');
  } else {
    $envBadge.classList.add('hidden');
  }
  $settingEnv.textContent = state.env || 'production';
  $settingApiUrl.textContent = state.apiUrl || '—';

  // Offline printer banners (one per offline printer)
  const offlinePrinters = state.offlinePrinters || [];
  if (offlinePrinters.length > 0) {
    $offlineBanners.innerHTML = offlinePrinters.map(p => {
      const mins = Math.floor((Date.now() - new Date(p.since).getTime()) / 60000);
      const timeStr = mins < 1 ? tr('offline.since.now') : tr('offline.since.ago', { min: mins });
      const plural = p.spooledCount > 1 ? 's' : '';
      return `<div class="offline-banner">
        <span class="offline-banner-icon">\u26a0</span>
        <div class="offline-banner-body">
          <strong>${tr('offline.title', { printer: escapeHtml(p.printerName) })}</strong>
          <span>${tr('offline.spooled', { count: p.spooledCount, plural })}</span><!--\u00e2che--><!-- en attente — reprise auto d\u00e8s reconnexion-->
        </div>
        <span class="offline-banner-since">${escapeHtml(timeStr)}</span>
      </div>`;
    }).join('');
  } else {
    $offlineBanners.innerHTML = '';
  }

  // Error banner
  if (state.lastError) {
    $errorBanner.classList.remove('hidden');
    const isApiError = state.connectionStatus === 'error';
    $errorText.textContent = isApiError
      ? '⚠ ' + state.lastError
      : state.lastError;
  } else {
    $errorBanner.classList.add('hidden');
  }

  // Render lists
  renderWorkspaces(state.workspaces);
  if (!testPrintInProgress) {
    renderPrinters(state.printers);
  }
  renderJobConfigs(state.printerAssignments, state.printers, state.workspaces);
  renderHistory(state.printHistory);
}

// ═══════════════════════════════════════════════════════
// Workspace list
// ═══════════════════════════════════════════════════════

function renderWorkspaces(workspaces) {
  // Show all workspaces — user decides which to enable for printing
  const allWorkspaces = workspaces || [];

  if (allWorkspaces.length === 0) {
    $workspaceList.innerHTML = `<div class="empty-state">${escapeHtml(tr('workspaces.empty'))}</div>`;
    return;
  }

  $workspaceList.innerHTML = allWorkspaces.map(ws => `
    <div class="card${ws.workspace.hasShop ? '' : ' card-disabled'}">
      <div class="card-icon">${ws.workspace.hasShop ? '🏪' : '📁'}</div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(ws.workspace.name)}</div>
        <div class="card-subtitle">${escapeHtml(ws.workspace.hasShop ? (ws.config?.enabled ? tr('workspaces.print-enabled') : tr('workspaces.print-disabled')) : tr('workspaces.no-shop'))}</div>
      </div>
      <div class="card-action">
        <label class="toggle">
          <input type="checkbox" ${ws.enabled ? 'checked' : ''} ${ws.workspace.hasShop ? '' : 'disabled'} data-workspace-id="${ws.workspace.id}">
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
  `).join('');

  // Bind toggle events
  $workspaceList.querySelectorAll('input[type="checkbox"]').forEach(el => {
    el.addEventListener('change', (e) => {
      const wsId = e.target.dataset.workspaceId;
      api.toggleWorkspace(wsId, e.target.checked);
    });
  });
}

// ═══════════════════════════════════════════════════════
// Printer list
// ═══════════════════════════════════════════════════════

function renderPrinters(printers) {
  if (!printers || printers.length === 0) {
    $printerList.innerHTML = `<div class="empty-state">${escapeHtml(tr('printers.empty'))}</div>`;
    return;
  }

  const typeLabels = {
    thermal: tr('printer-type.thermal'),
    receipt: tr('printer-type.receipt'),
    standard: tr('printer-type.standard'),
    niimbot: tr('printer-type.niimbot'),
    unknown: tr('printer-type.unknown'),
  };

  const formats = currentState?.printerLabelFormats || {};

  $printerList.innerHTML = printers.map(p => {
    const fmt = formats[p.name];
    const fmtBadge = fmt
      ? `<span class="badge badge-detected">${fmt.widthMm}×${fmt.heightMm}mm</span>`
      : '';
    const detectBtn = p.type === 'niimbot'
      ? `<button class="btn btn-sm btn-ghost btn-detect" data-detect-printer="${escapeAttr(p.name)}" title="${escapeAttr(tr('printers.detect-label.title'))}"><span class="btn-detect-label">${escapeHtml(tr('printers.detect-label'))}</span></button>`
      : '';
    return `
    <div class="card">
      <div class="card-icon">${PRINTER_TYPE_ICONS[p.type] || '🖨️'}</div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(p.displayName)} ${fmtBadge}</div>
        <div class="card-subtitle">${typeLabels[p.type] || p.type}${p.description ? ' • ' + escapeHtml(p.description) : ''} ${p.isDefault ? '• ' + escapeHtml(tr('printers.default')) : ''}</div>
      </div>
      <div class="card-action">
        ${detectBtn}
        <button class="btn btn-sm btn-ghost btn-test" data-test-printer="${escapeAttr(p.name)}">
          <span class="btn-test-label">${escapeHtml(tr('printers.test'))}</span>
        </button>
      </div>
    </div>
  `}).join('');

  // Bind test buttons
  $printerList.querySelectorAll('[data-test-printer]').forEach(el => {
    el.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const name = btn.dataset.testPrinter;
      const labelSpan = btn.querySelector('.btn-test-label');

      // Prevent re-render from wiping button state during print
      testPrintInProgress = true;

      // Disable button and show loading state
      btn.disabled = true;
      btn.classList.add('btn-test-loading');
      if (labelSpan) labelSpan.textContent = tr('printers.test.printing');

      try {
        const result = await api.testPrinter(name);
        btn.classList.remove('btn-test-loading');

        if (result.success) {
          btn.classList.add('btn-test-success');
          if (labelSpan) labelSpan.textContent = tr('printers.test.ok');
          // If RFID detected a label size, update the dropdown
          if (result.detectedLabel) {
            const dl = result.detectedLabel;
            const sizeStr = dl.widthMm + 'x' + dl.heightMm;
            updateDetectedLabelSize(sizeStr, dl);
          }
        } else {
          btn.classList.add('btn-test-error');
          if (labelSpan) labelSpan.textContent = tr('printers.test.fail-prefix') + (result.error || tr('printers.detect.error').replace('✕ ', ''));
        }
      } catch (err) {
        btn.classList.remove('btn-test-loading');
        btn.classList.add('btn-test-error');
        if (labelSpan) labelSpan.textContent = tr('printers.test.fail-prefix') + (err.message || tr('printers.detect.error').replace('✕ ', ''));
      }

      setTimeout(() => {
        testPrintInProgress = false;
        btn.disabled = false;
        btn.classList.remove('btn-test-success', 'btn-test-error');
        if (labelSpan) labelSpan.textContent = tr('printers.test');
      }, 4000);
    });
  });

  // Bind detect buttons (Niimbot only — RFID detection without printing)
  $printerList.querySelectorAll('[data-detect-printer]').forEach(el => {
    el.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const name = btn.dataset.detectPrinter;
      const labelSpan = btn.querySelector('.btn-detect-label');

      btn.disabled = true;
      btn.classList.add('btn-test-loading');
      if (labelSpan) labelSpan.textContent = tr('printers.detecting-rfid');

      try {
        const result = await api.detectLabel(name);
        btn.classList.remove('btn-test-loading');

        if (result.success && result.detectedLabel) {
          btn.classList.add('btn-test-success');
          const dl = result.detectedLabel;
          if (labelSpan) labelSpan.textContent = '✓ ' + dl.widthMm + ' × ' + dl.heightMm + ' mm';
          const sizeStr = dl.widthMm + 'x' + dl.heightMm;
          updateDetectedLabelSize(sizeStr, dl);
          showDetectNotification(true, dl);
        } else {
          btn.classList.add('btn-test-error');
          if (labelSpan) labelSpan.textContent = tr('printers.detect.fail');
          showDetectNotification(false, null, result.error || tr('detect.fail.no-label'));
        }
      } catch (err) {
        btn.classList.remove('btn-test-loading');
        btn.classList.add('btn-test-error');
        if (labelSpan) labelSpan.textContent = tr('printers.detect.error');
        showDetectNotification(false, null, err.message || tr('detect.fail.comm'));
      }

      setTimeout(() => {
        btn.disabled = false;
        btn.classList.remove('btn-test-success', 'btn-test-error');
        if (labelSpan) labelSpan.textContent = tr('printers.detect-label');
      }, 5000);
    });
  });
}

// ═══════════════════════════════════════════════════════
// Job config panels (per job-type tabs)
// ═══════════════════════════════════════════════════════

function renderJobConfigs(assignments, printers, workspaces) {
  const printerOptions = (printers || [])
    .map(p => `<option value="${escapeAttr(p.name)}">${escapeHtml(p.displayName)}</option>`)
    .join('');

  // Populate printer dropdowns in all job panels
  document.querySelectorAll('[data-job-assign]').forEach(el => {
    const type = el.dataset.jobAssign;
    const current = assignments?.[type] || '';
    // Preserve first "Non assignée" option, add printer options
    el.innerHTML = `<option value="">${escapeHtml(tr('config.unassigned'))}</option>${printerOptions}`;
    el.value = current;

    // Remove old listeners by replacing node
    const clone = el.cloneNode(true);
    clone.value = current;
    el.parentNode.replaceChild(clone, el);

    clone.addEventListener('change', (e) => {
      api.assignPrinter(type, e.target.value || null);
      // For product_label, update preview with printer's detected format
      if (type === 'product_label' && currentState) {
        const printerName = e.target.value;
        const formats = currentState.printerLabelFormats || {};
        const fmt = printerName ? formats[printerName] : null;
        if (fmt) {
          loadJobPreview('product_label', fmt.widthMm + 'x' + fmt.heightMm);
        }
      }
      // For shipping_label, show/hide ZPL config
      if (type === 'shipping_label') {
        renderShippingZplConfig(e.target.value || null);
      }
    });
  });

  // Render product_label label size selector
  renderProductLabelSizes(workspaces);

  // Render shipping label ZPL config
  const shippingPrinter = assignments?.shipping_label || null;
  renderShippingZplConfig(shippingPrinter);
}

/**
 * Show/hide the advanced ZPL config section for shipping labels.
 * Loads saved config from the store when a printer is assigned.
 */
function renderShippingZplConfig(printerName) {
  const section = document.getElementById('zpl-config-section');
  const body = document.getElementById('zpl-config-body');
  if (!section) return;

  // Only show when a thermal printer is assigned
  if (!printerName) {
    section.classList.add('hidden');
    return;
  }

  // Show the section
  section.classList.remove('hidden');

  // Load saved config from state
  const configs = currentState?.printerZplConfigs || {};
  const config = configs[printerName] || { mode: 'auto', dpi: 203, scale: 0.90 };

  // Set values
  const modeEl = document.getElementById('zpl-config-mode');
  const dpiEl = document.getElementById('zpl-config-dpi');
  const scaleEl = document.getElementById('zpl-config-scale');
  const scaleValueEl = document.getElementById('zpl-config-scale-value');

  if (modeEl) modeEl.value = config.mode;
  if (dpiEl) dpiEl.value = String(config.dpi);
  if (scaleEl) scaleEl.value = String(config.scale);
  if (scaleValueEl) scaleValueEl.textContent = Math.round(config.scale * 100) + '%';
}

/**
 * Initialize ZPL config event listeners (called once at setup).
 */
function initZplConfigListeners() {
  const toggle = document.getElementById('btn-zpl-config-toggle');
  const body = document.getElementById('zpl-config-body');
  const scaleEl = document.getElementById('zpl-config-scale');
  const scaleValueEl = document.getElementById('zpl-config-scale-value');
  const saveBtn = document.getElementById('btn-zpl-config-save');
  const testBtn = document.getElementById('btn-zpl-test-print');

  if (toggle && body) {
    toggle.addEventListener('click', () => {
      body.classList.toggle('hidden');
      toggle.textContent = body.classList.contains('hidden')
        ? tr('zpl.advanced')
        : tr('zpl.advanced.open');
    });
  }

  if (scaleEl && scaleValueEl) {
    scaleEl.addEventListener('input', () => {
      scaleValueEl.textContent = Math.round(scaleEl.value * 100) + '%';
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const printerName = currentState?.printerAssignments?.shipping_label;
      if (!printerName) return;

      const modeEl = document.getElementById('zpl-config-mode');
      const dpiEl = document.getElementById('zpl-config-dpi');
      const scaleEl = document.getElementById('zpl-config-scale');

      const config = {
        mode: modeEl?.value || 'auto',
        dpi: parseInt(dpiEl?.value || '203'),
        scale: parseFloat(scaleEl?.value || '0.90'),
      };

      await api.setPrinterZplConfig(printerName, config);
      saveBtn.textContent = tr('zpl.saved');
      setTimeout(() => { saveBtn.textContent = tr('zpl.save'); }, 2000);
    });
  }

  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      const printerName = currentState?.printerAssignments?.shipping_label;
      if (!printerName) return;

      testBtn.disabled = true;
      testBtn.textContent = tr('zpl.test-print.printing');
      try {
        const result = await api.testPrinter(printerName);
        testBtn.textContent = result.success ? tr('zpl.test-print.ok') : tr('zpl.test-print.fail');
      } catch (err) {
        testBtn.textContent = tr('zpl.test-print.error');
      }
      setTimeout(() => {
        testBtn.disabled = false;
        testBtn.textContent = tr('zpl.test-print');
      }, 3000);
    });
  }
}

/**
 * Render label size dropdown(s) inside the product_label sub-panel.
 */
function renderProductLabelSizes(workspaces) {
  const container = document.getElementById('job-label-size-product_label');
  if (!container) return;

  const shopWorkspaces = (workspaces || []).filter(ws => ws.workspace.hasShop && ws.enabled);
  const formats = currentState?.printerLabelFormats || {};
  const assignments = currentState?.printerAssignments || {};

  const assignedPrinter = assignments.product_label;
  const detectedFmt = assignedPrinter ? formats[assignedPrinter] : null;

  if (shopWorkspaces.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding:12px">${escapeHtml(tr('config.enable-shop-hint'))}</div>`;
    return;
  }

  // Detected format info badge
  const detectedInfo = detectedFmt
    ? `<div class="detected-format-info">
        <span class="badge badge-detected">${escapeHtml(tr('label-size.detected-badge', { w: detectedFmt.widthMm, h: detectedFmt.heightMm }))}</span>
      </div>`
    : '';

  const detectedSize = detectedFmt ? detectedFmt.widthMm + 'x' + detectedFmt.heightMm : null;
  const configSizes = shopWorkspaces.map(ws => ws.config?.productLabelSize).filter(Boolean);
  const extraSize = detectedSize || configSizes.find(s => !LABEL_SIZE_VALUES.includes(s)) || null;
  const sizeOptions = buildSizeOptions(extraSize);

  container.innerHTML = detectedInfo + shopWorkspaces.map(ws => {
    const currentSize = ws.config?.productLabelSize || '57x32';
    return `
      <div class="assignment-item">
        <span class="assignment-label">${escapeHtml(ws.workspace.name)}</span>
        <select class="assignment-select" data-ws-label-size="${ws.workspace.id}">
          ${sizeOptions}
        </select>
      </div>
    `;
  }).join('');

  // Set values and bind events
  container.querySelectorAll('select').forEach(el => {
    const wsId = el.dataset.wsLabelSize;
    const ws = shopWorkspaces.find(w => w.workspace.id === wsId);

    if (detectedFmt) {
      const ds = detectedFmt.widthMm + 'x' + detectedFmt.heightMm;
      const existing = Array.from(el.options).find(o => o.value === ds);
      if (!existing) {
        const opt = document.createElement('option');
        opt.value = ds;
        opt.textContent = tr('label-size.detected', { w: detectedFmt.widthMm, h: detectedFmt.heightMm });
        el.appendChild(opt);
      }
      el.value = ds;
    } else {
      el.value = ws?.config?.productLabelSize || '57x32';
    }

    el.addEventListener('change', (e) => {
      api.updateWorkspaceConfig(wsId, { productLabelSize: e.target.value });
      loadJobPreview('product_label', e.target.value);
    });
  });

  // Load preview
  const previewSize = detectedFmt
    ? detectedFmt.widthMm + 'x' + detectedFmt.heightMm
    : shopWorkspaces[0]?.config?.productLabelSize || '57x32';
  loadJobPreview('product_label', previewSize);
}

/**
 * Load and display a label preview for the given job type and label size.
 */
async function loadJobPreview(jobType, labelSize) {
  const section = document.getElementById(`job-preview-${jobType}`);
  const img = document.getElementById(`job-preview-img-${jobType}`);
  if (!api || !section || !img) return;
  try {
    section.style.display = '';
    img.alt = tr('config.preview.loading');
    const dataUri = await api.previewLabel(labelSize);
    if (dataUri) {
      img.src = dataUri;
      img.alt = tr('config.preview.alt-dynamic', { size: labelSize });
    }
  } catch (err) {
    console.error('[Renderer] Preview error:', err);
    img.alt = tr('config.preview.error');
  }
}

/**
 * Update the label size dropdown when RFID auto-detects a label.
 */
function updateDetectedLabelSize(sizeStr, detectedLabel) {
  const container = document.getElementById('job-label-size-product_label');
  if (!container) return;
  const selects = container.querySelectorAll('select');
  selects.forEach(el => {
    const existing = Array.from(el.options).find(o => o.value === sizeStr);
    if (existing) {
      el.value = sizeStr;
    } else {
      const opt = document.createElement('option');
      opt.value = sizeStr;
      opt.textContent = tr('label-size.detected', { w: detectedLabel.widthMm, h: detectedLabel.heightMm });
      el.appendChild(opt);
      el.value = sizeStr;
    }
    const wsId = el.dataset.wsLabelSize;
    if (wsId) {
      api.updateWorkspaceConfig(wsId, { productLabelSize: sizeStr });
    }
    loadJobPreview('product_label', sizeStr);
  });

  // Update detected badge
  const existingBadge = container.querySelector('.detected-format-info');
  const newBadge = `<div class="detected-format-info">
    <span class="badge badge-detected">${escapeHtml(tr('label-size.detected-badge', { w: detectedLabel.widthMm, h: detectedLabel.heightMm }))}</span>
  </div>`;
  if (existingBadge) {
    existingBadge.outerHTML = newBadge;
  } else {
    container.insertAdjacentHTML('afterbegin', newBadge);
  }
  console.log('[Renderer] Label size updated from RFID: ' + sizeStr);
}

/**
 * Show a detection notification near the product_label panel.
 */
function showDetectNotification(success, detectedLabel, errorMsg) {
  const existing = document.querySelector('.detect-notification');
  if (existing) existing.remove();

  let html;
  if (success && detectedLabel) {
    html = `
      <div class="detect-notification detect-success">
        <span class="detect-notification-icon">✅</span>
        <div class="detect-notification-body">
          <div class="detect-notification-title">${escapeHtml(tr('detect.success.title'))}</div>
          ${tr('detect.success.body', { w: detectedLabel.widthMm, h: detectedLabel.heightMm })}
          <div class="detect-notification-hint">${escapeHtml(tr('detect.success.hint'))}</div>
        </div>
      </div>`;
  } else {
    html = `
      <div class="detect-notification detect-error">
        <span class="detect-notification-icon">⚠️</span>
        <div class="detect-notification-body">
          <div class="detect-notification-title">${escapeHtml(tr('detect.fail.title'))}</div>
          ${escapeHtml(errorMsg || tr('detect.fail.default'))}
          <div class="detect-notification-hint">${escapeHtml(tr('detect.fail.hint'))}</div>
        </div>
      </div>`;
  }

  const container = document.getElementById('job-label-size-product_label');
  if (container) {
    container.insertAdjacentHTML('beforebegin', html);
  } else {
    const printerList = document.getElementById('printer-list');
    if (printerList) printerList.insertAdjacentHTML('afterend', html);
  }

  setTimeout(() => {
    const notif = document.querySelector('.detect-notification');
    if (notif) {
      notif.style.opacity = '0';
      notif.style.transition = 'opacity 0.3s ease';
      setTimeout(() => notif.remove(), 300);
    }
  }, 15000);
}


// ═══════════════════════════════════════════════════════
// Print history
// ═══════════════════════════════════════════════════════

/** Translated short label for a history entry type. */
function historyTypeLabel(type) {
  const key = 'history-type.' + type;
  const translated = tr(key);
  return translated === key ? type : translated;
}

/**
 * Bandeau « étiquettes manquantes ».
 *
 * Une étiquette qui n'est jamais sortie ne laissait qu'une ligne rouge au fond
 * de l'onglet Historique et un compteur remis à zéro chaque nuit — pendant un
 * live, l'app est réduite dans la barre des tâches, personne ne les voit. Le
 * colis partait incomplet. Le bandeau reste donc affiché, avec le nom de la
 * cliente concernée, tant que les étiquettes ne sont pas ressorties.
 */
function renderUnprintedBanner(entries) {
  const $banner = document.getElementById('unprinted-banner');
  const $title = document.getElementById('unprinted-title');
  const $list = document.getElementById('unprinted-list');
  if (!$banner || !$title || !$list) return;

  if (!entries.length) {
    $banner.classList.add('hidden');
    return;
  }

  $banner.classList.remove('hidden');
  $title.textContent = tr('unprinted.title', { count: entries.length });

  // Regroupé par cliente : c'est le colis qui est incomplet, pas la ligne.
  const byCustomer = new Map();
  for (const entry of entries) {
    const p = entry.payload || {};
    const handle = entry.socialHandle || p.socialHandle || '';
    const name = entry.customerName || p.customerName || '';
    const key = handle || name || tr('unprinted.unknown-customer');
    const products = byCustomer.get(key) || [];
    products.push(entry.productName);
    byCustomer.set(key, products);
  }

  $list.innerHTML = [...byCustomer.entries()]
    .map(([customer, products]) => `
      <div class="unprinted-row">
        <span class="unprinted-row__customer">${escapeHtml(customer)}</span>
        <span class="unprinted-row__products">${escapeHtml(products.join(' • '))}</span>
      </div>
    `)
    .join('');
}

function renderHistory(history) {
  if (!$historyList) return;

  if (!history || history.length === 0) {
    $historyList.innerHTML = `<div class="empty-state">${escapeHtml(tr('history.empty'))}</div>`;
    return;
  }

  $historyList.innerHTML = history.map(entry => {
    const isError = entry.status === 'failed';
    const statusIcon = isError ? '✕' : '✓';
    const statusClass = isError ? 'history-failed' : 'history-success';
    const time = formatTime(entry.timestamp);
    const typeLabel = historyTypeLabel(entry.type);
    const canReprint = !!(entry.payload || entry.labelData);
    const isReprinting = reprintingIds.has(entry.id);
    const reprintBtn = canReprint
      ? (isReprinting
        ? `<button class="btn btn-sm btn-ghost btn-reprint btn-reprint-loading" disabled><span class="spinner spinner-sm"></span></button>`
        : `<button class="btn btn-sm btn-ghost btn-reprint" data-reprint-id="${escapeAttr(entry.id)}" title="${escapeAttr(tr('history.reprint'))}">\ud83d\udda8</button>`)
      : '';
    const retryBtn = isError
      ? `<button class="btn btn-sm btn-ghost btn-retry" data-retry-job="${escapeAttr(entry.jobId)}" title="${escapeAttr(tr('history.retry'))}">↻</button>`
      : '';
    const errorLine = isError && entry.error
      ? `<div class="history-error">${escapeHtml(entry.error)}</div>`
      : '';

    // Build detail chips (customer, handle, price, order date)
    // Read from top-level fields first, fallback to payload for old entries
    const p = entry.payload || {};
    const customerName = entry.customerName || p.customerName || '';
    const socialHandle = entry.socialHandle || p.socialHandle || '';
    const orderDate = entry.orderDate || p.orderDate || '';
    // Price: top-level, or format from payload cents
    let price = entry.price || p.price || '';
    if (!price && typeof p.priceCents === 'number') {
      const cur = p.currency || 'EUR';
      const val = (p.priceCents / 100).toFixed(2).replace('.', ',');
      price = cur === 'EUR' ? val + ' \u20ac' : val + ' ' + cur;
    }

    const details = [];
    if (customerName) details.push(escapeHtml(customerName));
    if (socialHandle) details.push('@' + escapeHtml(socialHandle));
    if (price) details.push(escapeHtml(price));
    if (orderDate) details.push(escapeHtml(orderDate));
    const detailLine = details.length > 0
      ? `<div class="history-detail">${details.join(' • ')}</div>`
      : '';

    return `
      <div class="history-item ${statusClass}">
        <span class="history-status-icon">${statusIcon}</span>
        <div class="history-body">
          <div class="history-title">${escapeHtml(entry.productName)}</div>
          ${detailLine}
          <div class="history-meta">${escapeHtml(typeLabel)} • ${time}${entry.attempts > 1 ? ' • ' + escapeHtml(tr('history.attempts', { count: entry.attempts })) : ''}</div>
          ${errorLine}
        </div>
        <div class="history-actions">
          ${reprintBtn}
          ${retryBtn}
        </div>
      </div>
    `;
  }).join('');

  // Bind reprint buttons
  $historyList.querySelectorAll('[data-reprint-id]').forEach(el => {
    el.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const entryId = btn.dataset.reprintId;
      // Add to persistent reprinting set so spinner survives re-renders
      reprintingIds.add(entryId);
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner spinner-sm"></span>';
      btn.classList.add('btn-reprint-loading');
      try {
        const result = await api.reprintJob(entryId);
        if (result && !result.success) {
          console.error('[Renderer] Reprint failed:', result.error);
          showNotification(result.error || tr('history.reprint.error'), 'error');
          reprintingIds.delete(entryId);
          btn.disabled = false;
          btn.innerHTML = '🖨';
          btn.classList.remove('btn-reprint-loading');
        }
      } catch (err) {
        console.error('[Renderer] Reprint error:', err);
        reprintingIds.delete(entryId);
        btn.disabled = false;
        btn.innerHTML = '🖨';
        btn.classList.remove('btn-reprint-loading');
      }
    });
  });

  // Bind retry buttons
  $historyList.querySelectorAll('[data-retry-job]').forEach(el => {
    el.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const jobId = btn.dataset.retryJob;
      btn.disabled = true;
      btn.textContent = '…';
      try {
        await api.retryJob(jobId);
      } catch (err) {
        console.error('[Renderer] Retry failed:', err);
      }
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = '↻';
      }, 2000);
    });
  });
}

function formatTime(isoString) {
  try {
    const d = new Date(isoString);
    const date = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return date + ' ' + time;
  } catch {
    return '';
  }
}


document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    // Remove active from all tabs
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));

    // Activate clicked tab
    tab.classList.add('active');
    const panel = document.getElementById(`panel-${tab.dataset.tab}`);
    if (panel) {
      panel.classList.remove('hidden');
      panel.classList.add('active');
    }
  });
});

// Sub-tab navigation (job type config panels)
document.querySelectorAll('.sub-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const parent = tab.closest('.section');
    if (!parent) return;
    parent.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
    parent.querySelectorAll('.sub-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const panel = document.getElementById(`jobpanel-${tab.dataset.jobtab}`);
    if (panel) panel.classList.add('active');
  });
});

// ═══════════════════════════════════════════════════════
// Button handlers
// ═══════════════════════════════════════════════════════

function bindBtn(id, handler) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      console.log(`[Renderer] Button clicked: ${id}`);
      handler();
    });
  } else {
    console.warn(`[Renderer] Button not found: ${id}`);
  }
}

bindBtn('btn-login', () => api.login());
bindBtn('btn-logout', () => api.logout());
bindBtn('btn-minimize', () => api.minimize());
bindBtn('btn-close', () => api.minimize());
bindBtn('btn-refresh-workspaces', async () => {
  $workspaceList.innerHTML = `<div class="loading-state"><span class="spinner"></span> ${escapeHtml(tr('workspaces.loading.full'))}</div>`;
  try {
    await api.refreshWorkspaces();
  } catch (err) {
    $workspaceList.innerHTML = '<div class="error-state">' + escapeHtml(tr('error.prefix')) + escapeHtml(err.message || tr('workspaces.error')) + '</div>';
  }
});
bindBtn('btn-refresh-printers', async () => {
  $printerList.innerHTML = `<div class="loading-state"><span class="spinner"></span> ${escapeHtml(tr('printers.detecting.full'))}</div>`;
  try {
    await api.listPrinters();
  } catch (err) {
    $printerList.innerHTML = '<div class="error-state">' + escapeHtml(tr('error.prefix')) + escapeHtml(err.message || tr('printers.error')) + '</div>';
  }
});
bindBtn('btn-retry-all', () => api.retryAllFailed());
// ⚠️ Distinct de « Réessayer tout » : celui-là re-télécharge les jobs EN ATTENTE
// côté serveur, or une étiquette abandonnée y est acquittée `failed` et n'en
// fait donc plus partie. Les manquantes ne peuvent être relancées que depuis la
// copie gardée en local.
bindBtn('btn-reprint-unprinted', async () => {
  const btn = document.getElementById('btn-reprint-unprinted');
  if (btn) btn.disabled = true;
  try {
    await api.reprintAllUnprinted();
  } finally {
    if (btn) btn.disabled = false;
  }
});
bindBtn('btn-clear-history', async () => {
  await api.clearHistory();
  if ($historyList) $historyList.innerHTML = `<div class="empty-state">${escapeHtml(tr('history.empty'))}</div>`;
});
bindBtn('btn-open-dashboard', () => {
  const appUrl = currentState?.appUrl || 'https://app.hou.la';
  api.openExternal(`${appUrl}/manager`);
});

// Init ZPL config listeners (toggle, save, test, scale slider)
initZplConfigListeners();

// ═══════════════════════════════════════════════════════
// Language selector
// ═══════════════════════════════════════════════════════

const $settingLanguage = document.getElementById('setting-language');
if ($settingLanguage) {
  $settingLanguage.addEventListener('change', (e) => {
    setLanguage(e.target.value);
  });
}

// ═══════════════════════════════════════════════════════
// IPC listener: state updates from main process
// ═══════════════════════════════════════════════════════

api.onStateUpdated((state) => updateUI(state));

// Fetch the persisted language first, apply static translations, then load state.
(async () => {
  try {
    const lang = await api.getLanguage();
    if (i18n.isLanguage(lang)) currentLang = lang;
  } catch (err) {
    console.error('[Renderer] getLanguage failed:', err);
  }
  applyTranslations();
  if ($settingLanguage) $settingLanguage.value = currentLang;

  // Initial state fetch
  api.getState().then((state) => {
    updateUI(state);
    // Auto-detect printers on startup if authenticated and list is empty
    if (state.authenticated && (!state.printers || state.printers.length === 0)) {
      $printerList.innerHTML = `<div class="loading-state"><span class="spinner"></span> ${escapeHtml(tr('printers.detecting.full'))}</div>`;
      api.listPrinters().catch(() => {});
    }
  });
})();

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
