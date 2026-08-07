# Fit-Scoring Algorithm (current implementation)

Source of truth: `services/fit-service/main.py`. This is the most important diagram for judging — it is the actual decision pipeline behind every recommendation, with no hidden model calls.

```mermaid
flowchart TD
    IN["Height + Weight<br/>(+ optional chest/waist/shoulder overrides)"] --> BZ["estimate_body_zones()<br/>linear coefficients, calibrated to two reference bodies"]
    BZ --> GM["Garment Measurements<br/>(from the SKU's Fit Artifact)"]
    GM --> EFF["Effective dimension =<br/>garment x (1 - shrinkage) x (1 + stretch)"]
    EFF --> SLACK["Slack = effective - body measurement"]
    PREF["Fit Preference<br/>tight 0.55x / regular 1.0x / relaxed 1.6x"] --> TE["Target Ease = base_ease x preference multiplier"]
    SLACK --> ZS
    TE --> ZS["Zone Score = exp(-abs(slack - target_ease) / scale)<br/>x0.2 penalty if slack < 0"]
    ZS --> WS["Weighted Overall Score<br/>chest 0.35, waist 0.30, shoulder 0.20, sleeve 0.15"]
    WS --> SM["Softmax (temperature 0.15)<br/>across S / M / L / XL"]
    SM --> PROB["Probability per Size<br/>(sums to ~100%)"]
    US["Optional: Usual Size"] -.-> PRIOR["Ordinal-distance prior<br/>exp(-rank_diff^2 / 2)"]
    PRIOR -.->|"0.8 body-fit + 0.2 prior<br/>(only if usual size given)"| PROB
    PROB --> BEST["Best Size = highest unrounded probability"]
    BEST --> CONF["Confidence = 0.7 x fit-quality-normalized score<br/>+ 0.3 x relative margin over runner-up"]
    CONF --> FQ["Fit Quality<br/>>=0.65 Good / >=0.35 Fair / else Poor"]
    FQ --> EXPL["Explainable Recommendation<br/>deterministic template text, no LLM"]

    style IN fill:#4f46e5,color:#fff
    style EXPL fill:#16a34a,color:#fff
```

## Notes on fidelity

- Every box above corresponds to a real function or code block in `services/fit-service/main.py` — nothing here is aspirational.
- The dashed "Usual Size" path only activates when the shopper provides one; the rest of the pipeline is byte-identical whether or not it's used.
- `Confidence` and `Fit Quality` are computed from the winning size's **pure, unblended** zone scores — the usual-size prior can change *which* size wins, but never inflates the confidence number.
- There is no branch anywhere in this pipeline that calls an LLM, a vision model, or a trained ML model. Every arrow is closed-form arithmetic.
