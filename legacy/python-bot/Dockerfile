FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 DB_PATH=/app/data/santa.db
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY santa ./santa
VOLUME /app/data
CMD ["python", "-m", "santa"]
