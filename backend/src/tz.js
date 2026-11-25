'use strict';
// Time-zone helpers (no dependencies). Google Sheets stores dates as "serial numbers"
// in the spreadsheet's own time zone; these convert to and from real JavaScript Dates.

const EPOCH = Date.UTC(1899, 11, 30);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  f.formatToParts(date).forEach(x => { p[x.type] = x.value; });
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

function dateToSerial(date, tz) {
  const p = parts(date, tz);
  return (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - EPOCH) / 86400000;
}

function serialToDate(serial, tz) {
  const wall = EPOCH + Math.round(serial * 86400) * 1000;   // the wall-clock time, as if it were UTC
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(guess), tz);
    guess += wall - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  }
  return new Date(guess);
}

// Same patterns Apps Script's Utilities.formatDate uses (only the ones the app needs)
function formatDate(date, tz, pattern) {
  const p = parts(date, tz);
  const pad = n => String(n).padStart(2, '0');
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  const map = {
    yyyy: p.y, MMM: MON[p.mo - 1], MM: pad(p.mo), dd: pad(p.d), HH: pad(p.h),
    hh: pad(h12), h: h12, mm: pad(p.mi), ss: pad(p.s), a: p.h < 12 ? 'AM' : 'PM'
  };
  return pattern.replace(/yyyy|MMM|MM|dd|HH|hh|h|mm|ss|a/g, t => map[t]);
}

module.exports = { dateToSerial, serialToDate, formatDate };
