import { describe, it, expect } from 'vitest';
import { isTransientError } from './transient-errors';

/**
 * Régression de l'incident du 2026-09-11 (ticket #108674).
 *
 * Une erreur transitoire est réessayée indéfiniment ; une erreur fatale
 * consomme une tentative et, au bout de 3, le job est acquitté `failed`
 * côté serveur — l'étiquette est alors DÉFINITIVEMENT perdue, la seule copie
 * restante étant l'historique local.
 *
 * Ce jour-là, le serveur plafonnait `POST /api/oauth/token` à 5 req/min (le
 * seau anti-brute-force de login). À partir de la 6e étiquette du lot, le
 * rafraîchissement de jeton prenait un 429 ; l'agent l'avalait et réémettait
 * un « PDF download failed: 401 Unauthorized ». Ce message n'étant reconnu
 * par aucun motif transitoire, 8 étiquettes sont parties en erreur fatale.
 *
 * Un simple réessai aurait suffi. D'où ces cas.
 */
describe('isTransientError', () => {
    describe('doit être TRANSITOIRE (réessayable, rien n’est perdu)', () => {
        const cas = [
            // Le cas exact de l'incident, tel que le message est désormais formé.
            'PDF download failed: 401 Unauthorized — token refresh failed: Token refresh temporarily failed: 429 Too Many Requests — credentials kept',
            'Token refresh temporarily failed: 429 Too Many Requests — credentials kept',
            'PDF download failed: 429 Too Many Requests',
            'PDF download failed: 503 Service Unavailable',
            'PDF download failed: 502 Bad Gateway',
            'PDF download failed: 504 Gateway Timeout',
            'fetch failed',
            'ECONNRESET',
            'ETIMEDOUT',
            // Et les cas imprimante, qui marchaient déjà : on vérifie qu'on ne
            // les a pas cassés en ajoutant les cas réseau.
            'Imprimante non connectée',
            'Printer not connected',
            'Out of paper',
            'timeout waiting for print complete',
            'Skipped after previous page failure — resource busy',
        ];
        it.each(cas)('%s', (msg) => {
            expect(isTransientError(msg)).toBe(true);
        });
    });

    describe('doit rester FATAL (inutile de réessayer)', () => {
        // CONTRE-TÉMOIN indispensable : si tout devenait transitoire, les
        // tests ci-dessus passeraient sans rien prouver, et un job réellement
        // impossible boucierait pour toujours.
        const cas = [
            'PDF download failed: 401 Unauthorized',
            'PDF download failed: 403 Forbidden',
            'PDF download failed: 404 Not Found',
            'Refresh token rejected (400) — re-authentication required',
            'Refresh token rejected (401) — re-authentication required',
            'No label data or URL for PDF job',
            'Unsupported label format: docx',
        ];
        it.each(cas)('%s', (msg) => {
            expect(isTransientError(msg)).toBe(false);
        });
    });

    it('un 401 NU reste fatal, mais le même 401 causé par un quota devient transitoire', () => {
        // C'est toute la distinction que l'ancien `catch {}` vide effaçait :
        // il réémettait le 401 sec, perdant l'information qui aurait permis
        // de réessayer.
        expect(isTransientError('PDF download failed: 401 Unauthorized')).toBe(false);
        expect(
            isTransientError(
                'PDF download failed: 401 Unauthorized — token refresh failed: Token refresh temporarily failed: 429 Too Many Requests — credentials kept',
            ),
        ).toBe(true);
    });
});
