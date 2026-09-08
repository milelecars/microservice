"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendJoinInvite = sendJoinInvite;
exports.sendJoinRetry = sendJoinRetry;
const telegram_api_1 = require("../telegram-api");
const supabase_1 = require("./supabase");
/** Two automatic join messages closer together than this are the same nudge twice. */
const MIN_GAP_MS = 60000;
async function stamp(telegramUserId) {
    await (0, supabase_1.updateLead)(telegramUserId, { join_message_sent_at: (0, supabase_1.nowIso)() });
}
/**
 * The join invitation. This one is automatic — link_sent detection and /start
 * can both fire within seconds of each other — so it is throttled.
 */
async function sendJoinInvite(telegramUserId, known) {
    const row = known ?? (await (0, supabase_1.getLead)(telegramUserId));
    const lastSent = row?.join_message_sent_at ? Date.parse(row.join_message_sent_at) : NaN;
    if (!Number.isNaN(lastSent) && Date.now() - lastSent < MIN_GAP_MS) {
        console.log('[join] suppressed duplicate | TG', telegramUserId);
        return false;
    }
    const sent = await (0, telegram_api_1.sendJoinMessage)(telegramUserId);
    if (sent)
        await stamp(telegramUserId);
    return sent;
}
/**
 * The "cannot see you yet" retry. Never throttled: the person just tapped the
 * button and is owed an answer, however often they tap.
 */
async function sendJoinRetry(telegramUserId) {
    const sent = await (0, telegram_api_1.sendNotJoinedMessage)(telegramUserId);
    if (sent)
        await stamp(telegramUserId);
    return sent;
}
