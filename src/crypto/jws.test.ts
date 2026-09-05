import { describe, expect, it } from 'vitest';
import { generateKeyPair } from './keys.js';
import { JwsError, b64uEncode, decodeUnverified, hashCompact, sign, verify } from './jws.js';

const keys = await generateKeyPair();
const other = await generateKeyPair();

describe('sign and verify', () => {
  it('round-trips a mandate-shaped claim set', async () => {
    const compact = await sign(
      { vct: 'mandate.checkout.open.1', iat: 1757000000, exp: 1757003600 },
      keys,
    );
    const { header, payload } = await verify(compact, keys.publicKey);
    expect(header.alg).toBe('EdDSA');
    expect(header.kid).toBe(keys.kid);
    expect(payload).toMatchObject({ vct: 'mandate.checkout.open.1' });
  });

  it('rejects a signature made by a different key', async () => {
    const compact = await sign({ vct: 'mandate.payment.1' }, keys);
    await expect(verify(compact, other.publicKey)).rejects.toThrow(JwsError);
  });

  it('rejects a tampered payload', async () => {
    const compact = await sign({ vct: 'mandate.payment.1', payment_amount: 780000 }, keys);
    const [h, , s] = compact.split('.') as [string, string, string];
    const forged = `${h}.${b64uEncode(JSON.stringify({ vct: 'mandate.payment.1', payment_amount: 1 }))}.${s}`;
    await expect(verify(forged, keys.publicKey)).rejects.toThrow(JwsError);
  });

  it('refuses alg values other than EdDSA, closing the alg:none family', async () => {
    const compact = await sign({ vct: 'mandate.payment.1' }, keys);
    const [, p, s] = compact.split('.') as [string, string, string];
    const none = `${b64uEncode(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${p}.${s}`;
    await expect(verify(none, keys.publicKey)).rejects.toThrow(/unsupported JWS alg: none/);
  });

  it('rejects malformed compact serialisations', async () => {
    await expect(verify('not.a.jws.at.all', keys.publicKey)).rejects.toThrow(JwsError);
    await expect(verify('only-one-segment', keys.publicKey)).rejects.toThrow(JwsError);
  });

  it('does not enforce exp, because expiry is a Gate constraint and not a forgery', async () => {
    const longExpired = await sign({ vct: 'mandate.checkout.1', exp: 1 }, keys);
    await expect(verify(longExpired, keys.publicKey)).resolves.toBeDefined();
  });
});

describe('hashCompact', () => {
  it('is stable for identical bytes and differs for any change', () => {
    expect(hashCompact('abc')).toBe(hashCompact('abc'));
    expect(hashCompact('abc')).not.toBe(hashCompact('abd'));
  });

  it('is base64url, so it is safe as a JWT claim value', () => {
    expect(hashCompact('abc')).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('decodeUnverified', () => {
  it('reads claims without a key, for inspection only', async () => {
    const compact = await sign({ vct: 'mandate.checkout.1', transaction_id: 'txn_1' }, keys);
    expect(decodeUnverified(compact)).toMatchObject({ transaction_id: 'txn_1' });
  });
});
