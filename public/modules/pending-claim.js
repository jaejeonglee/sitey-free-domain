// public/modules/pending-claim.js — the name somebody was taking when we
// stopped them to sign in.
//
// "Get it" on a free name needs an account, and getting one is a round trip
// through Google that ends on /dashboard. The name did not survive that trip:
// you typed `abcd`, pressed the button, came back signed in, and were looking
// at a list of the records you already had with `abcd` nowhere on the screen
// (reported 2026-09-18). So the pair — name and root — is put down here on the
// way out and picked up on the way back.
//
// Two rules make that safe to do with storage:
//
//   1. **Every touch is wrapped.** sessionStorage is not merely empty in a
//      private window with site data blocked, it throws on the way in and on
//      the way out. A browser that refuses to remember has to behave exactly
//      as it does today — sign in, land on the dashboard, nothing said about
//      it — because there is nothing the reader could do about it anyway.
//   2. **Reading deletes.** A value left behind would bounce somebody who
//      only wanted their dashboard onto the home page instead, for a reason
//      they could not see. It is removed before it is even parsed, so a value
//      we cannot understand cannot stay to do it twice.
//
// What comes back out is not trusted: the name goes through the same regex
// the server uses, and the root has to be one we still hand out — which only
// the home page can tell, so it checks there (public/modules/home.js).
//
// Since the first screen creates in place (2026-11-10) the trip also carries
// what was filled in below the name — the hosting chip, the record type, the
// value — so coming back is one press of «Create», not a form to redo. Those
// three are optional: a value written before them ({subdomain, domain}) still
// reads, and a malformed one drops just that part, never the name.
import { SUBDOMAIN_REGEX } from "./constants.js";

const KEY = "sitey-claim";

const RECORD_TYPES = new Set(["A", "CNAME", "REDIRECT"]);
// The same ceiling the server puts on a REDIRECT URL, the longest value there is.
const MAX_VALUE_LENGTH = 2048;
const HOST_ID = /^[a-z]{1,32}$/;

/**
 * Put the name down on the way to the sign-in.
 *
 * @param {string} subdomain
 * @param {string} domain
 * @param {{host?: string, recordType?: string, value?: string}} [details]
 *   what was chosen below the name, if anything.
 */
export function savePendingClaim(subdomain, domain, details = {}) {
  const claim = { subdomain, domain };
  if (details.host) claim.host = details.host;
  if (details.recordType) claim.recordType = details.recordType;
  if (details.value) claim.value = details.value;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(claim));
  } catch {
    // Storage is off. Signing in still works; only the walk back is poorer.
  }
}

/**
 * Pick it up — and drop it, in that order.
 *
 * @returns {{subdomain: string, domain: string, host: string|null,
 *   recordType: string|null, value: string|null}|null} null for absent,
 *   unreadable, or anything whose name or root we would not have written.
 *   The three details come back null when missing or not in a shape we write.
 */
export function takePendingClaim() {
  let raw = null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const { subdomain, domain, host, recordType, value } = JSON.parse(raw) || {};
    if (typeof subdomain !== "string" || !SUBDOMAIN_REGEX.test(subdomain)) return null;
    if (typeof domain !== "string" || !domain) return null;
    return {
      subdomain,
      domain,
      host: typeof host === "string" && HOST_ID.test(host) ? host : null,
      recordType: RECORD_TYPES.has(recordType) ? recordType : null,
      value:
        typeof value === "string" && value.length <= MAX_VALUE_LENGTH && value.trim()
          ? value
          : null,
    };
  } catch {
    return null;
  }
}

/* ============================================
   The last few metres

   The address bar carries the name over — ?check=, the same channel the
   blog's domain chips use — but not which root was chosen, and not what was
   filled in below the name. Those travel in memory for the one render that
   follows the redirect.

   Deliberately not in the URL: /?check=x&host=vercel&value=… would be a link
   anybody could send, and a link that arrives with a record half-made is not
   what ?check= means anywhere else it is used.
   ============================================ */

let held = null;

export function holdClaim(claim) {
  held = claim;
}

/** Read once. A second render of the home page is an ordinary one. */
export function takeHeldClaim() {
  const claim = held;
  held = null;
  return claim;
}

/* ============================================
   The address somebody was opening (2026-11-11)

   `/dashboard?edit=jay.sitey.my` opens that address's edit window — the link
   in the «not loading» mail and on an expired renewal page. Signed out, the
   router sends them to sign in first and the query does not survive Google;
   and a save refused because the session ran out sends them the same way with
   what they had typed. Both are put down here and picked up by the dashboard,
   under the same two rules as the claim above: every touch wrapped, reading
   deletes.
   ============================================ */

const EDIT_KEY = "sitey-edit";
const FQDN = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_TXT_LENGTH = 512;

/**
 * @param {string} key - the address, e.g. "jay.sitey.my"
 * @param {{value?: string, txt?: string, type?: string}} [draft] - what was
 *   typed in its edit window, when there was something.
 */
export function savePendingEdit(key, draft = null) {
  const edit = { key: String(key || "").toLowerCase() };
  if (draft) edit.draft = { value: draft.value, txt: draft.txt, type: draft.type };
  try {
    sessionStorage.setItem(EDIT_KEY, JSON.stringify(edit));
  } catch {
    // Storage is off: the window simply is not reopened.
  }
}

/**
 * @returns {{key: string, draft: {value: string, txt: string, type: string}|null}|null}
 *   null for absent or not an address; a draft in any other shape is dropped
 *   and the address kept.
 */
export function takePendingEdit() {
  let raw = null;
  try {
    raw = sessionStorage.getItem(EDIT_KEY);
    sessionStorage.removeItem(EDIT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const { key, draft } = JSON.parse(raw) || {};
    if (typeof key !== "string" || !FQDN.test(key)) return null;
    const ok =
      draft &&
      typeof draft.value === "string" && draft.value.length <= MAX_VALUE_LENGTH &&
      typeof draft.txt === "string" && draft.txt.length <= MAX_TXT_LENGTH &&
      RECORD_TYPES.has(draft.type);
    return { key, draft: ok ? { value: draft.value, txt: draft.txt, type: draft.type } : null };
  } catch {
    return null;
  }
}
