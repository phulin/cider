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

export async function uploadDocument(
	file: File,
	onProgress?: (percent: number) => void,
): Promise<UploadResponse> {
	const formData = new FormData();
	formData.append("document", file);

	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("POST", `${API_BASE}/api/documents`);
		xhr.responseType = "json";

		xhr.upload.onprogress = (event) => {
			if (!event.lengthComputable || !onProgress) return;
			const percent = Math.round((event.loaded / event.total) * 100);
			onProgress(Math.min(100, Math.max(0, percent)));
		};

		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				resolve(xhr.response as UploadResponse);
				return;
			}
			const errorMessage =
				(xhr.response && (xhr.response as { error?: string }).error) ||
				"Upload failed";
			reject(new Error(errorMessage));
		};

		xhr.onerror = () => {
			reject(new Error("Upload failed"));
		};

		xhr.send(formData);
	});
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

export function documentStreamUrl(id: string): string {
	const url = new URL(API_BASE);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return `${url.toString().replace(/\/$/, "")}/api/documents/${id}/stream`;
}
