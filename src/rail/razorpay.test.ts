import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  RailError,
  createOrder,
  derivedRefundCap,
  refund,
  verifyWebhookSignature,
  type RailClient,
} from './razorpay.js';
import { mintAllowToken, type AllowToken } from '../gate/verdict.js';
import { paise } from '../money.js';
import { MERCHANT, NOW } from '../testing/fixtures.js';

function token(amount = 780000): AllowToken {
  return mintAllowToken(
    {
      action: 'allow',
      transactionId: 'txn_1',
      constraints: [],
      classification: 'conforming',
      reasons: [],
      evaluatedAt: NOW * 1000,
      usedNonDeterministicEvaluation: false,
    },
    paise(amount),
    MERCHANT,
    'verdict_hash',
  );
}

function stubClient(): RailClient & {
  orders: { create: ReturnType<typeof vi.fn> };
  payments: { fetch: ReturnType<typeof vi.fn>; refund: ReturnType<typeof vi.fn> };
} {
  return {
    orders: {
      create: vi.fn(async (o: { amount: number }) => ({
        id: 'order_1',
        amount: o.amount,
        currency: 'INR',
        status: 'created',
      })),
    },
    payments: {
      fetch: vi.fn(async () => ({
        id: 'pay_1',
        order_id: 'order_1',
        amount: 780000,
        status: 'captured',
      })),
      refund: vi.fn(async (id: string, o: { amount: number }) => ({
        id: 'rfnd_1',
        payment_id: id,
        amount: o.amount,
        status: 'processed',
      })),
    },
  } as never;
}

describe('createOrder', () => {
  it('charges exactly the amount on the token', async () => {
    const client = stubClient();
    await createOrder(client, token(780000), 'rcpt_1');
    expect(client.orders.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 780000, currency: 'INR' }),
    );
  });

  it('records the transaction and verdict on the order for later replay', async () => {
    const client = stubClient();
    await createOrder(client, token(), 'rcpt_1');
    const notes = client.orders.create.mock.calls[0]?.[0]?.notes;
    expect(notes).toMatchObject({
      recourse_transaction_id: 'txn_1',
      recourse_verdict: 'verdict_hash',
    });
  });

  // The runtime half of the guarantee. The compile-time half is asserted in gate.test.ts.
  it('refuses a forged token before building a request', async () => {
    const client = stubClient();
    const forged = { transactionId: 'txn_1', amount: 780000 } as unknown as AllowToken;
    await expect(createOrder(client, forged, 'rcpt_1')).rejects.toThrow(
      /not a Gate-issued allow token/,
    );
    expect(client.orders.create).not.toHaveBeenCalled();
  });
});

describe('derivedRefundCap', () => {
  const basis = {
    paymentId: 'pay_1',
    capturedAmount: paise(780000),
    alreadyRefunded: paise(0),
    budgetMax: paise(800000),
    adjudicatorAward: paise(780000),
  };

  it('returns the award when the award is the smallest bound', () => {
    expect(derivedRefundCap({ ...basis, adjudicatorAward: paise(500000) })).toBe(500000);
  });

  it('never exceeds what was actually captured', () => {
    expect(derivedRefundCap({ ...basis, adjudicatorAward: paise(10_000_000) })).toBe(780000);
  });

  it('never exceeds what the mandate authorised', () => {
    expect(
      derivedRefundCap({
        ...basis,
        capturedAmount: paise(9_000_000),
        budgetMax: paise(800000),
        adjudicatorAward: paise(9_000_000),
      }),
    ).toBe(800000);
  });

  it('subtracts what has already been returned, so a payment cannot be refunded twice', () => {
    expect(derivedRefundCap({ ...basis, alreadyRefunded: paise(600000) })).toBe(180000);
  });

  it('is zero once the capture has been fully returned', () => {
    expect(derivedRefundCap({ ...basis, alreadyRefunded: paise(780000) })).toBe(0);
  });
});

describe('refund', () => {
  const basis = {
    paymentId: 'pay_1',
    capturedAmount: paise(780000),
    alreadyRefunded: paise(0),
    budgetMax: paise(800000),
    adjudicatorAward: paise(780000),
  };

  it('sends the derived cap, not anything a caller asked for', async () => {
    const client = stubClient();
    await refund(client, token(), { ...basis, adjudicatorAward: paise(300000) });
    expect(client.payments.refund).toHaveBeenCalledWith('pay_1', expect.objectContaining({ amount: 300000 }));
  });

  it('clamps an over-large award down to the capture', async () => {
    const client = stubClient();
    await refund(client, token(), { ...basis, adjudicatorAward: paise(5_000_000) });
    expect(client.payments.refund).toHaveBeenCalledWith('pay_1', expect.objectContaining({ amount: 780000 }));
  });

  it('sends nothing at all when the cap works out to zero', async () => {
    const client = stubClient();
    await expect(
      refund(client, token(), { ...basis, alreadyRefunded: paise(780000) }),
    ).rejects.toThrow(RailError);
    expect(client.payments.refund).not.toHaveBeenCalled();
  });

  it('refuses a forged token', async () => {
    const client = stubClient();
    await expect(refund(client, {} as unknown as AllowToken, basis)).rejects.toThrow(
      /not a Gate-issued allow token/,
    );
    expect(client.payments.refund).not.toHaveBeenCalled();
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'whsec_test';
  const body = '{"event":"payment.captured","payload":{}}';
  const good = createHmac('sha256', secret).update(body, 'utf8').digest('hex');

  it('accepts a correct signature', () => {
    expect(verifyWebhookSignature(body, good, secret)).toBe(true);
  });

  it('rejects a signature over different bytes', () => {
    expect(verifyWebhookSignature(body + ' ', good, secret)).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    expect(verifyWebhookSignature(body, 'abcd', secret)).toBe(false);
  });

  it('rejects a non-hex signature', () => {
    expect(verifyWebhookSignature(body, 'zzzz', secret)).toBe(false);
  });

  it('refuses to run at all without a secret, rather than quietly returning false', () => {
    expect(() => verifyWebhookSignature(body, good, '')).toThrow(RailError);
  });
});
