import requests
import json
import time
import hashlib
from tqdm import tqdm

posts = {}
posts["nsfw"] = {}
posts["sfw"] = {}

BASE = "https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1"
TAGS = "{fox_girl ~ *girl* fox_ears} -furry -comic"
TAGS = "{fox_girl ~ *girl* fox_ears} -furry -comic -amputee -trap -gaping"
LIMIT = 100


def fetch(url, retries=5, wait=5):
    for attempt in range(retries):
        try:
            resp = requests.get(url, timeout=30)
            return resp.json()
        except Exception as e:
            print(f"\nRequest failed (attempt {attempt + 1}/{retries}): {e}")
            if attempt < retries - 1:
                time.sleep(wait)
    return None


count_resp = fetch(f"{BASE}&tags={TAGS}&limit=1")
count = count_resp["@attributes"]["count"]

last_id = None
with tqdm(total=count, desc="Parsing links") as bar:
    while True:
        if last_id is None:
            tags = TAGS
        else:
            tags = f"{TAGS} id:<{last_id}"

        resp = fetch(f"{BASE}&tags={tags}&limit={LIMIT}")

        if resp is None:
            time.sleep(5)
            continue

        posts_on_page = resp.get("post", [])
        if not posts_on_page:
            break

        for post in posts_on_page:
            bar.update(1)

            file_url = post.get("file_url", "")
            if not file_url:
                continue

            if not file_url.endswith((".jpg", ".jpeg", ".png", ".webp")):
                continue

            item = {}
            item["link"] = file_url
            item["id"] = post["id"]
            item["is_loli"] = "loli" in post.get("tags", "").split()

            post_id = post["id"]
            byte_id = post_id.to_bytes((post_id.bit_length() + 7) // 8, 'little')
            hash_key = hashlib.sha256(byte_id).hexdigest()

            rating = post.get("rating", "general")
            if rating in ("e", "q", "s", "sensitive", "explicit", "questionable"):
                posts["nsfw"][hash_key] = item
            else:
                posts["sfw"][hash_key] = item

        last_id = min(post["id"] for post in posts_on_page)
        time.sleep(0.5)

with open("db.json", "w") as outfile:
    outfile.write(json.dumps(posts))

print(f"Done! {len(posts['sfw'])} sfw, {len(posts['nsfw'])} nsfw")