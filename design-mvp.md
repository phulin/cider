# Citation Checker MVP

## Technical Design Document

**Version:** 0.1 MVP
**Date:** January 2026
**Status:** Draft

---

## 1. Overview

A minimal citation verification system that:
1. Accepts a .docx file upload
2. Extracts footnotes and their associated claims
3. Uses an LLM with web browsing to read and verify each citation
4. Returns verdicts on whether sources support claims

### Key MVP Simplification

Instead of building complex citation resolution infrastructure (pattern matching, external APIs like Unpaywall, Semantic Scholar, CourtListener, etc.), the MVP uses **Claude with computer use / tool use** to:
- Read and interpret the citation text
- Browse to the source (if it's a URL or findable via search)
- Extract relevant content
- Verify whether it supports the claim

This trades infrastructure complexity for LLM API costs, which is acceptable for an MVP.

**Model Choice:** Gemini 3.0 Flash Preview - fast, cheap, and has native tool use support.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      FRONTEND (SolidStart)                      │
│                    Cloudflare Pages + SSR                       │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                        API WORKER (Hono)                        │
│            Upload, Status Polling, Results Retrieval            │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PROCESSING WORKER                            │
│     Parse .docx → Extract Footnotes → LLM Verification          │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                       CLOUDFLARE R2                             │
│              Documents, Results (JSON)                          │
└─────────────────────────────────────────────────────────────────┘
```

### Components

| Component | Purpose |
|-----------|---------|
| **Frontend** | Upload UI, results display |
| **API Worker** | Handle uploads, serve status/results |
| **Processing Worker** | Parse docs, call LLM for verification |
| **R2 Storage** | Store uploaded docs and results |

---

## 3. LLM-Based Citation Reading

### 3.1 The Approach

For each footnote, we call Gemini 3.0 Flash Preview with function calling:

```typescript
const tools = [
  {
    functionDeclarations: [
      {
        name: "web_search",
        description: "Search the web for information",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" }
          },
          required: ["query"]
        }
      },
      {
        name: "read_url",
        description: "Fetch and read the content of a URL",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch" }
          },
          required: ["url"]
        }
      }
    ]
  }
];
```

### 3.2 Verification Prompt

```typescript
const VERIFICATION_PROMPT = `You are a citation verification assistant.

TASK: Verify whether the cited source supports the claim it's attached to.

CLAIM (from the document):
{claim}

CITATION (footnote text):
{citation}

INSTRUCTIONS:
1. If the citation contains a URL, use read_url to fetch it
2. If the citation references an article/paper without a URL, use web_search to find it
3. If you find the source, read it and determine if it supports the claim
4. If you cannot access the source (paywall, dead link, etc.), report that

Respond with JSON:
{
  "verdict": "supports" | "partially_supports" | "does_not_support" | "contradicts" | "source_unavailable",
  "confidence": 0.0-1.0,
  "explanation": "Brief explanation",
  "source_accessed": true | false,
  "source_url": "URL if found, or null"
}`;
```

### 3.3 Tool Implementation

The worker implements the tools that Claude can call:

```typescript
async function handleToolCall(
  toolName: string,
  input: Record<string, unknown>
): Promise<string> {
  switch (toolName) {
    case "web_search":
      // Use a search API (SerpAPI, Brave Search, etc.)
      return await performWebSearch(input.query as string);

    case "read_url":
      // Fetch URL content, convert to text
      return await fetchAndExtractText(input.url as string);

    default:
      return "Unknown tool";
  }
}

async function fetchAndExtractText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "CitationChecker/1.0" }
  });

  if (!response.ok) {
    return `Failed to fetch: ${response.status}`;
  }

  const html = await response.text();
  // Use linkedom or similar to extract text
  return extractTextFromHtml(html);
}
```

### 3.4 Agentic Loop

```typescript
import { GoogleGenAI } from "@google/genai";

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function verifyFootnote(
  claim: string,
  citation: string
): Promise<Verification> {
  const chat = genai.chats.create({
    model: "gemini-3-flash-preview",
    config: { tools }
  });

  const prompt = VERIFICATION_PROMPT
    .replace("{claim}", claim)
    .replace("{citation}", citation);

  // Agentic loop - let Gemini use tools until it has an answer
  let response = await chat.sendMessage({ message: prompt });

  while (response.functionCalls && response.functionCalls.length > 0) {
    const functionResponses = await Promise.all(
      response.functionCalls.map(async (call) => ({
        name: call.name,
        response: await handleToolCall(call.name, call.args)
      }))
    );

    response = await chat.sendMessage({
      functionResponses
    });
  }

  // Gemini returned final answer
  return parseVerificationResponse(response.text);
}
```

---

## 4. Data Models (Simplified)

```typescript
interface Document {
  id: string;
  filename: string;
  uploadedAt: string;
  status: "processing" | "complete" | "failed";
  footnoteCount: number;
}

interface Footnote {
  id: string;
  documentId: string;
  index: number;
  claim: string;           // Text before the footnote marker
  citation: string;        // Raw footnote text
}

interface Verification {
  footnoteId: string;
  verdict: "supports" | "partially_supports" | "does_not_support" | "contradicts" | "source_unavailable";
  confidence: number;
  explanation: string;
  sourceAccessed: boolean;
  sourceUrl?: string;
}

interface DocumentResult {
  document: Document;
  footnotes: Footnote[];
  verifications: Verification[];
}
```

---

## 5. API Endpoints

```
POST /api/documents
  - Upload .docx file
  - Returns { id, status: "processing" }

GET /api/documents/:id
  - Returns document status and results (if complete)
  - Poll this endpoint for status updates

GET /api/documents
  - List user's documents (if auth implemented)

DELETE /api/documents/:id
  - Delete document and results
```

---

## 6. Frontend (Minimal)

### Pages

1. **Upload Page** (`/`)
   - File input for .docx
   - Upload button
   - Redirects to results page on submit

2. **Results Page** (`/documents/:id`)
   - Shows processing status
   - Polls for updates every 3 seconds while processing
   - Displays footnote list with verdicts when complete

### Key Components

```tsx
// Simplified FootnoteCard
function FootnoteCard(props: { footnote: Footnote; verification?: Verification }) {
  const verdictColors = {
    supports: "bg-green-100 border-green-500",
    partially_supports: "bg-yellow-100 border-yellow-500",
    does_not_support: "bg-orange-100 border-orange-500",
    contradicts: "bg-red-100 border-red-500",
    source_unavailable: "bg-gray-100 border-gray-500",
  };

  return (
    <div class={`p-4 border-l-4 ${verdictColors[props.verification?.verdict || "source_unavailable"]}`}>
      <div class="font-mono text-sm text-gray-500">[{props.footnote.index}]</div>
      <p class="font-medium">{props.footnote.claim}</p>
      <p class="text-sm text-gray-600 mt-1">{props.footnote.citation}</p>

      <Show when={props.verification}>
        <div class="mt-2 text-sm">
          <span class="font-semibold">{formatVerdict(props.verification!.verdict)}</span>
          <p class="text-gray-600">{props.verification!.explanation}</p>
        </div>
      </Show>
    </div>
  );
}
```

---

## 7. Document Parsing

Same as full design - use JSZip to extract XML:

```typescript
import JSZip from "jszip";

interface ParsedDocument {
  footnotes: Array<{
    index: number;
    claim: string;
    citation: string;
  }>;
}

async function parseDocx(buffer: ArrayBuffer): Promise<ParsedDocument> {
  const zip = await JSZip.loadAsync(buffer);

  const documentXml = await zip.file("word/document.xml")?.async("string");
  const footnotesXml = await zip.file("word/footnotes.xml")?.async("string");

  if (!documentXml || !footnotesXml) {
    throw new Error("Invalid .docx file");
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(documentXml, "application/xml");
  const fnDoc = parser.parseFromString(footnotesXml, "application/xml");

  // Extract footnote text by ID
  const footnoteTexts = extractFootnoteTexts(fnDoc);

  // Walk document, find footnote refs, extract surrounding context
  return extractFootnotesWithContext(doc, footnoteTexts);
}
```

---

## 8. Processing Flow

```
1. User uploads .docx
2. API Worker:
   - Generates document ID
   - Stores file in R2
   - Enqueues processing job (or triggers worker directly)
   - Returns { id, status: "processing" }

3. Processing Worker:
   - Fetches .docx from R2
   - Parses document, extracts footnotes
   - For each footnote:
     - Calls Claude with tools to verify
     - Stores result
   - Marks document as complete
   - Stores final results JSON in R2

4. User polls GET /api/documents/:id
   - Returns status + results when complete
```

---

## 9. MVP Limitations (Acceptable for v0.1)

| Limitation | Reason | Future Fix |
|------------|--------|------------|
| No real-time progress | Polling is simpler | Add SSE in v0.2 |
| No auth | MVP can be single-user | Add Cloudflare Access |
| No caching | Simpler implementation | Add source caching |
| Higher LLM costs | Using LLM instead of APIs | Add specialized fetchers |
| No legal citations | Complex parsing | Add pattern matching |
| No PDFs | Extra complexity | Add pdf-parse |
| Gemini-only | Single provider | Add Claude fallback |
| Sequential verification | Simpler than parallel | Add parallel processing |

---

## 10. Cost Estimate (MVP)

Assuming ~10 footnotes per document, ~2 tool calls per footnote:

| Component | Cost per Document |
|-----------|-------------------|
| Gemini 3.0 Flash Preview (~20 calls, ~2K tokens each) | ~$0.02-0.05 |
| Workers | negligible |
| R2 Storage | negligible |
| Search API (if used) | ~$0.01-0.05 |

**Total: ~$0.03-0.10 per document**

For 100 documents/month: **~$3-10/month**

*Gemini 3.0 Flash Preview is significantly cheaper than Claude while maintaining good tool use capabilities.*

---

## 11. Tech Stack (Simplified)

```json
{
  "dependencies": {
    "@solidjs/router": "^0.14.0",
    "@solidjs/start": "^1.0.0",
    "solid-js": "^1.8.0",
    "hono": "^4.0.0",
    "zod": "^3.23.0",
    "jszip": "^3.10.0",
    "@google/genai": "^1.0.0",
    "linkedom": "^0.16.0"
  }
}
```

---

## 12. File Structure

```
cider/
├── apps/
│   ├── web/                    # SolidStart frontend
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   │   ├── index.tsx   # Upload page
│   │   │   │   └── documents/
│   │   │   │       └── [id].tsx # Results page
│   │   │   ├── components/
│   │   │   │   ├── FileUpload.tsx
│   │   │   │   └── FootnoteCard.tsx
│   │   │   └── lib/
│   │   │       └── api.ts
│   │   └── app.config.ts
│   └── worker/                 # Single Cloudflare Worker
│       ├── src/
│       │   ├── index.ts        # Hono routes
│       │   ├── docx.ts         # Document parsing
│       │   └── verify.ts       # LLM verification
│       └── wrangler.toml
├── packages/
│   └── shared/                 # Shared types
│       └── src/
│           └── types.ts
└── package.json
```

---

## 13. Implementation Order

1. **Week 1: Core Processing**
   - [ ] .docx parsing (JSZip + XML)
   - [ ] LLM verification with tool use
   - [ ] Basic worker endpoint

2. **Week 2: API & Storage**
   - [ ] R2 integration
   - [ ] Full API (upload, status, results)
   - [ ] Error handling

3. **Week 3: Frontend**
   - [ ] Upload page
   - [ ] Results page with polling
   - [ ] Basic styling

4. **Week 4: Polish**
   - [ ] Edge cases
   - [ ] Basic rate limiting
   - [ ] Deploy to Cloudflare

---

## 14. Success Criteria

MVP is successful if:
- [ ] Can upload a .docx with footnotes
- [ ] Extracts footnotes and associated claims correctly
- [ ] Verifies at least 70% of URL-based citations
- [ ] Returns useful verdicts and explanations
- [ ] Completes verification for a 10-footnote doc in < 2 minutes
