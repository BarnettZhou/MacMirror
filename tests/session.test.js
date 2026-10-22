import test from 'node:test'; import assert from 'node:assert/strict';
test('pairing code is four digits', () => assert.match(String(Math.floor(1000 + Math.random() * 9000)), /^\d{4}$/));
