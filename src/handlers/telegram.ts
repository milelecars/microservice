import { Request, Response } from 'express';
import axios from 'axios';
import { requireEnv, errText } from '../env';
import { closeTalk, contactStatusFor, setContactStatus } from '../kommo';
import { pushPending } from '../pending';
import { tagResumedAfterReminder } from '../reminders';
import { reviveLead } from '../revive';
import { answerCallbackQuery, sendJoinMessage } from '../telegram-api';
import { markLinkSent } from './join';
import { getLead, updateLead, upsertLead, nowIso } from './supabase';
import { welcomeUser } from './welcome';

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

interface TgCallbackQuery {
  id?: string;
  from?: TgUser;
  data?: string;
}

interface TgUpdate {
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
  chat_member?: TgChatMemberUpdated;
}

/** callback_data of the Continue button on a reminder. */
const CONTINUE_CALLBACK = 'fc_continue';

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

/** Forward a plain "Hi" to Kommo in the shape Telegram would have sent it. */
async function forwardToKommo(update: unknown): Promise<void> {
  try {
    await axios.post(KOMMO_TG_WEBHOOK, update, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10_000,
    });
    console.log('[telegram] forwarded to Kommo OK');
  } catch (err) {
    console.error('[telegram] forward failed:', errText(err));
  }
}

// ── "Continue" tap: the reminder's button, which resends the join card ────────
//
// Joining is picked up by the chat_member event, so this is the only callback
// the bot still puts in front of anyone.

async function handleContinueTap(query: TgCallbackQuery): Promise<void> {
  if (query.id) await answerCallbackQuery(query.id);

  const telegramUserId = query.from?.id;
  if (!telegramUserId) {
    console.warn('[resume] callback without from.id - skipping');
    return;
  }

  await updateLead(telegramUserId, { last_activity_at: nowIso() });

  const row = await getLead(telegramUserId);
  if (!row) {
    console.warn('[resume] no Supabase row for TG', telegramUserId, '- skipping');
    return;
  }

  await tagResumedAfterReminder(row);
  await reviveLead(telegramUserId, row);
  await sendJoinMessage(telegramUserId);

  console.log('[resume] TG', telegramUserId, '-> join card resent');
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

  if (IN_CHANNEL_STATUSES.includes(status)) {
    // Telegram saw the join first hand — same routine as the button
    await welcomeUser(telegramUserId, existing);
    // After the welcome: it has usually just moved the lead to Joined Channel,
    // and the read inside reviveLead then leaves the stage alone.
    await reviveLead(telegramUserId, existing, { joined: true });
    console.log('[telegram] chat_member', status, '| TG user:', telegramUserId);
    return;
  }

  if (!OUT_OF_CHANNEL_STATUSES.includes(status)) {
    console.log('[telegram] chat_member status ignored:', status, '| TG user:', telegramUserId);
    return;
  }

  await updateLead(telegramUserId, { in_channel: false, left_at: nowIso() });
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

      // Our own button: handled here, never forwarded to Kommo
      if (body?.callback_query?.data === CONTINUE_CALLBACK) {
        await handleContinueTap(body.callback_query);
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
      const existing = await getLead(telegramUserId);

      // Anything at all from someone written off as Lost brings them back,
      // whether it is `/start` or an ordinary message.
      await reviveLead(telegramUserId, existing);

      if (isStartCommand && existing) {
        await tagResumedAfterReminder(existing);

        // Tell Kommo where this person stands before the forwarded message
        // reaches the Salesbot.
        if (existing.kommo_contact_id) {
          await setContactStatus(existing.kommo_contact_id, contactStatusFor(existing));
        }

        if (existing.kommo_talk_id) {
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

      await forwardToKommo(forwardBody);

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
          last_activity_at:         nowIso(),
        },
        { onlyIfNull: ['original_source_platform', 'started_at'] }
      );

      console.log('[telegram] row upserted | TG user:', telegramUserId);

      // The greeting card is ours: sent from Kommo, its button would be
      // rewritten to a kommo.cc link. Every /start is answered with it — or
      // with the one-liner, for someone who is already inside.
      if (isStartCommand) {
        await markLinkSent(telegramUserId, existing);
      }
    } catch (err) {
      console.error('[telegram] error:', errText(err));
    }
  });
}
