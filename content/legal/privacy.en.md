# Privacy Policy

Effective 2026-09-14 · Operated by sitey (sitey.my)

## 1. What we collect

**When you sign in with Google**

- Email address
- Google account identifier
- Display name and profile picture URL
- Time of sign-up

**When you create a subdomain**

- The name you chose and which root domain it sits under
- Where it points: the IP for an A record, the hostname for a CNAME, the value for a TXT record
- Times of creation and expiry
- **For records created without an account, the creator's IP address.** With no account this is the only thing that identifies the owner. Records created under an account do not store it

**When you issue an API key**

- A hash of the key and its first few characters. The key itself is never stored
- Times of issue and last use

**To keep you signed in**

- A session identifier with its issue and expiry times. No IP address or browser details are stored with it

**While you use the service (server logs)**

- Time, method, the route pattern of the page requested, response code, time taken
- The subject making the request — an account, or an anonymous identifier
- **The IP address as an irreversible hash, never in the clear**
- The subdomain names you search for or attempt are not written to the log

**When we email you**

- Which kind of message was sent and when, and a hash of the recipient address

## 2. Why we use it

| Data | Purpose |
| --- | --- |
| Email, Google identifier | Identifying you, signing you in |
| Name, profile picture | Displaying your account |
| Subdomain records | Providing the DNS service |
| IP on account-less records | Establishing ownership, preventing abuse |
| API key hash | Authentication |
| Server logs | Diagnosing faults, preventing abuse, improving the service |
| Email address | Sending expiry notices |

## 3. How long we keep it

- **Account details** — erased without delay when you ask us to close your account
- **Subdomain records** — until the record is deleted or reclaimed at expiry
- **API keys** — until you delete them
- **Sessions** — invalid once expired, and removed periodically
- **Server logs** — kept for as long as fault diagnosis and abuse assessment require, then deleted oldest first
- Where the law requires a longer period, we follow it

## 4. Processors

| Processor | What they do | What reaches them |
| --- | --- | --- |
| Google LLC | Sign-in | Your Google account details, held by Google |
| Google LLC (AdSense) | Serving adverts | Advertising cookies |
| Resend, Inc. | Sending notices | Email address and message content |
| DigitalOcean, LLC | Hosting | The servers holding the above |

We do not sell personal data, and we do not pass it to anyone else.

## 5. Transfer outside Korea

All four processors are outside Korea, and data is stored on servers outside Korea. Server locations follow each processor's own policy.

Using the service means accepting this transfer. If you do not accept it, the service cannot be provided.

## 6. Cookies

**Session cookie (required)**

It keeps you signed in and does nothing else. It is set HttpOnly so page scripts cannot read it, and it is not sent anywhere off this site. Blocking cookies means you cannot sign in.

**Advertising cookies (Google AdSense)**

This site uses Google AdSense. Google and its partners may use cookies to serve adverts based on your prior visits to this and other sites.

- How Google uses advertising cookies: `google.com/policies/technologies/ads`
- You can turn personalised advertising off at `adssettings.google.com`
- Third-party vendor cookies can also be opted out of at `aboutads.info`

## 7. Your rights

You may ask us to **show you** the personal data we hold, **correct** it, **erase** it, or **stop processing** it.

Email `hello@sitey.one` from the address you signed up with. **We respond within 30 days.**

You can also delete your subdomain records yourself from the dashboard at any time.

## 8. Erasure

Once the retention period ends or the purpose is met, data is erased without delay. Electronic records are deleted by means that do not permit recovery.

## 9. How we protect it

- All traffic between your browser and our servers is encrypted with TLS
- API keys are stored only as hashes; the originals are never kept
- Server access is restricted to key-based authentication
- IP addresses in service logs are recorded as hashes

## 10. Contact

Privacy enquiries: `hello@sitey.one`

## 11. Changes

If this policy changes, we will publish the new version on the site with the date it takes effect.
