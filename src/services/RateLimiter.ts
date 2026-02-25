/**
 * Rate Limiter for Polymarket API
 *
 * Prevents Cloudflare Error 1015 (rate limiting) by:
 * 1. Tracking request counts per endpoint category
 * 2. Implementing request queuing with configurable limits
 * 3. Adding exponential backoff on 429/1015 errors
 *
 * Official Rate Limits (from docs.polymarket.com):
 * - CLOB API (general): 9,000 requests / 10 seconds
 * - CLOB API (market data): 1,500 requests / 10 seconds
 * - Gamma API: 300 requests / 10 seconds
 * - Data API: 150 requests / 10 seconds
 *
 * Applied limits (80% of official):
 * - CLOB general: 7,200 req/10s → 720 req/s
 * - CLOB market data: 1,200 req/10s → 120 req/s
 * - Gamma: 240 req/10s → 24 req/s
 * - Data API: 120 req/10s → 12 req/s
 */

export type EndpointCategory =
  | "clob-general"
  | "clob-market-data"
  | "gamma"
  | "data-api";

interface RateLimitConfig {
  maxRequestsPerWindow: number; // Max requests per 10-second window
  windowMs: number; // Window size in ms (default: 10000)
  minIntervalMs: number; // Minimum ms between requests
  maxRetries: number; // Max retries on rate limit
  baseBackoffMs: number; // Base backoff time for exponential backoff
}

interface RequestRecord {
  timestamp: number;
  category: EndpointCategory;
}

interface QueuedRequest<T> {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  category: EndpointCategory;
  retryCount: number;
}

// Default configs per endpoint category (80% of official limits)
const DEFAULT_CONFIGS: Record<EndpointCategory, RateLimitConfig> = {
  "clob-general": {
    maxRequestsPerWindow: 7200, // 80% of 9000
    windowMs: 10000,
    minIntervalMs: 2, // ~500 req/s max
    maxRetries: 3,
    baseBackoffMs: 1000,
  },
  "clob-market-data": {
    maxRequestsPerWindow: 1200, // 80% of 1500
    windowMs: 10000,
    minIntervalMs: 9, // ~111 req/s max
    maxRetries: 3,
    baseBackoffMs: 1000,
  },
  gamma: {
    maxRequestsPerWindow: 240, // 80% of 300
    windowMs: 10000,
    minIntervalMs: 42, // ~24 req/s max
    maxRetries: 3,
    baseBackoffMs: 2000,
  },
  "data-api": {
    maxRequestsPerWindow: 120, // 80% of 150
    windowMs: 10000,
    minIntervalMs: 84, // ~12 req/s max
    maxRetries: 3,
    baseBackoffMs: 2000,
  },
};

export class RateLimiter {
  private requestHistory: RequestRecord[] = [];
  private lastRequestTime: Record<EndpointCategory, number> = {
    "clob-general": 0,
    "clob-market-data": 0,
    gamma: 0,
    "data-api": 0,
  };
  private queues: Record<EndpointCategory, QueuedRequest<any>[]> = {
    "clob-general": [],
    "clob-market-data": [],
    gamma: [],
    "data-api": [],
  };
  private processing: Record<EndpointCategory, boolean> = {
    "clob-general": false,
    "clob-market-data": false,
    gamma: false,
    "data-api": false,
  };
  private configs: Record<EndpointCategory, RateLimitConfig>;
  private enabled: boolean = true;
  private stats: Record<
    EndpointCategory,
    { requests: number; rateLimited: number; retries: number }
  > = {
    "clob-general": { requests: 0, rateLimited: 0, retries: 0 },
    "clob-market-data": { requests: 0, rateLimited: 0, retries: 0 },
    gamma: { requests: 0, rateLimited: 0, retries: 0 },
    "data-api": { requests: 0, rateLimited: 0, retries: 0 },
  };

  constructor(
    customConfigs?: Partial<Record<EndpointCategory, Partial<RateLimitConfig>>>,
  ) {
    // Merge custom configs with defaults
    this.configs = { ...DEFAULT_CONFIGS };
    if (customConfigs) {
      for (const category of Object.keys(customConfigs) as EndpointCategory[]) {
        if (customConfigs[category]) {
          this.configs[category] = {
            ...this.configs[category],
            ...customConfigs[category],
          };
        }
      }
    }
  }

  /**
   * Enable or disable rate limiting
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      console.log("[RateLimiter] Rate limiting ENABLED");
    } else {
      console.log("[RateLimiter] Rate limiting DISABLED (bypass mode)");
    }
  }

  /**
   * Check if we can make a request right now
   */
  private canRequest(category: EndpointCategory): boolean {
    const config = this.configs[category];
    const now = Date.now();

    // Check minimum interval
    if (now - this.lastRequestTime[category] < config.minIntervalMs) {
      return false;
    }

    // Check window limit
    const windowStart = now - config.windowMs;
    const recentRequests = this.requestHistory.filter(
      (r) => r.category === category && r.timestamp > windowStart,
    );

    return recentRequests.length < config.maxRequestsPerWindow;
  }

  /**
   * Get time to wait before next request is allowed
   */
  private getWaitTime(category: EndpointCategory): number {
    const config = this.configs[category];
    const now = Date.now();

    // Check minimum interval first
    const timeSinceLastRequest = now - this.lastRequestTime[category];
    if (timeSinceLastRequest < config.minIntervalMs) {
      return config.minIntervalMs - timeSinceLastRequest;
    }

    // Check window limit
    const windowStart = now - config.windowMs;
    const recentRequests = this.requestHistory.filter(
      (r) => r.category === category && r.timestamp > windowStart,
    );

    if (recentRequests.length >= config.maxRequestsPerWindow) {
      // Wait until oldest request expires from window
      const oldestInWindow = Math.min(
        ...recentRequests.map((r) => r.timestamp),
      );
      return oldestInWindow + config.windowMs - now + 1;
    }

    return 0;
  }

  /**
   * Record a request
   */
  private recordRequest(category: EndpointCategory): void {
    const now = Date.now();
    this.requestHistory.push({ timestamp: now, category });
    this.lastRequestTime[category] = now;
    this.stats[category].requests++;

    // Cleanup old records (older than 20 seconds)
    const cutoff = now - 20000;
    this.requestHistory = this.requestHistory.filter(
      (r) => r.timestamp > cutoff,
    );
  }

  /**
   * Check if an error is a rate limit error
   */
  isRateLimitError(error: any): boolean {
    if (!error) return false;

    // Check for Cloudflare Error 1015
    const message = error.message || error.toString();
    if (
      message.includes("1015") ||
      message.includes("rate limit") ||
      message.includes("Rate limit")
    ) {
      return true;
    }

    // Check for HTTP 429
    if (error.response?.status === 429) {
      return true;
    }

    // Check for Cloudflare response
    if (error.response?.headers?.["cf-mitigated"] === "challenge") {
      return true;
    }

    return false;
  }

  /**
   * Execute a request with rate limiting
   */
  async execute<T>(
    category: EndpointCategory,
    fn: () => Promise<T>,
    description?: string,
  ): Promise<T> {
    // Bypass if disabled
    if (!this.enabled) {
      return fn();
    }

    return new Promise<T>((resolve, reject) => {
      this.queues[category].push({
        execute: fn,
        resolve,
        reject,
        category,
        retryCount: 0,
      });
      this.processQueue(category);
    });
  }

  /**
   * Process the queue for a category
   */
  private async processQueue(category: EndpointCategory): Promise<void> {
    if (this.processing[category]) return;
    this.processing[category] = true;

    try {
      while (this.queues[category].length > 0) {
        const waitTime = this.getWaitTime(category);
        if (waitTime > 0) {
          await this.sleep(waitTime);
        }

        const request = this.queues[category][0];
        if (!request) break;

        try {
          this.recordRequest(category);
          const result = await request.execute();
          this.queues[category].shift();
          request.resolve(result);
        } catch (error: any) {
          if (this.isRateLimitError(error)) {
            this.stats[category].rateLimited++;

            if (request.retryCount < this.configs[category].maxRetries) {
              // Exponential backoff
              const backoff =
                this.configs[category].baseBackoffMs *
                Math.pow(2, request.retryCount);
              console.warn(
                `[RateLimiter] Rate limited on ${category}, retry ${request.retryCount + 1}/${this.configs[category].maxRetries} after ${backoff}ms`,
              );

              request.retryCount++;
              this.stats[category].retries++;
              await this.sleep(backoff);
              // Don't shift - retry same request
            } else {
              console.error(
                `[RateLimiter] Rate limit retries exhausted for ${category}`,
              );
              this.queues[category].shift();
              request.reject(error);
            }
          } else {
            // Non-rate-limit error - fail immediately
            this.queues[category].shift();
            request.reject(error);
          }
        }
      }
    } finally {
      this.processing[category] = false;
    }
  }

  /**
   * Get current stats
   */
  getStats(): Record<
    EndpointCategory,
    {
      requests: number;
      rateLimited: number;
      retries: number;
      queueLength: number;
    }
  > {
    const result: any = {};
    for (const category of Object.keys(this.stats) as EndpointCategory[]) {
      result[category] = {
        ...this.stats[category],
        queueLength: this.queues[category].length,
      };
    }
    return result;
  }

  /**
   * Get request count in current window
   */
  getWindowRequestCount(category: EndpointCategory): number {
    const now = Date.now();
    const windowStart = now - this.configs[category].windowMs;
    return this.requestHistory.filter(
      (r) => r.category === category && r.timestamp > windowStart,
    ).length;
  }

  /**
   * Check if approaching rate limit threshold (>80% of limit)
   */
  isApproachingLimit(category: EndpointCategory): boolean {
    const count = this.getWindowRequestCount(category);
    const limit = this.configs[category].maxRequestsPerWindow;
    return count > limit * 0.8;
  }

  /**
   * Reset stats (for testing)
   */
  resetStats(): void {
    for (const category of Object.keys(this.stats) as EndpointCategory[]) {
      this.stats[category] = { requests: 0, rateLimited: 0, retries: 0 };
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton instance for global rate limiting
let globalRateLimiter: RateLimiter | null = null;

export function getGlobalRateLimiter(): RateLimiter {
  if (!globalRateLimiter) {
    globalRateLimiter = new RateLimiter();
  }
  return globalRateLimiter;
}

export function setGlobalRateLimiter(limiter: RateLimiter): void {
  globalRateLimiter = limiter;
}
