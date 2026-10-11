import os
import tempfile
from pathlib import Path

# Isolate tests from any developer database.
_TEST_DB = Path(tempfile.gettempdir()) / "naqaa_field_lab_api_tests.sqlite3"
os.environ["FIELD_LAB_DATABASE_URL"] = f"sqlite:///{_TEST_DB.as_posix()}"
os.environ["FIELD_LAB_JWT_SECRET"] = "ci-only-secret-that-is-not-used-in-production"
os.environ["FIELD_LAB_ENV"] = "test"

from fastapi.testclient import TestClient
from main import Base, SessionLocal, app, engine  # noqa: E402

client = TestClient(app)


def setup_function():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


def register(email="field-user@example.com", password="StrongPass123!"):
    response = client.post("/auth/register", json={"email": email, "password": password})
    assert response.status_code == 201, response.text
    return response.json()["access_token"]


def test_health_and_plans_do_not_claim_payments_enabled():
    assert client.get("/health").json()["payments_enabled"] is False
    plans = client.get("/plans").json()
    assert plans["payments_enabled"] is False
    assert plans["plans"]["free"]["sites"] == 2
    assert plans["plans"]["daily"]["price_usd"] == 10
    assert plans["plans"]["weekly"]["price_usd"] == 50
    assert plans["plans"]["monthly"]["price_usd"] == 100


def test_register_login_and_usage_quota():
    token = register()
    headers = {"Authorization": f"Bearer {token}"}
    usage = client.get("/me/usage", headers=headers)
    assert usage.status_code == 200
    assert usage.json()["plan"] == "free"
    assert usage.json()["sites_limit"] == 2
    assert usage.json()["questions_limit"] == 10

    login = client.post("/auth/login", json={"email": "FIELD-USER@example.com", "password": "StrongPass123!"})
    assert login.status_code == 200
    assert login.json()["access_token"]

    assert client.post("/usage/consume", headers=headers, json={"action": "site"}).status_code == 200
    assert client.post("/usage/consume", headers=headers, json={"action": "site"}).status_code == 200
    exhausted = client.post("/usage/consume", headers=headers, json={"action": "site"})
    assert exhausted.status_code == 429

    for _ in range(10):
        response = client.post("/usage/consume", headers=headers, json={"action": "question"})
        assert response.status_code == 200
    assert client.post("/usage/consume", headers=headers, json={"action": "question"}).status_code == 429


def test_duplicate_email_and_invalid_login_are_rejected():
    register()
    duplicate = client.post("/auth/register", json={"email": "FIELD-USER@example.com", "password": "StrongPass123!"})
    assert duplicate.status_code == 409
    invalid = client.post("/auth/login", json={"email": "field-user@example.com", "password": "wrong-password"})
    assert invalid.status_code == 401


def test_protected_usage_requires_token():
    assert client.get("/me/usage").status_code == 401
    assert client.post("/usage/consume", json={"action": "site"}).status_code == 401
