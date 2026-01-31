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
import { toolDefinitions } from "./verify/tools/definitions";
import { createToolHandler } from "./verify/tools/handlers";
import type { VerificationContext } from "./verify/types";

const MODEL_NAME = "gemini-3-flash-preview";

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
   - get_earlier_footnotes: Retrieve a specific earlier footnote by index for cross-references (must choose the index)

5. **Source fidelity requirements**:
   - Use web_search ONLY to locate original sources; do not use search result summaries or snippets to verify claims.
   - Your goal is to find the precise page or piece of text referenced in the footnote and decide whether it supports the claim.
   - If a footnote has no sources (only explanatory text), return "not_applicable".
   - If you cannot confidently access the original source text, return "source_unavailable".

6. **For each source you find**, determine:
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
      "verdict": "supports" | "partially_supports" | "does_not_support" | "contradicts" | "source_unavailable" | "not_applicable",
      "explanation": "Brief explanation for this specific source"
    }
  ],
  "overall_verdict": "supports" | "partially_supports" | "does_not_support" | "contradicts" | "source_unavailable" | "not_applicable",
  "confidence": 0.0-1.0,
  "explanation": "Overall assessment considering all sources"
}

IMPORTANT:
- If there are multiple sources, the overall_verdict should reflect the WEAKEST support among accessible sources.
- If you cannot access ANY sources, use "source_unavailable".
- Be THOROUGH. Make multiple tool calls. Check multiple sources. Don't give up easily.`;

const VERIFICATION_CACHE_TTL = "3600s";

const tools = toolDefinitions;

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

const handleToolCall = createToolHandler({
	fetchWithTimeout,
	getCurrentContext: () => currentContext,
	getLinkupApiKey: () => currentLinkupApiKey,
});

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
			"not_applicable",
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
							outputWithTiming.length > 10000
								? `${outputWithTiming.slice(0, 10000)}...`
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
