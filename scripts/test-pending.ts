/**
 * Pending-match unit test. Run with: npm run test:pending
 *
 * Covers the production failure: Telegram gives display_name "Helia" while
 * Kommo's author.name is "Helia H". The text is what must match.
 */
import {
  clearPending,
  listPending,
  matchPendingByText,
  pushPending,
  recentPending,
  takePending,
} from '../src/pending';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log('  PASS', name);
  } else {
    failures++;
    console.error('  FAIL', name, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

// ── The production case ───────────────────────────────────────────────────────
console.log('the reported case: queued "Helia H" as TG 1, author "Helia H"');
clearPending();
pushPending({ telegram_user_id: 1, text_forwarded: 'Helia H', display_name: 'Helia' });

const match = matchPendingByText('Helia H', 'Helia H');
check('links to TG 1', match?.telegram_user_id === 1, match);
check('entry still queued until taken', listPending().length === 1);
check('takePending removes it', takePending(match!) && listPending().length === 0);

// ── Normalisation ─────────────────────────────────────────────────────────────
console.log('normalisation: case, padding and emoji');
clearPending();
pushPending({ telegram_user_id: 2, text_forwarded: '  HELIA h ', display_name: 'Helia' });
check('trim + lowercase both sides', matchPendingByText('helia H', 'anyone')?.telegram_user_id === 2);

clearPending();
pushPending({ telegram_user_id: 3, text_forwarded: 'Trading and investing 📈', display_name: 'A' });
check('emoji kept', matchPendingByText('Trading and investing 📈', 'A')?.telegram_user_id === 3);

// ── Name is a tie-breaker only ────────────────────────────────────────────────
console.log('two entries, same text: name breaks the tie');
clearPending();
pushPending({ telegram_user_id: 4, text_forwarded: 'Hi', display_name: 'Helia' });
pushPending({ telegram_user_id: 5, text_forwarded: 'Hi', display_name: 'Sam' });
check('prefix match wins over newest', matchPendingByText('Hi', 'Helia H')?.telegram_user_id === 4);
check('unknown name falls back to newest', matchPendingByText('Hi', 'Nobody')?.telegram_user_id === 5);

// ── No match ──────────────────────────────────────────────────────────────────
console.log('non-matching text');
clearPending();
pushPending({ telegram_user_id: 6, text_forwarded: 'Hi', display_name: 'Helia' });
check('different text does not match', matchPendingByText('Something else', 'Helia') === null);
check('recentPending still offers it to the fallback', recentPending(60_000)[0]?.telegram_user_id === 6);

console.log(failures === 0 ? '\nAll pending tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
