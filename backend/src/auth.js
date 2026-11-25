'use strict';
// Password hashing, token/OTP generation and hashing. No external deps (Node crypto).
const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;

// Hash a password: scrypt with a random 16-byte salt. Stored as "scrypt$salt$hash" (hex).
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return 'scrypt$' + salt.toString('hex') + '$' + dk.toString('hex');
}

// Constant-time verification against a stored hash.
function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const dk = crypto.scryptSync(String(password), salt, expected.length);
    return expected.length === dk.length && crypto.timingSafeEqual(expected, dk);
  } catch (_) {
    return false;
  }
}

// URL-safe random token (for email verification / sessions).
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Six-digit numeric OTP (for password recovery).
function randomOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// SHA-256 hex hash — we store only hashes of tokens/OTPs, never the raw value.
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = { hashPassword, verifyPassword, randomToken, randomOtp, sha256 };
