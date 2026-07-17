FROM python:3.12-slim

WORKDIR /app
RUN pip install --no-cache-dir uv
COPY pyproject.toml ./
RUN uv pip install --system .
COPY . .

CMD ["python", "train.py", "--num-envs", "2"]
