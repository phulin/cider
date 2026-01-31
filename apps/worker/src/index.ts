import type {
	Document,
	Footnote,
	UploadResponse,
	Verification,
} from "@cider/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { parseDocx } from "./docx";
import { ProgressDurableObject, type ProgressUpdate } from "./progress";
import type { Env } from "./types";
import { verifyAllFootnotes } from "./verify";

const app = new Hono<{ Bindings: Env }>();

// Enable CORS for frontend
app.use(
	"/api/*",
	cors({
		origin: ["http://localhost:3000", "https://cider.pages.dev"],
		allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type"],
	}),
);

// Health check
app.get("/", (c) => c.json({ status: "ok", service: "cider-api" }));

// WebSocket stream for document progress
app.get("/api/documents/:id/stream", (c) => {
	const id = c.req.param("id");
	const durableId = c.env.PROGRESS_DO.idFromName(id);
	const stub = c.env.PROGRESS_DO.get(durableId);
	return stub.fetch(c.req.raw);
});

// Upload document
app.post("/api/documents", async (c) => {
	const formData = await c.req.formData();
	const fileEntry = formData.get("document");

	if (!fileEntry || typeof fileEntry === "string") {
		return c.json({ error: "No document provided" }, 400);
	}

	const file = fileEntry as File;

	if (!file.name.endsWith(".docx")) {
		return c.json({ error: "Only .docx files are supported" }, 400);
	}

	// Generate document ID
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	try {
		// Store original file in R2
		const buffer = await file.arrayBuffer();
		await c.env.BUCKET.put(`documents/${id}/original.docx`, buffer);

		// Parse document
		const parsed = await parseDocx(buffer);

		// Create document metadata
		const document: Document = {
			id,
			filename: file.name,
			uploadedAt: now,
			status: "processing",
			footnoteCount: parsed.footnotes.length,
		};

		// Create footnotes with IDs
		const footnotes: Footnote[] = parsed.footnotes.map((fn, idx) => ({
			id: `${id}-fn-${idx + 1}`,
			documentId: id,
			index: fn.index,
			displayIndex: fn.displayIndex,
			order: fn.order,
			claim: fn.claim,
			citation: fn.citation,
		}));

		// Store parsed data
		await c.env.BUCKET.put(
			`documents/${id}/parsed.json`,
			JSON.stringify({ document, footnotes }),
		);

		// Start verification in background using waitUntil
		c.executionCtx.waitUntil(processDocument(c.env, id, document, footnotes));

		const response: UploadResponse = { id, status: "processing" };
		return c.json(response, 201);
	} catch (error) {
		console.error("Upload error:", error);
		return c.json(
			{ error: error instanceof Error ? error.message : "Upload failed" },
			500,
		);
	}
});

// Get document status and results
app.get("/api/documents/:id", async (c) => {
	const id = c.req.param("id");

	try {
		// Try to get results first
		const resultsObj = await c.env.BUCKET.get(`documents/${id}/results.json`);
		if (resultsObj) {
			const results = (await resultsObj.json()) as {
				document: Document;
				footnotes: Footnote[];
				verifications: Verification[];
			};
			return c.json(results);
		}

		// Fall back to parsed data (still processing)
		const parsedObj = await c.env.BUCKET.get(`documents/${id}/parsed.json`);
		if (parsedObj) {
			const parsed = (await parsedObj.json()) as {
				document: Document;
				footnotes: Footnote[];
			};
			return c.json({
				document: parsed.document,
				footnotes: parsed.footnotes,
				verifications: [],
			});
		}

		return c.json({ error: "Document not found" }, 404);
	} catch (error) {
		console.error("Get document error:", error);
		return c.json({ error: "Failed to retrieve document" }, 500);
	}
});

// Delete document
app.delete("/api/documents/:id", async (c) => {
	const id = c.req.param("id");

	try {
		// List and delete all objects for this document
		const objects = await c.env.BUCKET.list({ prefix: `documents/${id}/` });

		for (const obj of objects.objects) {
			await c.env.BUCKET.delete(obj.key);
		}

		return c.json({ deleted: true });
	} catch (error) {
		console.error("Delete error:", error);
		return c.json({ error: "Failed to delete document" }, 500);
	}
});

/**
 * Process document verification in background
 */
async function processDocument(
	env: Env,
	id: string,
	document: Document,
	footnotes: Footnote[],
): Promise<void> {
	try {
		const writeResults = async (
			status: Document["status"],
			verifications: Verification[],
			error?: string,
		) => {
			const updatedDocument: Document = {
				...document,
				status,
				...(error ? { error } : {}),
			};

			const payload: ProgressUpdate = {
				status,
				footnoteCount: footnotes.length,
				verifications,
				error,
			};

			await Promise.all([
				env.BUCKET.put(
					`documents/${id}/results.json`,
					JSON.stringify({
						document: updatedDocument,
						footnotes,
						verifications,
					}),
				),
				notifyProgress(env, id, payload),
			]);
		};

		if (!env.GEMINI_API_KEY) {
			await writeResults("failed", [], "GEMINI_API_KEY is not set");
			return;
		}
		if (!env.LINKUP_API_KEY) {
			console.log(
				"[verify] LINKUP_API_KEY is not set; web_search tool will be unavailable.",
			);
		}

		// Write initial processing state so the UI can show progress.
		await writeResults("processing", []);

		// Verify all footnotes
		const verifications = await verifyAllFootnotes(
			env.GEMINI_API_KEY,
			env.LINKUP_API_KEY,
			footnotes.map((fn) => ({
				id: fn.id,
				index: fn.index,
				displayIndex: fn.displayIndex,
				order: fn.order,
				claim: fn.claim,
				citation: fn.citation,
			})),
			{
				timeoutMs: 60000,
				onProgress: async (current) => {
					await writeResults("processing", current);
				},
			},
		);

		await writeResults("complete", verifications);
	} catch (error) {
		console.error("Processing error:", error);

		const errorDocument: Document = {
			...document,
			status: "failed",
			error: error instanceof Error ? error.message : "Processing failed",
		};

		const payload: ProgressUpdate = {
			status: "failed",
			footnoteCount: footnotes.length,
			verifications: [],
			error: errorDocument.error,
		};

		await Promise.all([
			env.BUCKET.put(
				`documents/${id}/results.json`,
				JSON.stringify({
					document: errorDocument,
					footnotes,
					verifications: [],
				}),
			),
			notifyProgress(env, id, payload),
		]);
	}
}

export default app;
export { ProgressDurableObject };

async function notifyProgress(
	env: Env,
	id: string,
	payload: ProgressUpdate,
): Promise<void> {
	const durableId = env.PROGRESS_DO.idFromName(id);
	const stub = env.PROGRESS_DO.get(durableId);

	try {
		await stub.fetch("https://progress/progress", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
	} catch (error) {
		console.warn("[progress] Failed to notify durable object:", error);
	}
}
