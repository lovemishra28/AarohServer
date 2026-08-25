# Aaroh AI service (Python/FastAPI) — pilot image.
# Python version is pinned here (independent of your system Python) so the
# service is reproducible for everyone and future ML libraries stay compatible.
FROM python:3.12-slim

WORKDIR /app

COPY pyproject.toml ./
COPY src ./src

RUN pip install --no-cache-dir .

EXPOSE 8000

CMD ["uvicorn", "aaroh_ai.inference.app:app", "--host", "0.0.0.0", "--port", "8000"]
