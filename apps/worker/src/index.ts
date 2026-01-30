import type {
	Document,
	Footnote,
	UploadResponse,
	Verification,
} from "@cider/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { parseDocx } from "./docx";
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
		// Verify all footnotes
		const verifications = await verifyAllFootnotes(
			env.GEMINI_API_KEY,
			footnotes.map((fn) => ({
				id: fn.id,
				index: fn.index,
				claim: fn.claim,
				citation: fn.citation,
			})),
		);

		// Update document status
		const updatedDocument: Document = {
			...document,
			status: "complete",
		};

		// Store results
		await env.BUCKET.put(
			`documents/${id}/results.json`,
			JSON.stringify({
				document: updatedDocument,
				footnotes,
				verifications,
			}),
		);
	} catch (error) {
		console.error("Processing error:", error);

		// Store error state
		const errorDocument: Document = {
			...document,
			status: "failed",
			error: error instanceof Error ? error.message : "Processing failed",
		};

		await env.BUCKET.put(
			`documents/${id}/results.json`,
			JSON.stringify({
				document: errorDocument,
				footnotes,
				verifications: [],
			}),
		);
	}
}

export default app;
