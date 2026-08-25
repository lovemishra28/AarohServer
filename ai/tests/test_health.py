from fastapi.testclient import TestClient

from aaroh_ai.inference.app import app

client = TestClient(app)


def test_health_ok() -> None:
    res = client.get("/health")
    assert res.status_code == 200

    body = res.json()
    assert body["status"] == "ok"
    assert body["service"] == "aaroh-ai"
    assert body["model_loaded"] is False
