# 06 — Four-Person Parallel Execution Plan

Written for a ~40-hour hackathon. Adjust the clock, keep the ordering — the dependency structure is what matters.

---

## 0. The rule that makes parallelism actually work

> **Hours 0–2 are spent by all four people in the same room freezing the contracts. Nobody writes a feature until the interfaces are merged.**

Four people cannot work in parallel on a system whose interfaces are still moving. Two hours of joint contract design buys thirty hours of conflict-free parallel work. This is the highest-leverage decision in the whole plan, and the one teams most often skip.

### Hour 0–2 — Joint session (all four)

| Deliverable | Owner drafts | All review |
|---|---|---|
| `packages/contracts/schemas.py` — every Pydantic model | D | yes |
| OpenAPI stubs for all six services (endpoints return fixtures) | B | yes |
| `data/fixtures/` — 3 realistic SKUs with charts, 5 shopper profiles | C | yes |
| Fit Artifact JSON shape (frozen — everything depends on it) | D | yes |
| Repo skeleton, Docker Compose, CI pipeline green on an empty test | B | yes |
| Demo storyboard — decide the exact 8 minutes **now** | A | yes |

Deciding the demo on hour one is not premature. It tells everyone which 20% of the system must be beautiful and which 80% merely needs to work.

**Merge and freeze.** From hour 2, everyone codes against fixtures. No one is blocked on anyone.

---

## 1. Ownership map

| Dev | Domain | Primary directories | Never touches |
|---|---|---|---|
| **A** | Frontend & Widget | `apps/web-seller`, `apps/web-widget`, `apps/web-admin` | `services/*` internals |
| **B** | Platform & Hot Path | `services/gateway`, `services/fit-service`, `infra/`, `tests/load`, `.github/` | ML model code |
| **C** | Vision & Documents | `services/vision-service`, `ml/training/cv`, `ml/registry` | Frontend |
| **D** | AI/ML & Guardrails | `services/chart-service`, `services/privacy-service`, `packages/fit-core`, `packages/guardrails`, `ml/training/bayes` | Frontend |

Disjoint directories mean near-zero merge conflicts. Shared code lives in `packages/`, changed only by pull request with a second reviewer.

---

## 2. Dev A — Frontend & Widget

**Owns the two things judges look at.** If the demo is ugly, the architecture does not matter.

| Phase | Tasks |
|---|---|
| **H2–8** | Next.js 15 scaffold + Tailwind + shadcn. Seller Studio shell: SKU list, upload dropzone, chart table. Wire to fixtures. Generated TS types from `contracts` |
| **H8–16** | **Widget** — Preact, standalone bundle, `<script>` embed. Three input modes (measurements / brand anchor / photo). Budget: **< 30 KB gzipped** |
| **H16–22** | **On-device pose**: MediaPipe PoseLandmarker WASM → 33 keypoints → ratios → 64-d int8 embedding. Release the canvas buffer. Verify in DevTools that no image request exists |
| **H22–28** | **Body-zone heat map** (SVG silhouette, per-zone slack colouring) + **confidence bands** (Recharts). Chart diff viewer with v2→v3 highlighting |
| **H28–34** | Admin: fairness dashboard, cost-per-inference panel, audit-trace viewer. Loading/error/empty states. Mobile responsive |
| **H34–38** | Demo polish. Rehearse. Every click in the storyboard must be muscle memory |

**Watch out for:** the widget bundle silently bloating. Put a size check in CI at hour 8, not hour 30.

---

## 3. Dev B — Platform & Hot Path

**Owns the 150 ms number and the "clean microservices" score.**

| Phase | Tasks |
|---|---|
| **H2–8** | Docker Compose (Postgres+pgvector, Redis, MinIO, Prometheus, Grafana, Ollama). Alembic migrations. **Row-Level Security policies** — do this now, retrofitting is painful |
| **H8–14** | `gateway`: JWT RS256, tenant resolution, Redis token-bucket rate limiting, idempotency keys, RFC 7807 errors, OTel middleware |
| **H14–22** | **`fit-service` — the hot path.** Artifact fetch (in-process LRU → Redis → Postgres), call `fit-core`, template slot-fill, orjson response. Profile relentlessly |
| **H22–26** | **k6 load test.** 500 VUs. Get p99 on screen. If it is over 40 ms, profile before adding anything |
| **H26–32** | CI: ruff, mypy --strict, pytest >=80%, bandit, gitleaks, trivy, widget-size gate. Grafana dashboards as code |
| **H32–38** | K8s manifests + Helm chart (credibility, not deployed). Seed script. `make demo` brings everything up in one command |

**Watch out for:** treating the hot path like the other services. It has a different discipline — no ORM, no lazy loading, no per-request object graph construction.

---

## 4. Dev C — Vision & Documents

**Owns the "45 minutes → 10 seconds" claim.**

| Phase | Tasks |
|---|---|
| **H2–8** | Download DeepFashion2. Baseline landmark detection. **Solve scale calibration first** — ArUco detection + homography. This is the highest-risk unknown; do not defer it |
| **H8–14** | Segmentation (FastSAM-s) → mask → contour → per-zone measurement extraction with a confidence score per measurement |
| **H14–20** | OCR: PP-OCRv4 + PP-Structure on tech packs. Deskew, table-cell grid, header classification, unit normalisation, monotonicity check |
| **H20–26** | Export everything to **ONNX INT8**. Benchmark on CPU. Target: full garment pass under 3 s |
| **H26–30** | FashionCLIP embeddings + pgvector HNSW index → the retrieval half of Fit Prior Transfer |
| **H30–36** | Fine-tune RTMPose-t on DeepFashion2 if time allows (this is the first thing to cut). Prepare demo assets: 5 garments, one deliberately mismeasured for the outlier demo |
| **H36–38** | Buffer |

**Watch out for:** scale calibration eating the whole hackathon. Timebox it to hour 8. If ArUco is not working by then, ship the tech-pack-anchored ratio method (rung 4 of the ladder in [02-AI-DESIGN.md](02-AI-DESIGN.md) §5) and move on — it is genuinely good enough for the demo.

---

## 5. Dev D — AI/ML & Guardrails

**Owns 25% of the score (guardrails) plus 20% (AI depth). The heaviest load — protect this person's time.**

| Phase | Tasks |
|---|---|
| **H2–8** | `packages/fit-core`: **Garment Mechanics Engine** + coefficient YAML + ordinal fit math. Pure functions, property-tested with Hypothesis. Everything downstream depends on this — ship it first |
| **H8–14** | Bayesian hierarchical ordinal model in NumPyro on ModCloth/RTR. Export posteriors to `.npz`. Validate calibration (reliability diagram, not just accuracy) |
| **H14–18** | Brand transfer: Gaussian prior x anchor likelihood, Laplace approximation. Transcribe 8 Indian brand charts into `data/brand-charts/*.yaml` |
| **H18–26** | **LangGraph agent pipeline** — 7 nodes, typed state, retries, Redis checkpointing. Model router (deterministic, 3-tier). Artifact compiler |
| **H26–32** | **`packages/guardrails`**: Numeric Fidelity Check, plausibility bounds, injection scanner, PII scrubber, tone filter. Each with tests that *demonstrate the attack being blocked* |
| **H32–36** | `privacy-service`: consent lifecycle, erasure with signed receipt, hash-chained audit ledger + verification endpoint |
| **H36–38** | Fairness audit report. Model cards |

**Watch out for:** the Bayesian model becoming a research project. Timebox NUTS sampling to hour 14; if it will not converge, ship LightGBM + isotonic calibration behind the same interface and keep the Bayesian brand-transfer layer, which is the part that is actually novel. `fit-core`'s interface makes that swap a one-file change — design it that way deliberately.

---

## 6. Integration checkpoints (everyone stops and syncs)

| Hour | Gate | Must be true |
|---:|---|---|
| **H2** | Contracts frozen | Schemas merged, fixtures committed, CI green |
| **H12** | First end-to-end skeleton | Seller uploads → fake chart → widget shows fake recommendation. **Ugly is fine. Connected is not optional.** |
| **H20** | Real data flowing | CV measures a real garment; Bayesian model returns a real probability |
| **H28** | **Feature freeze** | Everything after this hour is bug-fixing, polish, and rehearsal |
| **H32** | Full demo rehearsal | End to end, on the clock, on the demo machine, on the demo network |
| **H36** | Final rehearsal | Twice through. Recorded as a backup |

**H12 matters more than it looks.** A connected ugly system at hour 12 always beats four beautiful disconnected components at hour 30. If H12 slips, cut scope immediately rather than hoping.

---

## 7. Cut list, in the order things get cut

Agree this list at hour 2, while everyone is calm. Cutting is much easier when it was pre-authorised.

1. `web-admin` fairness dashboard → static screenshot in the deck
2. RTMPose fine-tuning → use the pretrained checkpoint
3. EU/UK/JP localisation → keep IN and US only
4. K8s manifests → keep Docker Compose, show the manifests as files
5. NUTS Bayesian → LightGBM + isotonic behind the same interface
6. Voice/NL input → drop
7. Post-wash forecast → **do not cut**, it is a headline differentiator and it is nearly free once the GME exists

Never cut: the 150 ms proof, the privacy demo, the injection demo, or explainability. Those are 45% of the score between them.

---

## 8. Working agreements

- Trunk-based development, short-lived branches, PR required for `packages/`
- Conventional commits; CI must be green to merge
- A shared `DEMO.md` that anyone can follow if the presenter's laptop dies
- **Record a full backup demo video at hour 32.** Live demos fail; the video is insurance that costs 10 minutes
- Fixtures are sacred — if a fixture changes, announce it in the channel
