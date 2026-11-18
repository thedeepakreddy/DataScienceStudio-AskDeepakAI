FROM python:3.13-slim

# libgomp1: OpenMP runtime that LightGBM, XGBoost and scikit-learn use for threads.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MPLCONFIGDIR=/tmp/matplotlib \
    NUMBA_CACHE_DIR=/tmp/numba

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY main.py stats_engine.py model_extras.py forecasting.py monitoring.py ./
COPY engine ./engine

# Run as an unprivileged user; it can only write to /tmp (where local engine storage lives
# unless ENGINE_STORAGE points at a gs:// bucket).
RUN useradd --create-home --uid 10001 engine
USER engine

EXPOSE 8000

# Shell form so $PORT expands: Cloud Run and Render assign the port through it; 8000 for
# Docker Compose. One worker on purpose: running jobs and their cancel switches live in
# this process (records and results are in storage).
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --timeout-keep-alive 75
