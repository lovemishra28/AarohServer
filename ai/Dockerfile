# Aaroh AI service (Python/FastAPI) — pilot image.
# Python version is pinned here (independent of your system Python) so the
# service is reproducible for everyone and future ML libraries stay compatible.
FROM python:3.12-slim

WORKDIR /app
ENV AAROH_MODEL_REGISTRY=/app/models/registry/registry.json
ENV AAROH_REGION_CONFIG_DIR=/app/src/aaroh_ai/services/agronomy/regions

COPY pyproject.toml ./
COPY src ./src
COPY models ./models

RUN pip install --no-cache-dir .

EXPOSE 8000

CMD ["uvicorn", "aaroh_ai.inference.app:app", "--host", "0.0.0.0", "--port", "8000"]
