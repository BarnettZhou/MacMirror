import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairingCode } from '../lib/pairing.js';

test('pairing code is four digits', () => {
  for (let i = 0; i < 100; i += 1) assert.match(createPairingCode(), /^\d{4}$/);
});

test('pairing code rotation avoids the previous code', () => {
  let code = createPairingCode();
  for (let i = 0; i < 100; i += 1) {
    const next = createPairingCode(code);
    assert.match(next, /^\d{4}$/);
    assert.notEqual(next, code);
    code = next;
  }
});
