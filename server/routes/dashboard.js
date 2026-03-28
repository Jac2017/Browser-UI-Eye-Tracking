/**
 * Dashboard HTML serving routes.
 */

const router = require('express').Router();
const path = require('path');

router.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

router.get('/dashboard/session/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'session.html'));
});

router.get('/dashboard/study/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'study.html'));
});

module.exports = router;
