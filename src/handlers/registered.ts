import { Request, Response } from 'express';
import { getTraderByUid } from '../weex';
import { resumeBot } from '../callback';

/**
 * POST /verify/registered
 *
 * Checks if a Weex UID exists under this affiliate account.
 *
 * Kommo sends:
 *   { token, return_url, data: { trader_id, lead_id } }
 */
export async function verifyRegistered(req: Request, res: Response): Promise<void> {
  const { return_url, data } = req.body;
  const traderId = data?.trader_id;

  console.log('[registered] received', { traderId, return_url });

  // Acknowledge immediately
  res.status(200).json({ ok: true });

  setImmediate(async () => {
    if (!return_url) {
      console.error('[registered] missing return_url');
      return;
    }

    if (!traderId) {
      await resumeBot(return_url, 'not_found', 'No Trader ID provided');
      return;
    }

    try {
      const trader = await getTraderByUid(String(traderId));

      if (!trader) {
        console.log('[registered] UID not found in affiliate account:', traderId);
        await resumeBot(
          return_url,
          'not_found',
          'Trader ID not found under this affiliate account'
        );
        return;
      }

      console.log('[registered] UID verified:', traderId);
      await resumeBot(return_url, 'verified', 'Registration confirmed');

    } catch (err) {
      console.error('[registered] Weex API error:', err);
      // On API error, return a retryable status so bot can try again
      await resumeBot(return_url, 'error', 'Verification service temporarily unavailable');
    }
  });
}
