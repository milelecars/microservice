import { Request, Response } from 'express';
import { errText } from '../env';
import { STAGE, KommoLead, get as kommoGet, getStageMap } from '../kommo';
import { resolveTelegramId } from './identity';
import { getLead, updateLead, nowIso, LeadRecord } from './supabase';

interface WebhookLead {
  id?: string | number;
  status_id?: string | number;
}

interface StageWebhookBody {
  leads?: {
    add?: WebhookLead[];
    update?: WebhookLead[];
    status?: WebhookLead[];
  };
}

// This route is called by Kommo on lead status change
export async function handleStageChange(req: Request, res: Response): Promise<void> {
  res.status(200).json({ ok: true });

  const body = req.body as StageWebhookBody;

  setImmediate(async () => {
    try {
      const lead = body?.leads?.status?.[0] ?? body?.leads?.add?.[0] ?? body?.leads?.update?.[0];

      if (!lead?.id) {
        console.warn('[stage] no lead in payload - skipping');
        return;
      }

      const leadId = String(lead.id);
      const statusId = Number(lead.status_id);

      const stages = await getStageMap();
      const stageName = stages[statusId];

      console.log('[stage] lead:', leadId, '-> status:', statusId, '|', stageName ?? 'unknown stage');

      // Look up TG user ID from Kommo lead to update Supabase by telegram_user_id
      const fullLead = await kommoGet<KommoLead>(`/leads/${leadId}?with=contacts`);
      const contacts = fullLead?._embedded?.contacts ?? [];
      const mainContact = contacts.find(c => c.is_main) ?? contacts[0];

      const { telegramUserId, row } = await resolveTelegramId('[stage]', fullLead, leadId, mainContact?.id);

      if (!telegramUserId) {
        console.warn('[stage] could not resolve TG user ID for lead:', leadId, '- skipping Supabase update');
        return;
      }

      const changes: Partial<LeadRecord> = { kommo_lead_id: leadId };
      if (stageName) changes.kommo_stage = stageName;

      // Stage-driven milestones, matched on status id (names change in Kommo)
      if (statusId === STAGE.JOINED_CHANNEL) {
        changes.in_channel = true;
        const existing = row ?? (await getLead(telegramUserId));
        if (!existing?.joined_at) changes.joined_at = nowIso();
      } else if (statusId === STAGE.LOST) {
        changes.lost_at = nowIso();
      }

      await updateLead(telegramUserId, changes);
    } catch (err) {
      console.error('[stage] error:', errText(err));
    }
  });
}
