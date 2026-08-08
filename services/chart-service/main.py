"""chart-service: seller write path. Mocked multi-agent pipeline (synchronous for demo)."""
import json
import os
import time
import urllib.request
import uuid
from typing import Optional

# Deployment-configurable: defaults to localhost so local dev is unchanged.
# Set FIT_SERVICE_URL in the hosting platform's environment to point at the
# deployed fit-service (e.g. https://fitchart-fit-service.onrender.com).
FIT_SERVICE_URL = os.environ.get("FIT_SERVICE_URL", "http://localhost:8000")

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="chart-service")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

SKUS: dict[str, dict] = {}
CHARTS: dict[str, dict] = {}

BASE_SIZES = ["S", "M", "L", "XL"]
BASE_DIMS = {  # category default, per-size, per-zone [shoulder, chest, waist, sleeve]
    "shirt": [
        [42.0, 92.0, 78.0, 57.0],
        [44.5, 100.0, 84.0, 59.0],
        [47.0, 108.0, 90.0, 61.0],
        [49.5, 116.0, 96.0, 63.0],
    ]
}
ZONES = ["shoulder", "chest", "waist", "sleeve"]


# Seller-declared garment cut and fabric-stretch level. Both actually shift
# the ease/stretch numbers below — never just displayed.
FIT_TYPE_EASE_MULT = {"slim": 0.7, "regular": 1.0, "relaxed": 1.3, "oversized": 1.7}
STRETCH_LEVEL_PCT = {"none": 0.0, "low": 0.05, "medium": 0.12, "high": 0.25}


class FabricSpec(BaseModel):
    composition: dict[str, float]  # e.g. {"cotton": 98, "elastane": 2}
    gsm: float = 180.0
    is_preshrunk: bool = False
    stretch_level: str = "none"  # none | low | medium | high — seller's own declared stretch


class SkuCreate(BaseModel):
    name: str
    category: str = "shirt"
    brand: Optional[str] = None
    gender: Optional[str] = None  # stored/displayed only — no defensible formula ties gender to ease
    fit_type: str = "regular"  # slim | regular | relaxed | oversized — the garment's own cut
    fabric: FabricSpec


def mechanics(fabric: FabricSpec, fit_type: str = "regular") -> dict:
    """Mock Garment Mechanics Engine: deterministic rules, no model call."""
    elastane = fabric.composition.get("elastane", 0) + fabric.composition.get("spandex", 0)
    elastane_stretch = elastane * 0.04
    declared_stretch = STRETCH_LEVEL_PCT.get(fabric.stretch_level, 0.0)
    stretch_pct = min(max(elastane_stretch, declared_stretch), 0.35)  # saturating stretch

    cotton_frac = fabric.composition.get("cotton", 0) / 100.0
    shrink = 0.03 * cotton_frac
    if fabric.is_preshrunk:
        shrink *= 0.3

    base_ease = [1.5, 4.0, 3.0, 0.0] if stretch_pct == 0 else [1.0, 2.5, 2.0, 0.0]
    fit_mult = FIT_TYPE_EASE_MULT.get(fit_type, 1.0)
    ease_min_cm = [round(e * fit_mult, 2) for e in base_ease]

    return {
        "usable_stretch_pct": [stretch_pct] * len(ZONES),
        "shrinkage_pct": round(shrink, 4),
        "ease_min_cm": ease_min_cm,
        "fit_type": fit_type,
    }


def run_agent_pipeline(sku: dict) -> dict:
    """Mock 7-agent pipeline: vision + document + materials -> reconciliation -> grading -> explain -> verify."""
    dims = BASE_DIMS.get(sku["category"], BASE_DIMS["shirt"])
    mech = mechanics(FabricSpec(**sku["fabric"]), sku.get("fit_type", "regular"))
    outlier_flags = []

    # mock reconciliation: flag if elastane implausibly high
    elastane = sku["fabric"]["composition"].get("elastane", 0)
    if elastane > 20:
        outlier_flags.append({
            "field": "composition.elastane", "severity": "high",
            "reason": f"{elastane}% elastane is unusually high for this category.",
            "action": "blocks_publish",
        })

    sizes = []
    for i, size in enumerate(BASE_SIZES):
        row = {"label": size, "confidence": 0.9}
        explanations = {}
        for zi, zone in enumerate(ZONES):
            base = dims[i][zi]
            ease = mech["ease_min_cm"][zi]
            val = round(base, 1)
            fit_note = f" ({mech['fit_type']} cut)" if mech["fit_type"] != "regular" else ""
            explanations[f"{zone}_cm"] = (
                f"{val} cm = body {zone} + {ease} cm ease{fit_note}. "
                f"{'Stretch credit ' + str(round(mech['usable_stretch_pct'][zi]*100,1)) + '%.' if mech['usable_stretch_pct'][zi] else 'No stretch credit: zero-stretch fabric.'}"
            )
            row[f"{zone}_cm"] = val
        row["explanations"] = explanations
        row["post_wash"] = {
            "washes": 5,
            **{f"{z}_cm": round(dims[i][zi] * (1 - mech["shrinkage_pct"]), 1) for zi, z in enumerate(ZONES)},
        }
        sizes.append(row)

    return {
        "sizes": sizes,
        "zones": ZONES,
        "dims_cm": dims,
        "ease_min_cm": mech["ease_min_cm"],
        "usable_stretch_pct": mech["usable_stretch_pct"],
        "shrinkage_pct": mech["shrinkage_pct"],
        "sigma": [1.2, 1.8, 1.6, 1.0],
        "cutpoints": [-0.87, 1.24],
        "outlier_flags": outlier_flags,
    }


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.post("/v1/skus")
def create_sku(body: SkuCreate):
    sku_id = f"sku_{uuid.uuid4().hex[:8]}"
    SKUS[sku_id] = {"sku_id": sku_id, **body.model_dump()}
    return SKUS[sku_id]


@app.post("/v1/skus/{sku_id}/generate-chart")
def generate_chart(sku_id: str):
    sku = SKUS.get(sku_id)
    if not sku:
        raise HTTPException(404, "SKU not found")
    start = time.perf_counter()
    result = run_agent_pipeline(sku)
    generated_ms = round((time.perf_counter() - start) * 1000 + 7200, 0)  # +mock pipeline latency

    version = CHARTS.get(sku_id, {}).get("version", 0) + 1
    status = "blocked" if result["outlier_flags"] else "published"

    chart = {
        "sku_id": sku_id,
        "version": version,
        "status": status,
        "generated_in_ms": generated_ms,
        "sizes": result["sizes"],
        "outlier_flags": result["outlier_flags"],
        "artifact": {
            "sku_id": sku_id,
            "artifact_version": version,
            "sizes": BASE_SIZES,
            "zones": result["zones"],
            "dims_cm": result["dims_cm"],
            "ease_min_cm": result["ease_min_cm"],
            "usable_stretch_pct": result["usable_stretch_pct"],
            "shrinkage_pct": result["shrinkage_pct"],
            "sigma": result["sigma"],
            "cutpoints": result["cutpoints"],
        },
    }
    CHARTS[sku_id] = chart
    if status == "published":
        push_artifact_to_fit_service(chart["artifact"])
    return chart


def push_artifact_to_fit_service(artifact: dict) -> None:
    """Best-effort push so the widget can query fit-service immediately."""
    try:
        req = urllib.request.Request(
            f"{FIT_SERVICE_URL}/v1/fit/artifact",
            data=json.dumps(artifact).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=2)
    except Exception:
        pass  # fit-service may not be running yet; demo can retry


@app.get("/v1/skus/{sku_id}/chart")
def get_chart(sku_id: str):
    chart = CHARTS.get(sku_id)
    if not chart:
        raise HTTPException(404, "no chart generated yet")
    return chart


def mock_extract(kind: str, size_kb: float) -> dict:
    """Mock CV/OCR extraction. Real models are out of scope for this demo pass."""
    if kind == "image":
        return {
            "detected_category": "shirt",
            "landmarks_found": 18,
            "calibration_confidence": 0.82,
            "note": "Mock CV extraction — a real vision model would replace this in production.",
        }
    return {
        "detected_rows": 4,
        "detected_columns": 6,
        "ocr_confidence": 0.91,
        "note": "Mock OCR/table extraction — a real document parser would replace this in production.",
    }


@app.post("/v1/skus/{sku_id}/assets")
async def upload_asset(sku_id: str, kind: str = Form(...), file: UploadFile = File(...)):
    """Additive endpoint: receives a garment image or tech-pack file for a SKU.
    Bytes are read into memory only to measure size, then discarded — never written to disk.
    """
    if sku_id not in SKUS:
        raise HTTPException(404, "SKU not found")
    if kind not in ("image", "techpack"):
        raise HTTPException(400, "kind must be 'image' or 'techpack'")

    contents = await file.read()
    size_kb = round(len(contents) / 1024, 1)
    del contents  # discard immediately — raw file bytes are never persisted

    return {
        "sku_id": sku_id,
        "kind": kind,
        "filename": file.filename,
        "size_kb": size_kb,
        "received": True,
        "stored_on_disk": False,
        "mock_extraction": mock_extract(kind, size_kb),
    }
