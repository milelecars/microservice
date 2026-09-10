import { errText } from './env';
import {
  BLOCKED_TAG,
  NO_RESPONSE_TAG,
  STAGE,
  ContactStatus,
  KommoLead,
  contactStatusFor,
  get as kommoGet,
  patch as kommoPatch,
  closeTalk,
  hasTag,
  setContactStatus,
} from './kommo';
import { updateLead, nowIso, LeadRecord } from './handlers/supabase';

/**
 * Write a lead off: the reminder ladder ran out and nothing came back. Lost,
 * tagged `No response`, `lost_at` stamped and the talk closed. Nothing is sent
 * to the person, so quiet hours have nothing to say about it.
 *
 * `why` is the tail of the log line — what made this the moment.
 *
 * Both the reminder loop and the startup sweep come through here, so a lead
 * written off today and one caught up on at boot end up identical in Kommo.
 *
 * Two details worth keeping:
 *
 * - `loss_reason_id` is absent on purpose. Kommo checks it against the stage
 *   the lead is in *now*, so anything in that field — null included — rejects
 *   the whole PATCH with "Loss reason can be specified only for lost lead" and
 *   the move never happens.
 * - `lost_at` is stamped only once Kommo has taken the move, so a refused PATCH
 *   is retried on the next tick rather than leaving the row saying Lost while
 *   the pipeline says otherwise.
 *
 * Returns true when this call was the one that moved the lead.
 */
export async function markNoResponse(row: LeadRecord, why: string): Promise<boolean> {
  const telegramUserId = row.telegram_user_id;
  let alreadyLost = false;

  if (row.kommo_lead_id) {
    try {
      const lead = await kommoGet<KommoLead>(`/leads/${row.kommo_lead_id}?with=tags`);
      alreadyLost = lead?.status_id === STAGE.LOST;

      if (!alreadyLost) {
        const body: { status_id: number; tags_to_add?: { name: string }[] } = { status_id: STAGE.LOST };
        if (!hasTag(lead?._embedded?.tags, NO_RESPONSE_TAG)) {
          body.tags_to_add = [{ name: NO_RESPONSE_TAG }];
        }
        await kommoPatch(`/leads/${row.kommo_lead_id}`, body);
      }
    } catch (err) {
      console.error('[no-response] lead', row.kommo_lead_id, 'could not be moved to Lost:', errText(err));
      return false;
    }
  }

  // Recorded either way: a lead already in Lost is lost, whoever put it there,
  // and leaving `lost_at` null would have every run pick the row up again.
  if (telegramUserId && !row.lost_at) await updateLead(telegramUserId, { lost_at: nowIso() });

  if (!alreadyLost && row.kommo_talk_id) await closeTalk(row.kommo_talk_id, telegramUserId ?? '-');

  console.log('[no-response] TG', telegramUserId ?? '-', '-> Lost |', alreadyLost ? 'already there' : why);
  return !alreadyLost;
}

export interface ReviveOptions {
  /** They are inside the channel, so the lead belongs in Joined Channel. */
  joined?: boolean;
}

/**
 * Someone written off has come back: a message, a `/start`, a tap, or the
 * channel join itself. Undo the writing-off, everywhere it landed.
 *
 * `lost_at` is cleared, both giving-up tags come off the lead, the contact
 * status goes back to where the person actually stands, and the lead returns to
 * In Conversation — or straight to Joined Channel when the thing that brought
 * them back was the join.
 *
 * `Bot blocked` comes off alongside `No response`: writing to the bot means the
 * block is gone, so the tag is stale the moment this runs. If they are somehow
 * still unreachable, the next send answers 403 and puts it back.
 *
 * Nothing happens for a row that was not lost, so every caller can hand it
 * whatever row it already has. The lead's stage is read first, so one already
 * sitting where it belongs is not moved again.
 */
export async function reviveLead(
  telegramUserId: number | string,
  row: LeadRecord | null | undefined,
  opts: ReviveOptions = {}
): Promise<void> {
  if (!row?.lost_at) return;

  const target = opts.joined ? STAGE.JOINED_CHANNEL : STAGE.IN_CONVERSATION;

  await updateLead(telegramUserId, { lost_at: null });

  if (row.kommo_lead_id) {
    try {
      const lead = await kommoGet<KommoLead>(`/leads/${row.kommo_lead_id}?with=tags`);
      const stale = (lead?._embedded?.tags ?? []).filter(t =>
        [NO_RESPONSE_TAG, BLOCKED_TAG].some(name => t.name?.toLowerCase() === name.toLowerCase())
      );

      const body: { status_id?: number; tags_to_delete?: number[] } = {};
      if (lead?.status_id !== target) body.status_id = target;
      if (stale.length > 0) body.tags_to_delete = stale.map(t => t.id);

      if (Object.keys(body).length > 0) await kommoPatch(`/leads/${row.kommo_lead_id}`, body);
    } catch (err) {
      console.error('[revive] lead', row.kommo_lead_id, 'could not be brought back:', errText(err));
    }
  }

  if (row.kommo_contact_id) {
    // contactStatusFor reads the row as it stands; the join is newer than it is.
    const status: ContactStatus = opts.joined ? 'joined' : contactStatusFor(row);
    await setContactStatus(row.kommo_contact_id, status);
  }

  console.log(
    '[revive] TG', telegramUserId, '-> back from Lost |',
    opts.joined ? 'Joined Channel' : 'In Conversation'
  );
}
