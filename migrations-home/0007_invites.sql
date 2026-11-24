-- ═══════════════════════════════════════════════════════════════
-- Home — first sign-in links
--
-- An account can exist because history names the person (a CSV or SQL
-- import) before anybody has chosen a password. An admin mints a
-- one-time link instead of choosing one for them; the person opens it
-- and sets their own password at /claim.
--
-- Only the SHA-256 of the token is stored, like a session token: the
-- database never holds a usable link. `used_at` makes it one-time,
-- `expires_at` makes it temporary, and one open link per person is
-- enforced by createInvite() replacing the previous one.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_home_invites_user ON invites(user_id);
