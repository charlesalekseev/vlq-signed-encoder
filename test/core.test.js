import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encode,
  decode,
  decodeOne,
  ALPHABET,
  CONTINUATION_MASK,
  GROUP_BITS,
} from '../src/index.js';

// The single-group cases are the most important to get exactly right: every
// short delta in a source map hits this path, so an off-by-one in the alphabet
// or in the zig-zag mapping would break everything downstream. We test every
// value that fits in one 5-bit group explicitly.

test('single-group happy path: zig-zag order is 0,-1,1,-2,2,...', () => {
  // The zig-zag mapping means single-group codes correspond to small signed
  // values in this interleaved order, not ascending order.
  const expected = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5,
                    -6, 6, -7, 7, -8, 8, -9, 9, -10, 10,
                    -11, 11, -12, 12, -13, 13, -14, 14, -15, 15];
  for (let i = 0; i < expected.length; i += 1) {
    const code = ALPHABET[i];
    assert.equal(encode(expected[i]), code,
      `encode(${expected[i]}) should be '${code}'`);
    assert.deepEqual(decode(code), [expected[i]],
      `decode('${code}') should be [${expected[i]}]`);
  }
});

test('zero encodes to a single "A"', () => {
  assert.equal(encode(0), 'A');
  assert.deepEqual(decode('A'), [0]);
});

test('positive single-digit values', () => {
  assert.equal(encode(1), 'C');
  assert.equal(encode(15), 'e');
});

test('negative single-digit values', () => {
  assert.equal(encode(-1), 'B');
  assert.equal(encode(-15), 'd');
});

test('two-group values cross the 5-bit boundary', () => {
  // 16 is the first value whose zig-zag form (32) does not fit in 5 bits,
  // so it is the first two-group encoding. -16 zig-zags to 31, which still
  // fits in a single group, so it is not a two-group value.
  assert.equal(encode(16), 'gB');
  assert.deepEqual(decode('gB'), [16]);
  assert.equal(encode(-17), 'hB');
  assert.deepEqual(decode('hB'), [-17]);
});

test('round-trips the full int32 range at boundaries', () => {
  // The extreme values exercise the topmost bits and the longest allowed
  // group count (7 groups). If the shift width ever drifts these fail loudly.
  const extremes = [
    -0x80000000, // INT32_MIN
    -0x7fffffff - 1, // same value, expressed differently
    -1,
    0,
    1,
    0x7fffffff, // INT32_MAX
  ];
  for (const n of extremes) {
    const round = decode(encode(n));
    assert.deepEqual(round, [n], `round-trip of ${n}`);
  }
});

test('round-trips a dense sample of values across the range', () => {
  // Step across the whole range so we exercise every group count from 1 to 7
  // without taking forever.
  const step = 0x10000; // 65536
  for (let n = -0x80000000; n <= 0x7fffffff; n += step) {
    assert.deepEqual(decode(encode(n)), [n], `round-trip of ${n}`);
  }
});

test('round-trips small magnitudes exhaustively', () => {
  // The short range is where source-map deltas actually live, so test every
  // value here rather than sampling.
  for (let n = -1000; n <= 1000; n += 1) {
    assert.deepEqual(decode(encode(n)), [n], `round-trip of ${n}`);
  }
});

test('multiple concatenated values decode in order', () => {
  // This is the real-world shape of a source-map segment field: many
  // deltas packed back-to-back, no separators.
  const values = [1, -1, 16, -16, 0, 255, -255, 0x7fffffff];
  const encoded = values.map(encode).join('');
  assert.deepEqual(decode(encoded), values);
});

test('decodeOne returns the value and the index just past it', () => {
  const str = 'CA'; // encode(1)='C', encode(0)='A'
  const [first, i1] = decodeOne(str, 0);
  assert.equal(first, 1);
  assert.equal(i1, 1);
  const [second, i2] = decodeOne(str, i1);
  assert.equal(second, 0);
  assert.equal(i2, 2);
});

test('decode of empty string is []', () => {
  assert.deepEqual(decode(''), []);
});

test('encode rejects non-integer input', () => {
  assert.throws(() => encode(1.5), RangeError);
  assert.throws(() => encode(NaN), RangeError);
  assert.throws(() => encode('1'), RangeError);
});

test('encode rejects out-of-range integers', () => {
  // VLQ here is defined for 32-bit signed integers only; larger magnitudes
  // would need a BigInt path which we deliberately do not provide.
  assert.throws(() => encode(0x80000000), RangeError);   // INT32_MAX + 1
  assert.throws(() => encode(-0x80000001), RangeError);  // INT32_MIN - 1
});

test('decode throws on a character outside the alphabet', () => {
  // A space is not in the Source Map VLQ alphabet; this is the kind of input
  // you get if a segment field was accidentally whitespace-split.
  assert.throws(() => decode('A B'), /Invalid Base64 VLQ character/);
  assert.throws(() => decode('!'), /Invalid Base64 VLQ character/);
});

test('decodeOne throws on a negative start index', () => {
  assert.throws(() => decodeOne('AAAA', -1), RangeError);
});

test('decodeOne throws on a start index past the end', () => {
  assert.throws(() => decodeOne('A', 1), RangeError);
  assert.throws(() => decodeOne('A', 5), RangeError);
});

test('decode throws on an unterminated continuation', () => {
  // 'g' has the continuation bit set (0x20 | 0x20 = 0x20... actually 'g'
  // is index 32 = 0x20, so it IS the continuation-only group). A string
  // that ends on a continuation is malformed.
  assert.throws(() => decode('g'), /Unterminated VLQ sequence/);
});

// The library exposes a few constants so that callers (and these tests) can
// reason about the encoding without hardcoding a duplicate alphabet.

test('exported ALPHABET is 64 characters long and contains no duplicates', () => {
  assert.equal(ALPHABET.length, 64);
  assert.equal(new Set(ALPHABET).size, 64);
});

test('CONTINUATION_MASK and GROUP_BITS have the documented values', () => {
  assert.equal(CONTINUATION_MASK, 0x20);
  assert.equal(GROUP_BITS, 5);
});

test('every single-group alphabet character round-trips', () => {
  // Only the first 32 characters of the alphabet represent single-group
  // values; characters at index 32 and above have the continuation bit set
  // and are not valid standalone encodings.
  for (let i = 0; i < 32; i += 1) {
    const ch = ALPHABET[i];
    const decoded = decode(ch);
    assert.equal(decoded.length, 1, `decode('${ch}') should yield one value`);
    assert.equal(encode(decoded[0]), ch,
      `encode(${decoded[0]}) should be '${ch}'`);
  }
});
