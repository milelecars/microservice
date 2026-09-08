import { sendJoinMessage, sendNotJoinedMessage } from '../telegram-api';
import { getLead, updateLead, nowIso, LeadRecord } from './supabase';

/** Two join messages closer together than this are the same nudge twice. */
const MIN_GAP_MS = 60_000;

async function sendOnce(
  telegramUserId: number | string,
  send: (id: number | string) => Promise<boolean>,
  known?: LeadRecord | null
): Promise<boolean> {
  const row = known ?? (await getLead(telegramUserId));
  const lastSent = row?.join_message_sent_at ? Date.parse(row.join_message_sent_at) : NaN;

  if (!Number.isNaN(lastSent) && Date.now() - lastSent < MIN_GAP_MS) {
    console.log('[join] suppressed duplicate | TG', telegramUserId);
    return false;
  }

  const sent = await send(telegramUserId);
  if (sent) await updateLead(telegramUserId, { join_message_sent_at: nowIso() });
  return sent;
}

/** The join invitation — at most one per minute per person. */
export async function sendJoinInvite(
  telegramUserId: number | string,
  known?: LeadRecord | null
): Promise<boolean> {
  return sendOnce(telegramUserId, sendJoinMessage, known);
}

/** The "cannot see you yet" retry — throttled the same way. */
export async function sendJoinRetry(
  telegramUserId: number | string,
  known?: LeadRecord | null
): Promise<boolean> {
  return sendOnce(telegramUserId, sendNotJoinedMessage, known);
}
