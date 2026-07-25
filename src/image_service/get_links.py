import requests
from config import *
import json
import time
import hashlib
from progress.bar import IncrementalBar


id = 7000000
posts = {}
posts["nsfw"] = {}
posts["sfw"] = {}

count = requests.get("https://danbooru.donmai.us/counts/posts.json?tags=fox_ears+~1girl+~2girls+-furry+-comic+status%3Aactive+filetype%3Apng%2Cwebp%2Cjpg+-status%3Abanned").json()
count = count["counts"]["posts"]

bar = IncrementalBar('Parsing links', max = count)

while True:
    resp = requests.get(f"https://danbooru.donmai.us/posts.json?tags=fox_ears+~1girl+~2girls+-furry+-comic+status%3Aactive+filetype%3Apng%2Cwebp%2Cjpg+-status%3Abanned+id%3A<{id}&limit=200&only=id,file_url,tag_string,rating", auth=(USERNAME,TOKEN)).json()
    if resp == []:  break
    for post in resp:
        item = {}
        item["link"] = post["file_url"]
        item["id"] = post["id"]
        item["is_loli"] = True if "loli" in post["tag_string"].split() else False
        id = post["id"]
        byte_id = id.to_bytes((id.bit_length() + 7) // 8, 'little')
        if post["rating"] == "e" or post["rating"] == "q":
            posts["nsfw"][hashlib.sha256(byte_id).hexdigest()] = item
        else:
            posts["sfw"][hashlib.sha256(byte_id).hexdigest()] = item
        bar.next()
    time.sleep(0.5)
    # break

bar.finish()
with open("db.json", "w") as outfile:
    outfile.write(json.dumps(posts))