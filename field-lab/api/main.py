"""NAQAA Field Lab API: accounts, quotas, and fail-closed verified USDT subscriptions."""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Generator, Literal

import jwt
from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field
from pwdlib import PasswordHash
from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, create_engine, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker
from payments_live import PaymentVerificationError, address_to_hex20, check_mainnet_provider, verify_usdt_transfer

DATABASE_URL = os.getenv("FIELD_LAB_DATABASE_URL", "sqlite:///./field_lab.db")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len("postgres://"):]
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len("postgresql://"):]
JWT_SECRET = os.getenv("FIELD_LAB_JWT_SECRET")
TOKEN_HOURS = int(os.getenv("FIELD_LAB_TOKEN_HOURS", "12"))
password_hash = PasswordHash.recommended()

if not JWT_SECRET:
    # Safe for local preview only; set a strong secret in deployment.
    if os.getenv("FIELD_LAB_ENV", "development").lower() == "production":
        raise RuntimeError("FIELD_LAB_JWT_SECRET must be set in production")
    JWT_SECRET = "local-preview-only-change-before-deployment"
if os.getenv("FIELD_LAB_ENV", "development").lower() == "production" and len(JWT_SECRET.encode("utf-8")) < 32:
    raise RuntimeError("FIELD_LAB_JWT_SECRET must contain at least 32 bytes in production")

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


class UsageReceipt(Base):
    __tablename__ = "field_lab_usage_receipts"
    __table_args__ = (UniqueConstraint("user_id", "action", "request_id", name="uq_usage_request_per_user"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("field_lab_users.id"), index=True)
    action: Mapped[str] = mapped_column(String(20))
    request_id: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class FieldRecord(Base):
    __tablename__ = "field_lab_records"
    __table_args__ = (UniqueConstraint("user_id", "record_id", name="uq_field_record_per_user"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("field_lab_users.id"), index=True)
    record_id: Mapped[str] = mapped_column(String(100))
    payload_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class PaymentIntent(Base):
    __tablename__ = "field_lab_payment_intents"
    __table_args__ = (
        Index(
            "uq_active_payment_amount",
            "amount_base_units",
            unique=True,
            postgresql_where=text("status = 'pending'"),
            sqlite_where=text("status = 'pending'"),
        ),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("field_lab_users.id"), index=True)
    plan_code: Mapped[str] = mapped_column(String(20))
    payer_address: Mapped[str] = mapped_column(String(40))
    amount_base_units: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    txid: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True, index=True)
    tx_block_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
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


class FieldRecordInput(BaseModel):
    record: dict


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
    request_id: str | None = Field(default=None, min_length=8, max_length=100, pattern="^[A-Za-z0-9_-]+$")


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
        payment_enabled=payments_enabled(),
    )


def payment_configuration_problems() -> list[str]:
    """Fail closed unless all production settings are valid."""
    problems: list[str] = []
    if len(JWT_SECRET.encode("utf-8")) < 32:
        problems.append("FIELD_LAB_JWT_SECRET must contain at least 32 bytes")
    if os.getenv("FIELD_LAB_ENV", "development").lower() != "production":
        problems.append("FIELD_LAB_ENV must be production")
    if os.getenv("FIELD_LAB_LIVE_PAYMENTS_ENABLED", "0").strip() != "1":
        problems.append("FIELD_LAB_LIVE_PAYMENTS_ENABLED is not enabled")
    receive_address = os.getenv("FIELD_LAB_TRON_USDT_RECEIVE_ADDRESS", "").strip()
    try:
        address_to_hex20(receive_address)
    except PaymentVerificationError:
        problems.append("A valid TRON mainnet receiving address is not configured")
    if not os.getenv("TRONGRID_API_KEY", "").strip():
        problems.append("TRONGRID_API_KEY is not configured")
    if not DATABASE_URL.startswith(("postgresql+psycopg://", "postgresql://", "postgres://")):
        problems.append("Persistent PostgreSQL is required for live payments")
    if not any(origin.lower().startswith("https://") for origin in allowed_origins):
        problems.append("At least one HTTPS frontend origin must be configured")
    try:
        confirmations = int(os.getenv("FIELD_LAB_TRON_MIN_CONFIRMATIONS", "20"))
        if confirmations < 20:
            problems.append("FIELD_LAB_TRON_MIN_CONFIRMATIONS must be at least 20")
    except ValueError:
        problems.append("FIELD_LAB_TRON_MIN_CONFIRMATIONS must be an integer")
    return problems


def payments_enabled() -> bool:
    return not payment_configuration_problems()


def format_usdt(amount_base_units: int) -> str:
    return f"{amount_base_units / 1_000_000:.6f}".rstrip("0").rstrip(".")


def utc_aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def payment_intent_output(intent: PaymentIntent, receive_address: str) -> dict:
    return {
        "intent_id": intent.id,
        "plan_code": intent.plan_code,
        "plan_label": PLANS[intent.plan_code]["label"],
        "payer_address": intent.payer_address,
        "amount_usdt": format_usdt(intent.amount_base_units),
        "currency": "USDT",
        "network": "TRON (TRC20)",
        "receive_address": receive_address,
        "status": intent.status,
        "created_at": intent.created_at,
        "expires_at": intent.expires_at,
        "confirmation_requirement": max(20, int(os.getenv("FIELD_LAB_TRON_MIN_CONFIRMATIONS", "20"))),
    }


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "naqaa-field-lab-api", "payments_enabled": payments_enabled()}


@app.get("/plans")
def list_plans() -> dict:
    return {"plans": PLANS, "currency": "USD", "payments_enabled": payments_enabled(),
            "note": "لا يُفعّل أي اشتراك مدفوع إلا بعد تأكيد التحويل على الشبكة من الخادم."}


@app.get("/payments/status")
def payment_status() -> dict:
    problems = payment_configuration_problems()
    api_key = os.getenv("TRONGRID_API_KEY", "").strip()
    if not problems:
        try:
            with engine.connect() as connection:
                connection.execute(text("SELECT 1"))
        except SQLAlchemyError:
            problems.append("The persistent database is unavailable; live invoices are disabled")
    if not problems:
        try:
            check_mainnet_provider(api_key)
        except PaymentVerificationError:
            problems.append("The TRON mainnet provider is unreachable; live invoices are disabled")
    receive_address = os.getenv("FIELD_LAB_TRON_USDT_RECEIVE_ADDRESS", "").strip()
    try:
        address_to_hex20(receive_address)
        address_valid = True
    except PaymentVerificationError:
        address_valid = False
    return {
        "payments_enabled": not problems,
        "network": "TRON",
        "token": "USDT-TRC20",
        "receive_address_configured": address_valid,
        "chain_provider_configured": bool(os.getenv("TRONGRID_API_KEY", "").strip()),
        "persistent_database_configured": DATABASE_URL.startswith(("postgresql+psycopg://", "postgresql://", "postgres://")),
        "receive_address": receive_address if not problems else None,
        "requirements_remaining": problems,
        "note": ("الدفع متاح. أنشئ طلبًا من التطبيق قبل التحويل." if not problems else
                 "الدفع مغلق حتى اكتمال إعداد الإنتاج: " + "؛ ".join(problems)),
    }


class CreatePaymentIntentInput(BaseModel):
    plan_code: Literal["daily", "weekly", "monthly"]
    payer_address: str = Field(min_length=30, max_length=40)


class VerifyPaymentInput(BaseModel):
    intent_id: str = Field(min_length=36, max_length=36)
    txid: str = Field(pattern="^[0-9a-fA-F]{64}$")


@app.post("/payments/intents", status_code=201)
def create_payment_intent(payload: CreatePaymentIntentInput, user: User = Depends(current_user),
                          db: Session = Depends(get_db)) -> dict:
    if not payments_enabled():
        raise HTTPException(status_code=503, detail="الدفع الحقيقي غير جاهز بعد. لم يتم إنشاء طلب دفع.")
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=503, detail="قاعدة البيانات الإنتاجية غير متاحة؛ لم يُنشأ طلب ولا ترسل أي مبلغ.") from exc
    try:
        check_mainnet_provider(os.getenv("TRONGRID_API_KEY", "").strip())
    except PaymentVerificationError as exc:
        raise HTTPException(status_code=503, detail="شبكة TRON غير متاحة للتحقق الآن؛ لم يُنشأ طلب ولا ترسل أي مبلغ.") from exc
    current_plan = active_plan(user)
    if current_plan != "free" and current_plan != payload.plan_code:
        raise HTTPException(status_code=409, detail="لديك اشتراك مدفوع نشط؛ جدّد الباقة نفسها أو انتظر انتهاءها.")
    payer_address = payload.payer_address.strip()
    try:
        address_to_hex20(payer_address)
    except PaymentVerificationError as exc:
        raise HTTPException(status_code=422, detail="عنوان المرسل ليس عنوان TRON Mainnet صالحًا.") from exc
    now = datetime.now(timezone.utc)
    # Expire old invoices before allocating a currently-unique on-chain amount.
    stale = db.scalars(select(PaymentIntent).where(
        PaymentIntent.status == "pending",
        PaymentIntent.expires_at <= now,
    )).all()
    for old_intent in stale:
        old_intent.status = "expired"
    db.flush()

    existing = db.scalar(select(PaymentIntent).where(
        PaymentIntent.user_id == user.id,
        PaymentIntent.plan_code == payload.plan_code,
        PaymentIntent.payer_address == payer_address,
        PaymentIntent.status == "pending",
        PaymentIntent.expires_at > now,
    ).order_by(PaymentIntent.created_at.desc()))
    receive_address = os.getenv("FIELD_LAB_TRON_USDT_RECEIVE_ADDRESS", "").strip()
    if existing:
        return payment_intent_output(existing, receive_address)

    base_amount = int(PLANS[payload.plan_code]["price_usd"]) * 1_000_000
    open_amounts = set(db.scalars(select(PaymentIntent.amount_base_units).where(
        PaymentIntent.status == "pending",
        PaymentIntent.expires_at > now,
    )).all())
    # Add a unique micro-USDT suffix (max +0.009999 USDT) to disambiguate concurrent
    # invoices going to the same receiver. A partial unique index guards concurrent requests.
    amount = next((base_amount + suffix for suffix in range(10_000)
                   if base_amount + suffix not in open_amounts), None)
    if amount is None:
        raise HTTPException(status_code=503, detail="اكتملت خانات مبالغ الدفع النشطة لهذه الباقة؛ حاول مجددًا لاحقًا.")
    intent = PaymentIntent(
        id=str(uuid.uuid4()), user_id=user.id, plan_code=payload.plan_code,
        payer_address=payer_address,
        amount_base_units=amount,
        created_at=now, expires_at=now + timedelta(minutes=60), status="pending",
    )
    db.add(intent)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="أنشأ عميل آخر طلب دفع متزامنًا؛ أعد إنشاء الطلب قبل التحويل.") from exc
    db.refresh(intent)
    return payment_intent_output(intent, receive_address)


@app.post("/payments/verify")
def verify_payment(payload: VerifyPaymentInput, user: User = Depends(current_user),
                   db: Session = Depends(get_db)) -> dict:
    if not payments_enabled():
        raise HTTPException(status_code=503, detail="التحقق من الدفع غير متاح الآن.")
    intent = db.scalar(select(PaymentIntent).where(PaymentIntent.id == payload.intent_id).with_for_update())
    if not intent or intent.user_id != user.id:
        raise HTTPException(status_code=404, detail="طلب الدفع غير موجود لهذا الحساب.")
    user = db.scalar(select(User).where(User.id == user.id).with_for_update().execution_options(populate_existing=True))
    txid = payload.txid.lower()
    if intent.status == "paid":
        if intent.txid == txid:
            return {"status": "confirmed", "already_processed": True, "plan": intent.plan_code,
                    "expires_at": user.plan_expires_at}
        raise HTTPException(status_code=409, detail="تم تأكيد طلب الدفع بمعاملة أخرى.")
    if intent.status != "pending":
        raise HTTPException(status_code=409, detail="طلب الدفع لم يعد نشطًا.")
    now = datetime.now(timezone.utc)
    if utc_aware(intent.expires_at) <= now:
        intent.status = "expired"
        db.commit()
        raise HTTPException(status_code=410, detail="انتهت صلاحية طلب الدفع؛ أنشئ طلبًا جديدًا.")
    if db.scalar(select(PaymentIntent.id).where(PaymentIntent.txid == txid)) is not None:
        raise HTTPException(status_code=409, detail="هذه المعاملة استُخدمت سابقًا ولا يمكن اعتمادها مجددًا.")
    current_plan = active_plan(user)
    if current_plan != "free" and current_plan != intent.plan_code:
        raise HTTPException(status_code=409, detail="الباقة النشطة تغيرت منذ إنشاء طلب الدفع.")
    created_ms = int(utc_aware(intent.created_at).timestamp() * 1000)
    expires_ms = int(utc_aware(intent.expires_at).timestamp() * 1000)
    try:
        transfer = verify_usdt_transfer(
            txid, receiving_address=os.getenv("FIELD_LAB_TRON_USDT_RECEIVE_ADDRESS", "").strip(),
            payer_address=intent.payer_address,
            expected_amount_base_units=intent.amount_base_units,
            api_key=os.getenv("TRONGRID_API_KEY", "").strip(),
            min_confirmations=max(20, int(os.getenv("FIELD_LAB_TRON_MIN_CONFIRMATIONS", "20"))),
            earliest_timestamp_ms=created_ms, latest_timestamp_ms=expires_ms,
        )
    except PaymentVerificationError as exc:
        raise HTTPException(status_code=422, detail="لم يتم اعتماد الدفع: " + str(exc)) from exc
    if current_plan == intent.plan_code and user.plan_expires_at:
        start_at = max(now, utc_aware(user.plan_expires_at))
    else:
        start_at = now
    user.plan = intent.plan_code
    user.plan_expires_at = start_at + timedelta(days=int(PLANS[intent.plan_code]["duration_days"]))
    user.sites_used = 0
    user.questions_used = 0
    user.usage_window_started_at = now
    intent.status = "paid"
    intent.txid = txid
    intent.tx_block_number = transfer.block_number
    intent.confirmed_at = now
    try:
        db.add(user)
        db.add(intent)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="تعذر اعتماد المعاملة لأنها سُجلت بالفعل؛ تحقق من الاشتراك قبل إعادة المحاولة.") from exc
    db.refresh(user)
    db.refresh(intent)
    return {"status": "confirmed", "already_processed": False, "txid": txid, "plan": user.plan,
            "plan_label": PLANS[user.plan]["label"], "expires_at": user.plan_expires_at,
            "confirmations": transfer.confirmations, "message": "تم التحقق من التحويل على شبكة TRON وتفعيل الاشتراك."}


@app.get("/payments/history")
def payment_history(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    intents = db.scalars(select(PaymentIntent).where(PaymentIntent.user_id == user.id)
                         .order_by(PaymentIntent.created_at.desc()).limit(50)).all()
    return {"transactions": [
        {"intent_id": p.id, "plan_code": p.plan_code, "plan_label": PLANS[p.plan_code]["label"],
         "payer_address": p.payer_address, "amount_usdt": format_usdt(p.amount_base_units), "status": p.status, "txid": p.txid,
         "created_at": p.created_at, "confirmed_at": p.confirmed_at, "expires_at": p.expires_at}
        for p in intents
    ]}



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
    if payload.request_id:
        previous = db.scalar(select(UsageReceipt).where(
            UsageReceipt.user_id == user.id,
            UsageReceipt.action == payload.action,
            UsageReceipt.request_id == payload.request_id,
        ))
        if previous:
            db.add(user)
            db.commit()
            db.refresh(user)
            return usage_for(user)
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
    if payload.request_id:
        db.add(UsageReceipt(user_id=user.id, action=payload.action, request_id=payload.request_id))
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        previous = db.scalar(select(UsageReceipt.id).where(
            UsageReceipt.user_id == user.id,
            UsageReceipt.action == payload.action,
            UsageReceipt.request_id == payload.request_id,
        )) if payload.request_id else None
        if previous:
            refreshed = db.get(User, user.id)
            return usage_for(refreshed)
        raise HTTPException(status_code=409, detail="تعذّر تثبيت عملية الحصة؛ أعد المحاولة بنفس معرّف الطلب.") from exc
    db.refresh(user)
    return usage_for(user)


@app.get("/records")
def list_field_records(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    rows = db.scalars(
        select(FieldRecord).where(FieldRecord.user_id == user.id).order_by(FieldRecord.updated_at.desc())
    ).all()
    records = []
    for row in rows:
        try:
            records.append(json.loads(row.payload_json))
        except (TypeError, json.JSONDecodeError):
            # A corrupt record is skipped rather than breaking access to every other record.
            continue
    return {"records": records, "count": len(records), "storage": "cloud"}


@app.put("/records/{record_id}")
def upsert_field_record(record_id: str, payload: FieldRecordInput,
                        user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    record = payload.record
    if not record_id or len(record_id) > 100 or not all(ch.isalnum() or ch in "-_" for ch in record_id):
        raise HTTPException(status_code=422, detail="معرّف السجل غير صالح.")
    if str(record.get("id", "")) != record_id:
        raise HTTPException(status_code=422, detail="معرّف السجل لا يطابق البيانات المرسلة.")
    if not isinstance(record.get("siteName"), str) or not record["siteName"].strip() or len(record["siteName"]) > 100:
        raise HTTPException(status_code=422, detail="اسم الموقع مطلوب وبحد أقصى 100 حرف.")
    photos = record.get("photos", [])
    if not isinstance(photos, list) or len(photos) > 6:
        raise HTTPException(status_code=422, detail="يسمح بست صور كحد أقصى لكل سجل.")
    try:
        encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="محتوى السجل غير صالح.") from exc
    if len(encoded.encode("utf-8")) > 32 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="حجم السجل يتجاوز 32 ميغابايت؛ قلّل حجم الصور ثم أعد المحاولة.")
    now = datetime.now(timezone.utc)
    row = db.scalar(select(FieldRecord).where(
        FieldRecord.user_id == user.id, FieldRecord.record_id == record_id
    ))
    record["storage"] = "cloud"
    encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    if row:
        row.payload_json = encoded
        row.updated_at = now
    else:
        row = FieldRecord(user_id=user.id, record_id=record_id, payload_json=encoded,
                          created_at=now, updated_at=now)
        db.add(row)
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="تعذر حفظ السجل في قاعدة البيانات الدائمة.") from exc
    return {"status": "saved", "id": record_id, "storage": "cloud", "updated_at": now}


@app.delete("/records/{record_id}")
def delete_field_record(record_id: str, user: User = Depends(current_user),
                        db: Session = Depends(get_db)) -> dict:
    row = db.scalar(select(FieldRecord).where(
        FieldRecord.user_id == user.id, FieldRecord.record_id == record_id
    ))
    if not row:
        raise HTTPException(status_code=404, detail="السجل غير موجود في التخزين السحابي.")
    db.delete(row)
    db.commit()
    return {"status": "deleted", "id": record_id}


@app.get("/me")
def get_me(user: User = Depends(current_user)) -> dict:
    return {"id": user.id, "email": user.email, "plan": active_plan(user), "created_at": user.created_at}

# Serve the web app and API from the same origin in the production container.
# In API-only unit tests the frontend directory is absent, so this mount is skipped.
STATIC_SITE_DIR = Path(os.getenv("FIELD_LAB_STATIC_DIR", str(Path(__file__).resolve().parent / "static" / "field-lab")))
if STATIC_SITE_DIR.is_dir():
    app.mount("/field-lab", StaticFiles(directory=str(STATIC_SITE_DIR), html=True), name="field-lab")

    @app.get("/", include_in_schema=False)
    def field_lab_home() -> RedirectResponse:
        return RedirectResponse(url="/field-lab/", status_code=307)
