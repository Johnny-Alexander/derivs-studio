# vegalab backend for Fly.io.
#
# Build context is vegalab/ (pyproject.toml lives here; the package and
# alembic live under backend/). WORKDIR ends at /app/backend so both the
# release_command ("alembic upgrade head") and uvicorn find alembic.ini
# and the vegalab package without PYTHONPATH games.

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY pyproject.toml ./
COPY backend/ backend/
RUN pip install .

WORKDIR /app/backend
EXPOSE 8080
CMD ["uvicorn", "vegalab.api.app:app", "--host", "0.0.0.0", "--port", "8080"]
