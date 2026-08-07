# End-to-End Workflow (current implementation)

## Seller workflow

```mermaid
flowchart TD
    A1[Seller fills product name, category,<br/>cotton %, elastane %, GSM] --> A2["POST /v1/skus<br/>(chart-service)"]
    A2 --> A3["Optional: POST /v1/skus/id/assets<br/>garment image or tech-pack PDF<br/>(mock CV/OCR extraction, file discarded)"]
    A3 --> A4["POST /v1/skus/id/generate-chart"]
    A4 --> A5["mechanics() computes stretch %,<br/>shrinkage %, ease from fabric composition"]
    A5 --> A6["run_agent_pipeline() builds per-size<br/>measurements + explanations + outlier flags"]
    A6 --> A7{elastane > 20%?}
    A7 -->|yes| A8["status = blocked<br/>outlier_flags returned"]
    A7 -->|no| A9["status = published"]
    A9 --> A10["Fit Artifact pushed to fit-service<br/>POST /v1/fit/artifact"]
    A8 --> A11[Chart shown to seller with reasons]
    A10 --> A11
```

## Shopper workflow

```mermaid
flowchart TD
    B1["Shopper enters SKU, height, weight,<br/>fit preference, wash horizon,<br/>optional usual size"] --> B2["Consent checkbox required"]
    B2 --> B3["POST /v1/fit/recommend<br/>(fit-service)"]
    B3 --> B4["estimate_body_zones()<br/>height/weight -> shoulder/chest/waist/sleeve"]
    B4 --> B5["For each size: score_zone() per zone<br/>vs. garment chart + fit-preference ease"]
    B5 --> B6["overall_score = weighted sum<br/>chest 0.35, waist 0.30, shoulder 0.20, sleeve 0.15"]
    B6 --> B7["softmax(overall_score, T=0.15)<br/>-> body-fit probability per size"]
    B7 --> B8{usual_size provided?}
    B8 -->|yes| B9["blend: 0.8 x body-fit prob<br/>+ 0.2 x usual-size prior"]
    B8 -->|no| B10[probability unchanged]
    B9 --> B11[Rank sizes by probability]
    B10 --> B11
    B11 --> B12["confidence + fit_quality<br/>from the winning size's pure zone scores"]
    B12 --> B13["build_explanations()<br/>deterministic template text"]
    B13 --> B14[Response rendered in Shopper Assistant UI]
```

If either service is unreachable, `apps/web-app/app.js` detects the failure (4-second timeout) and falls back to a client-side simulation that mirrors this same math, clearly labeled "Simulated" in the UI.
