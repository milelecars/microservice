/**
 * Reminder tagging unit test. Run with: npm run test:reminder-tags
 *
 * Stubs axios so no Telegram, Kommo or Supabase call leaves the machine, then
 * checks which tag each path writes onto the Kommo lead.
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
/** Telegram sendMessage outcome for the next run. */
let telegramStatus = 200;

const logged: string[] = [];
const realLog = console.log;

function ok(data: unknown) {
  return Promise.resolve({ status: 200, data });
}

axios.get = ((url: string) => {
  calls.push({ method: 'GET', url });
  if (url.includes('supabase.co')) return ok(supabaseRows);
  if (url.includes('/leads/')) return ok({ id: 1, _embedded: { tags: existingTags } });
  return ok({});
}) as unknown as typeof axios.get;

axios.patch = ((url: string, body: unknown) => {
  calls.push({ method: 'PATCH', url, body });
  return ok({});
}) as unknown as typeof axios.patch;

axios.post = ((url: string, body: unknown) => {
  calls.push({ method: 'POST', url, body });
  if (url.includes('api.telegram.org')) {
    if (telegramStatus === 403) {
      const err = Object.assign(new Error('Forbidden: bot was blocked by the user'), {
        isAxiosError: true,
        response: { status: 403, data: { description: 'Forbidden: bot was blocked by the user' } },
      });
      return Promise.reject(err);
    }
    return ok({ ok: true, result: { message_id: 1 } });
  }
  return ok({});
}) as unknown as typeof axios.post;

// The stub above is installed before any of these run a request.
import { runRemindersOnce, tagResumedAfterReminder, MAX_STAGE } from '../src/reminders';
import { LeadRecord } from '../src/handlers/supabase';

// ── Helpers ───────────────────────────────────────────────────────────────────

const HOURS_AGO_100 = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();

function row(over: Partial<LeadRecord> = {}): LeadRecord {
  return {
    kommo_lead_id: '55501',
    telegram_user_id: 9001,
    started_at: HOURS_AGO_100,
    last_activity_at: HOURS_AGO_100,
    reminder_stage: 0,
    phone: '+971500000000', // Asia/Dubai
    ...over,
  } as LeadRecord;
}

function reset(): void {
  calls = [];
  existingTags = [];
  telegramStatus = 200;
  logged.length = 0;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
}

function done(): void {
  console.log = realLog;
}

/** Tag names sent in every lead PATCH of the last run. */
function tagsAdded(): string[] {
  return calls
    .filter(c => c.method === 'PATCH' && c.url.includes('/leads/'))
    .flatMap(c => ((c.body as { tags_to_add?: { name: string }[] })?.tags_to_add ?? []).map(t => t.name));
}

function patchBodies(): Record<string, unknown>[] {
  return calls
    .filter(c => c.method === 'PATCH' && c.url.includes('/leads/'))
    .map(c => c.body as Record<string, unknown>);
}

async function main(): Promise<void> {
  // Quiet hours would skip the send, so only run when Dubai is awake.
  const dubaiHour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', hourCycle: 'h23' }).format(new Date())
  );
  if (dubaiHour >= 23 || dubaiHour < 8) {
    console.error('Dubai is in quiet hours right now - the send paths cannot be exercised. Re-run later.');
    process.exit(2);
  }

  // ── Each stage gets its own tag ───────────────────────────────────────────────

  realLog('a sent reminder tags the lead with the stage it went out at');
  for (let stage = 0; stage < MAX_STAGE; stage++) {
    reset();
    supabaseRows = [row({ reminder_stage: stage })];
    await runRemindersOnce();
    done();
    check(`stage ${stage} -> "Reminder ${stage + 1} sent"`, tagsAdded().join(',') === `Reminder ${stage + 1} sent`, tagsAdded());
    check(
      `stage ${stage} logs the tag line`,
      logged.some(l => l === `[reminder] tagged lead 55501 Reminder ${stage + 1} sent`),
      logged.filter(l => l.includes('tagged'))
    );
  }

  // ── Existing tags survive ─────────────────────────────────────────────────────

  realLog('existing tags are kept');
  reset();
  existingTags = [{ id: 7, name: 'Link sent' }, { id: 9, name: 'Instagram' }];
  supabaseRows = [row()];
  await runRemindersOnce();
  done();
  check('only the new tag is added', tagsAdded().join(',') === 'Reminder 1 sent', tagsAdded());
  check(
    'no tags_to_delete and no full tag replacement',
    patchBodies().every(b => !('tags_to_delete' in b) && !('_embedded' in b)),
    patchBodies()
  );

  // ── Already tagged: no second write ───────────────────────────────────────────

  realLog('a tag that is already on the lead is not written again');
  reset();
  existingTags = [{ id: 3, name: 'Reminder 1 sent' }];
  supabaseRows = [row()];
  await runRemindersOnce();
  done();
  check('no lead PATCH at all', patchBodies().length === 0, patchBodies());

  // ── Blocked bot ───────────────────────────────────────────────────────────────

  realLog('a 403 from Telegram tags "Bot blocked" and no reminder tag');
  reset();
  telegramStatus = 403;
  supabaseRows = [row()];
  await runRemindersOnce();
  done();
  check('tagged Bot blocked', tagsAdded().join(',') === 'Bot blocked', tagsAdded());
  check('no reminder tag', !tagsAdded().some(t => t.startsWith('Reminder')), tagsAdded());

  // ── No Kommo lead ─────────────────────────────────────────────────────────────

  realLog('a row with no kommo_lead_id is skipped and logged');
  reset();
  supabaseRows = [row({ kommo_lead_id: undefined as unknown as string })];
  await runRemindersOnce();
  done();
  check('no lead call at all', !calls.some(c => c.url.includes('/leads/')), calls.map(c => c.url));
  check(
    'logged the skip',
    logged.some(l => l.includes('no kommo_lead_id') && l.includes('Reminder 1 sent')),
    logged
  );

  // ── Resume ────────────────────────────────────────────────────────────────────

  realLog('resuming after a nudge tags the lead once');
  reset();
  await tagResumedAfterReminder(row({ reminder_stage: 2 }));
  done();
  check('tagged Resumed after reminder', tagsAdded().join(',') === 'Resumed after reminder', tagsAdded());

  reset();
  existingTags = [{ id: 4, name: 'Resumed after reminder' }];
  await tagResumedAfterReminder(row({ reminder_stage: 2 }));
  done();
  check('a second resume writes nothing', patchBodies().length === 0, patchBodies());

  reset();
  await tagResumedAfterReminder(row({ reminder_stage: 0 }));
  done();
  check('someone who never got a reminder is not tagged', !calls.some(c => c.url.includes('/leads/')), calls.map(c => c.url));

  // ── Result ────────────────────────────────────────────────────────────────────

  console.log(failures === 0 ? '\nAll reminder tag checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);

}

main();
