import { STAGE, KommoLead, get as kommoGet, patch as kommoPatch, closeTalk, setContactStatus } from '../kommo';
import { WELCOME_TEXT, sendMessage } from '../telegram-api';
import { getLead, updateLead, nowIso, LeadRecord } from './supabase';

const LINK_SENT_TAG = 'Link sent';
const JOINED_TAG = 'Joined Channel';

/** Move the Kommo lead to Joined Channel and swap its tag over. */
async function markLeadJoined(row: LeadRecord): Promise<void> {
  if (!row.kommo_lead_id) return;

  const lead = await kommoGet<KommoLead>(`/leads/${row.kommo_lead_id}?with=tags`);
  const linkSentTags = (lead?._embedded?.tags ?? []).filter(
    t => t.name?.toLowerCase() === LINK_SENT_TAG.toLowerCase()
  );

  const body: {
    status_id: number;
    tags_to_add: { name: string }[];
    tags_to_delete?: number[];
  } = {
    status_id: STAGE.JOINED_CHANNEL,
    tags_to_add: [{ name: JOINED_TAG }],
  };
  if (linkSentTags.length > 0) body.tags_to_delete = linkSentTags.map(t => t.id);

  await kommoPatch(`/leads/${row.kommo_lead_id}`, body);

  if (row.kommo_contact_id) await setContactStatus(row.kommo_contact_id, 'joined');
  if (row.kommo_talk_id) await closeTalk(row.kommo_talk_id, row.telegram_user_id ?? '-');
}

/**
 * Everything that happens once someone is confirmed inside the channel:
 * the welcome message, the Supabase timeline, and the Kommo move.
 *
 * The membership state is always refreshed — someone can leave and come back —
 * but the message and the Kommo move happen once per row, guarded on
 * welcome_sent.
 */
export async function welcomeUser(
  telegramUserId: number | string,
  known?: LeadRecord | null
): Promise<void> {
  const row = known ?? (await getLead(telegramUserId));
  if (!row) {
    console.warn('[welcome] no Supabase row for TG', telegramUserId, '- skipping');
    return;
  }

  const changes: Partial<LeadRecord> = { in_channel: true };
  if (!row.joined_at) changes.joined_at = nowIso();

  if (row.welcome_sent) {
    await updateLead(telegramUserId, changes);
    console.log('[welcome] TG', telegramUserId, '| already welcomed - membership refreshed');
    return;
  }

  const sent = await sendMessage(telegramUserId, WELCOME_TEXT);
  if (sent) changes.welcome_sent = true;

  await updateLead(telegramUserId, changes);
  await markLeadJoined(row);

  console.log('[welcome] TG', telegramUserId);
}
