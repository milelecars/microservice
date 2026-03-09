import { Request, Response } from 'express';
import axios from 'axios';
import { resumeBot } from '../callback';

const KOMMO_BASE = 'https://fahadriazex1.kommo.com/api/v4';

async function kommo(path: string, token: string) {
  const r = await axios.get(`${KOMMO_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10_000,
  });
  return r.data;
}

export async function verifyChannel(req: Request, res: Response): Promise<void> {
  const { return_url, data } = req.body;
  const leadId = data?.lead_id;

  console.log('[channel] received', { leadId, return_url });
  res.status(200).json({ ok: true });

  setImmediate(async () => {
    const kommoToken = process.env.KOMMO_TOKEN!;
    const botToken   = process.env.BOT_TOKEN!;
    const channelId  = process.env.CHANNEL_ID!;

    if (!kommoToken || !botToken || !channelId) {
      console.error('[channel] missing env vars');
      await resumeBot(return_url, 'not_joined', kommoToken, 'Server config error');
      return;
    }

    try {
      // ── Step 1: check if Telegram User ID already stored ──────────────────
      let telegramUserId: string | undefined;
      let contactId: number | undefined;

      const lead = await kommo(`/leads/${leadId}?with=contacts`, kommoToken);
      const contacts = lead?._embedded?.contacts ?? [];
      const mainContact = contacts.find((c: any) => c.is_main) ?? contacts[0];
      contactId = mainContact?.id;
      console.log('[channel] contactId:', contactId);

      if (contactId) {
        const contact = await kommo(`/contacts/${contactId}`, kommoToken);
        const fields: any[] = contact?.custom_fields_values ?? [];
        const tgField = fields.find((f: any) => f.field_id === 1067290);
        telegramUserId = tgField?.values?.[0]?.value?.toString();
        console.log('[channel] stored telegramUserId:', telegramUserId);
      }

      // ── Step 2: if not stored, discover from chats ────────────────────────
      if (!telegramUserId && contactId) {
        console.log('[channel] no stored ID — fetching chats...');

        // GET /contacts/{id}?with=chats gives chat list with source_uid
        const contactWithChats = await kommo(`/contacts/${contactId}?with=chats`, kommoToken);
        console.log('[channel] contact chats raw:', JSON.stringify(contactWithChats?._embedded?.chats));

        const chats: any[] = contactWithChats?._embedded?.chats ?? [];
        // Telegram chats have origin "telegram" — source_uid IS the Telegram user ID
        const tgChat = chats.find((c: any) =>
          c.origin?.toLowerCase?.() === 'telegram' ||
          c.channel_type?.toLowerCase?.() === 'telegram'
        );

        if (tgChat) {
          // source_uid or external_id holds the real Telegram user ID
          telegramUserId = (tgChat.source_uid ?? tgChat.external_id ?? '').toString();
          console.log('[channel] discovered telegramUserId from chat:', telegramUserId, 'chat object:', JSON.stringify(tgChat));
        } else {
          // Log all chats so we can see what fields are available
          console.log('[channel] no telegram chat found. all chats:', JSON.stringify(chats));
        }

        // ── Step 3: save discovered ID to custom field ─────────────────────
        if (telegramUserId && contactId) {
          await axios.patch(`${KOMMO_BASE}/contacts/${contactId}`, {
            custom_fields_values: [
              { field_id: 1067290, values: [{ value: telegramUserId }] }
            ]
          }, {
            headers: { Authorization: `Bearer ${kommoToken}` },
            timeout: 10_000,
          });
          console.log('[channel] saved telegramUserId to contact field:', telegramUserId);
        }
      }

      if (!telegramUserId) {
        console.error('[channel] could not resolve Telegram user ID');
        await resumeBot(return_url, 'not_joined', kommoToken, 'Could not resolve Telegram user ID');
        return;
      }

      // ── Step 4: check channel membership ──────────────────────────────────
      const tgResp = await axios.get('https://api.telegram.org/bot' + botToken + '/getChatMember', {
        params: { chat_id: channelId, user_id: telegramUserId },
        timeout: 10_000,
      });

      const status = tgResp.data?.result?.status;
      console.log('[channel] getChatMember status:', status, 'for user:', telegramUserId);

      const isJoined = ['member', 'administrator', 'creator'].includes(status);
      await resumeBot(
        return_url,
        isJoined ? 'joined' : 'not_joined',
        kommoToken,
        isJoined ? 'Channel membership confirmed' : 'User has not joined the channel'
      );

    } catch (err: any) {
      console.error('[channel] error:', err?.response?.data ?? err.message);
      await resumeBot(return_url, 'error', kommoToken, err?.response?.data?.detail ?? err.message);
    }
  });
}
// ── Step finish