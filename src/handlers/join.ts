import { addLeadTags, setContactStatus } from '../kommo';
import { sendAlreadyJoined, sendGreeting, unbanFromChannel } from '../telegram-api';
import { getLead, updateLead, nowIso, LeadRecord } from './supabase';

const LINK_SENT_TAG = 'Link sent';

/** Two join messages closer together than this are one `/start` counted twice. */
const MIN_GAP_MS = 60_000;

/** True while the last join message is too recent to send another. */
function justSent(row: LeadRecord | null | undefined): boolean {
  const last = row?.join_message_sent_at ? Date.parse(row.join_message_sent_at) : NaN;
  return !Number.isNaN(last) && Date.now() - last < MIN_GAP_MS;
}

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
 * when this person first got the link. The card itself goes out on every
 * `/start`, held back only by the 60-second guard against a double tap;
 * `join_message_sent` records that it has gone out but never suppresses it.
 *
 * Someone who is already in the channel gets a one-liner instead, and none of
 * the link-sent bookkeeping — they are past that.
 */
export async function markLinkSent(
  telegramUserId: number | string,
  known?: LeadRecord | null
): Promise<void> {
  const row = known ?? (await getLead(telegramUserId));

  if (row?.in_channel) {
    if (justSent(row)) {
      console.log('[greet] suppressed duplicate | TG', telegramUserId);
      return;
    }
    if (await sendAlreadyJoined(telegramUserId)) {
      await updateLead(telegramUserId, { join_message_sent_at: nowIso() });
    }
    return;
  }

  const changes: Partial<LeadRecord> = { current_tag: withLinkSentTag(row?.current_tag) };
  if (!row?.link_sent_at) changes.link_sent_at = nowIso();
  await updateLead(telegramUserId, changes);

  await unbanFromChannel(telegramUserId);

  // Kommo only knows about this person once the forwarded message created the
  // lead, so on a brand new sign-up there is nothing to tag yet.
  if (row?.kommo_lead_id) await addLeadTags(row.kommo_lead_id, [LINK_SENT_TAG]);
  if (row?.kommo_contact_id) await setContactStatus(row.kommo_contact_id, 'link sent');

  console.log('[join] link marked sent | TG', telegramUserId);

  if (justSent(row)) {
    console.log('[greet] suppressed duplicate | TG', telegramUserId);
    return;
  }

  // Stamped only once it has actually gone out, so a refused send is greeted
  // again on the next /start.
  if (await sendGreeting(telegramUserId)) {
    await updateLead(telegramUserId, { join_message_sent: true, join_message_sent_at: nowIso() });
  }
}
