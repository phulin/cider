import type { Footnote } from "@cider/shared";

export interface VerificationContext {
	allFootnotes: Footnote[];
	currentIndex: number;
}

export type FetchWithTimeout = (
	input: RequestInfo | URL,
	timeoutMs: number,
	init?: RequestInit,
) => Promise<Response>;
