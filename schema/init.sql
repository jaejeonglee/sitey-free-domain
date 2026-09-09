-- dns-controller schema
-- Run against MySQL database

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  google_id VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255),
  picture TEXT,
  -- NULL means "use SUBDOMAIN_LIMIT_DEFAULT". A number here is an exception
  -- granted to one account; never a name in the source. deploy/migrations/003.
  subdomain_limit INT NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id VARCHAR(36) PRIMARY KEY,
  user_id INT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS managed_domains (
  id INT AUTO_INCREMENT PRIMARY KEY,
  domain_name VARCHAR(255) NOT NULL UNIQUE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS subdomains (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT,
  domain_id INT NOT NULL,
  subdomain VARCHAR(255) NOT NULL,
  record_value VARCHAR(255) NOT NULL,
  record_type VARCHAR(10) DEFAULT 'A',
  warning_count INT DEFAULT 0,
  last_checked_at TIMESTAMP NULL,
  last_warning_at TIMESTAMP NULL,
  unreachable_notified_at TIMESTAMP NULL,
  owner_type ENUM('user','agent') DEFAULT 'user',
  owner_ip VARCHAR(45) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- NULL means never expires; the expiry job skips those rows.
  expires_at TIMESTAMP NULL,
  renewal_notice_stage TINYINT NULL,
  UNIQUE INDEX (subdomain, domain_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (domain_id) REFERENCES managed_domains(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subdomain_txt_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  subdomain_id INT NOT NULL,
  host_prefix VARCHAR(255) NOT NULL,
  txt_value TEXT NOT NULL,
  UNIQUE INDEX (subdomain_id, host_prefix),
  FOREIGN KEY (subdomain_id) REFERENCES subdomains(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  key_hash VARCHAR(64) NOT NULL UNIQUE,
  key_prefix VARCHAR(12) NOT NULL,
  name VARCHAR(50) DEFAULT 'default',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS credit_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  -- NULL for a caller with no account: an anonymous payment buys the request
  -- that carried it, because there is nothing to save a balance against.
  user_id INT NULL,
  payer VARCHAR(128) NULL,
  amount_micros BIGINT NOT NULL,
  channel VARCHAR(16) NOT NULL,
  reference VARCHAR(128) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- What stops one settled payment being spent twice.
  UNIQUE INDEX uniq_channel_reference (channel, reference),
  INDEX idx_user (user_id),
  INDEX idx_payer (payer),
  -- SET NULL, not CASCADE: deleting an account must not delete the record that
  -- money changed hands. deploy/migrations/004.
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Migration for existing databases:
-- ALTER TABLE subdomains ADD COLUMN owner_type ENUM('user','agent') DEFAULT 'user';
-- ALTER TABLE subdomains ADD COLUMN owner_ip VARCHAR(45) DEFAULT NULL;
-- deploy/migrations/001-unreachable-notice.sql  (unreachable_notified_at)
-- deploy/migrations/002-subdomain-expiry.sql     (expires_at, renewal_notice_stage)
-- deploy/migrations/003-subdomain-limit.sql      (users.subdomain_limit)
-- deploy/migrations/004-credit-ledger.sql        (credit_entries)
