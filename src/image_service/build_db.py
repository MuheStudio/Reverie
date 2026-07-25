"""
foxgirls.club db.json 构建工具。

从 Gelbooru API 抓取狐娘图片元数据，构建本地 db.json 数据库。
原始项目: foxgirls.club (MIT) by foxgirls.org
集成修改: Muhe Studio 2026

用法：
    python -m src.image_service.build_db
    python -m src.image_service.build_db --source gelbooru --limit 500
    python -m src.image_service.build_db --source danbooru --config config.py
"""
import argparse
import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Optional

logger = logging.getLogger("reverie.image_service.build_db")

# ── Gelbooru 抓取 ─────────────────────────────────────

GELBOORU_API = "https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1"
DEFAULT_TAGS = "fox_girl"  # 可根据需要修改为 cat_girl, fox_girl 等
DEFAULT_LIMIT = 100
DEFAULT_PER_PAGE = 100


async def fetch_gelbooru_page(
    session, tags: str, pid: int, limit: int = DEFAULT_PER_PAGE, api_key: str = "", user_id: str = ""
) -> list[dict]:
    """抓取 Gelbooru 一页数据。"""
    import aiohttp

    params = {
        "tags": tags,
        "pid": pid,
        "limit": min(limit, 100),
        "json": 1,
    }
    if api_key and user_id:
        params["api_key"] = api_key
        params["user_id"] = user_id

    url = GELBOORU_API
    async with session.get(url, params=params) as resp:
        if resp.status != 200:
            logger.warning("Gelbooru API 返回 %d (pid=%d)", resp.status, pid)
            return []
        try:
            data = await resp.json()
            if isinstance(data, dict) and "post" in data:
                return data["post"] if isinstance(data["post"], list) else []
            return []
        except Exception:
            return []


def classify_post(post: dict) -> Optional[str]:
    """根据 rating 和 tags 分类为 sfw / nsfw。"""
    rating = post.get("rating", "").lower()
    tags = post.get("tags", "").lower()

    if rating == "explicit":
        return "nsfw"
    elif rating == "questionable":
        return "nsfw"
    elif "explicit" in tags or "nsfw" in tags:
        return "nsfw"
    else:
        return "sfw"


async def scrape_gelbooru(
    tags: str = DEFAULT_TAGS,
    total_limit: int = DEFAULT_LIMIT,
    api_key: str = "",
    user_id: str = "",
) -> dict:
    """从 Gelbooru 抓取图片元数据，返回 db.json 格式。"""
    import aiohttp

    db = {"sfw": [], "nsfw": []}
    collected = 0
    pid = 0

    async with aiohttp.ClientSession() as session:
        while collected < total_limit:
            posts = await fetch_gelbooru_page(session, tags, pid, DEFAULT_PER_PAGE, api_key, user_id)
            if not posts:
                break

            for post in posts:
                file_url = post.get("file_url", "")
                if not file_url:
                    continue

                category = classify_post(post)
                entry = {
                    "id": post.get("id", ""),
                    "url": file_url,
                    "hash": post.get("md5", ""),
                    "tags": post.get("tags", ""),
                    "rating": post.get("rating", "s"),
                    "width": int(post.get("width", 0)),
                    "height": int(post.get("height", 0)),
                    "source": post.get("source", ""),
                    "score": int(post.get("score", 0)),
                    "has_loli": "loli" in post.get("tags", "").lower(),
                }
                db[category].append(entry)
                collected += 1
                if collected >= total_limit:
                    break

            pid += 1
            logger.info("Gelbooru: 已抓取 %d/%d (pid=%d)", collected, total_limit, pid)

    logger.info("Gelbooru 抓取完成: sfw=%d, nsfw=%d", len(db["sfw"]), len(db["nsfw"]))
    return db


# ── Danbooru 抓取 ─────────────────────────────────────

async def scrape_danbooru(
    username: str,
    api_key: str,
    tags: str = "fox_girl",
    total_limit: int = DEFAULT_LIMIT,
) -> dict:
    """从 Danbooru 抓取（需要 API key）。"""
    import aiohttp

    db = {"sfw": [], "nsfw": []}
    collected = 0
    page = 1

    auth = aiohttp.BasicAuth(username, api_key)

    async with aiohttp.ClientSession(auth=auth) as session:
        while collected < total_limit:
            url = "https://danbooru.donmai.us/posts.json"
            params = {
                "tags": tags,
                "limit": min(200, total_limit - collected),
                "page": page,
            }
            async with session.get(url, params=params) as resp:
                if resp.status != 200:
                    logger.warning("Danbooru API 返回 %d", resp.status)
                    break
                posts = await resp.json()
                if not posts:
                    break

                for post in posts:
                    file_url = post.get("file_url") or post.get("large_file_url", "")
                    if not file_url:
                        continue

                    rating = post.get("rating", "s")
                    category = "nsfw" if rating in ("q", "e") else "sfw"

                    entry = {
                        "id": post.get("id", ""),
                        "url": file_url,
                        "hash": post.get("md5", ""),
                        "tags": post.get("tag_string", ""),
                        "rating": rating,
                        "width": int(post.get("image_width", 0)),
                        "height": int(post.get("image_height", 0)),
                        "source": post.get("source", ""),
                        "score": int(post.get("score", 0)),
                        "has_loli": "loli" in post.get("tag_string", "").lower(),
                    }
                    db[category].append(entry)
                    collected += 1

            page += 1
            logger.info("Danbooru: 已抓取 %d/%d (page=%d)", collected, total_limit, page)

    return db


# ── 预设小型数据库 ────────────────────────────────────

def create_minimal_db() -> dict:
    """创建最小预设数据库（无需联网）。"""
    return {
        "sfw": [
            {
                "id": "preset_001",
                "url": "https://foxgirls.club/images/placeholder_sfw_01",
                "hash": "preset_sfw_01",
                "tags": "fox_girl cute tail",
                "rating": "s",
                "width": 1200,
                "height": 1600,
                "source": "",
                "score": 10,
                "has_loli": False,
            }
        ],
        "nsfw": [],
    }


# ── CLI ───────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="构建 foxgirls.club db.json")
    parser.add_argument("--source", choices=["gelbooru", "danbooru", "preset"], default="preset")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--tags", default=DEFAULT_TAGS)
    parser.add_argument("--output", default=None)
    parser.add_argument("--api-key", default="")
    parser.add_argument("--user-id", default="")
    parser.add_argument("--username", default="")
    parser.add_argument("--config", default=None)

    args = parser.parse_args()

    output_path = Path(args.output or Path(__file__).parent / "db.json")

    async def run():
        if args.source == "preset":
            db = create_minimal_db()
        elif args.source == "gelbooru":
            db = await scrape_gelbooru(
                tags=args.tags,
                total_limit=args.limit,
                api_key=args.api_key,
                user_id=args.user_id,
            )
        elif args.source == "danbooru":
            # 尝试从 config.py 加载凭据
            username = args.username
            api_key = args.api_key
            if args.config:
                import importlib.util
                spec = importlib.util.spec_from_file_location("config", args.config)
                cfg = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(cfg)
                username = getattr(cfg, "USERNAME", username)
                api_key = getattr(cfg, "TOKEN", api_key)

            if not username or not api_key:
                logger.error("Danbooru 需要 --username 和 --api-key")
                sys.exit(1)

            db = await scrape_danbooru(
                username=username,
                api_key=api_key,
                tags=args.tags,
                total_limit=args.limit,
            )
        else:
            db = create_minimal_db()

        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(db, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info(
            "db.json 已生成: %s (sfw=%d, nsfw=%d, 总计=%d)",
            output_path,
            len(db["sfw"]),
            len(db["nsfw"]),
            len(db["sfw"]) + len(db["nsfw"]),
        )

    asyncio.run(run())


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")
    main()
