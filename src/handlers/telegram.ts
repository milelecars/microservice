import { Request, Response } from 'express';
import axios from 'axios';
import { requireEnv, errText } from '../env';
import {
  LEAD_FIELD,
  PIPELINE_ID,
  KommoContact,
  KommoCustomField,
  KommoLead,
  KommoList,
  KommoTalk,
  get as kommoGet,
  patch as kommoPatch,
  getStageMap,
  tagNames,
} from '../kommo';
import { getLead, updateLead, upsertLead, nowIso, LeadRecord } from './supabase';

// ── Telegram update shapes (only what we read) ────────────────────────────────

interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TgChat {
  id: number;
}

interface TgMessage {
  text?: string;
  chat?: TgChat;
  from?: TgUser;
  entities?: unknown;
}

interface TgChatMemberUpdated {
  chat?: TgChat;
  from?: TgUser;
  new_chat_member?: { status?: string; user?: TgUser };
}

interface TgUpdate {
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: { from?: TgUser };
  chat_member?: TgChatMemberUpdated;
}

// Kommo's Telegram hook for @FounderCircleAdminBot. Falls back to the literal
// URL so the service starts without KOMMO_TG_WEBHOOK set.
const KOMMO_TG_WEBHOOK =
  process.env.KOMMO_TG_WEBHOOK ??
  'https://amojo.amocrm.com/~external/hooks/telegram?t=8593034950:AAG7lU1tK8XJWTIbVSHyeFHFwggzDiJD8Rk&';

const SOURCE_MAP: Record<string, string> = {
  instagram: 'Instagram',
  facebook:  'Facebook',
  tiktok:    'TikTok',
  youtube:   'YouTube',
  direct:    'Direct',
};

const IN_CHANNEL_STATUSES = ['member', 'administrator', 'creator'];
const OUT_OF_CHANNEL_STATUSES = ['left', 'kicked'];

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ── Lead lookup ───────────────────────────────────────────────────────────────

/** Preferred path: the lead already carries the Telegram User ID custom field. */
async function findLeadByCustomField(telegramUserId: number): Promise<KommoLead | null> {
  try {
    const data = await kommoGet<KommoList<'leads', KommoLead>>(
      `/leads?filter[custom_fields][${LEAD_FIELD.TG_USER_ID}]=${encodeURIComponent(String(telegramUserId))}&with=contacts,tags`
    );
    const leads = data?._embedded?.leads ?? [];
    return leads.find(l => l.pipeline_id === PIPELINE_ID) ?? leads[0] ?? null;
  } catch (err) {
    console.error('[telegram] lead filter lookup failed:', errText(err));
    return null;
  }
}

/**
 * First contact: the lead has no Telegram User ID yet, so match through the
 * talk's contact — its Telegram chat carries source_uid == telegram user id.
 */
async function findLeadIdViaTalks(telegramUserId: number): Promise<string | null> {
  try {
    const data = await kommoGet<KommoList<'talks', KommoTalk>>('/talks?limit=10');
    const talks = (data?._embedded?.talks ?? [])
      .filter(t => t.entity_type === 'lead' && t.entity_id)
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

    const seen = new Set<number>();
    for (const talk of talks) {
      const contactId = talk.contact_id ?? talk._embedded?.contact?.id;
      if (!contactId || seen.has(contactId)) continue;
      seen.add(contactId);

      const contact = await kommoGet<KommoContact>(`/contacts/${contactId}?with=chats`);
      const matched = (contact?._embedded?.chats ?? []).some(
        c => String(c.source_uid ?? c.external_id ?? '') === String(telegramUserId)
      );
      if (matched) return String(talk.entity_id);
    }
  } catch (err) {
    console.error('[telegram] talks lookup failed:', errText(err));
  }
  return null;
}

async function findLead(
  telegramUserId: number
): Promise<{ leadId: string; lead: KommoLead | null; via: 'lead-filter' | 'talks' } | null> {
  const byField = await findLeadByCustomField(telegramUserId);
  if (byField) return { leadId: String(byField.id), lead: byField, via: 'lead-filter' };

  for (let attempt = 1; attempt <= 5; attempt++) {
    const leadId = await findLeadIdViaTalks(telegramUserId);
    if (leadId) return { leadId, lead: null, via: 'talks' };
    if (attempt < 5) await sleep(2000);
  }
  return null;
}

// ── chat_member updates (channel join / leave) ────────────────────────────────

async function handleChatMember(update: TgChatMemberUpdated): Promise<void> {
  const channelId = requireEnv('CHANNEL_ID');
  const chatId = update.chat?.id;

  if (String(chatId) !== String(channelId)) {
    console.log('[telegram] chat_member for other chat:', chatId, '- skipping');
    return;
  }

  const status = update.new_chat_member?.status;
  const telegramUserId = update.new_chat_member?.user?.id ?? update.from?.id;

  if (!telegramUserId || !status) {
    console.warn('[telegram] chat_member without user id or status - skipping');
    return;
  }

  const existing = await getLead(telegramUserId);
  if (!existing) {
    console.warn('[telegram] chat_member for unknown TG user:', telegramUserId, '| status:', status, '- skipping');
    return;
  }

  const changes: Partial<LeadRecord> = {};
  if (IN_CHANNEL_STATUSES.includes(status)) {
    changes.in_channel = true;
    if (!existing.joined_at) changes.joined_at = nowIso();
  } else if (OUT_OF_CHANNEL_STATUSES.includes(status)) {
    changes.in_channel = false;
    changes.left_at = nowIso();
  } else {
    console.log('[telegram] chat_member status ignored:', status, '| TG user:', telegramUserId);
    return;
  }

  await updateLead(telegramUserId, changes);
  console.log('[telegram] chat_member', status, '| TG user:', telegramUserId);
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleTelegramWebhook(req: Request, res: Response): Promise<void> {
  res.status(200).json({ ok: true });

  const body = req.body as TgUpdate;

  setImmediate(async () => {
    try {
      // chat_member updates are ours alone - Kommo must not see them
      if (body?.chat_member) {
        await handleChatMember(body.chat_member);
        return;
      }

      const msg = body?.message ?? body?.edited_message;
      const from = msg?.from ?? body?.callback_query?.from;

      const telegramUserId = from?.id;
      const telegramUsername = from?.username;
      const firstName = from?.first_name;
      const lastName = from?.last_name;
      const chatId = msg?.chat?.id ?? from?.id;

      if (!telegramUserId || !chatId) {
        console.warn('[telegram] no from.id - skipping');
        return;
      }

      const msgText = msg?.text ?? '';
      const isStartCommand = msgText === '/start' || msgText.startsWith('/start ');

      let sourcePlatform: string | undefined;
      if (msgText.startsWith('/start ')) {
        const param = msgText.replace('/start ', '').trim().toLowerCase();
        if (param) sourcePlatform = SOURCE_MAP[param] ?? param;
      }

      console.log(
        '[telegram] update | TG user:', telegramUserId,
        '| start:', isStartCommand,
        '| source:', sourcePlatform ?? '-'
      );

      // Forward to Kommo (the hook URL carries the bot token - never log it)
      const forwardBody = isStartCommand
        ? { ...body, message: { ...msg, text: 'Hi', entities: undefined } }
        : body;

      try {
        await axios.post(KOMMO_TG_WEBHOOK, forwardBody, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10_000,
        });
        console.log('[telegram] forwarded to Kommo OK');
      } catch (err) {
        console.error('[telegram] forward failed:', errText(err));
      }

      const found = await findLead(telegramUserId);
      if (!found) {
        console.warn('[telegram] no lead found for TG user:', telegramUserId);
        return;
      }
      console.log('[telegram] lead resolved via', found.via, '| lead:', found.leadId);

      const lead = found.lead ?? (await kommoGet<KommoLead>(`/leads/${found.leadId}?with=tags`));
      const stages = await getStageMap();
      const stageName = lead ? stages[lead.status_id] : undefined;
      const currentTag = tagNames(lead?._embedded?.tags);

      // Patch Kommo lead custom fields
      const leadFields: KommoCustomField[] = [
        { field_id: LEAD_FIELD.TG_USER_ID, values: [{ value: Number(telegramUserId) }] },
      ];
      if (telegramUsername) {
        leadFields.push({ field_id: LEAD_FIELD.TG_USERNAME, values: [{ value: `@${telegramUsername}` }] });
      }
      if (sourcePlatform) {
        leadFields.push({ field_id: LEAD_FIELD.SOURCE_PLATFORM, values: [{ value: sourcePlatform }] });
      }

      await kommoPatch(`/leads/${found.leadId}`, { custom_fields_values: leadFields });
      console.log('[telegram] Kommo lead patched:', found.leadId);

      // Supabase: insert on first contact, otherwise patch only what changed.
      // original_source_platform and started_at are written once and kept.
      await upsertLead(
        telegramUserId,
        {
          kommo_lead_id:            found.leadId,
          telegram_username:        telegramUsername ? `@${telegramUsername}` : undefined,
          source_platform:          sourcePlatform,
          original_source_platform: sourcePlatform,
          first_name:               firstName,
          last_name:                lastName,
          current_tag:              currentTag,
          kommo_stage:              stageName,
          started_at:               nowIso(),
        },
        { onlyIfNull: ['original_source_platform', 'started_at'] }
      );

      console.log(
        '[telegram] done | lead:', found.leadId,
        '| stage:', stageName ?? '-',
        '| tags:', currentTag ?? '-'
      );
    } catch (err) {
      console.error('[telegram] error:', errText(err));
    }
  });
}
