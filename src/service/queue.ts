/**
 * One queue for the account owned by this process. Kicktipp's page object is
 * mutable, so an entire read or submission must finish before another caller
 * (including the scheduler) starts navigating it.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}

export const kicktippQueue = new SerialQueue();
