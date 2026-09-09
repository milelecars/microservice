import axios from 'axios';
import { requireEnv, errText } from '../env';

// Never logged, never echoed back — see errText()/redact() in ../env.
function restHeaders(): Record<string, string> {
  const key = requireEnv('SUPABASE_KEY');
  return {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
}

function restUrl(path: string): string {
  return `${requireEnv('SUPABASE_URL')}/rest/v1${path}`;
}

export interface LeadRecord {
  kommo_lead_id:             string;
  kommo_contact_id?:         string;
  kommo_talk_id?:            string; // Kommo talk (conversation) this row is in
  telegram_user_id?:         number;
  telegram_username?:        string;
  source_platform?:          string;
  original_source_platform?: string; // set once on first contact, never overwritten
  first_name?:               string;
  last_name?:                string;
  name?:                     string; // contact name typed into the Salesbot
  phone?:                    string;
  email?:                    string;
  country?:                  string;
  age_bracket?:              string;
  interest?:                 string;
  current_tag?:              string;
  kommo_stage?:              string;
  started_at?:               string | null;
  link_sent_at?:             string | null;
  joined_at?:                string | null;
  left_at?:                  string | null;
  lost_at?:                  string | null;
  in_channel?:               boolean;
  join_check_failures?:      number;
  join_message_sent?:        boolean; // join invitation sent once, after the email
  join_message_sent_at?:     string | null; // last join/retry message, for throttling
  welcome_sent?:             boolean; // welcome sent once, after the join was confirmed
  last_activity_at?:         string | null; // last message or tap from the person
  next_question?:            string | null; // 1003176 value that resumes the Salesbot
  reminder_stage?:           number; // how many reminders have gone out (0-4)
  reminder_sent_at?:         string | null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

// Get existing lead from Supabase by telegram_user_id
export async function getLead(telegramUserId: number | string): Promise<LeadRecord | null> {
  try {
    const resp = await axios.get<LeadRecord[]>(
      restUrl(`/founder_circle_members?telegram_user_id=eq.${encodeURIComponent(String(telegramUserId))}&limit=1`),
      { headers: restHeaders(), timeout: 10_000 }
    );
    return resp.data?.[0] ?? null;
  } catch (err) {
    console.error('[supabase] getLead failed:', errText(err));
    return null;
  }
}

async function getLeadBy(column: 'kommo_lead_id' | 'kommo_contact_id', value: string | number): Promise<LeadRecord | null> {
  try {
    const resp = await axios.get<LeadRecord[]>(
      restUrl(`/founder_circle_members?${column}=eq.${encodeURIComponent(String(value))}&limit=1`),
      { headers: restHeaders(), timeout: 10_000 }
    );
    return resp.data?.[0] ?? null;
  } catch (err) {
    console.error(`[supabase] getLeadBy ${column} failed:`, errText(err));
    return null;
  }
}

/**
 * Rows matching a raw PostgREST query string, e.g.
 * `link_sent_at=is.null&joined_at=is.null&limit=500`.
 */
export async function queryLeads(query: string): Promise<LeadRecord[]> {
  try {
    const resp = await axios.get<LeadRecord[]>(restUrl(`/founder_circle_members?${query}`), {
      headers: restHeaders(),
      timeout: 15_000,
    });
    return resp.data ?? [];
  } catch (err) {
    console.error('[supabase] queryLeads failed:', errText(err));
    return [];
  }
}

/** Row linked to this Kommo lead, if one was linked already. */
export async function getLeadByKommoLeadId(leadId: string | number): Promise<LeadRecord | null> {
  return getLeadBy('kommo_lead_id', leadId);
}

/** Row linked to this Kommo contact, if one was linked already. */
export async function getLeadByKommoContactId(contactId: string | number): Promise<LeadRecord | null> {
  return getLeadBy('kommo_contact_id', contactId);
}

// Insert new lead (only on first contact)
export async function insertLead(data: Partial<LeadRecord>): Promise<void> {
  try {
    const resp = await axios.post(restUrl('/founder_circle_members'), data, {
      headers: { ...restHeaders(), Prefer: 'return=minimal' },
      timeout: 10_000,
    });
    console.log('[supabase] inserted lead:', data.kommo_lead_id, '| TG user:', data.telegram_user_id, '| status:', resp.status);
  } catch (err) {
    console.error('[supabase] insert failed:', errText(err));
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
      restUrl(`/founder_circle_members?telegram_user_id=eq.${encodeURIComponent(String(telegramUserId))}`),
      changes,
      { headers: { ...restHeaders(), Prefer: 'return=minimal' }, timeout: 10_000 }
    );
    console.log('[supabase] updated TG user:', telegramUserId, '| fields:', Object.keys(changes).join(', '), '| status:', resp.status);
  } catch (err) {
    console.error('[supabase] update failed:', errText(err));
  }
}

export interface UpsertOptions {
  /** Written only when the row is created — e.g. original_source_platform, started_at. */
  insertOnly?: Partial<LeadRecord>;
  /** Keys in `data` that must not overwrite a value the row already has. */
  onlyIfNull?: (keyof LeadRecord)[];
}

/**
 * The subset of `data` that would actually change the row. Keys listed in
 * `onlyIfNull` are dropped when the row already holds a value for them.
 */
export function diffLead(
  existing: LeadRecord,
  data: Partial<LeadRecord>,
  onlyIfNull: (keyof LeadRecord)[] = []
): Partial<LeadRecord> {
  const changes: Partial<LeadRecord> = {};
  for (const key of Object.keys(data) as (keyof LeadRecord)[]) {
    const value = data[key];
    if (value === undefined) continue;
    if (onlyIfNull.includes(key) && existing[key] !== null && existing[key] !== undefined) continue;
    if (existing[key] === value) continue;
    Object.assign(changes, { [key]: value });
  }
  return changes;
}

/**
 * Insert the row on first contact, otherwise PATCH only the fields that changed.
 * Returns the row as it was before the write (null when it was just created).
 */
export async function upsertLead(
  telegramUserId: number,
  data: Partial<LeadRecord>,
  opts: UpsertOptions = {}
): Promise<LeadRecord | null> {
  const existing = await getLead(telegramUserId);

  if (!existing) {
    const record: Partial<LeadRecord> = {
      ...opts.insertOnly,
      ...data,
      telegram_user_id: telegramUserId,
    };
    for (const key of Object.keys(record) as (keyof LeadRecord)[]) {
      if (record[key] === undefined) delete record[key];
    }
    await insertLead(record);
    return null;
  }

  await updateLead(telegramUserId, diffLead(existing, data, opts.onlyIfNull ?? []));
  return existing;
}
