-- 004 — one balance, however the money arrived.
--
-- Two doors are planned and neither is open. An agent pays over HTTP with a
-- stablecoin (services/x402.js); a person would pay with a card, which an
-- agent cannot do because a card needs somebody to press a button in a
-- browser. The application must not care which door a payment came through —
-- it has one question, "how much can this account still spend", and a second
-- door should be a new value in `channel` and nothing else.
--
-- Entries, not a balance column. A balance can always be added up from
-- entries; entries can never be recovered from a balance. Same reason the rest
-- of this service writes down what happened rather than only what is true now:
-- code can be written later, history cannot.
--
-- `amount_micros` is signed and in millionths of one unit (USDC has six
-- decimals), so no amount here is ever a float. Only positive entries are
-- written today — a payment raises the account's ceiling rather than being
-- drawn down per request — and the column is signed so that metering can be
-- added later without changing the shape of the table.
--
-- UNIQUE (channel, reference) is what stops one settled transaction being
-- spent twice: the reference is the settlement's own identifier, so a replayed
-- payment header collides with the row it already wrote.
--
-- Not run by the application. Apply it by hand:
--
--   mysql -u <user> -p <database> < deploy/migrations/004-credit-ledger.sql

CREATE TABLE IF NOT EXISTS credit_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  -- Whose balance this is. NULL for a caller with no account: an anonymous
  -- payment buys the request that carried it and cannot be saved up, because
  -- there is nothing to save it against. Wanting a balance means wanting an
  -- account, which is the honest answer anyway.
  user_id INT NULL,
  -- Who paid, as the channel names them — a wallet address for x402. Kept even
  -- when user_id is set, because it is the only handle a refund or a dispute
  -- would have.
  payer VARCHAR(128) NULL,
  amount_micros BIGINT NOT NULL,
  -- 'x402' today. A card would be 'card' and nothing else would change.
  channel VARCHAR(16) NOT NULL,
  -- The channel's own identifier for this payment (a transaction hash).
  reference VARCHAR(128) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE INDEX uniq_channel_reference (channel, reference),
  INDEX idx_user (user_id),
  INDEX idx_payer (payer),
  -- SET NULL, not CASCADE as elsewhere in this schema. Deleting an account
  -- must not delete the record that money changed hands: that record is what a
  -- refund, a dispute or a tax return is answered from. The row survives with
  -- `payer` still naming who paid.
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Check before leaving: an empty table, and the uniqueness that protects it.
--
--   SHOW INDEX FROM credit_entries WHERE Key_name = 'uniq_channel_reference';
--   SELECT COUNT(*) FROM credit_entries;   -- expect 0

-- What an account has paid for, at any time:
--
--   SELECT user_id, SUM(amount_micros) FROM credit_entries GROUP BY user_id;

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
-- Safe to drop while the code is deployed: services/credits.js tolerates the
-- table being absent, because the code may equally arrive before this file is
-- run. Nothing is written to it at all until X402_ENABLED is switched on.
--
-- 🔴 Do not drop it once anything is in it. Those rows are payments.
--
--   DROP TABLE credit_entries;
