import { describe, it, expect, afterEach, vi } from 'vitest';
import { emitError, emitJson, isJsonMode, setJsonMode, widest } from '../src/helpers/output.js';

afterEach(() => {
  setJsonMode(false);
  vi.restoreAllMocks();
});

describe('widest', () => {
  it('measures the longest entry, honouring a minimum', () => {
    expect(widest(['a', 'abc', 'ab'])).toBe(3);
    expect(widest([], 5)).toBe(5);
    expect(widest(['ab'], 5)).toBe(5);
  });
});

describe('json mode', () => {
  it('is off until switched on', () => {
    expect(isJsonMode()).toBe(false);
    setJsonMode(true);
    expect(isJsonMode()).toBe(true);
  });

  it('writes parseable JSON to stdout', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    emitJson({ community: 'c', data: [1, 2] });
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({ community: 'c', data: [1, 2] });
  });

  it('reports errors as prose on stderr normally', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    emitError(new Error('boom'));
    expect(err).toHaveBeenCalledWith('boom');
    expect(log).not.toHaveBeenCalled();
  });

  it('reports errors as JSON on stdout in json mode', () => {
    setJsonMode(true);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    emitError(new Error('boom'));
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({ error: 'boom' });
    expect(err).not.toHaveBeenCalled();
  });

  it('handles a non-Error throw', () => {
    setJsonMode(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    emitError('plain string');
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({ error: 'plain string' });
  });
});
