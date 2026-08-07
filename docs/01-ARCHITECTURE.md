# 01 — System Architecture

## 1. The governing principle

> **Expensive, non-deterministic AI runs once per SKU at write-time.
> The shopper hot path is deterministic arithmetic over a precompiled artifact.**

Everything below follows from that split. It is what lets us satisfy "multi-agent orchestration + multimodal embeddings" and "under 150 ms" at the same time, instead of trading one against the other.

## 2. Top-level topology

```
                         ┌──────────────────────────────────────┐
   SELLER STUDIO ───────▶│  gateway  (FastAPI, authn/z, quotas) │
   (Next.js 15)          └──────────────┬───────────────────────┘
                                        │
        ┌───────────────────────────────┼──────────────────────────────┐
        │                               │                              │
        ▼  WRITE PATH (async, ≤10s)     ▼  HOT PATH (<150ms)           ▼
┌───────────────────┐          ┌──────────────────┐        ┌────────────────────┐
│  chart-service    │          │   fit-service    │        │  privacy-service   │
│  LangGraph, 7     │          │  closed-form     │        │  consent, erasure, │
│  specialist agents│          │  Bayesian ordinal│        │  audit ledger      │
└─────┬──────┬──────┘          │  NO model calls  │        └────────────────────┘
      │      │                 └────────┬─────────┘
      ▼      ▼                          │
┌───────────────┐  ┌──────────────┐     │  reads 2 KB Fit Artifact
│vision-service │  │feedback-svc  │     ▼
│ CV + OCR ONNX │  │returns→Bayes │  ┌─────────┐
└───────────────┘  └──────────────┘  │  Redis  │◀── artifact published on chart approval
                                     └─────────┘
        ▲                                 ▲
        │                                 │
   ┌────┴─────────────────────────────────┴──────────────────┐
   │  PostgreSQL 16 + pgvector   │   MinIO (garment images    │
   │  SKUs, charts, consents,    │   ONLY — never body photos)│
   │  audit chain, embeddings    │                            │
   └─────────────────────────────┴────────────────────────────┘

   SHOPPER  ──▶  fit-widget (<30 KB embeddable JS)
                 • MediaPipe Pose runs IN-BROWSER (WASM)
                 • raw pixels never leave the device
                 • can evaluate the Fit Artifact locally → 0 ms, ₹0
```

## 3. Services and their single responsibilities

| Service | Language / Runtime | Owns | Latency budget |
|---|---|---|---|
| `gateway` | FastAPI + uvloop | JWT auth, tenant isolation, rate limits, idempotency keys, request signing | +3 ms |
| `fit-service` | FastAPI + NumPy | The hot path. Artifact lookup → ordinal fit probabilities → explanation slot-fill | **p99 < 35 ms** |
| `chart-service` | FastAPI + LangGraph | Multi-agent SKU pipeline, artifact compilation, chart versioning | ≤ 10 s async |
| `vision-service` | FastAPI + ONNX Runtime | Garment segmentation, landmark detection, scale calibration, OCR, table structure | ≤ 3 s |
| `privacy-service` | FastAPI | DPDP consent lifecycle, data-principal rights, retention sweeper, hash-chained audit log | +5 ms |
| `feedback-service` | FastAPI + APScheduler | Returns ingestion, fit-reason classification, Bayesian ease updates, chart re-issue | batch |

Why microservices and not a monolith: the brief explicitly scores "clean, scalable microservices with low-latency API handling," and more practically, it lets four people work without merge conflicts. Each service is independently deployable and owns no other service's tables.

## 4. Shared packages (the anti-duplication layer)

| Package | Contents | Why it is shared |
|---|---|---|
| `packages/contracts` | Pydantic v2 models + generated JSON Schema + generated TypeScript types | One source of truth for every API boundary; frontend types are generated, never hand-written |
| `packages/fit-core` | Garment Mechanics Engine + ordinal fit math. **Pure functions, zero I/O, zero network** | Same code runs in `fit-service`, in `chart-service` validation, in offline evals, and is transpiled to TS for the client-side widget |
| `packages/guardrails` | Numeric Fidelity Check, physical plausibility bounds, prompt-injection sanitiser, PII scrubber, tone filter | Guardrails must be impossible to bypass by forgetting to import them; each service wires them in middleware |
| `packages/telemetry` | OpenTelemetry setup, structured logging, **cost meter** | Cost-per-inference is a scored deliverable — it needs to be measured, not estimated |

`fit-core` being pure is the keystone. It makes the fit maths trivially unit-testable, property-testable, and portable to the browser.

## 5. Data flow — seller journey

```
1. POST /v1/skus                      → SKU shell created, tenant-scoped
2. POST /v1/skus/{id}/assets          → flat-lay + tech pack to MinIO (presigned)
3. POST /v1/skus/{id}/generate-chart  → 202 Accepted + job_id
                                        └─▶ Redis Stream "chart.jobs"
4. chart-service consumes → LangGraph run:
     Vision Agent      → pixel dims + calibration confidence
     Document Agent    → OCR'd tech-pack table → canonical spec
     Materials Agent   → fabric → stretch / shrinkage / drape params
     Reconciliation    → cross-validate CV vs OCR vs category prior → outlier score
     Grading Agent     → size grading + regional localisation
     Explainer Agent   → verbalise the computation trace (numbers frozen)
     Verifier Agent    → schema + monotonicity + fidelity gate → accept / retry / escalate
5. Chart v1 persisted (versioned) + Fit Artifact compiled → Redis
6. GET /v1/skus/{id}/chart            → chart + per-number explanations + confidence
```

Anything the Reconciliation Agent flags as an outlier **blocks publication** and routes to a human review queue. That is the brief's "flag inaccurate seller measurements before listings go live," implemented as a hard gate rather than a warning banner.

## 6. Data flow — shopper journey (the 150 ms path)

```
Browser widget
  ├─ Option A: user types height/weight/(optional chest,waist,hip)
  ├─ Option B: "I'm M in Levi's 511"  → brand anchor
  └─ Option C: photo → MediaPipe Pose in WASM → 33 keypoints → ratios
                                                → RAW IMAGE DISCARDED IN-PAGE

  POST /v1/fit/recommend  { sku_id, anchors, consent_id }   ← no image, ever
        │
        ▼
  fit-service
    1. Redis GET fit_artifact:{sku_id}          ~0.4 ms  (in-process LRU in front)
    2. Body posterior: Gaussian prior × brand-anchor likelihood (Laplace approx)
    3. For each size: per-zone slack → soft-min → ordinal Φ() → P(small/fit/large)
    4. Binding-constraint extraction → explanation slot-fill from frozen templates
    5. Emit audit event (async, off the response path)
        │
        ▼
  { recommended: "L", confidence: 0.82, per_size: [...],
    zones: { shoulder: -1.8, chest: +0.4, waist: +2.1 },
    why: ["L clears your shoulders by 0.9 cm; M is 1.8 cm short",
          "Waist +1.5 cm applied: zero-stretch denim, 0% elastane",
          "Post-5-wash forecast: chest shrinks 2.1 cm — L still fits"] }
```

Steps 2–4 are pure NumPy on arrays of length ≤ 10. Measured cost is well under 1 ms; the budget is dominated by network and serialisation, which is why we use `orjson` and keep the payload under 4 KB.

## 7. Technology stack, and why each choice

### Frontend
| Choice | Rationale |
|---|---|
| **Next.js 15 (App Router) + TypeScript** | Seller Studio needs server components for fast catalog lists and a rich upload UX |
| **Tailwind + shadcn/ui** | Judge-visible polish in hours, not days; accessible primitives out of the box |
| **Vanilla TS + Preact for the widget** | The embeddable Fit Assistant must be **< 30 KB gzipped** and drop into any seller's page via one `<script>` tag. Shipping React there would be malpractice |
| **MediaPipe Tasks Vision (WASM)** | On-device pose. This is the privacy guarantee, not a nice-to-have |
| **Recharts / D3** | Confidence bands and the body-zone heat map |

### Backend
| Choice | Rationale |
|---|---|
| **Python 3.12 + FastAPI + uvloop + orjson** | Async, native OpenAPI generation, and the fastest practical Python JSON path |
| **Pydantic v2** | Rust-backed validation; our contracts *are* our guardrails |
| **LangGraph** | Typed state graph with explicit topology, checkpointing, and per-node retries. Demonstrably "not one giant prompt" |
| **Redis Streams** (not Kafka) | Real durable queueing with consumer groups, one container instead of five. Correct call for a hackathon that must still look enterprise-grade |
| **ONNX Runtime** | INT8-quantised CV models on CPU. No GPU required for the demo — a real cost-efficiency argument |

### Data
| Choice | Rationale |
|---|---|
| **PostgreSQL 16 + pgvector** | Relational integrity for charts/consents *and* HNSW vector search for Fit Prior Transfer in one engine. One fewer moving part than a separate vector DB |
| **Row-Level Security** | Tenant isolation enforced by the database, not by a `WHERE` clause someone might forget |
| **Redis** | Fit Artifact cache. Sub-millisecond, and the artifact is the only thing on the hot path |
| **MinIO** | S3-compatible object store for **garment** assets only. Body photos have no storage path in the system at all |

### Ops
OpenTelemetry → Prometheus → Grafana; `structlog` JSON logs; Docker Compose for the demo with Kubernetes manifests and a Helm chart committed for credibility; GitHub Actions running ruff, mypy --strict, pytest (80% gate), bandit, gitleaks, trivy, and a model-eval regression gate.

## 8. Repository layout

```
fitchart/
├── apps/
│   ├── web-seller/          # Next.js Seller Studio
│   ├── web-widget/          # Embeddable Fit Assistant (<30 KB, Preact)
│   └── web-admin/           # Governance, fairness & cost dashboards
├── services/
│   ├── gateway/             # authn/z, rate limiting, tenant routing
│   ├── fit-service/         # HOT PATH — <150 ms, no model calls
│   ├── chart-service/       # LangGraph multi-agent orchestration
│   ├── vision-service/      # CV + OCR, ONNX Runtime
│   ├── privacy-service/     # DPDP consent, erasure, audit ledger
│   └── feedback-service/    # returns → Bayesian ease updates
│       └── (each: app/{api,core,domain,adapters}, tests/, Dockerfile, pyproject.toml)
├── packages/
│   ├── contracts/           # Pydantic models → JSON Schema → TS types
│   ├── fit-core/            # GME + ordinal maths (pure, portable)
│   ├── guardrails/          # fidelity, plausibility, injection, PII, tone
│   └── telemetry/           # OTel + cost meter
├── ml/
│   ├── training/            # Bayesian ordinal, GME regression, landmark finetune
│   ├── registry/            # ONNX artifacts, model cards, version manifest
│   ├── evals/               # eval harness + CI regression gates + fairness audit
│   └── notebooks/
├── infra/
│   ├── docker/              # compose.yml, per-service Dockerfiles
│   ├── k8s/                 # manifests + Helm chart
│   └── grafana/             # dashboards as code
├── data/
│   ├── raw/ processed/      # ModCloth, RentTheRunway, DeepFashion2, Cloth3D
│   └── brand-charts/        # published Indian brand size charts (YAML)
├── tests/
│   ├── unit/ integration/
│   ├── load/                # k6 — proves the p99 number live
│   └── security/            # no-persistence, injection, RLS, erasure proofs
├── docs/
└── .github/workflows/
```

## 9. Deployment

**Demo:** `docker compose up` brings the whole system up on a laptop with no GPU — six services, Postgres, Redis, MinIO, Prometheus, Grafana, and Ollama serving a quantised SLM.

**Production story for the pitch:** each service scales independently; `fit-service` is stateless and horizontally scalable behind a load balancer with the artifact cache warmed from Redis; `chart-service` scales on Redis Stream lag; CV models run on CPU node pools, so a GPU is only needed for offline retraining. Artifacts are immutable and versioned, which makes rollback a pointer swap.
