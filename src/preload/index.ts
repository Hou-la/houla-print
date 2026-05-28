import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/types';

/**
 * Preload script: exposes a safe IPC bridge to the renderer process.
 * Only exposes specific channels — no arbitrary IPC access.
 */
contextBridge.exposeInMainWorld('houlaPrint', {
  // Auth
  login: () => ipcRenderer.invoke(IPC.AUTH_LOGIN),
  logout: () => ipcRenderer.invoke(IPC.AUTH_LOGOUT),
  isAuthenticated: () => ipcRenderer.invoke(IPC.AUTH_STATUS),

  // State
  getState: () => ipcRenderer.invoke(IPC.GET_STATE),
  onStateUpdated: (callback: (state: any) => void) => {
    const handler = (_event: any, state: any) => callback(state);
    ipcRenderer.on(IPC.STATE_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC.STATE_UPDATED, handler);
  },

  // Workspaces
  toggleWorkspace: (workspaceId: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC.WORKSPACE_TOGGLE, workspaceId, enabled),
  refreshWorkspaces: () => ipcRenderer.invoke(IPC.WORKSPACE_REFRESH),
  updateWorkspaceConfig: (workspaceId: string, config: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC.WORKSPACE_UPDATE_CONFIG, workspaceId, config),

  // Printers
  listPrinters: () => ipcRenderer.invoke(IPC.PRINTER_LIST),
  assignPrinter: (jobType: string, printerName: string | null) =>
    ipcRenderer.invoke(IPC.PRINTER_ASSIGN, jobType, printerName),
  testPrinter: (printerName: string) =>
    ipcRenderer.invoke(IPC.PRINTER_TEST, printerName),
  probePrinter: (printerName: string) =>
    ipcRenderer.invoke(IPC.PRINTER_PROBE, printerName),
  detectLabel: (printerName: string) =>
    ipcRenderer.invoke(IPC.PRINTER_DETECT, printerName),
  previewLabel: (labelSize: string) =>
    ipcRenderer.invoke(IPC.PRINTER_PREVIEW, labelSize),
  setPrinterZplConfig: (printerName: string, config: any) =>
    ipcRenderer.invoke(IPC.PRINTER_SET_ZPL_CONFIG, printerName, config),
  getPrinterZplConfig: (printerName: string) =>
    ipcRenderer.invoke(IPC.PRINTER_GET_ZPL_CONFIG, printerName),

  // Queue
  getQueueStats: () => ipcRenderer.invoke(IPC.QUEUE_STATS),
  retryAllFailed: () => ipcRenderer.invoke(IPC.QUEUE_RETRY_ALL),
  retryJob: (jobId: string) => ipcRenderer.invoke(IPC.QUEUE_RETRY_JOB, jobId),
  reprintJob: (historyEntryId: string) => ipcRenderer.invoke(IPC.QUEUE_REPRINT_JOB, historyEntryId),
  getHistory: () => ipcRenderer.invoke(IPC.QUEUE_HISTORY),
  clearHistory: () => ipcRenderer.invoke(IPC.QUEUE_CLEAR_HISTORY),

  // App
  quit: () => ipcRenderer.send(IPC.APP_QUIT),
  minimize: () => ipcRenderer.send(IPC.APP_MINIMIZE),
  openExternal: (url: string) => ipcRenderer.send(IPC.OPEN_EXTERNAL, url),
  setEnv: (env: 'production' | 'development') => ipcRenderer.invoke(IPC.SET_ENV, env),
});
