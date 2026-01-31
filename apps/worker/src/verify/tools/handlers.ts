import type { FetchWithTimeout, VerificationContext } from "../types";
import { getEarlierFootnotes } from "./earlier-footnotes";
import { readPdfPage } from "./read-pdf-page";
import { fetchAndExtractText } from "./read-url";
import { performWebSearch } from "./web-search";

interface ToolHandlerDeps {
	fetchWithTimeout: FetchWithTimeout;
	getCurrentContext: () => VerificationContext | null;
	getLinkupApiKey: () => string | null;
}

export function createToolHandler({
	fetchWithTimeout,
	getCurrentContext,
	getLinkupApiKey,
}: ToolHandlerDeps) {
	return async (
		name: string,
		args: Record<string, unknown>,
	): Promise<string> => {
		switch (name) {
			case "web_search":
				return performWebSearch(args.query as string, {
					fetchWithTimeout,
					getApiKey: getLinkupApiKey,
				});
			case "read_url":
				return fetchAndExtractText(args.url as string, fetchWithTimeout);
			case "read_pdf_page":
				return readPdfPage(
					args.url as string,
					args.page as number,
					fetchWithTimeout,
				);
			case "get_earlier_footnotes":
				return getEarlierFootnotes(
					getCurrentContext(),
					args.specific_index as number | undefined,
				);
			default:
				return `Unknown tool: ${name}`;
		}
	};
}
