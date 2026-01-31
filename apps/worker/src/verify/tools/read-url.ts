import { parseHTML } from "linkedom";
import type { FetchWithTimeout } from "../types";

const MAX_CONTENT_CHARS = 20000;

const DEFAULT_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
};

export async function fetchAndExtractText(
	url: string,
	fetchWithTimeout: FetchWithTimeout,
): Promise<string> {
	try {
		const startedAt = Date.now();
		// Clean up URL if needed
		let cleanUrl = url.trim();
		if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
			cleanUrl = `https://${cleanUrl}`;
		}

		const response = await fetchWithTimeout(cleanUrl, 15000, {
			headers: DEFAULT_HEADERS,
			redirect: "follow",
		});
		console.log(
			`[verify] read_url "${cleanUrl}" -> ${response.status} in ${Date.now() - startedAt}ms`,
		);

		if (!response.ok) {
			if (response.status === 403 || response.status === 401) {
				return `Access denied (HTTP ${response.status}). This may be a paywalled source. Try searching for an open access version.`;
			}
			if (response.status === 404) {
				return `Page not found (HTTP 404). The URL may be outdated. Try searching for the article by title.`;
			}
			return `Failed to fetch URL: HTTP ${response.status}. Try searching for an alternate source.`;
		}

		const contentType = response.headers.get("content-type") || "";

		if (contentType.includes("application/pdf")) {
			return "PDF detected. Use read_pdf_page with the URL and a page number to extract text. Note: citation page numbers may not match the PDF's internal page order.";
		}

		const html = await response.text();
		const { document } = parseHTML(html);

		// Remove non-content elements
		document
			.querySelectorAll(
				"script, style, nav, footer, header, aside, .ad, .advertisement, .sidebar, .menu, .navigation",
			)
			.forEach((el: Element) => {
				el.remove();
			});

		// Try to find main content area
		const contentSelectors = [
			"article",
			"main",
			".article-content",
			".post-content",
			".entry-content",
			".content",
			"#content",
			".article-body",
			".story-body",
			"[role='main']",
		];

		let mainContent = null;
		for (const selector of contentSelectors) {
			mainContent = document.querySelector(selector);
			if (mainContent) break;
		}

		if (!mainContent) {
			mainContent = document.body;
		}

		// Extract title
		const title =
			document.querySelector("title")?.textContent?.trim() ||
			document.querySelector("h1")?.textContent?.trim() ||
			"Untitled";

		const text = mainContent?.textContent?.trim() || "";

		// Clean up whitespace
		const cleanedText = text.replace(/\s+/g, " ").replace(/\n\s*\n/g, "\n\n");

		// Truncate to reasonable size for LLM context
		const truncated = cleanedText.slice(0, MAX_CONTENT_CHARS);

		let result = `**Title**: ${title}\n**URL**: ${cleanUrl}\n\n**Content**:\n${truncated}`;

		if (truncated.length < cleanedText.length) {
			result += "\n\n[Content truncated - showing first 20,000 characters]";
		}

		if (truncated.length < 500) {
			result +=
				"\n\n[Note: Very little content extracted. This may be a paywall, JavaScript-heavy site, or redirect page. Try searching for the content elsewhere.]";
		}

		return (
			result || "No text content found. Try searching for this source by title."
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		console.log(`[verify] read_url "${url}" failed: ${message}`);
		return `Error fetching URL: ${message}. Try searching for this source using web_search.`;
	}
}
