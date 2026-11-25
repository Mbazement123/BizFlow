'use strict';
// Shared helpers for both apps: ID codes, phone matching, cleaning, money rounding.

const ROUND = 2;

// Zero-padded sequential code from a Postgres sequence value: pad(5, 'cus') -> 'cus0005'
function code(prefix, n) {
  return prefix + String(n).padStart(4, '0');
}

// Same cleaning the old Router used for the business PIN / app name.
const clean = s => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);

// Normalize a phone to digits only, and reduce to a comparison key (last 10 digits).
function normalizePhone(phone) {
  return String(phone == null ? '' : phone).replace(/[^0-9]/g, '');
}
function phoneKey(phone) {
  const d = normalizePhone(phone);
  return d.length > 10 ? d.slice(-10) : d;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// Dates leave the server as ISO strings (same contract the client already expects).
function iso(v) {
  if (v == null) return '';
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

function daysDate(s) {
  // 'yyyy-MM-dd' -> Date at local noon (matches the old parseDay_ semantics)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0) : null;
}

// Escape for the receipt HTML (same as the original esc()).
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function money(n, currency) {
  return (currency || '') + Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: ROUND, maximumFractionDigits: ROUND
  });
}

module.exports = {
  ROUND, code, clean, normalizePhone, phoneKey, round2, iso, daysDate, esc, money
};
