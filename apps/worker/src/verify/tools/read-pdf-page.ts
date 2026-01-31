import pdfParse from "pdf-parse";
import type { FetchWithTimeout } from "../types";

const MAX_PDF_PAGE_CHARS = 12000;
const PDF_CACHE_LIMIT = 3;

const pdfCache = new Map<string, ArrayBuffer>();

const DEFAULT_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	Accept: "application/pdf,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
};

async function fetchPdfBytes(
	url: string,
	fetchWithTimeout: FetchWithTimeout,
): Promise<ArrayBuffer | string> {
	let cleanUrl = url.trim();
	if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
		cleanUrl = `https://${cleanUrl}`;
	}

	const cached = pdfCache.get(cleanUrl);
	if (cached) {
		return cached;
	}

	const startedAt = Date.now();
	const response = await fetchWithTimeout(cleanUrl, 20000, {
		headers: DEFAULT_HEADERS,
		redirect: "follow",
	});
	console.log(
		`[verify] read_pdf_page "${cleanUrl}" -> ${response.status} in ${Date.now() - startedAt}ms`,
	);

	if (!response.ok) {
		if (response.status === 403 || response.status === 401) {
			return `Access denied (HTTP ${response.status}). This PDF may be paywalled.`;
		}
		if (response.status === 404) {
			return "PDF not found (HTTP 404). The URL may be outdated.";
		}
		return `Failed to fetch PDF: HTTP ${response.status}.`;
	}

	const contentType = response.headers.get("content-type") || "";
	if (!contentType.includes("application/pdf")) {
		return `Expected a PDF but got content-type: ${contentType || "unknown"}.`;
	}

	const data = await response.arrayBuffer();
	if (pdfCache.size >= PDF_CACHE_LIMIT) {
		const oldestKey = pdfCache.keys().next().value as string | undefined;
		if (oldestKey) {
			pdfCache.delete(oldestKey);
		}
	}
	pdfCache.set(cleanUrl, data);
	return data;
}

export async function readPdfPage(
	url: string,
	pageNumber: number,
	fetchWithTimeout: FetchWithTimeout,
): Promise<string> {
	if (!Number.isFinite(pageNumber) || pageNumber < 1) {
		return "Invalid page number. Provide a 1-based page number.";
	}

	const dataOrError = await fetchPdfBytes(url, fetchWithTimeout);
	if (typeof dataOrError === "string") {
		return dataOrError;
	}

	try {
		const data = Buffer.from(dataOrError);
		const targetIndex = pageNumber - 1;
		let extractedText = "";

		const parsed = await pdfParse(data, {
			max: pageNumber,
			pagerender: (pageData: {
				pageIndex?: number;
				pageNumber?: number;
				getTextContent: () => Promise<{
					items: Array<{ str?: string }>;
				}>;
			}) => {
				const pageIndex =
					typeof pageData.pageIndex === "number"
						? pageData.pageIndex
						: typeof pageData.pageNumber === "number"
							? pageData.pageNumber - 1
							: undefined;

				if (pageIndex !== undefined && pageIndex !== targetIndex) {
					return Promise.resolve("");
				}

				return pageData.getTextContent().then((text) => {
					const textValue = text.items
						.map((item) => item.str ?? "")
						.filter(Boolean)
						.join(" ")
						.replace(/\s+/g, " ")
						.trim();
					extractedText = textValue;
					return textValue;
				});
			},
		});

		const totalPages = parsed.numpages || 0;
		if (totalPages && pageNumber > totalPages) {
			return `PDF has ${totalPages} pages. Requested page ${pageNumber} is out of range.`;
		}

		const rawText = (extractedText || parsed.text || "")
			.replace(/\s+/g, " ")
			.trim();
		const truncated =
			rawText.length > MAX_PDF_PAGE_CHARS
				? `${rawText.slice(0, MAX_PDF_PAGE_CHARS)}...`
				: rawText;

		let result = `**PDF**: ${url}\n**Page**: ${pageNumber}/${totalPages || "?"}\n\n${truncated}`;
		if (rawText.length > MAX_PDF_PAGE_CHARS) {
			result += `\n\n[Content truncated to ${MAX_PDF_PAGE_CHARS} characters]`;
		}
		if (truncated.length < 200) {
			result +=
				"\n\n[Note: Very little text extracted. This page may be scanned or image-based.]";
		}

		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		return `Failed to parse PDF: ${message}`;
	}
}
