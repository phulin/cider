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

/**
 * Extract all text content from an XML element using regex
 * Since linkedom doesn't support getElementsByTagNameNS well for XML
 */
function getTextContent(xmlString: string): string {
	const textMatches = xmlString.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
	return textMatches
		.map((match) => {
			const content = match.match(/>([^<]*)</);
			return content ? content[1] : "";
		})
		.join("");
}

/**
 * Extract footnote contents from footnotes.xml
 */
function extractFootnoteContents(footnotesXml: string): Map<string, string> {
	const map = new Map<string, string>();

	// Match footnote elements with their IDs
	const footnoteRegex =
		/<w:footnote[^>]*w:id="([^"]+)"[^>]*>([\s\S]*?)<\/w:footnote>/g;
	const matches = footnotesXml.matchAll(footnoteRegex);

	for (const match of matches) {
		const id = match[1];
		const content = match[2];

		// Skip separator footnotes (id 0 and -1)
		if (id && id !== "0" && id !== "-1") {
			const text = getTextContent(content).trim();
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

	// Extract paragraphs
	const paragraphRegex = /<w:p[^>]*>([\s\S]*?)<\/w:p>/g;
	const paragraphs: string[] = [];

	for (const paraMatch of documentXml.matchAll(paragraphRegex)) {
		paragraphs.push(paraMatch[1]);
	}

	// For each paragraph, find footnote references and extract context
	for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
		const para = paragraphs[pIdx];
		const paraText = getTextContent(para);

		// Find footnote references in this paragraph, including custom marks
		const runRegex = /<w:r[^>]*>[\s\S]*?<\/w:r>/g;
		const refs: Array<{ id: string; customMark?: string }> = [];

		for (const runMatch of para.matchAll(runRegex)) {
			const runXml = runMatch[0];
			const refRegex = /<w:footnoteReference\b[^>]*\/?>/g;

			for (const refMatch of runXml.matchAll(refRegex)) {
				const refTag = refMatch[0];
				const idMatch = refTag.match(/w:id="([^"]+)"/);
				const footnoteId = idMatch?.[1];
				if (!footnoteId) {
					continue;
				}
				const hasCustomMark = /w:customMarkFollows="1"/.test(refTag);
				let customMark: string | undefined;

				if (hasCustomMark) {
					const afterRef = runXml.slice(refMatch.index + refTag.length);
					const markMatch = afterRef.match(/<w:t[^>]*>([^<]*)<\/w:t>/);
					customMark = markMatch?.[1]?.trim() || undefined;
				}

				refs.push({ id: footnoteId, customMark });
			}
		}

		for (const ref of refs) {
			const footnoteId = ref.id;

			if (footnoteContents.has(footnoteId)) {
				// Use the paragraph text as context, or get surrounding paragraphs
				let claim = paraText.trim();

				// If paragraph is too short, include adjacent paragraphs
				if (claim.length < 20 && pIdx > 0) {
					const prevText = getTextContent(paragraphs[pIdx - 1]);
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
				const index = isCustomMark ? 0 : numericIndex;

				results.push({
					index,
					displayIndex,
					order: orderIndex,
					claim: claim || "(No context found)",
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
