/**
 * NIIMBOT printer service — serial port communication.
 * Handles device discovery, connection, and print job sending.
 *
 * Supports USB and Bluetooth serial connections.
 */

import { SerialPort } from 'serialport';
import {
  NiimbotPacket,
  NiimbotCommand,
  NiimbotResponse,
  NiimbotLabelType,
  InfoCommand,
  NIIMBOT_PORT_PATTERNS,
  NIIMBOT_MODELS,
  DEFAULT_MODEL,
  NiimbotModelSpec,
  encodePacket,
  decodePackets,
  buildConnect,
  buildGetInfo,
  buildGetRfid,
  buildSetLabelType,
  buildSetDensity,
  buildStartPrint,
  buildEndPrint,
  buildSetQuantity,
  buildSetPageSize,
  buildStartPagePrint,
  buildEndPagePrint,
  buildHeartbeat,
  buildImageRow,
  buildGetPrintStatus,
} from './niimbot-protocol';

export interface NiimbotDeviceInfo {
  port: string;        // e.g. "COM3"
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  friendlyName?: string;
  modelName?: string;   // e.g. "Niimbot B1" — resolved after probing
}

export interface NiimbotPrintResult {
  success: boolean;
  error?: string;
}

// ═══════════════════════════════════════════════════════
// Niimbot Service
// ═══════════════════════════════════════════════════════

export class NiimbotService {
  private port: SerialPort | null = null;
  private rxBuffer = Buffer.alloc(0);
  private responsePromise: { resolve: (pkt: NiimbotPacket) => void; reject: (err: Error) => void } | null = null;
  private model: NiimbotModelSpec = DEFAULT_MODEL;
  private connected = false;
  /** True when connected via Bluetooth SPP (slower pacing needed) */
  private isBluetooth = false;
  /** Heartbeat interval to prevent printer from sleeping */
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  /** Mutex: true while a probe, connect, or print is actively using a serial port */
  private busy = false;
  /** Ports known to be dead (e.g. BT incoming port that always fails on write) */
  private deadPorts = new Set<string>();

  /**
   * List all serial ports that could be Niimbot printers.
   * Returns only immediately-identifiable devices (USB VID match, name patterns).
   * BT ports are NOT probed here — caller should use discoverFast() and probe async.
   */
  async discover(): Promise<NiimbotDeviceInfo[]> {
    const { immediate } = await this.discoverFast();
    return immediate;
  }

  /**
   * Fast discovery: returns USB-identified and BT Niimbot printers immediately.
   * No port is opened — identification is based on VID, name patterns, and BT metadata.
   */
  async discoverFast(): Promise<{ immediate: NiimbotDeviceInfo[]; pendingBtProbe: NiimbotDeviceInfo[] }> {
    const ports = await SerialPort.list();
    const immediate: NiimbotDeviceInfo[] = [];
    const pendingBtProbe: NiimbotDeviceInfo[] = []; // kept empty — no probing

    console.log(`[Niimbot] Serial ports found: ${ports.length}`);
    for (const p of ports) {
      const portAny = p as any;
      const friendly = portAny.friendlyName || '';
      const combined = `${p.path} ${p.manufacturer || ''} ${friendly} ${p.pnpId || ''}`;
      const matchesPattern = NIIMBOT_PORT_PATTERNS.some(pattern => pattern.test(combined));
      const matchesVid = !!(p.vendorId && p.vendorId.toLowerCase() === '3513');
      const isNiimbot = matchesPattern || matchesVid;
      const isBluetooth = /bluetooth/i.test(friendly) || /bluetooth/i.test(p.manufacturer || '');

      console.log(`[Niimbot]   ${p.path}: manufacturer=${p.manufacturer || '?'}, vid=${p.vendorId || '?'}, friendly=${friendly || '?'}, match=${isNiimbot}, bt=${isBluetooth}`);

      const info: NiimbotDeviceInfo = {
        port: p.path,
        manufacturer: p.manufacturer,
        serialNumber: p.serialNumber,
        vendorId: p.vendorId,
        productId: p.productId,
        friendlyName: friendly,
      };

      if (isNiimbot) {
        immediate.push(info);
      } else if (isBluetooth && !this.deadPorts.has(p.path)) {
        // Add BT ports as potential Niimbot printers without probing
        // Connection will happen only when user clicks Test or prints
        info.modelName = 'Niimbot (Bluetooth)';
        immediate.push(info);
      }
    }

    console.log(`[Niimbot] Discover: ${immediate.length} candidate(s), 0 to probe`);
    return { immediate, pendingBtProbe };
  }

  /**
   * List all available serial ports (for manual selection).
   */
  async listAllPorts(): Promise<NiimbotDeviceInfo[]> {
    const ports = await SerialPort.list();
    return ports.map(p => ({
      port: p.path,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
      vendorId: p.vendorId,
      productId: p.productId,
      friendlyName: (p as any).friendlyName,
    }));
  }

  /**
   * Connect to a Niimbot printer on the specified serial port.
   */
  async connect(portPath: string): Promise<void> {
    if (this.port?.isOpen) {
      await this.disconnect();
    }

    return new Promise((resolve, reject) => {
      this.port = new SerialPort({
        path: portPath,
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        autoOpen: false,
      });

      this.rxBuffer = Buffer.alloc(0);

      this.port.on('data', (chunk: Buffer) => {
        console.log(`[Niimbot] RX: ${chunk.toString('hex')}`);
        this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
        this.processReceivedData();
      });

      this.port.on('error', (err) => {
        console.error('[Niimbot] Serial error:', err.message);
        this.connected = false;
        this.stopHeartbeat();
      });

      this.port.on('close', () => {
        console.log('[Niimbot] Port closed.');
        this.connected = false;
        this.stopHeartbeat();
      });

      this.busy = true;
      this.port.open(async (err) => {
        if (err) {
          this.busy = false;
          reject(new Error(`Cannot open port ${portPath}: ${err.message}`));
          return;
        }

        console.log(`[Niimbot] Port ${portPath} opened.`);

        try {
          // Detect if this is a Bluetooth connection (port name or metadata)
          const portInfo = (await SerialPort.list()).find(p => p.path === portPath);
          const portAny = portInfo as any;
          const friendly = portAny?.friendlyName || '';
          this.isBluetooth = /bluetooth/i.test(friendly) || /bluetooth/i.test(portInfo?.manufacturer || '');

          // BT SPP needs 2s to establish; USB is near-instant
          const settleMs = this.isBluetooth ? 2000 : 200;
          console.log(`[Niimbot] Connection type: ${this.isBluetooth ? 'Bluetooth' : 'USB'}, settle=${settleMs}ms`);
          await new Promise(r => setTimeout(r, settleMs));

          const connectPkt = buildConnect();
          console.log(`[Niimbot] Sending CONNECT: ${connectPkt.toString('hex')}`);

          // Send CONNECT command and wait for ACK
          await this.sendAndWait(connectPkt, NiimbotResponse.CONNECT_ACK, 5000);
          this.connected = true;
          this.startHeartbeat();
          console.log('[Niimbot] Connected to printer.');
          resolve();
        } catch (connErr: any) {
          this.busy = false;
          this.port?.close();
          reject(new Error(`Niimbot handshake failed: ${connErr.message}`));
        }
      });
    });
  }

  /**
   * Disconnect from the printer.
   */
  async disconnect(): Promise<void> {
    this.stopHeartbeat();
    this.connected = false;
    this.busy = false;
    if (!this.port?.isOpen) return;

    return new Promise((resolve) => {
      this.port!.close(() => {
        this.port = null;
        resolve();
      });
    });
  }

  isConnected(): boolean {
    return this.connected && (this.port?.isOpen ?? false);
  }

  /**
   * Start periodic heartbeat to prevent printer from entering sleep mode.
   * Sends a heartbeat command every 30 seconds.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(async () => {
      if (!this.isConnected() || this.busy) return;
      try {
        const pkt = buildHeartbeat();
        this.port!.write(pkt);
      } catch (err: any) {
        console.warn(`[Niimbot] Heartbeat failed: ${err.message}`);
      }
    }, 30_000);
  }

  /**
   * Stop the heartbeat timer.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Get printer info (battery, serial, version).
   */
  async getBattery(): Promise<number> {
    const pkt = await this.sendAndWait(buildGetInfo(InfoCommand.BATTERY), NiimbotResponse.GET_INFO_ACK, 3000);
    return pkt.data.length > 0 ? pkt.data[pkt.data.length - 1] : -1;
  }

  async getSerialNumber(): Promise<string> {
    const pkt = await this.sendAndWait(buildGetInfo(InfoCommand.SERIAL_NUMBER), NiimbotResponse.GET_INFO_ACK, 3000);
    return pkt.data.toString('ascii');
  }

  /**
   * Get the print head width in dots. Helps identify the model.
   */
  async getAreaWidth(): Promise<number> {
    try {
      const pkt = await this.sendAndWait(buildGetInfo(InfoCommand.AREA_WIDTH), NiimbotResponse.GET_INFO_ACK, 3000);
      if (pkt.data.length >= 2) {
        return pkt.data.readUInt16BE(0);
      }
      return pkt.data.length > 0 ? pkt.data[0] : -1;
    } catch {
      return -1;
    }
  }

  /**
   * Probe the connected printer to identify its model.
   * Connects briefly, reads area width, and matches to known models.
   */
  async probeModel(portPath: string): Promise<{
    modelName: string;
    widthDots: number;
    detectedLabel?: { widthMm: number; heightMm: number; remaining: number; barCode: string };
  }> {
    const wasConnected = this.isConnected();
    try {
      if (!wasConnected) {
        await this.connect(portPath);
      }
      const widthDots = await this.getAreaWidth();
      let modelName = 'Niimbot';

      if (widthDots > 0) {
        // Match width to known models
        for (const [, spec] of Object.entries(NIIMBOT_MODELS)) {
          if (spec.printWidthDots === widthDots) {
            modelName = spec.name;
            break;
          }
        }
        if (modelName === 'Niimbot') {
          modelName = `Niimbot (${widthDots}dots)`;
        }
      }

      // Try RFID label detection
      const detectedLabel = await this.readRfidLabel() ?? undefined;

      return { modelName, widthDots, detectedLabel };
    } catch {
      return { modelName: 'Niimbot', widthDots: -1 };
    } finally {
      if (!wasConnected) {
        await this.disconnect().catch(() => {});
      }
    }
  }

  /**
   * Read RFID data from the loaded label roll.
   *
   * NiimBlue RFID response format (cmd 0x1b):
   *   [uuid (8 bytes)] [barCode (VString)] [serialNumber (VString)]
   *   [allPaper (u16BE)] [usedPaper (u16BE)] [consumablesType (u8)]
   *   [capacity (u16BE, optional)]
   *
   * The barCode is an opaque label identifier. The official Niimbot app sends
   * it to their cloud API to resolve label dimensions. We try the same API,
   * and fall back to null if it's unavailable.
   */
  async readRfidLabel(): Promise<{
    widthMm: number; heightMm: number; remaining: number;
    barCode: string; serialNumber: string; uuid: string;
  } | null> {
    try {
      const pkt = await this.sendAndWait(
        buildGetRfid(),
        NiimbotResponse.GET_RFID_ACK,
        3000,
      );

      // Single-byte response means no RFID tag
      if (!pkt.data || pkt.data.length <= 1) return null;

      const d = pkt.data;
      console.log(`[Niimbot] RFID raw (${d.length} bytes): ${d.toString('hex')}`);

      // Parse using NiimBlue's format: UUID(8) + VString(barCode) + VString(serial) + allPaper(2) + usedPaper(2) + consumablesType(1)
      let offset = 0;

      // UUID: 8 bytes
      if (d.length < 8) return null;
      const uuid = d.subarray(0, 8).toString('hex');
      offset = 8;

      // barCode: VString (1 byte length + N bytes)
      if (offset >= d.length) return null;
      const barCodeLen = d[offset++];
      if (offset + barCodeLen > d.length) return null;
      const barCode = d.subarray(offset, offset + barCodeLen).toString('ascii');
      offset += barCodeLen;

      // serialNumber: VString (1 byte length + N bytes)
      if (offset >= d.length) return null;
      const serialLen = d[offset++];
      if (offset + serialLen > d.length) return null;
      const serialNumber = d.subarray(offset, offset + serialLen).toString('ascii');
      offset += serialLen;

      // allPaper (u16BE) — total labels on roll
      let allPaper = -1;
      if (offset + 2 <= d.length) {
        allPaper = (d[offset] << 8) | d[offset + 1];
        offset += 2;
      }

      // usedPaper (u16BE) — used labels
      let usedPaper = -1;
      if (offset + 2 <= d.length) {
        usedPaper = (d[offset] << 8) | d[offset + 1];
        offset += 2;
      }

      // consumablesType (u8)
      let consumablesType = -1;
      if (offset < d.length) {
        consumablesType = d[offset++];
      }

      const remaining = allPaper >= 0 && usedPaper >= 0 ? allPaper - usedPaper : -1;

      console.log(`[Niimbot] RFID parsed: uuid=${uuid}, barCode=${barCode}, serial=${serialNumber}, allPaper=${allPaper}, usedPaper=${usedPaper}, type=${consumablesType}, remaining=${remaining}`);

      if (!barCode) return null;

      // Try to resolve label dimensions via Niimbot cloud API
      const dims = await this.resolveBarcodeDimensions(barCode);
      if (dims) {
        console.log(`[Niimbot] Cloud API resolved barCode ${barCode} → ${dims.widthMm}x${dims.heightMm}mm`);
        return { widthMm: dims.widthMm, heightMm: dims.heightMm, remaining, barCode, serialNumber, uuid };
      }

      console.log(`[Niimbot] Cloud API did not resolve barCode ${barCode}, dimensions unknown`);
      return null;
    } catch (err: any) {
      console.log(`[Niimbot] RFID read failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Try to resolve label dimensions from the Niimbot cloud API using the barCode.
   * This is the same API the official Niimbot app uses to get label parameters.
   * Returns null on any failure (network, timeout, unexpected format).
   */
  private async resolveBarcodeDimensions(barCode: string): Promise<{ widthMm: number; heightMm: number } | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const resp = await fetch('https://print.niimbot.com/api/template/getCloudTemplateByOneCode', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'niimbot-user-agent': 'AppVersionName/999.0.0',
        },
        body: JSON.stringify({ oneCode: barCode }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        console.log(`[Niimbot] Cloud API HTTP ${resp.status}`);
        return null;
      }

      const json: any = await resp.json();
      console.log(`[Niimbot] Cloud API response: ${JSON.stringify(json).substring(0, 500)}`);

      // The API response format contains label dimensions — extract them
      // Known fields: width, height (in mm) inside the response data
      // IMPORTANT: the API may return a "rotate" field (0, 90, 270).
      // When rotate=90 or rotate=270, the dimensions are in template orientation
      // and must be swapped to get the physical label dimensions in the printer.
      const data = json?.data;
      if (data) {
        let widthMm = data.width || data.labelWidth || data.paperWidth;
        let heightMm = data.height || data.labelHeight || data.paperHeight;
        if (widthMm > 0 && heightMm > 0) {
          const rotate = data.rotate || 0;
          if (rotate === 90 || rotate === 270) {
            console.log(`[Niimbot] Cloud API rotate=${rotate}, swapping ${widthMm}x${heightMm} → ${heightMm}x${widthMm}`);
            [widthMm, heightMm] = [heightMm, widthMm];
          }
          return { widthMm, heightMm };
        }
      }

      return null;
    } catch (err: any) {
      console.log(`[Niimbot] Cloud API failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Print a monochrome bitmap on the Niimbot printer.
   *
   * @param bitmap - Packed 1-bit bitmap (MSB first, 8 pixels per byte)
   * @param widthDots - Width in dots (must match printer width, typically 384 for B1)
   * @param heightDots - Height in dots
   * @param density - Print density 1-5 (default 3)
   * @param labelType - Label type (default GAP for die-cut)
   * @param quantity - Number of copies (default 1)
   */
  async printBitmap(
    bitmap: Buffer,
    widthDots: number,
    heightDots: number,
    density = 3,
    labelType: NiimbotLabelType = NiimbotLabelType.GAP,
    quantity = 1,
  ): Promise<NiimbotPrintResult> {
    if (!this.isConnected()) {
      return { success: false, error: 'Imprimante non connectée' };
    }

    const bytesPerRow = Math.ceil(widthDots / 8);

    try {
      const t0 = Date.now();
      // B1 print task sequence (from NiimBlue official docs)
      // Init phase
      await this.sendAndWait(buildSetDensity(density), NiimbotResponse.SET_LABEL_DENSITY_ACK, 3000);
      await this.sendAndWait(buildSetLabelType(labelType), NiimbotResponse.SET_LABEL_TYPE_ACK, 3000);
      await this.sendAndWait(buildStartPrint(quantity), NiimbotResponse.START_PRINT_ACK, 5000);
      const tInit = Date.now();

      // Page phase
      await this.sendAndWait(buildStartPagePrint(), NiimbotResponse.START_PAGE_ACK, 3000);
      await this.sendAndWait(buildSetPageSize(heightDots, widthDots, quantity), NiimbotResponse.SET_PAGE_SIZE_ACK, 3000);

      // Image data — one-way packets, no ACK expected per NiimBlue protocol
      for (let row = 0; row < heightDots; row++) {
        const rowStart = row * bytesPerRow;
        const rowData = bitmap.subarray(rowStart, rowStart + bytesPerRow);
        const paddedRow = rowData.length < bytesPerRow
          ? Buffer.concat([rowData, Buffer.alloc(bytesPerRow - rowData.length)])
          : rowData;
        await this.sendRow(buildImageRow(row, paddedRow));
      }
      const tImage = Date.now();

      // End page
      await this.sendAndWait(buildEndPagePrint(), NiimbotResponse.END_PAGE_ACK, 10000);
      const tEndPage = Date.now();

      // Poll print status until printer confirms page is done
      await this.waitForPrintComplete();
      const tPoll = Date.now();

      // End print session
      await this.sendAndWait(buildEndPrint(), NiimbotResponse.END_PRINT_ACK, 5000);
      const tEnd = Date.now();

      console.log(`[Niimbot] Print complete: ${widthDots}x${heightDots} dots — init:${tInit - t0}ms image:${tImage - tInit}ms endPage:${tEndPage - tImage}ms poll:${tPoll - tEndPage}ms end:${tEnd - tPoll}ms TOTAL:${tEnd - t0}ms`);
      return { success: true };
    } catch (err: any) {
      console.error('[Niimbot] Print failed:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Print multiple DIFFERENT bitmaps as fast sequential individual prints.
   * Each label gets its own START_PRINT(1)→END_PRINT cycle so the printer
   * fully ejects each label (user can tear it off). But we skip redundant
   * SET_DENSITY and SET_LABEL_TYPE for labels 2+ since the printer retains
   * these settings across print sessions.
   *
   * Returns per-page results so the caller can ACK successful pages individually.
   */
  async printBitmapSequence(
    pages: Array<{ bitmap: Buffer; widthDots: number; heightDots: number }>,
    density = 3,
    labelType: NiimbotLabelType = NiimbotLabelType.GAP,
  ): Promise<{ results: NiimbotPrintResult[]; totalPrinted: number }> {
    if (!this.isConnected()) {
      return {
        results: pages.map(() => ({ success: false, error: 'Imprimante non connectée' })),
        totalPrinted: 0,
      };
    }

    if (pages.length === 0) {
      return { results: [], totalPrinted: 0 };
    }

    // Single page — delegate to standard method
    if (pages.length === 1) {
      const r = await this.printBitmap(pages[0].bitmap, pages[0].widthDots, pages[0].heightDots, density, labelType);
      return { results: [r], totalPrinted: r.success ? 1 : 0 };
    }

    const results: NiimbotPrintResult[] = [];
    let totalPrinted = 0;
    const sessionStart = Date.now();

    console.log(`[Niimbot] Sequence print: ${pages.length} labels`);

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const bytesPerRow = Math.ceil(page.widthDots / 8);
      const pageStart = Date.now();

      try {
        // Init — only send density/labelType for the FIRST label (printer retains settings)
        if (i === 0) {
          await this.sendAndWait(buildSetDensity(density), NiimbotResponse.SET_LABEL_DENSITY_ACK, 3000);
          await this.sendAndWait(buildSetLabelType(labelType), NiimbotResponse.SET_LABEL_TYPE_ACK, 3000);
        }
        await this.sendAndWait(buildStartPrint(1), NiimbotResponse.START_PRINT_ACK, 5000);

        // Page
        await this.sendAndWait(buildStartPagePrint(), NiimbotResponse.START_PAGE_ACK, 3000);
        await this.sendAndWait(
          buildSetPageSize(page.heightDots, page.widthDots, 1),
          NiimbotResponse.SET_PAGE_SIZE_ACK,
          3000,
        );

        // Image data (one-way, no ACK)
        for (let row = 0; row < page.heightDots; row++) {
          const rowStart = row * bytesPerRow;
          const rowData = page.bitmap.subarray(rowStart, rowStart + bytesPerRow);
          const paddedRow = rowData.length < bytesPerRow
            ? Buffer.concat([rowData, Buffer.alloc(bytesPerRow - rowData.length)])
            : rowData;
          await this.sendRow(buildImageRow(row, paddedRow));
        }
        const tImage = Date.now();

        // End page + poll + end session
        await this.sendAndWait(buildEndPagePrint(), NiimbotResponse.END_PAGE_ACK, 10000);
        const tEndPage = Date.now();

        await this.waitForPrintComplete();
        const tPoll = Date.now();

        await this.sendAndWait(buildEndPrint(), NiimbotResponse.END_PRINT_ACK, 5000);
        const tEnd = Date.now();

        results.push({ success: true });
        totalPrinted++;
        console.log(`[Niimbot] Label ${i + 1}/${pages.length} — image:${tImage - pageStart}ms endPage:${tEndPage - tImage}ms poll:${tPoll - tEndPage}ms end:${tEnd - tPoll}ms total:${tEnd - pageStart}ms`);
      } catch (err: any) {
        console.error(`[Niimbot] Label ${i + 1}/${pages.length} failed: ${err.message}`);
        results.push({ success: false, error: err.message });
        // Try to clean up the session
        try { await this.sendAndWait(buildEndPrint(), NiimbotResponse.END_PRINT_ACK, 3000); } catch { /* ignore */ }
        // Stop batch on failure
        for (let j = i + 1; j < pages.length; j++) {
          results.push({ success: false, error: 'Skipped after previous label failure' });
        }
        break;
      }
    }

    console.log(`[Niimbot] Sequence complete: ${totalPrinted}/${pages.length} labels in ${Date.now() - sessionStart}ms`);
    return { results, totalPrinted };
  }

  /**
   * Send a test label (small "Hou.la Print" text).
   * Auto-detects label dimensions via RFID + Niimbot cloud API if available.
   * Width always = print head width.
   */
  async testPrint(): Promise<NiimbotPrintResult> {
    const DPI = 8; // dots per mm for 203 DPI printers

    // Width always matches the print head (384 dots for B1)
    const w = this.model.printWidthDots;
    let h = 240; // default fallback (~30mm)
    let detectedLabel: { widthMm: number; heightMm: number; remaining: number } | null = null;

    // Try RFID + cloud API auto-detect for label dimensions
    const rfid = await this.readRfidLabel();
    if (rfid && rfid.heightMm > 0) {
      h = rfid.heightMm * DPI;
      detectedLabel = rfid;
      console.log(`[Niimbot] Label detected: ${rfid.widthMm}x${rfid.heightMm}mm → ${w}x${h} dots (barCode=${rfid.barCode}, remaining=${rfid.remaining})`);
    } else {
      console.log(`[Niimbot] No label dimensions detected, using defaults: ${w}x${h} dots`);
    }
    const bytesPerRow = Math.ceil(w / 8);
    const bitmap = Buffer.alloc(bytesPerRow * h, 0x00); // all white

    // Draw a simple border (top, bottom, left, right lines)
    for (let x = 0; x < w; x++) {
      setBit(bitmap, bytesPerRow, 0, x);             // top line
      setBit(bitmap, bytesPerRow, 1, x);
      setBit(bitmap, bytesPerRow, h - 1, x);         // bottom line
      setBit(bitmap, bytesPerRow, h - 2, x);
    }
    for (let y = 0; y < h; y++) {
      setBit(bitmap, bytesPerRow, y, 0);              // left line
      setBit(bitmap, bytesPerRow, y, 1);
      setBit(bitmap, bytesPerRow, y, w - 1);          // right line
      setBit(bitmap, bytesPerRow, y, w - 2);
    }

    // Draw "Hou.la Print TEST" centered — compute max scale that fits the width
    const testText = 'Hou.la Print TEST';
    const maxScaleW = Math.floor((w - 20) / (testText.length * 6));  // 6px per char at scale 1
    const maxScaleH = Math.floor((h - 20) / 8);                     // 8px per char height at scale 1
    const scale = Math.max(1, Math.min(maxScaleW, maxScaleH));
    const testPattern = renderTextSimple(testText, scale);
    const textStartX = Math.floor((w - testPattern.width) / 2);
    const textStartY = Math.floor((h - testPattern.height) / 2);
    overlayBitmap(bitmap, bytesPerRow, testPattern, textStartX, textStartY);

    const result = await this.printBitmap(bitmap, w, h);
    // Attach detected label info for the caller to use
    if (detectedLabel) {
      (result as any).detectedLabel = detectedLabel;
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════
  // Internal: serial communication
  // ═══════════════════════════════════════════════════════

  /**
   * Poll GET_PRINT_STATUS until the printer reports page completion.
   * NiimBlue reference: after END_PAGE, poll 0xA3 until status == 1 (done).
   * Status 0 = in progress, 1 = done, other = error/unknown.
   */
  /**
   * Attend la confirmation PHYSIQUE de sortie d'une étiquette.
   *
   * ⚠️ Cette fonction décidait auparavant « tant pis, on continue » à l'expiration
   * du délai : la page était alors déclarée imprimée, acquittée `printed` côté
   * serveur et comptée dans les stats — alors que rien n'était sorti. C'est le
   * SEUL mécanisme qui peut produire des trous NON contigus au milieu d'un lot
   * (constaté en prod : « 1/4 et 4/4 sorties, 2/4 et 3/4 jamais vues », les 4
   * étant `printed` en base). Une panne franche, elle, tue toujours une FIN de
   * lot, jamais son milieu.
   *
   * Un trou silencieux vaut un colis faux ; une étiquette en double se jette.
   * On préfère donc lever une erreur — classée transitoire par `isTransientError`
   * (« timeout waiting »), donc réessayée avec backoff au lieu d'être perdue.
   *
   * Nuance importante : une imprimante qui répond « j'imprime encore » (status 0)
   * n'est PAS en panne, elle est lente (gros visuel, batterie faible, Bluetooth).
   * Tant qu'elle répond, on prolonge jusqu'à `hardCapMs` au lieu de la déclarer
   * morte — c'est ce qui évite de transformer une lenteur en rafale de doublons.
   */
  private async waitForPrintComplete(timeoutMs = 10000, hardCapMs = 30000): Promise<void> {
    const startTime = Date.now();
    const hardDeadline = startTime + hardCapMs;
    let deadline = startTime + timeoutMs;
    let polls = 0;
    let printerAnswered = false;

    while (Date.now() < deadline) {
      polls++;
      try {
        const pkt = await this.sendAndWait(
          buildGetPrintStatus(),
          NiimbotResponse.PRINT_STATUS_ACK,
          3000,
        );
        const status = pkt.data.length > 0 ? pkt.data[0] : -1;
        console.log(`[Niimbot] Print status poll #${polls}: cmd=0x${pkt.command.toString(16)}, status=${status}, data=${pkt.data.toString('hex')}`);

        if (status === 1) {
          console.log(`[Niimbot] Printer reports page complete (${polls} polls, ${Date.now() - startTime}ms).`);
          return;
        }
        if (status === 0) {
          // Toujours en cours : l'imprimante est vivante, on lui laisse du temps.
          printerAnswered = true;
          deadline = Math.min(Date.now() + timeoutMs, hardDeadline);
          continue;
        }
        // Unknown status — brief pause before retry
        printerAnswered = true;
        await new Promise(r => setTimeout(r, 30));
      } catch (err: any) {
        console.warn(`[Niimbot] Print status poll error: ${err.message}`);
        // Timeout on individual poll — retry
        await new Promise(r => setTimeout(r, 100));
      }
    }

    const waited = Date.now() - startTime;
    console.error(
      `[Niimbot] Aucune confirmation de sortie après ${polls} sondages (${waited}ms, imprimante ${printerAnswered ? 'répondante' : 'muette'}) — étiquette considérée NON imprimée`,
    );
    throw new Error(`Timeout waiting for print completion after ${waited}ms`);
  }

  private send(data: Buffer): void {
    if (!this.port?.isOpen) throw new Error('Port not open');
    this.port.write(data);
    // Flush the OS buffer — critical for BT SPP where data can sit in buffer
    this.port.drain(() => {});
  }

  /**
   * Send image row data and await drain (no ACK expected).
   * Includes a small delay for printer buffer pacing.
   */
  private sendRow(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.port?.isOpen) { reject(new Error('Port not open')); return; }
      this.port.write(data, (writeErr) => {
        if (writeErr) { reject(writeErr); return; }
        this.port!.drain((drainErr) => {
          if (drainErr) { reject(drainErr); return; }
          // BT needs pacing (20ms) to avoid buffer overflow; USB drain() is enough (3ms safety)
          setTimeout(resolve, this.isBluetooth ? 20 : 3);
        });
      });
    });
  }

  private sendAndWait(data: Buffer, expectedResponseCmd: number, timeoutMs: number): Promise<NiimbotPacket> {
    return new Promise((resolve, reject) => {
      const reqCmd = data[2]; // command byte from the sent packet

      const timer = setTimeout(() => {
        this.responsePromise = null;
        reject(new Error(`Timeout waiting for response (cmd=0x${reqCmd.toString(16)})`));
      }, timeoutMs);

      // Accept any valid response from the printer.
      // Niimbot B1 uses non-standard ACK codes (sometimes CMD+1, sometimes CMD+0x10,
      // sometimes 0x00, sometimes completely different like 0xDB). The protocol is
      // strictly request/response so the next packet is always the answer.
      this.responsePromise = {
        resolve: (pkt: NiimbotPacket) => {
          clearTimeout(timer);
          this.responsePromise = null;
          console.log(`[Niimbot] ACK cmd=0x${pkt.command.toString(16)} data=${pkt.data.toString('hex')} for TX 0x${reqCmd.toString(16)}`);
          resolve(pkt);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          this.responsePromise = null;
          reject(err);
        },
      };

      console.log(`[Niimbot] TX cmd=0x${reqCmd.toString(16)} (${data.length}B)`);
      this.send(data);
    });
  }

  private processReceivedData(): void {
    const { packets, remainder } = decodePackets(this.rxBuffer);
    this.rxBuffer = Buffer.from(remainder);

    for (const pkt of packets) {
      if (this.responsePromise) {
        this.responsePromise.resolve(pkt);
      } else {
        // Unsolicited packet (e.g. status update)
        console.log(`[Niimbot] Unsolicited packet: cmd=0x${pkt.command.toString(16)}, data=${pkt.data.toString('hex')}`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════
// Simple bitmap text rendering (no external deps)
// ═══════════════════════════════════════════════════════

interface SimpleBitmap {
  data: Buffer;
  width: number;
  height: number;
  bytesPerRow: number;
}

/** Set a single bit (black pixel) in a packed 1-bit bitmap */
function setBit(bitmap: Buffer, bytesPerRow: number, row: number, col: number): void {
  const byteIdx = row * bytesPerRow + Math.floor(col / 8);
  const bitIdx = 7 - (col % 8); // MSB first
  if (byteIdx < bitmap.length) {
    bitmap[byteIdx] |= (1 << bitIdx);
  }
}

/**
 * Render text as a simple bitmap using a built-in 5×7 pixel font.
 * Returns a packed 1-bit bitmap.
 */
function renderTextSimple(text: string, scale = 1): SimpleBitmap {
  const charW = 6 * scale; // 5 pixels + 1 gap, scaled
  const charH = 8 * scale; // 7 pixels + 1 gap, scaled
  const width = text.length * charW;
  const height = charH;
  const bytesPerRow = Math.ceil(width / 8);
  const data = Buffer.alloc(bytesPerRow * height, 0x00);

  for (let i = 0; i < text.length; i++) {
    const glyph = FONT_5X7[text.charCodeAt(i)] || FONT_5X7[0x3f]; // '?' for unknown
    if (!glyph) continue;

    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy] & (1 << (4 - gx))) {
          // Scale the pixel
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const px = i * charW + gx * scale + sx;
              const py = gy * scale + sy;
              setBit(data, bytesPerRow, py, px);
            }
          }
        }
      }
    }
  }

  return { data, width, height, bytesPerRow };
}

/** Overlay a small bitmap onto a larger one at position (ox, oy) */
function overlayBitmap(
  target: Buffer, targetBytesPerRow: number,
  src: SimpleBitmap, ox: number, oy: number,
): void {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const srcByteIdx = y * src.bytesPerRow + Math.floor(x / 8);
      const srcBitIdx = 7 - (x % 8);
      if (src.data[srcByteIdx] & (1 << srcBitIdx)) {
        setBit(target, targetBytesPerRow, oy + y, ox + x);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════
// 5×7 bitmap font (ASCII 32–126)
// Each glyph: 7 rows, each row encodes 5 pixels in bits 4..0
// ═══════════════════════════════════════════════════════

const FONT_5X7: Record<number, number[]> = {
  0x20: [0x00,0x00,0x00,0x00,0x00,0x00,0x00], // space
  0x21: [0x04,0x04,0x04,0x04,0x04,0x00,0x04], // !
  0x22: [0x0a,0x0a,0x00,0x00,0x00,0x00,0x00], // "
  0x23: [0x0a,0x1f,0x0a,0x0a,0x1f,0x0a,0x00], // #
  0x27: [0x04,0x04,0x00,0x00,0x00,0x00,0x00], // '
  0x28: [0x02,0x04,0x08,0x08,0x08,0x04,0x02], // (
  0x29: [0x08,0x04,0x02,0x02,0x02,0x04,0x08], // )
  0x2a: [0x00,0x0a,0x04,0x1f,0x04,0x0a,0x00], // *
  0x2b: [0x00,0x04,0x04,0x1f,0x04,0x04,0x00], // +
  0x2c: [0x00,0x00,0x00,0x00,0x00,0x04,0x08], // ,
  0x2d: [0x00,0x00,0x00,0x1f,0x00,0x00,0x00], // -
  0x2e: [0x00,0x00,0x00,0x00,0x00,0x00,0x04], // .
  0x2f: [0x01,0x02,0x04,0x04,0x08,0x10,0x00], // /
  0x30: [0x0e,0x11,0x13,0x15,0x19,0x11,0x0e], // 0
  0x31: [0x04,0x0c,0x04,0x04,0x04,0x04,0x0e], // 1
  0x32: [0x0e,0x11,0x01,0x06,0x08,0x10,0x1f], // 2
  0x33: [0x0e,0x11,0x01,0x06,0x01,0x11,0x0e], // 3
  0x34: [0x02,0x06,0x0a,0x12,0x1f,0x02,0x02], // 4
  0x35: [0x1f,0x10,0x1e,0x01,0x01,0x11,0x0e], // 5
  0x36: [0x06,0x08,0x10,0x1e,0x11,0x11,0x0e], // 6
  0x37: [0x1f,0x01,0x02,0x04,0x08,0x08,0x08], // 7
  0x38: [0x0e,0x11,0x11,0x0e,0x11,0x11,0x0e], // 8
  0x39: [0x0e,0x11,0x11,0x0f,0x01,0x02,0x0c], // 9
  0x3a: [0x00,0x00,0x04,0x00,0x04,0x00,0x00], // :
  0x3f: [0x0e,0x11,0x01,0x02,0x04,0x00,0x04], // ?
  0x40: [0x0e,0x11,0x17,0x15,0x17,0x10,0x0e], // @
  // Uppercase letters
  0x41: [0x0e,0x11,0x11,0x1f,0x11,0x11,0x11], // A
  0x42: [0x1e,0x11,0x11,0x1e,0x11,0x11,0x1e], // B
  0x43: [0x0e,0x11,0x10,0x10,0x10,0x11,0x0e], // C
  0x44: [0x1e,0x11,0x11,0x11,0x11,0x11,0x1e], // D
  0x45: [0x1f,0x10,0x10,0x1e,0x10,0x10,0x1f], // E
  0x46: [0x1f,0x10,0x10,0x1e,0x10,0x10,0x10], // F
  0x47: [0x0e,0x11,0x10,0x17,0x11,0x11,0x0e], // G
  0x48: [0x11,0x11,0x11,0x1f,0x11,0x11,0x11], // H
  0x49: [0x0e,0x04,0x04,0x04,0x04,0x04,0x0e], // I
  0x4a: [0x07,0x02,0x02,0x02,0x02,0x12,0x0c], // J
  0x4b: [0x11,0x12,0x14,0x18,0x14,0x12,0x11], // K
  0x4c: [0x10,0x10,0x10,0x10,0x10,0x10,0x1f], // L
  0x4d: [0x11,0x1b,0x15,0x11,0x11,0x11,0x11], // M
  0x4e: [0x11,0x19,0x15,0x13,0x11,0x11,0x11], // N
  0x4f: [0x0e,0x11,0x11,0x11,0x11,0x11,0x0e], // O
  0x50: [0x1e,0x11,0x11,0x1e,0x10,0x10,0x10], // P
  0x51: [0x0e,0x11,0x11,0x11,0x15,0x12,0x0d], // Q
  0x52: [0x1e,0x11,0x11,0x1e,0x14,0x12,0x11], // R
  0x53: [0x0e,0x11,0x10,0x0e,0x01,0x11,0x0e], // S
  0x54: [0x1f,0x04,0x04,0x04,0x04,0x04,0x04], // T
  0x55: [0x11,0x11,0x11,0x11,0x11,0x11,0x0e], // U
  0x56: [0x11,0x11,0x11,0x0a,0x0a,0x04,0x04], // V
  0x57: [0x11,0x11,0x11,0x15,0x15,0x1b,0x11], // W
  0x58: [0x11,0x11,0x0a,0x04,0x0a,0x11,0x11], // X
  0x59: [0x11,0x11,0x0a,0x04,0x04,0x04,0x04], // Y
  0x5a: [0x1f,0x01,0x02,0x04,0x08,0x10,0x1f], // Z
  // Lowercase letters
  0x61: [0x00,0x00,0x0e,0x01,0x0f,0x11,0x0f], // a
  0x62: [0x10,0x10,0x1e,0x11,0x11,0x11,0x1e], // b
  0x63: [0x00,0x00,0x0e,0x11,0x10,0x11,0x0e], // c
  0x64: [0x01,0x01,0x0f,0x11,0x11,0x11,0x0f], // d
  0x65: [0x00,0x00,0x0e,0x11,0x1f,0x10,0x0e], // e
  0x66: [0x06,0x09,0x08,0x1e,0x08,0x08,0x08], // f
  0x67: [0x00,0x00,0x0f,0x11,0x0f,0x01,0x0e], // g
  0x68: [0x10,0x10,0x16,0x19,0x11,0x11,0x11], // h
  0x69: [0x04,0x00,0x0c,0x04,0x04,0x04,0x0e], // i
  0x6a: [0x02,0x00,0x06,0x02,0x02,0x12,0x0c], // j
  0x6b: [0x10,0x10,0x12,0x14,0x18,0x14,0x12], // k
  0x6c: [0x0c,0x04,0x04,0x04,0x04,0x04,0x0e], // l
  0x6d: [0x00,0x00,0x1a,0x15,0x15,0x11,0x11], // m
  0x6e: [0x00,0x00,0x16,0x19,0x11,0x11,0x11], // n
  0x6f: [0x00,0x00,0x0e,0x11,0x11,0x11,0x0e], // o
  0x70: [0x00,0x00,0x1e,0x11,0x1e,0x10,0x10], // p
  0x71: [0x00,0x00,0x0f,0x11,0x0f,0x01,0x01], // q
  0x72: [0x00,0x00,0x16,0x19,0x10,0x10,0x10], // r
  0x73: [0x00,0x00,0x0e,0x10,0x0e,0x01,0x1e], // s
  0x74: [0x08,0x08,0x1e,0x08,0x08,0x09,0x06], // t
  0x75: [0x00,0x00,0x11,0x11,0x11,0x13,0x0d], // u
  0x76: [0x00,0x00,0x11,0x11,0x0a,0x0a,0x04], // v
  0x77: [0x00,0x00,0x11,0x11,0x15,0x15,0x0a], // w
  0x78: [0x00,0x00,0x11,0x0a,0x04,0x0a,0x11], // x
  0x79: [0x00,0x00,0x11,0x11,0x0f,0x01,0x0e], // y
  0x7a: [0x00,0x00,0x1f,0x02,0x04,0x08,0x1f], // z
};
