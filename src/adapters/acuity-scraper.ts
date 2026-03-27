/**
 * Re-export scraper from @tummycrypt/scheduling-kit.
 *
 * @deprecated — see scheduling-kit's acuity-scraper.ts for deprecation details.
 * Prefer extract-business.ts (BUSINESS object) and wizard steps (readAvailableDates, readTimeSlots).
 */
export {
  AcuityScraper,
  createScraperAdapter,
  scrapeServicesOnce,
  scrapeAvailabilityOnce,
  type ScraperConfig,
  type ScrapedService,
  type ScrapedAvailability,
  type ScrapedTimeSlot,
} from '@tummycrypt/scheduling-kit/adapters';
