import { describe, expect, it } from 'vitest';
import { describeError } from '../src/errors.js';

describe('describeError', () => {
  it('adds the cause, which says why a fetch failed', () => {
    expect(describeError(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND mcp.example.test') }))).toBe('fetch failed (getaddrinfo ENOTFOUND mcp.example.test)');
    expect(describeError(new Error('plain'))).toBe('plain');
    expect(describeError('odd')).toBe('odd');
  });

  it('names the first failure inside an AggregateError with no message of its own', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED ::1:443'), { code: 'ECONNREFUSED' });
    expect(describeError(new TypeError('fetch failed', { cause: new AggregateError([refused], '') }))).toBe('fetch failed (connect ECONNREFUSED ::1:443)');
  });

  it('falls back to the inner error code when that has no message either', () => {
    const refused = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
    expect(describeError(new TypeError('fetch failed', { cause: new AggregateError([refused], '') }))).toBe('fetch failed (ECONNREFUSED)');
  });
});
