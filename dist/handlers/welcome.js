"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.welcomeUser = welcomeUser;
const kommo_1 = require("../kommo");
const telegram_api_1 = require("../telegram-api");
const supabase_1 = require("./supabase");
const LINK_SENT_TAG = 'Link sent';
const JOINED_TAG = 'Joined Channel';
/** Move the Kommo lead to Joined Channel and swap its tag over. */
async function markLeadJoined(row) {
    if (!row.kommo_lead_id)
        return;
    const lead = await (0, kommo_1.get)(`/leads/${row.kommo_lead_id}?with=tags`);
    const linkSentTags = (lead?._embedded?.tags ?? []).filter(t => t.name?.toLowerCase() === LINK_SENT_TAG.toLowerCase());
    const body = {
        status_id: kommo_1.STAGE.JOINED_CHANNEL,
        tags_to_add: [{ name: JOINED_TAG }],
    };
    if (linkSentTags.length > 0)
        body.tags_to_delete = linkSentTags.map(t => t.id);
    await (0, kommo_1.patch)(`/leads/${row.kommo_lead_id}`, body);
    if (row.kommo_contact_id)
        await (0, kommo_1.setContactStatus)(row.kommo_contact_id, 'joined');
    if (row.kommo_talk_id)
        await (0, kommo_1.closeTalk)(row.kommo_talk_id, row.telegram_user_id ?? '-');
}
/**
 * Everything that happens once someone is confirmed inside the channel:
 * the welcome message, the Supabase timeline, and the Kommo move.
 *
 * The membership state is always refreshed — someone can leave and come back —
 * but the message and the Kommo move happen once per row, guarded on
 * welcome_sent.
 */
async function welcomeUser(telegramUserId, known) {
    const row = known ?? (await (0, supabase_1.getLead)(telegramUserId));
    if (!row) {
        console.warn('[welcome] no Supabase row for TG', telegramUserId, '- skipping');
        return;
    }
    const changes = { in_channel: true };
    if (!row.joined_at)
        changes.joined_at = (0, supabase_1.nowIso)();
    if (row.welcome_sent) {
        await (0, supabase_1.updateLead)(telegramUserId, changes);
        console.log('[welcome] TG', telegramUserId, '| already welcomed - membership refreshed');
        return;
    }
    const sent = await (0, telegram_api_1.sendMessage)(telegramUserId, telegram_api_1.WELCOME_TEXT);
    if (sent)
        changes.welcome_sent = true;
    await (0, supabase_1.updateLead)(telegramUserId, changes);
    await markLeadJoined(row);
    console.log('[welcome] TG', telegramUserId);
}
