import { Request, Response } from 'express';
import axios from 'axios';
import { resumeBot } from '../callback';
import { errText } from '../env';
import { LEAD_FIELD, KommoLead, get as kommoGet, patch as kommoPatch, setContactStatus } from '../kommo';
import { resolveTelegramId } from './identity';
import { getLead, updateLead, nowIso, LeadRecord } from './supabase';

interface TelegramChatMemberResponse {
  result?: { status?: string };
}

async function syncJoined(telegramUserId: string, contactId?: string | number): Promise<void> {
  const existing = await getLead(telegramUserId);
  if (!existing) {
    console.warn('[channel] no Supabase row for TG user:', telegramUserId, '- skipping sync');
    return;
  }
  const changes: Partial<LeadRecord> = { in_channel: true };
  if (!existing.joined_at) changes.joined_at = nowIso();
  await updateLead(telegramUserId, changes);

  const contact = contactId ?? existing.kommo_contact_id;
  if (contact) await setContactStatus(contact, 'joined');
}

async function syncNotJoined(telegramUserId: string): Promise<void> {
  const existing = await getLead(telegramUserId);
  if (!existing) {
    console.warn('[channel] no Supabase row for TG user:', telegramUserId, '- skipping sync');
    return;
  }
  await updateLead(telegramUserId, {
    in_channel: false,
    join_check_failures: (existing.join_check_failures ?? 0) + 1,
  });
}

export async function verifyChannel(req: Request, res: Response): Promise<void> {
  const { return_url } = req.body;
  const rawData = req.body?.data;

  let data: { lead_id?: string | number } | undefined;
  if (typeof rawData === 'string') {
    try {
      data = JSON.parse(rawData);
    } catch (e) {
      console.error('[channel] failed to parse body.data JSON', { error: errText(e) });
      data = undefined;
    }
  } else {
    data = rawData;
  }

  const leadId = data?.lead_id;

  console.log('[channel] received', {
    returnUrlPresent: !!return_url,
    rawDataType: rawData === null ? 'null' : Array.isArray(rawData) ? 'array' : typeof rawData,
    leadId,
    bodyKeys: Object.keys(req.body ?? {}).slice(0, 30),
  });
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
      if (!return_url) {
        console.error('[channel] missing return_url');
        return;
      }
      if (!leadId) {
        console.error('[channel] missing lead_id in data');
        await resumeBot(return_url, 'error', kommoToken, 'Missing lead_id');
        return;
      }

      // ── Step 1: resolve the Telegram user id ──────────────────────────────
      const lead = await kommoGet<KommoLead>(`/leads/${leadId}?with=contacts`);
      const contacts = lead?._embedded?.contacts ?? [];
      const mainContact = contacts.find(c => c.is_main) ?? contacts[0];
      const contactId = mainContact?.id;
      console.log('[channel] contactId:', contactId);

      const { telegramUserId, row, via } = await resolveTelegramId('[channel]', lead, leadId, contactId);
      console.log('[channel] telegramUserId:', telegramUserId ?? '-', '| via:', via);

      if (!telegramUserId) {
        console.error('[channel] could not resolve Telegram user ID');
        await resumeBot(return_url, 'not_joined', kommoToken, 'Could not resolve Telegram user ID');
        return;
      }

      // ── Step 2: save it onto the LEAD when the field was empty ────────────
      if (via !== 'lead-field') {
        await kommoPatch(`/leads/${leadId}`, {
          custom_fields_values: [
            { field_id: LEAD_FIELD.TG_USER_ID, values: [{ value: Number(telegramUserId) }] },
          ],
        });
        console.log('[channel] saved telegramUserId to lead field:', telegramUserId);
      }

      // ── Step 3: chat_member already told us they are in ───────────────────
      const existing = row ?? (await getLead(telegramUserId));
      if (existing?.in_channel) {
        console.log('[channel] in_channel already true - answering joined | TG user:', telegramUserId);
        if (!existing.joined_at) await updateLead(telegramUserId, { joined_at: nowIso() });
        const knownContact = contactId ?? existing.kommo_contact_id;
        if (knownContact) await setContactStatus(knownContact, 'joined');
        await resumeBot(return_url, 'joined', kommoToken, 'Channel membership confirmed');
        return;
      }

      // ── Step 4: check channel membership ──────────────────────────────────
      const tgResp = await axios.get<TelegramChatMemberResponse>(
        'https://api.telegram.org/bot' + botToken + '/getChatMember',
        { params: { chat_id: channelId, user_id: telegramUserId }, timeout: 10_000 }
      );

      const status = tgResp.data?.result?.status;
      console.log('[channel] getChatMember status:', status, 'for user:', telegramUserId);

      const isJoined = ['member', 'administrator', 'creator'].includes(status ?? '');

      if (isJoined) await syncJoined(telegramUserId, contactId);
      else await syncNotJoined(telegramUserId);

      await resumeBot(
        return_url,
        isJoined ? 'joined' : 'not_joined',
        kommoToken,
        isJoined ? 'Channel membership confirmed' : 'User has not joined the channel'
      );

    } catch (err) {
      console.error('[channel] error:', errText(err));
      await resumeBot(return_url, 'error', kommoToken, errText(err));
    }
  });
}
