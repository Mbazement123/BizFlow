'use strict';
// Email sending via Resend (https://resend.com). If RESEND_API_KEY is not set,
// emails are logged to the console instead of sent (safe for local/dev/testing).

const API_URL = 'https://api.resend.com/emails';

// Last delivery error (message only), exposed via /health for diagnostics.
let lastError = null;
let lastSentAt = null;

function isConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

async function sendEmail({ to, subject, html, text }) {
  const from = process.env.MAIL_FROM || 'Bizflow <onboarding@resend.dev>';

  if (!isConfigured()) {
    // Dev fallback: print the message so the flow is testable without a provider.
    console.log('\n--- EMAIL (not sent: RESEND_API_KEY not set) ---');
    console.log('To:      ' + to);
    console.log('From:    ' + from);
    console.log('Subject: ' + subject);
    console.log(text || html);
    console.log('-----------------------------------------------\n');
    lastError = 'RESEND_API_KEY not set';
    return { delivered: false };
  }

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from, to: [to], subject, html, text })
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      lastError = 'HTTP ' + res.status + ': ' + body.slice(0, 300);
      throw new Error('Email provider error (' + res.status + '): ' + body.slice(0, 200));
    }
    lastError = null;
    lastSentAt = new Date().toISOString();
    return { delivered: true };
  } catch (e) {
    if (!lastError) lastError = (e && e.message) || 'unknown error';
    throw e;
  }
}

async function sendVerificationEmail({ to, businessName, link }) {
  const subject = 'Verify your Bizflow account';
  const html =
    '<p>Hi ' + escapeHtml(businessName) + ',</p>' +
    '<p>Thanks for signing up for Bizflow. Confirm your email to activate your workspace:</p>' +
    '<p><a href="' + link + '" style="display:inline-block;padding:10px 18px;background:#567C8D;color:#fff;border-radius:8px;text-decoration:none">Verify my email</a></p>' +
    '<p>Or paste this link into your browser:<br>' + link + '</p>' +
    '<p>If you did not sign up, you can ignore this email.</p>';
  const text = 'Verify your Bizflow account for ' + businessName + ':\n' + link;
  return sendEmail({ to, subject, html, text });
}

async function sendOtpEmail({ to, otp }) {
  const subject = 'Your Bizflow password reset code';
  const html = '<p>Your password reset code is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">' + otp + '</p><p>This code expires in 10 minutes.</p>';
  const text = 'Your Bizflow password reset code is ' + otp + ' (expires in 10 minutes).';
  return sendEmail({ to, subject, html, text });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Diagnostic: send a simple test email and return the provider outcome (or throw with its message).
async function sendTest(to) {
  return sendEmail({
    to,
    subject: 'Bizflow test email',
    html: '<p>This is a test email from your Bizflow backend. If you got this, Resend is configured correctly.</p>',
    text: 'This is a test email from your Bizflow backend.'
  });
}

function configSummary() {
  const from = process.env.MAIL_FROM || 'Bizflow <onboarding@resend.dev>';
  const fromDomain = (from.match(/@([^>\s]+)/) || [])[1] || '';
  return {
    hasApiKey: Boolean(process.env.RESEND_API_KEY),
    from,
    fromDomain,
    isSandboxSender: /^resend\.dev$/i.test(fromDomain),
    appBaseUrl: process.env.APP_BASE_URL || '',
    publicBackendUrl: process.env.PUBLIC_BACKEND_URL || '',
    lastError: lastError,
    lastSentAt: lastSentAt
  };
}

module.exports = { sendVerificationEmail, sendOtpEmail, sendTest, configSummary, isConfigured };
