# Task Plan: Build Citation Checker MVP

## Goal
Implement the MVP citation checker as designed in `design-mvp.md`.

## Phases
- [x] Phase 1: Project setup & structure
- [x] Phase 2: Core document parsing (.docx → footnotes)
- [x] Phase 3: LLM verification with Gemini 3.0 Flash Preview
- [x] Phase 4: API worker (upload, status, results)
- [x] Phase 5: Frontend (upload + results pages)
- [x] Phase 6: Enhance verification agent with more tools
- [ ] Phase 7: Install dependencies & test

## What Was Built

### Project Structure
```
cider/
├── apps/
│   ├── web/                 # SolidStart frontend
│   │   └── src/
│   │       ├── routes/
│   │       │   ├── index.tsx           # Upload page
│   │       │   └── documents/[id].tsx  # Results page
│   │       └── lib/api.ts              # API client
│   └── worker/              # Cloudflare Worker
│       └── src/
│           ├── index.ts     # Hono routes
│           ├── docx.ts      # .docx parser
│           └── verify.ts    # Gemini verification
├── packages/
│   └── shared/              # Shared types
└── package.json             # Monorepo config
```

### Features Implemented
- .docx parsing with JSZip (extract footnotes + context)
- LLM verification with Gemini 3.0 Flash Preview + tool use
- Tools: web_search (DuckDuckGo), read_url (fetch + extract)
- API: POST /api/documents, GET /api/documents/:id, DELETE
- Frontend: drag-drop upload, polling for status, verdict display
- R2 storage for documents and results

## Next Steps

1. **Install dependencies**: `pnpm install`
2. **Set up R2 bucket**: `wrangler r2 bucket create cider-documents`
3. **Add Gemini API key**: Add `GEMINI_API_KEY` secret to wrangler
4. **Run dev servers**:
   - Worker: `cd apps/worker && pnpm dev`
   - Frontend: `cd apps/web && pnpm dev`
5. **Test with a .docx file** containing footnotes

## Status
**Phase 6 complete** - Agent enhanced, ready for testing

## Phase 6 Details: Agent Enhancement (DONE)

### New Tools Added
1. ✅ `get_earlier_footnotes` - Agent can retrieve previous footnotes for cross-references (Id., Ibid., supra note X)

### Prompt Improvements (DONE)
- ✅ Emphasizes finding ALL sources in a footnote (separated by semicolons, "see also", etc.)
- ✅ Handles "supra" and "infra" references with specific_index parameter
- ✅ Handles abbreviated references (Id., Ibid., Op. cit.)
- ✅ Encourages multiple tool calls - max iterations increased from 5 to 10
- ✅ Response now includes per-source verdicts in `sources[]` array

### Type Changes
- Added `SourceResult` interface to track individual sources
- `Verification.sources` now optional array of per-source results
- Overall verdict reflects weakest support among accessible sources
