const DEFAULT_BASE_DELAY_MS = 2000;
const DEFAULT_MAX_DELAY_MS = 30000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value: string | null): number | null {
	if (!value) {
		return null;
	}

	const seconds = Number.parseInt(value, 10);
	if (!Number.isNaN(seconds)) {
		return Math.max(0, seconds * 1000);
	}

	const date = Date.parse(value);
	if (!Number.isNaN(date)) {
		const delta = date - Date.now();
		return delta > 0 ? delta : 0;
	}

	return null;
}

export class WebSearchRateLimiter {
	private backoffMs = 0;
	private nextAllowedAt = 0;

	constructor(
		private readonly baseDelayMs = DEFAULT_BASE_DELAY_MS,
		private readonly maxDelayMs = DEFAULT_MAX_DELAY_MS,
	) {}

	async wait(): Promise<void> {
		const now = Date.now();
		if (now < this.nextAllowedAt) {
			await sleep(this.nextAllowedAt - now);
		}
	}

	on429(retryAfterHeader: string | null): void {
		const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
		const now = Date.now();

		if (retryAfterMs !== null && retryAfterMs > 0) {
			this.backoffMs = Math.min(
				this.maxDelayMs,
				Math.max(this.backoffMs, retryAfterMs),
			);
		} else if (this.backoffMs > 0) {
			this.backoffMs = Math.min(this.maxDelayMs, this.backoffMs * 2);
		} else {
			this.backoffMs = this.baseDelayMs;
		}

		this.nextAllowedAt = now + this.backoffMs;
	}

	onSuccess(): void {
		if (this.backoffMs <= 0) {
			return;
		}

		this.backoffMs = Math.floor(this.backoffMs * 0.5);
		this.nextAllowedAt = Date.now() + this.backoffMs;
	}
}
