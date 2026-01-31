import { Type } from "@google/genai";

export const toolDefinitions = [
	{
		functionDeclarations: [
			{
				name: "web_search",
				description:
					"Search the web for information about a citation, source, article, paper, or book. Use this to find URLs for sources, find archived versions of dead links, or locate academic papers by title/author.",
				parameters: {
					type: Type.OBJECT,
					properties: {
						query: {
							type: Type.STRING,
							description:
								"Search query - be specific with titles, authors, publication names",
						},
					},
					required: ["query"],
				},
			},
		],
	},
	{
		functionDeclarations: [
			{
				name: "read_url",
				description:
					"Fetch and read the content of a URL. Use this to access web pages, articles, papers (if open access), and other online sources.",
				parameters: {
					type: Type.OBJECT,
					properties: {
						url: {
							type: Type.STRING,
							description: "URL to fetch and read",
						},
					},
					required: ["url"],
				},
			},
		],
	},
	{
		functionDeclarations: [
			{
				name: "read_pdf_page",
				description:
					"Download a PDF and extract text from a specific page. Page numbers are 1-based and follow the PDF's internal order (this may NOT match citation page numbering).",
				parameters: {
					type: Type.OBJECT,
					properties: {
						url: {
							type: Type.STRING,
							description: "PDF URL to download",
						},
						page: {
							type: Type.NUMBER,
							description:
								"Page number to extract (1-based; PDF internal order)",
						},
					},
					required: ["url", "page"],
				},
			},
		],
	},
	{
		functionDeclarations: [
			{
				name: "get_earlier_footnotes",
				description:
					"Retrieve a specific earlier footnote from the document by its index. Use this when the current citation references earlier footnotes with 'Id.', 'Ibid.', 'supra note X', or similar cross-references.",
				parameters: {
					type: Type.OBJECT,
					properties: {
						specific_index: {
							type: Type.NUMBER,
							description:
								"Footnote number to retrieve (e.g., for 'supra note 5', use 5). Required.",
						},
					},
					required: ["specific_index"],
				},
			},
		],
	},
];
