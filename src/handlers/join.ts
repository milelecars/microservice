import { addLeadTags, setContactStatus } from '../kommo';
import { sendJoinMessage, sendNotJoinedMessage } from '../telegram-api';
import { getLead, updateLead, nowIso, LeadRecord } from './supabase';

/** Two automatic join messages closer together than this are the same nudge twice. */
const MIN_GAP_MS = 60_000;

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
 * The greeting-only flow's one and only card: mark the row as "link sent" —
 * what the reminder loop, the dashboard and Kommo all read — then send it.
 *
 * `link_sent_at` is stamped once and never moved, so the timeline still shows
 * when this person first got the link.
 */
export async function sendJoinCard(
  telegramUserId: number | string,
  known?: LeadRecord | null
): Promise<boolean> {
  const row = known ?? (await getLead(telegramUserId));

  const changes: Partial<LeadRecord> = {
    join_message_sent:    true,
    join_message_sent_at: nowIso(),
    current_tag:          withLinkSentTag(row?.current_tag),
  };
  if (!row?.link_sent_at) changes.link_sent_at = nowIso();
  await updateLead(telegramUserId, changes);

  // Kommo only knows about this person once the forwarded message created the
  // lead, so on a brand new sign-up there is nothing to tag yet.
  if (row?.kommo_lead_id) await addLeadTags(row.kommo_lead_id, [LINK_SENT_TAG]);
  if (row?.kommo_contact_id) await setContactStatus(row.kommo_contact_id, 'link sent');

  return sendJoinMessage(telegramUserId);
}

async function stamp(telegramUserId: number | string): Promise<void> {
  await updateLead(telegramUserId, { join_message_sent_at: nowIso() });
}

/**
 * The join invitation. This one is automatic — link_sent detection and /start
 * can both fire within seconds of each other — so it is throttled.
 */
export async function sendJoinInvite(
  telegramUserId: number | string,
  known?: LeadRecord | null
): Promise<boolean> {
  const row = known ?? (await getLead(telegramUserId));
  const lastSent = row?.join_message_sent_at ? Date.parse(row.join_message_sent_at) : NaN;

  if (!Number.isNaN(lastSent) && Date.now() - lastSent < MIN_GAP_MS) {
    console.log('[join] suppressed duplicate | TG', telegramUserId);
    return false;
  }

  const sent = await sendJoinMessage(telegramUserId);
  if (sent) await stamp(telegramUserId);
  return sent;
}

/**
 * The "cannot see you yet" retry. Never throttled: the person just tapped the
 * button and is owed an answer, however often they tap.
 */
export async function sendJoinRetry(telegramUserId: number | string): Promise<boolean> {
  const sent = await sendNotJoinedMessage(telegramUserId);
  if (sent) await stamp(telegramUserId);
  return sent;
}
