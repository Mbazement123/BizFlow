'use strict';
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { google } = require('googleapis');
const { createCore } = require('./src/core');
const { buildPdf } = require('./src/pdf');

function credentials() {
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set.');
  if (!raw.trim().startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');   // base64 also accepted
  const c = JSON.parse(raw);
  c.private_key = String(c.private_key || '').replace(/\\n/g, '\n');
  return c;
}

const REGISTRY_ID = process.env.REGISTRY_SHEET_ID;
if (!REGISTRY_ID) throw new Error('REGISTRY_SHEET_ID is not set.');

const auth = new google.auth.GoogleAuth({ credentials: credentials(), scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const core = createCore({
  sheetsApi: google.sheets({ version: 'v4', auth }),
  registryId: REGISTRY_ID,
  tz: process.env.TZ_NAME || 'Africa/Lagos',
  ttlSeconds: Number(process.env.SHEET_CACHE_SECONDS || 20),
  gasDir: path.join(__dirname, 'gas'),
  buildPdf,
  frontendUrl: (process.env.ALLOWED_ORIGINS || '').split(',')[0] || '/'
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || allowed.includes('*') || allowed.includes(origin)),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-token']
}));

const pinLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many attempts. Wait a minute and try again.' } });
const callLimiter = rateLimit({ windowMs: 60 * 1000, limit: 400, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many requests. Please slow down.' } });

const wrap = fn => async (req, res) => {
  try { res.json({ ok: true, result: await fn(req.body || {}, req) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message || 'Something went wrong.' }); }
};

app.get('/', (req, res) => res.type('text').send('API is running.'));
app.get('/health', (req, res) => res.json({ ok: true }));
app.post('/api/session', pinLimiter, wrap(b => core.session(b)));
app.post('/api/check', pinLimiter, wrap(b => core.check(b)));
app.post('/api/call', callLimiter, wrap(b => core.call(b)));

// One-time setup for a new Services business (needs ADMIN_TOKEN)
app.post('/admin/setup', pinLimiter, async (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.get('x-admin-token') !== token) return res.status(401).json({ ok: false, error: 'Not allowed.' });
  wrap(b => core.adminSetup(b))(req, res);
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log('API listening on ' + port));
