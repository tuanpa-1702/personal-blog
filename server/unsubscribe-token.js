const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./env');

// Tokens for the one-click unsubscribe link carried by new-post notifications.
//
// Gmail and Yahoo require bulk mail to offer one-click unsubscribe
// (List-Unsubscribe-Post), and a reader who cannot get out of a mailing in one
// click presses "spam" instead - which is a vote against every future message,
// not just that one. The site already stores the opt-in per user
// (users.email_notifications), so the token only has to say WHO is asking, and
// the route flips that one column.
//
// Deliberately NOT a login token: the purpose claim below is checked on the way
// in, and the auth middleware looks for its own claims on the way into any
// authenticated route, so neither token opens the other's door.
const PURPOSE = 'email-unsubscribe';

// No expiry. A notification can sit in a mailbox for months before its reader
// decides they have had enough, and an unsubscribe link that 401s at that moment
// is worse than none: it tells them the only working exit is the spam button.
// The token reveals nothing but a user id and cannot be spent on anything else.
function signUnsubscribeToken(userId) {
  return jwt.sign({ uid: Number(userId), purpose: PURPOSE }, JWT_SECRET);
}

// The user id the token names, or null when it is forged, mangled in transit by
// a mail client that line-wrapped it, or simply not ours.
function verifyUnsubscribeToken(token) {
  try {
    const payload = jwt.verify(String(token || ''), JWT_SECRET);
    if (!payload || payload.purpose !== PURPOSE || !payload.uid) return null;
    return Number(payload.uid);
  } catch {
    return null;
  }
}

module.exports = { signUnsubscribeToken, verifyUnsubscribeToken };
