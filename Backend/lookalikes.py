"""Click a piece of a runway look to find it, with Google Gemini (GEMINI_API_KEY in Backend/.env).

  pieces(image)          Gemini marks each piece in the picture (coat, boots, bag...)
                         with a box and words to shop for it. Works on the free plan.
  shop(image, n)         products for piece n, in two lists: the original (the
                         designer's own piece, new or resale; Gemini with Google
                         Search) and lookalikes from other brands (Google Shopping
                         through SerpApi when SERPAPI_KEY is set, with a photo and
                         price each; otherwise Gemini).
  details(image, n)      Gemini reads those products' pages (through Google, which
                         shops let in) for each one's photo and current price.
  crop(image, box)       just that piece, as a JPEG (shown in the panel, and handed
                         to Google Lens for a visual search of the piece alone).

Speed: the free plan's models are often "busy" (an error within a second or two),
so several fast models are asked at once and the first answer wins. Answers are
kept in Backend/cache/lookalikes.json, so each look is only asked about once.
"""
import base64
import io
import json
import os
import re
import threading
import time
from difflib import SequenceMatcher
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
from urllib.parse import quote, urljoin, urlparse

import requests
from PIL import Image

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache" / "lookalikes.json"
API = "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent"
# Asked at the same time; the lite models with minimal thinking answer in seconds.
FAST = [
    ("gemini-flash-lite-latest", "minimal"),
    ("gemini-3.5-flash-lite", "minimal"),
    ("gemini-3.1-flash-lite", "minimal"),
    ("gemini-3.8-flash", "low"),
]
# Searching the web: one model at a time is enough (its answer takes longer anyway).
SEARCHERS = [("gemini-3.8-flash", "low")]  # one at a time: each search is billed
PATIENCE = 40  # seconds to keep retrying busy models
SEARCH_RETRY = 3600  # after "no quota for search", wait this long before trying search again

_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=12)
_photos = ThreadPoolExecutor(max_workers=4)  # small shops share hosts that refuse bursts
_search_off_until = 0.0
_pictures = {}  # image address -> bytes, for the few looks being worked on
try:
    _saved = json.loads(CACHE.read_text(encoding="utf-8"))
except (OSError, ValueError):
    _saved = {}

PIECES_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Short name, e.g. 'Leather boots'."},
                    "description": {"type": "string", "description": "Colour, material, cut, details."},
                    "search": {"type": "string", "description": "Shopping search words for similar products."},
                    "box_2d": {"type": "array", "items": {"type": "integer"}, "description": "[ymin, xmin, ymax, xmax], 0-1000."},
                },
                "required": ["name", "description", "search", "box_2d"],
            },
        }
    },
    "required": ["items"],
}


class GeminiError(Exception):
    pass


class Busy(GeminiError):
    pass


def available():
    return bool(os.environ.get("GEMINI_API_KEY"))


def _once(model, thinking, body):
    """(text, None) on success, or (None, (status, message))."""
    config = dict(body.get("generationConfig", {}))
    if thinking:
        config["thinkingConfig"] = {"thinkingLevel": thinking}
    payload = {**body, "generationConfig": config} if config else body
    try:
        response = requests.post(
            API.format(model), headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]}, json=payload, timeout=30
        )
    except requests.RequestException as error:
        return None, (504, f"{model}: {error.__class__.__name__}")
    if response.status_code == 200:
        candidate = (response.json().get("candidates") or [{}])[0]
        text = "".join(part.get("text", "") for part in candidate.get("content", {}).get("parts", []))
        # The pages Google Search returned for the answer, when search was used.
        sources = [chunk.get("web", {}) for chunk in candidate.get("groundingMetadata", {}).get("groundingChunks", [])]
        return (text, sources), None
    try:
        message = response.json().get("error", {}).get("message", "")
    except ValueError:
        message = response.text[:200]
    return None, (response.status_code, message)


def _ask(body, models, sources=False):
    """Asks all `models` at once and returns the first answer; retries busy ones.
    With sources=True, returns (text, the web pages Google Search used)."""
    deadline = time.time() + PATIENCE
    last = (503, "no answer")
    while time.time() < deadline:
        running = {_pool.submit(_once, model, thinking, body) for model, thinking in models}
        while running:
            done, running = wait(running, timeout=max(1, deadline - time.time()), return_when=FIRST_COMPLETED)
            if not done:
                break
            for future in done:
                answer, error = future.result()
                if answer is not None:
                    return answer if sources else answer[0]
                last = error
        if last[0] in (400, 401, 403, 429):  # not "busy": retrying will not help
            raise GeminiError(f"{last[0]}: {last[1]}")
        time.sleep(1)  # everyone was busy: try again shortly
    raise Busy(f"{last[0]}: {last[1]}")


def _json_in(text):
    match = re.search(r"\{.*\}", text or "", re.S)
    if not match:
        return {}
    try:
        return json.loads(match.group())
    except ValueError:
        return {}


def _save(key, value):
    with _lock:
        _saved[key] = value
        try:
            CACHE.parent.mkdir(exist_ok=True)
            temporary = CACHE.with_suffix(".tmp")
            temporary.write_text(json.dumps(_saved), encoding="utf-8")
            temporary.replace(CACHE)
        except OSError as error:
            print(f"Lookalikes not saved: {error}")


def _picture(image_url):
    if urlparse(image_url).hostname != "assets.vogue.com":
        raise ValueError("Only Vogue Runway pictures can be looked up.")
    with _lock:
        if image_url in _pictures:
            return _pictures[image_url]
    response = requests.get(image_url, timeout=20)
    response.raise_for_status()
    with _lock:
        if len(_pictures) > 40:
            _pictures.clear()
        _pictures[image_url] = response.content
    return response.content


def pieces(image_url, designer="", show="", cached_only=False):
    """The pieces in a look, each with a box (0-1000, [top, left, bottom, right]).
    With cached_only, only pieces already found ([] otherwise; Gemini is not asked)."""
    key = f"pieces\n{image_url}"
    with _lock:
        if key in _saved:
            return _saved[key]
    if cached_only:
        return []
    picture = _picture(image_url)
    prompt = (
        f"This is a runway look ({designer}, {show}). Find each distinct clothing piece, shoe, bag and accessory "
        "a shopper could buy, at most 8, most noticeable first. Only the model walking in front, not the audience "
        "or other models. box_2d tightly frames the piece."
    )
    text = _ask(
        {
            "contents": [{"parts": [
                {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(picture).decode()}},
                {"text": prompt},
            ]}],
            "generationConfig": {"responseMimeType": "application/json", "responseSchema": PIECES_SCHEMA},
        },
        FAST,
    )
    found = []
    for item in _json_in(text).get("items", [])[:8]:
        box = item.get("box_2d") or []
        if len(box) == 4 and all(isinstance(n, (int, float)) for n in box):
            top, left, bottom, right = (max(0, min(1000, int(n))) for n in box)
            if bottom > top and right > left:
                found.append({**{k: item.get(k, "") for k in ("name", "description", "search")}, "box": [top, left, bottom, right]})
    if found:
        _save(key, found)
    return found


def _product(title, store, price, url, image=None):
    if not (title and str(url or "").startswith("http")):
        return None
    return {"title": title, "store": store or "", "price": price or "", "url": url, "image": image or ""}


def _serpapi_shopping(query, key):
    """Google Shopping results through SerpApi: real products with photo, shop and price."""
    response = requests.get(
        "https://serpapi.com/search.json",
        params={"engine": "google_shopping", "q": query, "gl": "us", "hl": "en", "api_key": key},
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    if data.get("error") and not data.get("shopping_results"):
        # e.g. "Your account has run out of searches." (an empty result is not an error)
        if "hasn't returned any results" not in data["error"]:
            raise ValueError(data["error"])
    found = []
    for item in data.get("shopping_results", []):
        product = _product(
            item.get("title"),
            item.get("source"),
            item.get("price"),
            item.get("link") or item.get("product_link"),
            item.get("thumbnail") or (item.get("thumbnails") or [None])[0],
        )
        if product:
            found.append(product)
    return found


BROWSER = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}
REDIRECT = "vertexaisearch.cloud.google.com"


def _site(url):
    host = (urlparse(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def _follow(url):
    """Google's search links are redirects; this is where one goes."""
    if _site(url) != REDIRECT:
        return url
    try:
        return requests.head(url, allow_redirects=False, timeout=10).headers.get("Location") or ""
    except requests.RequestException:
        return ""


def _gemini_shopping(piece, designer, lookalikes=True):
    """Both lists (or only the originals) from one Gemini answer with Google Search.

    Gemini is asked in plain words (asking for JSON makes it skip searching) to
    list products one per line. Each product then links to the page Google
    Search actually returned on that shop's site, the closest one to the link
    Gemini wrote, since the links it types drift from the real ones; products
    whose page the search did not return link to a Google search for that exact
    product at that shop. Each product's photo is read from its own page."""
    original = (
        f"where the actual {designer} piece, or the closest {designer} item, is sold now, new or resale "
        "(the brand's shop, department stores, Farfetch, SSENSE, The RealReal, Grailed, GOAT...)"
    )
    if lookalikes:
        prompt = (
            f"Search the web for this {designer} runway piece: {piece['name']} — {piece['description']}.\n"
            f"Find (a) {original}, and (b) lookalikes from other brands at a range of prices, budget to luxury.\n"
            "List each product on its own line exactly like this:\n"
            "ORIGINAL | product name | shop | price | product page link\n"
            "LOOKALIKE | product name | shop | price | product page link\n"
            "Up to 6 originals and 10 lookalikes. Use product pages from your search results."
        )
    else:
        prompt = (
            f"Search the web for this {designer} runway piece: {piece['name']} — {piece['description']}.\n"
            f"Find {original}.\n"
            "List each product on its own line exactly like this:\n"
            "ORIGINAL | product name | shop | price | product page link\n"
            "Up to 6 products. Use product pages from your search results."
        )
    text, sources = _ask({"contents": [{"parts": [{"text": prompt}]}], "tools": [{"google_search": {}}]}, SEARCHERS, sources=True)
    pages = [url for url in _pool.map(lambda source: _follow(source.get("uri", "")), sources) if url.startswith("http")]

    def real_page(written):
        """The search result on the same site whose address is closest to `written`."""
        site = _site(written)
        same = [page for page in pages if _site(page) == site]
        if not same:
            return ""
        path = urlparse(written).path
        return max(same, key=lambda page: SequenceMatcher(None, urlparse(page).path, path).ratio())

    lists = {"ORIGINAL": [], "LOOKALIKE": []}
    seen = set()
    for line in text.splitlines():
        cells = [cell.strip(" *`") for cell in line.strip().strip("-* ").split("|")]
        if len(cells) < 5 or cells[0].upper() not in lists or not cells[1]:
            continue
        # Not among the pages the search returned: link to a Google search for
        # that exact product at that shop rather than to an address that may not exist.
        url = real_page(_follow(cells[4])) or f"https://www.google.com/search?q={quote(cells[1] + ' ' + cells[2])}"
        if url in seen:
            continue
        seen.add(url)
        price = cells[3] if re.search(r"\d", cells[3]) else ""
        lists[cells[0].upper()].append(_product(cells[1], cells[2], price, url))

    # Photos and current prices are read afterwards (details() below), so the
    # list reaches the page as soon as Gemini has answered.
    return lists["ORIGINAL"][:6], lists["LOOKALIKE"][:10]


def _serpapi_lookalikes(piece, designer, key):
    """Lookalikes from Google Shopping (through SerpApi): every one with a photo and a price."""
    brand = designer.casefold().replace("-", " ")
    found = _serpapi_shopping(piece["search"], key)
    return [p for p in found if brand not in p["title"].casefold().replace("-", " ")][:12]


def shop(image_url, index, designer=""):
    """{"original": [...], "lookalikes": [...], "source": "gemini" | None} for piece `index`.

    The originals come from Gemini with Google Search, which finds the designer's
    actual piece (Google Shopping reads names like "Off-White" as a colour). The
    lookalikes come from Google Shopping through SerpApi when SERPAPI_KEY is set
    (a photo and price for each), else from Gemini too. Both run at once."""
    global _search_off_until
    key = f"shop\n{image_url}\n{index}"
    with _lock:
        if key in _saved:
            return _saved[key]
    piece = pieces(image_url)[index]
    serpapi_key = os.environ.get("SERPAPI_KEY")
    shopping = _pool.submit(_serpapi_lookalikes, piece, designer, serpapi_key) if serpapi_key else None
    original, lookalikes, source = [], [], None
    if time.time() >= _search_off_until:
        try:
            original, gemini_lookalikes = _gemini_shopping(piece, designer, lookalikes=not shopping)
            lookalikes, source = gemini_lookalikes, "gemini"
        except Busy:
            raise
        except GeminiError:  # no quota or not allowed: search is off for a while
            _search_off_until = time.time() + SEARCH_RETRY
    if shopping:
        try:
            lookalikes, source = shopping.result(), source or "gemini"
        except (requests.RequestException, ValueError) as error:
            # Out of SerpApi searches (or SerpApi down): Gemini finds the lookalikes instead.
            print(f"SerpApi failed, Gemini finds lookalikes: {error}", flush=True)
            if source:
                lookalikes = _gemini_shopping(piece, designer)[1]
    answer = {"original": original, "lookalikes": lookalikes, "source": source}
    if source:
        _save(key, answer)
    return answer


def _page_photo(url):
    """A product's photo straight from its shop, where the shop allows it:
    Shopify's public product data (/products/<name>.json), else the page's og:image."""
    path = urlparse(url).path
    if "/products/" in path:
        handle = path.split("/products/", 1)[1].split("/")[0]
        try:
            response = requests.get(urljoin(url, f"/products/{handle}.json"), headers=BROWSER, timeout=6)
            images = response.json().get("product", {}).get("images", []) if response.ok else []
            if images and images[0].get("src"):
                return images[0]["src"]
        except (requests.RequestException, ValueError):
            pass
    try:
        response = requests.get(url, headers=BROWSER, timeout=6)
    except requests.RequestException:
        return ""
    if not response.ok:
        return ""
    head = response.text[:300_000]
    for pattern in (
        r'<meta[^>]+(?:property|name)=["\'](?:og:image(?::secure_url)?|twitter:image)["\'][^>]*content=["\']([^"\']+)',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\'](?:og:image|twitter:image)["\']',
    ):
        match = re.search(pattern, head, re.I)
        if match:
            return urljoin(url, match.group(1).replace("&amp;", "&"))
    return ""


def _real_image(url):
    """True if `url` answers with a picture (so a card never shows a broken image)."""
    try:
        with requests.get(url, headers=BROWSER, timeout=8, stream=True) as response:
            return response.ok and response.headers.get("Content-Type", "").startswith("image/")
    except requests.RequestException:
        return False


def _read_pages(products):
    """Gemini reads these product pages (through Google, which shops let in) and
    gives each one's current price and, on a page listing many products, the
    matching product's own page. (It cannot see the pages' pictures, and the
    picture addresses it offers are guesses, so photos come from _page_photo.)"""
    listing = "\n".join(f"{n + 1}. {p['title']} ({p['store']}) — {p['url']}" for n, p in enumerate(products))
    prompt = (
        "Read each of these shop pages:\n"
        f"{listing}\n\n"
        "For each, find the product named (if the page lists many products, the one that best matches the name). "
        "Give its own product page link and its current price as shown on the page, with currency.\n"
        "One line per number, exactly: number | product page link | - | price\n"
        "Write NONE for anything the page does not show. Use only what the pages contain."
    )
    text = _ask({"contents": [{"parts": [{"text": prompt}]}], "tools": [{"url_context": {}}]}, SEARCHERS)
    found = {}
    for line in text.splitlines():
        cells = [cell.strip(" *`") for cell in line.strip().strip("-* ").split("|")]
        if len(cells) < 4 or not cells[0].rstrip(".").isdigit():
            continue
        number = int(cells[0].rstrip(".")) - 1
        if not 0 <= number < len(products):
            continue
        product = products[number]
        page, photo, price = (None if cell.upper() == "NONE" else cell for cell in cells[1:4])
        # A product page only from the same shop, and a photo only if it really is one.
        page = page if page and page.startswith("http") and _site(page) == _site(product["url"]) else product["url"]
        found[product["url"]] = {"url": page, "image": "", "price": price if price and re.search(r"\d", price) else ""}
    return found


def _shopping_photo(product, key):
    """Google Shopping's photo of this very product, if it lists one by (nearly) the same name."""
    try:
        results = _serpapi_shopping(f"{product['title']} {product['store']}", key)
    except (requests.RequestException, ValueError):
        return ""
    name = product["title"].casefold()
    best = max(results, key=lambda r: SequenceMatcher(None, r["title"].casefold(), name).ratio(), default=None)
    if best and best["image"] and SequenceMatcher(None, best["title"].casefold(), name).ratio() >= 0.6:
        return best["image"]
    return ""


def details(image_url, index):
    """{listed product page: {"url", "image", "price"}} for piece `index`'s products."""
    key = f"details\n{image_url}\n{index}"
    with _lock:
        if key in _saved:
            return _saved[key]
        answer = _saved.get(f"shop\n{image_url}\n{index}")
    if not answer or answer["source"] != "gemini":
        return {}
    products = [p for p in answer["original"] + answer["lookalikes"] if _site(p["url"]) != "google.com"]
    # Two batches at once: each page takes Gemini a few seconds to read.
    half = (len(products) + 1) // 2
    found = {}
    for part in _pool.map(_read_pages, [chunk for chunk in (products[:half], products[half:]) if chunk]):
        found.update(part)
    # Photos from the shops themselves, checked so a card never shows a broken picture.
    pages = {listed: found.get(listed, {"url": listed, "price": ""})["url"] for listed in (p["url"] for p in products)}
    photos = list(_photos.map(lambda page: _page_photo(page), pages.values()))
    checks = list(_photos.map(lambda photo: bool(photo) and _real_image(photo), photos))
    for (listed, page), photo, ok in zip(pages.items(), photos, checks):
        found.setdefault(listed, {"url": page, "price": ""})["image"] = photo if ok else ""
    # Originals whose shop shares no photo (Farfetch, SSENSE...): Google Shopping's
    # photo of the same product, for the first two (each costs a SerpApi search).
    serpapi_key = os.environ.get("SERPAPI_KEY")
    missing = [p for p in answer["original"] if p["url"] in found and not found[p["url"]]["image"]][:2]
    if serpapi_key and missing:
        for product, photo in zip(missing, _pool.map(lambda p: _shopping_photo(p, serpapi_key), missing)):
            found[product["url"]]["image"] = photo
    _save(key, found)
    return found


def crop(image_url, box):
    """JPEG of one piece, with a little room around it."""
    picture = Image.open(io.BytesIO(_picture(image_url)))
    width, height = picture.size
    top, left, bottom, right = box
    pad_y, pad_x = (bottom - top) * 0.08, (right - left) * 0.08
    area = (
        max(0, int((left - pad_x) * width / 1000)),
        max(0, int((top - pad_y) * height / 1000)),
        min(width, int((right + pad_x) * width / 1000)),
        min(height, int((bottom + pad_y) * height / 1000)),
    )
    out = io.BytesIO()
    picture.crop(area).convert("RGB").save(out, "JPEG", quality=88)
    return out.getvalue()
