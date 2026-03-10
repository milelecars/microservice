import { Request, Response } from 'express';
import axios from 'axios';

const KOMMO_BASE = 'https://fahadriazex1.kommo.com/api/v4';
const KOMMO_TOKEN = process.env.KOMMO_TOKEN!;
const TG_FIELD_ID = 1067290;

// Kommo's internal Telegram webhook URL (from getWebhookInfo)
const KOMMO_TG_WEBHOOK = 'https://amojo.amocrm.com/~external/hooks/telegram?t=8593034950:AAG7lU1tK8XJWTIbVSHyeFHFwggzDiJD8Rk&';

export async function handleTelegramWebhook(req: Request, res: Response): Promise<void> {
  // Respond to Telegram immediately — prevents retries
  res.status(200).json({ ok: true });

  setImmediate(async () => {
    try {
      const body = req.body;
      console.log('[telegram] incoming update:', JSON.stringify(body));

      // 1. Forward raw update to Kommo right away (non-blocking)
      axios.post(KOMMO_TG_WEBHOOK, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10_000,
      })
        .then(() => console.log('[telegram] forwarded to Kommo ✓'))
        .catch(err => console.error('[telegram] forward to Kommo failed:', err.message));

      // 2. Extract Telegram user ID from raw update
      const from =
        body?.message?.from ??
        body?.edited_message?.from ??
        body?.callback_query?.from;

      const telegramUserId: number | undefined = from?.id;

      if (!telegramUserId) {
        console.warn('[telegram] no from.id in update — skipping field save');
        return;
      }

      console.log('[telegram] TG user ID:', telegramUserId);

      // 3. Wait for Kommo to process the message and create/update the talk
      await new Promise(r => setTimeout(r, 3000));

      // 4. Find the most recent telegram talk to get the lead ID
      const talksResp = await axios.get(
        `${KOMMO_BASE}/talks?limit=5`,
        { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000 }
      );

      const talks: any[] = talksResp.data?._embedded?.talks ?? [];
      console.log('[telegram] recent talks:', talks.length);

      const activeTalk = talks
        .filter(t => t.origin === 'telegram' && t.entity_id && t.entity_type === 'lead')
        .sort((a, b) => b.created_at - a.created_at)[0];

      if (!activeTalk) {
        console.warn('[telegram] no active telegram talk found');
        return;
      }

      const leadId = activeTalk.entity_id;
      console.log('[telegram] matched lead:', leadId);

      // 5. Save numeric Telegram user ID to the lead's custom field
      const patchResp = await axios.patch(
        `${KOMMO_BASE}/leads/${leadId}`,
        {
          custom_fields_values: [
            { field_id: TG_FIELD_ID, values: [{ value: Number(telegramUserId) }] }
          ]
        },
        { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000 }
      );

      console.log('[telegram] saved TG user ID', telegramUserId, '→ lead', leadId, '| status:', patchResp.status);

    } catch (err: any) {
      console.error('[telegram] error:', err?.response?.data ?? err.message);
    }
  });
}