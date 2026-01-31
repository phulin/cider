import type {
	Footnote,
	SourceResult,
	ToolCall,
	Verdict,
	Verification,
} from "@cider/shared";
import {
	createPartFromFunctionResponse,
	GoogleGenAI,
	Type,
} from "@google/genai";
import { parseHTML } from "linkedom";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";

// Context for the current document - passed to verification functions
interface VerificationContext {
	allFootnotes: Footnote[];
	currentIndex: number;
}

const MODEL_NAME = "gemini-3-flash-preview";
const MAX_WEB_SEARCH_CHARS = 10000;
const MAX_PDF_PAGE_CHARS = 12000;
const PDF_CACHE_LIMIT = 3;

GlobalWorkerOptions.workerSrc = "";

// Simple in-memory cache for PDF bytes; swap to R2 if persistence is needed.
const pdfCache = new Map<string, ArrayBuffer>();

const VERIFICATION_SYSTEM_PROMPT = `You are an expert citation verification assistant. Your job is to rigorously verify that cited sources actually support the claims they're attached to.

CRITICAL INSTRUCTIONS:

1. **Identify ALL sources** in this citation. Many footnotes cite multiple sources (separated by semicolons, "see also", "compare", etc.). You must attempt to verify EACH source mentioned.

2. **Handle cross-references**: If the citation uses shorthand references like:
   - "Id." or "Ibid." - refers to the immediately preceding footnote
   - "Supra note X" - refers to footnote X earlier in the document
   - "Op. cit." - refers to a previously cited work
   Use the get_earlier_footnotes tool to retrieve the full citation from earlier footnotes.

3. **Be persistent in finding sources**:
   - If a URL doesn't work, try web_search to find an archived or alternate version
   - For academic papers, search by title and author
   - For news articles, search by headline
   - For books, search for excerpts or reviews that quote relevant passages

4. **Use your tools liberally**:
   - web_search: Search for sources by title, author, or key phrases
   - read_url: Fetch and read content from URLs
   - read_pdf_page: Extract text from a specific PDF page (PDF page numbers may not match citation page numbering)
   - get_earlier_footnotes: Retrieve earlier footnotes for cross-references

5. **For each source you find**, determine:
   - Does it DIRECTLY support the specific claim?
   - Does it only PARTIALLY support (supports a related but not identical claim)?
   - Does it NOT SUPPORT (discusses the topic but doesn't back up this claim)?
   - Does it CONTRADICT the claim?

After thoroughly investigating, respond with ONLY a JSON object:
{
  "sources": [
    {
      "title": "Source title or description",
      "url": "URL if found",
      "accessed": true/false,
      "verdict": "supports" | "partially_supports" | "does_not_support" | "contradicts" | "source_unavailable",
      "explanation": "Brief explanation for this specific source"
    }
  ],
  "overall_verdict": "supports" | "partially_supports" | "does_not_support" | "contradicts" | "source_unavailable",
  "confidence": 0.0-1.0,
  "explanation": "Overall assessment considering all sources"
}

IMPORTANT:
- If there are multiple sources, the overall_verdict should reflect the WEAKEST support among accessible sources.
- If you cannot access ANY sources, use "source_unavailable".
- Be THOROUGH. Make multiple tool calls. Check multiple sources. Don't give up easily.`;

const VERIFICATION_CACHE_TTL = "3600s";

const tools = [
	{
		functionDeclarations: [
			{
				name: "web_search",
				description:
					"Search the web for information about a citation, source, article, paper, or book. Use this to find URLs for sources, find archived versions of dead links, or locate academic papers by title/author.",
				parameters: {
					type: Type.OBJECT,
					properties: {
						query: {
							type: Type.STRING,
							description:
								"Search query - be specific with titles, authors, publication names",
						},
					},
					required: ["query"],
				},
			},
		],
	},
	{
		functionDeclarations: [
			{
				name: "read_url",
				description:
					"Fetch and read the content of a URL. Use this to access web pages, articles, papers (if open access), and other online sources.",
				parameters: {
					type: Type.OBJECT,
					properties: {
						url: {
							type: Type.STRING,
							description: "URL to fetch and read",
						},
					},
					required: ["url"],
				},
			},
		],
	},
	{
		functionDeclarations: [
			{
				name: "read_pdf_page",
				description:
					"Download a PDF and extract text from a specific page. Page numbers are 1-based and follow the PDF's internal order (this may NOT match citation page numbering).",
				parameters: {
					type: Type.OBJECT,
					properties: {
						url: {
							type: Type.STRING,
							description: "PDF URL to download",
						},
						page: {
							type: Type.NUMBER,
							description:
								"Page number to extract (1-based; PDF internal order)",
						},
					},
					required: ["url", "page"],
				},
			},
		],
	},
	{
		functionDeclarations: [
			{
				name: "get_earlier_footnotes",
				description:
					"Retrieve earlier footnotes from the document. Use this when the current citation references earlier footnotes with 'Id.', 'Ibid.', 'supra note X', or similar cross-references.",
				parameters: {
					type: Type.OBJECT,
					properties: {
						count: {
							type: Type.NUMBER,
							description:
								"Number of earlier footnotes to retrieve (1-10). For 'Id.', use 1. For 'supra note X', retrieve from footnote 1 up to the current one.",
						},
						specific_index: {
							type: Type.NUMBER,
							description:
								"Optional: retrieve a specific footnote by its number (e.g., for 'supra note 5', use 5)",
						},
					},
					required: ["count"],
				},
			},
		],
	},
];

const verificationResponseSchema = {
	type: Type.OBJECT,
	properties: {
		sources: {
			type: Type.ARRAY,
			items: {
				type: Type.OBJECT,
				properties: {
					title: { type: Type.STRING },
					url: { type: Type.STRING },
					accessed: { type: Type.BOOLEAN },
					verdict: { type: Type.STRING },
					explanation: { type: Type.STRING },
				},
				required: ["accessed", "verdict", "explanation"],
			},
		},
		overall_verdict: { type: Type.STRING },
		confidence: { type: Type.NUMBER },
		explanation: { type: Type.STRING },
	},
	required: ["sources", "overall_verdict", "confidence", "explanation"],
};

// Store context for the current verification session
let currentContext: VerificationContext | null = null;
let currentLinkupApiKey: string | null = null;

const verificationCacheByKey = new Map<string, Promise<string | null>>();

function buildVerificationUserPrompt(
	footnoteNumber: number | string,
	claim: string,
	citation: string,
	extraInstructions?: string,
): string {
	const base = `CURRENT FOOTNOTE NUMBER: ${footnoteNumber}

CLAIM (from the document):
${claim}

CITATION (footnote text):
${citation}`;

	if (!extraInstructions) {
		return base;
	}

	return `${base}\n\n${extraInstructions}`;
}

async function getVerificationCacheName(
	apiKey: string,
): Promise<string | null> {
	const cacheKey = `${apiKey}:${MODEL_NAME}:verification-system`;
	const existing = verificationCacheByKey.get(cacheKey);
	if (existing) {
		return existing;
	}

	const pending = (async () => {
		try {
			const genai = new GoogleGenAI({ apiKey });
			const cache = await genai.caches.create({
				model: MODEL_NAME,
				config: {
					systemInstruction: VERIFICATION_SYSTEM_PROMPT,
					ttl: VERIFICATION_CACHE_TTL,
				},
			});
			console.log(`[verify] prompt cache ready: ${cache.name}`);
			return cache.name ?? null;
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			console.log(`[verify] prompt cache failed: ${message}`);
			return null;
		}
	})();

	verificationCacheByKey.set(cacheKey, pending);
	return pending;
}

/**
 * Perform a web search using Linkup
 */
async function performWebSearch(query: string): Promise<string> {
	const apiKey = currentLinkupApiKey;
	if (!apiKey) {
		return "Search unavailable: LINKUP_API_KEY is not set.";
	}

	try {
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
			const detail = await response.text().catch(() => "");
			const suffix = detail ? ` (${detail.slice(0, 200)})` : "";
			return `Search failed with status ${response.status}${suffix}. Try a different search query.`;
		}

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

/**
 * Fetch a URL and extract its text content
 */
async function fetchAndExtractText(url: string): Promise<string> {
	try {
		const startedAt = Date.now();
		// Clean up URL if needed
		let cleanUrl = url.trim();
		if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
			cleanUrl = `https://${cleanUrl}`;
		}

		const response = await fetchWithTimeout(cleanUrl, 15000, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
			},
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
		const maxLength = 20000;
		const truncated = cleanedText.slice(0, maxLength);

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

async function fetchPdfBytes(url: string): Promise<ArrayBuffer | string> {
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
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Accept: "application/pdf,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
		},
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

async function readPdfPage(url: string, pageNumber: number): Promise<string> {
	if (!Number.isFinite(pageNumber) || pageNumber < 1) {
		return "Invalid page number. Provide a 1-based page number.";
	}

	const dataOrError = await fetchPdfBytes(url);
	if (typeof dataOrError === "string") {
		return dataOrError;
	}

	try {
		const loadingTask = getDocument({ data: dataOrError });
		const pdf = await loadingTask.promise;
		const totalPages = pdf.numPages;
		if (pageNumber > totalPages) {
			return `PDF has ${totalPages} pages. Requested page ${pageNumber} is out of range.`;
		}

		const page = await pdf.getPage(pageNumber);
		const textContent = (await page.getTextContent()) as {
			items: Array<{ str?: string }>;
		};
		const parts = textContent.items
			.map((item) => item.str ?? "")
			.filter(Boolean);
		const rawText = parts.join(" ").replace(/\s+/g, " ").trim();
		const truncated =
			rawText.length > MAX_PDF_PAGE_CHARS
				? `${rawText.slice(0, MAX_PDF_PAGE_CHARS)}...`
				: rawText;

		let result = `**PDF**: ${url}\n**Page**: ${pageNumber}/${totalPages}\n\n${truncated}`;
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

async function fetchWithTimeout(
	input: RequestInfo | URL,
	timeoutMs: number,
	init?: RequestInit,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await fetch(input, {
			...init,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Get earlier footnotes for cross-reference resolution
 */
function getEarlierFootnotes(count: number, specificIndex?: number): string {
	if (!currentContext) {
		return "No document context available.";
	}

	const { allFootnotes, currentIndex } = currentContext;

	if (specificIndex !== undefined) {
		// Get a specific footnote by index (1-based in documents)
		const footnote = allFootnotes.find((f) => f.index === specificIndex);
		if (footnote) {
			const label = footnote.displayIndex ?? String(footnote.index);
			return `**Footnote ${label}**:\nClaim: ${footnote.claim}\nCitation: ${footnote.citation}`;
		}
		return `Footnote ${specificIndex} not found.`;
	}

	// Get the previous N footnotes
	const startIdx = Math.max(0, currentIndex - count);
	const previousFootnotes = allFootnotes.slice(startIdx, currentIndex);

	if (previousFootnotes.length === 0) {
		return "No earlier footnotes available (this is the first footnote).";
	}

	const formatted = previousFootnotes
		.map((f) => {
			const label = f.displayIndex ?? String(f.index);
			return `**Footnote ${label}**:\nClaim: ${f.claim}\nCitation: ${f.citation}`;
		})
		.join("\n\n---\n\n");

	return `Earlier footnotes (${previousFootnotes.length} retrieved):\n\n${formatted}`;
}

/**
 * Handle tool calls from Gemini
 */
async function handleToolCall(
	name: string,
	args: Record<string, unknown>,
): Promise<string> {
	switch (name) {
		case "web_search":
			return await performWebSearch(args.query as string);
		case "read_url":
			return await fetchAndExtractText(args.url as string);
		case "read_pdf_page":
			return await readPdfPage(args.url as string, args.page as number);
		case "get_earlier_footnotes":
			return getEarlierFootnotes(
				(args.count as number) || 1,
				args.specific_index as number | undefined,
			);
		default:
			return `Unknown tool: ${name}`;
	}
}

/**
 * Parse the verification response from Gemini
 */
function parseVerificationResponse(
	text: string,
	footnoteId: string,
): Verification {
	try {
		const trimmed = text.trim();
		if (!trimmed) {
			throw new Error("Empty response");
		}

		// Try to extract JSON from the response
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			throw new Error("No JSON found in response");
		}

		const parsed = JSON.parse(jsonMatch[0]) as {
			sources?: Array<{
				title?: string;
				url?: string | null;
				accessed?: boolean;
				verdict?: string;
				explanation?: string;
			}>;
			overall_verdict?: string;
			verdict?: string; // fallback for old format
			confidence?: number;
			explanation?: string;
			source_accessed?: boolean;
			source_url?: string | null;
		};

		const validVerdicts: Verdict[] = [
			"supports",
			"partially_supports",
			"does_not_support",
			"contradicts",
			"source_unavailable",
		];

		// Parse individual sources
		const sources: SourceResult[] = (parsed.sources || []).map((s) => ({
			title: s.title,
			url: s.url || undefined,
			accessed: s.accessed ?? false,
			verdict: validVerdicts.includes(s.verdict as Verdict)
				? (s.verdict as Verdict)
				: "source_unavailable",
			explanation: s.explanation || "",
		}));

		// Get overall verdict
		const overallVerdict = parsed.overall_verdict || parsed.verdict;
		const verdict = validVerdicts.includes(overallVerdict as Verdict)
			? (overallVerdict as Verdict)
			: "source_unavailable";

		// Determine if any source was accessed
		const sourceAccessed =
			sources.some((s) => s.accessed) || (parsed.source_accessed ?? false);

		// Get primary source URL (first accessible one)
		const primaryUrl =
			sources.find((s) => s.url && s.accessed)?.url ||
			parsed.source_url ||
			undefined;

		return {
			footnoteId,
			verdict,
			confidence:
				typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
			explanation: parsed.explanation || "Unable to parse explanation",
			sourceAccessed,
			sourceUrl: primaryUrl,
			sources: sources.length > 0 ? sources : undefined,
		};
	} catch (e) {
		console.error(
			"Failed to parse verification response:",
			e,
			"\nRaw text:",
			text,
		);
		return {
			footnoteId,
			verdict: "source_unavailable",
			confidence: 0,
			explanation: `Failed to parse verification response${text.trim() ? `: ${text.trim().slice(0, 200)}` : ""}`,
			sourceAccessed: false,
		};
	}
}

/**
 * Verify a single footnote using Gemini with tool use
 */
export async function verifyFootnote(
	apiKey: string,
	linkupApiKey: string | undefined,
	footnoteId: string,
	claim: string,
	citation: string,
	footnoteNumber: number | string,
	context?: VerificationContext,
): Promise<Verification> {
	// Set context for tool calls
	currentContext = context || null;
	currentLinkupApiKey = linkupApiKey || null;
	const footnoteStartedAt = Date.now();

	const genai = new GoogleGenAI({ apiKey });
	const prompt = buildVerificationUserPrompt(footnoteNumber, claim, citation);

	// Track tool calls for the trace
	const trace: ToolCall[] = [];

	try {
		// Create a chat session with tools
		let chat = genai.chats.create({
			model: MODEL_NAME,
			config: {
				tools,
				responseMimeType: "application/json",
				responseSchema: verificationResponseSchema,
				temperature: 0.2,
				systemInstruction: VERIFICATION_SYSTEM_PROMPT,
			},
		});
		let cachedChat: typeof chat | null = null;

		// Send initial message
		const firstCallStartedAt = Date.now();
		let response = await chat.sendMessage({ message: prompt });
		console.log(
			`[verify] model initial response for ${footnoteId} in ${Date.now() - firstCallStartedAt}ms`,
		);

		// Agentic loop - handle tool calls
		// Increased max iterations to allow more thorough investigation
		let iterations = 0;
		const maxIterations = 4;
		let functionCalls = getFunctionCalls(response);

		while (functionCalls.length > 0) {
			if (iterations >= maxIterations) {
				console.log(
					`Max iterations (${maxIterations}) reached for footnote ${footnoteId}`,
				);
				break;
			}

			if (!cachedChat) {
				const cachedContent = await getVerificationCacheName(apiKey);
				const responseContent = getResponseContent(response);
				if (cachedContent && responseContent?.parts?.length) {
					cachedChat = genai.chats.create({
						model: MODEL_NAME,
						config: {
							tools,
							responseMimeType: "application/json",
							responseSchema: verificationResponseSchema,
							temperature: 0.2,
							cachedContent,
						},
						history: [
							{
								role: "user",
								parts: [{ text: prompt }],
							},
							{
								role: responseContent.role ?? "model",
								parts: responseContent.parts as unknown as Array<
									Record<string, unknown>
								>,
							},
						],
					});
					chat = cachedChat;
				}
			}

			const responseParts = await Promise.all(
				functionCalls.map(async (call) => {
					const toolName = call.name || "unknown";
					const toolId = call.id || call.name || crypto.randomUUID();
					const input = call.args as Record<string, unknown>;
					const toolStartedAt = Date.now();
					const output = await handleToolCall(toolName, input);
					const toolDurationMs = Date.now() - toolStartedAt;
					const outputWithTiming = `${output}\n\n[tool_timing] ${toolDurationMs}ms`;

					// Record the tool call in the trace
					trace.push({
						tool: toolName,
						input,
						output:
							outputWithTiming.length > 2000
								? `${outputWithTiming.slice(0, 2000)}...`
								: outputWithTiming,
					});

					return createPartFromFunctionResponse(toolId, toolName, {
						result: outputWithTiming,
					});
				}),
			);

			const followupStartedAt = Date.now();
			response = await chat.sendMessage({ message: responseParts });
			console.log(
				`[verify] model follow-up response for ${footnoteId} in ${Date.now() - followupStartedAt}ms`,
			);
			functionCalls = getFunctionCalls(response);
			iterations++;
		}

		// Parse final response
		let text = getResponseText(response) || "";
		if (!text.trim()) {
			const pendingCalls = getFunctionCalls(response);
			if (pendingCalls.length > 0) {
				const toolOutputs = await Promise.all(
					pendingCalls.map(async (call) => {
						const toolName = call.name || "unknown";
						const _toolId = call.id || call.name || crypto.randomUUID();
						const input = call.args as Record<string, unknown>;
						const toolStartedAt = Date.now();
						const output = await handleToolCall(toolName, input);
						const toolDurationMs = Date.now() - toolStartedAt;
						const outputWithTiming = `${output}\n\n[tool_timing] ${toolDurationMs}ms`;

						trace.push({
							tool: toolName,
							input,
							output:
								outputWithTiming.length > 2000
									? `${outputWithTiming.slice(0, 2000)}...`
									: outputWithTiming,
						});

						return `Tool: ${toolName}\nInput: ${JSON.stringify(input)}\nOutput: ${outputWithTiming}`;
					}),
				);

				const fallbackPrompt = `${prompt}\n\nTOOL OUTPUTS:\n${toolOutputs.join(
					"\n\n---\n\n",
				)}\n\nReturn ONLY the JSON response. Do not call any tools.`;

				const fallbackStartedAt = Date.now();
				const cachedContent = await getVerificationCacheName(apiKey);
				const fallbackResponse = await genai.models.generateContent({
					model: MODEL_NAME,
					contents: fallbackPrompt,
					config: {
						responseMimeType: "application/json",
						responseSchema: verificationResponseSchema,
						temperature: 0.2,
						...(cachedContent
							? { cachedContent }
							: { systemInstruction: VERIFICATION_SYSTEM_PROMPT }),
					},
				});
				console.log(
					`[verify] model fallback response for ${footnoteId} in ${Date.now() - fallbackStartedAt}ms`,
				);

				text = getResponseText(fallbackResponse) || "";
			}
		}
		if (!text.trim()) {
			const responseAny = response as unknown as {
				candidates?: Array<{
					content?: { parts?: Array<Record<string, unknown>> };
				}>;
			};
			const partKeys =
				responseAny.candidates?.[0]?.content?.parts?.map((part) =>
					Object.keys(part),
				) ?? [];
			const firstCall = responseAny.candidates?.[0]?.content?.parts?.find(
				(part) => typeof part.functionCall === "object",
			) as { functionCall?: { name?: string; args?: unknown } } | undefined;
			const callSummary = firstCall?.functionCall
				? `; functionCall: ${JSON.stringify({
						name: firstCall.functionCall.name,
						args: firstCall.functionCall.args,
					}).slice(0, 200)}`
				: "";

			return {
				footnoteId,
				verdict: "source_unavailable",
				confidence: 0,
				explanation: `Empty response from model${partKeys.length ? ` (parts: ${JSON.stringify(partKeys)})` : ""}${callSummary}`,
				sourceAccessed: false,
				trace,
			};
		}

		const verification = parseVerificationResponse(text, footnoteId);
		verification.trace = trace;
		console.log(
			`[verify] footnote ${footnoteId} done in ${Date.now() - footnoteStartedAt}ms`,
		);
		return verification;
	} catch (error) {
		console.error("Verification error for footnote", footnoteId, error);
		console.log(
			`[verify] footnote ${footnoteId} failed in ${Date.now() - footnoteStartedAt}ms`,
		);
		return {
			footnoteId,
			verdict: "source_unavailable",
			confidence: 0,
			explanation: `Verification error: ${error instanceof Error ? error.message : "Unknown error"}`,
			sourceAccessed: false,
			trace,
		};
	} finally {
		currentContext = null;
		currentLinkupApiKey = null;
	}
}

function getResponseText(response: { text?: string; data?: string }): string {
	if (typeof response.text === "string" && response.text.trim().length > 0) {
		return response.text;
	}

	if (typeof response.data === "string" && response.data.length > 0) {
		try {
			return Buffer.from(response.data, "base64").toString("utf-8");
		} catch {
			return response.data;
		}
	}

	return "";
}

function getResponseContent(
	response: unknown,
): { role?: string; parts?: Array<unknown> } | null {
	const responseAny = response as {
		candidates?: Array<{
			content?: {
				role?: string;
				parts?: Array<unknown>;
			};
		}>;
	};

	return responseAny.candidates?.[0]?.content ?? null;
}

function getFunctionCalls(response: {
	functionCalls?: Array<{
		id?: string;
		name?: string;
		args?: Record<string, unknown>;
	}>;
	candidates?: Array<{
		content?: { parts?: Array<{ functionCall?: unknown }> };
	}>;
}): Array<{ id?: string; name?: string; args?: Record<string, unknown> }> {
	if (response.functionCalls && response.functionCalls.length > 0) {
		return response.functionCalls;
	}

	const parts = response.candidates?.[0]?.content?.parts ?? [];
	const calls = parts
		.map((part) => part.functionCall)
		.filter(Boolean) as Array<{
		id?: string;
		name?: string;
		args?: Record<string, unknown>;
	}>;

	return calls || [];
}

/**
 * Verify all footnotes in a document
 */
export async function verifyAllFootnotes(
	apiKey: string,
	linkupApiKey: string | undefined,
	footnotes: Array<{
		id: string;
		index: number;
		displayIndex?: string;
		order?: number;
		claim: string;
		citation: string;
	}>,
	options?: {
		timeoutMs?: number;
		onProgress?: (verifications: Verification[]) => Promise<void> | void;
	},
): Promise<Verification[]> {
	const timeoutMs = options?.timeoutMs ?? 60000;

	// Sort footnotes by document order to ensure proper ordering for cross-references
	const sortedFootnotes = [...footnotes].sort((a, b) => {
		const orderA = a.order ?? a.index;
		const orderB = b.order ?? b.index;
		return orderA - orderB;
	});

	// Build full footnote list for context
	const allFootnotes: Footnote[] = sortedFootnotes.map((f) => ({
		id: f.id,
		documentId: "", // Not needed for context
		index: f.index,
		displayIndex: f.displayIndex,
		order: f.order,
		claim: f.claim,
		citation: f.citation,
	}));

	const results: Array<Verification | undefined> = new Array(
		sortedFootnotes.length,
	);
	const concurrencyLimit = 5;
	let nextIndex = 0;
	let active = 0;
	let progressChain = Promise.resolve();

	return await new Promise<Verification[]>((resolve) => {
		const runNext = () => {
			while (active < concurrencyLimit && nextIndex < sortedFootnotes.length) {
				const current = nextIndex++;
				const footnote = sortedFootnotes[current];
				active += 1;

				const context: VerificationContext = {
					allFootnotes,
					currentIndex: current,
				};

				(async () => {
					try {
						const verification = await withTimeout(
							verifyFootnote(
								apiKey,
								linkupApiKey,
								footnote.id,
								footnote.claim,
								footnote.citation,
								footnote.displayIndex ?? footnote.index,
								context,
							),
							timeoutMs,
							`Verification timed out after ${timeoutMs}ms`,
						);
						results[current] = verification;
					} catch (error) {
						if (error instanceof Error && error.message.includes("timed out")) {
							try {
								const fallback = await withTimeout(
									quickVerifyFootnote(
										apiKey,
										linkupApiKey,
										footnote.id,
										footnote.claim,
										footnote.citation,
										footnote.displayIndex ?? footnote.index,
									),
									15000,
									"Quick verification timed out after 15000ms",
								);
								results[current] = fallback;
							} catch (fallbackError) {
								results[current] = {
									footnoteId: footnote.id,
									verdict: "source_unavailable",
									confidence: 0,
									explanation: `Verification error: ${fallbackError instanceof Error ? fallbackError.message : "Unknown error"}`,
									sourceAccessed: false,
								};
							}
						} else {
							results[current] = {
								footnoteId: footnote.id,
								verdict: "source_unavailable",
								confidence: 0,
								explanation: `Verification error: ${error instanceof Error ? error.message : "Unknown error"}`,
								sourceAccessed: false,
							};
						}
					}

					if (options?.onProgress) {
						const snapshot = results.filter(
							Boolean as unknown as (
								value: Verification | undefined,
							) => value is Verification,
						);
						progressChain = progressChain
							.then(() => options.onProgress?.(snapshot))
							.catch(() => undefined);
					}
				})()
					.catch(() => undefined)
					.finally(() => {
						active -= 1;
						if (nextIndex >= sortedFootnotes.length && active === 0) {
							resolve(
								results.filter(
									Boolean as unknown as (
										value: Verification | undefined,
									) => value is Verification,
								),
							);
							return;
						}
						runNext();
					});
			}
		};

		runNext();
	});
}

async function quickVerifyFootnote(
	apiKey: string,
	linkupApiKey: string | undefined,
	footnoteId: string,
	claim: string,
	citation: string,
	footnoteNumber: number | string,
): Promise<Verification> {
	const genai = new GoogleGenAI({ apiKey });
	const prompt = buildVerificationUserPrompt(
		footnoteNumber,
		claim,
		citation,
		"Do not call any tools. Base your answer on the citation text itself.",
	);
	currentLinkupApiKey = linkupApiKey || null;
	try {
		const response = await genai.models.generateContent({
			model: MODEL_NAME,
			contents: prompt,
			config: {
				responseMimeType: "application/json",
				responseSchema: verificationResponseSchema,
				temperature: 0.2,
				systemInstruction: VERIFICATION_SYSTEM_PROMPT,
			},
		});

		const text = getResponseText(response) || "";
		if (!text.trim()) {
			return {
				footnoteId,
				verdict: "source_unavailable",
				confidence: 0,
				explanation: "Quick verification returned empty response",
				sourceAccessed: false,
			};
		}

		return parseVerificationResponse(text, footnoteId);
	} finally {
		currentLinkupApiKey = null;
	}
}

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	timeoutMessage: string,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(timeoutMessage));
		}, timeoutMs);

		promise
			.then((value) => {
				clearTimeout(timer);
				resolve(value);
			})
			.catch((error) => {
				clearTimeout(timer);
				reject(error);
			});
	});
}
