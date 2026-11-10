export const SUBDOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const IPV4_REGEX =
  /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
export const HOSTNAME_REGEX =
  /^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}\.?$/i;

/**
 * How many days before expiry the dashboard starts flagging a record.
 *
 * The same fortnight renewal opens in — REMINDER_DAYS[0] in
 * services/expiry.js, which is also when the first reminder is sent. The
 * number has to be repeated here because nothing serves it to the browser; a
 * test in tests/expiry.test.js fails if the two ever part company.
 */
export const RENEWAL_WINDOW_DAYS = 14;

export const RECORD_TYPE_UI = {
  A: {
    placeholder: "e.g. 203.0.113.10",
    inputMode: "decimal",
    detailLabel: "IPv4 address",
  },
  CNAME: {
    placeholder: "e.g. app.example.com",
    inputMode: "url",
    detailLabel: "Canonical hostname",
  },
  REDIRECT: {
    placeholder: "https://…",
    inputMode: "url",
    detailLabel: "Redirect URL",
  },
};
