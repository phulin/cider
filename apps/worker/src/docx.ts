import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

export interface ParsedFootnote {
	index: number;
	displayIndex: string;
	order: number;
	claim: string;
	citation: string;
}

export interface ParsedDocument {
	footnotes: ParsedFootnote[];
}

const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	textNodeName: "#text",
	trimValues: false,
	processEntities: true,
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
	if (!value) {
		return [];
	}
	return Array.isArray(value) ? value : [value];
}

function findFirstNode(obj: unknown, key: string): unknown | undefined {
	if (!obj || typeof obj !== "object") {
		return undefined;
	}

	if (Object.hasOwn(obj, key)) {
		return (obj as Record<string, unknown>)[key];
	}

	for (const value of Object.values(obj as Record<string, unknown>)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				const found = findFirstNode(item, key);
				if (found !== undefined) {
					return found;
				}
			}
		} else if (value && typeof value === "object") {
			const found = findFirstNode(value, key);
			if (found !== undefined) {
				return found;
			}
		}
	}

	return undefined;
}

/**
 * Extract all text content from a parsed XML node
 */
function decodeXmlEntities(text: string): string {
	if (!text.includes("&")) {
		return text;
	}

	return text.replace(
		/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
		(match, entity: string) => {
			switch (entity) {
				case "amp":
					return "&";
				case "lt":
					return "<";
				case "gt":
					return ">";
				case "quot":
					return '"';
				case "apos":
					return "'";
				default: {
					if (entity.startsWith("#x")) {
						const codePoint = Number.parseInt(entity.slice(2), 16);
						return Number.isNaN(codePoint)
							? match
							: String.fromCodePoint(codePoint);
					}
					if (entity.startsWith("#")) {
						const codePoint = Number.parseInt(entity.slice(1), 10);
						return Number.isNaN(codePoint)
							? match
							: String.fromCodePoint(codePoint);
					}
					return match;
				}
			}
		},
	);
}

function extractTextFromNode(node: unknown): string {
	if (node === null || node === undefined) {
		return "";
	}

	if (typeof node === "string") {
		return decodeXmlEntities(node);
	}

	if (typeof node === "number") {
		return String(node);
	}

	if (Array.isArray(node)) {
		return node.map((entry) => extractTextFromNode(entry)).join("");
	}

	if (typeof node !== "object") {
		return "";
	}

	const record = node as Record<string, unknown>;
	if (record["w:t"] !== undefined) {
		return extractTextFromNode(record["w:t"]);
	}

	if (typeof record["#text"] === "string") {
		return decodeXmlEntities(record["#text"]);
	}

	let result = "";
	for (const [key, value] of Object.entries(record)) {
		if (key.startsWith("@_")) {
			continue;
		}
		// Ignore field instructions like NOTEREF ... \h \* MERGEFORMAT.
		if (key === "w:instrText" || key === "w:fldChar") {
			continue;
		}
		if (key === "w:footnoteRef") {
			continue;
		}
		if (key === "w:tab") {
			result += "\t";
			continue;
		}
		if (key === "w:br" || key === "w:cr") {
			result += "\n";
			continue;
		}
		result += extractTextFromNode(value);
	}
	return result;
}

function extractParagraphText(paragraph: Record<string, unknown>): string {
	if (paragraph["w:t"] !== undefined) {
		return extractTextFromNode(paragraph["w:t"]);
	}
	return extractTextFromNode(paragraph);
}

type ParagraphFootnoteRef = {
	id: string;
	customMark?: string;
	marker: string;
};

function extractParagraphTextWithFootnoteMarkers(
	paragraph: Record<string, unknown>,
): { text: string; refs: ParagraphFootnoteRef[] } {
	const runs = asArray(paragraph["w:r"]);
	if (runs.length === 0) {
		return { text: extractParagraphText(paragraph), refs: [] };
	}

	let text = "";
	const refs: ParagraphFootnoteRef[] = [];
	const markerCounts = new Map<string, number>();

	for (const run of runs) {
		if (!run || typeof run !== "object") {
			continue;
		}
		const runRecord = run as Record<string, unknown>;
		const runText = extractTextFromNode(runRecord["w:t"]);
		if (runText) {
			text += runText;
		}

		const refNodes = asArray(runRecord["w:footnoteReference"]);
		if (refNodes.length === 0) {
			continue;
		}

		for (const refNode of refNodes) {
			if (!refNode || typeof refNode !== "object") {
				continue;
			}
			const refRecord = refNode as Record<string, unknown>;
			const footnoteId = refRecord["@_w:id"];
			if (typeof footnoteId !== "string") {
				continue;
			}
			const hasCustomMark = refRecord["@_w:customMarkFollows"] === "1";
			const runTextTrim = runText.trim();
			const markerIndex = (markerCounts.get(footnoteId) ?? 0) + 1;
			markerCounts.set(footnoteId, markerIndex);
			const marker = `[[FN_${footnoteId}_${markerIndex}]]`;

			refs.push({
				id: footnoteId,
				customMark: hasCustomMark ? runTextTrim || undefined : undefined,
				marker,
			});

			text += marker;
		}
	}

	return { text, refs };
}

function applyFootnoteMarker(
	text: string,
	refs: ParagraphFootnoteRef[],
	targetMarker: string,
	displayIndex: string,
): string {
	let updated = text;
	for (const ref of refs) {
		if (ref.marker === targetMarker) {
			updated = updated.split(ref.marker).join(`[${displayIndex}]`);
		} else {
			updated = updated.split(ref.marker).join("");
		}
	}
	return updated;
}

/**
 * Extract footnote contents from footnotes.xml
 */
function extractFootnoteContents(footnotesXml: string): Map<string, string> {
	const map = new Map<string, string>();
	const parsed = xmlParser.parse(footnotesXml);
	const footnotesNode = findFirstNode(parsed, "w:footnotes");
	const footnotes = asArray(
		footnotesNode && typeof footnotesNode === "object"
			? (footnotesNode as Record<string, unknown>)["w:footnote"]
			: undefined,
	);

	for (const footnote of footnotes) {
		if (!footnote || typeof footnote !== "object") {
			continue;
		}
		const footnoteRecord = footnote as Record<string, unknown>;
		const id = footnoteRecord["@_w:id"];

		// Skip separator footnotes (id 0 and -1)
		if (typeof id === "string" && id !== "0" && id !== "-1") {
			const text = extractTextFromNode(footnoteRecord).trim();
			if (text) {
				map.set(id, text);
			}
		}
	}

	return map;
}

/**
 * Extract footnotes with their context from document.xml using regex
 */
function extractFootnotesWithContext(
	documentXml: string,
	footnoteContents: Map<string, string>,
): ParsedFootnote[] {
	const results: ParsedFootnote[] = [];
	let numericIndex = 1;
	let orderIndex = 1;
	const parsed = xmlParser.parse(documentXml);
	const bodyNode = findFirstNode(parsed, "w:body");
	const paragraphs = asArray(
		bodyNode && typeof bodyNode === "object"
			? (bodyNode as Record<string, unknown>)["w:p"]
			: undefined,
	);

	for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
		const para = paragraphs[pIdx];
		if (!para || typeof para !== "object") {
			continue;
		}
		const paraRecord = para as Record<string, unknown>;
		const { text: paraTextWithMarkers, refs } =
			extractParagraphTextWithFootnoteMarkers(paraRecord);
		const paraText = paraTextWithMarkers;

		for (const ref of refs) {
			const footnoteId = ref.id;

			if (footnoteContents.has(footnoteId)) {
				// Use the paragraph text as context, or get surrounding paragraphs
				let claim = paraText.trim();

				// If paragraph is too short, include adjacent paragraphs
				if (claim.length < 20 && pIdx > 0) {
					const prevPara = paragraphs[pIdx - 1];
					const prevText =
						prevPara && typeof prevPara === "object"
							? extractParagraphText(prevPara as Record<string, unknown>)
							: "";
					claim = `${prevText.trim()} ${claim}`;
				}

				// Truncate if too long
				if (claim.length > 500) {
					claim = `${claim.slice(0, 500)}...`;
				}

				const citation = footnoteContents.get(footnoteId);
				if (!citation) {
					continue;
				}

				const isCustomMark = Boolean(ref.customMark);
				const displayIndex = isCustomMark
					? ref.customMark || "?"
					: String(numericIndex);
				const claimWithRef = applyFootnoteMarker(
					claim,
					refs,
					ref.marker,
					displayIndex,
				);
				const finalClaim = claimWithRef.trim() || "(No context found)";
				const index = isCustomMark ? 0 : numericIndex;

				results.push({
					index,
					displayIndex,
					order: orderIndex,
					claim: finalClaim,
					citation,
				});

				orderIndex += 1;
				if (!isCustomMark) {
					numericIndex += 1;
				}
			}
		}
	}

	return results;
}

/**
 * Parse a .docx file and extract footnotes with their context
 */
export async function parseDocx(buffer: ArrayBuffer): Promise<ParsedDocument> {
	const zip = await JSZip.loadAsync(buffer);

	const documentXmlStr = await zip.file("word/document.xml")?.async("string");
	const footnotesXmlStr = await zip.file("word/footnotes.xml")?.async("string");

	if (!documentXmlStr) {
		throw new Error("Invalid .docx file: missing document.xml");
	}

	if (!footnotesXmlStr) {
		// No footnotes in document
		return { footnotes: [] };
	}

	const footnoteContents = extractFootnoteContents(footnotesXmlStr);
	const footnotes = extractFootnotesWithContext(
		documentXmlStr,
		footnoteContents,
	);

	return { footnotes };
}
