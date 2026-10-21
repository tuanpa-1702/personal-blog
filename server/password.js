// Shared password policy, so the three places that hash a password (self-service
// change, admin reset, OTP reset) and the two that create an account cannot drift
// apart on cost factor or minimum length.
//
// Raised from 6 to 10 (security.md item 15). Only gates NEW/CHANGED passwords -
// existing bcrypt hashes in the users table are untouched, so nobody already
// holding a shorter password is locked out; they just cannot set a shorter one
// again on their next change. The seeded admin account is held to a higher bar
// because it is created non-interactively from .env and is the most valuable
// account on the site.

const BCRYPT_ROUNDS = 10;

// Minimum for accounts created or changed over HTTP.
const MIN_PASSWORD_LENGTH = 10;

// Minimum for the first-run admin seeded out of ADMIN_PASSWORD.
const MIN_ADMIN_SEED_PASSWORD_LENGTH = 12;

// bcrypt hashes at most the first 72 BYTES of the input and silently ignores the
// rest - so without a ceiling, two different long passwords sharing a 72-byte
// prefix are the same password, and a megabyte-long one costs the server a
// megabyte of hashing for nothing. Measured in bytes, not characters: Vietnamese
// text is multi-byte in UTF-8, so a 40-character password can already exceed 72.
const MAX_PASSWORD_BYTES = 72;

// Returns an error message in Vietnamese, or null when the password is acceptable.
function validatePassword(password, { min = MIN_PASSWORD_LENGTH } = {}) {
  const value = String(password ?? '');
  if (value.length < min) return `Mật khẩu phải có ít nhất ${min} ký tự.`;
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) {
    return `Mật khẩu quá dài (tối đa ${MAX_PASSWORD_BYTES} byte).`;
  }
  return null;
}

module.exports = {
  BCRYPT_ROUNDS,
  MIN_PASSWORD_LENGTH,
  MIN_ADMIN_SEED_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  validatePassword,
};
