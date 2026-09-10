/**
 * handleBlocked unit test. Run with: npm run test:blocked
 *
 * Stubs axios so no Telegram, Kommo or Supabase call leaves the machine, then
 * checks what a 403 from Telegram writes to each side, and what it does not
 * write when the row is already lost or when Telegram failed for some other
 * reason.
 */
import axios from 'axios';

process.env.KOMMO_TOKEN = 'test-token';
process.env.BOT_TOKEN = '1:test';
process.env.CHANNEL_ID = '-100123';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_KEY = 'test-key';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log('  PASS', name);
  } else {
    failures++;
    console.error('  FAIL', name, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

// ── axios stub ────────────────────────────────────────────────────────────────

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

let calls: Call[] = [];
let supabaseRows: unknown[] = [];
/** Set to answer Supabase reads per query instead of always returning the same row. */
let supabaseGet: ((url: string) => unknown[]) | null = null;
let existingTags: { id: number; name: string }[] = [];
/** Leads the pipeline listing hands back during a sweep. */
let pipelineLeads: unknown[] = [];
/** status_id a single-lead read reports. */
let leadStatus = 102006151;
/** Telegram sendMessage outcome for the next run. */
let telegramStatus = 200;

const logged: string[] = [];
const realLog = console.log;

function ok(data: unknown) {
  return Promise.resolve({ status: 200, data });
}

function telegramError(status: number, description: string) {
  return Promise.reject(
    Object.assign(new Error(description), {
      isAxiosError: true,
      response: { status, data: { description } },
    })
  );
}

axios.get = ((url: string) => {
  calls.push({ method: 'GET', url });
  if (url.includes('supabase.co')) return ok(supabaseGet ? supabaseGet(url) : supabaseRows);
  if (url.includes('/leads?')) return ok({ _embedded: { leads: pipelineLeads } });
  if (url.includes('/leads/')) {
    const id = Number(url.split('/leads/')[1].split('?')[0]);
    return ok({ id, status_id: leadStatus, _embedded: { tags: existingTags } });
  }
  return ok({});
}) as unknown as typeof axios.get;

axios.patch = ((url: string, body: unknown) => {
  calls.push({ method: 'PATCH', url, body });
  return ok({});
}) as unknown as typeof axios.patch;

axios.post = ((url: string, body: unknown) => {
  calls.push({ method: 'POST', url, body });
  if (url.includes('api.telegram.org')) {
    if (telegramStatus === 403) return telegramError(403, 'Forbidden: bot was blocked by the user');
    if (telegramStatus === 429) return telegramError(429, 'Too Many Requests: retry after 30');
    return ok({ ok: true, result: { message_id: 1 } });
  }
  return ok({});
}) as unknown as typeof axios.post;

// The stub above is installed before any of these run a request.
import { handleBlocked, sweepBlocked } from '../src/blocked';
import { sendMessage } from '../src/telegram-api';
import { MAX_STAGE, LeadRecord } from '../src/handlers/supabase';
import { STAGE, CONTACT_FIELD } from '../src/kommo';

// ── Helpers ───────────────────────────────────────────────────────────────────

function row(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    kommo_lead_id:    '77',
    kommo_contact_id: '88',
    kommo_talk_id:    '99',
    telegram_user_id: 9001,
    link_sent_at:     new Date().toISOString(),
    joined_at:        null,
    lost_at:          null,
    in_channel:       false,
    reminder_stage:   2,
    ...overrides,
  };
}

async function run(fn: () => Promise<unknown>): Promise<void> {
  calls = [];
  logged.length = 0;
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.log = realLog;
  }
}

const find = (method: string, fragment: string) =>
  calls.filter(c => c.method === method && c.url.includes(fragment));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = (call: Call | undefined): Record<string, any> => (call?.body ?? {}) as Record<string, any>;

// ── Cases ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('a 403 from Telegram marks the row lost and the lead Lost');
  existingTags = [{ id: 5, name: 'Link sent' }];
  supabaseRows = [row()];
  telegramStatus = 403;

  await run(() => sendMessage(9001, 'anything'));

  const rowPatch = bodyOf(find('PATCH', 'supabase.co')[0]);
  check('lost_at stamped', typeof rowPatch.lost_at === 'string', rowPatch);
  check('in_channel false', rowPatch.in_channel === false, rowPatch);
  check('taken out of the reminder ladder', rowPatch.reminder_stage === MAX_STAGE, rowPatch);

  const leadPatch = bodyOf(find('PATCH', '/leads/77')[0]);
  check('lead moved to Lost', leadPatch.status_id === STAGE.LOST, leadPatch);
  check('loss_reason left empty', leadPatch.loss_reason_id === null, leadPatch);
  check(
    'tagged Bot blocked',
    JSON.stringify(leadPatch.tags_to_add) === JSON.stringify([{ name: 'Bot blocked' }]),
    leadPatch
  );
  check('Link sent tag removed', JSON.stringify(leadPatch.tags_to_delete) === JSON.stringify([5]), leadPatch);

  const contactPatch = bodyOf(find('PATCH', '/contacts/88')[0]);
  check(
    'contact field 1003176 set to blocked',
    contactPatch.custom_fields_values?.[0]?.field_id === CONTACT_FIELD.STATUS &&
      contactPatch.custom_fields_values?.[0]?.values?.[0]?.value === 'blocked',
    contactPatch
  );

  const talkClose = find('POST', '/talks/99/close')[0];
  check('talk force-closed', bodyOf(talkClose).force_close === true, talkClose);
  check('logged the Lost line', logged.some(l => l.includes('[blocked] TG 9001 -> Lost')), logged);

  console.log('a row that is already lost is left alone');
  supabaseRows = [row({ lost_at: new Date().toISOString(), reminder_stage: MAX_STAGE })];

  await run(() => handleBlocked(9001));

  check('no Supabase write', find('PATCH', 'supabase.co').length === 0, calls);
  check('no lead write', find('PATCH', '/leads/').length === 0, calls);
  check('no talk close', find('POST', '/talks/').length === 0, calls);
  check('logged the skip', logged.some(l => l.includes('already marked lost')), logged);

  console.log('force redoes the Kommo side for a row Kommo never caught up with');
  existingTags = [{ id: 6, name: 'Bot blocked' }];
  supabaseRows = [row({ lost_at: '2026-01-01T00:00:00.000Z', reminder_stage: MAX_STAGE })];

  await run(() => handleBlocked(9001, { force: true }));

  const forcedLead = bodyOf(find('PATCH', '/leads/77')[0]);
  check('lead moved to Lost', forcedLead.status_id === STAGE.LOST, forcedLead);
  check('a tag already on the lead is not written again', forcedLead.tags_to_add === undefined, forcedLead);
  check('lost_at kept as it was', bodyOf(find('PATCH', 'supabase.co')[0]).lost_at === undefined, calls);

  console.log('a 429 is not treated as a block');
  existingTags = [];
  supabaseRows = [row()];
  telegramStatus = 429;

  await run(() => sendMessage(9001, 'anything'));

  check('no Supabase write', find('PATCH', 'supabase.co').length === 0, calls);
  check('no lead write', find('PATCH', '/leads/').length === 0, calls);
  check('no contact write', find('PATCH', '/contacts/').length === 0, calls);

  console.log('the sweep separates blocked leads from leads that ran out of reminders');
  existingTags = [{ id: 7, name: 'Bot blocked' }];
  leadStatus = 102006151; // In Conversation
  pipelineLeads = [
    { id: 55, status_id: 102006151, _embedded: { tags: [{ id: 7, name: 'Bot blocked' }] } },
    { id: 66, status_id: 102006151, _embedded: { tags: [{ id: 8, name: 'Reminder 4 sent' }] } },
  ];
  supabaseGet = (url: string) => {
    // Lead 55 has no row of its own; the ladder query answers with lead 66's.
    if (url.includes('kommo_lead_id=eq.')) return [];
    if (url.includes('reminder_stage=gte.')) {
      return [row({ kommo_lead_id: '66', kommo_contact_id: '99', telegram_user_id: 9002, reminder_stage: MAX_STAGE })];
    }
    return [];
  };

  await run(() => sweepBlocked());

  const blockedLead = bodyOf(find('PATCH', '/leads/55')[0]);
  check('the tagged lead is moved to Lost', blockedLead.status_id === STAGE.LOST, blockedLead);

  const exhaustedLead = bodyOf(find('PATCH', '/leads/66')[0]);
  check('the lead out of reminders is moved to Lost', exhaustedLead.status_id === STAGE.LOST, exhaustedLead);
  check('and is NOT tagged Bot blocked', exhaustedLead.tags_to_add === undefined, exhaustedLead);
  check('and keeps every tag it has', exhaustedLead.tags_to_delete === undefined, exhaustedLead);
  check('and its contact is not marked blocked', find('PATCH', '/contacts/99').length === 0, calls);
  check('and no talk is closed for it', find('POST', '/talks/').length === 0, calls);
  check(
    'its row records lost_at',
    typeof bodyOf(find('PATCH', 'supabase.co')[0]).lost_at === 'string',
    calls
  );

  console.log('the sweep runs once per deploy');
  await run(() => sweepBlocked());
  check('a second call does nothing', calls.length === 0, calls);
  check('and says so', logged.some(l => l.includes('sweep already ran')), logged);

  supabaseGet = null;

  if (failures > 0) {
    console.error('\n' + failures + ' blocked check(s) failed.');
    process.exit(1);
  }
  console.log('\nAll blocked checks passed.');
}

main();
