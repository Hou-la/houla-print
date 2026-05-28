import { Notification } from 'electron';
import { StoreService } from './store.service';
import { ApiService } from './api.service';
import { PrinterService } from './printer.service';
import { PrintJob, PrintHistoryEntry, WorkspaceState } from '../../shared/types';
import { LabelContent } from './niimbot';

const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 5000, 15000]; // ms — for fatal errors only

// For transient errors (printer offline/no paper), use escalating backoff with no upper limit on retries
const TRANSIENT_RETRY_DELAYS = [2000, 5000, 10000, 20000, 30000, 60000]; // last value repeats forever

/**
 * Determine if an error is transient (printer offline, connection lost, no paper)
 * vs fatal (corrupt data, unsupported format, render failure).
 * Transient errors get infinite retries; fatal errors get MAX_RETRIES.
 */
function isTransientError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase();
  return (
    lower.includes('non connectée') ||
    lower.includes('not connected') ||
    lower.includes('not open') ||
    lower.includes('port not open') ||
    lower.includes('cannot open') ||
    lower.includes('timeout waiting') ||
    lower.includes('handshake failed') ||
    lower.includes('access denied') ||
    lower.includes('device not configured') ||
    lower.includes('resource busy') ||
    lower.includes('no such file or directory') ||
    lower.includes('enoent') ||
    lower.includes('eperm') ||
    lower.includes('eacces') ||
    lower.includes('print failed') ||    // generic Niimbot print failure
    lower.includes('connection lost') ||
    lower.includes('paper') ||           // out of paper
    lower.includes('busy')               // printer busy
  );
}

/** Build "1/3" from quantityIndex and quantity fields */
function buildQuantityFraction(idx: unknown, total: unknown): string | undefined {
  const i = typeof idx === 'number' ? idx : parseInt(idx as string, 10);
  const t = typeof total === 'number' ? total : parseInt(total as string, 10);
  if (isNaN(i) || isNaN(t) || t <= 1) return undefined;
  return `${i}/${t}`;
}

/**
 * Local print queue: receives jobs from WebSocket or API polling,
 * routes them to the correct printer, handles retries, and acks the API.
 */
/** Per-printer offline state */
interface OfflinePrinterState {
  since: string;            // ISO 8601 — when the first transient error was detected
  retries: number;          // consecutive transient failures (for backoff)
  nextRetryAt: number;      // Date.now()-based timestamp — don't retry before this
}

export class QueueService {
  private pendingJobs: Map<string, { job: PrintJob; apiKey: string; retries: number }> = new Map();
  private lastError: string | null = null;
  private processing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onStateChange: (() => void) | null = null;
  /** Per-printer offline tracking (key = printer name) */
  private offlinePrinters: Map<string, OfflinePrinterState> = new Map();

  constructor(
    private store: StoreService,
    private api: ApiService,
    private printer: PrinterService,
  ) {
    // Restore persisted queue from disk (jobs that survived a restart)
    this.restorePersistedQueue();

    // Process queue every 2 seconds
    this.timer = setInterval(() => this.processNext(), 2000);
  }

  /**
   * Restore pending jobs from persistent storage (survives app restarts).
   */
  private restorePersistedQueue(): void {
    const persisted = this.store.getPendingQueue();
    if (persisted.length === 0) return;

    let restored = 0;
    for (const entry of persisted) {
      if (!this.pendingJobs.has(entry.job.id)) {
        this.pendingJobs.set(entry.job.id, {
          job: entry.job,
          apiKey: entry.apiKey,
          retries: entry.retries,
        });
        restored++;
      }
    }

    if (restored > 0) {
      console.log(`[Queue] Restored ${restored} pending job(s) from persistent storage`);
      new Notification({
        title: 'Hou.la Print',
        body: `${restored} impression${restored > 1 ? 's' : ''} en attente restaurée${restored > 1 ? 's' : ''}`,
      }).show();
    }
  }

  /**
   * Persist the current in-memory queue to disk.
   */
  private persistQueue(): void {
    const items = Array.from(this.pendingJobs.entries()).map(([_, entry]) => ({
      job: entry.job,
      apiKey: entry.apiKey,
      retries: entry.retries,
      spooledAt: new Date().toISOString(),
    }));
    this.store.setPendingQueue(items);
  }

  /**
   * Set callback for state changes (used by main to broadcast).
   */
  setOnStateChange(callback: () => void): void {
    this.onStateChange = callback;
  }

  /**
   * Start periodic API polling (fallback when WebSocket events are missed).
   */
  startPolling(activeWorkspaces: WorkspaceState[]): void {
    this.stopPolling();
    // Poll every 30s to catch any missed WebSocket events
    this.pollTimer = setInterval(async () => {
      for (const ws of activeWorkspaces) {
        await this.fetchPendingForWorkspace(ws.workspace.id, ws.apiKey);
      }
      this.onStateChange?.();
    }, 30_000);
    console.log(`[Queue] Polling started for ${activeWorkspaces.length} workspace(s)`);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Add jobs received from WebSocket to the local queue.
   */
  enqueueJobs(jobs: PrintJob[], apiKey: string): void {
    let newCount = 0;
    for (const job of jobs) {
      if (!this.pendingJobs.has(job.id)) {
        this.pendingJobs.set(job.id, { job, apiKey, retries: 0 });
        newCount++;
      }
    }

    if (newCount > 0) {
      console.log(`[Queue] Enqueued ${newCount} new job(s) (total pending: ${this.pendingJobs.size})`);
      this.persistQueue(); // Save to disk immediately
      new Notification({
        title: 'Hou.la Print',
        body: `${newCount} nouveau${newCount > 1 ? 'x' : ''} job${newCount > 1 ? 's' : ''} d'impression`,
      }).show();
      this.onStateChange?.();
      // Trigger immediate processing instead of waiting for 2s timer
      setImmediate(() => this.processNext());
    }
  }

  /**
   * Remove cancelled jobs from the local queue.
   */
  cancelJobs(jobIds: string[]): void {
    for (const id of jobIds) {
      this.pendingJobs.delete(id);
      this.store.removeFromPendingQueue(id);
    }
    if (jobIds.length > 0) this.persistQueue();
  }

  /**
   * Fetch pending jobs from the API for all active workspaces (on startup/reconnect).
   */
  async fetchPendingFromApi(activeWorkspaces: WorkspaceState[]): Promise<void> {
    for (const ws of activeWorkspaces) {
      await this.fetchPendingForWorkspace(ws.workspace.id, ws.apiKey);
    }
  }

  /**
   * Fetch pending jobs for a single workspace.
   */
  async fetchPendingForWorkspace(workspaceId: string, apiKey: string): Promise<void> {
    try {
      console.log(`[Queue] Fetching pending jobs for workspace ${workspaceId.substring(0, 8)}...`);
      const jobs = await this.api.getPendingJobs(apiKey);
      console.log(`[Queue] Got ${jobs.length} pending job(s) from API for workspace ${workspaceId.substring(0, 8)}`);
      if (jobs.length > 0) {
        this.enqueueJobs(jobs, apiKey);
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error(`[Queue] Failed to fetch pending jobs for workspace ${workspaceId.substring(0, 8)}: ${msg}`);
      this.lastError = `Erreur API: ${msg}`;
      this.onStateChange?.();
    }
  }

  /**
   * Resolve the printer name for a given job type from assignments.
   */
  private resolvePrinter(jobType: string): string | null {
    const assignments = this.store.getPrinterAssignments();
    return assignments[jobType] || null;
  }

  /**
   * Count jobs assigned to a specific printer (by checking job type → assignment).
   */
  private countJobsForPrinter(printerName: string): number {
    let count = 0;
    for (const [, entry] of this.pendingJobs) {
      if (this.resolvePrinter(entry.job.type) === printerName) count++;
    }
    return count;
  }

  /**
   * Process the next eligible job in the queue.
   * Skips jobs whose printer is offline (in cooldown). Jobs for online printers
   * proceed normally, so one offline printer never blocks the others.
   *
   * Transient errors (printer offline) → infinite retry with per-printer backoff
   * Fatal errors (bad data) → MAX_RETRIES then abandon
   */
  private async processNext(): Promise<void> {
    if (this.processing) return;
    if (this.pendingJobs.size === 0) return;

    const now = Date.now();

    // Find the first job whose printer is available (not in cooldown)
    let selectedJobId: string | null = null;
    let selectedEntry: { job: PrintJob; apiKey: string; retries: number } | null = null;
    let selectedPrinter: string | null = null;

    for (const [jobId, entry] of this.pendingJobs) {
      const printerName = this.resolvePrinter(entry.job.type);
      if (!printerName) continue; // No printer assigned — skip

      const offlineState = this.offlinePrinters.get(printerName);
      if (offlineState && now < offlineState.nextRetryAt) {
        // This printer is in cooldown — skip this job, try next
        continue;
      }

      // This job's printer is available (online or cooldown expired → time to retry)
      selectedJobId = jobId;
      selectedEntry = entry;
      selectedPrinter = printerName;
      break;
    }

    if (!selectedJobId || !selectedEntry || !selectedPrinter) return;

    this.processing = true;
    let shouldContinue = false;

    const printerName = selectedPrinter;
    const isNiimbot = printerName.startsWith('niimbot:') || this.isNiimbotPrinter(printerName);

    // ── NIIMBOT BATCH PATH ──
    // Collect all eligible jobs for the same Niimbot printer and print in one session.
    if (isNiimbot) {
      const batch = this.collectBatchForPrinter(printerName, now);
      if (batch.length > 1) {
        console.log(`[Queue] Niimbot batch: ${batch.length} jobs for "${printerName}"`);
        shouldContinue = await this.processNiimbotBatch(batch, printerName);
        this.processing = false;
        this.onStateChange?.();
        if (shouldContinue && this.pendingJobs.size > 0) {
          setImmediate(() => this.processNext());
        }
        return;
      }
    }

    // ── SINGLE JOB PATH ──
    const jobId = selectedJobId;
    const entry = selectedEntry;
    const { job, apiKey } = entry;
    const isReprint = apiKey === '__reprint__';

    try {
      await this.executePrint(job, printerName);

      // Success — ack the API (skip for local reprints) and remove from queue
      if (!isReprint) {
        await this.api.ackJob(apiKey, job.id, 'printed').catch(console.error);
      }
      this.pendingJobs.delete(jobId);
      this.store.removeFromPendingQueue(jobId);
      this.store.incrementPrintedToday();
      this.lastError = null;
      shouldContinue = true;

      // Clear offline state for this printer
      this.clearOfflineState(printerName);

      // Record in persistent history (skip reprints to avoid clutter)
      if (!isReprint) {
        this.store.addHistoryEntry(this.buildHistoryEntry(job, 'printed', null, entry.retries));
      }
    } catch (err: any) {
      const errorMsg = err.message || String(err);
      console.error(`Print failed for job ${jobId} on printer "${printerName}":`, errorMsg);

      entry.retries++;

      if (isTransientError(errorMsg)) {
        // ── TRANSIENT ERROR: printer offline / no paper / connection lost ──
        // Mark this specific printer as offline with backoff
        const existing = this.offlinePrinters.get(printerName);
        const retries = existing ? existing.retries + 1 : 1;
        const delayIndex = Math.min(retries - 1, TRANSIENT_RETRY_DELAYS.length - 1);
        const delay = TRANSIENT_RETRY_DELAYS[delayIndex];

        this.offlinePrinters.set(printerName, {
          since: existing?.since || new Date().toISOString(),
          retries,
          nextRetryAt: Date.now() + delay,
        });

        // Notify on first transient error for this printer
        if (!existing) {
          const spooled = this.countJobsForPrinter(printerName);
          new Notification({
            title: `Hou.la Print — ${printerName}`,
            body: `Imprimante indisponible — ${spooled} impression${spooled > 1 ? 's' : ''} en attente`,
          }).show();
        }

        this.lastError = `${printerName}: indisponible (tentative ${retries}, prochain essai dans ${Math.round(delay / 1000)}s)`;

        // Persist updated retry count
        this.store.updatePendingQueueItem(jobId, { retries: entry.retries });

      } else {
        // ── FATAL ERROR: bad data, unsupported format, render failure ──
        if (entry.retries >= MAX_RETRIES) {
          if (!isReprint) {
            await this.api.ackJob(apiKey, job.id, 'failed', errorMsg).catch(console.error);
          }
          this.pendingJobs.delete(jobId);
          this.store.removeFromPendingQueue(jobId);
          this.lastError = `Job ${jobId.substring(0, 8)} échoué: ${errorMsg}`;
          this.store.incrementFailedToday();

          this.store.addHistoryEntry(this.buildHistoryEntry(job, 'failed', errorMsg, entry.retries));

          new Notification({
            title: 'Hou.la Print — Erreur',
            body: `Impression échouée après ${MAX_RETRIES} tentatives: ${errorMsg.substring(0, 80)}`,
          }).show();
        } else {
          const delay = RETRY_DELAYS[entry.retries - 1] || 15000;
          this.lastError = `Tentative ${entry.retries}/${MAX_RETRIES}: ${errorMsg}`;
          this.store.updatePendingQueueItem(jobId, { retries: entry.retries });
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    } finally {
      this.processing = false;
      this.onStateChange?.();
      // Immediately process next job without waiting for 2s timer tick
      if (shouldContinue && this.pendingJobs.size > 0) {
        setImmediate(() => this.processNext());
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // Niimbot batch printing
  // ═══════════════════════════════════════════════════════

  /** Maximum number of labels to batch in a single Niimbot print session */
  private static readonly MAX_BATCH_SIZE = 10;

  /**
   * Collect all eligible pending jobs for a given printer (up to MAX_BATCH_SIZE).
   * Returns entries in queue order (FIFO).
   */
  private collectBatchForPrinter(
    printerName: string,
    now: number,
  ): Array<{ jobId: string; entry: { job: PrintJob; apiKey: string; retries: number } }> {
    const batch: Array<{ jobId: string; entry: { job: PrintJob; apiKey: string; retries: number } }> = [];

    for (const [jobId, entry] of this.pendingJobs) {
      if (batch.length >= QueueService.MAX_BATCH_SIZE) break;

      const resolvedPrinter = this.resolvePrinter(entry.job.type);
      if (resolvedPrinter !== printerName) continue;

      const offlineState = this.offlinePrinters.get(resolvedPrinter);
      if (offlineState && now < offlineState.nextRetryAt) continue;

      batch.push({ jobId, entry });
    }

    return batch;
  }

  /**
   * Build label content from a job payload (extracted from executeNiimbotPrint).
   */
  private buildLabelContentFromJob(job: PrintJob): { content: LabelContent; labelSize: string } {
    const p = job.payload;

    const formatPrice = (cents: unknown, currency: unknown): string | undefined => {
      if (typeof cents !== 'number') return undefined;
      const cur = (currency as string) || 'EUR';
      const val = (cents / 100).toFixed(2).replace('.', ',');
      return cur === 'EUR' ? val + ' €' : val + ' ' + cur;
    };

    const content: LabelContent = {
      productName: (p.productName as string) || (p.name as string) || 'Produit',
      variant: (p.variant as string) || (p.variants as string) || undefined,
      sku: (p.sku as string) || undefined,
      price: (p.price as string) || formatPrice(p.priceCents, p.currency),
      originalPrice: (p.originalPrice as string) || formatPrice(p.originalPriceCents, p.currency),
      barcode: (p.barcode as string) || undefined,
      orderId: (p.orderNumber as string) || (p.orderId as string) || undefined,
      orderDate: (p.orderDate as string) || undefined,
      orderTotal: (p.orderTotal as string) || (p.orderTotalFormatted as string) || undefined,
      quantityFraction: buildQuantityFraction(p.quantityIndex, p.quantity),
      customerName: (p.customerName as string) || undefined,
      socialHandle: (p.socialHandle as string) || undefined,
      country: (p.country as string) || undefined,
      qrCodeUrl: (p.qrCodeUrl as string) || undefined,
      brandName: (p.brandName as string) || undefined,
      websiteUrl: (p.websiteUrl as string) || undefined,
    };

    const printerFormat = this.store.getPrinterLabelFormat(
      this.resolvePrinter(job.type) || '',
    );
    const labelSize = printerFormat
      ? `${printerFormat.widthMm}x${printerFormat.heightMm}`
      : '40x30';

    return { content, labelSize };
  }

  /**
   * Process a batch of Niimbot jobs as fast sequential individual prints.
   * Each label fully ejects (labels 2+ skip SET_DENSITY/SET_LABEL_TYPE).
   * All bitmaps pre-rendered upfront, connection stays open between prints.
   * Returns true if at least one page succeeded (to trigger immediate reprocess).
   */
  private async processNiimbotBatch(
    batch: Array<{ jobId: string; entry: { job: PrintJob; apiKey: string; retries: number } }>,
    printerName: string,
  ): Promise<boolean> {
    // Build all label bitmaps upfront
    const labels = batch.map(({ entry }) => this.buildLabelContentFromJob(entry.job));

    let batchResult: { results: Array<{ success: boolean; error?: string }>; totalPrinted: number };

    try {
      batchResult = await this.printer.printNiimbotBatch(
        printerName,
        labels.map(l => ({ content: l.content, labelSize: l.labelSize as any })),
      );
    } catch (err: any) {
      // Total failure (connection, init) — mark first job as error
      const errorMsg = err.message || String(err);
      console.error(`[Queue] Niimbot batch session failed: ${errorMsg}`);
      this.handlePrintError(batch[0].jobId, batch[0].entry, printerName, errorMsg);
      return false;
    }

    // Process per-page results
    for (let i = 0; i < batch.length; i++) {
      const { jobId, entry } = batch[i];
      const pageResult = batchResult.results[i];
      const isReprint = entry.apiKey === '__reprint__';

      if (pageResult?.success) {
        if (!isReprint) {
          await this.api.ackJob(entry.apiKey, entry.job.id, 'printed').catch(console.error);
        }
        this.pendingJobs.delete(jobId);
        this.store.removeFromPendingQueue(jobId);
        this.store.incrementPrintedToday();

        if (!isReprint) {
          this.store.addHistoryEntry(this.buildHistoryEntry(entry.job, 'printed', null, entry.retries));
        }
      } else {
        // Page failed — handle error for this and remaining jobs
        const errorMsg = pageResult?.error || 'Unknown print failure';
        console.error(`[Queue] Niimbot batch page ${i + 1}/${batch.length} failed: ${errorMsg}`);
        this.handlePrintError(jobId, entry, printerName, errorMsg);
        // Remaining pages were already skipped by printBitmapMultiPage
        for (let j = i + 1; j < batch.length; j++) {
          this.handlePrintError(batch[j].jobId, batch[j].entry, printerName, 'Skipped after previous page failure');
        }
        break;
      }
    }

    if (batchResult.totalPrinted > 0) {
      this.lastError = null;
      this.clearOfflineState(printerName);
      this.persistQueue();
      console.log(`[Queue] Niimbot batch: ${batchResult.totalPrinted}/${batch.length} printed successfully`);
    }

    return batchResult.totalPrinted > 0;
  }

  /**
   * Clear offline state for a printer and notify user.
   */
  private clearOfflineState(printerName: string): void {
    if (this.offlinePrinters.has(printerName)) {
      this.offlinePrinters.delete(printerName);
      console.log(`[Queue] Printer "${printerName}" back online — spooled jobs resuming`);
      new Notification({
        title: 'Hou.la Print',
        body: `Imprimante "${printerName}" reconnectée — reprise des impressions`,
      }).show();
    }
  }

  /**
   * Handle a print error for a single job (transient vs fatal classification).
   */
  private handlePrintError(
    jobId: string,
    entry: { job: PrintJob; apiKey: string; retries: number },
    printerName: string,
    errorMsg: string,
  ): void {
    entry.retries++;

    if (isTransientError(errorMsg)) {
      const existing = this.offlinePrinters.get(printerName);
      const retries = existing ? existing.retries + 1 : 1;
      const delayIndex = Math.min(retries - 1, TRANSIENT_RETRY_DELAYS.length - 1);
      const delay = TRANSIENT_RETRY_DELAYS[delayIndex];

      this.offlinePrinters.set(printerName, {
        since: existing?.since || new Date().toISOString(),
        retries,
        nextRetryAt: Date.now() + delay,
      });

      if (!existing) {
        const spooled = this.countJobsForPrinter(printerName);
        new Notification({
          title: `Hou.la Print — ${printerName}`,
          body: `Imprimante indisponible — ${spooled} impression${spooled > 1 ? 's' : ''} en attente`,
        }).show();
      }

      this.lastError = `${printerName}: indisponible (tentative ${retries}, prochain essai dans ${Math.round(delay / 1000)}s)`;
      this.store.updatePendingQueueItem(jobId, { retries: entry.retries });
    } else {
      if (entry.retries >= MAX_RETRIES) {
        const isReprint = entry.apiKey === '__reprint__';
        if (!isReprint) {
          this.api.ackJob(entry.apiKey, entry.job.id, 'failed', errorMsg).catch(console.error);
        }
        this.pendingJobs.delete(jobId);
        this.store.removeFromPendingQueue(jobId);
        this.lastError = `Job ${jobId.substring(0, 8)} échoué: ${errorMsg}`;
        this.store.incrementFailedToday();
        this.store.addHistoryEntry(this.buildHistoryEntry(entry.job, 'failed', errorMsg, entry.retries));

        new Notification({
          title: 'Hou.la Print — Erreur',
          body: `Impression échouée après ${MAX_RETRIES} tentatives: ${errorMsg.substring(0, 80)}`,
        }).show();
      } else {
        this.lastError = `Tentative ${entry.retries}/${MAX_RETRIES}: ${errorMsg}`;
        this.store.updatePendingQueueItem(jobId, { retries: entry.retries });
      }
    }
  }

  /**
   * Execute the actual print operation based on label format and printer type.
   */
  private async executePrint(job: PrintJob, printerName: string): Promise<void> {
    // Check if printer is a Niimbot (serial) — route to Niimbot pipeline
    if (printerName.startsWith('niimbot:') || this.isNiimbotPrinter(printerName)) {
      await this.executeNiimbotPrint(job, printerName);
      return;
    }

    switch (job.labelFormat) {
      case 'zpl':
        if (!job.labelData) throw new Error('No label data for ZPL job');
        await this.printer.printZpl(printerName, job.labelData);
        break;

      case 'escpos':
        if (!job.labelData) throw new Error('No label data for ESC/POS job');
        await this.printer.printEscPos(printerName, job.labelData);
        break;

      case 'pdf':
        if (job.labelData) {
          // Inline PDF (base64)
          const buffer = Buffer.from(job.labelData, 'base64');
          const zplConfig = this.store.getPrinterZplConfig(printerName);
          await this.printer.printPdf(printerName, buffer, zplConfig);
        } else if (job.labelUrl) {
          // Download PDF from external URL (e.g. Sendcloud label)
          const pdfBuffer = await this.downloadPdfFromUrl(job.labelUrl);
          const zplConfig = this.store.getPrinterZplConfig(printerName);
          await this.printer.printPdf(printerName, pdfBuffer, zplConfig);
        } else {
          throw new Error('No label data or URL for PDF job');
        }
        break;

      default:
        throw new Error(`Unsupported label format: ${job.labelFormat}`);
    }
  }

  /**
   * Download a PDF from a URL and return it as a Buffer.
   * If the URL is an internal API path (starts with /api/), resolves it
   * against the configured API base URL and adds JWT authentication.
   */
  private async downloadPdfFromUrl(url: string): Promise<Buffer> {
    let resolvedUrl = url;
    const headers: Record<string, string> = {};

    if (url.startsWith('/api/')) {
      // Internal API endpoint — resolve against base URL and add auth
      const baseUrl = this.store.getApiUrl();
      resolvedUrl = `${baseUrl}${url}`;
      const token = this.store.getAccessToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    } else {
      // External URL — no auth added
    }

    let response = await fetch(resolvedUrl, { headers });

    // Auto-refresh JWT on 401 for internal API calls
    if (response.status === 401 && url.startsWith('/api/')) {
      try {
        const newToken = await this.api.refreshAccessToken();
        headers['Authorization'] = `Bearer ${newToken}`;
        response = await fetch(resolvedUrl, { headers });
      } catch {
        // refresh failed — throw the original 401
      }
    }

    if (!response.ok) {
      throw new Error(`PDF download failed: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Execute a print job targeting a Niimbot printer.
   * Converts the job payload into a label bitmap and sends via NIIMBOT protocol.
   */
  private async executeNiimbotPrint(job: PrintJob, printerName: string): Promise<void> {
    const { content, labelSize } = this.buildLabelContentFromJob(job);
    await this.printer.printNiimbot(printerName, content, labelSize as any);
  }

  /**
   * Check if a printer name corresponds to a detected Niimbot device.
   */
  private isNiimbotPrinter(printerName: string): boolean {
    const detected = this.printer.getLastDetected();
    const p = detected.find(d => d.name === printerName);
    return p?.type === 'niimbot';
  }

  /**
   * Find the API key for a job's workspace.
   */
  private getApiKeyForJob(job: PrintJob): string {
    const workspaces = this.store.getWorkspaces();
    return workspaces[job.workspaceId]?.apiKey || '';
  }

  /**
   * Retry all failed jobs (re-enqueue).
   */
  async retryAllFailed(): Promise<void> {
    // Failed jobs were already removed — this retries by re-fetching from API
    const workspaces = this.store.getWorkspaces();
    for (const [wsId, wsData] of Object.entries(workspaces)) {
      if (wsData.enabled && wsData.apiKey) {
        await this.fetchPendingForWorkspace(wsId, wsData.apiKey);
      }
    }
  }

  getPendingCount(): number {
    return this.pendingJobs.size;
  }

  getPrintedTodayCount(): number {
    return this.store.getPrintedTodayCount();
  }

  getFailedTodayCount(): number {
    return this.store.getFailedTodayCount();
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getHistory(): PrintHistoryEntry[] {
    return this.store.getHistory();
  }

  clearHistory(): void {
    this.store.clearHistory();
  }

  getStats(): {
    pending: number;
    printedToday: number;
    failedToday: number;
    lastError: string | null;
    offlinePrinters: Array<{ printerName: string; since: string; spooledCount: number }>;
  } {
    const offlinePrinters: Array<{ printerName: string; since: string; spooledCount: number }> = [];
    for (const [printerName, state] of this.offlinePrinters) {
      offlinePrinters.push({
        printerName,
        since: state.since,
        spooledCount: this.countJobsForPrinter(printerName),
      });
    }

    return {
      pending: this.getPendingCount(),
      printedToday: this.getPrintedTodayCount(),
      failedToday: this.getFailedTodayCount(),
      lastError: this.lastError,
      offlinePrinters,
    };
  }

  /**
   * Retry a single failed job by re-fetching it from the API.
   */
  async retryJob(jobId: string): Promise<void> {
    // Find the workspace and apiKey for this job from history
    const history = this.store.getHistory();
    const entry = history.find(h => h.jobId === jobId);
    if (!entry) return;

    const workspaces = this.store.getWorkspaces();
    const wsData = workspaces[entry.workspaceId];
    if (!wsData?.apiKey) return;

    // Re-fetch pending jobs for this workspace — the API marks failed jobs as re-queueable
    await this.fetchPendingForWorkspace(entry.workspaceId, wsData.apiKey);
  }

  /**
   * Reprint a job from history. Reconstructs a PrintJob from the stored
   * history entry and enqueues it directly (no API round-trip needed for
   * Niimbot/ZPL/ESC-POS since we store the payload/labelData).
   */
  async reprintJob(historyEntryId: string): Promise<{ success: boolean; error?: string }> {
    const history = this.store.getHistory();
    const entry = history.find(h => h.id === historyEntryId);
    if (!entry) return { success: false, error: 'Entrée introuvable dans l\'historique' };

    if (!entry.payload && !entry.labelData) {
      return { success: false, error: 'Données d\'impression manquantes — impossible de réimprimer' };
    }

    const workspaces = this.store.getWorkspaces();
    const wsData = workspaces[entry.workspaceId];
    if (!wsData?.apiKey) {
      return { success: false, error: 'Workspace non connecté' };
    }

    // Build a synthetic PrintJob from history data
    const reprintJob: PrintJob = {
      id: `reprint-${Date.now()}`,
      workspaceId: entry.workspaceId,
      orderId: null,
      type: entry.type,
      status: 'pending',
      payload: entry.payload || {},
      labelFormat: entry.labelFormat || 'niimbot',
      labelData: entry.labelData || null,
      labelUrl: null,
      attempts: 0,
      lastError: null,
      printedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Enqueue locally (no API ack needed for reprints)
    this.pendingJobs.set(reprintJob.id, { job: reprintJob, apiKey: '__reprint__', retries: 0 });
    this.persistQueue();
    console.log(`[Queue] Reprint enqueued for "${entry.productName}" (${reprintJob.id})`);
    this.onStateChange?.();

    return { success: true };
  }

  /**
   * Build a history entry from a completed (success or failed) print job.
   * Stores payload + labelFormat + labelData so the job can be reprinted from history.
   */
  private buildHistoryEntry(job: PrintJob, status: 'printed' | 'failed', error: string | null, attempts: number): PrintHistoryEntry {
    const p = job.payload || {};

    // Format price from cents for display
    const formatPrice = (cents: unknown, currency: unknown): string | undefined => {
      if (typeof cents !== 'number') return undefined;
      const cur = (currency as string) || 'EUR';
      const val = (cents / 100).toFixed(2).replace('.', ',');
      return cur === 'EUR' ? val + ' \u20ac' : val + ' ' + cur;
    };

    return {
      id: `${job.id}-${Date.now()}`,
      jobId: job.id,
      workspaceId: job.workspaceId,
      type: job.type,
      status,
      productName: (p.productName as string) || (p.name as string) || job.type,
      customerName: (p.customerName as string) || undefined,
      socialHandle: (p.socialHandle as string) || undefined,
      price: (p.price as string) || formatPrice(p.priceCents, p.currency),
      orderDate: (p.orderDate as string) || undefined,
      error,
      attempts,
      timestamp: new Date().toISOString(),
      payload: job.payload,
      labelFormat: job.labelFormat,
      // Store labelData for ZPL/ESC-POS (text, small). Skip for PDF (base64, large).
      labelData: job.labelFormat !== 'pdf' ? job.labelData : null,
    };
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopPolling();
    // Persist remaining jobs before shutdown
    this.persistQueue();
  }
}
