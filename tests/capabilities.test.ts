import { describe, it, expect } from 'vitest';
import { extractCapabilities } from '../src/capabilities.js';

describe('extractCapabilities', () => {
  it('should return empty capabilities when nothing is configured', () => {
    const caps = extractCapabilities({}, {});
    expect(caps.methods).toEqual([]);
    expect(caps.stripe).toBeNull();
    expect(caps.venmo).toBeNull();
    expect(caps.cash).toBe(false);
  });

  it('should detect Stripe from practitioner settings', () => {
    const settings = { stripe_publishable_key: 'pk_test_123' };
    const caps = extractCapabilities(settings, {});
    expect(caps.stripe).not.toBeNull();
    expect(caps.stripe!.available).toBe(true);
    expect(caps.stripe!.publishableKey).toBe('pk_test_123');
    expect(caps.methods).toContainEqual(expect.objectContaining({ id: 'card', available: true }));
  });

  it('should detect Stripe from env var fallback', () => {
    const env = { PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_env' };
    const caps = extractCapabilities({}, env);
    expect(caps.stripe!.publishableKey).toBe('pk_test_env');
  });

  it('should prefer practitioner settings over env vars for Stripe', () => {
    const settings = { stripe_publishable_key: 'pk_practitioner' };
    const env = { PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_platform' };
    const caps = extractCapabilities(settings, env);
    expect(caps.stripe!.publishableKey).toBe('pk_practitioner');
  });

  it('should detect Venmo when client ID and payee email both exist', () => {
    const settings = { paypal_payee_email: 'jen@example.com' };
    const env = { PUBLIC_PAYPAL_CLIENT_ID: 'paypal_123', PAYPAL_ENVIRONMENT: 'sandbox' };
    const caps = extractCapabilities(settings, env);
    expect(caps.venmo).not.toBeNull();
    expect(caps.venmo!.available).toBe(true);
    expect(caps.venmo!.clientId).toBe('paypal_123');
    expect(caps.venmo!.environment).toBe('sandbox');
    expect(caps.methods).toContainEqual(expect.objectContaining({ id: 'venmo', available: true }));
  });

  it('should NOT enable Venmo when payee email is missing', () => {
    const env = { PUBLIC_PAYPAL_CLIENT_ID: 'paypal_123' };
    const caps = extractCapabilities({}, env);
    expect(caps.venmo).toBeNull();
    expect(caps.methods).not.toContainEqual(expect.objectContaining({ id: 'venmo' }));
  });

  it('should return both Stripe and Venmo when both configured', () => {
    const settings = {
      stripe_publishable_key: 'pk_test_123',
      paypal_payee_email: 'jen@example.com',
    };
    const env = { PUBLIC_PAYPAL_CLIENT_ID: 'paypal_123', PAYPAL_ENVIRONMENT: 'production' };
    const caps = extractCapabilities(settings, env);
    expect(caps.stripe!.available).toBe(true);
    expect(caps.venmo!.available).toBe(true);
    expect(caps.venmo!.environment).toBe('production');
    expect(caps.methods).toHaveLength(2);
  });

  it('should never enable cash', () => {
    const settings = { allow_cash: 'true', cash_enabled: 'true' };
    const caps = extractCapabilities(settings, {});
    expect(caps.cash).toBe(false);
    expect(caps.methods).not.toContainEqual(expect.objectContaining({ id: 'cash' }));
  });

  it('should include connected account ID when available', () => {
    const settings = {
      stripe_publishable_key: 'pk_test_123',
      stripe_connect_account_id: 'acct_123',
    };
    const caps = extractCapabilities(settings, {});
    expect(caps.stripe!.connectedAccountId).toBe('acct_123');
  });
});
