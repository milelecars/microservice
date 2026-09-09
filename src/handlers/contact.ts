import { Request, Response } from 'express';
import { errText } from '../env';
import {
  CONTACT_FIELD,
  PIPELINE_ID,
  KommoContact,
  KommoLead,
  contactStatusFor,
  fieldValue,
  get as kommoGet,
  hasTag,
  setContactStatus,
  tagNames,
} from '../kommo';
import { resolveTelegramId } from './identity';
import { sendJoinInvite } from './join';
import { getLead, insertLead, updateLead, diffLead, nowIso, LeadRecord } from './supabase';

// Kommo account webhooks post form-encoded contacts[add|update][0][id]
interface WebhookEntity {
  id?: string | number;
}

interface ContactWebhookBody {
  contacts?: {
    add?: WebhookEntity[];
    update?: WebhookEntity[];
  };
}

/**
 * Copy the contact's name and the lead's tags onto the Supabase row, and keep
 * the Kommo ids in sync. Used by both the Kommo contact webhook and every
 * incoming message.
 *
 * The bot asks no questions any more, so country, age, interest, phone and
 * email are never read back — rows from the question era keep whatever they
 * already hold, and new rows simply leave those columns null.
 */
export async function syncContactAnswers(
  contactId: string | number,
  leadId: string | number,
  telegramUserId: string | number
): Promise<void> {
  const contact = await kommoGet<KommoContact>(`/contacts/${contactId}`);
  if (!contact) {
    console.warn('[answers] contact not found:', contactId);
    return;
  }

  const lead = await kommoGet<KommoLead>(`/leads/${leadId}?with=tags`);
  const tags = lead?._embedded?.tags;
  const status = fieldValue(contact.custom_fields_values, CONTACT_FIELD.STATUS);

  const data: Partial<LeadRecord> = {
    kommo_lead_id:    String(leadId),
    kommo_contact_id: String(contactId),
    name:             contact.name?.trim() || undefined,
    current_tag:      tagNames(tags),
  };
  if (hasTag(tags, 'Link sent')) data.link_sent_at = nowIso();

  const existing = await getLead(telegramUserId);

  if (!existing) {
    const record: Partial<LeadRecord> = { ...data, telegram_user_id: Number(telegramUserId) };
    for (const key of Object.keys(record) as (keyof LeadRecord)[]) {
      if (record[key] === undefined) delete record[key];
    }
    await insertLead(record);
    console.log('[answers] TG', telegramUserId, '| row created');
    await syncStatusField(contactId, status, record);
    if (record.link_sent_at) await inviteToChannel(telegramUserId);
    return;
  }

  const changes = diffLead(existing, data, ['link_sent_at']);
  const changed = Object.keys(changes);

  // link_sent_at only appears in the diff the first time the tag shows up
  const linkJustSent = changes.link_sent_at !== undefined && !existing.join_message_sent;

  await syncStatusField(contactId, status, { ...existing, ...changes });

  if (changed.length === 0) {
    console.log('[answers] TG', telegramUserId, '| no change');
    return;
  }

  await updateLead(telegramUserId, changes);
  console.log('[answers] TG', telegramUserId, '| updated:', changed.join(', '));

  if (linkJustSent) await inviteToChannel(telegramUserId);
}

/**
 * Keep contact field 1003176 in step with the row. The greeting sends the card
 * before Kommo has a contact to write to, so this is where a brand new lead's
 * "link sent" lands. Only written when it would actually change.
 */
async function syncStatusField(
  contactId: string | number,
  current: string | undefined,
  row: Partial<LeadRecord>
): Promise<void> {
  const desired = contactStatusFor(row);
  if (!desired || desired === current) return;
  await setContactStatus(contactId, desired);
}

/** Send the join invitation once, and remember that we did. */
async function inviteToChannel(telegramUserId: string | number): Promise<void> {
  const sent = await sendJoinInvite(telegramUserId);
  if (sent) await updateLead(telegramUserId, { join_message_sent: true });
}

/** The lead this contact is linked to inside the Founder Circle pipeline. */
async function findPipelineLead(contact: KommoContact): Promise<KommoLead | null> {
  for (const ref of contact._embedded?.leads ?? []) {
    const lead = await kommoGet<KommoLead>(`/leads/${ref.id}?with=tags`);
    if (lead && lead.pipeline_id === PIPELINE_ID) return lead;
  }
  return null;
}

// Called by the Kommo account webhook on "Contact added" and "Contact updated"
export async function handleContactUpdate(req: Request, res: Response): Promise<void> {
  res.status(200).json({ ok: true });

  const body = req.body as ContactWebhookBody;

  setImmediate(async () => {
    try {
      const raw = body?.contacts?.update?.[0]?.id ?? body?.contacts?.add?.[0]?.id;
      if (!raw) {
        console.warn('[contact] no contact in payload - skipping');
        return;
      }
      const contactId = String(raw);

      const contact = await kommoGet<KommoContact>(`/contacts/${contactId}?with=leads`);
      if (!contact) {
        console.warn('[contact] contact not found:', contactId);
        return;
      }

      const lead = await findPipelineLead(contact);
      if (!lead) {
        console.warn('[contact] no lead in pipeline', PIPELINE_ID, 'for contact:', contactId, '- skipping');
        return;
      }

      const { telegramUserId } = await resolveTelegramId('[contact]', lead, lead.id, contactId);

      if (!telegramUserId) {
        console.warn(
          '[contact] could not resolve TG user ID | lead:', lead.id,
          '| contact:', contactId, '- skipping'
        );
        return;
      }

      await syncContactAnswers(contactId, lead.id, telegramUserId);

      console.log('[contact] synced | contact:', contactId, '| lead:', lead.id, '| TG user:', telegramUserId);
    } catch (err) {
      console.error('[contact] error:', errText(err));
    }
  });
}
