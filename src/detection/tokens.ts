/**
 * Unsubscribe-intent tokens, maintained in one place.
 *
 * These are matched case-insensitively, and with a loose separator so that
 * `opt out`, `opt-out` and `opt_out` all match one entry. Keep them here rather
 * than scattered through the detection code: this list is the part of the
 * detector most likely to need a change six months from now, and it should be
 * possible to add a language without reading any parsing logic.
 *
 * Only tier 4 (body scraping) uses these. Tiers 1–3 read headers, which are
 * defined by RFC and need no vocabulary.
 */

/** Phrases that mean "this link stops the mail". Strong signal. */
export const UNSUBSCRIBE_TOKENS: readonly string[] = [
  // English
  'unsubscribe',
  'un-subscribe',
  'opt out',
  'opt-out',
  'optout',
  'stop receiving',
  'stop these emails',
  'stop emails',
  'remove me',
  'remove my email',
  'no longer wish to receive',
  'no longer want to receive',
  'cancel subscription',
  'cancel my subscription',
  'end subscription',
  // French
  'désabonner',
  'desabonner',
  'se désabonner',
  'désinscription',
  'desinscription',
  'me désabonner',
  // German
  'abbestellen',
  'abmelden',
  'newsletter abbestellen',
  'vom newsletter abmelden',
  'austragen',
  // Spanish
  'darse de baja',
  'baja',
  'cancelar suscripción',
  'cancelar suscripcion',
  'anular suscripción',
  // Italian
  'disiscriviti',
  'cancellati',
  'annulla iscrizione',
  // Portuguese
  'cancelar inscrição',
  'cancelar inscricao',
  'descadastrar',
  // Dutch
  'uitschrijven',
  'afmelden',
  // Nordic
  'avsluta prenumeration',
  'afmeld',
  'meld deg av',
  // Polish
  'wypisz się',
  'wypisz sie',
  'zrezygnuj',
];

/**
 * Phrases that mean "this link leads to somewhere you can stop the mail".
 *
 * Weaker than the list above: a preference centre is where unsubscribing
 * happens, but the link itself does not unsubscribe you, and "manage
 * preferences" also appears on plenty of links that only change frequency. They
 * are detected, scored lower, and never executed automatically.
 */
export const PREFERENCE_TOKENS: readonly string[] = [
  'manage preferences',
  'email preferences',
  'manage your preferences',
  'manage subscriptions',
  'manage your subscription',
  'subscription preferences',
  'notification preferences',
  'update your preferences',
  'communication preferences',
  'préférences',
  'preferences',
  'einstellungen',
  'e-mail-einstellungen',
  'preferencias',
  'preferenze',
  'voorkeuren',
];

/**
 * Path and query fragments that indicate an unsubscribe endpoint even when the
 * link text says nothing useful ("Click here", an image, a bare URL).
 */
export const URL_TOKENS: readonly string[] = [
  'unsubscribe',
  'unsub',
  'optout',
  'opt-out',
  'opt_out',
  'remove',
  'desabonner',
  'desinscription',
  'abmelden',
  'abbestellen',
  'uitschrijven',
  'baja',
  'cancel-subscription',
  'email-preferences',
  'subscription/manage',
  'list-manage',
  'preferences',
  '/leave',
  'stoppen',
];

/**
 * Normalise text for token matching: lowercase, strip accents so `désabonner`
 * matches `desabonner`, and flatten separators so `opt-out`, `opt_out` and
 * `opt   out` all reduce to the same thing.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s\-_.]+/g, ' ')
    .trim();
}

function matches(haystack: string, tokens: readonly string[]): string | undefined {
  const normalized = normalizeForMatch(haystack);
  if (normalized.length === 0) return undefined;
  for (const token of tokens) {
    if (normalized.includes(normalizeForMatch(token))) return token;
  }
  return undefined;
}

export function matchUnsubscribeToken(text: string): string | undefined {
  return matches(text, UNSUBSCRIBE_TOKENS);
}

export function matchPreferenceToken(text: string): string | undefined {
  return matches(text, PREFERENCE_TOKENS);
}

/**
 * Match against a URL's path and query only — never its host. A link to
 * `https://unsubscribe-tracker.example/x` should not count as intent just
 * because the vendor named their domain that way.
 */
export function matchUrlToken(url: string): string | undefined {
  let target = url;
  try {
    const parsed = new URL(url);
    target = `${parsed.pathname}${parsed.search}`;
  } catch {
    // Relative or malformed href: match the whole thing rather than nothing.
  }
  return matches(target, URL_TOKENS);
}
