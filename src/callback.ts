import axios from 'axios';

/**
 * Calls Kommo's return_url to resume the paused SalesBot.
 * 
 * status examples:
 *   "joined"      — channel membership confirmed
 *   "not_joined"  — user not in channel
 *   "verified"    — UID found in Weex affiliate account
 *   "not_found"   — UID not in affiliate account
 *   "deposited"   — first deposit confirmed
 *   "no_deposit"  — no deposit yet
 */
export async function resumeBot(returnUrl: string, status: string, message?: string): Promise<void> {
  try {
    await axios.post(returnUrl, {
      data: { status, message: message ?? '' },
    }, { timeout: 10_000 });
    console.log(`[callback] ${status} → ${returnUrl}`);
  } catch (err) {
    console.error('[callback] failed to resume bot', { returnUrl, status, err });
  }
}