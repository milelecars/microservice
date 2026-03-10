import { Request, Response } from 'express';
import axios from 'axios';

const KOMMO_BASE = 'https://fahadriazex1.kommo.com/api/v4';
const KOMMO_TOKEN = process.env.KOMMO_TOKEN!;
const TG_FIELD_ID = 1067290;

export async function handleTelegramWebhook(req: Request, res: Response): Promise<void> {
  res.status(200).json({ ok: true });

  setImmediate(async () => {
    try {
      const body = req.body;
      console.log('[telegram] incoming update:', JSON.stringify(body));

      // Parse lead_id from Kommo webhook format
      const leadId =
        body?.leads?.add?.[0]?.id ??
        body?.leads?.update?.[0]?.id ??
        body?.lead_id;

      if (!leadId) {
        console.warn('[telegram] no lead_id found in body, skipping');
        return;
      }

      console.log('[telegram] lead_id:', leadId);

      // Fetch talks filtered by this lead
      const talksResp = await axios.get(
        `${KOMMO_BASE}/talks?entity_id=${leadId}&entity_type=lead&limit=10`,
        { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000 }
      );

      const talks = talksResp.data?._embedded?.talks ?? [];
      console.log('[telegram] talks found:', talks.length, JSON.stringify(talks));

      const tgTalk = talks
        .filter((t: any) => t.origin === 'telegram')
        .sort((a: any, b: any) => b.created_at - a.created_at)[0];

      if (!tgTalk) {
        console.warn('[telegram] no telegram talk found for lead', leadId);
        return;
      }

      const telegramUserId =
        tgTalk?.chat?.origin_id ??
        tgTalk?.origin_id ??
        tgTalk?.chat_id;

      if (!telegramUserId) {
        console.warn('[telegram] no TG user ID in talk:', JSON.stringify(tgTalk));
        return;
      }

      console.log('[telegram] saving TG user ID:', telegramUserId, '→ lead:', leadId);

      const patchResp = await axios.patch(
        `${KOMMO_BASE}/leads/${leadId}`,
        {
          custom_fields_values: [
            { field_id: TG_FIELD_ID, values: [{ value: Number(telegramUserId) }] }
          ]
        },
        { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000 }
      );

      console.log('[telegram] done — status:', patchResp.status);

    } catch (err: any) {
      console.error('[telegram] error:', err?.response?.data ?? err.message);
    }
  });
}