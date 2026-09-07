import { LEAD_FIELD, KommoLead, fieldValue, resolveTelegramUserId } from '../kommo';
import { getLeadByKommoLeadId, getLeadByKommoContactId, LeadRecord } from './supabase';

export type ResolvedVia =
  | 'lead-field'
  | 'supabase-lead-id'
  | 'supabase-contact-id'
  | 'chats'
  | 'none';

export interface ResolvedIdentity {
  telegramUserId?: string;
  /** The Supabase row, when the resolution went through it. */
  row: LeadRecord | null;
  via: ResolvedVia;
}

/**
 * The one resolution order used by every Kommo-side handler:
 *   1. lead custom field 1067290
 *   2. Supabase row linked to this lead id
 *   3. Supabase row linked to this contact id
 *   4. the contact's Telegram chat (empty on this account, kept as a last resort)
 */
export async function resolveTelegramId(
  logTag: string,
  lead: KommoLead | null,
  leadId?: string | number,
  contactId?: string | number
): Promise<ResolvedIdentity> {
  const fromField = fieldValue(lead?.custom_fields_values, LEAD_FIELD.TG_USER_ID);
  if (fromField) {
    return { telegramUserId: fromField, row: null, via: 'lead-field' };
  }

  if (leadId !== undefined && leadId !== null) {
    const row = await getLeadByKommoLeadId(leadId);
    if (row?.telegram_user_id) {
      console.log(logTag, 'TG user resolved via supabase lead id:', row.telegram_user_id);
      return { telegramUserId: String(row.telegram_user_id), row, via: 'supabase-lead-id' };
    }
  }

  if (contactId !== undefined && contactId !== null) {
    const row = await getLeadByKommoContactId(contactId);
    if (row?.telegram_user_id) {
      console.log(logTag, 'TG user resolved via supabase contact id:', row.telegram_user_id);
      return { telegramUserId: String(row.telegram_user_id), row, via: 'supabase-contact-id' };
    }

    const fromChats = await resolveTelegramUserId(contactId);
    if (fromChats) {
      console.log(logTag, 'TG user resolved via contact chats:', fromChats);
      return { telegramUserId: fromChats, row: null, via: 'chats' };
    }
  }

  console.warn(logTag, 'could not resolve TG user ID | lead:', leadId ?? '-', '| contact:', contactId ?? '-');
  return { row: null, via: 'none' };
}
