import axios from 'axios';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_KEY!;

const headers = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Prefer': 'resolution=merge-duplicates',
};

export interface LeadRecord {
  kommo_lead_id:     string;
  telegram_user_id?: number;
  telegram_username?: string;
  source_platform?:  string;
  first_name?:       string;
  last_name?:        string;
  current_tag?:      string;
}

export async function upsertLead(data: LeadRecord): Promise<void> {
  try {
    const resp = await axios.post(
      `${SUPABASE_URL}/rest/v1/leads`,
      data,
      { headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' }, timeout: 10_000 }
    );
    console.log('[supabase] upserted lead:', data.kommo_lead_id, '| status:', resp.status);
  } catch (err: any) {
    console.error('[supabase] upsert failed:', err?.response?.data ?? err.message);
  }
}

export async function updateLeadTag(kommoLeadId: string, tag: string): Promise<void> {
  try {
    const resp = await axios.patch(
      `${SUPABASE_URL}/rest/v1/leads?kommo_lead_id=eq.${kommoLeadId}`,
      { current_tag: tag },
      { headers: { ...headers, 'Prefer': 'return=minimal' }, timeout: 10_000 }
    );
    console.log('[supabase] tag updated:', tag, '→ lead:', kommoLeadId, '| status:', resp.status);
  } catch (err: any) {
    console.error('[supabase] tag update failed:', err?.response?.data ?? err.message);
  }
}