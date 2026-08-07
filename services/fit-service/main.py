"""fit-service: hot path, no model calls, closed-form fit scoring."""
import math
import time
import uuid
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="fit-service")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ---- in-memory Fit Artifact store (replace with Redis later) ----
ARTIFACTS: dict[str, dict] = {
    "sku_demo_1": {
        "sku_id": "sku_demo_1",
        "artifact_version": 1,
        "sizes": ["S", "M", "L", "XL"],
        "zones": ["shoulder", "chest", "waist", "sleeve"],
        "dims_cm": [
            [42.0, 92.0, 78.0, 57.0],
            [44.5, 100.0, 84.0, 59.0],
            [47.0, 108.0, 90.0, 61.0],
            [49.5, 116.0, 96.0, 63.0],
        ],
        "ease_min_cm": [1.5, 4.0, 3.0, 0.0],
        "usable_stretch_pct": [0.0, 0.0, 0.0, 0.0],
        "shrinkage_pct": 0.021,
        "sigma": [1.2, 1.8, 1.6, 1.0],
        "cutpoints": [-0.87, 1.24],
    }
}


class BodyInput(BaseModel):
    height_cm: float
    weight_kg: float
    chest_cm: Optional[float] = None
    waist_cm: Optional[float] = None
    shoulder_cm: Optional[float] = None
    fit_preference: str = "regular"
    usual_size: Optional[str] = None  # optional self-report, e.g. "L" — a soft prior, never a hard override


class RecommendRequest(BaseModel):
    sku_id: str
    body: BodyInput
    wash_horizon: int = 0


# MVP fit-scoring constants. tight/relaxed scale how much ease (room) a size
# needs to feel "right" relative to the regular-fit baseline already baked
# into each artifact's ease_min_cm. Zone weights follow standard shirt-fit
# priority: chest > waist > shoulder > sleeve.
PREFERENCE_EASE_MULT = {"tight": 0.55, "regular": 1.0, "relaxed": 1.6}
ZONE_WEIGHTS = {"shoulder": 0.20, "chest": 0.35, "waist": 0.30, "sleeve": 0.15}

# Usual-size calibration: body/garment fit stays the dominant (80%) signal;
# a self-reported usual size only contributes a small (20%) prior, and only
# when one was actually provided (see USUAL_SIZE_WEIGHT usage in recommend()).
USUAL_SIZE_WEIGHT = 0.20
USUAL_SIZE_PRIOR_SIGMA = 1.0  # in size-steps; 1 step away already halves the credit


def usual_size_prior(size: str, usual_size: Optional[str], sizes_order: list[str]) -> float:
    """Soft, ordinal-distance prior centered on the shopper's self-reported
    usual size — NOT a lookup/override. A neighboring size still gets partial
    credit; two steps away gets very little. Returns 0.0 (no effect) if no
    usual size was given or it doesn't match a real size on this chart."""
    if not usual_size or usual_size not in sizes_order:
        return 0.0
    rank_diff = abs(sizes_order.index(size) - sizes_order.index(usual_size))
    return math.exp(-(rank_diff ** 2) / (2 * USUAL_SIZE_PRIOR_SIGMA ** 2))


def estimate_body_zones(body: BodyInput) -> dict[str, float]:
    """MVP anthropometric approximation — deterministic, not dataset-trained.

    Calibrated on two reference points so results stay physically plausible:
    an average adult (175cm/75kg) maps to roughly the ease-adjusted M-size
    body, and a larger adult (185cm/100kg) maps toward the ease-adjusted
    XL-size body. Previous coefficients (h*0.53+w*0.18 for chest, etc.)
    produced body measurements larger than even XL for realistic adults,
    which broke fit scoring for every size at once — see README.md.
    """
    h = body.height_cm
    w = body.weight_kg
    shoulder = body.shoulder_cm or (0.20 * h + 0.12 * w - 1.0)
    chest = body.chest_cm or (0.35 * h + 0.50 * w - 2.75)
    waist = body.waist_cm or (0.10 * h + 0.44 * w + 30.5)
    sleeve = 0.337 * h
    return {"shoulder": shoulder, "chest": chest, "waist": waist, "sleeve": sleeve}


def score_zone(slack: float, target_ease: float, scale: float) -> float:
    """Higher is better (max 1.0). Heavily penalized when the garment is
    physically smaller than the body at this zone (negative slack)."""
    error = abs(slack - target_ease)
    score = math.exp(-error / scale)
    if slack < 0:
        score *= 0.2
    return score


def build_explanations(req: RecommendRequest, art: dict, per_size: list[dict],
                        best: dict, fit_quality: str, shrink: float) -> list[str]:
    """Deterministic, template-based explanation grounded in the numbers
    above — no LLM call, so nothing here can be hallucinated."""
    explanations = []
    if fit_quality == "Poor fit":
        explanations.append(
            f"Poor fit — no available size provides sufficient ease for this body at a "
            f"{req.body.fit_preference} fit. {best['size']} is the least-bad option; its "
            f"binding zone is {best['binding_zone']} "
            f"({best['zone_slack_cm'][best['binding_zone']]:+.1f} cm slack)."
        )
    else:
        parts = [f"{z} has {best['zone_slack_cm'][z]:+.1f} cm ease"
                 for z in ("chest", "waist") if z in best["zone_slack_cm"]]
        explanations.append(
            f"Recommended {best['size']} because " + " and ".join(parts) +
            f". {best['size']} provides the best overall balance for a "
            f"{req.body.fit_preference} fit ({fit_quality})."
        )

    sizes_order = art["sizes"]
    smaller = [s for s in per_size if sizes_order.index(s["size"]) < sizes_order.index(best["size"])]
    failing = [s for s in smaller if s["zone_slack_cm"][s["binding_zone"]] < 0]
    if failing:
        worst = min(failing, key=lambda s: s["zone_slack_cm"][s["binding_zone"]])
        explanations.append(
            f"{worst['size']} rejected because {worst['binding_zone']} has insufficient ease "
            f"({worst['zone_slack_cm'][worst['binding_zone']]:+.1f} cm)."
        )

    if any(v > 0 for v in art["usable_stretch_pct"]):
        max_stretch = max(art["usable_stretch_pct"])
        explanations.append(
            f"This fabric's {max_stretch * 100:.0f}% stretch allowance provides additional tolerance."
        )

    if req.wash_horizon > 0:
        explanations.append(
            f"After {req.wash_horizon} wash(es), garment dimensions shrink by {shrink * 100:.1f}% "
            f"— already factored into this recommendation."
        )

    usual = req.body.usual_size
    if usual and usual in sizes_order:
        if best["size"] == usual:
            explanations.append(f"Your usual {usual} size also supports this recommendation.")
        else:
            explanations.append(
                f"Your usual size is {usual}, but the measurements suggest {best['size']} "
                f"may provide a closer fit for this garment."
            )
    return explanations


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/v1/fit/artifact/{sku_id}")
def get_artifact(sku_id: str):
    art = ARTIFACTS.get(sku_id)
    if not art:
        raise HTTPException(404, "no published chart for SKU")
    return art


@app.post("/v1/fit/artifact")
def put_artifact(artifact: dict):
    """Internal: chart-service pushes a freshly published artifact here."""
    ARTIFACTS[artifact["sku_id"]] = artifact
    return {"stored": True, "sku_id": artifact["sku_id"]}


@app.post("/v1/fit/recommend")
def recommend(req: RecommendRequest):
    start = time.perf_counter()
    art = ARTIFACTS.get(req.sku_id)
    if not art:
        raise HTTPException(404, "no published chart for SKU")

    body_zones = estimate_body_zones(req.body)
    zones = art["zones"]
    sigma = art["sigma"]
    ease_mult = PREFERENCE_EASE_MULT.get(req.body.fit_preference, 1.0)
    shrink = art["shrinkage_pct"] * min(req.wash_horizon / 5.0, 1.0)

    per_size = []
    for size, dims_row in zip(art["sizes"], art["dims_cm"]):
        zone_scores: dict[str, float] = {}
        zone_slack: dict[str, float] = {}
        zone_target_ease: dict[str, float] = {}
        for zi, zone in enumerate(zones):
            stretch = art["usable_stretch_pct"][zi]
            effective = dims_row[zi] * (1 - shrink) * (1 + stretch)
            slack = effective - body_zones[zone]
            target_ease = art["ease_min_cm"][zi] * ease_mult

            zone_scores[zone] = score_zone(slack, target_ease, sigma[zi])
            zone_slack[zone] = round(slack, 2)
            zone_target_ease[zone] = target_ease

        overall_score = sum(ZONE_WEIGHTS[z] * zone_scores[z] for z in zones)
        binding_zone = min(zones, key=lambda z: zone_scores[z])
        binding_scale = sigma[zones.index(binding_zone)]
        binding_slack = zone_slack[binding_zone]

        p_small = (round(min(1.0, max(0.0, -binding_slack / (2 * binding_scale))), 3)
                   if binding_slack < 0 else 0.0)
        oversize = binding_slack - zone_target_ease[binding_zone] * 2
        p_large = (round(min(1.0, max(0.0, oversize / (2 * binding_scale))), 3)
                   if oversize > 0 else 0.0)

        per_size.append({
            "size": size, "_score": overall_score, "_binding_score": zone_scores[binding_zone],
            "_prior": usual_size_prior(size, req.body.usual_size, art["sizes"]),
            "binding_zone": binding_zone, "zone_slack_cm": zone_slack,
            "p_small": p_small, "p_large": p_large,
        })

    # Softmax over the pure body-fit zone score -> calibrated fit probabilities
    # that sum to ~100% across sizes. This is byte-identical to before the
    # usual-size feature existed (replaces the old ordinal cut-point model,
    # which saturated to 0% for every size once the body estimate exceeded
    # the largest available garment).
    temperature = 0.15
    max_score = max(s["_score"] for s in per_size)
    exp_scores = [math.exp((s["_score"] - max_score) / temperature) for s in per_size]
    total = sum(exp_scores)
    for s, e in zip(per_size, exp_scores):
        s["_body_p_fit"] = e / total

    # If a usual size was given, blend it in as a small (20%) calibration
    # prior directly in probability space — a literal weighted average of the
    # pure body-fit distribution (80%, dominant) and a normalized ordinal
    # prior centered on the usual size (20%). Blending in probability space
    # (rather than before softmax) keeps the prior's effect predictable and
    # bounded instead of being amplified or swamped by the softmax
    # temperature. Confidence/fit_quality further down deliberately keep
    # reading the pure, unblended _score/_binding_score, so the prior can
    # nudge WHICH size wins without ever inflating how confident we claim to
    # be about the physical fit. With no usual size, the blended probability
    # equals the pure body-fit probability exactly — byte-identical behavior.
    has_usual_size = bool(req.body.usual_size and req.body.usual_size in art["sizes"])
    if has_usual_size:
        prior_total = sum(s["_prior"] for s in per_size)
        for s in per_size:
            prior_norm = (s["_prior"] / prior_total) if prior_total > 0 else 0.0
            s["_p_fit_raw"] = (1 - USUAL_SIZE_WEIGHT) * s["_body_p_fit"] + USUAL_SIZE_WEIGHT * prior_norm
    else:
        for s in per_size:
            s["_p_fit_raw"] = s["_body_p_fit"]

    for s in per_size:
        s["p_fit"] = round(s["_p_fit_raw"], 3)  # displayed value

    # Rank on the unrounded probability. Ranking on the rounded p_fit (as
    # before) can create an artificial tie when every size is catastrophically
    # bad (e.g. all round to 0.250) even though one size is still measurably,
    # if uselessly, less bad than the others — a stable sort on a real tie
    # then falls back to list order and always "wins" with S, which reads as
    # a confident recommendation it isn't. Confidence/fit_quality still use
    # the same displayed p_fit values as before, so those are unaffected.
    ranked = sorted(per_size, key=lambda s: s["_p_fit_raw"], reverse=True)
    best, second = ranked[0], (ranked[1] if len(ranked) > 1 else ranked[0])

    # best_fit_quality: a properly-saturated [0,1] read on how good the winning
    # size actually is. The raw weighted-zone score (_score) is a SUM of
    # exp(-error/scale) terms across 4 zones, so it structurally compresses
    # into a low ~0.15-0.5 range even for a genuinely good match — feeding it
    # into confidence directly (as before) reads as falsely conservative.
    # SAT_OVERALL/SAT_BINDING rescale "a good real-world score" up to full
    # credit. Binding-zone score is included separately (not just folded into
    # the average) so a specific problem zone still pulls confidence down,
    # just not so hard that a size winning by a landslide reads as low-confidence.
    SAT_OVERALL, SAT_BINDING = 0.5, 0.35
    normalized_overall = min(1.0, best["_score"] / SAT_OVERALL)
    normalized_binding = min(1.0, best["_binding_score"] / SAT_BINDING)
    best_fit_quality = 0.7 * normalized_overall + 0.3 * normalized_binding

    # winner_margin: how decisively the top size beats the runner-up, as a
    # fraction of the top size's own probability (0 = effectively tied,
    # 1 = the runner-up has ~no share at all).
    winner_margin = ((best["p_fit"] - second["p_fit"]) / best["p_fit"]) if best["p_fit"] > 0 else 0.0
    winner_margin = max(0.0, min(1.0, winner_margin))

    confidence = 0.70 * best_fit_quality + 0.30 * winner_margin
    confidence = round(max(0.0, min(1.0, confidence)), 3)

    if best_fit_quality >= 0.65:
        fit_quality = "Good fit"
    elif best_fit_quality >= 0.35:
        fit_quality = "Fair fit"
    else:
        fit_quality = "Poor fit"

    explanations = build_explanations(req, art, per_size, best, fit_quality, shrink)

    for s in per_size:
        del s["_score"]
        del s["_binding_score"]
        del s["_prior"]
        del s["_body_p_fit"]
        del s["_p_fit_raw"]

    latency_ms = round((time.perf_counter() - start) * 1000, 2)
    return {
        "recommended_size": best["size"],
        "confidence": confidence,
        "fit_quality": fit_quality,
        "per_size": per_size,
        "explanations": explanations,
        "privacy": {"raw_image_retained": False, "processed": "server-mock"},
        "trace_id": str(uuid.uuid4()),
        "latency_ms": latency_ms,
    }
