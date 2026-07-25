from aiohttp import web, RequestInfo
import aiohttp
import json
import random
import re
import aiohttp_jinja2
import jinja2
from pathlib import Path

ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

here = Path(__file__).resolve().parent
db = []
with open('db.json', 'r') as file:
    db = json.load(file)

async def get_image(type, hide_loli, only_loli):
    if type == "nsfw":
        choice = random.choice(list(db["nsfw"].items()))
    elif type == "sfw":
        choice = random.choice(list(db["sfw"].items()))
    else:
        selected_sub_dict_key = random.choice(list(db.keys()))
        selected_sub_dict = db[selected_sub_dict_key]
        choice = random.choice(list(selected_sub_dict.items()))
    if hide_loli and choice[1]["is_loli"]:
        return await get_image(type, hide_loli, only_loli)
    elif only_loli and not choice[1]["is_loli"]:
        return await get_image(type, hide_loli, only_loli)
    else:
        return choice


def get_request_domain(request: RequestInfo):
    forwarded_proto = request.headers.get("X-Forwarded-Proto")
    scheme = forwarded_proto.split(",")[0].strip() if forwarded_proto else request.scheme
    return f"{scheme}://{request.host}/"


async def handle_image(request):
    hash_match = re.match(r'^/images/(.*)$', request.path)
    if not hash_match:
        return web.Response(
            text="Invalid request",
            status=400,
            headers={'Access-Control-Allow-Origin': '*'}
        )

    image_hash = hash_match.group(1)
    if image_hash in db['nsfw']:
        image_url = db['nsfw'][image_hash]["link"]
    elif image_hash in db['sfw']:
        image_url = db['sfw'][image_hash]["link"]
    else:
        return web.Response(
            text="Invalid request",
            status=400,
            headers={'Access-Control-Allow-Origin': '*'}
        )

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(image_url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': 'https://gelbooru.com/',
            }) as resp:
                if resp.status != 200:
                    return web.Response(
                        text=f"Failed to fetch image (status {resp.status})",
                        status=resp.status,
                        headers={'Access-Control-Allow-Origin': '*'}
                    )

                content_type = resp.headers.get('Content-Type', '')
                content_type = content_type.split(';')[0].strip()

                if content_type not in ALLOWED_CONTENT_TYPES:
                    return web.Response(
                        text="Invalid content type",
                        status=502,
                        headers={'Access-Control-Allow-Origin': '*'}
                    )

                body = await resp.read()
                return web.Response(
                    body=body,
                    status=200,
                    content_type=content_type,
                    headers={'Access-Control-Allow-Origin': '*'}
                )

    except aiohttp.ClientError as e:
        return web.json_response({'error': f"Error {e}"}, status=500)


async def handle_api_get(request: RequestInfo):
    def parse_bool_query(name, default=False):
        value = request.url.query.get(name)
        if value is None:
            return default
        return value.lower() in {"1", "true"}

    hide_loli = parse_bool_query("hide_loli", default=True)
    only_loli = parse_bool_query("only_loli", default=False)
    danb = request.url.query.get("original_booru_data")
    domain = get_request_domain(request)
    type = re.match(r'^/api/(.*)$', request.path)
    type = type.group(1)
    if type == "endpoints":
        resp = {}
        resp['endpoints'] = {
            'sfw images': domain + "api/sfw",
            'nsfw images': domain + "api/nsfw",
            "sfw+nsfw images": domain + "api/"
        }
        resp["query parameters"] = {
            'Do not include loli images': "hide_loli=true"
        }
        return web.json_response(resp, status=200, headers={'Access-Control-Allow-Origin': '*'})
    img = await get_image(type, hide_loli, only_loli)
    if danb:
        return web.json_response(img[1], status=200, headers={'Access-Control-Allow-Origin': '*'})
    else:
        return web.json_response({'url': "/images/" + img[0]}, status=200, headers={'Access-Control-Allow-Origin': '*'})


@aiohttp_jinja2.template('/templates/index.html')
async def handle_index(request: RequestInfo):
    type = re.match(r'^/(.*)$', request.path)
    type = type.group(1)
    hide_loli = True if type == "nsfw" else False
    if type != "nsfw":
        type = "sfw"
    img = await get_image(type, hide_loli, False)
    domain = get_request_domain(request)
    vars = {
        'img_url': "/images/" + img[0],
        'rating': "NSFW" if type == "sfw" else "SFW",
        'r_link': "nsfw" if type == "sfw" else "sfw",
        'domain': domain
    }
    return vars


app = web.Application()
app.add_routes([web.get("/images/{tail:.*}", handle_image)])
app.add_routes([web.get("/api/{tail:.*}", handle_api_get)])
aiohttp_jinja2.setup(app, loader=jinja2.FileSystemLoader(str(here)))
app.add_routes([web.get("/{tail:(sfw|nsfw)?(?:/.*)?}", handle_index)])
app.router.add_static('/static/', path='static', name='static')
favicon_path = Path('static/images/favicon.ico')
app.router.add_get('/favicon.ico', lambda _: web.FileResponse(favicon_path))

if __name__ == "__main__":
    web.run_app(app, port=3010)