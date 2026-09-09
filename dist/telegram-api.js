"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WELCOME_TEXT = exports.NOT_IN_CHANNEL_TEXT = exports.JOIN_TEXT = void 0;
exports.inviteLink = inviteLink;
exports.joinKeyboard = joinKeyboard;
exports.sendMessageResult = sendMessageResult;
exports.sendMessage = sendMessage;
exports.unbanFromChannel = unbanFromChannel;
exports.sendJoinMessage = sendJoinMessage;
exports.sendNotJoinedMessage = sendNotJoinedMessage;
exports.continueKeyboard = continueKeyboard;
exports.sendReminder = sendReminder;
exports.answerCallbackQuery = answerCallbackQuery;
exports.getChatMemberStatus = getChatMemberStatus;
exports.isInChannelStatus = isInChannelStatus;
const axios_1 = __importDefault(require("axios"));
const env_1 = require("./env");
/** Founder Circle invite link. Overridable without a deploy. */
const DEFAULT_INVITE_LINK = 'https://t.me/+PSbwbTVOCeU0NWJk';
function inviteLink() {
    return process.env.CHANNEL_INVITE_LINK || DEFAULT_INVITE_LINK;
}
/** Join + confirm buttons, shown with the join message and the retry. */
function joinKeyboard() {
    return {
        inline_keyboard: [
            [{ text: 'Join Founder Circle', url: inviteLink() }],
            [{ text: "✅ I've Joined", callback_data: 'fc_joined' }],
        ],
    };
}
exports.JOIN_TEXT = 'You did it. 🎉 Tap Join Founder Circle, and once you are in, tap I\'ve Joined so I can welcome you.';
exports.NOT_IN_CHANNEL_TEXT = 'I looked, but I cannot see you in the channel yet. No stress, it happens. Join first, then tap I\'ve Joined again.';
exports.WELCOME_TEXT = 'You are in. Welcome to Founder Circle! 🙌\n\n' +
    'You are now inside my private circle, the part that is not open to the public. ' +
    'This is where I share the real numbers, the real decisions and the things that never make it to the feed. Unfiltered.\n\n' +
    'Glad you are here.\nFahad';
const IN_CHANNEL_STATUSES = ['member', 'administrator', 'creator'];
function api(method) {
    return `https://api.telegram.org/bot${(0, env_1.requireEnv)('BOT_TOKEN')}/${method}`;
}
/**
 * Send a message, reporting whether the person has blocked the bot. Callers
 * that only care whether it went out can use sendMessage().
 */
async function sendMessageResult(chatId, text, replyMarkup) {
    try {
        await axios_1.default.post(api('sendMessage'), { chat_id: chatId, text, reply_markup: replyMarkup, disable_web_page_preview: true }, { timeout: 10000 });
        return { ok: true, blocked: false };
    }
    catch (err) {
        if (axios_1.default.isAxiosError(err) && err.response?.status === 403) {
            console.warn('[telegram-api] TG', chatId, 'has blocked the bot - message not sent');
            return { ok: false, blocked: true };
        }
        console.error('[telegram-api] sendMessage failed for TG', chatId, '|', (0, env_1.errText)(err));
        return { ok: false, blocked: false };
    }
}
/** Send a message. False when Telegram refused it, for any reason. */
async function sendMessage(chatId, text, replyMarkup) {
    return (await sendMessageResult(chatId, text, replyMarkup)).ok;
}
/**
 * Lift the ban Telegram applies when an admin removes someone from the
 * channel — while it stands, every invite link tells that person the link has
 * expired. Harmless for anyone who is not banned, and failures do not matter.
 */
async function unbanFromChannel(telegramUserId) {
    try {
        await axios_1.default.post(api('unbanChatMember'), { chat_id: (0, env_1.requireEnv)('CHANNEL_ID'), user_id: telegramUserId, only_if_banned: true }, { timeout: 10000 });
        // Telegram answers the same whether or not a ban existed, so this only
        // records that we asked.
        console.log('[invite] unban called for TG', telegramUserId);
    }
    catch {
        // Ignored on purpose: the bot may not be an admin, or the person was never banned
    }
}
/** The join invitation, sent once the email has been accepted. */
async function sendJoinMessage(telegramUserId) {
    await unbanFromChannel(telegramUserId);
    const sent = await sendMessage(telegramUserId, exports.JOIN_TEXT, joinKeyboard());
    if (sent)
        console.log('[join] message sent to TG', telegramUserId);
    return sent;
}
/** Shown when "I've Joined" was tapped but the person is not in the channel. */
async function sendNotJoinedMessage(telegramUserId) {
    await unbanFromChannel(telegramUserId);
    return sendMessage(telegramUserId, exports.NOT_IN_CHANNEL_TEXT, joinKeyboard());
}
/** The single button under a reminder. */
function continueKeyboard() {
    return { inline_keyboard: [[{ text: 'Continue ▶️', callback_data: 'fc_continue' }]] };
}
/** A reminder for someone who stopped halfway through the questions. */
async function sendReminder(telegramUserId, text) {
    return sendMessageResult(telegramUserId, text, continueKeyboard());
}
/** Stop the button's spinner. Failures here are cosmetic. */
async function answerCallbackQuery(callbackQueryId, text) {
    try {
        await axios_1.default.post(api('answerCallbackQuery'), { callback_query_id: callbackQueryId, text }, { timeout: 10000 });
    }
    catch (err) {
        console.warn('[telegram-api] answerCallbackQuery failed:', (0, env_1.errText)(err));
    }
}
/** Raw chat member status, or undefined when Telegram would not say. */
async function getChatMemberStatus(chatId, telegramUserId) {
    try {
        const resp = await axios_1.default.get(api('getChatMember'), {
            params: { chat_id: chatId, user_id: telegramUserId },
            timeout: 10000,
        });
        return resp.data?.result?.status;
    }
    catch (err) {
        console.error('[telegram-api] getChatMember failed for TG', telegramUserId, '|', (0, env_1.errText)(err));
        return undefined;
    }
}
function isInChannelStatus(status) {
    return !!status && IN_CHANNEL_STATUSES.includes(status);
}
