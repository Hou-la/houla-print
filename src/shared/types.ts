// Shared types used by both main and renderer processes

export type PrintJobType = 'product_label' | 'order_summary' | 'invoice' | 'shipping_label' | 'packing_slip';
export type PrintJobStatus = 'pending' | 'sent' | 'printed' | 'failed' | 'cancelled';
export type PrintLabelFormat = 'zpl' | 'pdf' | 'escpos' | 'png' | 'niimbot';
export type PrintLabelSize = '57x32' | '40x30' | '50x30' | '50x25' | '100x50' | '100x100' | '100x150' | (string & {});

export const LABEL_SIZE_OPTIONS: { value: PrintLabelSize; label: string }[] = [
  { value: '57x32',   label: '57 × 32 mm — Standard' },
  { value: '40x30',   label: '40 × 30 mm — Petit (bijoux)' },
  { value: '50x30',   label: '50 × 30 mm — Niimbot standard' },
  { value: '50x25',   label: '50 × 25 mm — Compact' },
  { value: '100x50',  label: '100 × 50 mm — Moyen' },
  { value: '100x100', label: '100 × 100 mm — Grand carré' },
  { value: '100x150', label: '100 × 150 mm — Expédition (6×4")' },
];

export interface PrintJob {
  id: string;
  workspaceId: string;
  orderId: string | null;
  type: PrintJobType;
  status: PrintJobStatus;
  payload: Record<string, unknown>;
  labelFormat: PrintLabelFormat;
  labelData: string | null;
  labelUrl: string | null;
  attempts: number;
  lastError: string | null;
  printedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrintConfig {
  id: string;
  workspaceId: string;
  enabled: boolean;
  autoProductLabels: boolean;
  autoOrderSummary: boolean;
  autoInvoice: boolean;
  autoInvoiceTrigger: 'paid' | 'processing';
  autoShippingLabel: boolean;
  autoPackingSlip: boolean;
  productLabelTemplate: 'standard' | 'minimal' | 'detailed';
  productLabelSize: PrintLabelSize;
  brandName: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  type: string;
  avatarUrl: string | null;
  plan: string;
  hasShop?: boolean;
}

export interface WorkspaceState {
  workspace: Workspace;
  apiKey: string;
  enabled: boolean;
  config: PrintConfig | null;
}

export interface PrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
  status: number;
  description: string;
  /** Inferred printer type based on name/driver */
  type: 'thermal' | 'receipt' | 'standard' | 'niimbot' | 'unknown';
}

export interface PrinterAssignments {
  product_label: string | null;
  order_summary: string | null;
  invoice: string | null;
  shipping_label: string | null;
  packing_slip: string | null;
  [key: string]: string | null;
}

export type PrintHistoryStatus = 'printed' | 'failed';

export interface PrintHistoryEntry {
  id: string;
  jobId: string;
  workspaceId: string;
  type: PrintJobType;
  status: PrintHistoryStatus;
  productName: string;
  customerName?: string;
  socialHandle?: string;
  price?: string;
  orderDate?: string;
  error: string | null;
  attempts: number;
  timestamp: string; // ISO 8601
  /** Original job payload (product/order details) — needed for reprint */
  payload?: Record<string, unknown>;
  /** Label format used for printing */
  labelFormat?: PrintLabelFormat;
  /** Raw label data (ZPL/ESC-POS text) — stored for reprint. Omitted for Niimbot (re-rendered from payload). */
  labelData?: string | null;
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'no-workspace' | 'error';

/** Print mode for shipping label printers */
export type PrintMode = 'auto' | 'zpl' | 'driver';

/** Per-printer ZPL/thermal configuration for shipping labels */
export interface PrinterZplConfig {
  /** Print mode: auto (pattern-detected), zpl (force raw ZPL), driver (force Windows driver) */
  mode: PrintMode;
  /** Printer resolution in DPI: 203 (budget/Chinese) or 300 (genuine Zebra industrial) */
  dpi: 203 | 300;
  /** Scale factor 0.80–1.00 to fit label within printable area (default 0.90) */
  scale: number;
}

export const DEFAULT_ZPL_CONFIG: PrinterZplConfig = {
  mode: 'auto',
  dpi: 203,
  scale: 0.90,
};

export interface AppState {
  authenticated: boolean;
  connected: boolean;
  connectionStatus: ConnectionStatus;
  workspaces: WorkspaceState[];
  printers: PrinterInfo[];
  printerAssignments: PrinterAssignments;
  printerLabelFormats: Record<string, { widthMm: number; heightMm: number }>;
  printerZplConfigs: Record<string, PrinterZplConfig>;
  pendingJobsCount: number;
  printedTodayCount: number;
  failedTodayCount: number;
  offlinePrinters: Array<{ printerName: string; since: string; spooledCount: number }>;
  printHistory: PrintHistoryEntry[];
  lastError: string | null;
  env: 'production' | 'development';
  apiUrl: string;
  appUrl: string;
}

/** IPC channel names for main ↔ renderer communication */
export const IPC = {
  // Auth
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_STATUS: 'auth:status',

  // State
  GET_STATE: 'state:get',
  STATE_UPDATED: 'state:updated',

  // Workspaces
  WORKSPACE_TOGGLE: 'workspace:toggle',
  WORKSPACE_REFRESH: 'workspace:refresh',
  WORKSPACE_UPDATE_CONFIG: 'workspace:update-config',

  // Printers
  PRINTER_LIST: 'printer:list',
  PRINTER_ASSIGN: 'printer:assign',
  PRINTER_TEST: 'printer:test',
  PRINTER_PROBE: 'printer:probe',
  PRINTER_DETECT: 'printer:detect',
  PRINTER_PREVIEW: 'printer:preview',
  PRINTER_SET_ZPL_CONFIG: 'printer:set-zpl-config',
  PRINTER_GET_ZPL_CONFIG: 'printer:get-zpl-config',

  // Print queue
  QUEUE_STATS: 'queue:stats',
  QUEUE_RETRY_ALL: 'queue:retry-all',
  QUEUE_RETRY_JOB: 'queue:retry-job',
  QUEUE_REPRINT_JOB: 'queue:reprint-job',
  QUEUE_HISTORY: 'queue:history',
  QUEUE_CLEAR_HISTORY: 'queue:clear-history',

  // App
  APP_QUIT: 'app:quit',
  APP_MINIMIZE: 'app:minimize',
  OPEN_EXTERNAL: 'app:open-external',
  SET_ENV: 'app:set-env',
  NOTIFICATION: 'app:notification',
} as const;
