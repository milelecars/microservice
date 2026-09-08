import { sendJoinMessage, sendNotJoinedMessage } from '../telegram-api';
import { getLead, updateLead, nowIso, LeadRecord } from './supabase';

/** Two automatic join messages closer together than this are the same nudge twice. */
const MIN_GAP_MS = 60_000;

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
