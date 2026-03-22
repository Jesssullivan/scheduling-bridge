/**
 * Scheduling Adapter Interface
 * Backend-agnostic contract for scheduling providers (Acuity, Cal.com, etc.)
 */

import type {
  SchedulingResult,
  Service,
  Provider,
  TimeSlot,
  AvailableDate,
  Booking,
  BookingRequest,
  SlotReservation,
  ClientInfo,
} from '../core/types.js';

// =============================================================================
// SCHEDULING ADAPTER INTERFACE
// =============================================================================

/**
 * The core abstraction for scheduling backends.
 * Implement this interface for Acuity, Cal.com, or any other provider.
 */
export interface SchedulingAdapter {
  readonly name: string;

  // ---------------------------------------------------------------------------
  // Services (Appointment Types)
  // ---------------------------------------------------------------------------

  /**
   * Get all available services/appointment types
   */
  getServices(): SchedulingResult<Service[]>;

  /**
   * Get a specific service by ID
   */
  getService(serviceId: string): SchedulingResult<Service>;

  // ---------------------------------------------------------------------------
  // Providers (Calendars/Staff)
  // ---------------------------------------------------------------------------

  /**
   * Get all providers/calendars
   */
  getProviders(): SchedulingResult<Provider[]>;

  /**
   * Get a specific provider by ID
   */
  getProvider(providerId: string): SchedulingResult<Provider>;

  /**
   * Get providers available for a specific service
   */
  getProvidersForService(serviceId: string): SchedulingResult<Provider[]>;

  // ---------------------------------------------------------------------------
  // Availability
  // ---------------------------------------------------------------------------

  /**
   * Get available dates for a service (and optionally a provider)
   */
  getAvailableDates(params: {
    serviceId: string;
    providerId?: string;
    startDate: string; // YYYY-MM-DD
    endDate: string;   // YYYY-MM-DD
  }): SchedulingResult<AvailableDate[]>;

  /**
   * Get available time slots for a specific date
   */
  getAvailableSlots(params: {
    serviceId: string;
    providerId?: string;
    date: string; // YYYY-MM-DD
  }): SchedulingResult<TimeSlot[]>;

  /**
   * Check if a specific datetime is still available
   */
  checkSlotAvailability(params: {
    serviceId: string;
    providerId?: string;
    datetime: string; // ISO 8601
  }): SchedulingResult<boolean>;

  // ---------------------------------------------------------------------------
  // Slot Reservation (Hold)
  // ---------------------------------------------------------------------------

  /**
   * Create a temporary hold on a time slot while payment is processing.
   * This prevents double-booking during the checkout flow.
   */
  createReservation(params: {
    serviceId: string;
    providerId?: string;
    datetime: string;
    duration: number;
    expirationMinutes?: number;
    notes?: string;
  }): SchedulingResult<SlotReservation>;

  /**
   * Release a slot reservation (after successful booking or timeout)
   */
  releaseReservation(reservationId: string): SchedulingResult<void>;

  // ---------------------------------------------------------------------------
  // Bookings
  // ---------------------------------------------------------------------------

  /**
   * Create a new booking/appointment
   */
  createBooking(request: BookingRequest): SchedulingResult<Booking>;

  /**
   * Create a booking with a payment reference stored in notes/metadata
   * This is the key method for alt-payment integration
   */
  createBookingWithPaymentRef(
    request: BookingRequest,
    paymentRef: string,
    paymentProcessor: string
  ): SchedulingResult<Booking>;

  /**
   * Get a booking by ID
   */
  getBooking(bookingId: string): SchedulingResult<Booking>;

  /**
   * Cancel a booking
   */
  cancelBooking(bookingId: string, reason?: string): SchedulingResult<void>;

  /**
   * Reschedule a booking to a new datetime
   */
  rescheduleBooking(
    bookingId: string,
    newDatetime: string
  ): SchedulingResult<Booking>;

  // ---------------------------------------------------------------------------
  // Clients
  // ---------------------------------------------------------------------------

  /**
   * Find or create a client
   */
  findOrCreateClient(client: ClientInfo): SchedulingResult<{ id: string; isNew: boolean }>;

  /**
   * Get client by email
   */
  getClientByEmail(email: string): SchedulingResult<ClientInfo | null>;
}

// =============================================================================
// ADAPTER CONFIGURATION
// =============================================================================

export interface AcuityAdapterConfig {
  readonly type: 'acuity';
  readonly userId: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
}

export interface CalComAdapterConfig {
  readonly type: 'calcom';
  readonly apiKey: string;
  readonly baseUrl?: string;
}

export type SchedulingAdapterConfig = AcuityAdapterConfig | CalComAdapterConfig;

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

export type CreateSchedulingAdapter = (
  config: SchedulingAdapterConfig
) => SchedulingAdapter;
