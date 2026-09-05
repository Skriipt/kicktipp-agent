const [moduleUrl, file] = process.argv.slice(2);
const { FileLock } = await import(moduleUrl);

try {
  const lock = FileLock.acquire(file);
  process.send({ status: 'held' });
  process.on('message', () => {
    lock.release();
    process.exit(0);
  });
} catch (error) {
  process.send({ status: error.name });
  process.exit(1);
}
