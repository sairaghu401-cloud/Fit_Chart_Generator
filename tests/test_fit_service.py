"""Business-correctness tests for fit-service. Run: pytest tests/test_fit_service.py -v"""
import importlib.util
from pathlib import Path

from fastapi.testclient import TestClient

# Both services' entry file is named main.py — load this one under a unique
# module name so it can't collide with chart-service's main.py in the same
# pytest session (a bare `import main` would silently reuse whichever loads
# first via sys.modules).
_spec = importlib.util.spec_from_file_location(
    "fit_service_main", Path(__file__).resolve().parents[1] / "services" / "fit-service" / "main.py"
)
fit_service_main = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fit_service_main)

client = TestClient(fit_service_main.app)
SKU = "sku_demo_1"


def recommend(**body):
    payload = {"sku_id": SKU, "body": body, "wash_horizon": body.pop("wash_horizon", 0)}
    return client.post("/v1/fit/recommend", json=payload)


def test_normal_slim_shopper():
    r = recommend(height_cm=160, weight_kg=50, fit_preference="tight")
    d = r.json()
    assert r.status_code == 200
    assert d["recommended_size"] == "S"


def test_normal_average_shopper():
    r = recommend(height_cm=175, weight_kg=75, fit_preference="regular")
    d = r.json()
    assert r.status_code == 200
    assert d["recommended_size"] in {"M", "L"}
    assert d["fit_quality"] in {"Good fit", "Fair fit"}


def test_large_shopper():
    r = recommend(height_cm=185, weight_kg=100, fit_preference="relaxed")
    d = r.json()
    assert d["recommended_size"] == "XL"


def test_tight_vs_relaxed_preference_shifts_ease():
    """Same body, opposite preferences must not produce identical zone slack for the winner."""
    tight = recommend(height_cm=178, weight_kg=78, fit_preference="tight").json()
    relaxed = recommend(height_cm=178, weight_kg=78, fit_preference="relaxed").json()
    tight_best = next(s for s in tight["per_size"] if s["size"] == tight["recommended_size"])
    relaxed_best = next(s for s in relaxed["per_size"] if s["size"] == relaxed["recommended_size"])
    assert tight_best["zone_slack_cm"] != relaxed_best["zone_slack_cm"] or tight["recommended_size"] != relaxed["recommended_size"]


def test_missing_optional_measurements_are_all_estimated():
    r = recommend(height_cm=178, weight_kg=74, fit_preference="regular")
    d = r.json()
    assert all(v == "estimated" for v in d["measurement_sources"].values())


def test_user_provided_measurements_are_labeled_and_used():
    r = recommend(height_cm=187, weight_kg=83.5, fit_preference="relaxed",
                   chest_cm=100, waist_cm=84, sleeve_cm=59)
    d = r.json()
    assert d["measurement_sources"]["chest"] == "provided"
    assert d["measurement_sources"]["waist"] == "provided"
    assert d["measurement_sources"]["sleeve"] == "provided"
    assert d["measurement_sources"]["shoulder"] == "estimated"
    assert d["body_profile"]["basis"] == "chest and waist measurements"


def test_extreme_body_dimensions_flagged_poor_fit():
    r = recommend(height_cm=205, weight_kg=165, fit_preference="relaxed")
    d = r.json()
    assert d["fit_quality"] == "Poor fit"
    assert d["no_suitable_size"] is True
    assert d["confidence"] < 0.1


def test_no_suitable_size_guidance_structure():
    r = recommend(height_cm=205, weight_kg=165, fit_preference="relaxed")
    d = r.json()
    assert d["guidance"] is not None
    assert d["guidance"]["closest_available"] == d["recommended_size"]
    assert isinstance(d["guidance"]["problems"], dict)
    assert len(d["guidance"]["problems"]) > 0
    assert all(v < 0 for v in d["guidance"]["problems"].values())


def test_shrinkage_scenario_changes_effective_fit():
    no_wash = recommend(height_cm=187, weight_kg=83.5, fit_preference="relaxed", wash_horizon=0).json()
    washed = recommend(height_cm=187, weight_kg=83.5, fit_preference="relaxed", wash_horizon=5).json()
    no_wash_l = next(s for s in no_wash["per_size"] if s["size"] == "L")
    washed_l = next(s for s in washed["per_size"] if s["size"] == "L")
    assert no_wash_l["zone_slack_cm"] != washed_l["zone_slack_cm"]
    assert any("wash" in e.lower() for e in washed["explanations"])


def test_probability_sums_to_one():
    for h, w, pref in [(160, 50, "tight"), (175, 75, "regular"), (185, 100, "relaxed"), (205, 165, "relaxed")]:
        d = recommend(height_cm=h, weight_kg=w, fit_preference=pref).json()
        total = sum(s["p_fit"] for s in d["per_size"])
        assert abs(total - 1.0) < 0.01, f"probabilities summed to {total} for {h}/{w}/{pref}"


def test_confidence_always_between_zero_and_one():
    for h, w, pref in [(160, 50, "tight"), (175, 75, "regular"), (185, 100, "relaxed"), (205, 165, "relaxed")]:
        d = recommend(height_cm=h, weight_kg=w, fit_preference=pref).json()
        assert 0.0 <= d["confidence"] <= 1.0


def test_backward_compatible_response_shape():
    """A request with none of the V2 optional fields must still return every V1 field."""
    r = client.post("/v1/fit/recommend", json={
        "sku_id": SKU, "body": {"height_cm": 178, "weight_kg": 74}, "wash_horizon": 0,
    })
    d = r.json()
    for key in ("recommended_size", "confidence", "fit_quality", "per_size", "explanations",
                "privacy", "trace_id", "latency_ms"):
        assert key in d


def test_unknown_sku_returns_404():
    r = client.post(
        "/v1/fit/recommend",
        json={"sku_id": "sku_does_not_exist", "body": {"height_cm": 178, "weight_kg": 74}, "wash_horizon": 0},
    )
    assert r.status_code == 404
