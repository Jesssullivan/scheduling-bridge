/**
 * Core types for scheduling-kit
 * Backend-agnostic scheduling with fp-ts monadic composition
 */

import type { TaskEither } from 'fp-ts/TaskEither';
import type { ReaderTaskEither } from 'fp-ts/ReaderTaskEither';

// =============================================================================
// ERROR TYPES (Discriminated Union)
// =============================================================================

export interface AcuityError {
  readonly _tag: 'AcuityError';
  readonly code: string;
  readonly message: string;
  readonly statusCode?: number;
  readonly endpoint?: string;
}

export interface CalComError {
  readonly _tag: 'CalComError';
  readonly code: string;
  readonly message: string;
  readonly statusCode?: number;
}

export interface PaymentError {
  readonly _tag: 'PaymentError';
  readonly code: string;
  readonly message: string;
  readonly processor: string;
  readonly transactionId?: string;
  readonly recoverable: boolean;
}

export interface ValidationError {
  readonly _tag: 'ValidationError';
  readonly field: string;
  readonly message: string;
  readonly value?: unknown;
}

export interface ReservationError {
  readonly _tag: 'ReservationError';
  readonly code: 'SLOT_TAKEN' | 'BLOCK_FAILED' | 'TIMEOUT';
  readonly message: string;
  readonly datetime?: string;
}

export interface IdempotencyError {
  readonly _tag: 'IdempotencyError';
  readonly key: string;
  readonly existingResult?: unknown;
}

export interface InfrastructureError {
  readonly _tag: 'InfrastructureError';
  readonly code: 'NETWORK' | 'TIMEOUT' | 'REDIS' | 'UNKNOWN';
  readonly message: string;
  readonly cause?: Error;
}

export type SchedulingError =
  | AcuityError
  | CalComError
  | PaymentError
  | ValidationError
  | ReservationError
  | IdempotencyError
  | InfrastructureError;

// =============================================================================
// ERROR CONSTRUCTORS
// =============================================================================

export const Errors = {
  acuity: (code: string, message: string, statusCode?: number, endpoint?: string): AcuityError => ({
    _tag: 'AcuityError',
    code,
    message,
    statusCode,
    endpoint,
  }),

  calcom: (code: string, message: string, statusCode?: number): CalComError => ({
    _tag: 'CalComError',
    code,
    message,
    statusCode,
  }),

  payment: (
    code: string,
    message: string,
    processor: string,
    recoverable = false,
    transactionId?: string
  ): PaymentError => ({
    _tag: 'PaymentError',
    code,
    message,
    processor,
    recoverable,
    transactionId,
  }),

  validation: (field: string, message: string, value?: unknown): ValidationError => ({
    _tag: 'ValidationError',
    field,
    message,
    value,
  }),

  reservation: (
    code: 'SLOT_TAKEN' | 'BLOCK_FAILED' | 'TIMEOUT',
    message: string,
    datetime?: string
  ): ReservationError => ({
    _tag: 'ReservationError',
    code,
    message,
    datetime,
  }),

  idempotency: (key: string, existingResult?: unknown): IdempotencyError => ({
    _tag: 'IdempotencyError',
    key,
    existingResult,
  }),

  infrastructure: (
    code: 'NETWORK' | 'TIMEOUT' | 'REDIS' | 'UNKNOWN',
    message: string,
    cause?: Error
  ): InfrastructureError => ({
    _tag: 'InfrastructureError',
    code,
    message,
    cause,
  }),
} as const;

// =============================================================================
// MONADIC TYPES
// =============================================================================

/**
 * The core result type - TaskEither for async operations with typed errors
 */
export type SchedulingResult<A> = TaskEither<SchedulingError, A>;

/**
 * Reader variant for dependency injection
 */
export type SchedulingReader<Env, A> = ReaderTaskEither<Env, SchedulingError, A>;

// =============================================================================
// DOMAIN TYPES
// =============================================================================

export interface Service {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly duration: number; // minutes
  readonly price: number; // cents
  readonly currency: string;
  readonly category?: string;
  readonly color?: string;
  readonly active: boolean;
}

export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly email?: string;
  readonly description?: string;
  readonly image?: string;
  readonly timezone: string;
}

export interface TimeSlot {
  readonly datetime: string; // ISO 8601
  readonly available: boolean;
  readonly providerId?: string;
}

export interface AvailableDate {
  readonly date: string; // YYYY-MM-DD
  readonly slots: number;
}

export interface ClientInfo {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone?: string;
  readonly notes?: string;
  readonly customFields?: Record<string, string>;
}

export interface BookingRequest {
  readonly serviceId: string;
  readonly providerId?: string;
  readonly datetime: string;
  readonly client: ClientInfo;
  readonly paymentMethod?: string;
  readonly idempotencyKey: string;
}

export interface Booking {
  readonly id: string;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly providerId?: string;
  readonly providerName?: string;
  readonly datetime: string;
  readonly endTime: string;
  readonly duration: number;
  readonly price: number;
  readonly currency: string;
  readonly client: ClientInfo;
  readonly status: BookingStatus;
  readonly confirmationCode?: string;
  readonly paymentStatus: PaymentStatus;
  readonly paymentRef?: string;
  readonly createdAt: string;
}

export type BookingStatus = 'confirmed' | 'pending' | 'cancelled' | 'completed' | 'no-show';
export type PaymentStatus = 'pending' | 'paid' | 'refunded' | 'failed';

export interface SlotReservation {
  readonly id: string;
  readonly datetime: string;
  readonly duration: number;
  readonly expiresAt: string;
  readonly providerId?: string;
}

// =============================================================================
// PAYMENT TYPES
// =============================================================================

export interface PaymentIntent {
  readonly id: string;
  readonly amount: number; // cents
  readonly currency: string;
  readonly status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  readonly processor: string;
  readonly processorTransactionId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface PaymentResult {
  readonly success: boolean;
  readonly transactionId: string;
  readonly processor: string;
  readonly amount: number;
  readonly currency: string;
  readonly timestamp: string;
  readonly receiptUrl?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface RefundResult {
  readonly success: boolean;
  readonly refundId: string;
  readonly originalTransactionId: string;
  readonly amount: number;
  readonly currency: string;
  readonly timestamp: string;
}

// =============================================================================
// CHECKOUT STATE TYPES
// =============================================================================

export type CheckoutStep =
  | 'service'
  | 'provider'
  | 'datetime'
  | 'details'
  | 'payment'
  | 'confirm'
  | 'complete'
  | 'error';

export interface CheckoutState {
  readonly step: CheckoutStep;
  readonly service?: Service;
  readonly provider?: Provider;
  readonly datetime?: string;
  readonly client?: ClientInfo;
  readonly paymentIntent?: PaymentIntent;
  readonly paymentResult?: PaymentResult;
  readonly booking?: Booking;
  readonly reservation?: SlotReservation;
  readonly error?: SchedulingError;
}

// =============================================================================
// CONFIGURATION TYPES
// =============================================================================

export interface SchedulingConfig {
  readonly timezone: string;
  readonly currency: string;
  readonly locale: string;
  readonly minAdvanceHours: number;
  readonly maxAdvanceDays: number;
  readonly slotReservationMinutes: number;
}

export const DEFAULT_CONFIG: SchedulingConfig = {
  timezone: 'America/New_York',
  currency: 'USD',
  locale: 'en-US',
  minAdvanceHours: 2,
  maxAdvanceDays: 60,
  slotReservationMinutes: 15,
};
