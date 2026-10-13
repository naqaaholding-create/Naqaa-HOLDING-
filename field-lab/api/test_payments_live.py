import hashlib
import unittest
from unittest.mock import patch

from payments_live import (
    PaymentVerificationError,
    TRANSFER_TOPIC0,
    USDT_TRON_CONTRACT,
    address_to_hex20,
    verify_usdt_transfer,
)


def make_tron_address(payload20: bytes) -> str:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    body = b"\x41" + payload20
    checksum = hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
    raw = body + checksum
    number = int.from_bytes(raw, "big")
    chars = ""
    while number:
        number, rem = divmod(number, 58)
        chars = alphabet[rem] + chars
    return "1" * (len(raw) - len(raw.lstrip(b"\x00"))) + (chars or "1")


class TestMainnetPaymentVerifier(unittest.TestCase):
    def setUp(self):
        self.recipient = make_tron_address(bytes.fromhex("11" * 20))
        self.sender = make_tron_address(bytes.fromhex("22" * 20))
        self.txid = "ab" * 32
        self.amount = 10_000_000
        self.contract = address_to_hex20(USDT_TRON_CONTRACT)

    def event(self, recipient_hex=None, amount=None, contract=None, sender_hex=None):
        recipient_hex = recipient_hex or "11" * 20
        sender_hex = sender_hex or "22" * 20
        amount = self.amount if amount is None else amount
        contract = contract or self.contract
        return {
            "address": "41" + contract,
            "topics": [TRANSFER_TOPIC0, "0" * 24 + sender_hex, "0" * 24 + recipient_hex],
            "data": hex(amount)[2:].zfill(64),
        }

    def mocked_info(self, event=None, **overrides):
        info = {
            "id": self.txid,
            "blockNumber": 100,
            "blockTimeStamp": 1_800_000_000_000,
            "receipt": {"result": "SUCCESS"},
            "log": [event or self.event()],
        }
        info.update(overrides)
        return info

    @patch("payments_live._request_json")
    def test_verifies_exact_confirmed_transfer(self, request_json):
        request_json.side_effect = [
            self.mocked_info(),
            {"block_header": {"raw_data": {"number": 120}}},
        ]
        transfer = verify_usdt_transfer(
            self.txid, receiving_address=self.recipient, payer_address=self.sender, expected_amount_base_units=self.amount
        )
        self.assertEqual(transfer.amount_base_units, self.amount)
        self.assertEqual(transfer.confirmations, 21)
        self.assertEqual(request_json.call_args_list[0].args[0], "/wallet/gettransactioninfobyid")

    @patch("payments_live._request_json")
    def test_rejects_wrong_recipient(self, request_json):
        request_json.side_effect = [
            self.mocked_info(event=self.event(recipient_hex="22" * 20)),
            {"block_header": {"raw_data": {"number": 120}}},
        ]
        with self.assertRaises(PaymentVerificationError):
            verify_usdt_transfer(self.txid, receiving_address=self.recipient, payer_address=self.sender, expected_amount_base_units=self.amount)

    @patch("payments_live._request_json")
    def test_rejects_wrong_payer(self, request_json):
        request_json.side_effect = [
            self.mocked_info(event=self.event(sender_hex="33" * 20)),
            {"block_header": {"raw_data": {"number": 120}}},
        ]
        with self.assertRaises(PaymentVerificationError):
            verify_usdt_transfer(
                self.txid, receiving_address=self.recipient, payer_address=self.sender,
                expected_amount_base_units=self.amount
            )

    @patch("payments_live._request_json")
    def test_rejects_wrong_amount(self, request_json):
        request_json.side_effect = [
            self.mocked_info(event=self.event(amount=self.amount + 1)),
            {"block_header": {"raw_data": {"number": 120}}},
        ]
        with self.assertRaises(PaymentVerificationError):
            verify_usdt_transfer(self.txid, receiving_address=self.recipient, payer_address=self.sender, expected_amount_base_units=self.amount)

    @patch("payments_live._request_json")
    def test_rejects_insufficient_confirmations(self, request_json):
        request_json.side_effect = [
            self.mocked_info(),
            {"block_header": {"raw_data": {"number": 101}}},
        ]
        with self.assertRaises(PaymentVerificationError):
            verify_usdt_transfer(self.txid, receiving_address=self.recipient, payer_address=self.sender, expected_amount_base_units=self.amount)

    def test_rejects_invalid_recipient(self):
        with self.assertRaises(PaymentVerificationError):
            address_to_hex20("T_NOT_A_VALID_ADDRESS")

    @patch("payments_live._request_json")
    def test_rejects_transfer_outside_invoice_window(self, request_json):
        request_json.side_effect = [
            self.mocked_info(),
            {"block_header": {"raw_data": {"number": 120}}},
        ]
        with self.assertRaises(PaymentVerificationError):
            verify_usdt_transfer(
                self.txid,
                receiving_address=self.recipient,
                payer_address=self.sender,
                expected_amount_base_units=self.amount,
                earliest_timestamp_ms=1_800_000_000_001,
            )


if __name__ == "__main__":
    unittest.main()
