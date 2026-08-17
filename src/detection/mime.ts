/**
 * The small amount of MIME this tool actually needs.
 *
 * Deliberately hand-rolled rather than pulling in a full mail parser. The
 * requirement is narrow — unfold headers, decode RFC 2047 words in `From` and
 * `Subject`, find the HTML part, decode quoted-printable or base64 — and a
 * dependency that parses every message on earth is a large moving part to
 * maintain for a tool that must still work untouched in four months.
 */

export type Headers = Map<string, string[]>;

/** Case-insensitive single-value header lookup. */
export function header(headers: Headers, name: string): string | undefined {
  return headers.get(name.toLowerCase())?.[0];
}

/** Case-insensitive all-values lookup, for headers that legitimately repeat. */
export function headerAll(headers: Headers, name: string): string[] {
  return headers.get(name.toLowerCase()) ?? [];
}

/**
 * Parse a header block, unfolding continuation lines (RFC 5322 §2.2.3).
 *
 * A folded header is a line whose continuation begins with whitespace. Getting
 * this wrong truncates long `List-Unsubscribe` values at the fold, which is
 * exactly where a second URI usually lives.
 */
export function parseHeaders(block: string): Headers {
  const headers: Headers = new Map();
  const lines = block.replace(/\r\n/g, '\n').split('\n');

  let current: { name: string; value: string } | undefined;

  const flush = (): void => {
    if (current === undefined) return;
    const key = current.name.toLowerCase();
    const existing = headers.get(key);
    if (existing === undefined) {
      headers.set(key, [current.value.trim()]);
    } else {
      existing.push(current.value.trim());
    }
    current = undefined;
  };

  for (const line of lines) {
    if (line.length === 0) break; // End of the header block.
    if (/^[ \t]/.test(line) && current !== undefined) {
      // Folding whitespace: the fold itself is a single space.
      current.value += ' ' + line.trim();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue; // Not a header line; ignore rather than throw.
    flush();
    current = { name: line.slice(0, colon).trim(), value: line.slice(colon + 1) };
  }
  flush();

  return headers;
}

/** Split a raw message into its header block and its body. */
export function splitMessage(raw: string): { headers: Headers; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  const separator = normalized.indexOf('\n\n');
  if (separator === -1) {
    return { headers: parseHeaders(normalized), body: '' };
  }
  return {
    headers: parseHeaders(normalized.slice(0, separator)),
    body: normalized.slice(separator + 2),
  };
}

/** Decode RFC 2047 encoded words: `=?UTF-8?Q?Autumn_sale?=`. */
export function decodeEncodedWords(input: string): string {
  return input.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (whole, charset: string, encoding: string, text: string) => {
      try {
        const bytes =
          encoding.toLowerCase() === 'b'
            ? Buffer.from(text, 'base64')
            : Buffer.from(
                // In encoded words, `_` stands for a space.
                text
                  .replace(/_/g, ' ')
                  .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
                    String.fromCharCode(parseInt(hex, 16)),
                  ),
                'binary',
              );
        return decodeBytes(bytes, charset);
      } catch {
        return whole;
      }
    },
  );
}

function decodeBytes(bytes: Buffer, charset: string): string {
  const label = charset.toLowerCase();
  try {
    return new TextDecoder(label === 'unknown-8bit' ? 'utf-8' : label).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

export function decodeQuotedPrintable(input: string): string {
  const withoutSoftBreaks = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < withoutSoftBreaks.length; i += 1) {
    const char = withoutSoftBreaks[i] as string;
    if (char === '=' && i + 2 < withoutSoftBreaks.length) {
      const hex = withoutSoftBreaks.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(char.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes).toString('utf8');
}

export interface ContentType {
  type: string;
  parameters: Map<string, string>;
}

export function parseContentType(value: string | undefined): ContentType {
  if (value === undefined) return { type: 'text/plain', parameters: new Map() };
  const [rawType = '', ...rest] = value.split(';');
  const parameters = new Map<string, string>();
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const raw = part.slice(eq + 1).trim();
    parameters.set(key, raw.replace(/^"(.*)"$/, '$1'));
  }
  return { type: rawType.trim().toLowerCase(), parameters };
}

export interface MessagePart {
  contentType: string;
  charset: string;
  text: string;
}

/**
 * Flatten a message body into its decoded text parts.
 *
 * Nested multiparts are walked recursively; anything that is not text is
 * skipped. Attachments are never decoded — the detector has no use for them and
 * decoding a 4 MB PDF to look for the word "unsubscribe" would be absurd.
 */
export function decodeParts(headers: Headers, body: string, depth = 0): MessagePart[] {
  if (depth > 8) return []; // Malformed or hostile nesting.

  const contentType = parseContentType(header(headers, 'content-type'));
  const encoding = (header(headers, 'content-transfer-encoding') ?? '7bit')
    .trim()
    .toLowerCase();

  if (contentType.type.startsWith('multipart/')) {
    const boundary = contentType.parameters.get('boundary');
    if (boundary === undefined) return [];
    return splitMultipart(body, boundary).flatMap((section) => {
      const part = splitMessage(section);
      return decodeParts(part.headers, part.body, depth + 1);
    });
  }

  if (!contentType.type.startsWith('text/')) return [];

  const charset = contentType.parameters.get('charset') ?? 'utf-8';
  let text: string;
  switch (encoding) {
    case 'base64':
      text = decodeBytes(Buffer.from(body.replace(/\s+/g, ''), 'base64'), charset);
      break;
    case 'quoted-printable':
      text = decodeQuotedPrintable(body);
      break;
    default:
      text = charset.toLowerCase().startsWith('utf')
        ? body
        : decodeBytes(Buffer.from(body, 'binary'), charset);
  }

  return [{ contentType: contentType.type, charset, text }];
}

function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const sections: string[] = [];
  const lines = body.split('\n');

  let collecting = false;
  let buffer: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === delimiter || trimmed === `${delimiter}--`) {
      if (collecting) sections.push(buffer.join('\n'));
      buffer = [];
      collecting = trimmed === delimiter;
      continue;
    }
    if (collecting) buffer.push(line);
  }
  if (collecting && buffer.length > 0) sections.push(buffer.join('\n'));

  return sections;
}

/** Parse a whole message: headers plus decoded text parts. */
export interface ParsedMessage {
  headers: Headers;
  parts: MessagePart[];
}

export function parseMessage(raw: string): ParsedMessage {
  const { headers, body } = splitMessage(raw);
  return { headers, parts: decodeParts(headers, body) };
}

/** The `text/html` part, if there is one. */
export function htmlPart(parts: readonly MessagePart[]): string | undefined {
  return parts.find((p) => p.contentType === 'text/html')?.text;
}

/** The `text/plain` part, if there is one. */
export function textPart(parts: readonly MessagePart[]): string | undefined {
  return parts.find((p) => p.contentType === 'text/plain')?.text;
}

/** `"Patagonia" <news@patagonia.example>` → name and address. */
export function parseAddress(value: string | undefined): {
  name?: string | undefined;
  address: string;
} {
  if (value === undefined) return { address: '' };
  const decoded = decodeEncodedWords(value).trim();
  const angled = /^(.*)<([^>]+)>\s*$/.exec(decoded);
  if (angled !== null) {
    const name = (angled[1] ?? '')
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .trim();
    return {
      name: name.length > 0 ? name : undefined,
      address: (angled[2] ?? '').trim(),
    };
  }
  return { address: decoded };
}

/** Every `d=` domain across all `DKIM-Signature` headers. */
export function dkimDomains(headers: Headers): string[] {
  const domains: string[] = [];
  for (const signature of headerAll(headers, 'dkim-signature')) {
    const match = /(?:^|[;\s])d=([^;\s]+)/i.exec(signature);
    const value = match?.[1]?.trim().toLowerCase();
    if (value !== undefined && value.length > 0 && !domains.includes(value)) {
      domains.push(value);
    }
  }
  return domains;
}
