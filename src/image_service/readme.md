# <img src="https://raw.githubusercontent.com/foxgirlsorg/foxgirls.club/refs/heads/main/static/images/favicon.ico" width="30"> foxgirls.club 

A simple API and web viewer that serves random foxgirl images sourced from Danbooru or Gelbooru.

## Features

- Random foxgirl image API with SFW/NSFW filtering
- Optional loli tag filtering
- Proxies images through the server — no direct booru URLs exposed to clients
- Minimal web frontend to browse images
- Docker support for easy self-hosting

## API

Base URL: `https://foxgirls.club/`

### Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/sfw` | Random SFW image |
| `GET /api/nsfw` | Random NSFW image |
| `GET /api/` | Random image (SFW or NSFW) |
| `GET /api/endpoints` | List all available endpoints |
| `GET /images/{hash}` | Proxy-fetch an image by its hash |

### Query Parameters

| Parameter | Value | Description |
|---|---|---|
| `hide_loli` | `true/false` | Include images tagged as loli |

`hide_loli` is enabled by default.

### Response

```json
{
  "url": "https://foxgirls.club/images/<hash>"
}
```

## Setup

### Prerequisites

- Python 3.12+

### Installation

```bash
git clone https://github.com/foxgirlsorg/foxgirls_club
cd foxgirls_club
pip install -r requirements.txt
```

### Building the database

The app requires a `db.json` file containing image metadata. Choose **one** of the following scrapers.

**Gelbooru** (no auth required):

```bash
python get_files_gelbooru.py
```

If you have a Gelbooru account, you can append your API key and user ID to the base URL in `get_files_gelbooru.py` for higher rate limits:

```
https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1&api_key=YOUR_KEY&user_id=YOUR_ID
```

**Danbooru:**

Create a `config.py` file:

```python
USERNAME = "<danbooru username>"
TOKEN = "<danbooru api token>"
```

Then run:

```bash
python get_links.py
```

Both scripts produce a `db.json` with `sfw` and `nsfw` buckets.

### Running

```bash
python app.py
```

The server starts on port `3010` by default.

### Docker

```bash
docker compose up -d
```

The `db.json` is mounted as a volume so you can update the database without rebuilding the image.

## Project Structure

```
foxgirls_club/
├── app.py                  # Main aiohttp application
├── get_files_gelbooru.py   # Gelbooru scraper
├── get_links.py            # Danbooru scraper
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
├── static/
│   ├── css/
│   │   ├── index.css
│   │   └── menu.css
│   └── images/
│       ├── baner.jpg
│       └── favicon.ico
└── templates/
    └── index.html
```

## License

MIT License — see [LICENSE](LICENSE) for details.
