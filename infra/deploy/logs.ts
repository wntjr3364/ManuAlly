// PW-061 bounded logs: each process's output goes to <data_root>/logs/<name>.log; past maxBytes the file is
// renamed to <name>.log.1 (older ones shift up) and at most `keep` old files remain. The logs can therefore
// never use more than (keep + 1) × maxBytes per process.
import fs from 'node:fs';
import path from 'node:path';

export class RotatingLog {
  private fd: number;
  private size: number;
  constructor(private readonly dir: string, private readonly name: string, private readonly maxBytes: number, private readonly keep: number) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.fd = fs.openSync(this.file(0), 'a', 0o600);
    this.size = fs.fstatSync(this.fd).size;
  }
  private file(n: number) { return path.join(this.dir, n === 0 ? `${this.name}.log` : `${this.name}.log.${n}`); }
  write(chunk: Buffer | string) {
    let b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (b.length) {
      if (this.size >= this.maxBytes) this.rotate();
      const room = this.maxBytes - this.size;
      const part = b.subarray(0, room);
      fs.writeSync(this.fd, part);
      this.size += part.length;
      b = b.subarray(part.length);
    }
  }
  private rotate() {
    fs.closeSync(this.fd);
    fs.rmSync(this.file(this.keep), { force: true });
    for (let n = this.keep - 1; n >= 0; n--) if (fs.existsSync(this.file(n))) fs.renameSync(this.file(n), this.file(n + 1));
    this.fd = fs.openSync(this.file(0), 'a', 0o600);
    this.size = 0;
  }
  close() { fs.closeSync(this.fd); }
}
