"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.markLinkSent = markLinkSent;
const kommo_1 = require("../kommo");
const telegram_api_1 = require("../telegram-api");
const supabase_1 = require("./supabase");
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
 * Record that this person has the link. Kommo's "Greet and Join" bot sends the
 * greeting and the Join button itself, so the service sends nothing here — it
 * only writes down what Kommo just did, which is what the reminder loop, the
 * dashboard and the Kommo pipeline all read.
 *
 * The unban is still ours: while a leftover ban stands, every invite link tells
 * that person the link has expired.
 *
 * `link_sent_at` is stamped once and never moved, so the timeline still shows
 * when this person first got the link.
 */
async function markLinkSent(telegramUserId, known) {
    const row = known ?? (await (0, supabase_1.getLead)(telegramUserId));
    const changes = {
        join_message_sent: true,
        current_tag: withLinkSentTag(row?.current_tag),
    };
    if (!row?.link_sent_at)
        changes.link_sent_at = (0, supabase_1.nowIso)();
    await (0, supabase_1.updateLead)(telegramUserId, changes);
    await (0, telegram_api_1.unbanFromChannel)(telegramUserId);
    // Kommo only knows about this person once the forwarded message created the
    // lead, so on a brand new sign-up there is nothing to tag yet.
    if (row?.kommo_lead_id)
        await (0, kommo_1.addLeadTags)(row.kommo_lead_id, [LINK_SENT_TAG]);
    if (row?.kommo_contact_id)
        await (0, kommo_1.setContactStatus)(row.kommo_contact_id, 'link sent');
    console.log('[join] link marked sent | TG', telegramUserId);
}
