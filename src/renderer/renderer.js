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

const JOB_TYPE_LABELS = {
  product_label: 'Étiquettes produits',
  order_summary: 'Récapitulatif commande',
  invoice: 'Facture',
  // shipping_label and packing_slip: disabled until shipping module is implemented
};

const PRINTER_TYPE_ICONS = {
  thermal: '🏷️',
  receipt: '🧾',
  standard: '🖨️',
  niimbot: '🔵',
  unknown: '❓',
};

const LABEL_SIZE_OPTIONS = [
  { value: '57x32',   label: '57 × 32 mm — Standard' },
  { value: '50x30',   label: '50 × 30 mm — Niimbot standard' },
  { value: '40x30',   label: '40 × 30 mm — Petit (bijoux)' },
  { value: '50x25',   label: '50 × 25 mm — Compact' },
  { value: '100x50',  label: '100 × 50 mm — Moyen' },
  { value: '100x100', label: '100 × 100 mm — Grand carré' },
  { value: '100x150', label: '100 × 150 mm — Expédition (6×4")' },
];

/** Build <option> HTML, including a dynamic custom size if needed */
function buildSizeOptions(extraSize) {
  let opts = LABEL_SIZE_OPTIONS;
  if (extraSize && !opts.find(o => o.value === extraSize)) {
    const [ww, hh] = extraSize.split('x');
    opts = [...opts, { value: extraSize, label: ww + ' × ' + hh + ' mm — Détecté (RFID)' }];
  }
  return opts.map(o => `<option value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</option>`).join('');
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
    'connected':    { dot: true,  text: 'Connecté' },
    'no-workspace': { dot: false, text: 'Activez une boutique' },
    'error':        { dot: false, text: 'Erreur connexion' },
    'disconnected': { dot: false, text: 'Déconnecté' },
  };
  const status = statusMap[state.connectionStatus] || statusMap['disconnected'];
  if (status.dot) {
    $statusDot.classList.add('connected');
  } else {
    $statusDot.classList.remove('connected');
  }
  $statusText.textContent = status.text;

  $statPending.textContent = `${state.pendingJobsCount} en attente`;
  $statToday.textContent = `${state.printedTodayCount} imprimé(s)`;

  // Failed counter (hidden when 0)
  const failedCount = state.failedTodayCount || 0;
  if (failedCount > 0) {
    $statFailed.textContent = `${failedCount} échoué(s)`;
    $statFailed.classList.remove('hidden');
    $sepFailed.classList.remove('hidden');
  } else {
    $statFailed.classList.add('hidden');
    $sepFailed.classList.add('hidden');
  }

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
      const timeStr = mins < 1 ? '\u00e0 l\'instant' : `depuis ${mins} min`;
      const plural = p.spooledCount > 1 ? 's' : '';
      return `<div class="offline-banner">
        <span class="offline-banner-icon">\u26a0</span>
        <div class="offline-banner-body">
          <strong>${escapeHtml(p.printerName)} — hors ligne</strong>
          <span>${p.spooledCount} t\u00e2che${plural} en attente — reprise auto d\u00e8s reconnexion</span>
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
    $workspaceList.innerHTML = '<div class="empty-state">Aucune boutique trouvée</div>';
    return;
  }

  $workspaceList.innerHTML = allWorkspaces.map(ws => `
    <div class="card${ws.workspace.hasShop ? '' : ' card-disabled'}">
      <div class="card-icon">${ws.workspace.hasShop ? '🏪' : '📁'}</div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(ws.workspace.name)}</div>
        <div class="card-subtitle">${ws.workspace.hasShop ? (ws.config?.enabled ? 'Impression activée' : 'Impression désactivée') : 'Pas de boutique'}</div>
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
    $printerList.innerHTML = '<div class="empty-state">Aucune imprimante détectée</div>';
    return;
  }

  const typeLabels = {
    thermal: 'Thermique (ZPL)',
    receipt: 'Ticket (ESC/POS)',
    standard: 'Standard (PDF)',
    niimbot: 'Niimbot (étiquettes)',
    unknown: 'Inconnu',
  };

  const formats = currentState?.printerLabelFormats || {};

  $printerList.innerHTML = printers.map(p => {
    const fmt = formats[p.name];
    const fmtBadge = fmt
      ? `<span class="badge badge-detected">${fmt.widthMm}×${fmt.heightMm}mm</span>`
      : '';
    const detectBtn = p.type === 'niimbot'
      ? `<button class="btn btn-sm btn-ghost btn-detect" data-detect-printer="${escapeAttr(p.name)}" title="Détecter automatiquement le format d'étiquette chargée dans l'imprimante"><span class="btn-detect-label">Détecter étiquette</span></button>`
      : '';
    return `
    <div class="card">
      <div class="card-icon">${PRINTER_TYPE_ICONS[p.type] || '🖨️'}</div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(p.displayName)} ${fmtBadge}</div>
        <div class="card-subtitle">${typeLabels[p.type] || p.type}${p.description ? ' • ' + escapeHtml(p.description) : ''} ${p.isDefault ? '• par défaut' : ''}</div>
      </div>
      <div class="card-action">
        ${detectBtn}
        <button class="btn btn-sm btn-ghost btn-test" data-test-printer="${escapeAttr(p.name)}">
          <span class="btn-test-label">Test</span>
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
      if (labelSpan) labelSpan.textContent = 'Impression…';

      try {
        const result = await api.testPrinter(name);
        btn.classList.remove('btn-test-loading');

        if (result.success) {
          btn.classList.add('btn-test-success');
          if (labelSpan) labelSpan.textContent = '✓ OK';
          // If RFID detected a label size, update the dropdown
          if (result.detectedLabel) {
            const dl = result.detectedLabel;
            const sizeStr = dl.widthMm + 'x' + dl.heightMm;
            updateDetectedLabelSize(sizeStr, dl);
          }
        } else {
          btn.classList.add('btn-test-error');
          if (labelSpan) labelSpan.textContent = '✕ ' + (result.error || 'Erreur');
        }
      } catch (err) {
        btn.classList.remove('btn-test-loading');
        btn.classList.add('btn-test-error');
        if (labelSpan) labelSpan.textContent = '✕ ' + (err.message || 'Erreur');
      }

      setTimeout(() => {
        testPrintInProgress = false;
        btn.disabled = false;
        btn.classList.remove('btn-test-success', 'btn-test-error');
        if (labelSpan) labelSpan.textContent = 'Test';
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
      if (labelSpan) labelSpan.textContent = 'Lecture RFID…';

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
          if (labelSpan) labelSpan.textContent = '✕ Échec';
          showDetectNotification(false, null, result.error || 'Aucune étiquette détectée. Vérifiez que des étiquettes sont chargées dans l\'imprimante.');
        }
      } catch (err) {
        btn.classList.remove('btn-test-loading');
        btn.classList.add('btn-test-error');
        if (labelSpan) labelSpan.textContent = '✕ Erreur';
        showDetectNotification(false, null, err.message || 'Impossible de communiquer avec l\'imprimante.');
      }

      setTimeout(() => {
        btn.disabled = false;
        btn.classList.remove('btn-test-success', 'btn-test-error');
        if (labelSpan) labelSpan.textContent = 'Détecter étiquette';
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
    el.innerHTML = `<option value="">Non assignée</option>${printerOptions}`;
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
        ? '⚙️ Configuration avancée ▸'
        : '⚙️ Configuration avancée ▾';
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
      saveBtn.textContent = '✓ Enregistré';
      setTimeout(() => { saveBtn.textContent = 'Enregistrer'; }, 2000);
    });
  }

  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      const printerName = currentState?.printerAssignments?.shipping_label;
      if (!printerName) return;

      testBtn.disabled = true;
      testBtn.textContent = '⏳ Impression…';
      try {
        const result = await api.testPrinter(printerName);
        testBtn.textContent = result.success ? '✓ Test OK' : '✗ Échec';
      } catch (err) {
        testBtn.textContent = '✗ Erreur';
      }
      setTimeout(() => {
        testBtn.disabled = false;
        testBtn.textContent = '🖨️ Impression test';
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
    container.innerHTML = '<div class="empty-state" style="padding:12px">Activez une boutique pour configurer le format</div>';
    return;
  }

  // Detected format info badge
  const detectedInfo = detectedFmt
    ? `<div class="detected-format-info">
        <span class="badge badge-detected">📡 Format détecté : ${detectedFmt.widthMm} × ${detectedFmt.heightMm} mm</span>
      </div>`
    : '';

  const detectedSize = detectedFmt ? detectedFmt.widthMm + 'x' + detectedFmt.heightMm : null;
  const configSizes = shopWorkspaces.map(ws => ws.config?.productLabelSize).filter(Boolean);
  const extraSize = detectedSize || configSizes.find(s => !LABEL_SIZE_OPTIONS.find(o => o.value === s)) || null;
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
        opt.textContent = detectedFmt.widthMm + ' × ' + detectedFmt.heightMm + ' mm — Détecté (RFID)';
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
    img.alt = 'Chargement...';
    const dataUri = await api.previewLabel(labelSize);
    if (dataUri) {
      img.src = dataUri;
      img.alt = 'Aperçu étiquette ' + labelSize;
    }
  } catch (err) {
    console.error('[Renderer] Preview error:', err);
    img.alt = 'Erreur de chargement';
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
      opt.textContent = detectedLabel.widthMm + ' × ' + detectedLabel.heightMm + ' mm — Détecté (RFID)';
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
    <span class="badge badge-detected">📡 Format détecté : ${detectedLabel.widthMm} × ${detectedLabel.heightMm} mm</span>
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
          <div class="detect-notification-title">Détection réussie !</div>
          Votre imprimante contient des étiquettes de <strong>${detectedLabel.widthMm} × ${detectedLabel.heightMm} mm</strong>.
          Le format a été appliqué automatiquement.
          <div class="detect-notification-hint">Si ce n'est pas le bon format, vous pouvez le modifier manuellement dans la liste ci-dessous.</div>
        </div>
      </div>`;
  } else {
    html = `
      <div class="detect-notification detect-error">
        <span class="detect-notification-icon">⚠️</span>
        <div class="detect-notification-body">
          <div class="detect-notification-title">Détection échouée</div>
          ${escapeHtml(errorMsg || 'Impossible de détecter le format d\'étiquette.')}
          <div class="detect-notification-hint">Vous pouvez sélectionner le format manuellement dans la liste ci-dessous.</div>
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

const HISTORY_TYPE_LABELS = {
  product_label: 'Étiquette',
  order_summary: 'Récap.',
  invoice: 'Facture',
  shipping_label: 'Expédition',
  packing_slip: 'Bordereau',
};

function renderHistory(history) {
  if (!$historyList) return;

  if (!history || history.length === 0) {
    $historyList.innerHTML = '<div class="empty-state">Aucune impression enregistrée</div>';
    return;
  }

  $historyList.innerHTML = history.map(entry => {
    const isError = entry.status === 'failed';
    const statusIcon = isError ? '✕' : '✓';
    const statusClass = isError ? 'history-failed' : 'history-success';
    const time = formatTime(entry.timestamp);
    const typeLabel = HISTORY_TYPE_LABELS[entry.type] || entry.type;
    const canReprint = !!(entry.payload || entry.labelData);
    const isReprinting = reprintingIds.has(entry.id);
    const reprintBtn = canReprint
      ? (isReprinting
        ? `<button class="btn btn-sm btn-ghost btn-reprint btn-reprint-loading" disabled><span class="spinner spinner-sm"></span></button>`
        : `<button class="btn btn-sm btn-ghost btn-reprint" data-reprint-id="${escapeAttr(entry.id)}" title="R\u00e9imprimer">\ud83d\udda8</button>`)
      : '';
    const retryBtn = isError
      ? `<button class="btn btn-sm btn-ghost btn-retry" data-retry-job="${escapeAttr(entry.jobId)}" title="Réessayer depuis l'API">↻</button>`
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
          <div class="history-meta">${typeLabel} • ${time}${entry.attempts > 1 ? ' • ' + entry.attempts + ' tentatives' : ''}</div>
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
          showNotification(result.error || 'Erreur de réimpression', 'error');
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
  $workspaceList.innerHTML = '<div class="loading-state"><span class="spinner"></span> Chargement des boutiques…</div>';
  try {
    await api.refreshWorkspaces();
  } catch (err) {
    $workspaceList.innerHTML = '<div class="error-state">Erreur : ' + escapeHtml(err.message || 'Impossible de charger les boutiques') + '</div>';
  }
});
bindBtn('btn-refresh-printers', async () => {
  $printerList.innerHTML = '<div class="loading-state"><span class="spinner"></span> Détection des imprimantes…</div>';
  try {
    await api.listPrinters();
  } catch (err) {
    $printerList.innerHTML = '<div class="error-state">Erreur : ' + escapeHtml(err.message || 'Impossible de détecter les imprimantes') + '</div>';
  }
});
bindBtn('btn-retry-all', () => api.retryAllFailed());
bindBtn('btn-clear-history', async () => {
  await api.clearHistory();
  if ($historyList) $historyList.innerHTML = '<div class="empty-state">Aucune impression enregistrée</div>';
});
bindBtn('btn-open-dashboard', () => {
  const appUrl = currentState?.appUrl || 'https://app.hou.la';
  api.openExternal(`${appUrl}/manager`);
});

// Init ZPL config listeners (toggle, save, test, scale slider)
initZplConfigListeners();

// ═══════════════════════════════════════════════════════
// IPC listener: state updates from main process
// ═══════════════════════════════════════════════════════

api.onStateUpdated((state) => updateUI(state));

// Initial state fetch
api.getState().then((state) => {
  updateUI(state);
  // Auto-detect printers on startup if authenticated and list is empty
  if (state.authenticated && (!state.printers || state.printers.length === 0)) {
    $printerList.innerHTML = '<div class="loading-state"><span class="spinner"></span> Détection des imprimantes…</div>';
    api.listPrinters().catch(() => {});
  }
});

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
