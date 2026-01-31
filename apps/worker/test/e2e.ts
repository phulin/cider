/**
 * End-to-end test for the citation checker
 *
 * Usage: npx tsx test/e2e.ts
 *
 * Requires the worker to be running on localhost:8787
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_BASE = process.env.API_URL || "http://localhost:8787";
const DEFAULT_TEST_FILE = resolve(__dirname, "../../../ai-errors-mini.docx");
const TEST_FILE =
	process.env.TEST_FILE ||
	(process.argv[2] ? resolve(process.argv[2]) : DEFAULT_TEST_FILE);

interface Document {
	id: string;
	filename: string;
	status: "processing" | "complete" | "failed";
	footnoteCount: number;
	error?: string;
}

interface Footnote {
	id: string;
	index: number;
	claim: string;
	citation: string;
}

interface Verification {
	footnoteId: string;
	verdict: string;
	confidence: number;
	explanation: string;
	sourceAccessed: boolean;
	sourceUrl?: string;
}

interface DocumentResult {
	document: Document;
	footnotes: Footnote[];
	verifications: Verification[];
}

async function uploadDocument(filePath: string): Promise<string> {
	const fileBuffer = readFileSync(filePath);
	const blob = new Blob([fileBuffer], {
		type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	});

	const formData = new FormData();
	formData.append("document", blob, "adams-black.docx");

	const response = await fetch(`${API_BASE}/api/documents`, {
		method: "POST",
		body: formData,
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Upload failed: ${response.status} ${error}`);
	}

	const result = (await response.json()) as { id: string };
	return result.id;
}

async function pollForResults(
	id: string,
	maxAttempts = Number(process.env.MAX_ATTEMPTS || 120),
	pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 3000),
): Promise<DocumentResult> {
	for (let i = 0; i < maxAttempts; i++) {
		const response = await fetch(`${API_BASE}/api/documents/${id}`);

		if (!response.ok) {
			throw new Error(`Failed to get document: ${response.status}`);
		}

		const result = (await response.json()) as DocumentResult;

		if (result.document.status === "complete") {
			return result;
		}

		if (result.document.status === "failed") {
			throw new Error(`Processing failed: ${result.document.error}`);
		}

		console.log(
			`  Waiting... (${i + 1}/${maxAttempts}) - ${result.verifications.length}/${result.footnotes.length} verified`,
		);
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	throw new Error("Timeout waiting for results");
}

function buildStreamUrl(id: string): string {
	const base = new URL(API_BASE);
	base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
	return `${base.toString().replace(/\/$/, "")}/api/documents/${id}/stream`;
}

async function streamForResults(
	id: string,
	timeoutMs = Number(process.env.WS_TIMEOUT_MS || 10 * 60 * 1000),
): Promise<DocumentResult> {
	const WebSocketImpl = (
		globalThis as unknown as { WebSocket?: typeof WebSocket }
	).WebSocket;
	if (!WebSocketImpl) {
		throw new Error("WebSocket is not available in this runtime");
	}

	return await new Promise<DocumentResult>((resolve, reject) => {
		const ws = new WebSocketImpl(buildStreamUrl(id));
		const timer = setTimeout(() => {
			ws.close();
			reject(new Error("Timeout waiting for WebSocket results"));
		}, timeoutMs);

		ws.addEventListener("message", async (event) => {
			try {
				const payload = JSON.parse(event.data as string) as {
					type: string;
					data?: {
						status: "processing" | "complete" | "failed";
						footnoteCount: number;
						verifications: Verification[];
						error?: string;
					};
				};

				if (payload.type !== "progress" || !payload.data) return;

				console.log(
					`  [ws] ${payload.data.verifications.length}/${payload.data.footnoteCount} verified`,
				);

				if (payload.data.status === "failed") {
					clearTimeout(timer);
					ws.close();
					reject(
						new Error(
							`Processing failed: ${payload.data.error ?? "Unknown error"}`,
						),
					);
					return;
				}

				if (payload.data.status === "complete") {
					clearTimeout(timer);
					ws.close();
					const result = await getDocument(id);
					resolve(result);
				}
			} catch (err) {
				clearTimeout(timer);
				ws.close();
				reject(
					err instanceof Error ? err : new Error("WebSocket message error"),
				);
			}
		});

		ws.addEventListener("error", () => {
			clearTimeout(timer);
			ws.close();
			reject(new Error("WebSocket error"));
		});

		ws.addEventListener("close", () => {
			clearTimeout(timer);
		});
	});
}

function formatVerdict(verdict: string): string {
	const colors: Record<string, string> = {
		supports: "\x1b[32m✓ SUPPORTS\x1b[0m",
		partially_supports: "\x1b[33m◐ PARTIALLY SUPPORTS\x1b[0m",
		does_not_support: "\x1b[31m✗ DOES NOT SUPPORT\x1b[0m",
		contradicts: "\x1b[31m✗✗ CONTRADICTS\x1b[0m",
		source_unavailable: "\x1b[90m? SOURCE UNAVAILABLE\x1b[0m",
	};
	return colors[verdict] || verdict;
}

async function main() {
	console.log("🧪 Citation Checker E2E Test\n");
	console.log(`API: ${API_BASE}`);
	console.log(`Test file: ${TEST_FILE}\n`);

	// Check if worker is running
	try {
		const health = await fetch(`${API_BASE}/`);
		if (!health.ok) throw new Error();
		console.log("✓ Worker is running\n");
	} catch {
		console.error(
			"✗ Worker is not running. Start it with: cd apps/worker && pnpm dev",
		);
		process.exit(1);
	}

	// Upload document
	console.log("📤 Uploading document...");
	const id = await uploadDocument(TEST_FILE);
	console.log(`  Document ID: ${id}\n`);

	// Stream results (WebSocket) with polling fallback
	console.log("⏳ Processing...");
	const useWs = String(process.env.USE_WS || "true").toLowerCase() !== "false";
	const result = useWs
		? await streamForResults(id).catch((err) => {
				console.warn(`  WS failed (${err.message}); falling back to polling.`);
				return pollForResults(id);
			})
		: await pollForResults(id);
	console.log(`\n✓ Processing complete!\n`);

	// Display results
	console.log("═".repeat(60));
	console.log(`📄 ${result.document.filename}`);
	console.log(`   ${result.footnotes.length} footnotes\n`);

	const verificationMap = new Map(
		result.verifications.map((v) => [v.footnoteId, v]),
	);

	// Summary counts
	const counts: Record<string, number> = {};
	for (const v of result.verifications) {
		counts[v.verdict] = (counts[v.verdict] || 0) + 1;
	}

	console.log("Summary:");
	for (const [verdict, count] of Object.entries(counts)) {
		console.log(`  ${formatVerdict(verdict)}: ${count}`);
	}
	console.log();

	// Details
	console.log("─".repeat(60));
	for (const footnote of result.footnotes) {
		const v = verificationMap.get(footnote.id);

		console.log(
			`\n[${footnote.displayIndex ?? footnote.index}] ${v ? formatVerdict(v.verdict) : "PENDING"}`,
		);
		console.log(
			`    Claim: "${footnote.claim.slice(0, 100)}${footnote.claim.length > 100 ? "..." : ""}"`,
		);
		console.log(
			`    Citation: "${footnote.citation.slice(0, 80)}${footnote.citation.length > 80 ? "..." : ""}"`,
		);

		if (v) {
			console.log(`    Confidence: ${Math.round(v.confidence * 100)}%`);
			console.log(`    Explanation: ${v.explanation}`);
			if (v.sourceUrl) {
				console.log(`    Source: ${v.sourceUrl}`);
			}
		}
	}

	console.log(`\n${"═".repeat(60)}`);
	console.log("✅ Test complete!");
}

main().catch((err) => {
	console.error("\n❌ Test failed:", err.message);
	process.exit(1);
});
