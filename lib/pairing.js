import { randomInt } from 'node:crypto';

export function createPairingCode(previous) {
  let code;
  do {
    code = String(randomInt(1000, 10000));
  } while (code === previous);
  return code;
}
