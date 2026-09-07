"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveTelegramId = resolveTelegramId;
const kommo_1 = require("../kommo");
const supabase_1 = require("./supabase");
/**
 * The one resolution order used by every Kommo-side handler:
 *   1. lead custom field 1067290
 *   2. Supabase row linked to this lead id
 *   3. Supabase row linked to this contact id
 *   4. the contact's Telegram chat (empty on this account, kept as a last resort)
 */
async function resolveTelegramId(logTag, lead, leadId, contactId) {
    const fromField = (0, kommo_1.fieldValue)(lead?.custom_fields_values, kommo_1.LEAD_FIELD.TG_USER_ID);
    if (fromField) {
        return { telegramUserId: fromField, row: null, via: 'lead-field' };
    }
    if (leadId !== undefined && leadId !== null) {
        const row = await (0, supabase_1.getLeadByKommoLeadId)(leadId);
        if (row?.telegram_user_id) {
            console.log(logTag, 'TG user resolved via supabase lead id:', row.telegram_user_id);
            return { telegramUserId: String(row.telegram_user_id), row, via: 'supabase-lead-id' };
        }
    }
    if (contactId !== undefined && contactId !== null) {
        const row = await (0, supabase_1.getLeadByKommoContactId)(contactId);
        if (row?.telegram_user_id) {
            console.log(logTag, 'TG user resolved via supabase contact id:', row.telegram_user_id);
            return { telegramUserId: String(row.telegram_user_id), row, via: 'supabase-contact-id' };
        }
        const fromChats = await (0, kommo_1.resolveTelegramUserId)(contactId);
        if (fromChats) {
            console.log(logTag, 'TG user resolved via contact chats:', fromChats);
            return { telegramUserId: fromChats, row: null, via: 'chats' };
        }
    }
    console.warn(logTag, 'could not resolve TG user ID | lead:', leadId ?? '-', '| contact:', contactId ?? '-');
    return { row: null, via: 'none' };
}
