export const SUBDOMAIN_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const IPV4_REGEX =
  /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
export const HOSTNAME_REGEX =
  /^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}\.?$/i;

export const RECORD_TYPE_UI = {
  A: {
    label: "A record (IPv4)",
    placeholder: "e.g. 203.0.113.10",
    helper: "Maps this domain to an IPv4 address.",
    inputMode: "decimal",
    detailLabel: "IPv4 address",
    tooltip:
      "The A record maps this domain to a specific IPv4 address so browsers know where to connect.",
    tooltipLabel: "Learn about A records",
  },
  CNAME: {
    label: "CNAME target",
    placeholder: "e.g. app.example.com",
    helper: "Points this domain to another hostname.",
    inputMode: "url",
    detailLabel: "Canonical hostname",
    tooltip:
      "The CNAME record aliases this domain to another hostname. The target must already resolve to the right service.",
    tooltipLabel: "Learn about CNAME records",
  },
};
