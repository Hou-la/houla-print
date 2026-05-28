import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import { AuthService } from './services/auth.service';
import { SocketService } from './services/socket.service';
import { PrinterService } from './services/printer.service';
import { QueueService } from './services/queue.service';
import { StoreService } from './services/store.service';
import { WorkspaceService } from './services/workspace.service';
import { ApiService } from './services/api.service';
import { IPC, AppState } from '../shared/types';
import { APP_NAME, APP_PROTOCOL } from '../shared/config';

// Catch unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[Main] Unhandled rejection:', err);
});

console.log('[Main] Starting Hou.la Print...');

// Single instance lock — prevent multiple windows
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Disable GPU hardware acceleration to avoid Windows GPU cache errors
// ("GPU state invalid after WaitForGetOffsetInRange")
app.disableHardwareAcceleration();

// Set app name so OS protocol handler dialog shows "Hou.la Print" instead of "Electron"
if (process.platform === 'win32') {
  app.setAppUserModelId('com.houla.print');
}
app.setName(APP_NAME);

// Register custom protocol for OAuth callback
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(APP_PROTOCOL);
}

// In dev mode, patch Windows registry so browser shows "Hou.la Print" instead of "Electron"
if (process.platform === 'win32' && process.defaultApp) {
  try {
    const { execSync } = require('child_process');
    const regBase = `HKCU\\Software\\Classes\\${APP_PROTOCOL}`;
    execSync(`reg add "${regBase}" /ve /d "URL:${APP_NAME}" /f`, { stdio: 'ignore' });
    execSync(`reg add "${regBase}\\shell\\open" /v "FriendlyAppName" /d "${APP_NAME}" /f`, { stdio: 'ignore' });
  } catch { /* non-critical */ }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let lastConnectionError: string | null = null;
let retryTimeout: ReturnType<typeof setTimeout> | null = null;

// Services
let store: StoreService;
let auth: AuthService;
let api: ApiService;
let socket: SocketService;
let printer: PrinterService;
let queue: QueueService;
let workspaces: WorkspaceService;

function getAppIcon(): Electron.NativeImage {
  // Try root assets/ first, then dist/assets/ as fallback
  const dirs = [
    path.join(__dirname, '..', '..', 'assets'),
    path.join(__dirname, '..', 'assets'),
  ];
  const fs = require('fs');
  for (const dir of dirs) {
    // On Windows use the 256px PNG for best taskbar quality (ico can be buggy with nativeImage)
    const png256 = path.join(dir, 'icon-256.png');
    const icoPath = path.join(dir, 'icon.ico');
    const pngPath = path.join(dir, 'icon.png');
    try {
      // Prefer the 256px PNG — Windows taskbar uses 48px+ and downscales
      if (process.platform === 'win32' && fs.existsSync(png256)) {
        const img = nativeImage.createFromPath(png256);
        if (!img.isEmpty()) {
          console.log('[Main] App icon loaded from', png256);
          return img;
        }
      }
      if (process.platform === 'win32' && fs.existsSync(icoPath)) {
        const img = nativeImage.createFromPath(icoPath);
        if (!img.isEmpty()) {
          console.log('[Main] App icon loaded from', icoPath);
          return img;
        }
      }
      if (fs.existsSync(pngPath)) {
        const img = nativeImage.createFromPath(pngPath);
        if (!img.isEmpty()) {
          console.log('[Main] App icon loaded from', pngPath);
          return img;
        }
      }
    } catch { /* continue to next dir */ }
  }
  console.warn('[Main] No app icon found in:', dirs);
  return nativeImage.createEmpty();
}

function createWindow(): void {
  const appIcon = getAppIcon();
  mainWindow = new BrowserWindow({
    width: 480,
    height: 680,
    minWidth: 400,
    minHeight: 500,
    resizable: true,
    frame: false,
    titleBarStyle: 'hidden',
    show: false,
    skipTaskbar: false,
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Required so preload can require() shared modules
    },
  });

  // Force-set icon again after creation (Windows taskbar needs this in dev mode)
  if (!appIcon.isEmpty()) {
    mainWindow.setIcon(appIcon);
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    console.log('[Main] Window ready-to-show.');
    // In dev mode, always show the window and open DevTools
    if (detectEnv() === 'development') {
      mainWindow?.show();
      mainWindow?.webContents.openDevTools({ mode: 'detach' });
    }
    // In production, stay hidden in tray
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[Main] Renderer crashed:', details.reason, details.exitCode);
  });

  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
    console.error('[Main] Failed to load:', errorCode, errorDescription);
  });

  mainWindow.on('close', (e) => {
    // Minimize to tray instead of closing
    e.preventDefault();
    mainWindow?.hide();
  });
}

function getTrayIcon(): Electron.NativeImage {
  const dirs = [
    path.join(__dirname, '..', '..', 'assets'),
    path.join(__dirname, '..', 'assets'),
  ];
  const fs = require('fs');
  for (const dir of dirs) {
    const pngPath = path.join(dir, 'tray-icon.png');
    try {
      if (fs.existsSync(pngPath)) {
        const img = nativeImage.createFromPath(pngPath).resize({ width: 16, height: 16 });
        if (!img.isEmpty()) return img;
      }
    } catch { /* continue to next dir */ }
  }
  console.warn('[Main] No tray icon found');
  return nativeImage.createEmpty();
}

function createTray(): void {
  tray = new Tray(getTrayIcon());
  tray.setToolTip(APP_NAME);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Afficher',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Dashboard Hou.la',
      click: () => shell.openExternal(`${store.getAppUrl()}/manager/shop/settings`),
    },
    { type: 'separator' },
    {
      label: 'Quitter',
      click: () => {
        app.exit(0);
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
}

function detectEnv(): 'production' | 'development' {
  // CLI flag takes precedence
  if (process.argv.includes('--dev')) return 'development';
  // NODE_ENV from environment
  if (process.env.NODE_ENV === 'development') return 'development';
  // Electron: app.isPackaged is false when running via `electron .`
  if (!app.isPackaged) return 'development';
  return 'production';
}

function initServices(): void {
  store = new StoreService();
  store.setEnv(detectEnv());
  api = new ApiService(store);
  auth = new AuthService(store, api);
  printer = new PrinterService();
  printer.setOnStateChanged(() => broadcastState());
  queue = new QueueService(store, api, printer);
  queue.setOnStateChange(() => broadcastState());
  workspaces = new WorkspaceService(store, api);
  socket = new SocketService(store, queue, workspaces, () => broadcastState());
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError && (err as any).cause?.code === 'ECONNREFUSED') return true;
  if (err instanceof TypeError && err.message === 'fetch failed') return true;
  if (err instanceof Error && err.message.includes('ECONNREFUSED')) return true;
  if (err instanceof Error && err.message.includes('ENOTFOUND')) return true;
  if (err instanceof Error && err.message.includes('ETIMEDOUT')) return true;
  return false;
}

function setConnectionError(err: unknown): void {
  if (isNetworkError(err)) {
    lastConnectionError = `API indisponible (${store.getApiUrl()}). Vérifiez que le serveur est démarré.`;
  } else if (err instanceof Error) {
    lastConnectionError = err.message;
  }
  broadcastState();
}

function clearConnectionError(): void {
  if (lastConnectionError) {
    lastConnectionError = null;
    broadcastState();
  }
}

/** Schedule an auto-retry to reconnect when the API becomes available */
function scheduleRetry(delaySec = 15): void {
  if (retryTimeout) return; // already scheduled
  console.log(`[Main] Will retry connection in ${delaySec}s...`);
  retryTimeout = setTimeout(async () => {
    retryTimeout = null;
    if (!auth.isAuthenticated()) return;
    try {
      await workspaces.refresh();
      clearConnectionError();
      socket.connectAll(workspaces.getActiveWorkspaces());
      queue.startPolling(workspaces.getActiveWorkspaces());
      await queue.fetchPendingFromApi(workspaces.getActiveWorkspaces());
      console.log('[Main] Retry succeeded — reconnected.');
      broadcastState();
    } catch (err) {
      console.error('[Main] Retry failed:', (err as Error).message);
      setConnectionError(err);
      scheduleRetry(30); // back off
    }
  }, delaySec * 1000);
}

function registerIpcHandlers(): void {
  // Auth
  ipcMain.handle(IPC.AUTH_LOGIN, async () => {
    // Only open browser — token exchange + workspace sync happens in handleDeepLink()
    await auth.login();
  });

  ipcMain.handle(IPC.AUTH_LOGOUT, async () => {
    socket.disconnectAll();
    workspaces.clear();
    auth.logout();
    broadcastState();
  });

  ipcMain.handle(IPC.AUTH_STATUS, () => auth.isAuthenticated());

  // State
  ipcMain.handle(IPC.GET_STATE, () => getAppState());

  // Workspaces
  ipcMain.handle(IPC.WORKSPACE_TOGGLE, async (_e, workspaceId: string, enabled: boolean) => {
    try {
      await workspaces.toggle(workspaceId, enabled);
      if (enabled) {
        socket.connect(workspaceId, workspaces.getApiKey(workspaceId));
      } else {
        socket.disconnect(workspaceId);
      }
      clearConnectionError();
    } catch (err) {
      console.error('[Main] workspace:toggle failed:', (err as Error).message);
      setConnectionError(err);
    }
    broadcastState();
  });

  ipcMain.handle(IPC.WORKSPACE_REFRESH, async () => {
    try {
      await workspaces.refresh();
      clearConnectionError();
    } catch (err) {
      console.error('[Main] workspace:refresh failed:', (err as Error).message);
      setConnectionError(err);
      if (isNetworkError(err)) scheduleRetry();
    }
    broadcastState();
  });

  ipcMain.handle(IPC.WORKSPACE_UPDATE_CONFIG, async (_e, workspaceId: string, config: Record<string, unknown>) => {
    try {
      await workspaces.updateConfig(workspaceId, config);
      clearConnectionError();
    } catch (err) {
      console.error('[Main] workspace:update-config failed:', (err as Error).message);
      setConnectionError(err);
    }
    broadcastState();
  });

  // Printers
  ipcMain.handle(IPC.PRINTER_LIST, async () => {
    try {
      const printers = await printer.detectPrinters();
      broadcastState();
      return printers;
    } catch (err) {
      console.error('[Main] printer:list failed:', (err as Error).message);
      return printer.getLastDetected();
    }
  });
  ipcMain.handle(IPC.PRINTER_ASSIGN, (_e, jobType: string, printerName: string | null) => {
    store.setPrinterAssignment(jobType, printerName);
    broadcastState();
  });
  ipcMain.handle(IPC.PRINTER_TEST, async (_e, printerName: string) => {
    const zplConfig = store.getPrinterZplConfig(printerName);
    const result = await printer.testPrint(printerName, zplConfig);
    // Save RFID-detected label format for this printer
    if ((result as any).detectedLabel) {
      const dl = (result as any).detectedLabel;
      store.setPrinterLabelFormat(printerName, { widthMm: dl.widthMm, heightMm: dl.heightMm });
      broadcastState();
    }
    return result;
  });
  ipcMain.handle(IPC.PRINTER_PROBE, async (_e, printerName: string) => {
    return printer.probePrinter(printerName);
  });
  ipcMain.handle(IPC.PRINTER_DETECT, async (_e, printerName: string) => {
    const result = await printer.detectNiimbotLabel(printerName);
    if (result.detectedLabel) {
      store.setPrinterLabelFormat(printerName, { widthMm: result.detectedLabel.widthMm, heightMm: result.detectedLabel.heightMm });
      broadcastState();
    }
    return result;
  });
  ipcMain.handle(IPC.PRINTER_PREVIEW, async (_e, labelSize: string) => {
    return printer.generatePreviewBase64(labelSize as any);
  });
  ipcMain.handle(IPC.PRINTER_SET_ZPL_CONFIG, (_e, printerName: string, config: any) => {
    store.setPrinterZplConfig(printerName, config);
    broadcastState();
  });
  ipcMain.handle(IPC.PRINTER_GET_ZPL_CONFIG, (_e, printerName: string) => {
    return store.getPrinterZplConfig(printerName);
  });

  // Queue
  ipcMain.handle(IPC.QUEUE_STATS, () => queue.getStats());
  ipcMain.handle(IPC.QUEUE_RETRY_ALL, async () => {
    await queue.retryAllFailed();
    broadcastState();
  });
  ipcMain.handle(IPC.QUEUE_RETRY_JOB, async (_e, jobId: string) => {
    await queue.retryJob(jobId);
    broadcastState();
  });
  ipcMain.handle(IPC.QUEUE_REPRINT_JOB, async (_e, historyEntryId: string) => {
    const result = await queue.reprintJob(historyEntryId);
    broadcastState();
    return result;
  });
  ipcMain.handle(IPC.QUEUE_HISTORY, () => queue.getHistory());
  ipcMain.handle(IPC.QUEUE_CLEAR_HISTORY, () => {
    queue.clearHistory();
    broadcastState();
  });

  // Environment
  ipcMain.handle(IPC.SET_ENV, (_e, env: 'production' | 'development') => {
    store.setEnv(env);
    // Rebuild tray to reflect the new dashboard URL
    createTray();
    broadcastState();
  });

  // App
  ipcMain.on(IPC.APP_QUIT, () => app.exit(0));
  ipcMain.on(IPC.APP_MINIMIZE, () => mainWindow?.hide());
  ipcMain.on(IPC.OPEN_EXTERNAL, (_e, url: string) => {
    // Only allow https/http URLs to prevent arbitrary protocol execution
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
  });
}

function getAppState(): AppState {
  const isSocketConnected = socket.isConnected();
  const hasEnabledWorkspace = workspaces.getAll().some(ws => ws.enabled);
  let connectionStatus: AppState['connectionStatus'];
  if (lastConnectionError) {
    connectionStatus = 'error';
  } else if (isSocketConnected) {
    connectionStatus = 'connected';
  } else if (!hasEnabledWorkspace) {
    connectionStatus = 'no-workspace';
  } else {
    connectionStatus = 'disconnected';
  }

  return {
    authenticated: auth.isAuthenticated(),
    connected: isSocketConnected,
    connectionStatus,
    workspaces: workspaces.getAll().map(ws => ({ ...ws, apiKey: '' })),
    printers: printer.getLastDetected(),
    printerAssignments: store.getPrinterAssignments(),
    pendingJobsCount: queue.getPendingCount(),
    printedTodayCount: queue.getPrintedTodayCount(),
    failedTodayCount: queue.getFailedTodayCount(),
    offlinePrinters: queue.getStats().offlinePrinters,
    printHistory: queue.getHistory(),
    lastError: lastConnectionError || queue.getLastError(),
    env: store.getEnv(),
    apiUrl: store.getApiUrl(),
    appUrl: store.getAppUrl(),
    printerLabelFormats: store.getAllPrinterLabelFormats(),
    printerZplConfigs: store.getAllPrinterZplConfigs(),
  };
}

function broadcastState(): void {
  mainWindow?.webContents.send(IPC.STATE_UPDATED, getAppState());
  updateTrayTooltip();
}

function updateTrayTooltip(): void {
  const pending = queue.getPendingCount();
  const status = socket.isConnected() ? 'Connecté' : 'Déconnecté';
  tray?.setToolTip(`${APP_NAME} — ${status} • ${pending} en attente`);
}

// Handle deep link (houla-print://callback?code=...)
function handleDeepLink(url: string): void {
  // Clear any previous session to prevent stale workspace data on account switch
  // This is critical: without it, workspaces from a previous account remain visible
  socket.disconnectAll();
  workspaces.clear();
  auth.logout();

  auth.handleOAuthCallback(url).then(async () => {
    try {
      await workspaces.refresh();
      clearConnectionError();
      socket.connectAll(workspaces.getActiveWorkspaces());
      queue.startPolling(workspaces.getActiveWorkspaces());
    } catch (err) {
      console.error('[Main] Post-OAuth workspace refresh failed:', (err as Error).message);
      setConnectionError(err);
      if (isNetworkError(err)) scheduleRetry();
    }
    broadcastState();
    mainWindow?.show();
    mainWindow?.focus();
  }).catch((err) => {
    console.error('OAuth callback error:', err);
    new Notification({
      title: APP_NAME,
      body: 'Erreur de connexion. Veuillez réessayer.',
    }).show();
  });
}

// ═══════════════════════════════════════════════════════
// App lifecycle
// ═══════════════════════════════════════════════════════

app.on('second-instance', (_e, argv) => {
  // Someone tried to run a second instance — focus ours instead
  mainWindow?.show();
  mainWindow?.focus();

  // Handle deep link from second instance (Windows)
  const deepLink = argv.find(arg => arg.startsWith(`${APP_PROTOCOL}://`));
  if (deepLink) handleDeepLink(deepLink);
});

app.on('open-url', (_e, url) => {
  // Handle deep link (macOS)
  handleDeepLink(url);
});

app.whenReady().then(async () => {
  console.log('[Main] App ready. Initializing...');

  // Auto-start on boot (production only)
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  }

  try {
    initServices();
    console.log('[Main] Services initialized.');
  } catch (err) {
    console.error('[Main] initServices failed:', err);
    return;
  }
  try {
    createWindow();
    console.log('[Main] Window created.');
  } catch (err) {
    console.error('[Main] createWindow failed:', err);
    return;
  }
  try {
    createTray();
    console.log('[Main] Tray created.');
  } catch (err) {
    console.error('[Main] createTray failed:', err);
  }
  registerIpcHandlers();
  console.log('[Main] IPC handlers registered.');

  // Initialize auto updater
  try {
    autoUpdater.checkForUpdatesAndNotify();
  } catch (err) {
    console.error('Failed to check for updates', err);
  }

  // Auto-detect printers
  try {
    await printer.detectPrinters();
    console.log('[Main] Printers detected.');
  } catch (err) {
    console.error('[Main] detectPrinters failed:', err);
  }

  // If already authenticated, auto-connect
  try {
    if (auth.isAuthenticated()) {
      await workspaces.refresh();
      clearConnectionError();
      socket.connectAll(workspaces.getActiveWorkspaces());
      queue.startPolling(workspaces.getActiveWorkspaces());
      await queue.fetchPendingFromApi(workspaces.getActiveWorkspaces());
      console.log('[Main] Auto-reconnected.');
    }
  } catch (err) {
    console.error('[Main] Auto-reconnect failed:', (err as Error).message);
    setConnectionError(err);
    if (isNetworkError(err)) scheduleRetry();
  }

  broadcastState();
  console.log('[Main] Init complete. App should stay running.');

  // Periodic printer detection (every 30s)
  setInterval(async () => {
    try { await printer.detectPrinters(); } catch { /* ignore */ }
  }, 30_000);
});

app.on('window-all-closed', () => {
  // Keep running in tray — don't quit
  console.log('[Main] window-all-closed event — ignoring, staying in tray.');
});

app.on('before-quit', () => {
  console.log('[Main] before-quit event.');
  socket.disconnectAll();
  queue.close();
});

process.on('exit', (code) => {
  console.log(`[Main] Process exiting with code: ${code}`);
});
