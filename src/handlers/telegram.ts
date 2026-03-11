import { Request, Response } from 'express';
import axios from 'axios';

const KOMMO_BASE  = 'https://fahadriazex1.kommo.com/api/v4';
const KOMMO_TOKEN = process.env.KOMMO_TOKEN!;

// Lead custom fields
const FIELD_TG_USER_ID      = 1067290; // numeric
const FIELD_TG_USERNAME     = 1104292; // text — Telegram @username
const FIELD_SOURCE_PLATFORM = 1094948; // text — TikTok / Instagram / etc

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

      // 1. Extract sender info
      const msg  = body?.message ?? body?.edited_message;
      const from = msg?.from ?? body?.callback_query?.from;

      const telegramUserId: number | undefined = from?.id;
      const telegramUsername: string | undefined = from?.username;
      const chatId: number | undefined = msg?.chat?.id ?? from?.id;

      if (!telegramUserId || !chatId) {
        console.warn('[telegram] no from.id in update — skipping');
        return;
      }

      console.log('[telegram] user:', { id: telegramUserId, username: telegramUsername });

      // 2. Parse source platform from /start <param>
      //    Links: t.me/askfahadbot?start=tiktok  (or instagram, youtube, facebook, direct)
      const msgText: string = msg?.text ?? '';
      const isStartCommand = msgText === '/start' || msgText.startsWith('/start ');

      let sourcePlatform: string | undefined;
      if (msgText.startsWith('/start ')) {
        const param = msgText.replace('/start ', '').trim().toLowerCase();
        sourcePlatform = SOURCE_MAP[param] ?? param;
        console.log('[telegram] source platform:', sourcePlatform);
      }

      // 3. Forward to Kommo — strip bot_command entity from /start so Kommo
      //    treats it as a regular incoming message, creating the lead and
      //    triggering the Salesbot reply immediately.
      const forwardBody = isStartCommand
        ? {
            ...body,
            message: {
              ...msg,
              text: 'Hi',        // replace /start <param> with plain text
              entities: undefined, // remove bot_command entity so Kommo doesn't ignore it
            },
          }
        : body;

      axios.post(KOMMO_TG_WEBHOOK, forwardBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10_000,
      })
        .then(() => console.log('[telegram] forwarded to Kommo ✓'))
        .catch(err => console.error('[telegram] forward failed:', err.message));

      // 5. Wait for Kommo to process and create the talk/lead
      await new Promise(r => setTimeout(r, 3000));

      // 6. Find the most recent telegram talk → get lead ID
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

      // 7. Patch lead — save all captured fields in one request
      const leadFields: any[] = [
        { field_id: FIELD_TG_USER_ID, values: [{ value: Number(telegramUserId) }] },
      ];
      if (telegramUsername) {
        leadFields.push({ field_id: FIELD_TG_USERNAME, values: [{ value: `@${telegramUsername}` }] });
      } else {
        console.warn('[telegram] user has no @username — skipping');
      }
      if (sourcePlatform) {
        leadFields.push({ field_id: FIELD_SOURCE_PLATFORM, values: [{ value: sourcePlatform }] });
      }

      const leadPatch = await axios.patch(
        `${KOMMO_BASE}/leads/${leadId}`,
        { custom_fields_values: leadFields },
        { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000 }
      );
      console.log('[telegram] lead patched | status:', leadPatch.status);
      console.log('[telegram] ✓ done | lead:', leadId, '| TG ID:', telegramUserId, '| username:', telegramUsername ?? 'none', '| source:', sourcePlatform ?? 'unknown');

    } catch (err: any) {
      console.error('[telegram] error:', err?.response?.data ?? err.message);
    }
  });
}