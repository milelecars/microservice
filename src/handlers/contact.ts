import { Request, Response } from 'express';
import { errText } from '../env';
import {
  CONTACT_FIELD,
  LEAD_FIELD,
  PIPELINE_ID,
  KommoContact,
  KommoLead,
  get as kommoGet,
  fieldValue,
  hasTag,
  resolveTelegramUserId,
  tagNames,
} from '../kommo';
import { upsertLead, nowIso, LeadRecord } from './supabase';

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

      const fields = contact.custom_fields_values;
      const name        = contact.name?.trim() || undefined;
      const phone       = fieldValue(fields, CONTACT_FIELD.PHONE);
      const email       = fieldValue(fields, CONTACT_FIELD.EMAIL);
      const country     = fieldValue(fields, CONTACT_FIELD.COUNTRY);
      const ageBracket  = fieldValue(fields, CONTACT_FIELD.AGE);
      const interest    = fieldValue(fields, CONTACT_FIELD.INTEREST);

      const lead = await findPipelineLead(contact);
      if (!lead) {
        console.warn('[contact] no lead in pipeline', PIPELINE_ID, 'for contact:', contactId, '- skipping');
        return;
      }

      // Field not filled in yet — fall back to this contact's Telegram chat
      const telegramUserId =
        fieldValue(lead.custom_fields_values, LEAD_FIELD.TG_USER_ID) ??
        (await resolveTelegramUserId(contactId));

      if (!telegramUserId) {
        console.warn(
          '[contact] no Telegram User ID on lead:', lead.id,
          'and no telegram chat on contact:', contactId, '- skipping'
        );
        return;
      }

      const tags = lead._embedded?.tags;
      const currentTag = tagNames(tags);
      const linkSent = hasTag(tags, 'Link sent');

      const data: Partial<LeadRecord> = {
        kommo_lead_id:    String(lead.id),
        kommo_contact_id: contactId,
        name,
        phone,
        email,
        country,
        age_bracket:      ageBracket,
        interest,
        current_tag:      currentTag,
      };
      if (linkSent) data.link_sent_at = nowIso();

      await upsertLead(Number(telegramUserId), data, { onlyIfNull: ['link_sent_at'] });

      console.log(
        '[contact] synced | contact:', contactId,
        '| lead:', lead.id,
        '| TG user:', telegramUserId,
        '| tags:', currentTag ?? '-'
      );
    } catch (err) {
      console.error('[contact] error:', errText(err));
    }
  });
}
