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

// Context for the current document - passed to verification functions
interface VerificationContext {
	allFootnotes: Footnote[];
	currentIndex: number;
}

const VERIFICATION_PROMPT = `You are an expert citation verification assistant. Your job is to rigorously verify that cited sources actually support the claims they're attached to.

CURRENT FOOTNOTE NUMBER: {footnote_number}

CLAIM (from the document):
{claim}

CITATION (footnote text):
{citation}

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
      "url": "URL if found, or null",
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

// Store context for the current verification session
let currentContext: VerificationContext | null = null;

/**
 * Perform a web search using DuckDuckGo + Google fallback
 */
async function performWebSearch(query: string): Promise<string> {
	try {
		// Try DuckDuckGo instant answer API first
		const encoded = encodeURIComponent(query);
		const response = await fetch(
			`https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1`,
		);

		if (!response.ok) {
			return `Search failed with status ${response.status}. Try a different search query.`;
		}

		const data = (await response.json()) as {
			Abstract?: string;
			AbstractURL?: string;
			AbstractSource?: string;
			RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
			Results?: Array<{ Text?: string; FirstURL?: string }>;
		};

		const results: string[] = [];

		if (data.Abstract) {
			results.push(`**${data.AbstractSource || "Result"}**: ${data.Abstract}`);
			if (data.AbstractURL) {
				results.push(`URL: ${data.AbstractURL}`);
			}
		}

		if (data.Results && data.Results.length > 0) {
			results.push("\n**Direct Results:**");
			data.Results.slice(0, 5).forEach((r, i) => {
				results.push(`${i + 1}. ${r.Text || ""}\n   ${r.FirstURL || ""}`);
			});
		}

		if (data.RelatedTopics && data.RelatedTopics.length > 0) {
			results.push("\n**Related:**");
			data.RelatedTopics.slice(0, 5).forEach((t, i) => {
				if (t.Text) {
					results.push(`${i + 1}. ${t.Text}\n   ${t.FirstURL || ""}`);
				}
			});
		}

		if (results.length === 0) {
			return `No results found for "${query}". Try:\n- Different keywords\n- Author names + title\n- Removing special characters\n- Searching for the publication name`;
		}

		return results.join("\n");
	} catch (error) {
		return `Search error: ${error instanceof Error ? error.message : "Unknown error"}. Try a simpler query.`;
	}
}

/**
 * Fetch a URL and extract its text content
 */
async function fetchAndExtractText(url: string): Promise<string> {
	try {
		// Clean up URL if needed
		let cleanUrl = url.trim();
		if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
			cleanUrl = `https://${cleanUrl}`;
		}

		const response = await fetch(cleanUrl, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
			},
			redirect: "follow",
		});

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
			return "PDF detected. Unable to extract text from PDFs directly. Try searching for an HTML version or the article abstract.";
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
		return `Error fetching URL: ${message}. Try searching for this source using web_search.`;
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
			return `**Footnote ${footnote.index}**:\nClaim: ${footnote.claim}\nCitation: ${footnote.citation}`;
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
		.map(
			(f) =>
				`**Footnote ${f.index}**:\nClaim: ${f.claim}\nCitation: ${f.citation}`,
		)
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
			explanation: "Failed to parse verification response",
			sourceAccessed: false,
		};
	}
}

/**
 * Verify a single footnote using Gemini with tool use
 */
export async function verifyFootnote(
	apiKey: string,
	footnoteId: string,
	claim: string,
	citation: string,
	footnoteNumber: number,
	context?: VerificationContext,
): Promise<Verification> {
	// Set context for tool calls
	currentContext = context || null;

	const genai = new GoogleGenAI({ apiKey });

	const prompt = VERIFICATION_PROMPT.replace(
		"{footnote_number}",
		String(footnoteNumber),
	)
		.replace("{claim}", claim)
		.replace("{citation}", citation);

	// Track tool calls for the trace
	const trace: ToolCall[] = [];

	try {
		// Create a chat session with tools
		const chat = genai.chats.create({
			model: "gemini-3-flash-preview",
			config: { tools },
		});

		// Send initial message
		let response = await chat.sendMessage({ message: prompt });

		// Agentic loop - handle tool calls
		// Increased max iterations to allow more thorough investigation
		let iterations = 0;
		const maxIterations = 10;

		while (response.functionCalls && response.functionCalls.length > 0) {
			if (iterations >= maxIterations) {
				console.log(
					`Max iterations (${maxIterations}) reached for footnote ${footnoteId}`,
				);
				break;
			}

			const responseParts = await Promise.all(
				response.functionCalls.map(async (call) => {
					const toolName = call.name || "unknown";
					const toolId = call.id || crypto.randomUUID();
					const input = call.args as Record<string, unknown>;
					const output = await handleToolCall(toolName, input);

					// Record the tool call in the trace
					trace.push({
						tool: toolName,
						input,
						output:
							output.length > 2000 ? `${output.slice(0, 2000)}...` : output,
					});

					return createPartFromFunctionResponse(toolId, toolName, {
						result: output,
					});
				}),
			);

			response = await chat.sendMessage({ message: responseParts });
			iterations++;
		}

		// Parse final response
		const text = response.text || "";
		const verification = parseVerificationResponse(text, footnoteId);
		verification.trace = trace;
		return verification;
	} catch (error) {
		console.error("Verification error for footnote", footnoteId, error);
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
	}
}

/**
 * Verify all footnotes in a document
 */
export async function verifyAllFootnotes(
	apiKey: string,
	footnotes: Array<{
		id: string;
		index: number;
		claim: string;
		citation: string;
	}>,
): Promise<Verification[]> {
	// Sort footnotes by index to ensure proper ordering for cross-references
	const sortedFootnotes = [...footnotes].sort((a, b) => a.index - b.index);

	// Build full footnote list for context
	const allFootnotes: Footnote[] = sortedFootnotes.map((f) => ({
		id: f.id,
		documentId: "", // Not needed for context
		index: f.index,
		claim: f.claim,
		citation: f.citation,
	}));

	const results: Verification[] = [];

	for (let i = 0; i < sortedFootnotes.length; i++) {
		const footnote = sortedFootnotes[i];

		// Create context with all footnotes and current position
		const context: VerificationContext = {
			allFootnotes,
			currentIndex: i,
		};

		const verification = await verifyFootnote(
			apiKey,
			footnote.id,
			footnote.claim,
			footnote.citation,
			footnote.index,
			context,
		);
		results.push(verification);
	}

	return results;
}
