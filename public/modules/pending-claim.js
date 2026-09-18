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
import { SUBDOMAIN_REGEX } from "./constants.js";

const KEY = "sitey-claim";

/** Put the name down on the way to the sign-in. */
export function savePendingClaim(subdomain, domain) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ subdomain, domain }));
  } catch {
    // Storage is off. Signing in still works; only the walk back is poorer.
  }
}

/**
 * Pick it up — and drop it, in that order.
 *
 * @returns {{subdomain: string, domain: string}|null} null for absent,
 *   unreadable, or anything whose shape we would not have written.
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
    const { subdomain, domain } = JSON.parse(raw) || {};
    if (typeof subdomain !== "string" || !SUBDOMAIN_REGEX.test(subdomain)) return null;
    if (typeof domain !== "string" || !domain) return null;
    return { subdomain, domain };
  } catch {
    return null;
  }
}

/* ============================================
   The last few metres

   The address bar carries the name over — ?check=, the same channel the
   blog's domain chips use — but not which root was chosen, and not that a
   form should open by itself. Those travel in memory for the one render that
   follows the redirect.

   Deliberately not in the URL: /?check=x&open=sitey.my would be a link anybody
   could send, and a link that opens a form on arrival is not what ?check=
   means anywhere else it is used.
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
