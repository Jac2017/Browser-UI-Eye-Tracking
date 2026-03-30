/**
 * Decryption service — mirrors the extension's AES-256-GCM encryption.
 * Derives the same key from the API key using PBKDF2.
 */

const crypto = require('crypto');

const SALT = 'eyed-upload-salt-v1';
const ITERATIONS = 100000;
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12;  // 96-bit IV for GCM
const TAG_LENGTH = 16; // 128-bit auth tag

// Cache derived keys per API key string with TTL
const KEY_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const keyCache = new Map();

function deriveKey(apiKey) {
  const cached = keyCache.get(apiKey);
  if (cached && Date.now() - cached.time < KEY_CACHE_TTL) return cached.key;

  const key = crypto.pbkdf2Sync(
    apiKey, SALT, ITERATIONS, KEY_LENGTH, 'sha256'
  );
  keyCache.set(apiKey, { key, time: Date.now() });

  // Lazy cleanup: remove expired entries when cache grows
  if (keyCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of keyCache) {
      if (now - v.time >= KEY_CACHE_TTL) keyCache.delete(k);
    }
  }

  return key;
}

/**
 * Decrypt a payload that was encrypted by the extension's encryptPayload().
 * Input: base64(iv + ciphertext + authTag)
 */
function decrypt(base64Data, apiKey) {
  const combined = Buffer.from(base64Data, 'base64');
  if (combined.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Encrypted payload too short');
  }

  const iv = combined.subarray(0, IV_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH, combined.length - TAG_LENGTH);
  const authTag = combined.subarray(combined.length - TAG_LENGTH);

  const key = deriveKey(apiKey);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString('utf8'));
}

/**
 * Verify HMAC-SHA256 signature.
 */
function verifySignature(body, signature, apiKey) {
  if (!signature || !apiKey) return false;

  const expected = crypto.createHmac('sha256', apiKey)
    .update(body)
    .digest('base64');

  return crypto.timingSafeEqual(
    Buffer.from(signature, 'base64'),
    Buffer.from(expected, 'base64')
  );
}

module.exports = { decrypt, verifySignature, deriveKey };
