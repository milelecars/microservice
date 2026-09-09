import axios from 'axios';
import { requireEnv, errText } from './env';

export const KOMMO_BASE = 'https://fahadriazex1.kommo.com/api/v4';

/** Founder Circle pipeline. */
export const PIPELINE_ID = 13228919;

/** Pipeline stages, by status id. */
export const STAGE = {
  INCOMING_LEADS:       102006055,
  IN_CONVERSATION:      102006151, // "In Converstation" in Kommo
  JOINED_CHANNEL:       111366003,
  PENDING_REGISTERATION: 102006155,
  PENDING_VERIFICATION: 102006159,
  PENDING_FTD:          102006163,
  UPSELL:               102006167,
  LOST:                 102006171,
} as const;

/** Custom fields on the LEAD. */
export const LEAD_FIELD = {
  TG_USER_ID:      1067290,
  TG_USERNAME:     1104292,
  SOURCE_PLATFORM: 1094948,
} as const;

/** Custom fields on the CONTACT, written by the Salesbot. */
export const CONTACT_FIELD = {
  STATUS:   1003176, // funnel status: "joined" / "link sent" / empty
  PHONE:    1003178, // multitext, enum WORK
  EMAIL:    1003180, // multitext, enum WORK
  COUNTRY:  1383512,
  AGE:      1383508,
  INTEREST: 1383510,
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KommoFieldValue {
  value: string | number | boolean | null;
  enum_id?: number;
  enum_code?: string;
}

export interface KommoCustomField {
  field_id: number;
  field_name?: string;
  field_code?: string | null;
  values?: KommoFieldValue[];
}

export interface KommoTag {
  id: number;
  name: string;
}

export interface KommoEmbeddedLead {
  id: number;
}

export interface KommoEmbeddedContact {
  id: number;
  is_main?: boolean;
}

export interface KommoChat {
  id?: string;
  chat_id?: string;
  source_uid?: string | null;
  external_id?: string | null;
  origin?: string;
  channel_type?: string;
}

export interface KommoLead {
  id: number;
  status_id: number;
  pipeline_id: number;
  custom_fields_values?: KommoCustomField[] | null;
  _embedded?: {
    tags?: KommoTag[];
    contacts?: KommoEmbeddedContact[];
  };
}

export interface KommoContact {
  id: number;
  name?: string;
  first_name?: string;
  last_name?: string;
  custom_fields_values?: KommoCustomField[] | null;
  _embedded?: {
    tags?: KommoTag[];
    leads?: KommoEmbeddedLead[];
    chats?: KommoChat[];
  };
}

export interface KommoTalk {
  talk_id?: number;
  entity_id?: number;
  entity_type?: string;
  origin?: string;
  created_at?: number;
  contact_id?: number;
  _embedded?: { contact?: { id: number } };
}

export interface KommoList<K extends string, T> {
  _embedded?: Partial<Record<K, T[]>>;
}

export interface KommoPipeline {
  id: number;
  name: string;
  _embedded?: { statuses?: { id: number; name: string }[] };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${requireEnv('KOMMO_TOKEN')}` };
}

/** GET a Kommo API path. Returns null on 204 (Kommo's "empty result"). */
export async function get<T>(path: string): Promise<T | null> {
  const resp = await axios.get<T>(`${KOMMO_BASE}${path}`, {
    headers: authHeaders(),
    timeout: 10_000,
    validateStatus: s => (s >= 200 && s < 300) || s === 204,
  });
  if (resp.status === 204) return null;
  return resp.data ?? null;
}

/** PATCH a Kommo API path. */
export async function patch<T>(path: string, body: unknown): Promise<T | null> {
  const resp = await axios.patch<T>(`${KOMMO_BASE}${path}`, body, {
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    timeout: 10_000,
  });
  return resp.data ?? null;
}

/** POST to a Kommo API path. */
export async function post<T>(path: string, body: unknown): Promise<T | null> {
  const resp = await axios.post<T>(`${KOMMO_BASE}${path}`, body, {
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    timeout: 10_000,
  });
  return resp.data ?? null;
}

// ── Contact status (field 1003176) ────────────────────────────────────────────

/** Values bot version 26 routes on, in contact field 1003176. */
export type ContactStatus =
  | 'joined'
  | 'link sent'
  | 'need name'
  | 'need country'
  | 'need age'
  | 'need interest'
  | 'need phone'
  | 'need email'
  | '';

/**
 * Mirror where the person stands onto the contact, so Kommo and Supabase never
 * disagree. An empty value clears the field.
 */
export async function setContactStatus(contactId: string | number, value: ContactStatus): Promise<boolean> {
  try {
    await patch(`/contacts/${contactId}`, {
      custom_fields_values: [{ field_id: CONTACT_FIELD.STATUS, values: [{ value }] }],
    });
    console.log('[status] contact', contactId, 'set to', value === '' ? '""' : value);
    return true;
  } catch (err) {
    console.error('[status] contact', contactId, 'update failed:', errText(err));
    return false;
  }
}

// ── Talks ─────────────────────────────────────────────────────────────────────

/**
 * Close a Kommo talk so the next Telegram message starts a fresh conversation.
 * A 404 means it is closed already, which is the state we wanted anyway.
 */
export async function closeTalk(talkId: string | number, telegramUserId: string | number): Promise<boolean> {
  try {
    await post(`/talks/${talkId}/close`, { force_close: true });
    console.log('[talk] closed', talkId, 'for TG', telegramUserId);
    return true;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      console.log('[talk]', talkId, 'already closed for TG', telegramUserId);
      return true;
    }
    console.error('[talk] close failed', talkId, 'for TG', telegramUserId, '|', errText(err));
    return false;
  }
}

// ── Lead tags ─────────────────────────────────────────────────────────────────

/**
 * Add tags to a lead without touching the ones it already has. The current tags
 * are read first so a name already on the lead is left alone, and the write goes
 * through `tags_to_add`, which appends — nothing else can be dropped by a stale
 * read. Returns the names that were actually added.
 */
export async function addLeadTags(leadId: string | number, names: string[]): Promise<string[]> {
  try {
    const lead = await get<KommoLead>(`/leads/${leadId}?with=tags`);
    const existing = lead?._embedded?.tags ?? [];
    const missing = names.filter(name => !hasTag(existing, name));
    if (missing.length === 0) return [];

    await patch(`/leads/${leadId}`, { tags_to_add: missing.map(name => ({ name })) });
    return missing;
  } catch (err) {
    console.error('[kommo] addLeadTags failed for lead', leadId, '|', errText(err));
    return [];
  }
}

// ── Stage map (cached after first successful load) ─────────────────────────────

let stageMap: Record<number, string> = {};
let stageMapLoaded = false;

export async function getStageMap(): Promise<Record<number, string>> {
  if (stageMapLoaded) return stageMap;
  try {
    const data = await get<KommoList<'pipelines', KommoPipeline>>('/leads/pipelines');
    const next: Record<number, string> = {};
    for (const pipeline of data?._embedded?.pipelines ?? []) {
      for (const stage of pipeline._embedded?.statuses ?? []) {
        next[stage.id] = stage.name;
      }
    }
    if (Object.keys(next).length > 0) {
      stageMap = next;
      stageMapLoaded = true;
      console.log('[kommo] stage map loaded:', Object.keys(stageMap).length, 'stages');
    }
  } catch (err) {
    console.error('[kommo] failed to load stage map:', errText(err));
  }
  return stageMap;
}

// ── Telegram identity ─────────────────────────────────────────────────────────

/**
 * Discover the Telegram user id from a contact's chats — a Telegram chat's
 * source_uid IS the Telegram user id. Returns undefined when the contact has
 * no Telegram chat yet.
 */
export async function resolveTelegramUserId(contactId: number | string): Promise<string | undefined> {
  try {
    const contact = await get<KommoContact>(`/contacts/${contactId}?with=chats`);
    const chats = contact?._embedded?.chats ?? [];

    const tgChat =
      chats.find(c => c.origin?.toLowerCase() === 'telegram' || c.channel_type?.toLowerCase() === 'telegram') ??
      chats.find(c => !!(c.source_uid ?? c.external_id));

    if (!tgChat) {
      console.log('[kommo] no telegram chat for contact:', contactId, '| chats:', chats.length);
      return undefined;
    }

    const uid = String(tgChat.source_uid ?? tgChat.external_id ?? '').trim();
    return uid.length > 0 ? uid : undefined;
  } catch (err) {
    console.error('[kommo] resolveTelegramUserId failed for contact:', contactId, '|', errText(err));
    return undefined;
  }
}

// ── Field helpers ─────────────────────────────────────────────────────────────

function pickValue(
  fields: KommoCustomField[] | null | undefined,
  fieldId: number,
  which: 'first' | 'last'
): string | undefined {
  const values = fields?.find(f => f.field_id === fieldId)?.values ?? [];
  const picked = which === 'last' ? values[values.length - 1] : values[0];
  const raw = picked?.value;
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  return text.length > 0 ? text : undefined;
}

/** First value of a custom field, as a trimmed string. */
export function fieldValue(fields: KommoCustomField[] | null | undefined, fieldId: number): string | undefined {
  return pickValue(fields, fieldId, 'first');
}

/**
 * Last value of a custom field — multitext fields such as Phone and Email keep
 * every value the Salesbot has written, and the newest one is the current one.
 */
export function fieldValueLast(fields: KommoCustomField[] | null | undefined, fieldId: number): string | undefined {
  return pickValue(fields, fieldId, 'last');
}

/** Tag names joined by comma, or undefined when the entity has no tags. */
export function tagNames(tags: KommoTag[] | undefined): string | undefined {
  const names = (tags ?? []).map(t => t.name).filter(Boolean);
  return names.length > 0 ? names.join(', ') : undefined;
}

export function hasTag(tags: KommoTag[] | undefined, name: string): boolean {
  return (tags ?? []).some(t => t.name?.toLowerCase() === name.toLowerCase());
}
