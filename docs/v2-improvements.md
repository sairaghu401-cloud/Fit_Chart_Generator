# V1 → V2 Improvements

All V2 additions are additive to the API — every V1 request/response shape still works unchanged (verified in `tests/`).

| V1 | V2 |
|---|---|
| Body estimated from height/weight only | Optional direct chest/waist/shoulder/sleeve measurements — used when given, estimated otherwise; response labels each zone `"provided"` or `"estimated"` |
| No body-shape signal | `body_profile`: BMI-band frame size from height/weight alone, upgrades to a proportion-aware label (Upper/Lower-body dominant, Balanced) when chest+waist are supplied |
| Recommendation with no comparison | `size_comparison`: why the size one smaller and one larger lose, computed from each size's own binding zone |
| Confidence number only | `fit_risk`: LOW/MEDIUM/HIGH with plain-language reasons (negative ease, low confidence, a close second choice) |
| "Poor fit" was just a text label | `no_suitable_size: true` + structured `guidance` (closest available size, the specific zones that fail, a suggested action) |
| Seller inputs were fabric-composition only | Seller-declared `fit_type` (slim/regular/relaxed/oversized) and `stretch_level` (none/low/medium/high) — both actually shift the computed ease and stretch, not just displayed |
| No automated tests | 20 pytest tests across both services covering slim/average/large/extreme bodies, both preferences, optional measurements, shrinkage, no-suitable-size, probability-sum and confidence-bounds invariants, and backward compatibility |
| Manual demo setup | 5 one-click scenario buttons that populate the form and call the real `/v1/fit/recommend` endpoint — never bypass the backend |

## What was deliberately not built

- **Size availability / inventory** — real feature, meaningful scope on its own; not implemented this pass rather than half-built.
- **Seller analytics dashboard beyond existing session counters** — the frontend already had session-only stat cards from V1; not expanded further.
- **Gender-based ease adjustment** — `gender` is now a stored, displayed SKU field, but no formula ties it to ease. There's no defensible coefficient for that, so it isn't used in scoring rather than inventing one.

## How to demonstrate this to a judge

1. Open the Shopper Assistant, click any of the 5 scenario buttons — each is a real API call, not canned data.
2. Point out the **risk badge** and **why-not-the-next-size** cards — both computed from the same numbers already in the response, nothing new invented.
3. Click "Extreme / No Suitable Size" — show the red banner and confirm it's honest: XL is still shown as the least-bad option, not falsely presented as a good fit.
4. Open "Optional: enter direct measurements," add a chest/waist value, re-run — show the `body_profile` label upgrade and the `measurement_sources` tags flipping from "estimated" to "provided."
5. Run `pytest tests/ -v` live — 20 tests, all green, in about 13 seconds.
