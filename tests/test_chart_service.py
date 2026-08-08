"""Business-correctness tests for chart-service. Run: pytest tests/test_chart_service.py -v"""
import importlib.util
from pathlib import Path

from fastapi.testclient import TestClient

# See test_fit_service.py for why this uses a unique module name instead of
# a bare `import main` — both services' entry file is named main.py.
_spec = importlib.util.spec_from_file_location(
    "chart_service_main", Path(__file__).resolve().parents[1] / "services" / "chart-service" / "main.py"
)
chart_service_main = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(chart_service_main)

client = TestClient(chart_service_main.app)


def make_sku(**overrides):
    payload = {
        "name": "Test Shirt", "category": "shirt",
        "fabric": {"composition": {"cotton": 98, "elastane": 2}, "gsm": 180, "is_preshrunk": False},
    }
    payload.update(overrides)
    return client.post("/v1/skus", json=payload).json()


def test_backward_compatible_generation():
    sku = make_sku()
    chart = client.post(f"/v1/skus/{sku['sku_id']}/generate-chart").json()
    assert chart["status"] == "published"
    assert chart["artifact"]["ease_min_cm"] == [1.0, 2.5, 2.0, 0.0]


def test_fit_type_oversized_increases_ease():
    regular = make_sku()
    oversized = make_sku(fit_type="oversized")
    regular_chart = client.post(f"/v1/skus/{regular['sku_id']}/generate-chart").json()
    oversized_chart = client.post(f"/v1/skus/{oversized['sku_id']}/generate-chart").json()
    for reg_e, over_e in zip(regular_chart["artifact"]["ease_min_cm"], oversized_chart["artifact"]["ease_min_cm"]):
        assert over_e >= reg_e


def test_fit_type_slim_decreases_ease():
    regular = make_sku()
    slim = make_sku(fit_type="slim")
    regular_chart = client.post(f"/v1/skus/{regular['sku_id']}/generate-chart").json()
    slim_chart = client.post(f"/v1/skus/{slim['sku_id']}/generate-chart").json()
    for reg_e, slim_e in zip(regular_chart["artifact"]["ease_min_cm"], slim_chart["artifact"]["ease_min_cm"]):
        assert slim_e <= reg_e


def test_stretch_level_overrides_zero_elastane_fabric():
    sku = make_sku(fabric={"composition": {"cotton": 100}, "gsm": 160, "is_preshrunk": False, "stretch_level": "high"})
    chart = client.post(f"/v1/skus/{sku['sku_id']}/generate-chart").json()
    assert chart["artifact"]["usable_stretch_pct"][0] == 0.25


def test_high_elastane_blocks_publish():
    sku = make_sku(fabric={"composition": {"cotton": 55, "elastane": 45}, "gsm": 180, "is_preshrunk": False})
    chart = client.post(f"/v1/skus/{sku['sku_id']}/generate-chart").json()
    assert chart["status"] == "blocked"
    assert len(chart["outlier_flags"]) > 0


def test_asset_upload_never_written_to_disk_flag():
    sku = make_sku()
    files = {"file": ("flatlay.jpg", b"fake-bytes", "image/jpeg")}
    r = client.post(f"/v1/skus/{sku['sku_id']}/assets", data={"kind": "image"}, files=files)
    d = r.json()
    assert r.status_code == 200
    assert d["stored_on_disk"] is False
    assert d["received"] is True


def test_unknown_sku_returns_404():
    r = client.post("/v1/skus/sku_does_not_exist/generate-chart")
    assert r.status_code == 404
