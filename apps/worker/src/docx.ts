import JSZip from "jszip";

export interface ParsedFootnote {
	index: number;
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

		// Find footnote references in this paragraph
		const refRegex = /<w:footnoteReference[^>]*w:id="([^"]+)"[^>]*\/?>/g;

		for (const refMatch of para.matchAll(refRegex)) {
			const footnoteId = refMatch[1];

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

				results.push({
					index: results.length + 1,
					claim: claim || "(No context found)",
					citation,
				});
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
