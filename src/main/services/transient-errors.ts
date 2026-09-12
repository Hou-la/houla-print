/**
 * Classification des erreurs d'impression : transitoire ou fatale.
 *
 * Une erreur TRANSITOIRE est réessayée indéfiniment, avec backoff, et ne
 * consomme aucune tentative : l'étiquette reste due. Une erreur FATALE
 * consomme une tentative et, au bout de `MAX_RETRIES`, le job est acquitté
 * `failed` côté serveur — l'étiquette est alors DÉFINITIVEMENT perdue, la
 * seule copie restante étant l'entrée d'historique locale.
 *
 * La classification pèse donc exactement autant qu'une étiquette. Le
 * 2026-09-11, le serveur plafonnait `POST /api/oauth/token` à 5 req/min (le
 * seau anti-brute-force de login) : à partir de la 6e étiquette d'un lot, le
 * rafraîchissement de jeton prenait un 429, l'agent l'avalait et réémettait
 * un « PDF download failed: 401 Unauthorized ». Aucun motif ne reconnaissait
 * ce message, si bien que 8 étiquettes sont parties en erreur fatale là où un
 * simple réessai aurait suffi.
 *
 * ⚠️ CE FICHIER NE DOIT RIEN IMPORTER D'ELECTRON. La fonction vivait dans
 * `queue.service.ts`, qui importe `electron` : sous vitest le module ne
 * s'exportait pas du tout (`isTransientError is not a function`) et la
 * classification restait donc intestable. C'est la raison d'être de ce
 * fichier séparé.
 */
export function isTransientError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase();
  return (
    // ── Côté IMPRIMANTE ────────────────────────────────────────────────
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
    lower.includes('busy') ||            // printer busy
    // ── Côté RÉSEAU / SERVEUR ──────────────────────────────────────────
    // Un quota ou une indisponibilité passagère ne doit JAMAIS faire perdre
    // une étiquette. C'est précisément ce qui manquait le 2026-09-11.
    lower.includes('429') ||
    lower.includes('too many requests') ||
    lower.includes('temporarily failed') ||
    lower.includes('credentials kept') ||
    lower.includes(' 502') ||
    lower.includes(' 503') ||
    lower.includes(' 504') ||
    lower.includes('bad gateway') ||
    lower.includes('service unavailable') ||
    lower.includes('gateway timeout') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed')
  );
}
