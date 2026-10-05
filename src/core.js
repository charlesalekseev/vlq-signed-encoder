/**
 * VLQ (variable-length quantity) encoding for signed integers, as used in
 * Source Map version 3 segment encoding.
 *
 * Encoding choice: a signed integer is mapped to an unsigned integer by
 * interleaving the sign bit into the least-significant bit ("zig-zag"),
 * then the unsigned value is written base-32 with 5 bits per group, least
 * significant group first, and a continuation bit on every group except the
 * last. This is the exact scheme used by the `vlq` npm package and by the
 * Mozilla source-map library, so output is interchangeable.
 *
 * Why zig-zag rather than two's-complement sign-magnitude: small negative
 * numbers (which are common in source-map deltas) stay small after zig-zag,
 * so they fit in a single 5-bit group. Two's-complement would force -1 into
 * a 64-bit pattern and waste many groups.
 *
 * Base 64 alphabet used here is the standard Source Map VLQ alphabet:
 *   ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/
 * which means each 5-bit group maps to one ASCII character. A group is the
 * low 5 bits; the 6th bit (0x20) is the continuation flag, so each output
 * byte is `flag | group`.
 */

// Base64 VLQ alphabet, fixed by the Source Map specification. Ordering
// matters and must not be changed; existing source maps depend on it.
const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const CONTINUATION_BIT = 0x20; // 6th bit (1 << 5)
const GROUP_MASK = 0x1f;      // low 5 bits
const GROUP_BIT_COUNT = 5;

// Precomputed for decode speed: maps each ASCII code to its 6-bit value, or
// -1 if not in the alphabet. Building this once avoids a string indexOf
// (O(n) scan) per character during decode.
const CHAR_TO_VALUE = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < BASE64_CHARS.length; i += 1) {
    table[BASE64_CHARS.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * Convert a signed integer into the unsigned "zig-zag" form used by VLQ.
 * n = 0 -> 0, n = -1 -> 1, n = 1 -> 2, n = -2 -> 3, ...
 * The sign occupies the least-significant bit; the magnitude is shifted up.
 * `n >> 31` sign-extends to all-1s for negatives, 0 for non-negatives, so
 * XOR with it flips all bits for negatives before the shift.
 *
 * Arithmetic right shift (`>>`) is used instead of unsigned (`>>>`) because
 * we want the sign-extended mask; the final `>>> 0` is only needed to coerce
 * to an unsigned 32-bit representation.
 */
function toVLQSigned(n) {
  return (n << 1) ^ (n >> 31) >>> 0;
}

/**
 * Inverse of toVLQSigned. The low bit is the sign; the rest is the magnitude.
 * `-(n & 1)` yields 0 for non-negatives and -1 (all-1s) for negatives; XOR
 * with that restores the two's-complement form, then arithmetic shift right
 * rebuilds the original signed value.
 */
function fromVLQSigned(n) {
  return (n >>> 1) ^ -(n & 1);
}

/**
 * Encode a single signed integer into its Base64 VLQ string.
 *
 * Zero is a valid input and yields "A" (one group, value 0, no continuation).
 *
 * @param {number} n - a 32-bit signed integer. Non-integers and values
 *   outside the int32 range are rejected explicitly; VLQ in source maps only
 *   ever carries int32 deltas, and staying strict prevents silent
 *   truncation of bad data.
 * @returns {string}
 */
export function encode(n) {
  if (!Number.isInteger(n) || n < -0x80000000 || n > 0x7fffffff) {
    throw new RangeError(
      `encode() expects a 32-bit signed integer, got ${String(n)}`,
    );
  }

  let value = toVLQSigned(n);
  let out = '';
  do {
    // Peel off the low 5 bits. If anything remains, set the continuation bit.
    let group = value & GROUP_MASK;
    value >>>= GROUP_BIT_COUNT;
    if (value > 0) {
      group |= CONTINUATION_BIT;
    }
    out += BASE64_CHARS[group];
  } while (value > 0);
  return out;
}

/**
 * Decode the next Base64 VLQ value starting at index `start` in `str`.
 *
 * Multi-value strings (the common case in source maps: many deltas
 * concatenated) are supported by reading forward until a group without the
 * continuation bit, and returning the index where the next value begins.
 *
 * @param {string} str
 * @param {number} start - index into `str` to begin reading at
 * @returns {[number, number]} `[value, nextIndex]` where nextIndex points
 *   just past the last character consumed
 * @throws {Error} if `str` contains a character outside the VLQ alphabet,
 *   or if decoding runs off the end of the string (an unterminated
 *   continuation)
 */
export function decodeOne(str, start) {
  if (typeof str !== 'string') {
    throw new TypeError('decodeOne() expects a string');
  }
  if (!Number.isInteger(start) || start < 0 || start >= str.length) {
    throw new RangeError(
      `decodeOne() start index out of range: got ${String(start)} for length ${str.length}`,
    );
  }

  let result = 0;
  let shift = 0;
  let index = start;

  // The cap is the bit width of a 32-bit value (32) plus one extra group to
  // accommodate the zig-zag sign bit, so 7 groups * 5 bits = 35. Anything
  // longer cannot be a valid 32-bit VLQ value and almost certainly indicates
  // corrupted input; the decode loop would otherwise shift meaningless bits
  // into `result` silently.
  const maxGroups = 7;
  let groupsRead = 0;

  while (true) {
    if (index >= str.length) {
      // The last group we read had the continuation bit set, but there was
      // no next group. The input is malformed.
      throw new Error('Unterminated VLQ sequence: continuation bit set on last group');
    }
    const code = str.charCodeAt(index);
    const value = code < 128 ? CHAR_TO_VALUE[code] : -1;
    if (value === -1) {
      throw new Error(`Invalid Base64 VLQ character at index ${index}: '${str[index]}'`);
    }
    index += 1;
    groupsRead += 1;

    const group = value & GROUP_MASK;
    const continuation = (value & CONTINUATION_BIT) !== 0;
    result += group << shift;

    if (!continuation) {
      break;
    }
    if (groupsRead >= maxGroups) {
      // One more group would push us past 35 bits; 32-bit `result` can no
      // longer represent the accumulation faithfully.
      throw new Error('VLQ sequence too long for a 32-bit signed integer');
    }
    shift += GROUP_BIT_COUNT;
  }

  return [fromVLQSigned(result >>> 0), index];
}

/**
 * Decode an entire Base64 VLQ string into a list of signed integers.
 *
 * The string may encode one value or many concatenated values. Trailing
 * garbage that looks like VLQ is still decoded; an empty string returns [].
 *
 * @param {string} str
 * @returns {number[]}
 */
export function decode(str) {
  if (typeof str !== 'string') {
    throw new TypeError('decode() expects a string');
  }
  if (str.length === 0) {
    return [];
  }
  const out = [];
  let index = 0;
  while (index < str.length) {
    const [value, nextIndex] = decodeOne(str, index);
    out.push(value);
    index = nextIndex;
  }
  return out;
}

// Re-export the alphabet and constants for consumers that need to reason
// about them (rare, but useful for tests and for building related tooling
// without duplicating the table).
export const ALPHABET = BASE64_CHARS;
export const CONTINUATION_MASK = CONTINUATION_BIT;
export const GROUP_BITS = GROUP_BIT_COUNT;
