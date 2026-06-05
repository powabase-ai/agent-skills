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

**`extraction_status` enum** — `pending` → `extracting` → terminal one of
`extracted` · `attention_required` · `failed` · `cancelled`.

> `attention_required` is a **success-ish** terminal state (some pages failed but
> the source is still indexable). Treat it as "done", not "retry". Poll until the
> status is in the terminal set:

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

## 6. Embeddings & reranking

- **Embedding model** default `text-embedding-3-small` (OpenAI, 1536 dims). All
  chunks in a KB must share one model — changing it requires a reindex. pgvector
  **HNSW caps at 2000 dims**: `text-embedding-3-large` (3072) falls back to a slow
  sequential scan. Cohere/Voyage/Google/Mistral models are supported via LiteLLM
  but need their platform-level API keys configured by an admin.
- **Reranking** (optional, precision boost): a cross-encoder re-scores a candidate
  pool (default `candidate_count=20`) then returns `top_k`. Providers: Cohere
  (default), Jina, Voyage, ZeroEntropy. Reranker API keys are **platform-managed**.
  Enable per strategy / per search request. `GET /api/config/kb-defaults` lists the
  selectable rerankers authoritatively.

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

- **`source_id` vs `indexed_source_id`** (§2) — the #1 source of 404s.
- **`chunk_overlap` vs `overlap`** — docs inconsistent; examples use `overlap`. Verify live.
- **`tree_search` ⇒ PageIndex only; `build-bm25`/`full_text`/`hybrid` ⇒ need a BM25 index.**
- **`text-embedding-3-large` (3072) > HNSW's 2000-dim limit** → slow sequential scan.
- **`full_document` summary truncates at ~32K tokens**; reindex destroys + recreates all artifacts.
- **Non-OpenAI embedding/reranker providers need platform keys** (admin).
- **`GET /api/config/kb-defaults`** is authoritative for selectable options — don't hardcode.
