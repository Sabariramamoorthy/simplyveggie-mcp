import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';

export class ServiceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}
export const token = () => randomBytes(32).toString('base64url');
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function sameSecret(a, b) {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)))
  );
}
// One account, one cart: calls run one at a time so cart changes never interleave.
export class SerialQueue {
  tail = Promise.resolve();
  count = 0;
  run(fn) {
    if (this.count >= 12) throw new ServiceError('BUSY', 'Request queue is full; retry later.');
    this.count++;
    const result = this.tail.then(fn);
    this.tail = result
      .catch(() => {})
      .finally(() => {
        this.count--;
      });
    return result;
  }
}
export class JsonStore {
  constructor(directory) {
    this.directory = directory;
  }
  async read(name, fallback) {
    try {
      return JSON.parse(await readFile(`${this.directory}/${name}.json`, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return fallback;
      throw e;
    }
  }
  async write(name, value) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = `${this.directory}/${name}.json`;
    await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
}
