// Shared constants for the Frianzo Verified free-month flow.
//
// The first month costs Rs 0 (owner decision 2026-11-18). Tapping
// "Get Verified" does not grant the tick instantly: it submits a
// verification request carrying FREE_MONTH_REQUEST_REASON, and the
// admin review endpoint recognises that marker and grants a
// time-limited tick (FREE_MONTH_DAYS) instead of a permanent one.
export const FREE_MONTH_DAYS = 30;
export const FREE_MONTH_REQUEST_REASON = 'Free month claim — first month Rs 0 (30 days, team review)';
