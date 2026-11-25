'use strict';
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const core = require('./src/core');
const router = require('./src/router');
const db = require('./src/db');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || allowed.includes('*') || allowed.includes(origin)),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-token']
}));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Rate limits: PIN guesses are heavily capped; general calls more generous.
const pinLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many attempts. Wait a minute and try again.' } });
const callLimiter = rateLimit({ windowMs: 60 * 1000, limit: 400, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Too many requests. Please slow down.' } });

const wrap = fn => async (req, res) => {
  try { res.json({ ok: true, result: await fn(req.body || {}, req) }); }
  catch (e) {
    const status = e && e.statusCode ? e.statusCode : 400;
    res.status(status).json({ ok: false, error: e.message || 'Something went wrong.' });
  }
};

app.get('/', (req, res) => res.type('text').send('API is running.'));
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false, error: 'database unavailable' });
  }
});
app.post('/api/session', pinLimiter, wrap(b => router.session(b)));
app.post('/api/check', pinLimiter, wrap(b => router.check(b)));
app.post('/api/call', callLimiter, wrap(b => core.call(b)));

// One-time setup of a new Services business (needs ADMIN_TOKEN)
app.post('/admin/setup', pinLimiter, async (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.get('x-admin-token') !== token) return res.status(401).json({ ok: false, error: 'Not allowed.' });
  try {
    const { code, name } = req.body || {};
    if (!code) throw new Error('Business code is required.');
    const result = await require('./src/setup').setupServices(code, name);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Setup failed.' });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log('API listening on ' + port));

// Graceful shutdown
process.on('SIGTERM', async () => { await db.close(); process.exit(0); });
process.on('SIGINT', async () => { await db.close(); process.exit(0); });
