/**
 * Re-export core types from @tummycrypt/scheduling-kit.
 *
 * Type-only imports — no runtime code pulled in from scheduling-kit.
 * The Errors factory is inlined to avoid dragging in the full
 * scheduling-kit module tree (Svelte components, drizzle, etc.)
 * which breaks esbuild bundling for the Modal container.
 */
export type {
  AcuityError,
  CalComError,
  PaymentError,
  ValidationError,
  ReservationError,
  IdempotencyError,
  InfrastructureError,
  SchedulingError,
  SchedulingResult,
  SchedulingReader,
  Service,
  Provider,
  TimeSlot,
  AvailableDate,
  ClientInfo,
  BookingRequest,
  Booking,
  BookingStatus,
  PaymentStatus,
  SlotReservation,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  SchedulingConfig,
} from '@tummycrypt/scheduling-kit/core';

// Inlined from scheduling-kit/core/types.ts to avoid runtime import
// that would pull in the full module tree via esbuild.
import type {
  AcuityError,
  CalComError,
  PaymentError,
  ValidationError,
  ReservationError,
  IdempotencyError,
  InfrastructureError,
} from '@tummycrypt/scheduling-kit/core';

export const Errors = {
  acuity: (code: string, message: string, statusCode?: number, endpoint?: string): AcuityError => ({
    _tag: 'AcuityError', code, message, statusCode, endpoint,
  }),
  calcom: (code: string, message: string, statusCode?: number): CalComError => ({
    _tag: 'CalComError', code, message, statusCode,
  }),
  payment: (code: string, message: string, processor: string, recoverable = false, transactionId?: string): PaymentError => ({
    _tag: 'PaymentError', code, message, processor, recoverable, transactionId,
  }),
  validation: (field: string, message: string, value?: unknown): ValidationError => ({
    _tag: 'ValidationError', field, message, value,
  }),
  reservation: (code: 'SLOT_TAKEN' | 'BLOCK_FAILED' | 'TIMEOUT', message: string, datetime?: string): ReservationError => ({
    _tag: 'ReservationError', code, message, datetime,
  }),
  idempotency: (key: string, existingResult?: unknown): IdempotencyError => ({
    _tag: 'IdempotencyError', key, existingResult,
  }),
  infrastructure: (code: 'NETWORK' | 'TIMEOUT' | 'REDIS' | 'UNKNOWN', message: string, cause?: Error): InfrastructureError => ({
    _tag: 'InfrastructureError', code, message, cause,
  }),
} as const;
