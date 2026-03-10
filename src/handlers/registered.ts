import { Request, Response } from 'express';
import { getTraderByUid } from '../weex';
import { resumeBot } from '../callback';

export async function verifyRegistered(req: Request, res: Response): Promise<void> {

  const rawData = req.body.data;
  const data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
  const traderId = data?.trader_id;
  const { return_url } = req.body;
  const leadId = data?.lead_id;

  console.log('[registered] received', { traderId, return_url });
  res.status(200).json({ ok: true });

  setImmediate(async () => {
    const kommoToken = process.env.KOMMO_TOKEN!;

    if (!return_url) { console.error('[registered] missing return_url'); return; }
    if (!traderId) { await resumeBot(return_url, 'not_found', kommoToken, 'No Trader ID provided'); return; }

    try {
      const trader = await getTraderByUid(String(traderId));
      if (!trader) {
        await resumeBot(return_url, 'not_found', kommoToken, 'Trader ID not found under this affiliate account');
        return;
      }
      await resumeBot(return_url, 'verified', kommoToken, 'Registration confirmed');
    } catch (err) {
      console.error('[registered] Weex API error:', err);
      await resumeBot(return_url, 'error', kommoToken, 'Verification service temporarily unavailable');
    }
  });
}