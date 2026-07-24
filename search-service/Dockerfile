FROM vllm/vllm-openai:v0.15.1

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models \
    SENTENCE_TRANSFORMERS_HOME=/models \
    HF_HUB_DISABLE_XET=1

RUN /usr/bin/python3 -m pip install --no-cache-dir \
    sentence-transformers==5.5.0 \
    "fastapi>=0.116,<1" \
    "uvicorn[standard]>=0.35,<1"

WORKDIR /app
COPY app.py /app/app.py

EXPOSE 8000
ENTRYPOINT []
CMD ["/usr/bin/python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
