'use strict';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls fn(attemptNumber) until it resolves, at most `attempts` times, with exponential backoff between tries.
 * Rejects with the last error when every attempt failed.
 */
async function retry(fn, { attempts = 3, baseDelayMs = 100, sleep = defaultSleep } = {}) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastError = e;
      if (i < attempts) { await sleep(baseDelayMs * 2 ** (i - 1)); }
    }
  }
  throw lastError;
}

module.exports = { retry };
