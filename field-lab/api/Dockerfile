FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000 FIELD_LAB_ENV=production FIELD_LAB_STATIC_DIR=/app/static/field-lab
WORKDIR /app
COPY field-lab/api/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY field-lab/api/main.py field-lab/api/payments_testnet.py field-lab/api/payments_live.py ./
RUN mkdir -p /app/static/field-lab
COPY field-lab/*.html field-lab/*.css field-lab/*.js ./static/field-lab/
EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
