export {
  CONFIDENCE,
  detect,
  detectBodyLink,
  extractAnchors,
  hasOneClickPost,
  headersInconclusive,
  isSuspicious,
  parseListUnsubscribe,
  type Anchor,
  type DetectableMessage,
  type Detection,
  type UnsubscribeMethod,
} from './detect.js';

export {
  dkimDomains,
  decodeEncodedWords,
  decodeParts,
  decodeQuotedPrintable,
  header,
  headerAll,
  htmlPart,
  parseAddress,
  parseContentType,
  parseHeaders,
  parseMessage,
  splitMessage,
  textPart,
  type Headers,
  type MessagePart,
  type ParsedMessage,
} from './mime.js';

export {
  matchPreferenceToken,
  matchUnsubscribeToken,
  matchUrlToken,
  normalizeForMatch,
  PREFERENCE_TOKENS,
  UNSUBSCRIBE_TOKENS,
  URL_TOKENS,
} from './tokens.js';
