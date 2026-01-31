import type { VerificationContext } from "../types";

export function getEarlierFootnotes(
	context: VerificationContext | null,
	specificIndex?: number,
): string {
	if (!context) {
		return "No document context available.";
	}

	const { allFootnotes, currentIndex } = context;

	if (specificIndex === undefined) {
		return "Specify a footnote index to retrieve.";
	}

	if (specificIndex > currentIndex + 1) {
		return `Footnote ${specificIndex} is not earlier than the current footnote.`;
	}

	const footnote = allFootnotes.find((f) => f.index === specificIndex);
	if (footnote) {
		const label = footnote.displayIndex ?? String(footnote.index);
		return `**Footnote ${label}**:\nClaim: ${footnote.claim}\nCitation: ${footnote.citation}`;
	}
	return `Footnote ${specificIndex} not found.`;
}
