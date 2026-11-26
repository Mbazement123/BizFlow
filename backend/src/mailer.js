'use strict';
// Email sending via Brevo SMTP (nodemailer).
// Supports SMTP configuration via SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM.
// If not configured, emails are logged to the console instead of sent (safe for local/dev/testing).

const nodemailer = require('nodemailer');

let lastError = null;
let lastSentAt = null;

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  const host = process.env.SMTP_HOST || 'smtp-relay.brevo.com';
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false for other ports
    auth: {
      user,
      pass
    }
  });
}

async function sendEmail({ to, subject, html, text }) {
  const from = process.env.MAIL_FROM || 'Bizflow <no-reply@bizflow.app>';

  if (!isConfigured()) {
    // Dev fallback: print the message so the flow is testable without a provider.
    console.log('\n--- EMAIL (not sent: SMTP not configured) ---');
    console.log('To:      ' + to);
    console.log('From:    ' + from);
    console.log('Subject: ' + subject);
    console.log(text || html);
    console.log('-----------------------------------------------\n');
    lastError = 'SMTP not configured';
    return { delivered: false };
  }

  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from,
      to,
      subject,
      text,
      html
    });

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

async function sendTest(to) {
  return sendEmail({
    to,
    subject: 'Bizflow test email',
    html: '<p>This is a test email from your Bizflow backend. If you got this, Brevo SMTP is configured correctly.</p>',
    text: 'This is a test email from your Bizflow backend.'
  });
}

function configSummary() {
  const from = process.env.MAIL_FROM || 'Bizflow <no-reply@bizflow.app>';
  const fromDomain = (from.match(/@([^>\s]+)/) || [])[1] || '';
  return {
    hasSmtpConfig: isConfigured(),
    host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
    from,
    fromDomain,
    appBaseUrl: process.env.APP_BASE_URL || '',
    publicBackendUrl: process.env.PUBLIC_BACKEND_URL || '',
    lastError: lastError,
    lastSentAt: lastSentAt
  };
}

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendOtpEmail,
  sendTest,
  configSummary
};
