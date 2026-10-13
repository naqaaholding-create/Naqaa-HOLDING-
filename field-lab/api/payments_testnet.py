"""Fail-closed TRON testnet verifier.

This module is deliberately testnet-only. It never credits an account, activates a
subscription, signs transactions, or sends funds. A configured token contract and
receiving address are mandatory. Production/mainnet endpoints are rejected.
"""
from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import json

NILE_API = "https://nile.trongrid.io"
TRANSFER_TOPIC0 = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
HEX40 = re.compile(r"^[0-9a-fA-F]{40}$")
HEX64 = re.compile(r"^[0-9a-fA-F]{64}$")


class VerificationError(ValueError):
    """The supplied transaction cannot be safely verified."""


@dataclass(frozen=True)
class VerifiedTransfer:
    txid: str
    token_contract_hex: str
    recipient_hex: str
    amount_base_units: int
    decimals: int
    block_number: int
    confirmations: int

    @property
    def amount(self) -> Decimal:
        return Decimal(self.amount_base_units) / (Decimal(10) ** self.decimals)


def _b58decode(value: str) -> bytes:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    number = 0
    for char in value:
        if char not in alphabet:
            raise VerificationError("Invalid Base58 address")
        number = number * 58 + alphabet.index(char)
    raw = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    pad = len(value) - len(value.lstrip("1"))
    return b"\x00" * pad + raw


def address_to_hex20(address: str) -> str:
    """Validate a TRON Base58Check address and return its 20-byte payload."""
    raw = _b58decode(address.strip())
    if len(raw) != 25:
        raise VerificationError("Invalid TRON address length")
    body, checksum = raw[:-4], raw[-4:]
    expected = hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
    if checksum != expected or len(body) != 21 or body[0] != 0x41:
        raise VerificationError("Invalid TRON address checksum/network")
    return body[1:].hex()


def _request_json(base: str, path: str, api_key: str = "", payload: dict[str, Any] | None = None) -> dict[str, Any]:
    if base != NILE_API:
        raise VerificationError("Only the official Nile testnet API is allowed")
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if api_key:
        headers["TRON-PRO-API-KEY"] = api_key
    request = Request(base + path, data=json.dumps(payload or {}).encode("utf-8"), headers=headers, method="POST")
    try:
        with urlopen(request, timeout=12) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise VerificationError("Testnet provider unavailable; transaction not verified") from exc
    if not isinstance(payload, dict):
        raise VerificationError("Unexpected provider response")
    return payload


def verify_testnet_transfer(
    txid: str,
    *,
    receiving_address: str,
    token_contract: str,
    decimals: int = 6,
    min_confirmations: int = 2,
    api_key: str = "",
    api_base: str = NILE_API,
) -> VerifiedTransfer:
    """Verify a settled TRC20 Transfer on Nile testnet; fail closed on any ambiguity."""
    txid = txid.strip().lower()
    if not HEX64.fullmatch(txid):
        raise VerificationError("Transaction ID must be 64 hexadecimal characters")
    if api_base != NILE_API:
        raise VerificationError("Mainnet verification is intentionally disabled")
    if not HEX40.fullmatch(token_contract.strip()):
        raise VerificationError("Configure the Nile test-token contract as 40 hex characters")
    if not 0 <= decimals <= 18 or min_confirmations < 1:
        raise VerificationError("Invalid token precision or confirmation threshold")

    expected_recipient = address_to_hex20(receiving_address)
    expected_contract = token_contract.strip().lower()

    info = _request_json(api_base, "/wallet/gettransactioninfobyid", api_key, {"value": txid})
    if info.get("id", "").lower() != txid:
        raise VerificationError("Provider returned a different transaction")
    if info.get("receipt", {}).get("result") != "SUCCESS":
        raise VerificationError("Transaction is not confirmed successful")
    block_number = info.get("blockNumber")
    logs = info.get("log")
    if not isinstance(block_number, int) or not isinstance(logs, list):
        raise VerificationError("Transaction is not yet included in a confirmed block")

    head = _request_json(api_base, "/wallet/getnowblock", api_key)
    try:
        current_block = int(head["block_header"]["raw_data"]["number"])
    except (KeyError, TypeError, ValueError) as exc:
        raise VerificationError("Could not determine testnet confirmation count") from exc
    confirmations = current_block - block_number + 1
    if confirmations < min_confirmations:
        raise VerificationError("Insufficient testnet confirmations")

    matches = []
    for log in logs:
        if not isinstance(log, dict):
            continue
        contract = str(log.get("address", "")).lower().removeprefix("41")
        topics = log.get("topics", [])
        data = str(log.get("data", ""))
        if contract != expected_contract or not isinstance(topics, list) or len(topics) < 3:
            continue
        if str(topics[0]).lower().removeprefix("0x") != TRANSFER_TOPIC0:
            continue
        to_topic = str(topics[2]).lower().removeprefix("0x")
        if len(to_topic) != 64 or to_topic[-40:] != expected_recipient:
            continue
        if not re.fullmatch(r"[0-9a-fA-F]{64}", data):
            continue
        matches.append(int(data, 16))

    if len(matches) != 1:
        raise VerificationError("Expected exactly one matching token transfer in transaction")
    if matches[0] <= 0:
        raise VerificationError("Transfer amount must be positive")
    return VerifiedTransfer(
        txid=txid,
        token_contract_hex=expected_contract,
        recipient_hex=expected_recipient,
        amount_base_units=matches[0],
        decimals=decimals,
        block_number=block_number,
        confirmations=confirmations,
    )


def verify_from_environment(txid: str) -> VerifiedTransfer:
    """Environment wrapper; refuses to run unless explicitly in test mode."""
    if os.getenv("FIELD_LAB_ENV", "development").lower() != "test":
        raise VerificationError("Testnet verifier is available only when FIELD_LAB_ENV=test")
    address = os.getenv("FIELD_LAB_TRON_TEST_RECEIVE_ADDRESS", "").strip()
    contract = os.getenv("TRON_TESTNET_USDT_CONTRACT", "").strip()
    if not address or not contract:
        raise VerificationError("Configure a Nile test receiving address and test-token contract")
    return verify_testnet_transfer(
        txid,
        receiving_address=address,
        token_contract=contract,
        decimals=int(os.getenv("TRON_TESTNET_TOKEN_DECIMALS", "6")),
        min_confirmations=int(os.getenv("TRON_TESTNET_MIN_CONFIRMATIONS", "2")),
        api_key=os.getenv("TRONGRID_API_KEY", "").strip(),
    )
