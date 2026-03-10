import { Request, Response } from 'express';
import { getTraderByUid } from '../weex';
import { resumeBot } from '../callback';

export async function verifyDeposited(req: Request, res: Response): Promise<void> {
  const rawData = req.body.data;
  const data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
  const traderId = data?.trader_id;
  const { return_url } = req.body;
  const leadId = data?.lead_id;

  console.log('[deposited] received', { traderId, return_url });
  res.status(200).json({ ok: true });

  setImmediate(async () => {
    const kommoToken = process.env.KOMMO_TOKEN!;

    if (!return_url) { console.error('[deposited] missing return_url'); return; }
    if (!traderId) { await resumeBot(return_url, 'no_deposit', kommoToken, 'No Trader ID provided'); return; }

    try {
      const trader = await getTraderByUid(String(traderId));
      if (!trader) {
        await resumeBot(return_url, 'no_deposit', kommoToken, 'Trader ID not found');
        return;
      }
      const hasDeposit = !!trader.firstDeposit && trader.firstDeposit.trim().length > 0;
      if (hasDeposit) {
        const depositDate = new Date(parseInt(trader.firstDeposit!, 10)).toLocaleDateString();
        await resumeBot(return_url, 'deposited', kommoToken, `First deposit on ${depositDate}`);
      } else {
        await resumeBot(return_url, 'no_deposit', kommoToken, 'No deposit detected yet');
      }
    } catch (err) {
      console.error('[deposited] Weex API error:', err);
      await resumeBot(return_url, 'error', kommoToken, 'Verification service temporarily unavailable');
    }
  });
}