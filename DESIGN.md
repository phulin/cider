# Automatic Citation Checker for Word Footnotes

## Technical Design Document

**Version:** 1.0  
**Date:** January 2026  
**Status:** Draft

---

## 1. Executive Summary

This document describes the architecture for an automatic citation verification system that extracts footnotes from Word documents, resolves citations to their source materials, retrieves those sources, and uses large language models to determine whether each source actually supports the claim made in the associated text.

The system is built on Cloudflare's edge infrastructure (Workers, R2, Queues) with a SolidStart frontend, optimizing for low latency, cost efficiency, and horizontal scalability.

---

## 2. System Overview

### 2.1 Core Pipeline

The verification process flows through five stages:

1. **Document Ingestion** — Parse .docx file, extract body text with footnote markers, extract footnote contents
2. **Claim Extraction** — Identify the specific claim each footnote is meant to support (the sentence or clause preceding the footnote marker)
3. **Citation Resolution** — Parse the footnote text to identify the source type and normalize it to a retrievable reference
4. **Source Retrieval** — Fetch the actual source content (web page, PDF, academic paper)
5. **Verification** — Compare the claim against the source using an LLM to determine support, contradiction, or ambiguity

### 2.2 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND (SolidStart)                          │
│                         Cloudflare Pages + Edge SSR                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              API GATEWAY WORKER                             │
│                    Authentication, Rate Limiting, Routing                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│   INGESTION WORKER   │  │  RESOLVER WORKER     │  │  VERIFIER WORKER     │
│   Parse .docx        │  │  Resolve citations   │  │  LLM verification    │
│   Extract footnotes  │  │  Fetch sources       │  │  Generate verdicts   │
└──────────────────────┘  └──────────────────────┘  └──────────────────────┘
              │                        │                        │
              └────────────────────────┼────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLOUDFLARE QUEUES                                 │
│                    Job orchestration and retry handling                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLOUDFLARE R2                                  │
│         Documents, Source Cache, Verification Results, Job State           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Technology Stack

### 3.1 Frontend

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Framework | **SolidStart** | Fine-grained reactivity, excellent performance, SSR support |
| UI Library | **solid-ui** / **Kobalte** | Accessible primitives, pairs well with Solid |
| Styling | **Tailwind CSS** | Utility-first, works well with component libraries |
| State Management | Solid's built-in stores | No external state library needed |
| File Upload | **@solid-primitives/upload** | Native Solid integration |
| Hosting | **Cloudflare Pages** | Unified deployment with Workers |

### 3.2 Backend (Cloudflare Workers)

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Runtime | **Cloudflare Workers** | Edge deployment, low latency, generous free tier |
| Language | **TypeScript** | Type safety, first-class Cloudflare support |
| Routing | **Hono** | Lightweight, Workers-native, excellent DX |
| Validation | **Zod** | Runtime type validation, TypeScript inference |
| Job Queue | **Cloudflare Queues** | Native integration, automatic retries |
| Storage | **Cloudflare R2** | S3-compatible, no egress fees |
| KV Cache | **Cloudflare KV** | Fast reads for metadata, rate limiting |

### 3.3 Document Processing

| Task | Library | Notes |
|------|---------|-------|
| ZIP extraction | **JSZip** | Pure JS, Workers-compatible |
| XML parsing | **Native DOMParser** | Fastest option in Workers runtime |
| Fallback XML | **txml** | ~3KB, fast pure JS alternative |
| PDF text extraction | **pdf-parse** | For fetched PDF sources |
| HTML parsing | **linkedom** | DOM-like API for web content |

### 3.4 External Services

| Service | Purpose | Fallback |
|---------|---------|----------|
| **Anthropic Claude API** | Primary LLM for verification | OpenAI GPT-4 |
| **Semantic Scholar API** | Academic paper metadata | CrossRef |
| **Unpaywall API** | Open-access paper URLs | Direct DOI resolution |
| **CrossRef API** | DOI resolution | — |
| **Internet Archive (Wayback)** | Archived web sources | — |

---

## 4. Data Models

### 4.1 Core Entities

```typescript
// Document uploaded by user
interface Document {
  id: string;                    // ulid
  userId: string;
  filename: string;
  uploadedAt: string;            // ISO 8601
  status: 'processing' | 'ready' | 'failed';
  r2Key: string;                 // path in R2
  footnoteCount: number;
  verifiedCount: number;
}

// Extracted from document
interface Footnote {
  id: string;
  documentId: string;
  index: number;                 // footnote number in document
  markerContext: string;         // sentence(s) containing the marker
  claim: string;                 // extracted claim being supported
  rawCitation: string;           // raw footnote text
  status: 'pending' | 'resolving' | 'fetching' | 'verifying' | 'complete' | 'failed';
}

// Parsed citation information
interface ResolvedCitation {
  footnoteId: string;
  sourceType: SourceType;
  normalizedReference: string;   // URL, DOI, ISBN, etc.
  confidence: number;            // 0-1, parser confidence
  metadata?: SourceMetadata;
}

type SourceType = 
  | 'url'
  | 'doi'
  | 'isbn'
  | 'court_case'
  | 'statute'
  | 'news_article'
  | 'book_chapter'
  | 'unknown';

interface SourceMetadata {
  title?: string;
  authors?: string[];
  publicationDate?: string;
  publisher?: string;
  journal?: string;
  volume?: string;
  pages?: string;
}

// Fetched source content
interface SourceContent {
  citationId: string;
  r2Key: string;                 // cached content location
  contentType: 'html' | 'pdf' | 'text';
  extractedText: string;         // relevant excerpt
  fetchedAt: string;
  accessMethod: 'direct' | 'unpaywall' | 'wayback' | 'manual';
}

// Final verification result
interface Verification {
  id: string;
  footnoteId: string;
  verdict: Verdict;
  confidence: number;            // 0-1
  explanation: string;           // LLM-generated reasoning
  relevantQuote?: string;        // quote from source if found
  verifiedAt: string;
  modelUsed: string;
}

type Verdict = 
  | 'supports'           // source clearly supports the claim
  | 'partially_supports' // source somewhat supports but with caveats
  | 'does_not_support'   // source doesn't address the claim
  | 'contradicts'        // source contradicts the claim
  | 'ambiguous'          // unclear relationship
  | 'source_unavailable' // couldn't retrieve source
  | 'unparseable';       // couldn't parse citation
```

### 4.2 R2 Bucket Structure

```
citation-checker/
├── documents/
│   └── {userId}/
│       └── {documentId}/
│           ├── original.docx
│           ├── parsed.json          # extracted structure
│           └── results.json         # final verification results
├── sources/
│   └── {hash}/                      # content-addressed by URL/DOI hash
│       ├── content.html             # or .pdf, .txt
│       └── metadata.json
└── cache/
    └── citations/
        └── {normalizedRef}.json     # cached resolution results
```

---

## 5. Worker Architecture

### 5.1 API Gateway Worker

**Responsibilities:**
- Authentication (API keys, session tokens)
- Rate limiting (using KV for counters)
- Request routing to appropriate workers
- CORS handling

**Endpoints:**
```
POST   /api/documents              Upload new document
GET    /api/documents              List user's documents
GET    /api/documents/:id          Get document with footnotes
GET    /api/documents/:id/status   Poll verification progress
DELETE /api/documents/:id          Delete document and results

GET    /api/footnotes/:id          Get single footnote detail
POST   /api/footnotes/:id/retry    Retry failed verification

GET    /api/sources/:id            Get cached source content
```

**Technology:**
- Hono for routing
- Zod for request validation
- JWT or session-based auth

### 5.2 Ingestion Worker

**Trigger:** Queue message from document upload

**Process:**
1. Fetch .docx from R2
2. Unzip using JSZip
3. Parse `word/document.xml` with DOMParser
4. Parse `word/footnotes.xml`
5. Correlate footnote references with their text
6. Extract surrounding context for each footnote marker
7. Store parsed structure to R2
8. Enqueue footnotes for resolution

**Key Implementation:**

```typescript
import JSZip from 'jszip';

interface ParsedFootnote {
  index: number;
  markerContext: string;
  footnoteText: string;
}

async function parseDocx(buffer: ArrayBuffer): Promise<ParsedFootnote[]> {
  const zip = await JSZip.loadAsync(buffer);
  
  const documentXml = await zip.file('word/document.xml')?.async('string');
  const footnotesXml = await zip.file('word/footnotes.xml')?.async('string');
  
  if (!documentXml || !footnotesXml) {
    throw new Error('Invalid docx structure');
  }
  
  const parser = new DOMParser();
  const doc = parser.parseFromString(documentXml, 'application/xml');
  const footnotes = parser.parseFromString(footnotesXml, 'application/xml');
  
  // Extract footnote contents by ID
  const footnoteMap = extractFootnoteContents(footnotes);
  
  // Walk document, find footnote references, extract context
  return extractFootnotesWithContext(doc, footnoteMap);
}

function extractFootnoteContents(xml: Document): Map<string, string> {
  const map = new Map();
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const footnotes = xml.getElementsByTagNameNS(ns, 'footnote');
  
  for (const fn of footnotes) {
    const id = fn.getAttribute('w:id');
    if (id && id !== '0' && id !== '-1') { // skip separator footnotes
      const text = extractTextContent(fn);
      map.set(id, text);
    }
  }
  return map;
}
```

### 5.3 Citation Resolver Worker

**Trigger:** Queue message per footnote

**Process:**
1. Parse raw citation text
2. Identify source type using pattern matching + LLM fallback
3. Normalize to retrievable reference
4. Lookup metadata from external APIs
5. Enqueue for source fetching

**Citation Parsing Strategy:**

```typescript
const CITATION_PATTERNS = [
  // URLs
  { type: 'url', pattern: /https?:\/\/[^\s]+/i },
  
  // DOIs
  { type: 'doi', pattern: /10\.\d{4,}\/[^\s]+/i },
  { type: 'doi', pattern: /doi\.org\/([^\s]+)/i },
  
  // ISBNs
  { type: 'isbn', pattern: /ISBN[:\s]*([\d-X]+)/i },
  
  // Court cases (US)
  { type: 'court_case', pattern: /\d+\s+[A-Z]\.\s*\d*d?\s+\d+/i },  // 347 U.S. 483
  { type: 'court_case', pattern: /\d+\s+F\.\s*\d*d?\s+\d+/i },      // 123 F.3d 456
  
  // Statutes
  { type: 'statute', pattern: /\d+\s+U\.S\.C\.\s*§?\s*\d+/i },
];

async function resolveCitation(rawText: string): Promise<ResolvedCitation> {
  // Try pattern matching first
  for (const { type, pattern } of CITATION_PATTERNS) {
    const match = rawText.match(pattern);
    if (match) {
      return {
        sourceType: type,
        normalizedReference: normalizeReference(type, match),
        confidence: 0.9,
      };
    }
  }
  
  // Fall back to LLM parsing for complex citations
  return await llmParseCitation(rawText);
}
```

### 5.4 Source Fetcher Worker

**Trigger:** Queue message per resolved citation

**Process:**
1. Check R2 cache for existing content
2. Fetch source based on type
3. Extract relevant text
4. Store to R2 cache
5. Enqueue for verification

**Fetching Strategies by Source Type:**

| Type | Primary Strategy | Fallback |
|------|------------------|----------|
| URL | Direct fetch | Wayback Machine |
| DOI | Unpaywall → direct | Semantic Scholar PDF |
| ISBN | Google Books API | Open Library |
| Court case | CourtListener API | Google Scholar |
| Statute | US Code API | Cornell LII |

**Handling Paywalls:**

```typescript
async function fetchSource(citation: ResolvedCitation): Promise<SourceContent | null> {
  if (citation.sourceType === 'doi') {
    // Try Unpaywall first for open access
    const unpaywall = await fetch(
      `https://api.unpaywall.org/v2/${citation.normalizedReference}?email=${EMAIL}`
    );
    const data = await unpaywall.json();
    
    if (data.best_oa_location?.url_for_pdf) {
      return fetchPdf(data.best_oa_location.url_for_pdf);
    }
    
    // Try Semantic Scholar
    const paper = await semanticScholarLookup(citation.normalizedReference);
    if (paper?.openAccessPdf?.url) {
      return fetchPdf(paper.openAccessPdf.url);
    }
    
    // Mark as unavailable
    return {
      accessMethod: 'unavailable',
      reason: 'paywall',
    };
  }
  
  // ... other source types
}
```

### 5.5 Verification Worker

**Trigger:** Queue message per source-claim pair

**Process:**
1. Load claim and source content
2. Construct verification prompt
3. Call LLM API
4. Parse structured response
5. Store result

**LLM Prompt Strategy:**

```typescript
const VERIFICATION_PROMPT = `You are a citation verification assistant. Your task is to determine whether a source supports a specific claim.

CLAIM:
{claim}

SOURCE CONTENT:
{sourceContent}

Analyze whether the source supports the claim. Consider:
1. Does the source directly address the topic of the claim?
2. Does the source provide evidence that supports, contradicts, or is neutral toward the claim?
3. Are there any important caveats or qualifications?

Respond with a JSON object:
{
  "verdict": "supports" | "partially_supports" | "does_not_support" | "contradicts" | "ambiguous",
  "confidence": 0.0-1.0,
  "explanation": "Brief explanation of your reasoning",
  "relevant_quote": "Direct quote from source if applicable, or null"
}`;

async function verifyClaimAgainstSource(
  claim: string,
  sourceContent: string
): Promise<Verification> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: VERIFICATION_PROMPT
        .replace('{claim}', claim)
        .replace('{sourceContent}', truncateToContext(sourceContent, 8000))
    }]
  });
  
  return parseVerificationResponse(response);
}
```

---

## 6. Frontend Architecture

### 6.1 SolidStart Configuration

```typescript
// app.config.ts
import { defineConfig } from '@solidjs/start/config';

export default defineConfig({
  server: {
    preset: 'cloudflare-pages',
  },
  vite: {
    plugins: [],
  },
});
```

### 6.2 Route Structure

```
src/
├── routes/
│   ├── index.tsx              # Landing page
│   ├── app/
│   │   ├── index.tsx          # Dashboard - document list
│   │   ├── upload.tsx         # Upload new document
│   │   └── documents/
│   │       └── [id].tsx       # Document detail with footnotes
│   └── api/
│       └── [...path].ts       # API proxy to Workers (if needed)
├── components/
│   ├── DocumentUploader.tsx
│   ├── FootnoteList.tsx
│   ├── FootnoteCard.tsx
│   ├── VerificationBadge.tsx
│   ├── SourcePreview.tsx
│   └── ProgressTracker.tsx
├── lib/
│   ├── api.ts                 # API client
│   ├── stores/
│   │   ├── documents.ts
│   │   └── verification.ts
│   └── utils/
│       └── formatting.ts
└── styles/
    └── app.css
```

### 6.3 Key Components

**Document Uploader:**

```tsx
// components/DocumentUploader.tsx
import { createSignal } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { Button } from '@kobalte/core';

export function DocumentUploader() {
  const [file, setFile] = createSignal<File | null>(null);
  const [uploading, setUploading] = createSignal(false);
  const [progress, setProgress] = createSignal(0);
  const navigate = useNavigate();

  const handleUpload = async () => {
    const f = file();
    if (!f) return;

    setUploading(true);
    
    const formData = new FormData();
    formData.append('document', f);

    const response = await fetch('/api/documents', {
      method: 'POST',
      body: formData,
    });

    const { id } = await response.json();
    navigate(`/app/documents/${id}`);
  };

  return (
    <div class="upload-zone">
      <input
        type="file"
        accept=".docx"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <Button.Root
        onClick={handleUpload}
        disabled={!file() || uploading()}
      >
        {uploading() ? 'Uploading...' : 'Upload & Verify'}
      </Button.Root>
    </div>
  );
}
```

**Footnote Card with Verification Status:**

```tsx
// components/FootnoteCard.tsx
import { Show, Switch, Match } from 'solid-js';
import type { Footnote, Verification } from '~/lib/types';

interface Props {
  footnote: Footnote;
  verification?: Verification;
}

export function FootnoteCard(props: Props) {
  return (
    <div class="footnote-card">
      <div class="footnote-index">[{props.footnote.index}]</div>
      
      <div class="footnote-content">
        <p class="claim">
          <strong>Claim:</strong> {props.footnote.claim}
        </p>
        <p class="citation">
          <strong>Citation:</strong> {props.footnote.rawCitation}
        </p>
      </div>

      <Switch fallback={<StatusBadge status="pending" />}>
        <Match when={props.footnote.status === 'complete' && props.verification}>
          <VerificationResult verification={props.verification!} />
        </Match>
        <Match when={props.footnote.status === 'failed'}>
          <StatusBadge status="failed" />
        </Match>
        <Match when={props.footnote.status !== 'pending'}>
          <StatusBadge status="processing" />
        </Match>
      </Switch>
    </div>
  );
}

function VerificationResult(props: { verification: Verification }) {
  const verdictColors = {
    supports: 'bg-green-100 text-green-800',
    partially_supports: 'bg-yellow-100 text-yellow-800',
    does_not_support: 'bg-orange-100 text-orange-800',
    contradicts: 'bg-red-100 text-red-800',
    ambiguous: 'bg-gray-100 text-gray-800',
  };

  return (
    <div class="verification-result">
      <span class={`verdict-badge ${verdictColors[props.verification.verdict]}`}>
        {formatVerdict(props.verification.verdict)}
      </span>
      <p class="explanation">{props.verification.explanation}</p>
      <Show when={props.verification.relevantQuote}>
        <blockquote class="relevant-quote">
          "{props.verification.relevantQuote}"
        </blockquote>
      </Show>
    </div>
  );
}
```

### 6.4 Real-time Progress Updates

Use Server-Sent Events for progress updates:

```typescript
// lib/api.ts
export function subscribeToDocumentProgress(
  documentId: string,
  onUpdate: (update: ProgressUpdate) => void
) {
  const eventSource = new EventSource(`/api/documents/${documentId}/stream`);
  
  eventSource.onmessage = (event) => {
    const update = JSON.parse(event.data);
    onUpdate(update);
  };

  return () => eventSource.close();
}

// In component
import { onMount, onCleanup } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';

const [footnotes, setFootnotes] = createStore<Footnote[]>([]);

onMount(() => {
  const unsubscribe = subscribeToDocumentProgress(documentId, (update) => {
    if (update.type === 'footnote_updated') {
      setFootnotes(
        (fn) => fn.id === update.footnoteId,
        reconcile(update.footnote)
      );
    }
  });
  
  onCleanup(unsubscribe);
});
```

---

## 7. Queue Architecture

### 7.1 Queue Definitions

```typescript
// wrangler.toml
[[queues.producers]]
queue = "ingestion-queue"
binding = "INGESTION_QUEUE"

[[queues.producers]]
queue = "resolution-queue"
binding = "RESOLUTION_QUEUE"

[[queues.producers]]
queue = "fetch-queue"
binding = "FETCH_QUEUE"

[[queues.producers]]
queue = "verification-queue"
binding = "VERIFICATION_QUEUE"

[[queues.consumers]]
queue = "ingestion-queue"
script_name = "ingestion-worker"
max_batch_size = 1
max_retries = 3

[[queues.consumers]]
queue = "resolution-queue"
script_name = "resolver-worker"
max_batch_size = 10
max_retries = 3

[[queues.consumers]]
queue = "fetch-queue"
script_name = "fetcher-worker"
max_batch_size = 5
max_retries = 3
max_batch_timeout = 30

[[queues.consumers]]
queue = "verification-queue"
script_name = "verifier-worker"
max_batch_size = 5
max_retries = 2
```

### 7.2 Message Schemas

```typescript
interface IngestionMessage {
  type: 'ingest';
  documentId: string;
  r2Key: string;
}

interface ResolutionMessage {
  type: 'resolve';
  footnoteId: string;
  rawCitation: string;
}

interface FetchMessage {
  type: 'fetch';
  footnoteId: string;
  sourceType: SourceType;
  reference: string;
}

interface VerificationMessage {
  type: 'verify';
  footnoteId: string;
  claim: string;
  sourceR2Key: string;
}
```

### 7.3 Error Handling and Dead Letter Queue

```typescript
// After max retries, messages go to DLQ
[[queues.consumers]]
queue = "verification-queue"
script_name = "verifier-worker"
max_retries = 2
dead_letter_queue = "failed-jobs"

// DLQ processor for alerting/manual review
[[queues.consumers]]
queue = "failed-jobs"
script_name = "dlq-processor"
```

---

## 8. Performance Considerations

### 8.1 Caching Strategy

| Data | Cache Location | TTL | Key Pattern |
|------|----------------|-----|-------------|
| Resolved citations | R2 | 30 days | `cache/citations/{hash}.json` |
| Fetched sources | R2 | 7 days | `sources/{contentHash}/` |
| Rate limit counters | KV | 1 hour | `rate:{userId}:{hour}` |
| Source metadata | KV | 24 hours | `meta:{doi/url}` |

### 8.2 CPU Time Management

Workers have CPU time limits (50ms on free, 30s on paid). Handle this by:

1. **Streaming XML parsing** for very large documents
2. **Chunking** source text before LLM calls
3. **Batching** queue messages where possible

### 8.3 Cost Estimation

| Component | Unit Cost | Estimated Monthly (1000 docs) |
|-----------|-----------|------------------------------|
| Workers requests | $0.50/million | ~$1 |
| Workers CPU | $0.02/million ms | ~$5 |
| R2 storage | $0.015/GB | ~$0.50 |
| R2 operations | $0.36/million | ~$0.50 |
| Queues | $0.40/million | ~$2 |
| Claude API | $3/M input, $15/M output | ~$50-150 |

**Total estimated: $60-160/month for 1000 documents**

The LLM API is by far the largest cost. Consider:
- Caching verification results for identical claim/source pairs
- Using Claude Haiku for initial screening, Sonnet for ambiguous cases
- Allowing users to skip verification for certain citation types

---

## 9. Security Considerations

### 9.1 Authentication

- JWT tokens for API authentication
- Refresh token rotation
- Consider Cloudflare Access for additional protection

### 9.2 Input Validation

- Validate .docx file structure before processing
- Sanitize extracted text before LLM prompts
- Rate limit by user and IP

### 9.3 Data Privacy

- User documents stored in isolated R2 paths
- Automatic deletion after configurable retention period
- No source content shared between users (except cache)

### 9.4 External API Security

- Store API keys in Workers secrets
- Use environment-specific keys
- Implement circuit breakers for external services

---

## 10. Deployment

### 10.1 Repository Structure

```
citation-checker/
├── apps/
│   ├── web/                    # SolidStart frontend
│   │   ├── src/
│   │   ├── app.config.ts
│   │   └── package.json
│   └── workers/
│       ├── api-gateway/
│       ├── ingestion/
│       ├── resolver/
│       ├── fetcher/
│       └── verifier/
├── packages/
│   ├── shared/                 # Shared types, utilities
│   │   ├── src/
│   │   │   ├── types.ts
│   │   │   ├── schemas.ts
│   │   │   └── utils.ts
│   │   └── package.json
│   └── docx-parser/           # Document parsing logic
│       └── package.json
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

### 10.2 CI/CD Pipeline

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: pnpm/action-setup@v2
        with:
          version: 8
          
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'
          
      - run: pnpm install
      - run: pnpm test
      - run: pnpm build
      
      - name: Deploy Workers
        run: pnpm --filter "./apps/workers/*" run deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          
      - name: Deploy Frontend
        run: pnpm --filter web run deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
```

---

## 11. Future Enhancements

### 11.1 Phase 2 Features

- **Batch upload** — Process multiple documents
- **Citation style detection** — Identify and normalize across styles (APA, MLA, Chicago, Bluebook)
- **Source suggestions** — Recommend better sources for unsupported claims
- **Export results** — Generate annotated document with verification comments

### 11.2 Phase 3 Features

- **Browser extension** — Verify citations while reading online
- **API access** — Allow integration into other workflows
- **Team workspaces** — Shared document verification
- **Custom source databases** — Connect to institutional repositories

### 11.3 Potential Integrations

- Zotero/Mendeley for citation management
- Google Docs plugin
- Microsoft Word add-in
- Overleaf integration for LaTeX

---

## 12. Open Questions

1. **Source unavailability handling** — What UX for paywalled content? Allow manual upload?

2. **Claim extraction granularity** — Full sentence? Clause? Let user adjust?

3. **Confidence thresholds** — What confidence level triggers "needs review"?

4. **Legal content** — Special handling for court cases, statutes? Different verification logic?

5. **Multi-language support** — Scope for v1? Which languages?

---

## Appendix A: Library Versions

```json
{
  "dependencies": {
    "@solidjs/router": "^0.14.0",
    "@solidjs/start": "^1.0.0",
    "solid-js": "^1.8.0",
    "@kobalte/core": "^0.13.0",
    "hono": "^4.0.0",
    "zod": "^3.23.0",
    "jszip": "^3.10.0",
    "txml": "^6.0.0",
    "@anthropic-ai/sdk": "^0.30.0"
  }
}
```

## Appendix B: Environment Variables

```bash
# Workers
ANTHROPIC_API_KEY=sk-ant-...
UNPAYWALL_EMAIL=your@email.com
SEMANTIC_SCHOLAR_API_KEY=...
R2_BUCKET_NAME=citation-checker

# Frontend
PUBLIC_API_URL=https://api.citationchecker.example.com
```