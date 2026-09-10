import { errText } from './env';
import { addLeadTags } from './kommo';
import { markNoResponse } from './no-response';
import { sendJoinMessage } from './telegram-api';
import { queryLeads, updateLead, nowIso, LeadRecord, MAX_STAGE } from './handlers/supabase';

// The ladder's length lives with the column it writes, so the code that stops
// the ladder (see ./blocked) does not have to reach back in here for it.
export { MAX_STAGE };

/** How long after the last sign of life each reminder goes out. MAX_STAGE rungs. */
const STAGE_DELAYS_MS = [
  2 * 60 * 60 * 1000,   // stage 0 → first reminder after 2 hours
  8 * 60 * 60 * 1000,   // stage 1 → 8 hours after the first
  24 * 60 * 60 * 1000,  // stage 2 → 24 hours after the second
  72 * 60 * 60 * 1000,  // stage 3 → 72 hours after the third
];

/** What each rung says. The button under it is always Join Founder Circle. */
const STAGE_TEXTS = [
  'Still here? 👋 You are one tap from Founder Circle. Join below.',
  'Your spot in Founder Circle is still open. The real numbers and decisions are inside, come in.',
  'You started yesterday, then life happened. Founder Circle is where I show what is really going on at Milele, unfiltered. Join below.',
  'Last nudge, then I go quiet. If you want the behind the scenes, the button is right here. If not, no hard feelings.',
];

// ── Kommo tags, so the pipeline shows what the bot has been doing ─────────────

/** Tag for the nudge that just went out, from the stage it was sent at. */
const reminderTag = (stage: number) => `Reminder ${stage + 1} sent`;

export const RESUMED_TAG = 'Resumed after reminder';

/** Tag the Kommo lead behind a row, keeping every tag it already has. */
async function tagLead(row: LeadRecord, tag: string): Promise<void> {
  if (!row.kommo_lead_id) {
    console.log('[reminder] no kommo_lead_id for TG', row.telegram_user_id, '- tag', tag, 'skipped');
    return;
  }
  const added = await addLeadTags(row.kommo_lead_id, [tag]);
  if (added.length > 0) console.log('[reminder] tagged lead', row.kommo_lead_id, tag);
}

/**
 * Mark a lead that came back after a nudge — the Continue tap, or a `/start`
 * that resumes. Only for people who actually got a reminder, and only once:
 * addLeadTags leaves a tag that is already there alone.
 */
export async function tagResumedAfterReminder(row: LeadRecord): Promise<void> {
  if ((row.reminder_stage ?? 0) === 0) return;
  await tagLead(row, RESUMED_TAG);
}

/**
 * Silence this long after the ladder ran out and the lead is written off. The
 * clock is the same one the ladder runs on — the later of their last move and
 * our last nudge — so anything at all from them puts it back to zero.
 */
const LOST_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/** No messages before this hour or after it, local to the person. */
const QUIET_UNTIL_HOUR = 8;
const QUIET_FROM_HOUR = 23;

const DEFAULT_TIMEZONE = 'Asia/Dubai';

const RUN_EVERY_MS = 5 * 60 * 1000;

/** Dialling code → timezone, longest prefix wins. */
const PHONE_TIMEZONES: Record<string, string> = {
  '971': 'Asia/Dubai',       '966': 'Asia/Riyadh',      '965': 'Asia/Kuwait',
  '974': 'Asia/Qatar',       '973': 'Asia/Bahrain',     '968': 'Asia/Muscat',
  '964': 'Asia/Baghdad',     '962': 'Asia/Amman',       '961': 'Asia/Beirut',
  '963': 'Asia/Damascus',    '967': 'Asia/Aden',        '970': 'Asia/Hebron',
  '20':  'Africa/Cairo',     '212': 'Africa/Casablanca', '213': 'Africa/Algiers',
  '216': 'Africa/Tunis',     '218': 'Africa/Tripoli',   '249': 'Africa/Khartoum',
  '234': 'Africa/Lagos',     '254': 'Africa/Nairobi',   '27':  'Africa/Johannesburg',
  '90':  'Europe/Istanbul',  '92':  'Asia/Karachi',     '91':  'Asia/Kolkata',
  '880': 'Asia/Dhaka',       '94':  'Asia/Colombo',     '93':  'Asia/Kabul',
  '98':  'Asia/Tehran',      '7':   'Europe/Moscow',    '380': 'Europe/Kyiv',
  '44':  'Europe/London',    '353': 'Europe/Dublin',    '33':  'Europe/Paris',
  '49':  'Europe/Berlin',    '39':  'Europe/Rome',      '34':  'Europe/Madrid',
  '31':  'Europe/Amsterdam', '32':  'Europe/Brussels',  '41':  'Europe/Zurich',
  '46':  'Europe/Stockholm', '47':  'Europe/Oslo',      '45':  'Europe/Copenhagen',
  '48':  'Europe/Warsaw',    '30':  'Europe/Athens',    '351': 'Europe/Lisbon',
  '1':   'America/New_York', '52':  'America/Mexico_City', '55': 'America/Sao_Paulo',
  '54':  'America/Argentina/Buenos_Aires', '57': 'America/Bogota',
  '62':  'Asia/Jakarta',     '60':  'Asia/Kuala_Lumpur', '65': 'Asia/Singapore',
  '63':  'Asia/Manila',      '66':  'Asia/Bangkok',     '84':  'Asia/Ho_Chi_Minh',
  '86':  'Asia/Shanghai',    '81':  'Asia/Tokyo',       '82':  'Asia/Seoul',
  '61':  'Australia/Sydney', '64':  'Pacific/Auckland',
};

/** Best guess at the person's timezone, from the phone they gave. */
export function timezoneFor(phone: string | undefined | null): string {
  const digits = String(phone ?? '').replace(/[^\d]/g, '');
  if (!digits) return DEFAULT_TIMEZONE;

  for (let length = 3; length >= 1; length--) {
    const timezone = PHONE_TIMEZONES[digits.slice(0, length)];
    if (timezone) return timezone;
  }
  return DEFAULT_TIMEZONE;
}

/** Hour of day (0-23) in that timezone right now. */
export function hourIn(timezone: string, at: Date = new Date()): number {
  try {
    const hour = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(at);
    return Number(hour);
  } catch {
    return Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: DEFAULT_TIMEZONE, hour: '2-digit', hourCycle: 'h23' }).format(at)
    );
  }
}

export function isQuietHour(hour: number): boolean {
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

/** The clock a reminder waits on: the later of their last move and our last nudge. */
function lastSignal(row: LeadRecord): number {
  const times = [row.last_activity_at, row.reminder_sent_at, row.started_at]
    .map(value => (value ? Date.parse(value) : NaN))
    .filter(value => !Number.isNaN(value));
  return times.length > 0 ? Math.max(...times) : NaN;
}

export function isDue(row: LeadRecord, now: number = Date.now()): boolean {
  const stage = row.reminder_stage ?? 0;
  if (stage >= MAX_STAGE) return false;

  const since = lastSignal(row);
  if (Number.isNaN(since)) return false;

  return now - since >= STAGE_DELAYS_MS[stage];
}

/**
 * Out of reminders, still outside the channel, and silent for three days since
 * the last nudge. Quiet hours do not apply — nothing is sent.
 */
export function isSilent(row: LeadRecord, now: number = Date.now()): boolean {
  if ((row.reminder_stage ?? 0) < MAX_STAGE) return false;
  if (row.joined_at || row.lost_at) return false;

  const since = lastSignal(row);
  if (Number.isNaN(since)) return false;

  return now - since >= LOST_AFTER_MS;
}

/** One pass over everyone the ladder ran out on who then went quiet. */
export async function runNoResponseOnce(): Promise<number> {
  const rows = await queryLeads(
    'link_sent_at=not.is.null&joined_at=is.null&lost_at=is.null' +
    `&reminder_stage=gte.${MAX_STAGE}&limit=500`
  );

  let lost = 0;
  for (const row of rows) {
    if (!row.telegram_user_id || !isSilent(row)) continue;
    const since = new Date(lastSignal(row)).toISOString();
    if (await markNoResponse(row, `silent since ${since}`)) lost++;
  }
  return lost;
}

async function sendStage(row: LeadRecord): Promise<void> {
  const telegramUserId = row.telegram_user_id;
  if (!telegramUserId) return;

  const stage = row.reminder_stage ?? 0;

  // The one card the service still sends: this rung's text, and under it the
  // same Join Founder Circle link every time.
  const result = await sendJoinMessage(telegramUserId, STAGE_TEXTS[stage]);

  // handleBlocked, from inside the send, has already taken this row out of the
  // ladder and moved the lead to Lost.
  if (result.blocked) {
    console.log('[reminder] TG', telegramUserId, 'blocked the bot - no more reminders');
    return;
  }
  if (!result.ok) return;

  await updateLead(telegramUserId, { reminder_stage: stage + 1, reminder_sent_at: nowIso() });
  await tagLead(row, reminderTag(stage));
  console.log('[reminder] stage', stage, '-> TG', telegramUserId);
}

/** One pass over everyone who has the link but never joined the channel. */
export async function runRemindersOnce(): Promise<number> {
  const rows = await queryLeads(
    'link_sent_at=not.is.null&joined_at=is.null' +
    `&reminder_stage=lt.${MAX_STAGE}&limit=500`
  );

  let sent = 0;
  for (const row of rows) {
    if (!row.telegram_user_id || !isDue(row)) continue;

    if (isQuietHour(hourIn(timezoneFor(row.phone)))) continue; // try again next run

    await sendStage(row);
    sent++;
  }
  return sent;
}

let running = false;

/** Start the 5-minute loop. Safe to call once, from index.ts. */
export function startReminders(): NodeJS.Timeout {
  console.log('[reminder] scheduler started | every', RUN_EVERY_MS / 60_000, 'minutes');

  return setInterval(async () => {
    if (running) {
      console.log('[reminder] previous run still going - skipping this tick');
      return;
    }
    running = true;
    try {
      await runRemindersOnce();
      await runNoResponseOnce();
    } catch (err) {
      console.error('[reminder] run failed:', errText(err));
    } finally {
      running = false;
    }
  }, RUN_EVERY_MS);
}
