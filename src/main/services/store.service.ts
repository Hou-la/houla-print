import Store from 'electron-store';
import { app, safeStorage } from 'electron';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { PrinterAssignments, PrintHistoryEntry, WorkspaceState, PrintJob, PrinterZplConfig, DEFAULT_ZPL_CONFIG } from '../../shared/types';
import { API_URLS, APP_URLS } from '../../shared/config';

interface StoreSchema {
  // Auth
  accessToken: string;
  refreshToken: string;

  // Workspaces with API keys
  workspaces: Record<string, {
    apiKey: string;
    enabled: boolean;
    workspaceName: string;
  }>;

  // Printer assignments: jobType → printerName
  printerAssignments: PrinterAssignments;

  // Queue stats
  printedTodayCount: number;
  printedTodayDate: string; // YYYY-MM-DD — reset daily

  // Printer-detected label formats: printerName → { widthMm, heightMm }
  printerLabelFormats: Record<string, { widthMm: number; heightMm: number }>;

  // Per-printer ZPL/thermal config: printerName → { mode, dpi, scale }
  printerZplConfigs: Record<string, PrinterZplConfig>;

  // Print history (persistent, capped at 200 entries)
  printHistory: PrintHistoryEntry[];
  failedTodayCount: number;
  failedTodayDate: string; // YYYY-MM-DD — reset daily

  // Persistent pending queue (survives app restarts / printer offline)
  pendingQueue: Array<{ job: PrintJob; apiKey: string; retries: number; spooledAt: string }>;

  // App settings
  apiUrl: string;
  appUrl: string;
  env: 'production' | 'development';
}

const STORE_DEFAULTS: StoreSchema = {
  accessToken: '',
  refreshToken: '',
  workspaces: {},
  printerAssignments: {
    product_label: null,
    order_summary: null,
    invoice: null,
    shipping_label: null,
    packing_slip: null,
  },
  printedTodayCount: 0,
  printedTodayDate: new Date().toISOString().split('T')[0],
  printerLabelFormats: {},
  printerZplConfigs: {},
  printHistory: [],
  failedTodayCount: 0,
  failedTodayDate: new Date().toISOString().split('T')[0],
  pendingQueue: [],
  apiUrl: API_URLS.production,
  appUrl: APP_URLS.production,
  env: 'production',
};

const STORE_OPTIONS = {
  name: 'houla-print-config',
  defaults: STORE_DEFAULTS,
};

export class StoreService {
  private store: Store<StoreSchema>;

  constructor() {
    // Migration: old versions used encryptionKey which encrypted the entire file.
    // After removing encryptionKey, the old file is unreadable binary — delete and start fresh.
    try {
      this.store = new Store<StoreSchema>(STORE_OPTIONS);
    } catch (err) {
      if (err instanceof SyntaxError) {
        const configPath = join(app.getPath('userData'), `${STORE_OPTIONS.name}.json`);
        console.warn(`[StoreService] Corrupted config file detected, resetting: ${configPath}`);
        if (existsSync(configPath)) unlinkSync(configPath);
        this.store = new Store<StoreSchema>(STORE_OPTIONS);
      } else {
        throw err;
      }
    }
  }

  // OS-level encryption for sensitive values (DPAPI on Windows, Keychain on macOS)
  private encrypt(value: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(value).toString('base64');
    }
    return value;
  }

  private decrypt(value: string): string {
    if (!value) return '';
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(value, 'base64'));
      } catch {
        // Value stored before encryption was available — return as-is
        return value;
      }
    }
    return value;
  }

  // ═══════════════════════════════════════════════════════
  // Auth
  // ═══════════════════════════════════════════════════════

  getAccessToken(): string | null {
    const encrypted = this.store.get('accessToken');
    const value = this.decrypt(encrypted);
    return value || null;
  }

  setAccessToken(token: string | null): void {
    if (token) {
      this.store.set('accessToken', this.encrypt(token));
    } else {
      this.store.delete('accessToken');
    }
  }

  getRefreshToken(): string | null {
    const encrypted = this.store.get('refreshToken');
    const value = this.decrypt(encrypted);
    return value || null;
  }

  setRefreshToken(token: string | null): void {
    if (token) {
      this.store.set('refreshToken', this.encrypt(token));
    } else {
      this.store.delete('refreshToken');
    }
  }

  clearAuth(): void {
    this.store.delete('accessToken');
    this.store.delete('refreshToken');
    this.store.set('workspaces', {});
  }

  // ═══════════════════════════════════════════════════════
  // Workspaces
  // ═══════════════════════════════════════════════════════

  getWorkspaces(): Record<string, { apiKey: string; enabled: boolean; workspaceName: string }> {
    const raw = this.store.get('workspaces');
    // Decrypt API keys
    const result: Record<string, { apiKey: string; enabled: boolean; workspaceName: string }> = {};
    for (const [id, ws] of Object.entries(raw)) {
      result[id] = { ...ws, apiKey: ws.apiKey ? this.decrypt(ws.apiKey) : '' };
    }
    return result;
  }

  setWorkspace(workspaceId: string, data: { apiKey: string; enabled: boolean; workspaceName: string }): void {
    const all = this.store.get('workspaces');
    all[workspaceId] = {
      ...data,
      apiKey: data.apiKey ? this.encrypt(data.apiKey) : '',
    };
    this.store.set('workspaces', all);
  }

  removeWorkspace(workspaceId: string): void {
    const all = this.getWorkspaces();
    delete all[workspaceId];
    this.store.set('workspaces', all);
  }

  setWorkspaceEnabled(workspaceId: string, enabled: boolean): void {
    const all = this.getWorkspaces();
    if (all[workspaceId]) {
      all[workspaceId].enabled = enabled;
      this.store.set('workspaces', all);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Printers
  // ═══════════════════════════════════════════════════════

  getPrinterAssignments(): PrinterAssignments {
    return this.store.get('printerAssignments');
  }

  setPrinterAssignment(jobType: string, printerName: string | null): void {
    const assignments = this.getPrinterAssignments();
    if (jobType in assignments) {
      assignments[jobType] = printerName;
      this.store.set('printerAssignments', assignments);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Printer label formats (RFID-detected, per-printer)
  // ═══════════════════════════════════════════════════════

  getPrinterLabelFormat(printerName: string): { widthMm: number; heightMm: number } | null {
    const formats = this.store.get('printerLabelFormats');
    return formats[printerName] || null;
  }

  setPrinterLabelFormat(printerName: string, format: { widthMm: number; heightMm: number }): void {
    const formats = this.store.get('printerLabelFormats');
    formats[printerName] = format;
    this.store.set('printerLabelFormats', formats);
  }

  getAllPrinterLabelFormats(): Record<string, { widthMm: number; heightMm: number }> {
    return this.store.get('printerLabelFormats');
  }

  // ═══════════════════════════════════════════════════════
  // Printer ZPL config (per-printer DPI, scale, mode)
  // ═══════════════════════════════════════════════════════

  getPrinterZplConfig(printerName: string): PrinterZplConfig {
    const configs = this.store.get('printerZplConfigs');
    return configs[printerName] || { ...DEFAULT_ZPL_CONFIG };
  }

  setPrinterZplConfig(printerName: string, config: PrinterZplConfig): void {
    const configs = this.store.get('printerZplConfigs');
    configs[printerName] = config;
    this.store.set('printerZplConfigs', configs);
  }

  getAllPrinterZplConfigs(): Record<string, PrinterZplConfig> {
    return this.store.get('printerZplConfigs');
  }

  // ═══════════════════════════════════════════════════════
  // Stats
  // ═══════════════════════════════════════════════════════

  incrementPrintedToday(): number {
    const today = new Date().toISOString().split('T')[0];
    const storedDate = this.store.get('printedTodayDate');
    if (storedDate !== today) {
      this.store.set('printedTodayDate', today);
      this.store.set('printedTodayCount', 0);
    }
    const count = this.store.get('printedTodayCount') + 1;
    this.store.set('printedTodayCount', count);
    return count;
  }

  getPrintedTodayCount(): number {
    const today = new Date().toISOString().split('T')[0];
    if (this.store.get('printedTodayDate') !== today) {
      return 0;
    }
    return this.store.get('printedTodayCount');
  }

  // ═══════════════════════════════════════════════════════
  // API config
  // ═══════════════════════════════════════════════════════

  getApiUrl(): string {
    return this.store.get('apiUrl');
  }

  getAppUrl(): string {
    return this.store.get('appUrl');
  }

  getEnv(): 'production' | 'development' {
    return this.store.get('env');
  }

  setEnv(env: 'production' | 'development'): void {
    this.store.set('env', env);
    this.store.set('apiUrl', API_URLS[env]);
    this.store.set('appUrl', APP_URLS[env]);
  }

  // ═══════════════════════════════════════════════════════
  // Print history (persistent, capped)
  // ═══════════════════════════════════════════════════════

  private static MAX_HISTORY = 200;

  addHistoryEntry(entry: PrintHistoryEntry): void {
    const history = this.store.get('printHistory') || [];
    history.unshift(entry); // newest first
    if (history.length > StoreService.MAX_HISTORY) {
      history.length = StoreService.MAX_HISTORY;
    }
    this.store.set('printHistory', history);
  }

  getHistory(): PrintHistoryEntry[] {
    return this.store.get('printHistory') || [];
  }

  clearHistory(): void {
    this.store.set('printHistory', []);
  }

  // ═══════════════════════════════════════════════════════
  // Failed today counter
  // ═══════════════════════════════════════════════════════

  incrementFailedToday(): number {
    const today = new Date().toISOString().split('T')[0];
    const storedDate = this.store.get('failedTodayDate');
    if (storedDate !== today) {
      this.store.set('failedTodayDate', today);
      this.store.set('failedTodayCount', 0);
    }
    const count = this.store.get('failedTodayCount') + 1;
    this.store.set('failedTodayCount', count);
    return count;
  }

  getFailedTodayCount(): number {
    const today = new Date().toISOString().split('T')[0];
    if (this.store.get('failedTodayDate') !== today) {
      return 0;
    }
    return this.store.get('failedTodayCount');
  }

  // ═══════════════════════════════════════════════════════
  // Persistent pending queue (survives restart / printer offline)
  // ═══════════════════════════════════════════════════════

  getPendingQueue(): Array<{ job: PrintJob; apiKey: string; retries: number; spooledAt: string }> {
    return this.store.get('pendingQueue') || [];
  }

  setPendingQueue(items: Array<{ job: PrintJob; apiKey: string; retries: number; spooledAt: string }>): void {
    this.store.set('pendingQueue', items);
  }

  addToPendingQueue(item: { job: PrintJob; apiKey: string; retries: number; spooledAt: string }): void {
    const queue = this.getPendingQueue();
    // Avoid duplicates
    if (!queue.some(q => q.job.id === item.job.id)) {
      queue.push(item);
      this.store.set('pendingQueue', queue);
    }
  }

  removeFromPendingQueue(jobId: string): void {
    const queue = this.getPendingQueue().filter(q => q.job.id !== jobId);
    this.store.set('pendingQueue', queue);
  }

  updatePendingQueueItem(jobId: string, updates: Partial<{ retries: number }>): void {
    const queue = this.getPendingQueue();
    const item = queue.find(q => q.job.id === jobId);
    if (item) {
      if (updates.retries !== undefined) item.retries = updates.retries;
      this.store.set('pendingQueue', queue);
    }
  }
}
