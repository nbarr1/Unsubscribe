/**
 * Normalisation rules, kept as data in one file.
 *
 * ADR-005 is built on the premise that **these rules will change**: a new VERP
 * pattern turns up, a platform needs a special case, a threshold is wrong.
 * Keeping them here rather than scattered through the code means a change is a
 * diff to a table, and means the "changing a rule must not orphan a decision"
 * test has something concrete to change.
 */

/**
 * Local-part segments that look machine-generated get collapsed to `*`.
 *
 * Thresholds matter more than cleverness here. `news2@` must survive intact
 * (it is a real, stable address); `bounce-7f3a91c2@` must not (it is per
 * recipient). Erring toward *not* collapsing is the safe direction: leaving a
 * VERP address un-normalised fragments one sender into several rows, which the
 * user can fix with `merge`, while over-collapsing folds distinct senders
 * together, which they can only fix by splitting — and splitting is the
 * operation ADR-005 says must never happen behind their back.
 */
export interface VariableSegmentThresholds {
  /** A run of digits this long or longer is a counter, not a name. */
  digits: number;
  /** A hex-looking run this long or longer is a hash or an id. */
  hex: number;
  /** A mixed alphanumeric run this long or longer, containing a digit. */
  mixed: number;
}

export const VARIABLE_SEGMENT_THRESHOLDS: VariableSegmentThresholds = {
  digits: 3,
  hex: 8,
  mixed: 12,
};

/** Characters that separate segments inside a local part. */
export const SEGMENT_DELIMITERS = /[-+_.=]/;

/**
 * Local-part prefixes that mark an envelope-sender / bounce address. When one
 * of these leads the local part, the whole remainder is treated as variable —
 * `msprvs1=abc=def@` has no stable segment worth keeping.
 */
export const BOUNCE_PREFIXES: readonly string[] = [
  'bounce',
  'bounces',
  'bounce-md',
  'bounces-md',
  'return',
  'returns',
  'reply',
  'sr',
  'srs0',
  'srs1',
  'msprvs1',
  'msprvs',
  'prvs',
  'mailer-daemon',
  'postmaster-bounce',
  'envelope-from',
  'bnc',
  'bn',
];

/**
 * Subaddressing separator. `you+shopping@gmail.com` and `you@gmail.com` are the
 * same mailbox; for a *sender* address the tag is likewise per-recipient noise.
 */
export const SUBADDRESS_SEPARATOR = '+';

/**
 * Registrable-domain computation uses ICANN suffixes only, not the private
 * section of the Public Suffix List.
 *
 * With private suffixes on, `user.github.io` is its own registrable domain and
 * every subdomain of a shared platform becomes a separate identity — which is
 * right for web origins and wrong for mail, where a platform legitimately sends
 * for many customers from one registrable domain. ICANN-only also keeps the
 * `suspicious` check (ADR: detection) conservative: it compares
 * `sendgrid.net` to `sendgrid.net` rather than two unrelated subdomains.
 */
export const ALLOW_PRIVATE_SUFFIXES = false;
