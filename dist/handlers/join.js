"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendJoinInvite = sendJoinInvite;
exports.sendJoinRetry = sendJoinRetry;
const telegram_api_1 = require("../telegram-api");
const supabase_1 = require("./supabase");
/** Two join messages closer together than this are the same nudge twice. */
const MIN_GAP_MS = 60000;
async function sendOnce(telegramUserId, send, known) {
    const row = known ?? (await (0, supabase_1.getLead)(telegramUserId));
    const lastSent = row?.join_message_sent_at ? Date.parse(row.join_message_sent_at) : NaN;
    if (!Number.isNaN(lastSent) && Date.now() - lastSent < MIN_GAP_MS) {
        console.log('[join] suppressed duplicate | TG', telegramUserId);
        return false;
    }
    const sent = await send(telegramUserId);
    if (sent)
        await (0, supabase_1.updateLead)(telegramUserId, { join_message_sent_at: (0, supabase_1.nowIso)() });
    return sent;
}
/** The join invitation — at most one per minute per person. */
async function sendJoinInvite(telegramUserId, known) {
    return sendOnce(telegramUserId, telegram_api_1.sendJoinMessage, known);
}
/** The "cannot see you yet" retry — throttled the same way. */
async function sendJoinRetry(telegramUserId, known) {
    return sendOnce(telegramUserId, telegram_api_1.sendNotJoinedMessage, known);
}
