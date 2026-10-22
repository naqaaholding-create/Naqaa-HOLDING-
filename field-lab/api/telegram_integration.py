"""Telegram webhook integration for NAQAA Field Lab.

Configure TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and FIELD_LAB_PUBLIC_URL
as deployment secrets/settings. Register the webhook with Telegram after deployment.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter, Header, HTTPException, Request as FastAPIRequest

router = APIRouter(tags=["telegram"])


def _token() -> str:
    return os.getenv("TELEGRAM_BOT_TOKEN", "").strip()


def _secret() -> str:
    return os.getenv("TELEGRAM_WEBHOOK_SECRET", "").strip()


def _app_url() -> str:
    return os.getenv("FIELD_LAB_PUBLIC_URL", "").strip().rstrip("/")


def _send_message(chat_id: int, text: str, reply_markup: dict | None = None) -> None:
    token = _token()
    if not token:
        raise RuntimeError("Telegram bot token is not configured")
    body: dict = {"chat_id": chat_id, "text": text, "disable_web_page_preview": True}
    if reply_markup:
        body["reply_markup"] = reply_markup
    request = Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=8) as response:
            result = json.loads(response.read().decode("utf-8"))
        if not result.get("ok"):
            raise RuntimeError("Telegram rejected sendMessage")
    except (HTTPError, URLError, TimeoutError, ValueError) as exc:
        raise RuntimeError("Telegram API request failed") from exc


@router.get("/telegram/status")
def telegram_status() -> dict:
    configured = bool(_token() and _secret())
    return {
        "service": "naqaa-field-lab-telegram",
        "configured": configured,
        "webhook_ready": configured and bool(_app_url()),
        "app_url_configured": bool(_app_url()),
        "note": "Configure the bot token, webhook secret, public HTTPS app URL, then register the webhook with Telegram."
        if not configured or not _app_url()
        else "Bot settings are present; verify webhook registration in Telegram.",
    }


@router.post("/telegram/webhook")
async def telegram_webhook(
    request: FastAPIRequest,
    x_telegram_bot_api_secret_token: str | None = Header(default=None),
) -> dict:
    expected = _secret()
    if not _token() or not expected:
        raise HTTPException(status_code=503, detail="Telegram integration is not configured")
    supplied = x_telegram_bot_api_secret_token or ""
    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=403, detail="Invalid webhook secret")

    try:
        update = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid Telegram update") from exc

    message = update.get("message") or update.get("edited_message") or {}
    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    text = str(message.get("text") or "").strip()
    if not isinstance(chat_id, int) or not text.startswith("/"):
        return {"ok": True}

    command = text.split()[0].split("@", 1)[0].lower()
    app_url = _app_url()
    keyboard = None
    if app_url:
        keyboard = {
            "inline_keyboard": [[{"text": "فتح NAQAA Field Lab", "url": app_url}]]
        }

    if command in ("/start", "/app"):
        reply = (
            "مرحبًا بك في NAQAA Field Lab — مختبر نقاء الميداني.\n"
            "يمكنك توثيق المواقع والصور والملاحظات الميدانية. "
            "لا تعتبر الصور وحدها دليلًا على وجود آثار أو تجاويف أو مياه جوفية."
        )
    elif command in ("/help", "/about"):
        reply = (
            "أوامر NAQAA Field Lab:\n"
            "/start — بدء الاستخدام\n"
            "/app — فتح واجهة التطبيق\n"
            "/help — المساعدة\n\n"
            "احمِ بياناتك ولا ترسل كلمات مرور أو مفاتيح خاصة عبر Telegram."
        )
    else:
        reply = "استخدم /start لبدء الاستخدام أو /help لعرض المساعدة."

    try:
        _send_message(chat_id, reply, keyboard)
    except RuntimeError as exc:
        # Telegram can retry webhook deliveries; return a generic server error
        # rather than disclose bot credentials or provider responses.
        raise HTTPException(status_code=502, detail="Telegram message delivery failed") from exc
    return {"ok": True}
