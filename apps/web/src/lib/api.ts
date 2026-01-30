import type {
	Document,
	Footnote,
	UploadResponse,
	Verification,
} from "@cider/shared";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8787";

export interface DocumentResult {
	document: Document;
	footnotes: Footnote[];
	verifications: Verification[];
}

export async function uploadDocument(file: File): Promise<UploadResponse> {
	const formData = new FormData();
	formData.append("document", file);

	const response = await fetch(`${API_BASE}/api/documents`, {
		method: "POST",
		body: formData,
	});

	if (!response.ok) {
		const error = await response.json();
		throw new Error(error.error || "Upload failed");
	}

	return response.json();
}

export async function getDocument(id: string): Promise<DocumentResult> {
	const response = await fetch(`${API_BASE}/api/documents/${id}`);

	if (!response.ok) {
		if (response.status === 404) {
			throw new Error("Document not found");
		}
		throw new Error("Failed to fetch document");
	}

	return response.json();
}

export async function deleteDocument(id: string): Promise<void> {
	const response = await fetch(`${API_BASE}/api/documents/${id}`, {
		method: "DELETE",
	});

	if (!response.ok) {
		throw new Error("Failed to delete document");
	}
}
