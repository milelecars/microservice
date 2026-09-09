import axios from 'axios';
import { requireEnv, errText } from './env';

/** Founder Circle invite link. Overridable without a deploy. */
const DEFAULT_INVITE_LINK = 'https://t.me/+PSbwbTVOCeU0NWJk';

export function inviteLink(): string {
  return process.env.CHANNEL_INVITE_LINK || DEFAULT_INVITE_LINK;
}

export interface InlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface ReplyMarkup {
  inline_keyboard: InlineButton[][];
}

/** The one button under the card: straight into the channel. */
export function joinKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: 'Join Founder Circle', url: inviteLink() }],
    ],
  };
}

/** What the card says when the caller has nothing more specific to say. */
export const JOIN_TEXT = 'Still one tap away 👋 Tap Join Founder Circle and you are in.';

export const WELCOME_TEXT =
  'You are in. Welcome to Founder Circle! 🙌\n\n' +
  'You are now inside my private circle, the part that is not open to the public. ' +
  'This is where I share the real numbers, the real decisions and the things that never make it to the feed. Unfiltered.\n\n' +
  'Glad you are here.\nFahad';

const IN_CHANNEL_STATUSES = ['member', 'administrator', 'creator'];

function api(method: string): string {
  return `https://api.telegram.org/bot${requireEnv('BOT_TOKEN')}/${method}`;
}

export interface SendResult {
  ok: boolean;
  /** 403 — the person blocked the bot, so there is no point trying again. */
  blocked: boolean;
}

/**
 * Send a message, reporting whether the person has blocked the bot. Callers
 * that only care whether it went out can use sendMessage().
 */
export async function sendMessageResult(
  chatId: number | string,
  text: string,
  replyMarkup?: ReplyMarkup
): Promise<SendResult> {
  try {
    await axios.post(
      api('sendMessage'),
      { chat_id: chatId, text, reply_markup: replyMarkup, disable_web_page_preview: true },
      { timeout: 10_000 }
    );
    return { ok: true, blocked: false };
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 403) {
      console.warn('[telegram-api] TG', chatId, 'has blocked the bot - message not sent');
      return { ok: false, blocked: true };
    }
    console.error('[telegram-api] sendMessage failed for TG', chatId, '|', errText(err));
    return { ok: false, blocked: false };
  }
}

/** Send a message. False when Telegram refused it, for any reason. */
export async function sendMessage(
  chatId: number | string,
  text: string,
  replyMarkup?: ReplyMarkup
): Promise<boolean> {
  return (await sendMessageResult(chatId, text, replyMarkup)).ok;
}

/**
 * Lift the ban Telegram applies when an admin removes someone from the
 * channel — while it stands, every invite link tells that person the link has
 * expired. Harmless for anyone who is not banned, and failures do not matter.
 */
export async function unbanFromChannel(telegramUserId: number | string): Promise<void> {
  try {
    await axios.post(
      api('unbanChatMember'),
      { chat_id: requireEnv('CHANNEL_ID'), user_id: telegramUserId, only_if_banned: true },
      { timeout: 10_000 }
    );
    // Telegram answers the same whether or not a ban existed, so this only
    // records that we asked.
    console.log('[invite] unban called for TG', telegramUserId);
  } catch {
    // Ignored on purpose: the bot may not be an admin, or the person was never banned
  }
}

/**
 * The join card. Kommo's own "Greet and Join" bot sends the greeting and this
 * button on every new conversation, so the service only sends the card as a
 * nudge: the reminder ladder, and the Continue button on nudges already out
 * there. The unban first is what makes the link work for someone an admin
 * once removed from the channel.
 *
 * The button never changes; `text` is what each rung of the ladder says above
 * it.
 */
export async function sendJoinMessage(
  telegramUserId: number | string,
  text: string = JOIN_TEXT
): Promise<SendResult> {
  await unbanFromChannel(telegramUserId);
  const result = await sendMessageResult(telegramUserId, text, joinKeyboard());
  if (result.ok) console.log('[join] card sent to TG', telegramUserId);
  return result;
}

/** Stop the button's spinner. Failures here are cosmetic. */
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await axios.post(
      api('answerCallbackQuery'),
      { callback_query_id: callbackQueryId, text },
      { timeout: 10_000 }
    );
  } catch (err) {
    console.warn('[telegram-api] answerCallbackQuery failed:', errText(err));
  }
}

/** Raw chat member status, or undefined when Telegram would not say. */
export async function getChatMemberStatus(
  chatId: string | number,
  telegramUserId: string | number
): Promise<string | undefined> {
  try {
    const resp = await axios.get<{ result?: { status?: string } }>(api('getChatMember'), {
      params: { chat_id: chatId, user_id: telegramUserId },
      timeout: 10_000,
    });
    return resp.data?.result?.status;
  } catch (err) {
    console.error('[telegram-api] getChatMember failed for TG', telegramUserId, '|', errText(err));
    return undefined;
  }
}

export function isInChannelStatus(status: string | undefined): boolean {
  return !!status && IN_CHANNEL_STATUSES.includes(status);
}
