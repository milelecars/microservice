import { Request, Response } from 'express';
import axios from 'axios';
import { updateLead } from './supabase';

const KOMMO_BASE  = 'https://fahadriazex1.kommo.com/api/v4';
const KOMMO_TOKEN = process.env.KOMMO_TOKEN!;

// Cache stage map
let stageMap: Record<number, string> = {};
let stageMapLoaded = false;

async function getStageMap(): Promise<Record<number, string>> {
  if (stageMapLoaded) return stageMap;
  try {
    const resp = await axios.get(
      `${KOMMO_BASE}/leads/pipelines`,
      { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000 }
    );
    for (const pipeline of resp.data?._embedded?.pipelines ?? []) {
      for (const stage of pipeline._embedded?.statuses ?? []) {
        stageMap[stage.id] = stage.name;
      }
    }
    stageMapLoaded = true;
  } catch (err: any) {
    console.error('[stage] failed to load stage map:', err.message);
  }
  return stageMap;
}

// This route is called by Kommo Digital Pipeline webhook on stage change
export async function handleStageChange(req: Request, res: Response): Promise<void> {
  res.status(200).json({ ok: true });

  setImmediate(async () => {
    try {
      const body = req.body;
      console.log('[stage] incoming payload:', JSON.stringify(body));

      // Kommo pipeline webhook sends leads.add or leads.update
      const lead =
        body?.leads?.add?.[0] ??
        body?.leads?.update?.[0];

      if (!lead) {
        console.warn('[stage] no lead in payload — skipping');
        return;
      }

      const leadId   = String(lead.id);
      const statusId = Number(lead.status_id);

      const stages   = await getStageMap();
      const stageName = stages[statusId];

      if (!stageName) {
        console.warn('[stage] unknown status_id:', statusId);
        return;
      }

      console.log('[stage] lead:', leadId, '→ stage:', stageName);

      // Update only the stage in Supabase
      await updateLead(leadId, { kommo_stage: stageName });

    } catch (err: any) {
      console.error('[stage] error:', err?.response?.data ?? err.message);
    }
  });
}