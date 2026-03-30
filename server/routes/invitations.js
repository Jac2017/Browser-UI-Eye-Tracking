/**
 * Invitation & participant onboarding routes.
 *
 * Researchers: manage email lists, send invitations, track onboarding status.
 * Participants: accept invitation via token, consent, get auto-install instructions.
 */

const router = require('express').Router();
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { db } = require('../models/db');
const { masterAuth } = require('../middleware/auth');
const config = require('../config');

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function getTransporter() {
  if (!config.smtp.host || !config.smtp.user) return null;
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
}

function buildInviteEmail(invitation, study) {
  const onboardUrl = `${config.publicUrl}/onboard?token=${invitation.token}`;
  return {
    from: `"${config.smtp.fromName}" <${config.smtp.fromEmail || config.smtp.user}>`,
    to: invitation.email,
    subject: `You're invited to participate in "${study.name}" — EyeD Research`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <div style="text-align:center;margin-bottom:24px">
          <h1 style="color:#58a6ff;font-size:28px;margin:0">EyeD</h1>
          <p style="color:#8b949e;margin-top:4px">Eye Tracking Research Platform</p>
        </div>
        <div style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:24px;color:#e6edf3">
          <h2 style="margin-top:0;color:#e6edf3">You've been invited!</h2>
          <p>A researcher has invited you to participate in the study:</p>
          <div style="background:#161b22;border-radius:6px;padding:16px;margin:16px 0">
            <h3 style="margin:0 0 8px;color:#58a6ff">${study.name}</h3>
            ${study.description ? `<p style="margin:0;color:#8b949e;font-size:14px">${study.description}</p>` : ''}
          </div>
          <p>Click the button below to get started. The setup takes about 2 minutes.</p>
          <div style="text-align:center;margin:24px 0">
            <a href="${onboardUrl}" style="background:#238636;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:16px;display:inline-block">
              Join Study &amp; Install Extension
            </a>
          </div>
          <p style="font-size:13px;color:#8b949e">Or copy this link: <a href="${onboardUrl}" style="color:#58a6ff">${onboardUrl}</a></p>
          <hr style="border:none;border-top:1px solid #30363d;margin:24px 0">
          <p style="font-size:12px;color:#484f58;margin:0">
            Your participation is voluntary. You can withdraw at any time.
            If you didn't expect this email, you can safely ignore it.
          </p>
        </div>
      </div>
    `,
    text: `You've been invited to participate in "${study.name}".\n\nGet started: ${onboardUrl}\n\nYour participation is voluntary.`,
  };
}

/* ========== CRUD ========== */

// POST /invitations — add one or more participants to a study's email list
router.post('/invitations', masterAuth, (req, res) => {
  const { studyId, emails, groupName } = req.body;
  if (!studyId) return res.status(400).json({ error: 'studyId required' });

  const study = db.prepare('SELECT id FROM studies WHERE id = ?').get(studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });

  // Accept single email string or array
  let emailList = [];
  if (typeof emails === 'string') {
    // Support comma/newline/semicolon separated
    emailList = emails.split(/[,;\n]+/).map(e => e.trim().toLowerCase()).filter(Boolean);
  } else if (Array.isArray(emails)) {
    emailList = emails.map(e => (typeof e === 'string' ? e.trim().toLowerCase() : '')).filter(Boolean);
  }

  if (emailList.length === 0) return res.status(400).json({ error: 'No valid emails provided' });
  if (emailList.length > 500) return res.status(400).json({ error: 'Max 500 emails per batch' });

  // Basic email validation
  const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const invalid = emailList.filter(e => !emailRx.test(e));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Invalid emails: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '...' : ''}` });
  }

  const group = (groupName || 'default').substring(0, 100);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO invitations (study_id, email, group_name, token, participant_id)
    VALUES (?, ?, ?, ?, ?)
  `);

  const results = { added: 0, skipped: 0, errors: [] };
  const insertMany = db.transaction((list) => {
    for (const email of list) {
      const token = generateToken();
      const pid = `P${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
      try {
        const r = insert.run(studyId, email, group, token, pid);
        if (r.changes > 0) results.added++;
        else results.skipped++; // duplicate
      } catch (err) {
        results.skipped++;
      }
    }
  });
  insertMany(emailList);

  res.status(201).json(results);
});

// GET /invitations — list invitations for a study
router.get('/invitations', masterAuth, (req, res) => {
  const { studyId, status, search, limit, offset } = req.query;
  if (!studyId) return res.status(400).json({ error: 'studyId required' });

  let where = ['i.study_id = ?'];
  let params = [studyId];

  if (status) { where.push('i.status = ?'); params.push(status); }
  if (search) {
    where.push('(i.email LIKE ? OR i.participant_id LIKE ?)');
    const term = `%${search.substring(0, 200)}%`;
    params.push(term, term);
  }

  const lim = Math.min(parseInt(limit) || 50, 500);
  const off = parseInt(offset) || 0;

  const rows = db.prepare(`
    SELECT i.*, s.name as study_name
    FROM invitations i
    JOIN studies s ON i.study_id = s.id
    WHERE ${where.join(' AND ')}
    ORDER BY i.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, lim, off);

  const total = db.prepare(`SELECT COUNT(*) as count FROM invitations i WHERE ${where.join(' AND ')}`).get(...params);

  // Status breakdown
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status = 'opened' THEN 1 ELSE 0 END) as opened,
      SUM(CASE WHEN status = 'installed' THEN 1 ELSE 0 END) as installed,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN consent_given = 1 THEN 1 ELSE 0 END) as consented
    FROM invitations WHERE study_id = ?
  `).get(studyId);

  res.json({ invitations: rows, total: total.count, stats });
});

// DELETE /invitations/:id
router.delete('/invitations/:id', masterAuth, (req, res) => {
  const result = db.prepare('DELETE FROM invitations WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// DELETE /invitations/study/:studyId — clear all invitations for a study
router.delete('/invitations/study/:studyId', masterAuth, (req, res) => {
  const result = db.prepare('DELETE FROM invitations WHERE study_id = ?').run(req.params.studyId);
  res.json({ success: true, deleted: result.changes });
});

/* ========== SEND INVITATIONS ========== */

// POST /invitations/send — send invitation emails
router.post('/invitations/send', masterAuth, async (req, res) => {
  const { studyId, ids, resend } = req.body;
  if (!studyId) return res.status(400).json({ error: 'studyId required' });

  const transporter = getTransporter();
  if (!transporter) {
    return res.status(400).json({ error: 'SMTP not configured. Set EYED_SMTP_HOST, EYED_SMTP_USER, EYED_SMTP_PASS environment variables.' });
  }

  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });

  // If specific IDs provided, send to those; otherwise send to all unsent
  let invitations;
  if (Array.isArray(ids) && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    invitations = db.prepare(`SELECT * FROM invitations WHERE study_id = ? AND id IN (${placeholders})`).all(studyId, ...ids);
  } else {
    const statusFilter = resend ? '' : "AND status = 'pending'";
    invitations = db.prepare(`SELECT * FROM invitations WHERE study_id = ? ${statusFilter} LIMIT 200`).all(studyId);
  }

  if (invitations.length === 0) {
    return res.json({ sent: 0, failed: 0, message: 'No pending invitations to send' });
  }

  const updateSent = db.prepare("UPDATE invitations SET status = 'sent', sent_at = datetime('now') WHERE id = ?");
  const updateFailed = db.prepare("UPDATE invitations SET metadata = json_set(metadata, '$.lastError', ?) WHERE id = ?");

  let sent = 0, failed = 0;
  const errors = [];

  for (const inv of invitations) {
    try {
      const mail = buildInviteEmail(inv, study);
      await transporter.sendMail(mail);
      updateSent.run(inv.id);
      sent++;
    } catch (err) {
      updateFailed.run(err.message.substring(0, 500), inv.id);
      errors.push({ email: inv.email, error: err.message });
      failed++;
    }
  }

  res.json({ sent, failed, errors: errors.slice(0, 10) });
});

// POST /invitations/send-reminder — send reminders to participants who haven't installed
router.post('/invitations/send-reminder', masterAuth, async (req, res) => {
  const { studyId } = req.body;
  if (!studyId) return res.status(400).json({ error: 'studyId required' });

  const transporter = getTransporter();
  if (!transporter) {
    return res.status(400).json({ error: 'SMTP not configured.' });
  }

  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });

  // Only remind people who were sent but haven't installed, max 3 reminders
  const invitations = db.prepare(`
    SELECT * FROM invitations
    WHERE study_id = ? AND status IN ('sent', 'opened') AND reminder_count < 3
    AND (last_reminder_at IS NULL OR last_reminder_at < datetime('now', '-2 days'))
    LIMIT 200
  `).all(studyId);

  const updateReminder = db.prepare(`
    UPDATE invitations SET reminder_count = reminder_count + 1, last_reminder_at = datetime('now') WHERE id = ?
  `);

  let sent = 0, failed = 0;
  for (const inv of invitations) {
    try {
      const mail = buildInviteEmail(inv, study);
      mail.subject = `Reminder: ${mail.subject}`;
      await transporter.sendMail(mail);
      updateReminder.run(inv.id);
      sent++;
    } catch (err) {
      failed++;
    }
  }

  res.json({ sent, failed });
});

/* ========== SMTP TEST ========== */

router.post('/invitations/test-smtp', masterAuth, async (req, res) => {
  const { testEmail } = req.body;
  const transporter = getTransporter();
  if (!transporter) {
    return res.status(400).json({ error: 'SMTP not configured. Set EYED_SMTP_HOST, EYED_SMTP_USER, EYED_SMTP_PASS.' });
  }

  try {
    await transporter.verify();
    if (testEmail) {
      await transporter.sendMail({
        from: `"${config.smtp.fromName}" <${config.smtp.fromEmail || config.smtp.user}>`,
        to: testEmail,
        subject: 'EyeD SMTP Test',
        text: 'If you received this email, your SMTP configuration is working correctly.',
      });
      return res.json({ success: true, message: `Test email sent to ${testEmail}` });
    }
    res.json({ success: true, message: 'SMTP connection verified' });
  } catch (err) {
    res.status(400).json({ error: `SMTP error: ${err.message}` });
  }
});

/* ========== PUBLIC ONBOARDING ========== */

// GET /onboard — serve the onboarding page (no auth)
router.get('/onboard', (req, res) => {
  res.sendFile('onboard.html', { root: require('path').join(__dirname, '..', 'public') });
});

// GET /onboard/validate — validate a token and return study + config info
router.get('/onboard/validate', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const inv = db.prepare(`
    SELECT i.*, s.name as study_name, s.description as study_description,
           s.target_urls, s.config as study_config
    FROM invitations i
    JOIN studies s ON i.study_id = s.id
    WHERE i.token = ?
  `).get(token);

  if (!inv) return res.status(404).json({ error: 'Invalid or expired invitation link' });

  // Mark as opened
  if (inv.status === 'pending' || inv.status === 'sent') {
    db.prepare("UPDATE invitations SET status = 'opened', opened_at = datetime('now') WHERE id = ?").run(inv.id);
  }

  // Find the API key for this study
  const apiKey = db.prepare(`
    SELECT key FROM api_keys WHERE project = ? AND active = 1 LIMIT 1
  `).get(inv.study_name);

  res.json({
    studyName: inv.study_name,
    studyDescription: inv.study_description,
    participantId: inv.participant_id,
    groupName: inv.group_name,
    targetUrls: inv.target_urls,
    apiKey: apiKey?.key || '',
    serverUrl: config.publicUrl,
    consentRequired: true,
    alreadyConsented: inv.consent_given === 1,
  });
});

// POST /onboard/consent — record participant consent
router.post('/onboard/consent', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const inv = db.prepare('SELECT * FROM invitations WHERE token = ?').get(token);
  if (!inv) return res.status(404).json({ error: 'Invalid token' });

  db.prepare(`
    UPDATE invitations SET consent_given = 1, consent_at = datetime('now') WHERE id = ?
  `).run(inv.id);

  // Also update/create participant record in participants table
  const existing = db.prepare('SELECT id FROM participants WHERE study_id = ? AND participant_id = ?').get(inv.study_id, inv.participant_id);
  if (existing) {
    db.prepare("UPDATE participants SET consent_given = 1, consent_date = datetime('now') WHERE id = ?").run(existing.id);
  } else {
    db.prepare(`
      INSERT INTO participants (study_id, participant_id, group_name, consent_given, consent_date, metadata)
      VALUES (?, ?, ?, 1, datetime('now'), ?)
    `).run(inv.study_id, inv.participant_id, inv.group_name, JSON.stringify({ email: inv.email }));
  }

  res.json({ success: true });
});

// POST /onboard/installed — mark the extension as installed
router.post('/onboard/installed', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const inv = db.prepare('SELECT * FROM invitations WHERE token = ?').get(token);
  if (!inv) return res.status(404).json({ error: 'Invalid token' });

  db.prepare("UPDATE invitations SET status = 'installed', installed_at = datetime('now') WHERE id = ?").run(inv.id);

  res.json({ success: true });
});

// POST /invitations/import-csv — bulk import from CSV text
router.post('/invitations/import-csv', masterAuth, (req, res) => {
  const { studyId, csv, groupName } = req.body;
  if (!studyId || !csv) return res.status(400).json({ error: 'studyId and csv required' });

  const study = db.prepare('SELECT id FROM studies WHERE id = ?').get(studyId);
  if (!study) return res.status(404).json({ error: 'Study not found' });

  const lines = csv.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean);
  const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const group = (groupName || 'default').substring(0, 100);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO invitations (study_id, email, group_name, token, participant_id)
    VALUES (?, ?, ?, ?, ?)
  `);

  let added = 0, skipped = 0;
  const invalid = [];

  const importAll = db.transaction(() => {
    for (const line of lines) {
      // Support: email or "name,email" or "email,name" formats
      const parts = line.split(',').map(p => p.trim().replace(/"/g, ''));
      const email = parts.find(p => emailRx.test(p));
      if (!email) { invalid.push(line.substring(0, 100)); skipped++; continue; }

      const token = generateToken();
      const pid = `P${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
      try {
        const r = insert.run(studyId, email.toLowerCase(), group, token, pid);
        if (r.changes > 0) added++;
        else skipped++;
      } catch (e) { skipped++; }
    }
  });
  importAll();

  res.json({ added, skipped, invalid: invalid.slice(0, 10), totalLines: lines.length });
});

module.exports = router;
