/**
 * Re-export core types from @tummycrypt/scheduling-kit.
 *
 * We selectively re-export only the types module (not utils/pipelines)
 * to avoid pulling in fp-ts runtime code that has ESM import issues
 * in the published package.
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

export { Errors } from '@tummycrypt/scheduling-kit/core';
