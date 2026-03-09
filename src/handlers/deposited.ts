import { Request, Response } from 'express';
import { getTraderByUid } from '../weex';
import { resumeBot } from '../callback';

/**
 * POST /verify/deposited
 *
 * Checks if a Weex UID has made at least one deposit.
 * Uses the firstDeposit field — present = at least one deposit made.
 *
 * Kommo sends:
 *   { token, return_url, data: { trader_id, lead_id } }
 */
export async function verifyDeposited(req: Request, res: Response): Promise<void> {
  const { return_url, data } = req.body;
  const traderId = data?.trader_id;

  console.log('[deposited] received', { traderId, return_url });

  // Acknowledge immediately
  res.status(200).json({ ok: true });

  setImmediate(async () => {
    if (!return_url) {
      console.error('[deposited] missing return_url');
      return;
    }

    if (!traderId) {
      await resumeBot(return_url, 'no_deposit', 'No Trader ID provided');
      return;
    }

    try {
      const trader = await getTraderByUid(String(traderId));

      if (!trader) {
        console.log('[deposited] UID not found:', traderId);
        await resumeBot(return_url, 'no_deposit', 'Trader ID not found');
        return;
      }

      const hasDeposit = !!trader.firstDeposit && trader.firstDeposit.trim().length > 0;

      if (hasDeposit) {
        const depositDate = new Date(parseInt(trader.firstDeposit!, 10)).toLocaleDateString();
        console.log('[deposited] deposit confirmed:', traderId, depositDate);
        await resumeBot(return_url, 'deposited', `First deposit on ${depositDate}`);
      } else {
        console.log('[deposited] no deposit yet:', traderId);
        await resumeBot(return_url, 'no_deposit', 'No deposit detected yet');
      }

    } catch (err) {
      console.error('[deposited] Weex API error:', err);
      await resumeBot(return_url, 'error', 'Verification service temporarily unavailable');
    }
  });
}
