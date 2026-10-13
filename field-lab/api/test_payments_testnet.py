import hashlib
import unittest
from unittest.mock import patch

from payments_testnet import (
    NILE_API,
    TRANSFER_TOPIC0,
    VerificationError,
    address_to_hex20,
    verify_testnet_transfer,
)


def tron_address(payload20: bytes) -> str:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    body = b"\x41" + payload20
    checksum = hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
    raw = body + checksum
    number = int.from_bytes(raw, "big")
    chars = ""
    while number:
        number, rem = divmod(number, 58)
        chars = alphabet[rem] + chars
    zeros = len(raw) - len(raw.lstrip(b"\x00"))
    return "1" * zeros + (chars or "1")


class TestTestnetVerifier(unittest.TestCase):
    def setUp(self):
        self.recipient = tron_address(bytes.fromhex("11" * 20))
        self.txid = "ab" * 32
        self.contract = "22" * 20

    def test_address_checksum_and_network(self):
        self.assertEqual(address_to_hex20(self.recipient), "11" * 20)
        with self.assertRaises(VerificationError):
            address_to_hex20(self.recipient[:-1] + ("1" if self.recipient[-1] != "1" else "2"))

    def test_rejects_mainnet_endpoint(self):
        with self.assertRaises(VerificationError):
            verify_testnet_transfer(
                self.txid, receiving_address=self.recipient,
                token_contract=self.contract, api_base="https://api.trongrid.io"
            )

    def test_rejects_bad_txid(self):
        with self.assertRaises(VerificationError):
            verify_testnet_transfer(
                "not-a-hash", receiving_address=self.recipient,
                token_contract=self.contract
            )

    @patch("payments_testnet._request_json")
    def test_verifies_exact_token_recipient_and_amount(self, request_json):
        recipient_topic = "0" * 24 + "11" * 20
        request_json.side_effect = [
            {
                "id": self.txid,
                "blockNumber": 100,
                "receipt": {"result": "SUCCESS"},
                "log": [{
                    "address": self.contract,
                    "topics": [TRANSFER_TOPIC0, "0" * 64, recipient_topic],
                    "data": hex(25_000_000)[2:].zfill(64),
                }],
            },
            {"block_header": {"raw_data": {"number": 102}}},
        ]
        transfer = verify_testnet_transfer(
            self.txid, receiving_address=self.recipient,
            token_contract=self.contract, min_confirmations=2
        )
        self.assertEqual(str(transfer.amount), "25")
        self.assertEqual(transfer.confirmations, 3)
        self.assertEqual(request_json.call_args_list[0].args[:2], (NILE_API, "/wallet/gettransactioninfobyid"))

    @patch("payments_testnet._request_json")
    def test_rejects_wrong_recipient(self, request_json):
        request_json.side_effect = [
            {
                "id": self.txid, "blockNumber": 100,
                "receipt": {"result": "SUCCESS"},
                "log": [{
                    "address": self.contract, "topics": [TRANSFER_TOPIC0, "0" * 64, "0" * 64],
                    "data": hex(10**6)[2:].zfill(64),
                }],
            },
            {"block_header": {"raw_data": {"number": 105}}},
        ]
        with self.assertRaises(VerificationError):
            verify_testnet_transfer(
                self.txid, receiving_address=self.recipient,
                token_contract=self.contract
            )


if __name__ == "__main__":
    unittest.main()
