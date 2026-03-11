import axios from 'axios';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_KEY!;

const headers = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
};

export interface LeadRecord {
  kommo_lead_id:      string;
  telegram_user_id?:  number;
  telegram_username?: string;
  source_platform?:   string;
  first_name?:        string;
  last_name?:         string;
  current_tag?:       string;
  kommo_stage?:       string;
}

// Get existing lead from Supabase by telegram_user_id
export async function getLead(telegramUserId: number): Promise<LeadRecord | null> {
  try {
    const resp = await axios.get(
      `${SUPABASE_URL}/rest/v1/leads?telegram_user_id=eq.${telegramUserId}&limit=1`,
      { headers, timeout: 10_000 }
    );
    return resp.data?.[0] ?? null;
  } catch (err: any) {
    console.error('[supabase] getLead failed:', err?.response?.data ?? err.message);
    return null;
  }
}

// Insert new lead (only on first contact)
export async function insertLead(data: LeadRecord): Promise<void> {
  try {
    const resp = await axios.post(
      `${SUPABASE_URL}/rest/v1/leads`,
      data,
      { headers: { ...headers, 'Prefer': 'return=minimal' }, timeout: 10_000 }
    );
    console.log('[supabase] inserted lead:', data.kommo_lead_id, '| status:', resp.status);
  } catch (err: any) {
    console.error('[supabase] insert failed:', err?.response?.data ?? err.message);
  }
}

// Partial update — only send fields that actually changed, keyed by telegram_user_id
export async function updateLead(telegramUserId: number | string, changes: Partial<LeadRecord>): Promise<void> {
  if (Object.keys(changes).length === 0) {
    console.log('[supabase] no changes for TG user:', telegramUserId, '— skipping');
    return;
  }
  try {
    const resp = await axios.patch(
      `${SUPABASE_URL}/rest/v1/leads?telegram_user_id=eq.${telegramUserId}`,
      changes,
      { headers: { ...headers, 'Prefer': 'return=minimal' }, timeout: 10_000 }
    );
    console.log('[supabase] updated TG user:', telegramUserId, '| changes:', JSON.stringify(changes), '| status:', resp.status);
  } catch (err: any) {
    console.error('[supabase] update failed:', err?.response?.data ?? err.message);
  }
}