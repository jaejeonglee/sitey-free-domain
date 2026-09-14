// The machine-readable copy of the policy served at /api/policies/privacy.
// The page a person reads is /privacy, rendered from content/legal/privacy.*.md
// — keep the two in step. The markdown is the one written for humans; this is
// the same facts in a shape an integration can read.
module.exports = {
  version: "2.0.0",
  updatedAt: "2026-09-14",
  contact: {
    email: "ljj5256@gmail.com",
  },
  scope: [
    "This policy applies to sitey (sitey.my) and the subdomains it issues, including the web app and the REST and MCP APIs.",
    "The version a person reads is at https://sitey.my/privacy.",
  ],
  sections: [
    {
      id: "data-collected",
      title: "What we collect",
      statements: [
        "Google sign-in: email address, Google account identifier, display name, profile picture URL, and the time you signed up.",
        "Subdomain records: the name, its root domain, where it points, and the times of creation and expiry.",
        "For records created without an account, the creator's IP address — with no account it is the only thing that identifies the owner. Records under an account do not store it.",
        "API keys: a hash of the key and its first few characters. The key itself is never stored.",
        "Sessions: an identifier with issue and expiry times. No IP address or browser details.",
        "Server logs: time, method, route pattern, response code, duration, the subject making the request, and the IP address as an irreversible hash.",
        "Email: which kind of message was sent and when, and a hash of the recipient address.",
      ],
    },
    {
      id: "data-use",
      title: "How we use it",
      statements: [
        "Provision and manage DNS records on your behalf.",
        "Establish who owns a record, and prevent abuse.",
        "Send expiry notices so a name is not lost without warning.",
        "Diagnose faults and find where the service fails people.",
      ],
    },
    {
      id: "retention",
      title: "Retention",
      statements: [
        "Account details are erased without delay when you ask us to close your account.",
        "Subdomain records are kept until deleted or reclaimed at expiry.",
        "API keys are kept until you delete them.",
        "Sessions are invalid once expired and are removed periodically.",
        "Server logs are kept for as long as fault diagnosis and abuse assessment require, then deleted oldest first.",
        "Where the law requires a longer period, we follow it.",
      ],
    },
    {
      id: "processors",
      title: "Processors",
      statements: [
        "Google LLC — sign-in, and AdSense for advertising cookies.",
        "Resend, Inc. — sending notice emails; receives the address and message content.",
        "DigitalOcean, LLC — hosting the servers that hold the above.",
        "We do not sell personal data, and we do not pass it to anyone else.",
      ],
    },
    {
      id: "international-transfer",
      title: "Transfer outside Korea",
      statements: [
        "All processors are outside Korea and data is stored on servers outside Korea.",
        "Using the service means accepting this transfer; without it the service cannot be provided.",
      ],
    },
    {
      id: "cookies",
      title: "Cookies",
      statements: [
        "A session cookie keeps you signed in and does nothing else. It is HttpOnly and is not sent off this site.",
        "This site uses Google AdSense. Google and its partners may use cookies to serve adverts based on your prior visits.",
        "Personalised advertising can be turned off at adssettings.google.com, and third-party vendor cookies at aboutads.info.",
      ],
    },
    {
      id: "rights",
      title: "Your rights",
      statements: [
        "You may ask to see, correct, erase, or stop the processing of your personal data.",
        "Email ljj5256@gmail.com from the address you signed up with. We respond within 30 days.",
        "You can delete your subdomain records yourself from the dashboard at any time.",
      ],
    },
    {
      id: "security",
      title: "Security measures",
      statements: [
        "All traffic between your browser and our servers is encrypted with TLS.",
        "API keys are stored only as hashes; the originals are never kept.",
        "Server access is restricted to key-based authentication.",
        "IP addresses in service logs are recorded as hashes.",
      ],
    },
  ],
};
