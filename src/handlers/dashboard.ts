import crypto from 'crypto';
import path from 'path';
import { Request, Response, NextFunction } from 'express';
import { errText } from '../env';
import { queryLeads } from './supabase';

const USERNAME = 'founder';
const REALM = 'Founder Circle dashboard';

/** PostgREST page size — we keep asking until a page comes back short. */
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

/** How long a fetched snapshot is reused before we ask Supabase again. */
const CACHE_MS = 60_000;

/** Directory holding dashboard.html — repo root `public/`, from dist/ or src/. */
export const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');

/**
 * Columns the browser never needs. Kept out of the response so the dashboard
 * can be opened without handing over broker or payment identifiers.
 */
const HIDDEN_COLUMNS = [
  'broker_uid',
  'ftd_amount',
  'ftd_date',
  'contact_number',
  'kommo_talk_id',
  'invite_link',
] as const;

type Row = Record<string, unknown>;

interface Snapshot {
  rows: Row[];
  loaded_at: string;
}

let cache: Snapshot | null = null;
let cachedAt = 0;

function strip(row: Row): Row {
  const out: Row = { ...row };
  for (const column of HIDDEN_COLUMNS) delete out[column];
  return out;
}

/** Length-independent equality, so a wrong password leaks nothing by timing. */
function sameSecret(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function credentialsFrom(header: string | undefined): { user: string; pass: string } | null {
  if (!header || !/^Basic /i.test(header)) return null;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  if (split < 0) return null;
  return { user: decoded.slice(0, split), pass: decoded.slice(split + 1) };
}

/**
 * HTTP Basic in front of every dashboard route. The password itself is never
 * logged — only whether the attempt was accepted.
 */
export function dashboardAuth(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');

  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) {
    console.warn('[dashboard] request but DASHBOARD_PASSWORD is not set');
    res.status(503).type('text/plain').send('Dashboard password not set');
    return;
  }

  const creds = credentialsFrom(req.header('authorization'));
  if (!creds || !sameSecret(creds.user, USERNAME) || !sameSecret(creds.pass, expected)) {
    console.warn('[dashboard] rejected: bad or missing credentials');
    res.setHeader('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`);
    res.status(401).type('text/plain').send('Unauthorized');
    return;
  }

  next();
}

/** Every row of founder_circle_members, read a page at a time. */
async function fetchAllRows(): Promise<Row[]> {
  const rows: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = (await queryLeads(
      `select=*&order=started_at.desc&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`
    )) as unknown as Row[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

// GET /dashboard — the page itself
export function serveDashboard(_req: Request, res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
}

// GET /dashboard/data — the rows the page renders. `?fresh=1` skips the cache.
export async function dashboardData(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  const fresh = String(req.query.fresh ?? '') === '1';
  if (!fresh && cache && Date.now() - cachedAt < CACHE_MS) {
    res.status(200).json(cache);
    return;
  }

  try {
    const rows = (await fetchAllRows()).map(strip);
    const snapshot: Snapshot = { rows, loaded_at: new Date().toISOString() };

    // A failed read comes back as zero rows; don't pin that for a minute.
    if (rows.length > 0) {
      cache = snapshot;
      cachedAt = Date.now();
    }

    console.log('[dashboard] data served |', rows.length, 'rows | fresh:', fresh);
    res.status(200).json(snapshot);
  } catch (err) {
    console.error('[dashboard] data failed:', errText(err));
    res.status(500).json({ ok: false, error: 'Could not load dashboard data' });
  }
}
