import { addLeadTags, setContactStatus } from '../kommo';
import { sendGreeting, unbanFromChannel } from '../telegram-api';
import { getLead, updateLead, nowIso, LeadRecord } from './supabase';

const LINK_SENT_TAG = 'Link sent';

/** The row's tags with `Link sent` in them, however many it already had. */
function withLinkSentTag(current: string | undefined): string {
  const names = (current ?? '').split(',').map(name => name.trim()).filter(Boolean);
  if (!names.some(name => name.toLowerCase() === LINK_SENT_TAG.toLowerCase())) {
    names.push(LINK_SENT_TAG);
  }
  return names.join(', ');
}

/**
 * The greeting, and the record that this person has the link.
 *
 * The card is sent by the bot itself rather than by Kommo's "Greet and Join"
 * bot: anything Kommo sends leaves through its chat channel, which rewrites the
 * button's link to kommo.cc. Sent from here it opens Telegram directly.
 *
 * The unban is ours too: while a leftover ban stands, every invite link tells
 * that person the link has expired.
 *
 * `link_sent_at` is stamped once and never moved, so the timeline still shows
 * when this person first got the link, and `join_message_sent` keeps the
 * greeting to one per row however often /start is pressed.
 */
export async function markLinkSent(
  telegramUserId: number | string,
  known?: LeadRecord | null
): Promise<void> {
  const row = known ?? (await getLead(telegramUserId));

  const changes: Partial<LeadRecord> = { current_tag: withLinkSentTag(row?.current_tag) };
  if (!row?.link_sent_at) changes.link_sent_at = nowIso();
  await updateLead(telegramUserId, changes);

  await unbanFromChannel(telegramUserId);

  // Kommo only knows about this person once the forwarded message created the
  // lead, so on a brand new sign-up there is nothing to tag yet.
  if (row?.kommo_lead_id) await addLeadTags(row.kommo_lead_id, [LINK_SENT_TAG]);
  if (row?.kommo_contact_id) await setContactStatus(row.kommo_contact_id, 'link sent');

  console.log('[join] link marked sent | TG', telegramUserId);

  if (row?.join_message_sent) {
    console.log('[greet] already greeted | TG', telegramUserId);
    return;
  }

  // Stamped only once it has actually gone out, so a refused send is greeted
  // again on the next /start.
  if (await sendGreeting(telegramUserId)) {
    await updateLead(telegramUserId, { join_message_sent: true });
  }
}
