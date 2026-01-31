export interface Document {
	id: string;
	filename: string;
	uploadedAt: string;
	status: "processing" | "complete" | "failed";
	footnoteCount: number;
	error?: string;
}

export interface Footnote {
	id: string;
	documentId: string;
	index: number;
	displayIndex?: string;
	order?: number;
	claim: string;
	citation: string;
}

export type Verdict =
	| "supports"
	| "partially_supports"
	| "does_not_support"
	| "contradicts"
	| "source_unavailable";

export interface SourceResult {
	url?: string;
	title?: string;
	accessed: boolean;
	verdict: Verdict;
	explanation: string;
}

export interface ToolCall {
	tool: string;
	input: Record<string, unknown>;
	output: string;
}

export interface Verification {
	footnoteId: string;
	verdict: Verdict;
	confidence: number;
	explanation: string;
	sourceAccessed: boolean;
	sourceUrl?: string;
	sources?: SourceResult[];
	trace?: ToolCall[];
}

export interface DocumentResult {
	document: Document;
	footnotes: Footnote[];
	verifications: Verification[];
}

export interface UploadResponse {
	id: string;
	status: "processing";
}

export interface DocumentStatusResponse {
	document: Document;
	footnotes?: Footnote[];
	verifications?: Verification[];
}
