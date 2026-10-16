import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

# Isolate tests from any developer database.
_TEST_DB = Path(tempfile.gettempdir()) / "naqaa_field_lab_api_tests.sqlite3"
os.environ["FIELD_LAB_DATABASE_URL"] = f"sqlite:///{_TEST_DB.as_posix()}"
os.environ["FIELD_LAB_JWT_SECRET"] = "ci-only-secret-that-is-not-used-in-production"
os.environ["FIELD_LAB_ENV"] = "test"

from fastapi.testclient import TestClient
from main import Base, SessionLocal, app, engine  # noqa: E402
from payments_live import VerifiedUSDTTransfer, USDT_TRON_CONTRACT  # noqa: E402

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

def test_field_records_sync_across_sessions_and_are_user_scoped():
    token_a = register(email="record-owner@example.com")
    token_b = register(email="other-owner@example.com")
    headers_a = {"Authorization": f"Bearer {token_a}"}
    headers_b = {"Authorization": f"Bearer {token_b}"}
    record = {
        "id": "NQ-TEST-RECORD-01",
        "siteName": "موقع تجريبي",
        "type": "surface",
        "latitude": 31.5,
        "longitude": 34.4,
        "notes": "ملاحظة اختبار",
        "photos": [],
        "createdAt": 1800000000000,
        "storage": "local-device",
    }
    saved = client.put("/records/NQ-TEST-RECORD-01", headers=headers_a, json={"record": record})
    assert saved.status_code == 200, saved.text
    assert saved.json()["storage"] == "cloud"

    fetched = client.get("/records", headers=headers_a)
    assert fetched.status_code == 200
    assert fetched.json()["count"] == 1
    assert fetched.json()["records"][0]["siteName"] == "موقع تجريبي"
    assert fetched.json()["records"][0]["storage"] == "cloud"

    other_user = client.get("/records", headers=headers_b)
    assert other_user.status_code == 200
    assert other_user.json()["count"] == 0

    deleted = client.delete("/records/NQ-TEST-RECORD-01", headers=headers_a)
    assert deleted.status_code == 200
    assert client.get("/records", headers=headers_a).json()["count"] == 0


def test_field_record_rejects_mismatched_ids_and_oversized_content():
    token = register(email="record-validation@example.com")
    headers = {"Authorization": f"Bearer {token}"}
    mismatch = client.put("/records/NQ-EXPECTED-01", headers=headers, json={
        "record": {"id": "NQ-DIFFERENT-01", "siteName": "Test", "photos": []}
    })
    assert mismatch.status_code == 422

    oversized = client.put("/records/NQ-LARGE-01", headers=headers, json={
        "record": {"id": "NQ-LARGE-01", "siteName": "Test", "photos": [], "notes": "x" * (32 * 1024 * 1024 + 1)}
    })
    assert oversized.status_code == 413


def test_field_records_require_authentication():
    assert client.get("/records").status_code == 401
    assert client.put("/records/NQ-UNAUTH-01", json={
        "record": {"id": "NQ-UNAUTH-01", "siteName": "Test", "photos": []}
    }).status_code == 401


def test_payment_status_stays_disabled_even_if_readiness_values_exist(monkeypatch):
    monkeypatch.setenv("FIELD_LAB_TRON_USDT_RECEIVE_ADDRESS", "T_TEST_ONLY_NOT_A_REAL_ADDRESS")
    monkeypatch.setenv("TRONGRID_API_KEY", "test-only-not-a-real-key")
    response = client.get("/payments/status")
    assert response.status_code == 200
    body = response.json()
    assert body["payments_enabled"] is False
    assert "withdrawals_enabled" not in body
    assert body["receive_address_configured"] is False
    assert body["chain_provider_configured"] is True
    assert body["persistent_database_configured"] is False


def test_consume_rejects_unknown_action():
    token = register()
    response = client.post(
        "/usage/consume",
        headers={"Authorization": f"Bearer {token}"},
        json={"action": "payment"},
    )
    assert response.status_code == 422



def test_subscription_activates_only_after_verified_payment(monkeypatch):
    # Mock the chain verifier: this test never sends real money or contacts TRON.
    monkeypatch.setattr("main.payments_enabled", lambda: True)
    monkeypatch.setattr("main.check_mainnet_provider", lambda api_key: 123456)
    monkeypatch.setenv("FIELD_LAB_TRON_USDT_RECEIVE_ADDRESS", USDT_TRON_CONTRACT)
    token = register()
    headers = {"Authorization": f"Bearer {token}"}
    invoice_response = client.post("/payments/intents", headers=headers, json={"plan_code": "daily", "payer_address": USDT_TRON_CONTRACT})
    assert invoice_response.status_code == 201, invoice_response.text
    invoice = invoice_response.json()
    assert invoice["amount_usdt"] == "10"
    assert invoice["network"] == "TRON (TRC20)"
    txid = "cd" * 32
    transfer = VerifiedUSDTTransfer(
        txid=txid,
        amount_base_units=10_000_000,
        block_number=12345,
        block_timestamp_ms=int(datetime.now(timezone.utc).timestamp() * 1000),
        confirmations=21,
    )
    with patch("main.verify_usdt_transfer", return_value=transfer) as verifier:
        response = client.post("/payments/verify", headers=headers, json={
            "intent_id": invoice["intent_id"], "txid": txid,
        })
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "confirmed"
    verifier.assert_called_once()
    usage = client.get("/me/usage", headers=headers).json()
    assert usage["plan"] == "daily"
    assert usage["payment_enabled"] is True

    second_invoice = client.post("/payments/intents", headers=headers, json={"plan_code": "daily", "payer_address": USDT_TRON_CONTRACT})
    assert second_invoice.status_code == 201, second_invoice.text
    duplicate = client.post("/payments/verify", headers=headers, json={
        "intent_id": second_invoice.json()["intent_id"], "txid": txid,
    })
    assert duplicate.status_code == 409


def test_usage_request_id_is_idempotent():
    token = register()
    headers = {"Authorization": f"Bearer {token}"}
    payload = {"action": "site", "request_id": "NQ-ONCE-0001"}
    first = client.post("/usage/consume", headers=headers, json=payload)
    second = client.post("/usage/consume", headers=headers, json=payload)
    assert first.status_code == second.status_code == 200
    assert first.json()["sites_used"] == second.json()["sites_used"] == 1


def test_concurrent_open_invoices_use_distinct_exact_amounts(monkeypatch):
    monkeypatch.setattr("main.payments_enabled", lambda: True)
    monkeypatch.setattr("main.check_mainnet_provider", lambda api_key: 123456)
    monkeypatch.setenv("FIELD_LAB_TRON_USDT_RECEIVE_ADDRESS", USDT_TRON_CONTRACT)
    token_a = register(email="first-payer@example.com")
    token_b = register(email="second-payer@example.com")
    headers_a = {"Authorization": f"Bearer {token_a}"}
    headers_b = {"Authorization": f"Bearer {token_b}"}
    payer = USDT_TRON_CONTRACT
    first = client.post("/payments/intents", headers=headers_a,
                        json={"plan_code": "daily", "payer_address": payer})
    second = client.post("/payments/intents", headers=headers_b,
                         json={"plan_code": "daily", "payer_address": payer})
    assert first.status_code == second.status_code == 201
    assert first.json()["amount_usdt"] == "10"
    assert second.json()["amount_usdt"] != first.json()["amount_usdt"]
    assert second.json()["amount_usdt"].startswith("10.00000")
