/**
 * "No response" unit test. Run with: npm run test:no-response
 *
 * Stubs axios so no Telegram, Kommo or Supabase call leaves the machine, then
 * checks both directions: the reminder loop writing a silent lead off, and
 * anything at all from that person bringing it back.
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
let existingTags: { id: number; name: string }[] = [];
/** status_id a single-lead read reports. */
let leadStatus = 102006151; // In Conversation
/** Set to make the lead PATCH fail, the way Kommo did in production. */
let leadPatchFails = false;

const logged: string[] = [];
const realLog = console.log;

function ok(data: unknown) {
  return Promise.resolve({ status: 200, data });
}

axios.get = ((url: string) => {
  calls.push({ method: 'GET', url });
  if (url.includes('supabase.co')) return ok(supabaseRows);
  if (url.includes('/leads/')) {
    const id = Number(url.split('/leads/')[1].split('?')[0]);
    return ok({ id, status_id: leadStatus, _embedded: { tags: existingTags } });
  }
  return ok({});
}) as unknown as typeof axios.get;

axios.patch = ((url: string, body: unknown) => {
  calls.push({ method: 'PATCH', url, body });
  if (leadPatchFails && url.includes('/leads/')) {
    return Promise.reject(
      Object.assign(new Error('Bad Request'), {
        isAxiosError: true,
        response: { status: 400, data: { title: 'Bad Request', status: 400 } },
      })
    );
  }
  return ok({});
}) as unknown as typeof axios.patch;

axios.post = ((url: string, body: unknown) => {
  calls.push({ method: 'POST', url, body });
  return ok({});
}) as unknown as typeof axios.post;

// The stub above is installed before any of these run a request.
import { runNoResponseOnce } from '../src/reminders';
import { reviveLead } from '../src/revive';
import { MAX_STAGE, LeadRecord } from '../src/handlers/supabase';
import { STAGE } from '../src/kommo';

// ── Helpers ───────────────────────────────────────────────────────────────────

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

function row(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    kommo_lead_id:    '77',
    kommo_contact_id: '88',
    kommo_talk_id:    '99',
    telegram_user_id: 9001,
    link_sent_at:     daysAgo(10),
    joined_at:        null,
    lost_at:          null,
    in_channel:       false,
    reminder_stage:   MAX_STAGE,
    reminder_sent_at: daysAgo(4),
    last_activity_at: daysAgo(5),
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

/** The lead PATCH that carries a status move, ignoring the tag-only ones. */
const statusPatch = () => find('PATCH', '/leads/77').map(bodyOf).find(b => b.status_id !== undefined) ?? {};
const tagPatch = () => find('PATCH', '/leads/77').map(bodyOf).find(b => b.tags_to_add !== undefined) ?? {};

// ── Cases ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('three days of silence after the last nudge writes the lead off');
  existingTags = [];
  leadPatchFails = false;
  supabaseRows = [row()];

  await run(() => runNoResponseOnce());

  check('lead moved to Lost', statusPatch().status_id === STAGE.LOST, calls);
  check('no loss_reason sent', statusPatch().loss_reason_id === undefined, calls);
  check(
    'tagged No response',
    JSON.stringify(tagPatch().tags_to_add) === JSON.stringify([{ name: 'No response' }]),
    calls
  );
  check('no tag removed', find('PATCH', '/leads/77').every(c => bodyOf(c).tags_to_delete === undefined), calls);
  check('lost_at stamped', typeof bodyOf(find('PATCH', 'supabase.co')[0]).lost_at === 'string', calls);
  check('talk closed', bodyOf(find('POST', '/talks/99/close')[0]).force_close === true, calls);
  check('nothing sent to the person', find('POST', 'api.telegram.org').length === 0, calls);
  check('logged the write-off', logged.some(l => l.includes('[no-response] TG 9001 -> Lost')), logged);

  console.log('two days of silence is not enough');
  supabaseRows = [row({ reminder_sent_at: daysAgo(2), last_activity_at: daysAgo(2) })];

  await run(() => runNoResponseOnce());
  check('nothing written', calls.filter(c => c.method !== 'GET').length === 0, calls);

  console.log('a reply since the last nudge puts the clock back to zero');
  supabaseRows = [row({ reminder_sent_at: daysAgo(5), last_activity_at: hoursAgo(1) })];

  await run(() => runNoResponseOnce());
  check('nothing written', calls.filter(c => c.method !== 'GET').length === 0, calls);

  console.log('a row still climbing the ladder is left to the ladder');
  supabaseRows = [row({ reminder_stage: MAX_STAGE - 1 })];

  await run(() => runNoResponseOnce());
  check('nothing written', calls.filter(c => c.method !== 'GET').length === 0, calls);

  console.log('a lead Kommo refuses to move is not recorded as lost');
  leadPatchFails = true;
  supabaseRows = [row()];

  await run(() => runNoResponseOnce());

  check('the move was attempted', find('PATCH', '/leads/77').length === 1, calls);
  check('but lost_at is not stamped', find('PATCH', 'supabase.co').length === 0, calls);
  check('and no tag went on', find('PATCH', '/leads/77').every(c => bodyOf(c).tags_to_add === undefined), calls);
  check('and the talk is left open', find('POST', '/talks/').length === 0, calls);
  leadPatchFails = false;

  // ── Back again ──────────────────────────────────────────────────────────────

  console.log('a message from someone written off brings them back');
  existingTags = [{ id: 4, name: 'No response' }];
  leadStatus = STAGE.LOST;
  const lost = row({ lost_at: daysAgo(1) });

  await run(() => reviveLead(9001, lost));

  check('lost_at cleared', bodyOf(find('PATCH', 'supabase.co')[0]).lost_at === null, calls);
  check('back to In Conversation', bodyOf(find('PATCH', '/leads/77')[0]).status_id === STAGE.IN_CONVERSATION, calls);
  check(
    'No response tag removed',
    JSON.stringify(bodyOf(find('PATCH', '/leads/77')[0]).tags_to_delete) === JSON.stringify([4]),
    calls
  );
  check('logged the return', logged.some(l => l.includes('[revive] TG 9001 -> back from Lost')), logged);
  check('and says where it went', logged.some(l => l.includes('In Conversation')), logged);

  console.log('coming back by joining the channel goes straight to Joined Channel');
  await run(() => reviveLead(9001, lost, { joined: true }));

  check('back to Joined Channel', bodyOf(find('PATCH', '/leads/77')[0]).status_id === STAGE.JOINED_CHANNEL, calls);
  check('and says so', logged.some(l => l.includes('Joined Channel')), logged);

  console.log('a lead already where it belongs is not moved again');
  leadStatus = STAGE.IN_CONVERSATION;
  await run(() => reviveLead(9001, lost));

  check('no status in the patch', bodyOf(find('PATCH', '/leads/77')[0]).status_id === undefined, calls);
  check('but the tag still comes off', JSON.stringify(bodyOf(find('PATCH', '/leads/77')[0]).tags_to_delete) === JSON.stringify([4]), calls);

  console.log('a row that was never lost is left alone');
  await run(() => reviveLead(9001, row()));
  check('nothing at all', calls.length === 0, calls);

  await run(() => reviveLead(9001, null));
  check('and nothing for a row that does not exist', calls.length === 0, calls);

  if (failures > 0) {
    console.error('\n' + failures + ' no-response check(s) failed.');
    process.exit(1);
  }
  console.log('\nAll no-response checks passed.');
}

main();
