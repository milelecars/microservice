"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncContactAnswers = syncContactAnswers;
exports.handleContactUpdate = handleContactUpdate;
const env_1 = require("../env");
const kommo_1 = require("../kommo");
const identity_1 = require("./identity");
const join_1 = require("./join");
const supabase_1 = require("./supabase");
/**
 * Copy the contact's name and the lead's tags onto the Supabase row, and keep
 * the Kommo ids in sync. Used by both the Kommo contact webhook and every
 * incoming message.
 *
 * The bot asks no questions any more, so country, age, interest, phone and
 * email are never read back — rows from the question era keep whatever they
 * already hold, and new rows simply leave those columns null.
 */
async function syncContactAnswers(contactId, leadId, telegramUserId) {
    const contact = await (0, kommo_1.get)(`/contacts/${contactId}`);
    if (!contact) {
        console.warn('[answers] contact not found:', contactId);
        return;
    }
    const lead = await (0, kommo_1.get)(`/leads/${leadId}?with=tags`);
    const tags = lead?._embedded?.tags;
    const status = (0, kommo_1.fieldValue)(contact.custom_fields_values, kommo_1.CONTACT_FIELD.STATUS);
    const data = {
        kommo_lead_id: String(leadId),
        kommo_contact_id: String(contactId),
        name: contact.name?.trim() || undefined,
        current_tag: (0, kommo_1.tagNames)(tags),
    };
    if ((0, kommo_1.hasTag)(tags, 'Link sent'))
        data.link_sent_at = (0, supabase_1.nowIso)();
    const existing = await (0, supabase_1.getLead)(telegramUserId);
    if (!existing) {
        const record = { ...data, telegram_user_id: Number(telegramUserId) };
        for (const key of Object.keys(record)) {
            if (record[key] === undefined)
                delete record[key];
        }
        await (0, supabase_1.insertLead)(record);
        console.log('[answers] TG', telegramUserId, '| row created');
        await syncStatusField(contactId, status, record);
        if (record.link_sent_at)
            await inviteToChannel(telegramUserId);
        return;
    }
    const changes = (0, supabase_1.diffLead)(existing, data, ['link_sent_at']);
    const changed = Object.keys(changes);
    // link_sent_at only appears in the diff the first time the tag shows up
    const linkJustSent = changes.link_sent_at !== undefined && !existing.join_message_sent;
    await syncStatusField(contactId, status, { ...existing, ...changes });
    if (changed.length === 0) {
        console.log('[answers] TG', telegramUserId, '| no change');
        return;
    }
    await (0, supabase_1.updateLead)(telegramUserId, changes);
    console.log('[answers] TG', telegramUserId, '| updated:', changed.join(', '));
    if (linkJustSent)
        await inviteToChannel(telegramUserId);
}
/**
 * Keep contact field 1003176 in step with the row. The greeting sends the card
 * before Kommo has a contact to write to, so this is where a brand new lead's
 * "link sent" lands. Only written when it would actually change.
 */
async function syncStatusField(contactId, current, row) {
    const desired = (0, kommo_1.contactStatusFor)(row);
    if (!desired || desired === current)
        return;
    await (0, kommo_1.setContactStatus)(contactId, desired);
}
/** Send the join invitation once, and remember that we did. */
async function inviteToChannel(telegramUserId) {
    const sent = await (0, join_1.sendJoinInvite)(telegramUserId);
    if (sent)
        await (0, supabase_1.updateLead)(telegramUserId, { join_message_sent: true });
}
/** The lead this contact is linked to inside the Founder Circle pipeline. */
async function findPipelineLead(contact) {
    for (const ref of contact._embedded?.leads ?? []) {
        const lead = await (0, kommo_1.get)(`/leads/${ref.id}?with=tags`);
        if (lead && lead.pipeline_id === kommo_1.PIPELINE_ID)
            return lead;
    }
    return null;
}
// Called by the Kommo account webhook on "Contact added" and "Contact updated"
async function handleContactUpdate(req, res) {
    res.status(200).json({ ok: true });
    const body = req.body;
    setImmediate(async () => {
        try {
            const raw = body?.contacts?.update?.[0]?.id ?? body?.contacts?.add?.[0]?.id;
            if (!raw) {
                console.warn('[contact] no contact in payload - skipping');
                return;
            }
            const contactId = String(raw);
            const contact = await (0, kommo_1.get)(`/contacts/${contactId}?with=leads`);
            if (!contact) {
                console.warn('[contact] contact not found:', contactId);
                return;
            }
            const lead = await findPipelineLead(contact);
            if (!lead) {
                console.warn('[contact] no lead in pipeline', kommo_1.PIPELINE_ID, 'for contact:', contactId, '- skipping');
                return;
            }
            const { telegramUserId } = await (0, identity_1.resolveTelegramId)('[contact]', lead, lead.id, contactId);
            if (!telegramUserId) {
                console.warn('[contact] could not resolve TG user ID | lead:', lead.id, '| contact:', contactId, '- skipping');
                return;
            }
            await syncContactAnswers(contactId, lead.id, telegramUserId);
            console.log('[contact] synced | contact:', contactId, '| lead:', lead.id, '| TG user:', telegramUserId);
        }
        catch (err) {
            console.error('[contact] error:', (0, env_1.errText)(err));
        }
    });
}
