import { Request, Response } from 'express';
import axios from 'axios';
import { requireEnv, errText } from '../env';
import { ContactStatus, closeTalk, setContactStatus } from '../kommo';
import { pushPending } from '../pending';
import { nextQuestionFor } from '../questions';
import {
  answerCallbackQuery,
  getChatMemberStatus,
  isInChannelStatus,
  sendJoinMessage,
} from '../telegram-api';
import { sendJoinInvite, sendJoinRetry } from './join';
import { getLead, updateLead, upsertLead, nowIso, LeadRecord } from './supabase';
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
  message?: { chat?: TgChat };
}

interface TgUpdate {
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
  chat_member?: TgChatMemberUpdated;
}

/** callback_data of our own buttons. */
const JOINED_CALLBACK = 'fc_joined';
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

/** Where this person stands, as Kommo contact field 1003176 spells it. */
function statusFor(row: LeadRecord): ContactStatus {
  if (row.joined_at || row.in_channel) return 'joined';
  if (row.link_sent_at) return 'link sent';
  return (row.next_question as ContactStatus | null) ?? nextQuestionFor(row) ?? '';
}

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

function syntheticHi(user: TgUser, chatId: number): unknown {
  return {
    update_id: Date.now(),
    message: {
      message_id: Math.floor(Date.now() / 1000),
      from: {
        id: user.id,
        is_bot: false,
        first_name: user.first_name ?? '',
        last_name: user.last_name,
        username: user.username,
      },
      chat: {
        id: chatId,
        first_name: user.first_name ?? '',
        last_name: user.last_name,
        username: user.username,
        type: 'private',
      },
      date: Math.floor(Date.now() / 1000),
      text: 'Hi',
    },
  };
}

// ── "Continue" tap: pick the questions up where they stopped ──────────────────

async function handleContinueTap(query: TgCallbackQuery): Promise<void> {
  if (query.id) await answerCallbackQuery(query.id);

  const user = query.from;
  const telegramUserId = user?.id;
  if (!user || !telegramUserId) {
    console.warn('[resume] callback without from.id - skipping');
    return;
  }

  await updateLead(telegramUserId, { last_activity_at: nowIso() });

  const row = await getLead(telegramUserId);
  if (!row) {
    console.warn('[resume] no Supabase row for TG', telegramUserId, '- skipping');
    return;
  }

  const nextQuestion = nextQuestionFor(row);

  // Everything answered, they just never got in
  if (!nextQuestion) {
    await sendJoinMessage(telegramUserId);
    console.log('[resume] TG', telegramUserId, '-> all answered, join message resent');
    return;
  }

  if (row.next_question !== nextQuestion) {
    await updateLead(telegramUserId, { next_question: nextQuestion });
  }

  if (row.kommo_contact_id) {
    await setContactStatus(row.kommo_contact_id, nextQuestion);
  } else {
    console.warn('[resume] no contact id for TG', telegramUserId, '- Kommo not told where to resume');
  }

  if (row.kommo_talk_id) {
    await closeTalk(row.kommo_talk_id, telegramUserId);
    await sleep(1000);
  }

  const chatId = query.message?.chat?.id ?? telegramUserId;
  pushPending({
    telegram_user_id: telegramUserId,
    text_forwarded:   'Hi',
    display_name:     `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim(),
  });
  await forwardToKommo(syntheticHi(user, chatId));

  console.log('[resume] TG', telegramUserId, '->', nextQuestion);
}

// ── "I've Joined" tap ─────────────────────────────────────────────────────────

async function handleJoinedTap(query: TgCallbackQuery): Promise<void> {
  if (query.id) await answerCallbackQuery(query.id);

  const telegramUserId = query.from?.id;
  if (!telegramUserId) {
    console.warn('[join] callback without from.id - skipping');
    return;
  }

  await updateLead(telegramUserId, { last_activity_at: nowIso() });

  const status = await getChatMemberStatus(requireEnv('CHANNEL_ID'), telegramUserId);
  console.log('[join] I have joined tapped | TG user:', telegramUserId, '| status:', status ?? '-');

  if (isInChannelStatus(status)) {
    await welcomeUser(telegramUserId);
    return;
  }

  await sendJoinRetry(telegramUserId);

  const existing = await getLead(telegramUserId);

  if (existing) {
    await updateLead(telegramUserId, {
      join_check_failures: (existing.join_check_failures ?? 0) + 1,
    });
  }
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

      // Our own buttons: handled here, never forwarded to Kommo
      if (body?.callback_query?.data === JOINED_CALLBACK) {
        await handleJoinedTap(body.callback_query);
        return;
      }
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

      if (isStartCommand && existing) {
        // statusFor() points Kommo at the question they stopped on, so /start
        // resumes instead of starting over.
        if (existing.kommo_contact_id) {
          await setContactStatus(existing.kommo_contact_id, statusFor(existing));
        }

        if (existing.kommo_talk_id) {
          await closeTalk(existing.kommo_talk_id, telegramUserId);
          await sleep(1000);
        }
      }

      // Got the link but never made it in: any message brings the card back
      if (existing?.link_sent_at && !existing.joined_at && !existing.in_channel) {
        await sendJoinInvite(telegramUserId, existing);
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
    } catch (err) {
      console.error('[telegram] error:', errText(err));
    }
  });
}
