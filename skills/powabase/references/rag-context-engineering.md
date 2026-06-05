# Context Engineering (RAG): Sources & Knowledge Bases

The full RAG pipeline: ingest documents (**Sources**), then index them into
**Knowledge Bases** (KBs) with a chosen strategy, then retrieve. All paths are
under `{BASE_URL}` with the two-header auth. Verify shapes against
`https://docs.powabase.ai` — this surface is rich and evolving.

## 1. Sources & extraction

A Source is an uploaded file whose text is extracted asynchronously for indexing.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/sources` | List sources (optional `?status=`) |
| POST | `/api/sources/upload` | Upload a file (`multipart/form-data`) |
| POST | `/api/sources/import-from-storage` | Import a file already in project Storage (`{bucket, path, name?}`) |
| POST | `/api/sources/import-url` | Import web content (`{mode, urls, max_pages?}`); needs a Firecrawl key |
| GET | `/api/sources/{id}` | Get a source incl. `extraction_status` |
| GET | `/api/sources/{id}/page-texts` | Extracted text by page (`?page=N`, 1-based) |
| PATCH | `/api/sources/{id}` | Update `name` / `metadata` |
| POST | `/api/sources/{id}/reextract` | Re-run extraction (`{extraction_model?}`) |
| POST | `/api/sources/{id}/cancel` | Cancel an in-progress extraction |
| GET | `/api/sources/{id}/download` | Download the original file |
| GET | `/api/sources/{id}/derivatives/{type}/download` | Download a derivative (`markdown`/`text`/`page_text`/`image`; `?index=N`, 0-based) |
| DELETE | `/api/sources/{id}` | Delete the source + its storage files |

**Upload** (multipart): `file` (required); optional `name`, `metadata` (JSON
string), `extraction_model` (**PDF only**). Response:

```json
{ "id": "source-uuid", "name": "doc.pdf", "file_type": "application/pdf",
  "storage_path": "sources-{org}-{project}/{id}/doc.pdf",
  "extraction_status": "pending", "task_id": "celery-task-uuid" }
```

> **Content dedup is automatic and project-wide.** Sources are deduped on a
> `sha256` of the **raw file bytes** (a unique index on `ai.sources.content_hash`).
> Re-uploading identical content — even under a different filename — does **not**
> create a new source: upload returns **`409 duplicate_source`** with the existing
> source in the body, and **no re-extraction runs** (the prior extraction is
> reused). The same applies to `import-from-storage` / `import-url`. So **treat 409
> as success, not error** — read the existing source and proceed:
> ```python
> r = requests.post(f"{BASE_URL}/api/sources/upload", headers=h, files={"file": data})
> sid = (r.json()["id"] if r.status_code == 201
>        else r.json()["duplicate"]["id"])   # 409 → reuse existing source
> ```
> This makes idempotent re-runs cheap, but means a naive `r.json()["id"]` crashes on
> the second run of your script. Dedup is on **content**, not name — change the bytes
> (even a byte) and you get a new source.

**`extraction_status` enum** — `pending` → `extracting` → terminal one of
`extracted` · `attention_required` · `failed` · `cancelled`.

> `attention_required` is a **terminal** state (extraction finished but quality is
> suspect — e.g. a scanned PDF that fell back to a no-OCR extractor, yielding little
> text). Treat it as "done polling", not "retry". **But it is NOT accepted for KB
> indexing** — adding such a source to a KB returns 400 (see §2). To index it,
> `POST /api/sources/{id}/reextract` with an OCR `extraction_model` (e.g. `mistral`)
> until it reaches `extracted`. Poll until the status is in the terminal set:

```python
TERMINAL = {"extracted", "attention_required", "failed", "cancelled"}
while requests.get(f"{BASE_URL}/api/sources/{sid}", headers=h).json()["extraction_status"] not in TERMINAL:
    time.sleep(2)
```

**Supported types:** PDF, Word (`.docx`/`.doc`), images (`.png/.jpg/.jpeg/.webp/.gif/.tiff`, OCR),
text (`.txt/.md/.csv`), PowerPoint (`.pptx`), Excel (`.xlsx`), and URLs. (The docs'
allowed-extension validation list and the type table differ slightly on `.csv`/`.doc`/`.xls` —
verify if it matters.)

**PDF `extraction_model`:** `auto` (default; fallback chain
`mistral → opendataloader → fitz → pdfplumber`), `mistral` (OCR, needs
`MISTRAL_API_KEY`), `paddleocr` (needs key+base URL), `lighton` (needs key+base URL),
`opendataloader` / `fitz` / `pdfplumber` (local, no key). `paddleocr`/`lighton` are
**not** in the `auto` chain — request them explicitly.

### Derivatives are reusable app primitives (build a document viewer)

Extraction doesn't just feed RAG — it produces **derivatives you can render directly
in your own UI**. This is how you build a PDF-viewer / document-reader experience
without bundling a third-party PDF library. `GET /api/sources/{id}` returns a
`derivatives` JSONB plus `auto_metadata.page_count`:

```jsonc
"derivatives": {
  "markdown":  [{ "storage_path": "...", "format": "markdown" }],          // whole-doc markdown
  "text":      [{ "storage_path": "...", "format": "plain" }],             // whole-doc plain text
  "page_text": [{ "storage_path": "...", "page": 1, "format": "plain" }],  // one per page (page is 1-based)
  "image":     [{ "storage_path": "...", "page": 1, "format": "png",
                  "metadata": { "width": 816, "height": 1056, "dpi": 150 } }]  // one rendered page image per page
}
```

- **Page images:** PDF extraction renders **one PNG per page (~150 DPI)** into
  `derivatives.image` (most extractor paths — `fitz`/`opendataloader`/full-PDF OCR;
  the original file is used directly for image sources). Don't assume they always
  exist — **check `derivatives.image` is present**; if a path didn't render them,
  `reextract` with a model that does. Use these as the visual layer of your viewer.
- **Fetch for the viewer** (both stream the bytes under the two-header `/api/*` auth):
  - **Page image:** `GET /api/sources/{id}/derivatives/image/download?index=N` (`index`
    is **0-based** into the `image` array — order matches pages).
  - **Page text layer:** `GET /api/sources/{id}/page-texts?page=N` (**1-based**;
    omit `page` for all pages) → `{ text, page, count }`. Use it for search and a
    selectable/copyable text overlay.
  - **Pagination:** `auto_metadata.page_count`.
- **Serving to a browser:** the derivative/page-text endpoints **stream bytes**
  through the authenticated `/api/*` surface (the `sources` bucket is **private**;
  there is **no public or signed URL** for derivatives). So a frontend either calls
  these endpoints with the user's session, **or** — because source access is
  **project-wide, not per-user** (see [baas-database-rls.md](baas-database-rls.md)) —
  for a multi-tenant app **proxy them through your backend and enforce ownership
  there**. An `<img src="/api/sources/{id}/derivatives/image/download?index=0">` works
  only if that request carries valid auth on your origin.
- **Limitation — no positional/bbox data.** Extraction stores plain page text, not
  per-character coordinates. You get *page image + plain-text search/overlay*, not a
  pixel-aligned selection layer. For true text-on-image selection you'd OCR the page
  image yourself (e.g. Tesseract → word boxes) on top of these artifacts.

## 2. Knowledge Bases

| Method | Path | Purpose |
| --- | --- | --- |
| GET / POST | `/api/knowledge-bases` | List / create |
| GET / PATCH / DELETE | `/api/knowledge-bases/{id}` | Get (incl. indexed sources + status) / update / delete |
| GET | `/api/knowledge-bases/{id}/sources` | List indexed sources (paginated/filterable) |
| POST | `/api/knowledge-bases/{id}/sources` | Add a source → **triggers indexing** (`{source_id}`) |
| POST | `/api/knowledge-bases/{id}/sources/{indexed_source_id}/cancel` | Cancel an in-progress indexing |
| DELETE | `/api/knowledge-bases/{id}/sources/{indexed_source_id}` | Remove a source from the KB (source row untouched) |
| POST | `/api/knowledge-bases/{id}/reindex` | Reindex all / subset / failed-only |
| POST | `/api/knowledge-bases/{id}/build-bm25` | Rebuild the BM25 index (hybrid/full_text KBs only) |
| POST | `/api/knowledge-bases/{id}/items` | Enumerate indexed content (chunks/nodes/JSON) for source(s) |
| POST | `/api/knowledge-bases/{id}/search` | Search the KB |
| PUT/GET/DELETE | `/api/knowledge-bases/{id}/enrichment` | Manage metadata-enrichment config |
| POST | `/api/knowledge-bases/{id}/enrichment/run` | Run enrichment (`{incremental?, retry_failed?}`) |
| GET | `/api/knowledge-bases/{id}/enrichment/results?item_ids=` | Fetch enriched metadata |
| POST/GET | `/api/knowledge-bases/{id}/graph-enrichment/run`, `/graph-enrichment/errors` | GraphIndex cross-ref enrichment |
| GET | `/api/config/kb-defaults` | Platform defaults for KB creation (authoritative selectable strategies/rerankers) |

**Create:** `{ "name": <required>, "description"?, "indexing_config"?, "retrieval_config"? }`.
Any `indexing_config`/`retrieval_config` you pass is **merged over** the strategy
defaults (not a full replace). Default strategy is `chunk_embed`.

> **Reranking, query enrichment, and multimodal retrieval all live in
> `retrieval_config` and are stored on the KB** — set them at create OR change them
> later with `PATCH /api/knowledge-bases/{id}` (same fields as create). Because
> they're query-time, edits take effect on the next search with **no reindex**.
> The Studio "Create KB" modal exposes all three; over the API you set them
> directly. Shape:
> ```json
> "retrieval_config": {
>   "method": "hybrid", "top_k": 5, "vector_weight": 0.5,
>   "context_mode": "image",                                    // §6.3 multimodal retrieval
>   "reranker": { "model": "cohere/rerank-english-v3.0", "candidate_count": 20 },  // §6.1
>   "query_enrichment": { "enabled": true, "model": "gpt-5-mini" }                 // §6.2
> }
> ```
> Only `indexing_config` changes (chunking/embedding model/strategy) require a reindex.

> **Extraction is a hard barrier before indexing.** Upload and KB-add are two
> async stages with a gap between them: a source must be fully **`extracted`**
> before it can be added to a KB. `POST /knowledge-bases/{id}/sources` checks the
> source's `extraction_status` and returns **400 `"Source must be extracted first
> (status: ...)"`** for anything else — it does **not** queue or auto-index later.
> Notably `attention_required` is **rejected** too (re-extract with OCR first, §1).
> So the correct sequence is always: upload → **poll `GET /api/sources/{id}` to
> `extracted`** → add to KB → poll the indexed source to `indexed`. There is no
> single upload-extract-index endpoint; the client owns the polling.

> **Adding a source to a KB is idempotent.** `indexed_sources` has a unique
> `(knowledge_base_id, source_id)`, and add-source is an `ON CONFLICT … DO UPDATE`
> upsert — re-adding the same `source_id` resets it to `pending` and **re-dispatches
> indexing** (a deliberate way to re-index one source) rather than erroring or
> duplicating. Returns `201` either way; the `id` is the existing `indexed_source_id`
> on conflict. Combined with content dedup (§1), the whole upload→index pipeline is
> safe to re-run.

> **The two-IDs trap.** Adding a source uses `source_id` (the `ai.sources` UUID).
> But cancel / reindex / DELETE-link use `indexed_source_id` — the
> `indexed_sources.id` returned as `id` in the `/sources` list. They are different
> IDs; mixing them causes 404s.

**List sources** returns `{ "items": [...], "total", "limit", "offset" }`; each
item joins `indexed_sources` + `sources` and carries `index_status`
(`pending`/`indexing`/`indexed`/`failed`/`cancelled`), `error_message`,
`source_name`, etc. Filter with `?status=failed` to find broken indexing.

**Reindex** body (optional): `{ "indexed_source_ids"?: [...], "failed_only"?: bool }`.
If `indexed_source_ids` is given it wins; else `failed_only` reindexes only failed;
empty body reindexes everything. Reindex **destroys and recreates** all chunks/
nodes/JSON — the KB stays searchable but may be incomplete until done.

**Async contracts:** `build-bm25` returns `202 {task_id}` — poll the KB's
`bm25_status`. `/items` takes `source_ids` (the **source** UUIDs, not
`indexed_source_id`s; `limit` default 1000, cap 10000). Cancel endpoints return
`409` unless the task is still `pending`/`extracting` (sources) or
`pending`/`indexing` (KB).

## 3. Search

`POST /api/knowledge-bases/{id}/search`:

| Field | Type | Default / notes |
| --- | --- | --- |
| `query` | string | **required** |
| `top_k` | int | `5` (`full_document` defaults to `3`); or the `KB_DEFAULT_TOP_K` setting |
| `retrieval_method` | string | `vector_search`/`full_text`/`hybrid`/`tree_search`; omit → KB default |
| `similarity_threshold` | float | `0.0`; min vector score (0–1) to include |
| `vector_weight` | float | hybrid only; `0.5` default (↑ = favor semantic) |
| `filter_metadata` | object | restrict to chunks matching enrichment-metadata fields |
| `source_ids` | UUID[] | restrict to specific sources ("search inside one document") |

Response: `{ "results": [ { "score": <float>, "text": <string>, ...source metadata }, ... ] }`
(iterate `results["results"]`). Search runs with the **service role and bypasses
RLS** — to enforce per-user access, query `ai.chunks` under the user's JWT and pass
results as `context_items` instead (see [agents-and-tools.md](agents-and-tools.md)).

## 4. Indexing strategies (`indexing_config.strategy`)

| Strategy (enum) | What it does | Best for |
| --- | --- | --- |
| `chunk_embed` (default) | Overlapping chunks → embeddings (+ BM25 over chunk text). No LLM calls; fastest/cheapest. | General RAG, most docs |
| `full_document` | One LLM summary per doc (embedded); **search returns the whole original doc** | Short self-contained docs as units |
| `page_index` | LLM builds a hierarchical tree (ToC + section nodes) | Long structured PDFs |
| `graph_index` | PageIndex + cross-reference enrichment + graph expansion | Cross-referenced corpora |
| `doc2json` | Sliding-window LLM fills a user JSON schema | Structured field extraction |

Key config (in `indexing_config`, or `indexing_config.extra` for page/graph/doc2json):

- **chunk_embed:** `chunk_size` (default **2000** tokens), `chunk_overlap`/`overlap`
  (default **50** — docs name it `chunk_overlap` but examples use `overlap`;
  verify), `embedding_model` (default `text-embedding-3-small`).
- **full_document:** `summary_model`, `embedding_model`. Summary sees only the
  **first ~32K tokens**; longer unique content beyond that isn't in the retrieval
  summary (the full text is still returned on a match).
- **page_index:** `extra.model`, `extra.if_add_node_summary: "yes"`. Expensive to
  index (many LLM calls). **Retrieval: `tree_search` only.**
- **graph_index:** `extra.model`, `extra.enrichment_model`, `extra.embedding_model`,
  `extra.if_add_node_summary`. Retrieval: vector/hybrid/full_text (+ automatic graph
  expansion). **Not `tree_search`.**
- **doc2json:** `extra.json_schema` (`{fields:[{name,type,description}, ...]}`),
  `extra.extraction_model`. Text mode default 4000-token / 200-overlap windows;
  image mode for complex layouts. Read results via `/items` (`extracted_json`).

## 5. Retrieval methods (`retrieval_config.method` / per-request `retrieval_method`)

| Method (enum) | How | When |
| --- | --- | --- |
| `vector_search` | Cosine similarity over embeddings (~100ms) | Semantic / paraphrase matching |
| `full_text` | BM25 keyword scoring (`tsvector`, `k1=1.2`, `b=0.75`) | Exact phrases, IDs, error codes, names |
| `hybrid` (**recommended**) | Vector + BM25 fused via Reciprocal Rank Fusion (`k=60`); `vector_weight` balances | Production default, robust |
| `tree_search` | LLM picks docs then sections from the ToC | **`page_index` KBs only** |

`tree_search` reads the PageIndex ToC/nodes tables — treat it as **PageIndex-only**
and use hybrid on `graph_index`. (The docs are internally inconsistent on whether
GraphIndex also supports tree_search; the strategy/Info-box guidance says no — verify
live if you need it.) `full_text`/`hybrid` require a BM25 index; rebuild it with
`POST .../build-bm25` (vector-only KBs → 400).

## 6. Embeddings, reranking, query enrichment & multimodal retrieval

- **Embedding model** default `text-embedding-3-small` (OpenAI, 1536 dims). All
  chunks in a KB must share one model — changing it requires a reindex. pgvector
  **HNSW caps at 2000 dims**: `text-embedding-3-large` (3072) falls back to a slow
  sequential scan. Cohere/Voyage/Google/Mistral models are supported via LiteLLM
  but need their platform-level API keys configured by an admin.

### 6.1 Reranking — `retrieval_config.reranker`

Optional precision boost: a two-stage pipeline fetches `candidate_count` items with
the configured `method`, then a cross-encoder re-scores them and truncates to
`top_k`. **Enabled iff `reranker.model` is set** (omit the object → off). Stored on
the KB; query-time, so no reindex.

```json
"reranker": { "model": "cohere/rerank-english-v3.0", "candidate_count": 20 }
```

- `candidate_count` default **20** (Stage-1 pool); final count is `retrieval_config.top_k` (default 5).
- **Models** (provider-namespaced strings): `cohere/rerank-english-v3.0` (default),
  `cohere/rerank-multilingual-v3.0`, `jina_ai/jina-reranker-v2-base-multilingual`,
  `voyage/rerank-2.5`, `voyage/rerank-2.5-lite`, `zerank-1`/`zerank-2` (ZeroEntropy —
  a `zerank`-prefixed string routes to the ZeroEntropy client; everything else goes
  through LiteLLM, so Together/Azure/self-hosted `hosted_vllm/*` also work).
- Keys are **platform-managed** (admin). Billed as `reranker_call`. **Fails open** —
  a reranker error returns Stage-1 results truncated to `top_k`.
- `GET /api/config/kb-defaults` lists selectable rerankers authoritatively — don't hardcode.

### 6.2 Query enrichment — `retrieval_config.query_enrichment`

Optional LLM step that rewrites the query before retrieval. **Off by default**;
opt in per KB. Stored on the KB (query-time, no reindex).

```json
"query_enrichment": { "enabled": true, "model": "gpt-5-mini" }
```

- When on, the LLM (default `gpt-5-mini`, temperature 0) produces two variants:
  **`enriched_query`** (semantic restatement → used for the vector embedding) and
  **`keyword_query`** (OR-joined synonyms → used for BM25). Session history (recent
  turns) is fed in to resolve pronouns/ellipsis: *"what about pricing?"* →
  *"What are the AWS cloud pricing options?"*.
- The result is echoed in the response as `query_enrichment`
  (`original_query`/`enriched_query`/`keyword_query`/`model`/`method:"llm_enrichment"`).
  Billed as `query_enrichment`.
- **When to use:** conversational / multi-turn retrieval where follow-ups depend on
  prior context, or terse keyword queries that benefit from synonym expansion on
  hybrid/full_text. **Skip it** for simple single-shot lookups — it adds an LLM call
  (latency + cost) per search. **Auto-skipped for `tree_search`** (which does its own
  LLM doc/section selection). Note: for `full_text`/`hybrid`, even with enrichment
  **off**, a fast *tokenization* context-builder still folds history into the keyword
  query — that's not LLM enrichment and isn't billed as such.

### 6.3 Multimodal retrieval — `retrieval_config.context_mode`

`"text"` (default) returns chunk text; **`"image"`** returns the **original page
images** of the matched content as multimodal content blocks for the LLM —
preserving layout, tables, charts, stamps, handwriting that text extraction loses.

```json
"context_mode": "image"   // optional: "image_delivery": "base64" | signed-url
```

- **Available for all strategies EXCEPT `doc2json`** — `chunk_embed`,
  `full_document`, `page_index`, `graph_index` all support it. (Doc2JSON instead has
  an *indexing-time* `use_images` flag, §4.) This is the cross-cutting "multimodal
  retrieval" toggle, and it's a **retrieval-time** concern — stored on the KB,
  settable at create or via `PATCH`, no reindex.
- Resolves the **page-image derivatives** rendered at source extraction; items
  without an available page image **fall back to text** gracefully.
- **The consuming agent model must be vision-capable** (GPT-4o/GPT-5 class). A
  text-only model silently drops the image blocks — the classic "agent has the doc
  but answers as if it didn't" bug.
- Don't confuse with **metadata enrichment**'s `use_multimodal` (a separate
  `PUT /enrichment` flag that lets the *enricher* see page images; orthogonal, all strategies).

## 7. Decision guide

| Documents / queries | Strategy | Retrieval |
| --- | --- | --- |
| General, mixed (DEFAULT) | `chunk_embed` (2000/50) | `hybrid` (+ reranker for precision) |
| Exact tokens (IDs, codes, names) | `chunk_embed` | `full_text` |
| Whole short docs as units | `full_document` | `hybrid`, `top_k=3` |
| Long structured PDFs, structural queries | `page_index` | `tree_search` |
| Cross-referenced corpora | `graph_index` | `hybrid` |
| Invoices / forms / structured fields | `doc2json` | `vector_search` (read `/items`) |

## 8. Gotchas (quick checklist)

- **Extraction → indexing is a barrier** (§2): add-to-KB needs `extraction_status
  == "extracted"` (poll first) and **400s** otherwise — including `attention_required`.
- **Content dedup is project-wide** (§1): re-upload of identical bytes → **409
  `duplicate_source`** (reuse the returned source; no re-extraction). Re-adding a
  source to a KB is an idempotent upsert that **re-dispatches indexing**.
- **`source_id` vs `indexed_source_id`** (§2) — the #1 source of 404s.
- **`chunk_overlap` vs `overlap`** — docs inconsistent; examples use `overlap`. Verify live.
- **`tree_search` ⇒ PageIndex only; `build-bm25`/`full_text`/`hybrid` ⇒ need a BM25 index.**
- **`text-embedding-3-large` (3072) > HNSW's 2000-dim limit** → slow sequential scan.
- **`full_document` summary truncates at ~32K tokens**; reindex destroys + recreates all artifacts.
- **Non-OpenAI embedding/reranker providers need platform keys** (admin).
- **Reranker/query-enrichment/multimodal all nest in `retrieval_config`** (§6.1–6.3),
  are query-time, and need **no reindex** — editable via `PATCH`. Reranking is on iff
  `reranker.model` is present; `query_enrichment.enabled` is **off** by default.
- **`context_mode: "image"` needs a vision-capable agent model** and page-image
  derivatives; it's available for every strategy **except `doc2json`**.
- **`GET /api/config/kb-defaults`** is authoritative for selectable options — don't hardcode.
