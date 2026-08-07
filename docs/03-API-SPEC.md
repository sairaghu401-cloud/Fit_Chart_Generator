# 03 — REST API Specification

Conventions: `/v1` prefix, JSON, `snake_case`, RFC 7807 `application/problem+json` errors, ISO-8601 UTC timestamps, cursor pagination. Every mutating call accepts `Idempotency-Key`. Every response carries `X-Request-Id` and `X-Model-Versions`.

Auth: `Authorization: Bearer <JWT>` with `tenant_id`, `scopes`, `exp`. Shopper widget calls use a short-lived, SKU-scoped public token — never a seller token.

---

## 1. `fit-service` — the hot path (< 150 ms)

### `POST /v1/fit/recommend`
The single most important endpoint in the system. **Accepts no image under any circumstances.**

```jsonc
// Request
{
  "sku_id": "sku_01HQ8...",
  "region": "IN",
  "consent_id": "cns_01HQ9...",          // required when body data is present
  "body": {                               // Option A - direct measurements
    "height_cm": 178, "weight_kg": 74,
    "chest_cm": 98, "waist_cm": 84,       // optional
    "fit_preference": "regular"           // slim | regular | relaxed
  },
  "brand_anchors": [                      // Option B - "I'm M in Levi's"
    { "brand": "levis", "style": "511", "size": "M", "outcome": "good" }
  ],
  "pose_embedding": {                     // Option C - from IN-BROWSER pose only
    "vector_q8": "base64...",             // 64-dim int8, ~88 bytes
    "model": "mediapipe-pose-lite@1.0",
    "extracted_on": "client"              // server rejects "server" without explicit consent scope
  },
  "wash_horizon": 5                       // post-wash forecast
}
```

```jsonc
// 200 OK  - p99 target 35 ms
{
  "recommended_size": "L",
  "confidence": 0.82,
  "credible_interval": { "lower": "M", "upper": "L" },
  "per_size": [
    { "size": "M", "p_small": 0.61, "p_fit": 0.36, "p_large": 0.03, "binding_zone": "shoulder" },
    { "size": "L", "p_small": 0.09, "p_fit": 0.82, "p_large": 0.09, "binding_zone": "waist"   },
    { "size": "XL","p_small": 0.01, "p_fit": 0.31, "p_large": 0.68, "binding_zone": null      }
  ],
  "zone_slack_cm": { "shoulder": 0.9, "chest": 2.4, "waist": 3.1, "sleeve": 1.2 },
  "explanations": [
    { "text": "L clears your shoulders by 0.9 cm. M would be 1.8 cm short - the most common reason this style gets returned.",
      "evidence": ["body.shoulder=44.1+/-1.2", "garment.shoulder.L=46.5", "ease_min.slim=1.5"] },
    { "text": "Waist allowance +1.5 cm applied: this is zero-stretch denim (0% elastane).",
      "evidence": ["fabric.elastane_pct=0", "mechanics.usable_stretch.waist=0.0"] },
    { "text": "After 5 washes the chest shrinks about 2.1 cm. L still fits; M would not.",
      "evidence": ["mechanics.shrinkage_pct=0.021", "wash_horizon=5"] }
  ],
  "return_risk": { "score": 0.11, "band": "low", "baseline": 0.34 },
  "privacy": { "raw_image_retained": false, "body_data_ttl_days": 0, "processed": "client" },
  "trace_id": "trc_01HQA...",
  "latency_ms": 11
}
```

Errors: `400` invalid body bounds · `403` missing/expired consent · `404` no published chart for SKU · `422` insufficient anchors · `429` rate limited.

### `GET /v1/fit/artifact/{sku_id}`
Returns the ~2 KB Fit Artifact so the widget can compute **entirely client-side** (0 ms network, Rs 0 server cost).

```jsonc
{
  "sku_id": "sku_01HQ8...", "artifact_version": 3,
  "sizes": ["S","M","L","XL"],
  "zones": ["shoulder","chest","waist","hip","sleeve","length"],
  "dims_cm": [[43.0,96,80,98,58,68], [44.5,100,84,102,59,70], /* ... */],
  "ease_min_cm":    { "slim": [1.5,4,3,4,0,0], "regular": [2.5,8,6,7,0,0] },
  "mechanics": { "usable_stretch_pct": [0,0,0,0,0,0], "shrinkage_pct": 0.021, "drape": 0.41 },
  "cutpoints": [-0.87, 1.24], "scale": 0.63,
  "issued_at": "2026-08-07T14:30:00Z", "model_versions": { "ordinal": "1.4.0", "gme": "0.9.2" }
}
```

### `POST /v1/fit/feedback`
Post-purchase fit outcome. Feeds the continuous-learning loop.

---

## 2. `chart-service` — seller write path

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/skus` | Create SKU shell (name, category, brand, fabric spec) |
| `POST` | `/v1/skus/{id}/assets` | Presigned MinIO upload for flat-lay / tech pack |
| `POST` | `/v1/skus/{id}/generate-chart` | **202 Accepted** + `job_id`; enqueues the agent pipeline |
| `GET` | `/v1/jobs/{job_id}` | Job status + live per-agent progress (SSE available) |
| `GET` | `/v1/skus/{id}/chart` | Current published chart with per-cell explanations |
| `GET` | `/v1/skus/{id}/chart/versions` | Version list |
| `GET` | `/v1/skus/{id}/chart/diff?from=2&to=3` | **Chart diff** — "waist +1.2 cm, driven by 14 returns" |
| `POST` | `/v1/skus/{id}/chart/publish` | Publish → compiles artifact → Redis. Blocked if outliers unresolved |
| `GET` | `/v1/skus/{id}/trace` | Full agent decision trace (the audit view) |

### `GET /v1/skus/{id}/chart`

```jsonc
{
  "sku_id": "sku_01HQ8...", "version": 3, "status": "published",
  "generated_in_ms": 7420,
  "regions": {
    "IN": { "sizes": [
      { "label": "M", "chest_cm": 100, "waist_cm": 84, "shoulder_cm": 44.5,
        "confidence": 0.91,
        "explanations": {
          "waist_cm": "84 cm = body waist 81 cm + 3 cm ease. No stretch credit: 0% elastane.",
          "chest_cm": "100 cm from tech pack (OCR conf 0.96), confirmed by flat-lay CV at 99.4 cm - 0.6% divergence, within tolerance."
        },
        "post_wash": { "washes": 5, "chest_cm": 97.9, "waist_cm": 82.2 } }
    ]},
    "US": { "...": "..." }, "EU": { "...": "..." }, "UK": { "...": "..." }
  },
  "outlier_flags": [
    { "field": "sleeve_cm", "size": "XL", "severity": "high",
      "reason": "Tech pack states 64 cm; CV measures 61.2 cm (4.4% divergence, tolerance 2.5%). Also breaks grade rule: XL-L = 0.5 cm vs expected 1.5 cm.",
      "action": "blocks_publish", "suggested_value": 62.5 }
  ],
  "provenance": { "cv_model": "rtmpose-t-df2@1.2.0", "ocr": "ppocr-v4-mobile",
                  "route_tier": 1, "cost_inr": 0.014, "trace_hash": "sha256:9f2a..." }
}
```

The `outlier_flags` block with `"action": "blocks_publish"` is the brief's "flag inaccurate seller measurements before listings go live," implemented as an enforced gate.

---

## 3. `vision-service` — internal

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/vision/garment/measure` | Flat-lay → landmarks, dims, calibration confidence |
| `POST` | `/v1/vision/techpack/extract` | Tech pack → OCR'd structured table + per-cell confidence |
| `POST` | `/v1/vision/embed` | FashionCLIP embedding for Fit Prior Transfer |

Internal-only (mTLS, not exposed at the gateway). Accepts garment assets exclusively — the OpenAPI schema has no field capable of accepting a person's photo, which is a design-level guarantee rather than a runtime check.

---

## 4. `privacy-service` — DPDP compliance surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/privacy/consent` | Create a purpose-limited, versioned consent artifact → `consent_id` |
| `GET` | `/v1/privacy/consent/{id}` | Inspect scope, purpose, expiry, notice version |
| `DELETE` | `/v1/privacy/consent/{id}` | **Withdraw** consent (DPDP §6(6)); cascades to dependent data |
| `GET` | `/v1/privacy/subject/{sid}/export` | **Right to access** — machine-readable export of everything held |
| `POST` | `/v1/privacy/subject/{sid}/correct` | **Right to correction** |
| `DELETE` | `/v1/privacy/subject/{sid}` | **Right to erasure** — returns a signed deletion receipt |
| `GET` | `/v1/privacy/audit/{trace_id}` | Replayable decision trace + hash-chain proof |
| `GET` | `/v1/privacy/audit/verify` | Verify the whole chain is untampered |

```jsonc
// POST /v1/privacy/consent
{ "purposes": ["fit_recommendation"],          // purpose limitation - enforced in code
  "data_categories": ["body_measurements"],
  "retention_days": 0,                          // 0 = session-only, our default
  "notice_version": "2026-08-01",
  "age_attested_18_plus": true }
// -> { "consent_id": "cns_01HQ9...", "expires_at": "...", "withdrawable": true,
//      "receipt_hash": "sha256:..." }
```

```jsonc
// DELETE /v1/privacy/subject/{sid}  -> 200
{ "subject_id": "sub_hmac_7f3a...",
  "deleted": { "body_measurements": 3, "pose_embeddings": 1, "fit_events": 12 },
  "retained": { "audit_ledger_entries": 12,
                "basis": "DPDP s8(7) legal obligation - pseudonymous, no body data" },
  "receipt": { "hash": "sha256:...", "signed_at": "2026-08-07T14:31:02Z" } }
```

Returning a **signed deletion receipt** and being explicit about the lawful basis for what is retained is the difference between claiming compliance and demonstrating it.

---

## 5. `feedback-service`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/returns/ingest` | Bulk return events with fit reasons |
| `GET` | `/v1/analytics/returns` | Return rate by SKU/size/zone, before vs after |
| `GET` | `/v1/analytics/fairness` | Fit accuracy by body-shape cohort (k-anonymised, k >= 20) |
| `GET` | `/v1/analytics/cost` | Measured cost-per-inference by route tier |

---

## 6. Cross-cutting

`GET /healthz` · `GET /readyz` · `GET /metrics` (Prometheus) on every service.
`GET /v1/models` returns the active model manifest with versions and hashes — reproducibility is part of explainability.
