FROM python:3.12.7-alpine
LABEL authors="ItsOlegDm"

WORKDIR /usr/local/app

RUN python -m venv /opt/venv
RUN apk update -U && rm -rf /var/cache/
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

STOPSIGNAL SIGINT
ENTRYPOINT ["python", "app.py"]
