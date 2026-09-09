"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendJoinCard = sendJoinCard;
exports.sendJoinInvite = sendJoinInvite;
exports.sendJoinRetry = sendJoinRetry;
const kommo_1 = require("../kommo");
const telegram_api_1 = require("../telegram-api");
const supabase_1 = require("./supabase");
/** Two automatic join messages closer together than this are the same nudge twice. */
const MIN_GAP_MS = 60000;
const LINK_SENT_TAG = 'Link sent';
/** The row's tags with `Link sent` in them, however many it already had. */
function withLinkSentTag(current) {
    const names = (current ?? '').split(',').map(name => name.trim()).filter(Boolean);
    if (!names.some(name => name.toLowerCase() === LINK_SENT_TAG.toLowerCase())) {
        names.push(LINK_SENT_TAG);
    }
    return names.join(', ');
}
/**
 * The greeting-only flow's one and only card: mark the row as "link sent" —
 * what the reminder loop, the dashboard and Kommo all read — then send it.
 *
 * `link_sent_at` is stamped once and never moved, so the timeline still shows
 * when this person first got the link.
 */
async function sendJoinCard(telegramUserId, known) {
    const row = known ?? (await (0, supabase_1.getLead)(telegramUserId));
    const changes = {
        join_message_sent: true,
        join_message_sent_at: (0, supabase_1.nowIso)(),
        current_tag: withLinkSentTag(row?.current_tag),
    };
    if (!row?.link_sent_at)
        changes.link_sent_at = (0, supabase_1.nowIso)();
    await (0, supabase_1.updateLead)(telegramUserId, changes);
    // Kommo only knows about this person once the forwarded message created the
    // lead, so on a brand new sign-up there is nothing to tag yet.
    if (row?.kommo_lead_id)
        await (0, kommo_1.addLeadTags)(row.kommo_lead_id, [LINK_SENT_TAG]);
    if (row?.kommo_contact_id)
        await (0, kommo_1.setContactStatus)(row.kommo_contact_id, 'link sent');
    return (0, telegram_api_1.sendJoinMessage)(telegramUserId);
}
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
