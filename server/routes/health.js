const router = require('express').Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: Date.now() });
});

module.exports = router;
