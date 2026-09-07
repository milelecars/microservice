import { Request, Response } from 'express';
import axios from 'axios';
import { requireEnv, errText } from '../env';
import { ContactStatus, closeTalk, setContactStatus } from '../kommo';
import { pushPending } from '../pending';
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
  callback_query?: { from?: TgUser; data?: string };
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

/** Where this person stands, as Kommo contact field 1003176 spells it. */
function statusFor(row: LeadRecord): ContactStatus {
  if (row.joined_at || row.in_channel) return 'joined';
  if (row.link_sent_at) return 'link sent';
  return '';
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
    if (existing.kommo_contact_id) await setContactStatus(existing.kommo_contact_id, 'joined');
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

      const msgText = msg?.text ?? body?.callback_query?.data ?? '';
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

      // Returning user pressing /start: close the talk they left open, so
      // Kommo treats what follows as a new conversation and the Salesbot runs
      // again. First-time users have no row and no talk, and ordinary messages
      // must never close anything.
      if (isStartCommand) {
        const existing = await getLead(telegramUserId);

        if (existing?.kommo_contact_id) {
          await setContactStatus(existing.kommo_contact_id, statusFor(existing));
        }

        if (existing?.kommo_talk_id) {
          await closeTalk(existing.kommo_talk_id, telegramUserId);
          await sleep(1000);
        }
      }

      // Forward to Kommo (the hook URL carries the bot token - never log it)
      const forwardBody = isStartCommand
        ? { ...body, message: { ...msg, text: 'Hi', entities: undefined } }
        : body;

      // Remember what Kommo is about to receive, so /webhook/message can match
      // this Telegram user back to the lead Kommo creates. Queued before the
      // forward — Kommo's webhook can beat our own response back to us.
      const textForwarded = isStartCommand ? 'Hi' : msgText;
      const displayName = `${firstName ?? ''} ${lastName ?? ''}`.trim();
      if (textForwarded) {
        pushPending({
          telegram_user_id: telegramUserId,
          text_forwarded:   textForwarded,
          display_name:     displayName,
        });
      }

      try {
        await axios.post(KOMMO_TG_WEBHOOK, forwardBody, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10_000,
        });
        console.log('[telegram] forwarded to Kommo OK');
      } catch (err) {
        console.error('[telegram] forward failed:', errText(err));
      }

      // The Kommo lead does not exist yet at this point — /webhook/message links
      // the lead and contact once Kommo has created them. Here we only keep the
      // Telegram identity and the traffic source, keyed on telegram_user_id.
      await upsertLead(
        telegramUserId,
        {
          telegram_username:        telegramUsername ? `@${telegramUsername}` : undefined,
          source_platform:          sourcePlatform,
          original_source_platform: sourcePlatform,
          first_name:               firstName,
          last_name:                lastName,
          started_at:               nowIso(),
        },
        { onlyIfNull: ['original_source_platform', 'started_at'] }
      );

      console.log('[telegram] row upserted | TG user:', telegramUserId);
    } catch (err) {
      console.error('[telegram] error:', errText(err));
    }
  });
}
