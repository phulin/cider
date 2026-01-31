import type { FetchWithTimeout } from "../types";
import { WebSearchRateLimiter } from "./rate-limiter";

const MAX_WEB_SEARCH_CHARS = 10000;
const defaultRateLimiter = new WebSearchRateLimiter();

interface WebSearchDeps {
	fetchWithTimeout: FetchWithTimeout;
	getApiKey: () => string | null;
	rateLimiter?: WebSearchRateLimiter;
}

export async function performWebSearch(
	query: string,
	{
		fetchWithTimeout,
		getApiKey,
		rateLimiter = defaultRateLimiter,
	}: WebSearchDeps,
): Promise<string> {
	const apiKey = getApiKey();
	if (!apiKey) {
		return "Search unavailable: LINKUP_API_KEY is not set.";
	}

	try {
		await rateLimiter.wait();
		const startedAt = Date.now();
		const response = await fetchWithTimeout(
			"https://api.linkup.so/v1/search",
			15000,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					q: query,
					depth: "standard",
					outputType: "searchResults",
					includeImages: false,
					maxResults: 5,
				}),
			},
		);
		console.log(
			`[verify] web_search "${query}" -> ${response.status} in ${Date.now() - startedAt}ms`,
		);

		if (!response.ok) {
			if (response.status === 429) {
				rateLimiter.on429(response.headers.get("retry-after"));
			}

			const detail = await response.text().catch(() => "");
			const suffix = detail ? ` (${detail.slice(0, 200)})` : "";
			return `Search failed with status ${response.status}${suffix}. Try a different search query.`;
		}

		rateLimiter.onSuccess();

		const data = (await response.json()) as {
			results?: Array<{
				type?: string;
				name?: string;
				url?: string;
				content?: string;
			}>;
		};

		const results: string[] = [];

		if (data.results && data.results.length > 0) {
			results.push("**Results:**");
			data.results.slice(0, 5).forEach((r, i) => {
				const title = r.name || "Result";
				const url = r.url || "";
				const content = r.content ? `\n   ${r.content}` : "";
				results.push(`${i + 1}. ${title}\n   ${url}${content}`);
			});
		}

		if (results.length === 0) {
			return `No results found for "${query}". Try:\n- Different keywords\n- Author names + title\n- Removing special characters\n- Searching for the publication name`;
		}

		const output = results.join("\n");
		if (output.length > MAX_WEB_SEARCH_CHARS) {
			const truncated = output.slice(0, MAX_WEB_SEARCH_CHARS);
			return `${truncated}\n\n[Results truncated to ${MAX_WEB_SEARCH_CHARS} characters]`;
		}
		return output;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		console.log(`[verify] web_search "${query}" failed in error: ${message}`);
		return `Search error: ${error instanceof Error ? error.message : "Unknown error"}. Try a simpler query.`;
	}
}
