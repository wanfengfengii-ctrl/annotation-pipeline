import { readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
const identity = (s) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
// Per-attempt cache only. The entire tree is still enumerated on every check.
// ctime catches same-size writes even when mtime is restored by an editor.
export class SourceHashCache {
  constructor() {
    this.files = new Map();
  }
  read(file, before) {
    const stamp = identity(before),
      saved = this.files.get(file);
    if (saved?.stamp === stamp) return saved.sha256;
    const sha256 = createHash('sha256')
      .update(readFileSync(file))
      .digest('hex');
    if (identity(lstatSync(file)) !== stamp)
      throw Error('源码读取期间发生变化');
    this.files.set(file, { stamp, sha256 });
    return sha256;
  }
}
