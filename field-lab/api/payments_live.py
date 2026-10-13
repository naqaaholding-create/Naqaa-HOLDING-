"""Mainnet-only verifier for subscription payments in canonical USDT on TRON."""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

TRON_MAINNET_API = "https://api.trongrid.io"
# Tether's official TRC20 USDT contract on TRON.
USDT_TRON_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
TRANSFER_TOPIC0 = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
HEX64 = re.compile(r"^[0-9a-fA-F]{64}$")


class PaymentVerificationError(ValueError):
    """A transfer is not safe to accept as payment."""


@dataclass(frozen=True)
class VerifiedUSDTTransfer:
    txid: str
    amount_base_units: int
    block_number: int
    block_timestamp_ms: int
    confirmations: int


def _b58decode(value: str) -> bytes:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    number = 0
    for char in value:
        if char not in alphabet:
            raise PaymentVerificationError("Invalid Base58 address")
        number = number * 58 + alphabet.index(char)
    raw = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    return b"\x00" * (len(value) - len(value.lstrip("1"))) + raw


def address_to_hex20(value: str) -> str:
    """Validate TRON mainnet Base58Check and return its 20-byte address payload."""
    raw = _b58decode(value.strip())
    if len(raw) != 25:
        raise PaymentVerificationError("Invalid TRON address length")
    body, checksum = raw[:-4], raw[-4:]
    expected = hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
    if checksum != expected or len(body) != 21 or body[0] != 0x41:
        raise PaymentVerificationError("Invalid TRON address checksum/network")
    return body[1:].hex()


def _request_json(path: str, api_key: str = "", payload: dict[str, Any] | None = None) -> dict[str, Any]:
    # Fixed official mainnet host. A caller cannot redirect payment verification to another RPC.
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if api_key:
        headers["TRON-PRO-API-KEY"] = api_key
    request = Request(
        TRON_MAINNET_API + path,
        data=json.dumps(payload or {}).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(request, timeout=15) as response:
            result = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise PaymentVerificationError("TRON provider unavailable; transaction was not verified") from exc
    if not isinstance(result, dict):
        raise PaymentVerificationError("Unexpected TRON provider response")
    return result


def check_mainnet_provider(api_key: str = "") -> int:
    """Probe the fixed mainnet endpoint before showing a customer a live invoice."""
    head = _request_json("/wallet/getnowblock", api_key)
    try:
        block_number = int(head["block_header"]["raw_data"]["number"])
    except (KeyError, TypeError, ValueError) as exc:
        raise PaymentVerificationError("Could not determine current TRON block") from exc
    if block_number < 1:
        raise PaymentVerificationError("TRON provider returned an invalid block height")
    return block_number


def verify_usdt_transfer(
    txid: str,
    *,
    receiving_address: str,
    payer_address: str,
    expected_amount_base_units: int,
    api_key: str = "",
    min_confirmations: int = 20,
    earliest_timestamp_ms: int | None = None,
    latest_timestamp_ms: int | None = None,
) -> VerifiedUSDTTransfer:
    """Verify one exact, successful USDT transfer to the configured receiver on mainnet."""
    txid = txid.strip().lower()
    if not HEX64.fullmatch(txid):
        raise PaymentVerificationError("Transaction ID must contain 64 hexadecimal characters")
    if expected_amount_base_units <= 0:
        raise PaymentVerificationError("Expected payment amount must be positive")
    if min_confirmations < 20:
        raise PaymentVerificationError("Production confirmation threshold cannot be below 20")

    receiver_hex = address_to_hex20(receiving_address)
    payer_hex = address_to_hex20(payer_address)
    contract_hex = address_to_hex20(USDT_TRON_CONTRACT)

    info = _request_json("/wallet/gettransactioninfobyid", api_key, {"value": txid})
    if str(info.get("id", "")).lower() != txid:
        raise PaymentVerificationError("TRON provider did not return the requested transaction")
    if info.get("receipt", {}).get("result") != "SUCCESS":
        raise PaymentVerificationError("Transaction has not succeeded on-chain")

    block_number = info.get("blockNumber")
    timestamp_ms = info.get("blockTimeStamp")
    logs = info.get("log")
    if not isinstance(block_number, int) or not isinstance(timestamp_ms, int) or not isinstance(logs, list):
        raise PaymentVerificationError("Transaction is not yet confirmed in a block")
    if earliest_timestamp_ms is not None and timestamp_ms < earliest_timestamp_ms:
        raise PaymentVerificationError("Transfer predates this payment request")
    if latest_timestamp_ms is not None and timestamp_ms > latest_timestamp_ms:
        raise PaymentVerificationError("Payment request expired before this transfer")

    head = _request_json("/wallet/getnowblock", api_key)
    try:
        current_block = int(head["block_header"]["raw_data"]["number"])
    except (KeyError, TypeError, ValueError) as exc:
        raise PaymentVerificationError("Could not determine current TRON block") from exc
    confirmations = current_block - block_number + 1
    if confirmations < min_confirmations:
        raise PaymentVerificationError("Insufficient TRON confirmations")

    matches: list[int] = []
    for log in logs:
        if not isinstance(log, dict):
            continue
        contract = str(log.get("address", "")).lower().removeprefix("0x").removeprefix("41")
        topics = log.get("topics", [])
        data = str(log.get("data", ""))
        if contract != contract_hex or not isinstance(topics, list) or len(topics) < 3:
            continue
        if str(topics[0]).lower().removeprefix("0x") != TRANSFER_TOPIC0:
            continue
        sender_topic = str(topics[1]).lower().removeprefix("0x")
        recipient_topic = str(topics[2]).lower().removeprefix("0x")
        if len(sender_topic) != 64 or sender_topic[-40:] != payer_hex:
            continue
        if len(recipient_topic) != 64 or recipient_topic[-40:] != receiver_hex:
            continue
        if not HEX64.fullmatch(data):
            continue
        matches.append(int(data, 16))

    if len(matches) != 1:
        raise PaymentVerificationError("Expected exactly one USDT transfer to the receiving address")
    if matches[0] != expected_amount_base_units:
        raise PaymentVerificationError("Received amount does not exactly match the subscription price")
    return VerifiedUSDTTransfer(
        txid=txid,
        amount_base_units=matches[0],
        block_number=block_number,
        block_timestamp_ms=timestamp_ms,
        confirmations=confirmations,
    )
