/**
 * Payment capability extraction from practitioner settings and platform env vars.
 *
 * This is the canonical extraction logic used by downstream booking surfaces
 * to produce consistent payment method availability.
 */

// TODO: import from @tummycrypt/scheduling-kit/payments once 0.7.0 is published
interface PaymentMethodOption {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly icon?: string;
  readonly description?: string;
  readonly available: boolean;
  readonly processingFee?: number;
  readonly processingFeePercent?: number;
}

interface StripeCapability {
  readonly available: boolean;
  readonly publishableKey: string;
  readonly connectedAccountId?: string;
}

interface VenmoCapability {
  readonly available: boolean;
  readonly clientId: string;
  readonly environment: 'sandbox' | 'production';
}

interface PaymentCapabilities {
  readonly methods: PaymentMethodOption[];
  readonly stripe: StripeCapability | null;
  readonly venmo: VenmoCapability | null;
  readonly cash: false;
}

/**
 * Extract payment capabilities from practitioner settings and platform env vars.
 *
 * Priority hierarchy: practitioner settings (DB) > platform env vars > disabled.
 * Cash at Visit is structurally excluded (cash: false).
 *
 * @param settings - Practitioner-specific settings from database
 * @param env - Platform environment variables
 * @returns PaymentCapabilities contract for booking surfaces
 */
export const extractCapabilities = (
  settings: Record<string, string>,
  env: Record<string, string>,
): PaymentCapabilities => {
  const methods: PaymentMethodOption[] = [];

  // --- Stripe ---
  const stripeKey = settings.stripe_publishable_key || env.PUBLIC_STRIPE_PUBLISHABLE_KEY || '';
  const stripeConnectId = settings.stripe_connect_account_id || env.STRIPE_CONNECT_ACCOUNT_ID || '';
  let stripe: StripeCapability | null = null;

  if (stripeKey) {
    stripe = {
      available: true,
      publishableKey: stripeKey,
      ...(stripeConnectId ? { connectedAccountId: stripeConnectId } : {}),
    };
    methods.push({
      id: 'card',
      name: 'card',
      displayName: 'Credit/Debit Card',
      icon: 'card',
      available: true,
    });
  }

  // --- Venmo/PayPal ---
  const paypalClientId = env.PUBLIC_PAYPAL_CLIENT_ID || '';
  const payeeEmail = settings.paypal_payee_email || env.PAYPAL_PAYEE_EMAIL || '';
  const paypalEnv: 'sandbox' | 'production' = env.PAYPAL_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
  let venmo: VenmoCapability | null = null;

  if (paypalClientId && payeeEmail) {
    venmo = {
      available: true,
      clientId: paypalClientId,
      environment: paypalEnv,
    };
    methods.push({
      id: 'venmo',
      name: 'venmo',
      displayName: 'Venmo',
      icon: 'venmo',
      available: true,
    });
  }

  return { methods, stripe, venmo, cash: false };
};
