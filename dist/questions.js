"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QUESTION_ORDER = void 0;
exports.nextQuestionFor = nextQuestionFor;
/**
 * The Salesbot's six questions, in the order it asks them. The value is what
 * contact field 1003176 must hold for bot version 26 to route to that question.
 */
exports.QUESTION_ORDER = [
    { field: 'name', status: 'need name' },
    { field: 'country', status: 'need country' },
    { field: 'age_bracket', status: 'need age' },
    { field: 'interest', status: 'need interest' },
    { field: 'phone', status: 'need phone' },
    { field: 'email', status: 'need email' },
];
function filled(value) {
    return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
}
/** The first unanswered question, or null once all six are in. */
function nextQuestionFor(row) {
    for (const question of exports.QUESTION_ORDER) {
        if (!filled(row[question.field]))
            return question.status;
    }
    return null;
}
