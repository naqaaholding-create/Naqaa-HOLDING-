"""Smoke tests for the NAQAA Field Lab API.

These tests use an isolated SQLite database and never enable live payments.
"""
import os
import tempfile
from pathlib import Path

_test_dir = tempfile.TemporaryDirectory(prefix="naqaa-api-tests-")
os.environ["FIELD_LAB_ENV"] = "test"
os.environ["FIELD_LAB_DATABASE_URL"] = f"sqlite:///{Path(_test_dir.name) / 'test.db'}"
os.environ.pop("FIELD_LAB_LIVE_PAYMENTS_ENABLED", None)
os.environ.pop("FIELD_LAB_TRON_USDT_RECEIVE_ADDRESS", None)
os.environ.pop("TRONGRID_API_KEY", None)
os.environ.pop("FIELD_LAB_ALLOWED_ORIGINS", None)
os.environ.pop("FIELD_LAB_JWT_SECRET", None)

from fastapi.testclient import TestClient  # noqa: E402
import main  # noqa: E402

client = TestClient(main.app)


def test_health_endpoint_is_available():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["service"] == "naqaa-field-lab-api"
    assert response.json()["payments_enabled"] is False


def test_plans_are_listed_and_live_payments_default_to_off():
    response = client.get("/plans")
    assert response.status_code == 200
    body = response.json()
    assert body["currency"] == "USD"
    assert {"free", "daily", "weekly", "monthly"} <= set(body["plans"])
    assert body["payments_enabled"] is False


def test_payment_status_fails_closed_without_production_configuration():
    response = client.get("/payments/status")
    assert response.status_code == 200
    body = response.json()
    assert body["payments_enabled"] is False
    assert body["receive_address_configured"] is False
    assert body["persistent_database_configured"] is False
    assert body["requirements_remaining"]


def test_protected_usage_requires_authentication():
    response = client.get("/me/usage")
    assert response.status_code == 401


def test_register_login_and_usage_flow():
    email = "smoke-test@example.com"
    password = "correct-horse-battery-staple"
    registered = client.post("/auth/register", json={"email": email, "password": password})
    assert registered.status_code == 201
    token = registered.json()["access_token"]
    assert token

    logged_in = client.post("/auth/login", json={"email": email, "password": password})
    assert logged_in.status_code == 200
    login_token = logged_in.json()["access_token"]
    assert login_token

    usage = client.get("/me/usage", headers={"Authorization": f"Bearer {login_token}"})
    assert usage.status_code == 200
    assert usage.json()["plan"] == "free"
    assert usage.json()["payment_enabled"] is False


def test_duplicate_registration_is_rejected():
    email = "duplicate-test@example.com"
    payload = {"email": email, "password": "correct-horse-battery-staple"}
    first = client.post("/auth/register", json=payload)
    assert first.status_code == 201
    second = client.post("/auth/register", json=payload)
    assert second.status_code == 409
