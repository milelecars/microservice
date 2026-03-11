import { Request, Response } from 'express';
import axios from 'axios';

const KOMMO_BASE = 'https://fahadriazex1.kommo.com/api/v4';
const KOMMO_TOKEN = process.env.KOMMO_TOKEN!;

// Lead custom fields
const FIELD_TG_USER_ID      = 1067290; // numeric
const FIELD_SOURCE_PLATFORM = 1094948; // text

// Contact custom fields
const FIELD_TG_USERNAME     = 1104292; // text (short)

// Kommo's internal Telegram webhook URL
const KOMMO_TG_WEBHOOK = 'https://amojo.amocrm.com/~external/hooks/telegram?t=8593034950:AAG7lU1tK8XJWTIbVSHyeFHFwggzDiJD8Rk&';

// Map start parameter → display name
const SOURCE_MAP: Record<string, string> = {
  tiktok:    'TikTok',
  instagram: 'Instagram',
  youtube:   'YouTube',
  facebook:  'Facebook',
  direct:    'Direct',
};

export async function handleTelegramWebhook(req: Request, res: Response): Promise<void> {
  // Respond to Telegram immediately — prevents retries
  res.status(200).json({ ok: true });

  setImmediate(async () => {
    try {
      const body = req.body;
      console.log('[telegram] incoming update:', JSON.stringify(body));

      // 1. Forward raw update to Kommo immediately (non-blocking)
      axios.post(KOMMO_TG_WEBHOOK, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10_000,
      })
        .then(() => console.log('[telegram] forwarded to Kommo ✓'))
        .catch(err => console.error('[telegram] forward to Kommo failed:', err.message));

      // 2. Extract sender info from raw Telegram update
      const msg = body?.message ?? body?.edited_message;
      const from = msg?.from ?? body?.callback_query?.from;

      const telegramUserId: number | undefined = from?.id;
      const telegramUsername: string | undefined = from?.username;

      if (!telegramUserId) {
        console.warn('[telegram] no from.id in update — skipping');
        return;
      }

      console.log('[telegram] user:', { id: telegramUserId, username: telegramUsername });

      // 3. Parse source platform from /start <param>
      //    Links: t.me/askfahadbot?start=tiktok  (or instagram, youtube, facebook, direct)
      let sourcePlatform: string | undefined;
      const msgText: string = msg?.text ?? '';
      if (msgText.startsWith('/start ')) {
        const param = msgText.replace('/start ', '').trim().toLowerCase();
        sourcePlatform = SOURCE_MAP[param] ?? param;
        console.log('[telegram] source platform:', sourcePlatform);
      }

      // 4. Wait for Kommo to process the message and create the talk/lead
      await new Promise(r => setTimeout(r, 3000));

      // 5. Find the most recent telegram talk → get lead ID
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
      console.log('[telegram] matched lead:', leadId, '| full talk:', JSON.stringify(activeTalk));

      // 6. Fetch the lead to get the linked contact ID
      const leadResp = await axios.get(
        `${KOMMO_BASE}/leads/${leadId}?with=contacts`,
        { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000 }
      );

      // Try contacts embedded in lead, fallback to talk's own contact_id field
      const contactId =
        leadResp.data?._embedded?.contacts?.[0]?.id ??
        activeTalk?.contact_id;

      console.log('[telegram] linked contact:', contactId, '| lead contacts raw:', JSON.stringify(leadResp.data?._embedded?.contacts));

      // 7. Patch lead — Telegram User ID + Source Platform (if /start param found)
      const leadFields: any[] = [
        { field_id: FIELD_TG_USER_ID, values: [{ value: Number(telegramUserId) }] },
      ];
      if (sourcePlatform) {
        leadFields.push({ field_id: FIELD_SOURCE_PLATFORM, values: [{ value: sourcePlatform }] });
      }

      const leadPatch = await axios.patch(
        `${KOMMO_BASE}/leads/${leadId}`,
        { custom_fields_values: leadFields },
        { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000 }
      );
      console.log('[telegram] lead patched | status:', leadPatch.status);

      // 8. Patch contact — fetch first to get existing fields, then merge
      if (contactId && telegramUsername) {
        const contactGetResp = await axios.get(
          `${KOMMO_BASE}/contacts/${contactId}`,
          { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000 }
        );

        const existingFields: any[] = contactGetResp.data?.custom_fields_values ?? [];
        // Remove old TG username entry if exists, then append updated value
        const mergedFields = [
          ...existingFields.filter((f: any) => f.field_id !== FIELD_TG_USERNAME),
          { field_id: FIELD_TG_USERNAME, values: [{ value: `@${telegramUsername}` }] },
        ];

        const contactPatch = await axios.patch(
          `${KOMMO_BASE}/contacts/${contactId}`,
          { custom_fields_values: mergedFields },
          { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000 }
        );
        console.log('[telegram] contact patched | status:', contactPatch.status);
      } else if (!telegramUsername) {
        console.warn('[telegram] user has no @username — skipping contact patch');
      }

      console.log('[telegram] ✓ done | lead:', leadId, '| TG ID:', telegramUserId, '| username:', telegramUsername ?? 'none', '| source:', sourcePlatform ?? 'unknown');

    } catch (err: any) {
      console.error('[telegram] error:', err?.response?.data ?? err.message);
    }
  });
}