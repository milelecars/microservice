import type { LeadRecord } from './handlers/supabase';

/**
 * The Salesbot's six questions, in the order it asks them. The value is what
 * contact field 1003176 must hold for bot version 26 to route to that question.
 */
export const QUESTION_ORDER = [
  { field: 'name',        status: 'need name' },
  { field: 'country',     status: 'need country' },
  { field: 'age_bracket', status: 'need age' },
  { field: 'interest',    status: 'need interest' },
  { field: 'phone',       status: 'need phone' },
  { field: 'email',       status: 'need email' },
] as const;

export type NextQuestion = (typeof QUESTION_ORDER)[number]['status'];

function filled(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
}

/** The first unanswered question, or null once all six are in. */
export function nextQuestionFor(row: Partial<LeadRecord>): NextQuestion | null {
  for (const question of QUESTION_ORDER) {
    if (!filled(row[question.field])) return question.status;
  }
  return null;
}
