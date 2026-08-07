# 00 — Executive Brief: How We Win Track 6

## 1. Read the rubric before reading the problem

| Dimension | Weight | What most teams will do | What we will do |
|---|---:|---|---|
| Enterprise Security & Guardrails | **25%** | Bolt on a `.env` file and say "we use HTTPS" | A shippable **DPDP Act 2023 compliance module**, a hash-chained tamper-evident audit ledger, and *deterministic* LLM guardrails that make hallucinated measurements structurally impossible |
| Business Impact & ROI | 20% | Quote the 30–40% return stat from the brief | A live **Return-Risk simulator** with a defensible unit-economics model and a measured cost-per-transaction |
| AI Innovation & Depth | 20% | One big GPT-4 prompt reading an image | Bayesian hierarchical ordinal fit model + a physics-based Garment Mechanics Engine + multimodal **Fit Prior Transfer** for cold-start SKUs |
| Technical Excellence & Code | 20% | One `app.py`, 900 lines | Typed microservice monorepo, shared contracts, 80%+ coverage, CI security gates, k6 load proof |
| Cost Efficiency & Scalability | 15% | "We'd use GPT-4o" | 90% of SKUs cost **₹0** (rules-only path), blended ₹0.04/SKU, shopper path runs **client-side at ₹0** |

**The single most important insight: Security & Guardrails is weighted higher than any AI dimension.** The brief says so explicitly ("this is the single highest-weighted dimension in scoring"). Most hackathon teams treat this as paperwork. We treat it as the product. See [04-SECURITY-DPDP.md](04-SECURITY-DPDP.md).

## 2. The architectural decision that unlocks everything

The brief imposes two demands that look contradictory:

- *"Use multimodal embeddings and multi-agent orchestration"* → expensive, slow, non-deterministic
- *"Fit recommendations must return in under 150 ms"* → cheap, fast, deterministic

Naive teams will either drop the agents or blow the latency budget. Our answer:

> **Agents at write-time. Pure mathematics at read-time.**

A 7-agent LangGraph pipeline runs **once per SKU**, asynchronously, with a 10-second budget. It compiles everything it learns into a **~2 KB Fit Artifact** — a frozen vector of garment dimensions, per-zone ease coefficients, fabric mechanics parameters, and Bayesian ordinal cut-points.

At read-time the shopper request never touches a model. It fetches the artifact from Redis and evaluates a closed-form Gaussian ordinal expression — a few dozen floating-point operations. Target **p50 ≈ 8 ms, p99 ≈ 35 ms**, a 4× margin under the limit.

The artifact is small enough to ship to the browser, so the fit computation can also run **entirely client-side at zero marginal server cost and zero network latency**. That is our cost-efficiency headline.

## 3. The two user journeys

**Seller journey — 45 minutes → under 10 seconds**
Upload flat-lay images + tech pack PDF + fabric spec → multi-agent pipeline extracts, cross-validates, and flags → dynamic localized size chart (IN/US/EU/UK) with a plain-English reason attached to every single number.

**Shopper journey — under 150 ms**
"I'm a 32 in Levi's" *or* three body measurements *or* an on-device photo → Bayesian posterior over body dimensions → per-size fit probabilities with confidence bands, a body-zone tightness heat map, and a specific recommendation.

## 4. Non-negotiables we designed around

| Guardrail from the brief | Our mechanism | Provable how |
|---|---|---|
| < 150 ms per product-page request | Precompiled Fit Artifact + closed-form math, no model on the hot path | `tests/load/` k6 script prints measured p99 in the demo |
| Never persist raw user body photos | Pose extraction runs **in the browser** (MediaPipe WASM); only a 64-dim quantised embedding leaves the device. Server path is memory-only with a filesystem write guard | `tests/security/test_no_image_persistence.py` asserts zero disk writes |
| Explain every generated size | Numbers come from a deterministic engine; the LLM only *verbalises* an existing computation trace, and a **Numeric Fidelity Check** rejects any number not present in that trace | `packages/guardrails/` + property-based tests |
| Route SLM vs LLM, report cost | Three-tier difficulty router with a live cost meter exported to Prometheus | Grafana panel shown live in the demo |
| DPDP compliance from day one | Consent artifacts, purpose limitation, erasure API, retention TTLs, k-anonymity, hash-chained audit log | `services/privacy-service/` |

## 5. What we build beyond the brief

These exist to move *Business Impact* and *AI Innovation*, and each one is small enough to actually finish:

1. **Fit Prior Transfer** — a brand-new SKU with zero return history inherits fit corrections from visually and materially similar SKUs via FashionCLIP embeddings. Solves cold-start, which is the real blocker for small sellers.
2. **Post-Wash Size Forecast** — the chart shows dimensions at 0 washes *and* after 5 washes. Falls straight out of the fabric shrinkage model. No other team will show this.
3. **Brand Fit Passport** — a portable, signed, client-side fit profile. Works across sellers, stores zero PII server-side.
4. **Return-Risk Score at checkout** — predicted return probability plus a nudge; this is the direct line from our model to the 20–28% returns reduction claim.
5. **Body-zone tightness heat map** — where it pulls, rendered on a silhouette, driven by real per-zone slack values.
6. **Explainability Ledger** — hash-chained, replayable decision traces. Any recommendation can be reproduced months later with its exact model versions.
7. **Fairness dashboard** — fit accuracy broken out by body-shape cohort, with under-served segments flagged. Ethics as a feature, not a disclaimer.

Full detail in [07-INNOVATIONS-AND-DEMO.md](07-INNOVATIONS-AND-DEMO.md).

## 6. Document map

| Doc | Purpose |
|---|---|
| [01-ARCHITECTURE.md](01-ARCHITECTURE.md) | Services, data flow, folder structure, stack rationale |
| [02-AI-DESIGN.md](02-AI-DESIGN.md) | Multi-agent graph, Bayesian fit model, mechanics engine, model routing, datasets |
| [03-API-SPEC.md](03-API-SPEC.md) | REST contracts for every service |
| [04-SECURITY-DPDP.md](04-SECURITY-DPDP.md) | The 25% dimension, in full |
| [05-LATENCY-COST.md](05-LATENCY-COST.md) | Latency budget and unit economics |
| [06-TEAM-PLAN.md](06-TEAM-PLAN.md) | Four parallel workstreams, hour by hour |
| [07-INNOVATIONS-AND-DEMO.md](07-INNOVATIONS-AND-DEMO.md) | Differentiators and the 8-minute demo script |
