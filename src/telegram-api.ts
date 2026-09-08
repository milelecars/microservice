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

/** Join + confirm buttons, shown with the join message and the retry. */
export function joinKeyboard(): ReplyMarkup {
  return {
    inline_keyboard: [
      [{ text: 'Join Founder Circle', url: inviteLink() }],
      [{ text: "✅ I've Joined", callback_data: 'fc_joined' }],
    ],
  };
}

export const JOIN_TEXT =
  'You did it. 🎉 Tap Join Founder Circle, and once you are in, tap I\'ve Joined so I can welcome you.';

export const NOT_IN_CHANNEL_TEXT =
  'I looked, but I cannot see you in the channel yet. No stress, it happens. Join first, then tap I\'ve Joined again.';

export const WELCOME_TEXT =
  'You are in. Welcome to Founder Circle! 🙌\n\n' +
  'You are now inside my private circle, the part that is not open to the public. ' +
  'This is where I share the real numbers, the real decisions and the things that never make it to the feed. Unfiltered.\n\n' +
  'Glad you are here.\nFahad';

const IN_CHANNEL_STATUSES = ['member', 'administrator', 'creator'];

function api(method: string): string {
  return `https://api.telegram.org/bot${requireEnv('BOT_TOKEN')}/${method}`;
}

/**
 * Send a message. Returns false when Telegram refused it — 403 means the
 * person blocked the bot, which is normal and only worth a log line.
 */
export async function sendMessage(
  chatId: number | string,
  text: string,
  replyMarkup?: ReplyMarkup
): Promise<boolean> {
  try {
    await axios.post(
      api('sendMessage'),
      { chat_id: chatId, text, reply_markup: replyMarkup, disable_web_page_preview: true },
      { timeout: 10_000 }
    );
    return true;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 403) {
      console.warn('[telegram-api] TG', chatId, 'has blocked the bot - message not sent');
      return false;
    }
    console.error('[telegram-api] sendMessage failed for TG', chatId, '|', errText(err));
    return false;
  }
}

/**
 * Lift the ban Telegram applies when an admin removes someone from the
 * channel — while it stands, every invite link tells that person the link has
 * expired. Harmless for anyone who is not banned, and failures do not matter.
 */
export async function unbanFromChannel(telegramUserId: number | string): Promise<void> {
  try {
    const resp = await axios.post<{ result?: boolean }>(
      api('unbanChatMember'),
      { chat_id: requireEnv('CHANNEL_ID'), user_id: telegramUserId, only_if_banned: true },
      { timeout: 10_000 }
    );
    if (resp.data?.result === true) console.log('[invite] unbanned TG', telegramUserId);
  } catch {
    // Ignored on purpose: the bot may not be an admin, or the person was never banned
  }
}

/** The join invitation, sent once the email has been accepted. */
export async function sendJoinMessage(telegramUserId: number | string): Promise<boolean> {
  await unbanFromChannel(telegramUserId);
  const sent = await sendMessage(telegramUserId, JOIN_TEXT, joinKeyboard());
  if (sent) console.log('[join] message sent to TG', telegramUserId);
  return sent;
}

/** Shown when "I've Joined" was tapped but the person is not in the channel. */
export async function sendNotJoinedMessage(telegramUserId: number | string): Promise<boolean> {
  await unbanFromChannel(telegramUserId);
  return sendMessage(telegramUserId, NOT_IN_CHANNEL_TEXT, joinKeyboard());
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
