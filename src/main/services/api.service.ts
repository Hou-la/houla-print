import { StoreService } from './store.service';
import { PrintJob, PrintConfig, Workspace } from '../../shared/types';
import { OAUTH_CLIENT_ID, APP_PROTOCOL } from '../../shared/config';

/**
 * HTTP client for the Hou.la API.
 * Uses the stored access token (JWT) for user-level endpoints
 * and API keys for workspace-level print endpoints.
 */
export class ApiService {
  constructor(private store: StoreService) {}

  // ═══════════════════════════════════════════════════════
  // User-level endpoints (JWT auth)
  // ═══════════════════════════════════════════════════════

  async getWorkspaces(): Promise<Workspace[]> {
    const res = await this.fetchWithAuth('GET', '/api/workspaces');
    return res.data || res;
  }

  async createApiKey(workspaceId: string): Promise<{ key: string; id: string }> {
    return this.fetchWithAuth('POST', '/api/keys', {
      name: 'Hou.la Print',
      workspaceId,
      type: 'internal',
    }, { 'X-Workspace-Id': workspaceId });
  }

  // ═══════════════════════════════════════════════════════
  // Print endpoints (API Key auth)
  // ═══════════════════════════════════════════════════════

  async getPrintConfig(apiKey: string): Promise<PrintConfig> {
    return this.fetchWithApiKey('GET', '/api/print/config', apiKey);
  }

  async updatePrintConfig(apiKey: string, config: Partial<PrintConfig>): Promise<PrintConfig> {
    return this.fetchWithApiKey('PATCH', '/api/print/config', apiKey, config);
  }

  async getPendingJobs(apiKey: string): Promise<PrintJob[]> {
    const res = await this.fetchWithApiKey('GET', '/api/print/jobs?status=pending', apiKey);
    // API may return { items: [...], total } or a plain array
    return Array.isArray(res) ? res : (res?.items ?? []);
  }

  async ackJob(apiKey: string, jobId: string, status: 'printed' | 'failed', error?: string): Promise<void> {
    await this.fetchWithApiKey('POST', `/api/print/jobs/${encodeURIComponent(jobId)}/ack`, apiKey, {
      status,
      ...(error ? { error } : {}),
    });
  }

  async getLabelData(apiKey: string, jobId: string): Promise<string> {
    const res = await this.fetchWithApiKey('GET', `/api/print/jobs/${encodeURIComponent(jobId)}/label`, apiKey);
    return typeof res === 'string' ? res : res.labelData || res.data;
  }

  // ═══════════════════════════════════════════════════════
  // OAuth token exchange
  // ═══════════════════════════════════════════════════════

  async exchangeOAuthCode(code: string, codeVerifier: string): Promise<{ accessToken: string; refreshToken: string }> {
    const baseUrl = this.store.getApiUrl();
    const res = await fetch(`${baseUrl}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: `${APP_PROTOCOL}://callback`,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`OAuth token exchange failed: ${res.status} ${errBody}`);
    }
    const data = await res.json() as { access_token: string; refresh_token: string };
    return { accessToken: data.access_token, refreshToken: data.refresh_token };
  }

  async refreshAccessToken(): Promise<string> {
    const refreshToken = this.store.getRefreshToken();
    if (!refreshToken) throw new Error('No refresh token');

    const baseUrl = this.store.getApiUrl();
    const res = await fetch(`${baseUrl}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });
    if (!res.ok) {
      // ⚠️ NE PAS effacer les credentials pour n'importe quel échec.
      //
      // Ce `clearAuth()` était inconditionnel : un 429 (quota) ou un 5xx
      // (serveur indisponible) effaçait le jeton d'accès, le jeton de
      // rafraîchissement ET les clés API de TOUS les workspaces. Un simple
      // pic de trafic déconnectait donc l'agent, et la vendeuse devait tout
      // reconfigurer sans comprendre pourquoi. Vécu le 2026-09-11 : le
      // serveur plafonnait `POST /api/oauth/token` à 5 req/min (le seau
      // anti-brute-force de login), donc un lot d'étiquettes suffisait.
      //
      // Seul un refus DÉFINITIF du jeton justifie d'effacer : 400
      // (`invalid_grant`) ou 401. Tout le reste est transitoire et doit
      // ressortir comme tel, pour être réessayé.
      const definitif = res.status === 400 || res.status === 401;
      if (definitif) {
        this.store.clearAuth();
        throw new Error(`Refresh token rejected (${res.status}) — re-authentication required`);
      }
      throw new Error(
        `Token refresh temporarily failed: ${res.status} ${res.statusText} — credentials kept`,
      );
    }
    const data = await res.json() as { access_token: string; refresh_token?: string };
    this.store.setAccessToken(data.access_token);
    if (data.refresh_token) {
      this.store.setRefreshToken(data.refresh_token);
    }
    return data.access_token;
  }

  // ═══════════════════════════════════════════════════════
  // Internal HTTP helpers
  // ═══════════════════════════════════════════════════════

  private async fetchWithAuth(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<any> {
    const baseUrl = this.store.getApiUrl();
    let token = this.store.getAccessToken();

    let res = await this.doFetch(method, `${baseUrl}${path}`, {
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    }, body);

    // Auto-refresh on 401
    if (res.status === 401) {
      token = await this.refreshAccessToken();
      res = await this.doFetch(method, `${baseUrl}${path}`, {
        Authorization: `Bearer ${token}`,
        ...extraHeaders,
      }, body);
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`API ${method} ${path} failed: ${res.status} ${errBody}`);
    }
    return res.json();
  }

  private async fetchWithApiKey(method: string, path: string, apiKey: string, body?: unknown): Promise<any> {
    const baseUrl = this.store.getApiUrl();
    const res = await this.doFetch(method, `${baseUrl}${path}`, {
      'X-API-Key': apiKey,
    }, body);

    if (!res.ok) {
      throw new Error(`API ${method} ${path} failed: ${res.status}`);
    }
    return res.json();
  }

  private async doFetch(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
    return fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'HoulaPrint/1.0',
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
}
