import fs from 'node:fs';
const [moduleUrl, file, mode] = process.argv.slice(2);
const { FileLock } = await import(moduleUrl);
if (mode === 'crash-writing') {
  const write = fs.writeFileSync;
  fs.writeFileSync = function (target, data, ...args) {
    if (typeof target === 'number' && typeof data === 'string' && data.includes('schemaVersion')) {
      write(target, data.slice(0, 8), ...args);
      process.kill(process.pid, 'SIGKILL');
    }
    return write(target, data, ...args);
  };
}
try {
  const lock = FileLock.acquire(file);
  process.send({ status: 'held', pid: process.pid });
  process.on('message', () => {
    lock.release();
    process.exit(0);
  });
} catch (error) {
  process.send({ status: error.name });
  process.exit(0);
}
