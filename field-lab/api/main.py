"""NAQAA Field Lab API: accounts and server-enforced usage quotas.
Payment processing is intentionally not implemented; paid plans cannot be self-activated.
"""
from __future__ import annotations

import os
import json
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone
from typing import Generator

import jwt
from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field
from pwdlib import PasswordHash
from sqlalchemy import DateTime, ForeignKey, Integer, String, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

DATABASE_URL = os.getenv("FIELD_LAB_DATABASE_URL", "sqlite:///./field_lab.db")
JWT_SECRET = os.getenv("FIELD_LAB_JWT_SECRET")
TOKEN_HOURS = int(os.getenv("FIELD_LAB_TOKEN_HOURS", "12"))
password_hash = PasswordHash.recommended()

if not JWT_SECRET:
    # Safe for local preview only; set a stable secret in deployment.
    if os.getenv("FIELD_LAB_ENV", "development") == "production":
        raise RuntimeError("FIELD_LAB_JWT_SECRET must be set in production")
    JWT_SECRET = "local-preview-only-change-before-deployment"

connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "field_lab_users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_digest: Mapped[str] = mapped_column(String(512))
    plan: Mapped[str] = mapped_column(String(20), default="free")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    plan_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    sites_used: Mapped[int] = mapped_column(Integer, default=0)
    questions_used: Mapped[int] = mapped_column(Integer, default=0)
    usage_window_started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))




class Payment(Base):
    __tablename__ = "field_lab_payments"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("field_lab_users.id"), index=True)
    plan: Mapped[str] = mapped_column(String(20))
    expected_amount: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    txid: Mapped[str | None] = mapped_column(String(128), unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


Base.metadata.create_all(bind=engine)
app = FastAPI(title="NAQAA Field Lab API", version="0.1.0", description="Accounts and usage quotas for NAQAA Field Lab.")

allowed_origins = [x.strip() for x in os.getenv("FIELD_LAB_ALLOWED_ORIGINS", "").split(",") if x.strip()]
if allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )


PLANS = {
    "free": {"price_usd": 0, "duration_days": None, "sites": 2, "questions": 10, "window_days": None, "label": "التجربة المجانية"},
    "daily": {"price_usd": 10, "duration_days": 1, "sites": 2, "questions": 20, "window_days": 1, "label": "الاشتراك اليومي"},
    "weekly": {"price_usd": 50, "duration_days": 7, "sites": 10, "questions": 100, "window_days": 7, "label": "الاشتراك الأسبوعي"},
    "monthly": {"price_usd": 100, "duration_days": 30, "sites": 30, "questions": 300, "window_days": 30, "label": "الاشتراك الشهري"},
}


class RegisterInput(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)


class LoginInput(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class TokenOutput(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UsageOutput(BaseModel):
    plan: str
    plan_label: str
    price_usd: int
    sites_used: int
    sites_limit: int
    questions_used: int
    questions_limit: int
    expires_at: datetime | None
    payment_enabled: bool = False


class ConsumeInput(BaseModel):
    action: str = Field(pattern="^(site|question)$")




class PaymentCreateInput(BaseModel):
    plan: str = Field(pattern="^(daily|weekly|monthly)$")


class PaymentConfirmInput(BaseModel):
    payment_id: int = Field(gt=0)
    txid: str = Field(min_length=64, max_length=128, pattern="^[a-fA-F0-9]+$")

def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_token(user_id: int) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode({"sub": str(user_id), "iat": now, "exp": now + timedelta(hours=TOKEN_HOURS)}, JWT_SECRET, algorithm="HS256")


def current_user(authorization: str | None = Header(default=None), db: Session = Depends(get_db)) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="يلزم تسجيل الدخول")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, ValueError, KeyError):
        raise HTTPException(status_code=401, detail="رمز الدخول غير صالح أو منتهي")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=401, detail="الحساب غير موجود")
    return user


def active_plan(user: User) -> str:
    if user.plan != "free" and user.plan_expires_at:
        expires = user.plan_expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if expires <= datetime.now(timezone.utc):
            return "free"
    return user.plan if user.plan in PLANS else "free"


def refresh_window_if_needed(user: User, plan_name: str) -> None:
    if plan_name == "free":
        return  # Free trial quota is lifetime, not reset by logging in again.
    plan = PLANS[plan_name]
    started = user.usage_window_started_at
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    window_days = plan["window_days"] or 1
    if now >= started + timedelta(days=window_days):
        user.sites_used = 0
        user.questions_used = 0
        user.usage_window_started_at = now


def usage_for(user: User) -> UsageOutput:
    plan_name = active_plan(user)
    plan = PLANS[plan_name]
    expires = user.plan_expires_at if plan_name != "free" else None
    return UsageOutput(
        plan=plan_name, plan_label=plan["label"], price_usd=plan["price_usd"],
        sites_used=user.sites_used, sites_limit=plan["sites"],
        questions_used=user.questions_used, questions_limit=plan["questions"],
        expires_at=expires,
    )


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "naqaa-field-lab-api", "payments_enabled": False}


@app.get("/plans")
def list_plans() -> dict:
    return {"plans": PLANS, "payments_enabled": False, "note": "الأسعار والحدود مقترحة؛ لا يمكن شراء أو تفعيل الباقات المدفوعة من هذه الواجهة."}

@app.get("/payments/status")
def payment_status() -> dict:
    """Expose readiness only; this endpoint never accepts money or activates subscriptions."""
    receive_address = os.getenv("FIELD_LAB_TRON_USDT_RECEIVE_ADDRESS", "").strip()
    provider_key = os.getenv("TRONGRID_API_KEY", "").strip()
    return {
        "payments_enabled": False,
        "withdrawals_enabled": False,
        "network": "TRON",
        "token": "USDT-TRC20",
        "receive_address_configured": bool(receive_address),
        "chain_provider_configured": bool(provider_key),
        "note": (
            "الدفع الحقيقي غير مفعّل. يلزم إكمال التحقق من معاملات TRON، وسجل مالي آمن، "
            "ومراجعة إدارية للسحب، واختبارات أمنية قبل استقبال أموال حقيقية."
        ),
    }




TRON_API_BASE = os.getenv("TRON_API_BASE", "https://api.trongrid.io").rstrip("/")
TRON_USDT_CONTRACT = os.getenv("FIELD_LAB_TRON_USDT_CONTRACT", "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj")
DEFAULT_RECEIVE_ADDRESS = "TXPtDuKPXKrTWLpnDH7z25tDsPt2zqv4a5"


def _verified_transfer(txid: str) -> dict:
    headers = {"Accept": "application/json", "User-Agent": "NAQAA-Field-Lab/1.0"}
    key = os.getenv("TRONGRID_API_KEY", "").strip()
    if key:
        headers["TRON-PRO-API-KEY"] = key
    url = f"{TRON_API_BASE}/v1/transactions/{urllib.parse.quote(txid)}/events?only_confirmed=true&limit=200&contract_address={urllib.parse.quote(TRON_USDT_CONTRACT)}"
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=503, detail="تعذر التحقق من شبكة TRON؛ أعد المحاولة") from exc
    for event in body.get("data", []):
        if event.get("transaction_id", "").lower() == txid.lower() and event.get("event_name") == "Transfer":
            token = event.get("token_info") or {}
            result = event.get("result") or {}
            return {"to": result.get("to"), "value": result.get("value"), "decimals": int(token.get("decimals", 6)), "contract": token.get("address")}
    raise HTTPException(status_code=400, detail="لم يُعثر على تحويل USDT مؤكد بهذه المعاملة")


@app.get("/payments/status")
def payment_status() -> dict:
    return {"payments_enabled": True, "withdrawals_enabled": False, "network": "TRON", "token": "USDT-TRC20", "receive_address": os.getenv("FIELD_LAB_TRON_USDT_RECEIVE_ADDRESS", DEFAULT_RECEIVE_ADDRESS), "token_contract": TRON_USDT_CONTRACT}


@app.post("/payments/create", status_code=201)
def create_payment(payload: PaymentCreateInput, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    plan = PLANS[payload.plan]
    payment = Payment(user_id=user.id, plan=payload.plan, expected_amount=f'{plan["price_usd"]:.2f}')
    db.add(payment)
    db.commit()
    db.refresh(payment)
    return {"payment_id": payment.id, "plan": payment.plan, "amount": payment.expected_amount, "currency": "USDT", "network": "TRC20", "receive_address": os.getenv("FIELD_LAB_TRON_USDT_RECEIVE_ADDRESS", DEFAULT_RECEIVE_ADDRESS), "token_contract": TRON_USDT_CONTRACT, "status": payment.status}


@app.post("/payments/confirm")
def confirm_payment(payload: PaymentConfirmInput, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    payment = db.scalar(select(Payment).where(Payment.id == payload.payment_id, Payment.user_id == user.id))
    if payment is None:
        raise HTTPException(status_code=404, detail="طلب الدفع غير موجود")
    if payment.status == "confirmed":
        if payment.txid == payload.txid.lower():
            return {"status": "confirmed", "plan": payment.plan, "expires_at": user.plan_expires_at}
        raise HTTPException(status_code=409, detail="طلب الدفع مؤكد مسبقًا")
    transfer = _verified_transfer(payload.txid)
    address = os.getenv("FIELD_LAB_TRON_USDT_RECEIVE_ADDRESS", DEFAULT_RECEIVE_ADDRESS).strip()
    if (transfer["to"] or "").lower() != address.lower() or (transfer["contract"] or "").lower() != TRON_USDT_CONTRACT.lower():
        raise HTTPException(status_code=400, detail="عنوان الاستقبال أو عقد USDT غير مطابق")
    try:
        amount = int(transfer["value"]) / (10 ** transfer["decimals"])
    except (ValueError, TypeError, ZeroDivisionError):
        raise HTTPException(status_code=400, detail="مبلغ التحويل غير صالح")
    if abs(amount - float(payment.expected_amount)) > 0.000001:
        raise HTTPException(status_code=400, detail=f"المبلغ غير مطابق؛ المطلوب {payment.expected_amount} USDT")
    if db.scalar(select(Payment).where(Payment.txid == payload.txid.lower())):
        raise HTTPException(status_code=409, detail="معرّف المعاملة مستخدم سابقًا")
    now = datetime.now(timezone.utc)
    expiry = user.plan_expires_at
    if expiry and expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    start = expiry if expiry and expiry > now else now
    user.plan = payment.plan
    user.plan_expires_at = start + timedelta(days=PLANS[payment.plan]["duration_days"])
    user.sites_used = 0
    user.questions_used = 0
    user.usage_window_started_at = now
    payment.status = "confirmed"
    payment.txid = payload.txid.lower()
    payment.confirmed_at = now
    db.add_all([user, payment])
    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="المعاملة ربما سجلت سابقًا") from exc
    return {"status": "confirmed", "plan": payment.plan, "expires_at": user.plan_expires_at, "amount": payment.expected_amount, "currency": "USDT", "network": "TRC20"}



@app.post("/auth/register", response_model=TokenOutput, status_code=201)
def register(payload: RegisterInput, db: Session = Depends(get_db)) -> TokenOutput:
    email = str(payload.email).strip().lower()
    existing = db.scalar(select(User).where(User.email == email))
    if existing:
        raise HTTPException(status_code=409, detail="هذا البريد مسجل مسبقًا")
    user = User(email=email, password_digest=password_hash.hash(payload.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    return TokenOutput(access_token=create_token(user.id))


@app.post("/auth/login", response_model=TokenOutput)
def login(payload: LoginInput, db: Session = Depends(get_db)) -> TokenOutput:
    email = str(payload.email).strip().lower()
    user = db.scalar(select(User).where(User.email == email))
    if not user or not password_hash.verify(payload.password, user.password_digest):
        raise HTTPException(status_code=401, detail="البريد أو كلمة المرور غير صحيحة")
    return TokenOutput(access_token=create_token(user.id))


@app.get("/me/usage", response_model=UsageOutput)
def get_usage(user: User = Depends(current_user), db: Session = Depends(get_db)) -> UsageOutput:
    plan_name = active_plan(user)
    refresh_window_if_needed(user, plan_name)
    db.add(user)
    db.commit()
    db.refresh(user)
    return usage_for(user)


@app.post("/usage/consume", response_model=UsageOutput)
def consume(payload: ConsumeInput, user: User = Depends(current_user), db: Session = Depends(get_db)) -> UsageOutput:
    plan_name = active_plan(user)
    refresh_window_if_needed(user, plan_name)
    plan = PLANS[plan_name]
    if payload.action == "site":
        if user.sites_used >= plan["sites"]:
            db.commit()
            raise HTTPException(status_code=429, detail="انتهت حصة المواقع لهذه الباقة")
        user.sites_used += 1
    else:
        if user.questions_used >= plan["questions"]:
            db.commit()
            raise HTTPException(status_code=429, detail="انتهت حصة الاستفسارات لهذه الباقة")
        user.questions_used += 1
    db.add(user)
    db.commit()
    db.refresh(user)
    return usage_for(user)


@app.get("/me")
def get_me(user: User = Depends(current_user)) -> dict:
    return {"id": user.id, "email": user.email, "plan": active_plan(user), "created_at": user.created_at}
