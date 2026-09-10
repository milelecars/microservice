import { errText } from './env';
import { NO_RESPONSE_TAG, STAGE, KommoLead, get as kommoGet, patch as kommoPatch } from './kommo';
import { updateLead, LeadRecord } from './handlers/supabase';

export interface ReviveOptions {
  /** They are inside the channel, so the lead belongs in Joined Channel. */
  joined?: boolean;
}

/**
 * Someone written off as Lost has come back: a message, a `/start`, a tap, or
 * the channel join itself. Undo the writing-off, in both places.
 *
 * `lost_at` is cleared, the `No response` tag comes off the lead, and the lead
 * goes back to In Conversation - or straight to Joined Channel when the thing
 * that brought them back was the join. Nothing happens for a row that was not
 * lost, so every caller can hand it whatever row it already has.
 *
 * The lead's current stage is read first, so a lead already sitting where it
 * belongs is not patched again; welcomeUser has usually just moved it.
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
      const noResponse = (lead?._embedded?.tags ?? []).filter(
        t => t.name?.toLowerCase() === NO_RESPONSE_TAG.toLowerCase()
      );

      const body: { status_id?: number; tags_to_delete?: number[] } = {};
      if (lead?.status_id !== target) body.status_id = target;
      if (noResponse.length > 0) body.tags_to_delete = noResponse.map(t => t.id);

      if (Object.keys(body).length > 0) await kommoPatch(`/leads/${row.kommo_lead_id}`, body);
    } catch (err) {
      console.error('[revive] lead', row.kommo_lead_id, 'could not be brought back:', errText(err));
    }
  }

  console.log(
    '[revive] TG', telegramUserId, '-> back from Lost |',
    opts.joined ? 'Joined Channel' : 'In Conversation'
  );
}
