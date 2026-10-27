import { Transform } from "node:stream";
import { StorageError } from "@contextvault/domain";

// The SDK does not enforce ContentLength on a stream: a short or long body is sent as is (spike
// S5). This guard fails the stream on the first byte over, or at the end if bytes are missing.
export function lengthGuard(expected: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Uint8Array, _encoding, done) {
      seen += chunk.length;
      done(seen > expected ? new StorageError("storage.length_mismatch", false) : null, chunk);
    },
    flush(done) {
      done(seen === expected ? null : new StorageError("storage.length_mismatch", false));
    },
  });
}
