"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleContactUpdate = handleContactUpdate;
const env_1 = require("../env");
const kommo_1 = require("../kommo");
const supabase_1 = require("./supabase");
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
            const fields = contact.custom_fields_values;
            const name = contact.name?.trim() || undefined;
            const phone = (0, kommo_1.fieldValue)(fields, kommo_1.CONTACT_FIELD.PHONE);
            const email = (0, kommo_1.fieldValue)(fields, kommo_1.CONTACT_FIELD.EMAIL);
            const country = (0, kommo_1.fieldValue)(fields, kommo_1.CONTACT_FIELD.COUNTRY);
            const ageBracket = (0, kommo_1.fieldValue)(fields, kommo_1.CONTACT_FIELD.AGE);
            const interest = (0, kommo_1.fieldValue)(fields, kommo_1.CONTACT_FIELD.INTEREST);
            const lead = await findPipelineLead(contact);
            if (!lead) {
                console.warn('[contact] no lead in pipeline', kommo_1.PIPELINE_ID, 'for contact:', contactId, '- skipping');
                return;
            }
            const telegramUserId = (0, kommo_1.fieldValue)(lead.custom_fields_values, kommo_1.LEAD_FIELD.TG_USER_ID);
            if (!telegramUserId) {
                console.warn('[contact] no Telegram User ID on lead:', lead.id, '- skipping');
                return;
            }
            const tags = lead._embedded?.tags;
            const currentTag = (0, kommo_1.tagNames)(tags);
            const linkSent = (0, kommo_1.hasTag)(tags, 'Link sent');
            const data = {
                kommo_lead_id: String(lead.id),
                kommo_contact_id: contactId,
                name,
                phone,
                email,
                country,
                age_bracket: ageBracket,
                interest,
                current_tag: currentTag,
            };
            if (linkSent)
                data.link_sent_at = (0, supabase_1.nowIso)();
            await (0, supabase_1.upsertLead)(Number(telegramUserId), data, { onlyIfNull: ['link_sent_at'] });
            console.log('[contact] synced | contact:', contactId, '| lead:', lead.id, '| TG user:', telegramUserId, '| tags:', currentTag ?? '-');
        }
        catch (err) {
            console.error('[contact] error:', (0, env_1.errText)(err));
        }
    });
}
