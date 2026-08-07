# 02 — AI System Design

This is the deepest document. It covers the multi-agent graph, the two mathematical engines, retrieval, model routing, the open-source model roster, and the datasets.

---

## 1. Why multi-agent here is genuine, not decorative

The brief warns against "one giant prompt doing everything." A multi-agent design is only justified when the sub-problems have **different input modalities, different failure modes, and different correctness criteria**. Ours do:

| Agent | Modality | Distinct failure mode | Correctness criterion |
|---|---|---|---|
| Vision | Pixels | Wrong scale calibration → all dims off by a constant factor | Calibration confidence + aspect-ratio sanity |
| Document | Scanned tables | OCR digit confusion (`8`↔`3`, `1`↔`7`) | Row/column monotonicity + unit coherence |
| Materials | Text composition | Unknown fibre blend | Composition sums to 100% ± 1% |
| Reconciliation | Numeric | Silent disagreement between sources | Divergence within tolerance band |
| Grading | Numeric | Non-monotonic size progression | Grade rules satisfied |
| Explainer | Language | Hallucinated numbers | **Numeric Fidelity Check** |
| Verifier | All | Accepting a broken chart | All gates pass |

Two independent estimates of the same physical quantity (camera and document) that are then reconciled is exactly what makes the outlier-detection requirement solvable. A single prompt could not do this, because it would have no independent second opinion to disagree with.

## 2. The agent graph (LangGraph)

```
                        ┌──────────────┐
                        │   INGEST     │  normalise assets, hash inputs
                        └──────┬───────┘
                 ┌─────────────┼─────────────┐        (parallel fan-out)
                 ▼             ▼             ▼
          ┌────────────┐ ┌────────────┐ ┌────────────┐
          │  VISION    │ │ DOCUMENT   │ │ MATERIALS  │
          │  agent     │ │ agent      │ │ agent      │
          └─────┬──────┘ └─────┬──────┘ └─────┬──────┘
                └──────────────┼──────────────┘
                               ▼
                    ┌────────────────────┐
                    │  RECONCILIATION    │──▶ outlier_score > τ ──▶ HUMAN REVIEW
                    │  (+ Fit Prior      │                          (blocks publish)
                    │     Transfer RAG)  │
                    └─────────┬──────────┘
                              ▼
                    ┌────────────────────┐
                    │  GRADING           │  size grading + IN/US/EU/UK localisation
                    └─────────┬──────────┘
                              ▼
                    ┌────────────────────┐
                    │  EXPLAINER (LLM)   │  language only — numbers are frozen
                    └─────────┬──────────┘
                              ▼
                    ┌────────────────────┐
                    │  VERIFIER          │──fail──▶ retry once ──▶ deterministic fallback
                    └─────────┬──────────┘
                              ▼
                     COMPILE FIT ARTIFACT → Redis + Postgres (versioned)
```

**State object** is a typed `TypedDict` carrying `sources`, `estimates`, `mechanics`, `trace`, and `flags`. Every node appends to `trace`, never mutates a prior node's numbers. The trace *is* the explanation and *is* the audit record — one structure serving both.

**Retries** are per-node with exponential backoff. **Checkpointing** to Redis means a crashed job resumes rather than restarting a 10-second pipeline.

---

## 3. Engine A — Garment Mechanics Engine (deterministic physics)

This is our answer to "stretch, fabric, regional body variation, and shrinkage after a wash." It contains **no LLM and no black box**. Every coefficient lives in a versioned YAML table, sourced from textile engineering literature and regressed against Cloth3D/VITON tension simulations.

```python
# packages/fit-core/mechanics.py  (illustrative)

def mechanics(fabric: FabricSpec) -> Mechanics:
    el = fabric.elastane_pct + fabric.spandex_pct

    # Mechanical stretch saturates — 10% elastane is not 2x of 5%
    stretch_pct = K_KNIT[fabric.structure] * (1 - exp(-ALPHA * el)) * gsm_factor(fabric.gsm)

    # You never wear a garment at maximum stretch. Comfort tension ratio ~0.35-0.55
    usable_stretch = {z: stretch_pct * COMFORT_TENSION[z] for z in ZONES}

    # Shrinkage: cellulosic fibres shrink, synthetics do not; knits shrink more than wovens
    shrinkage_pct = (BASE_SHRINK[fabric.structure] * fabric.cellulosic_frac
                     + VISCOSE_PENALTY * fabric.viscose_pct
                     - PRESHRUNK_CREDIT * fabric.is_preshrunk)

    drape_coeff = DRAPE_REG.predict(fabric.gsm, fabric.weave, fabric.bending_rigidity)
    return Mechanics(usable_stretch, shrinkage_pct, drape_coeff, recovery_pct=...)
```

Effective garment dimension for zone *z*, size *s*, after *w* washes:

```
effective(z,s,w) = garment_dim(z,s)
                   x (1 - shrinkage(z) . saturating(w))     <- post-wash forecast
                   + usable_stretch(z) . garment_dim(z,s)   <- elastane give
```

**This single function produces the brief's exact required explanation format.** Zero elastane ⇒ `usable_stretch = 0` ⇒ the ease term must absorb the entire allowance ⇒ *"waist +1.5 cm for zero-stretch denim."* The sentence is not written by a model; it is a rendering of the arithmetic.

## 4. Engine B — Bayesian hierarchical ordinal fit model

The brief names "Bayesian body-metrics estimation" as core. We do it properly.

### 4.1 The latent-variable formulation

For body **b**, garment **g**, size **s**, zone **z**:

```
required(z)  = body(z) + ease_min(z | style, fit_intent)
slack(z)     = effective(z,s,w) - required(z)
u(z)         = slack(z) / sigma(z)
```

`sigma(z)` is the **total uncertainty** for that zone — the quadrature sum of CV/OCR extraction error, population measurement noise, and fabric lot variance. Carrying uncertainty through instead of discarding it is what makes the output a calibrated probability rather than a guess.

A garment fits badly if **any** zone binds, so we aggregate with a soft-minimum rather than a mean:

```
U_tight = -tau . log SUM_z exp(-u(z)/tau)     # differentiable min -> the binding constraint
U_loose = SUM_z w(z) . u(z)                   # weighted mean -> overall roominess
```

Ordinal likelihood with learned cut-points `c1 < c2`:

```
P(too small) = Phi((c1 - U_tight)/s)
P(good fit)  = Phi((c2 - U_loose)/s) - Phi((c1 - U_tight)/s)
P(too large) = 1 - Phi((c2 - U_loose)/s)
```

### 4.2 The hierarchy

Cut-points and scale get **partial pooling** across a three-level hierarchy:

```
c[category, brand] ~ Normal(c[category], sigma_brand)
c[category]        ~ Normal(c[global],   sigma_category)
```

This is the statistically correct way to handle a new brand with 12 data points: it borrows strength from its category rather than overfitting or falling back to a flat global average. It is also, conveniently, exactly why "brand vanity sizing" is handled automatically — a brand that runs small gets a shifted cut-point learned from data.

### 4.3 Training vs serving

- **Train offline** with **NumPyro** (JAX NUTS) on ModCloth + RentTheRunway. Roughly 82k labelled fit outcomes.
- **Export** posterior means and covariances to a small `.npz`.
- **Serve** with plain NumPy: two `Phi()` evaluations per size, ~10 sizes. **Sub-millisecond.**

Full Bayesian rigour offline; closed-form arithmetic online. This is the entire trick behind the latency budget.

### 4.4 Brand transfer — "I'm an M in Levi's"

This is Bayesian inference in its natural form:

```
prior:      p(body | height, weight, gender, region)     <- Gaussian, from RTR/ModCloth
                                                            + Indian anthropometric priors
likelihood: p(fit="good" | body, levis_511_M_spec)       <- the ordinal model above
posterior ~ prior x likelihood                           <- Laplace approximation -> Gaussian
```

One anchor tightens the posterior substantially; two or three anchors from different brands tighten it dramatically. And because the posterior is Gaussian, it composes: the shopper's Brand Fit Passport is just a mean vector and a covariance, ~200 bytes, storable client-side.

We report the **credible interval**, not a point estimate: *"We're 82% confident L fits. There's a 14% chance it's snug at the shoulders."* Honest uncertainty is more persuasive than false precision, and it is genuine explainability.

## 5. Computer vision pipeline

```
flat-lay image
  -> FastSAM-s / YOLOv8n-seg     : garment mask                      ~15 ms CPU
  -> RTMPose-t (DeepFashion2 FT) : 294 landmarks, 13 categories       ~8 ms CPU
  -> scale calibration            : ArUco marker > A4 sheet > known
                                    reference object > category prior
  -> pixel -> cm via homography   : corrects perspective skew
  -> measurement extraction       : chest/waist/hip/shoulder/sleeve/length
  -> confidence per measurement   : landmark score x calibration quality
```

**Scale calibration is the hard part** and it is where naive solutions break. Our ladder, best to worst, with confidence degrading at each rung:

1. ArUco marker in frame → near-exact, confidence 0.98 (we print one and include it in the seller onboarding kit — a genuinely practical product decision)
2. A4/Letter sheet detected → confidence 0.90
3. Any known reference object (credit card, ruler) → confidence 0.85
4. Tech-pack OCR provides one absolute dimension → CV supplies the rest by ratio → confidence 0.80
5. Category prior only → confidence 0.45, **forces human review**

Confidence propagates into `sigma(z)` in the fit model, so a poorly calibrated photo produces wider credible intervals rather than a confidently wrong answer. That is exactly the behaviour an enterprise reviewer wants to see.

## 6. OCR and document understanding

```
tech pack (PDF / photo / scan)
  -> deskew + denoise (OpenCV)
  -> PP-OCRv4 mobile det+rec                      ~40 ms CPU per page
  -> PP-Structure table model -> cell grid
  -> header classification (rules first, SLM fallback)
  -> unit normalisation: in > cm, 1/2" > 1.27 cm, "38-40" > range
  -> Pydantic schema validation
  -> row/column monotonicity check (sizes must increase)
```

If rules parse cleanly with high OCR confidence, **no model is called at all**. That is the Rs 0 path, and it covers the majority of well-formed tech packs. Messy layouts escalate to Qwen2.5-VL-3B; genuinely ambiguous ones escalate to a frontier LLM. See §8.

## 7. Retrieval — where it genuinely earns its place

We use retrieval in exactly two places, both of which solve a real problem rather than decorating the architecture.

### 7.1 Brand chart retrieval (text/structured RAG)
A pgvector store of published brand size charts — Levi's India, Allen Solly, Van Heusen, Fabindia, Biba, W, Jockey India, Uniqlo, Zara, H&M. Query: *"M in Levi's 511"* → embed with `bge-small-en-v1.5` → retrieve the canonical spec → feed as the likelihood anchor in §4.4. Charts are stored as structured YAML in `data/brand-charts/` with a source URL and retrieval date, so nothing is fabricated.

### 7.2 Fit Prior Transfer (multimodal embedding retrieval) — **our strongest novelty**

**The problem nobody else will solve:** a brand-new SKU has zero return history. Its ease coefficients are therefore pure category defaults — the very thing that causes bad charts today.

**Our solution:** embed the garment image with **FashionCLIP** (512-d) and concatenate a normalised fabric-mechanics vector. Find the *k* nearest historical SKUs in pgvector (HNSW), restricted to the same category. Those neighbours have *return-derived ease corrections* learned from real customers. Transfer them, weighted by similarity and by the neighbour's own evidence count:

```
ease_prior(z) = SUM_i w_i . ease_correction(SKU_i, z)   /   SUM_i w_i
w_i = cosine_sim(embedding, embedding_i)^gamma . log(1 + n_returns_i)
```

A new slim-fit stretch chino inherits the shoulder and thigh corrections that similar chinos earned the hard way. **Day-one accuracy without day-one data.** This is a real cold-start solution, it is measurable in the eval harness, and it is the single thing most likely to make a judge sit up.

## 8. Model routing — small models first, cost reported

Three tiers, chosen by measurable difficulty signals, never by guesswork:

| Tier | Trigger | Model | Share | Cost / SKU |
|---|---|---|---|---|
| **0 — Rules** | OCR confidence > 0.92, known category, table parses, composition sums to 100% | None | ~70% | **Rs 0.00** |
| **1 — SLM** | Messy layout, unit ambiguity, unknown fibre alias | Qwen3-4B-Instruct Q4_K_M via Ollama (local) | ~22% | ~Rs 0.015 (electricity) |
| **2 — VLM/LLM** | Handwritten tech pack, conflicting sources, novel category, Reconciliation divergence > tolerance | Qwen2.5-VL-7B local, escalating to a hosted frontier model only for the top ~2% | ~8% | ~Rs 0.35 |

**Blended ≈ Rs 0.032 per SKU chart.** The shopper hot path calls **no model at all**: ~Rs 0.0002 per request, and Rs 0 when the widget evaluates the artifact client-side.

The router itself is a 30-line deterministic function over confidence scores — not a model. Judging a model's difficulty with another model would be both slower and less auditable. Every routing decision is logged with its trigger, so the cost table in the demo is measured from telemetry, not estimated on a slide.

## 9. Open-source model roster

Everything below is free, permissively licensed, and CPU-viable after INT8 quantisation.

| Purpose | Model | Size | CPU latency | License |
|---|---|---|---|---|
| Garment segmentation | `FastSAM-s` or `YOLOv8n-seg` | 23 MB | ~15 ms | Apache-2.0 / AGPL* |
| Garment landmarks | `RTMPose-t` fine-tuned on DeepFashion2 | 14 MB | ~8 ms | Apache-2.0 |
| OCR | `PP-OCRv4-mobile` (det + rec) | 12 MB | ~40 ms/page | Apache-2.0 |
| Table structure | `PP-StructureV2` table | 9 MB | ~30 ms | Apache-2.0 |
| Multimodal embedding | `patrickjohncyh/fashion-clip` | 600 MB | ~35 ms | MIT |
| Text embedding | `BAAI/bge-small-en-v1.5` | 133 MB | ~6 ms | MIT |
| SLM | `Qwen3-4B-Instruct` Q4_K_M | 2.5 GB | ~40 tok/s | Apache-2.0 |
| VLM | `Qwen2.5-VL-7B` Q4 | 5 GB | ~18 tok/s | Apache-2.0 |
| On-device pose | MediaPipe `PoseLandmarker Lite` (WASM) | 3 MB | ~25 ms in-browser | Apache-2.0 |
| Bayesian inference | NumPyro / JAX (train) → NumPy (serve) | — | < 1 ms serve | Apache-2.0 / BSD |
| Tabular calibration | LightGBM + isotonic regression | — | < 1 ms | MIT |

\* Prefer FastSAM (Apache-2.0) over YOLOv8-seg where licensing matters for a commercial pitch — worth one sentence in the write-up, because judges notice license awareness.

## 10. Datasets

| Dataset | Source | Used for |
|---|---|---|
| **ModCloth & RentTheRunway Size & Fit** | UCSD / Kaggle, 82k+ records | Training the Bayesian ordinal fit model; body-shape cohorts; brand random effects. This is the primary training set — it has exactly the (body, item, size, fit-label) tuples we need |
| **DeepFashion2** | MMLab CUHK, 800k+ images | Fine-tuning the landmark detector; garment category classification; flat-lay dimension extraction |
| **Cloth3D + VITON-HD** | GitHub / Kaggle | Regressing drape coefficient and per-zone tension from GSM/weave; validating the stretch model against simulated garment-on-body tension |
| **Published Indian brand charts** | Public brand size pages (Levi's India, Allen Solly, Van Heusen, Fabindia, Biba, W, Jockey) | Regional localisation and brand anchors. Transcribed into `data/brand-charts/*.yaml` with source URL + retrieval date — **real data, per the brief's instruction not to generate any** |
| Indian anthropometric priors | Published population studies | Regional body-distribution priors for the Bayesian model |

**Honest data note for the write-up:** ModCloth/RTR skew toward women's Western sizing. We disclose this as a known limitation, quantify it in the fairness audit, and treat Indian brand anchoring as the mitigation. Naming your dataset's weaknesses before a judge does is worth more than pretending they do not exist.

## 11. Explainable AI — the full chain

Every number a shopper or seller sees is traceable to arithmetic:

```
"Recommended: L (82% confident)"
  '- binding zone: shoulder, slack -1.8 cm at M vs +0.9 cm at L
      '- required_shoulder = body_shoulder(44.1 +/- 1.2 cm) + ease_min(1.5 cm, slim fit)
          '- body_shoulder from Bayesian posterior
              '- prior: height 178 cm, weight 74 kg, region IN
              '- anchor: "M in Levi's 511" -> likelihood update
      '- effective_shoulder(L) = 46.5 cm x (1 - 0.021 shrinkage) + 0.0 stretch
          '- shrinkage 2.1%: 98% cotton, woven, not pre-shrunk
          '- stretch 0.0%:   0% elastane  => "zero-stretch denim"
```

The **Explainer Agent** renders this trace into prose. It receives the trace and a set of approved phrasings; it may reorder, condense, and humanise. It may **not** introduce a number. The **Numeric Fidelity Check** (see [04-SECURITY-DPDP.md](04-SECURITY-DPDP.md) §5) extracts every numeric token from the generated text and asserts each one appears in the trace within tolerance. A failure falls back to a deterministic template.

The consequence is strong and worth stating plainly in the pitch: **it is not possible for this system to show a shopper a hallucinated measurement.** Not unlikely — structurally impossible.

## 12. Continuous learning loop

```
return event ("too tight at shoulders", SKU-123, size M)
  -> fit-reason classifier (rules + SLM for free-text) -> canonical zone + direction
  -> Bayesian update of that SKU's ease posterior for that zone
  -> if |delta ease| > threshold and evidence n >= 8 -> re-issue chart v(n+1)
  -> diff surfaced to seller: "v3: shoulder +0.8 cm - driven by 14 'too tight' returns"
  -> corrected ease propagates to similar SKUs via Fit Prior Transfer (§7.2)
```

The loop closes: real returns improve the chart, and the improvement generalises to garments the model has never seen. That is the mechanism behind the 20–28% returns-reduction target, and it is measurable in the eval harness rather than asserted on a slide.
