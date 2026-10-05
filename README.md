# VLQ Signed Encoder

Encode and decode signed integers using the Base64 VLQ scheme defined by the Source Map v3 specification. Used for the segment fields in `.map` files, where many small signed deltas are packed into one string with no separators.

```js
import { encode, decode, decodeOne } from 'vlq-signed-encoder';

encode(0);        // 'A'
encode(-1);       // 'B'
encode(16);       // 'gB'   (first value that needs two groups)

decode('gB');     // [16]
decode('CBA');    // [1, -1, 0]

// decodeOne returns [value, nextIndex] for reading many values out of a
// larger string without allocating an array:
const [v, next] = decodeOne('CBA', 0);  // v === 1, next === 1
```

## Why this exists

Source map segment fields are runs of signed deltas encoded as Base64 VLQ. If you are building tooling that reads or writes source maps, you need exactly this encoding and nothing more. This library does only that, with no dependencies and no opinion on the surrounding source-map format.

The trade-off: values are 32-bit signed integers only. Source-map deltas are 32-bit in practice, so this matches the real format. If you need arbitrary-precision integers, this is the wrong library.

## Edge cases worth knowing

- The zig-zag mapping means the numeric order of single-group values is `0, -1, 1, -2, 2, ...`, not ascending. This is required for interoperability with existing source maps and with the `vlq` npm package.
- An empty string decodes to `[]`.
- `encode` throws `RangeError` on non-integers and on integers outside the int32 range. There is no BigInt path.
- `decode` throws on characters outside the Base64 VLQ alphabet and on sequences whose final group has the continuation bit set (a truncated input).

## Exports

`encode(n)`, `decode(str)`, `decodeOne(str, start)`, `ALPHABET`, `CONTINUATION_MASK` (0x20), `GROUP_BITS` (5).
